import type { ShellEnv, ShellResult } from '../types';
import type { VirtualFileSystem } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { applyStyleOverride, OVERRIDES_PATH, OVERRIDES_WRITTEN_EVENT, sweepUnusedOverrides } from '@/lib/direct-edit/apply-style';
import { declaredByScope, declaredProperties, scopePrelude, type OverrideScope } from '@/lib/direct-edit/overrides-css';
import { projectBreakpointsOf, scopeOfWidth } from '@/lib/direct-edit/breakpoints';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';
import { supportsDirectEditing } from '@/lib/runtimes/registry';
import { resolveRuntime } from '@/lib/vfs/project-settings';
import { editHistory } from '@/lib/direct-edit/edit-history';
import {
  domMatcher, findBySelector, findMarker, findPosition, pageFileFor, parseElementTarget,
  type ElementMatcher, type SourceElement, type TargetResult,
} from '@/lib/direct-edit/targets';
import type { ApplyResult, StyleChange, WriteRecorder } from '@/lib/direct-edit/types';
import { readOpenTagAt } from '@/lib/preview/provenance';
import { findAttributeIn } from '@/lib/direct-edit/attributes';
import { SHORTHAND_LONGHANDS } from '@/lib/preview/style-preview';
import { DEFAULT_RENDER_WIDTH, render } from './render-shared';

const USAGE = `Usage: style <element> prop=value [prop=value ...] [--width N]
  Changes how ONE element looks, by writing a rule for it in /overrides.css.

  <element> is one of:
    /index.html ".hero h1"   a page, then a CSS selector that matches one element on it
    /index.html:16           the element whose tag starts on line 16 of that file (or :16:5, line and column)
    @h7x2m4qp                an element's marker (its data-osw-id attribute)

  style /index.html ".hero h1" font-size=36px color=#111
  style /index.html:16 padding-block=24px --width 375
  style @h7x2m4qp color=            an empty value removes that property
  style @h7x2m4qp --clear           removes all of its overrides, at every width (with --width N, that width's only)
  style --sweep                     removes rules left behind by elements that are gone

  --width N  the change applies on screens N px wide and narrower. It goes in the block for the
             project's breakpoint that covers N, and the reply says which. Without it: every width.
  A value with spaces needs quotes: "margin=0 auto" or "margin: 0 auto".
  The reply says whether the change is in force on the rendered page. A change that a rule of the
  project or the element's style attribute would beat is marked !important so that it applies:
  leave !important off, style adds it when it is needed.
  To change every element of a kind, edit the project's stylesheet instead.`;

const fail = (message: string, exitCode = 1): ShellResult => ({ stdout: '', stderr: `style: ${message}`, exitCode });

/** CSS property names, as `/overrides.css` accepts them. */
const PROPERTY_RE = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Whether a word where the selector goes is a declaration instead: `prop=value`, or `prop:` with a
 * space or nothing after the colon (`margin: 0 auto`, `color:` before `red`). A colon with no space
 * after it begins a pseudo-class (`li:first-child`), and the word is a selector.
 */
const isDeclarationWord = (word: string) => /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*(?:\s*=|:(?:\s|$))/.test(word);

/**
 * The arguments as one declaration each. A shell splits an unquoted value on its spaces, so a word
 * that is no declaration of its own goes back onto the one before it (`margin=0 auto`,
 * `font-size: 36px`).
 */
function joinDeclarations(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const starts = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*\s*[=:]/.test(arg);
    if (!starts && out.length > 0) out[out.length - 1] += ` ${arg}`;
    else out.push(arg);
  }
  return out;
}

/** `fontSize` as CSS spells it; custom properties are left as written. */
function cssName(property: string): string {
  const name = property.trim();
  if (name.startsWith('--')) return name;
  return (name.includes('-') ? name : name.replace(/([a-z0-9])([A-Z])/g, '$1-$2')).toLowerCase();
}

/** `prop=value` arguments and `prop: value; …` lists, as changes; a message for one that is neither. */
export function parseDeclarations(args: readonly string[]): StyleChange[] | string {
  const changes: StyleChange[] = [];
  const add = (property: string, value: string): string | null => {
    if (!PROPERTY_RE.test(property.trim())) return `"${property.trim()}" is not a CSS property name`;
    // `!important` is not the caller's to give: the check after the write adds it where a rule of
    // the project would win, and nowhere else. Taken off here rather than refused.
    const v = value.trim().replace(/;$/, '').replace(/\s*!\s*important\s*$/i, '').trim();
    changes.push({ property: cssName(property), value: v === '' ? null : v });
    return null;
  };
  for (const arg of joinDeclarations(args)) {
    if (/^!\s*important;?$/i.test(arg.trim())) continue;
    const eq = arg.indexOf('=');
    const colon = arg.indexOf(':');
    if (colon > 0 && (eq === -1 || colon < eq)) {
      for (const part of arg.split(';')) {
        if (!part.trim()) continue;
        const c = part.indexOf(':');
        if (c <= 0) return `"${part.trim()}" is not a declaration; write prop=value`;
        const problem = add(part.slice(0, c), part.slice(c + 1));
        if (problem) return problem;
      }
      continue;
    }
    if (eq <= 0) return `"${arg}" is not a declaration; write prop=value, for example font-size=36px`;
    const problem = add(arg.slice(0, eq), arg.slice(eq + 1));
    if (problem) return problem;
  }
  return changes;
}

/** The declarations the browser would drop, where there is a browser to ask. */
function invalidDeclarations(changes: readonly StyleChange[]): string[] {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return [];
  return changes
    .filter(c => c.value !== null && !c.property.startsWith('--') && !CSS.supports(c.property, c.value))
    .map(c => `${c.property}: ${c.value}`);
}

async function readText(fs: VirtualFileSystem, projectId: string, path: string): Promise<string | null> {
  try {
    return asText((await fs.readFile(projectId, path)).content);
  } catch {
    return null;
  }
}

/** The project's breakpoints, read from its stylesheets, pages and partials. */
async function breakpoints(fs: VirtualFileSystem, projectId: string): Promise<number[]> {
  const files: { path: string; content: string }[] = [];
  for (const path of await fs.listFilePaths(projectId)) {
    if (!/\.(css|html?|hbs|handlebars)$/i.test(path)) continue;
    const content = await readText(fs, projectId, path);
    if (content !== null) files.push({ path, content });
  }
  return projectBreakpointsOf(files);
}

/** Where the scope applies, in words. */
function scopeWords(scope: OverrideScope): string {
  return scope === 'all' ? 'at every width' : `at widths up to ${scope} px (${scopePrelude(scope)})`;
}

async function resolve(env: ShellEnv, words: string[]): Promise<{ result: TargetResult; page: string | null; rest: string[] }> {
  const { vfs, projectId, ctx } = env;
  const [first, ...rest] = words;
  const target = parseElementTarget(first);
  if (target.kind === 'marker') return { result: await findMarker(vfs, projectId, target.id), page: null, rest };
  if (target.kind === 'position') return { result: await findPosition(vfs, projectId, target.file, target.line, target.col), page: null, rest };
  if (!first.startsWith('/')) {
    return { result: { ok: false, error: `"${first}" does not say which element. Give the page first and then the selector, in quotes: style /index.html "${first}${rest[0] && !isDeclarationWord(rest[0]) ? ` ${rest[0]}` : ''}" font-size=36px. Or name the element by its position (/index.html:16) or its marker (@h7x2m4qp)` }, page: null, rest };
  }
  const page = pageFileFor(first);
  const [selector, ...after] = rest;
  if (!selector || isDeclarationWord(selector)) {
    return { result: { ok: false, error: `say which element of ${page}: a selector after the page, style ${first} ".hero h1" font-size=36px, or a position, style ${page}:16 font-size=36px` }, page, rest };
  }
  const matcher: ElementMatcher | null = ctx?.matchElements ?? (typeof DOMParser !== 'undefined' ? domMatcher : null);
  if (!matcher) return { result: { ok: false, error: 'selectors are not available here; name the element by its position (/index.html:16) or its marker (@h7x2m4qp)' }, page, rest: after };
  const { VirtualServer } = await import('@/lib/preview/virtual-server');
  const project = await vfs.getProject(projectId);
  const server = new VirtualServer(vfs, projectId, { runtime: project?.settings?.runtime, provenance: true });
  let html: string;
  try {
    const compiled = await server.getCompiledFile(page);
    if (!compiled) return { result: { ok: false, error: `${page} does not exist` }, page, rest: after };
    html = typeof compiled.content === 'string' ? compiled.content : '';
  } catch (error) {
    return { result: { ok: false, error: `${page} did not compile: ${error instanceof Error ? error.message : String(error)}` }, page, rest: after };
  } finally {
    server.cleanupBlobUrls();
  }
  return { result: await findBySelector(vfs, projectId, page, html, selector, matcher), page, rest: after };
}

function name(element: SourceElement): string {
  return `<${element.tag}> ${element.ref}`;
}

/** The logical sides, which the frame's table of shorthands has no need of. */
const LOGICAL: Readonly<Record<string, readonly string[]>> = {
  'padding-block': ['padding-top', 'padding-bottom'], 'padding-inline': ['padding-left', 'padding-right'],
  'margin-block': ['margin-top', 'margin-bottom'], 'margin-inline': ['margin-left', 'margin-right'],
  'padding-block-start': ['padding-top'], 'padding-block-end': ['padding-bottom'],
  'padding-inline-start': ['padding-left'], 'padding-inline-end': ['padding-right'],
  'margin-block-start': ['margin-top'], 'margin-block-end': ['margin-bottom'],
  'margin-inline-start': ['margin-left'], 'margin-inline-end': ['margin-right'],
  overflow: ['overflow-x', 'overflow-y'],
};

/** The properties to read back for a written one: its longhands, or itself. */
const readBack = (property: string): readonly string[] => SHORTHAND_LONGHANDS[property] ?? LOGICAL[property] ?? [property];

const isPageFile = (path: string) => /\.html?$/i.test(path) && !path.startsWith('/templates/');

/** The properties among `set` that the element's own `style` attribute declares: those win over any stylesheet. */
function inlineConflicts(content: string | null, offset: number, set: readonly string[]): string[] {
  const tag = content ? readOpenTagAt(content, offset) : null;
  const inline = content && tag ? findAttributeIn(content, tag, 'style')?.value ?? '' : '';
  if (!inline) return [];
  const declared = inline.split(';').map(d => d.slice(0, Math.max(0, d.indexOf(':'))).trim().toLowerCase()).filter(Boolean);
  return set.filter(property => declared.some(d => d === property || property.startsWith(`${d}-`) || d.startsWith(`${property}-`)));
}

/** Whether the `style` attribute declares `property`, or a shorthand or side of it, `!important`. */
function inlineImportant(content: string | null, offset: number, property: string): boolean {
  const tag = content ? readOpenTagAt(content, offset) : null;
  const inline = content && tag ? findAttributeIn(content, tag, 'style')?.value ?? '' : '';
  return inline.split(';').some(declaration => {
    const colon = declaration.indexOf(':');
    if (colon <= 0 || !/!\s*important\s*$/i.test(declaration)) return false;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    return name === property || property.startsWith(`${name}-`) || name.startsWith(`${property}-`);
  });
}

/** A written property that is not in force on the rendered page, with what holds the value instead. */
interface Loss {
  property: string;
  /** The longhand that showed it. */
  longhand: string;
  computed: string;
  /** What wins, as a clause after "to": a rule, the style attribute. Null when the browser dropped the declaration. */
  winner: string | null;
  inline: boolean;
}

/**
 * Which of the written values are not in force, read from the page rendered with them. `null` when
 * no page could be rendered (no browser, or the element is in a partial and no page was named).
 */
async function verify(env: ShellEnv, pageFile: string | null, marker: string, width: number | null, set: readonly StyleChange[]): Promise<{ at: number; page: string; lost: Loss[] } | null> {
  if (!pageFile || set.length === 0) return null;
  const props = [...new Set(set.flatMap(c => readBack(c.property)))];
  const at = width ?? DEFAULT_RENDER_WIDTH;
  let result;
  try {
    result = await render(env, { kind: 'inspect', projectId: env.projectId, page: pageFile, width: at, target: `@${marker}`, depth: 0, props });
  } catch {
    return null;
  }
  if (!result.ok || result.kind !== 'inspect' || !result.report.node || !result.report.styles) return null;
  const rows = new Map(result.report.styles.map(row => [row.property, row]));
  const lost: Loss[] = [];
  for (const change of set) {
    const row = readBack(change.property).map(p => rows.get(p)).find(r => r && !r.declared?.ours);
    if (!row) continue;
    const d = row.declared;
    lost.push({
      property: change.property,
      longhand: row.property,
      computed: row.computed || 'unset',
      winner: !d ? null : d.origin === 'inline style' ? 'the element\'s own style attribute' : `the rule "${d.selector}" in ${d.origin}`,
      inline: d?.origin === 'inline style',
    });
  }
  return { at, page: pageFile, lost };
}

/**
 * A change that does not apply, once marking it `!important` has been tried. `unmarked` and `kept`
 * say why the mark and the taking out again were refused, when they were.
 */
function notApplied(loss: Loss, unmarked: string | null, kept: string | null): string {
  const why = loss.winner === null
    ? 'the browser did not take the declaration (check the property name and the value)'
    : unmarked !== null
      ? `${loss.winner} wins over it, and marking it !important was refused: ${unmarked}`
      : loss.inline
        ? `${loss.winner} sets it with !important, which no stylesheet can beat. Remove ${loss.longhand} from the style attribute in the HTML`
        : `${loss.winner} sets it with !important and a stronger selector. Change that rule instead`;
  const after = kept === null
    ? `The override for ${loss.property} was taken out again.`
    : `The override for ${loss.property} is still in ${OVERRIDES_PATH}, as taking it out was refused${kept === unmarked ? ' too.' : `: ${kept}.`}`;
  return `NOT APPLIED: ${loss.property} (${loss.longhand} is still ${loss.computed}): ${why}. ${after}`;
}

/** Why a write was refused, as a clause to end a sentence with. */
function refusal(result: ApplyResult): string {
  return (result.message ?? `${OVERRIDES_PATH} was not changed (${result.reason ?? 'unknown reason'})`).replace(/\.$/, '');
}

/** Tells an open workspace showing this project to send the new rules to its frames. */
function announce(projectId: string, css: string | undefined): void {
  if (css === undefined || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OVERRIDES_WRITTEN_EVENT, { detail: { projectId, css } }));
}

/** The workspace's undo history for this project, when the run is in the tab that has it open. */
function journal(projectId: string): WriteRecorder | undefined {
  const history = editHistory();
  if (!history || history.projectId !== projectId) return undefined;
  const group = `agent-style:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return (write) => history.record(group, 'style', write);
}

/** `style` — set, remove or clear an element's overrides in `/overrides.css`, through the Styles tab's write path. */
export async function styleCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args } = env;
  let width: number | null = null;
  let clear = false;
  let sweep = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--width' || a.startsWith('--width=')) {
      const raw = a === '--width' ? args[++i] : a.slice('--width='.length);
      const n = Number((raw ?? '').replace(/px$/i, ''));
      if (!raw || !Number.isFinite(n) || n <= 0) return fail(`--width takes a number of px, for example --width 375, not "${raw ?? ''}"`, 2);
      width = Math.round(n);
      continue;
    }
    if (a === '--clear') { clear = true; continue; }
    if (a === '--sweep') { sweep = true; continue; }
    if (a === '-h' || a === '--help') return { stdout: USAGE, stderr: '', exitCode: 0 };
    // A custom property is a declaration that starts with two dashes: `--accent=#f00`, `--gap: 4px`.
    if (a.startsWith('--') && !isDeclarationWord(a)) return fail(`unknown option ${a}\n${USAGE}`, 2);
    words.push(a);
  }

  if (sweep) {
    if (words.length > 0 || clear) return fail('--sweep takes nothing else', 2);
    const { removed, css } = await sweepUnusedOverrides(projectId, { fs: vfs, record: journal(projectId) });
    if (removed.length > 0) announce(projectId, css ?? undefined);
    return {
      stdout: css === null
        ? `${OVERRIDES_PATH} does not exist; nothing to sweep.`
        : removed.length === 0
          ? `Every rule in ${OVERRIDES_PATH} belongs to an element that still exists.`
          : `Removed the rules of ${removed.length} element${removed.length === 1 ? '' : 's'} no file has any more: ${removed.map(id => `@${id}`).join(', ')}.`,
      stderr: '',
      exitCode: 0,
    };
  }

  if (words.length === 0) return fail(`say which element and what to change.\n${USAGE}`, 2);
  let runtime;
  try {
    runtime = resolveRuntime((await vfs.getProject(projectId))?.settings);
  } catch {
    return fail('the project does not exist');
  }
  if (!supportsDirectEditing(runtime)) return fail(`style works on static and Handlebars projects, whose pages come from HTML source; this is a ${runtime} project. Edit its components and stylesheets instead.`);

  const { result, page, rest } = await resolve(env, words);
  if (!result.ok) return fail(result.error);
  const element = result.element;

  const parsed = parseDeclarations(rest);
  if (typeof parsed === 'string') return fail(parsed, 2);
  if (clear && parsed.length > 0) return fail('--clear takes no declarations', 2);
  if (!clear && parsed.length === 0) return fail(`nothing to change on ${name(element)}: add what to set, for example font-size=36px. To read its styles, use inspect.`, 2);
  const invalid = invalidDeclarations(parsed);
  if (invalid.length > 0) return fail(`not valid CSS, so nothing was written: ${invalid.join('; ')}. Check the property name and the value.`, 2);

  const edges = width === null ? [] : await breakpoints(vfs, projectId);
  const scope: OverrideScope = width === null ? 'all' : scopeOfWidth(width, edges);
  /** The changes, by the scope each goes in: one scope, except for --clear with no width. */
  let writes: { scope: OverrideScope; changes: StyleChange[] }[] = [{ scope, changes: parsed }];
  if (clear) {
    if (!element.marker) return { stdout: `${name(element)} has no overrides.`, stderr: '', exitCode: 0 };
    const css = (await readText(vfs, projectId, OVERRIDES_PATH)) ?? '';
    const marker = element.marker;
    let byScope: [OverrideScope, string[]][];
    try {
      byScope = width === null
        ? [...declaredByScope(css, marker)].map(([at, declared]) => [at, Object.keys(declared)])
        : [[scope, declaredProperties(css, marker, scope)]];
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    writes = byScope
      .filter(([, props]) => props.length > 0)
      .map(([at, props]) => ({ scope: at, changes: props.map(property => ({ property, value: null })) }));
    if (writes.length === 0) return { stdout: `${name(element)} has no overrides${width === null ? '' : ` ${scopeWords(scope)}`}.`, stderr: '', exitCode: 0 };
  }

  // One undo step for everything the command writes, the strengthening and a taking-back included.
  const record = journal(projectId);
  const apply = (write: (typeof writes)[number]) => applyStyleOverride(projectId, {
    srcAttr: element.src,
    tagName: element.tag,
    instanceCount: element.instances ?? 1,
    attributes: element.marker ? { [MARKER_ATTR]: element.marker } : {},
  }, write.changes, {
    scope: write.scope,
    markerId: element.marker,
    confirmedMultiInstance: true,
    fs: vfs,
    record,
  });
  let written = await apply(writes[0]);
  for (const write of writes.slice(1)) {
    if (!written.ok) break;
    written = await apply(write);
  }
  if (!written.ok) {
    switch (written.reason) {
      case 'stale-index': return fail(`${element.ref} changed while this ran; try again`);
      case 'missing-file': return fail(`${element.file} does not exist`);
      case 'ambiguous-stylesheet': return fail(`${OVERRIDES_PATH} was not changed: ${written.message ?? 'its rules for this element are where the writer will not edit them'}`);
      default: return fail(`${name(element)} could not be styled (${written.reason ?? 'unknown reason'})`);
    }
  }
  announce(projectId, written.css);

  const sets = parsed.filter(change => change.value !== null);
  // Where the element is now: its first override links /overrides.css into the page, which moves it down a line.
  const now = written.markerId ? await findMarker(vfs, projectId, written.markerId) : null;
  const shown = now?.ok ? now.element : element;
  const lines = [
    `${clear ? 'Cleared' : 'Styled'} ${name(shown)}${written.markerId ? ` (marker @${written.markerId})` : ''}.`,
  ];
  if (sets.length > 0) lines.push(`Set ${scopeWords(scope)}: ${sets.map(change => `${change.property}: ${change.value}`).join('; ')}`);
  for (const write of writes) {
    const removes = write.changes.filter(change => change.value === null);
    if (removes.length > 0) lines.push(`Removed ${scopeWords(write.scope)}: ${removes.map(change => change.property).join(', ')}`);
  }
  if (width !== null && scope === 'all') {
    lines.push(edges.length === 0
      ? 'The project has no breakpoints, so this applies at every width.'
      : `${width} px is wider than every breakpoint of the project, so this applies at every width.`);
  }
  if (element.file.startsWith('/templates/')) lines.push(`It is in the partial ${element.file}, so this applies on every page that includes it.`);
  if ((element.instances ?? 1) > 1) lines.push(`Its tag renders ${element.instances} elements on ${page}; all of them change.`);
  if (written.skippedPages?.length) lines.push(`Not linked from (no <head>): ${written.skippedPages.join(', ')}.`);
  if (written.markerId && sets.length > 0) {
    const markerId = written.markerId;
    const selection = { srcAttr: shown.src, tagName: shown.tag, instanceCount: element.instances ?? 1, attributes: { [MARKER_ATTR]: markerId } };
    /** Writes again; why /overrides.css refused the write, or null when it was made. */
    const rewrite = async (list: readonly StyleChange[], strengthen: readonly string[] = []): Promise<string | null> => {
      const next = await applyStyleOverride(projectId, selection, list, { scope, markerId, strengthen, confirmedMultiInstance: true, fs: vfs, record });
      if (!next.ok) return refusal(next);
      announce(projectId, next.css);
      return null;
    };
    const pageFile = page ?? (isPageFile(element.file) ? element.file : null);
    const first = await verify(env, pageFile, markerId, width, sets);
    if (first) {
      // A change that loses is the user's or the agent's intent not showing: it is marked !important,
      // which wins over a stronger selector and over the style attribute, and the page is read again.
      const weak = first.lost.filter(loss => loss.winner !== null);
      let still = first.lost;
      let unmarked: string | null = null;
      if (weak.length > 0) {
        unmarked = await rewrite([], weak.map(loss => loss.property));
        if (unmarked === null) {
          const second = await verify(env, pageFile, markerId, width, sets);
          still = second ? second.lost : first.lost.filter(loss => loss.winner === null);
        }
      }
      const won = weak.filter(loss => !still.some(l => l.property === loss.property));
      if (still.length < sets.length) {
        lines.push(`Checked on ${first.page} at ${first.at} px: ${still.length === 0 ? 'in force' : `${sets.filter(c => !still.some(l => l.property === c.property)).map(c => c.property).join(', ')} in force`}.`);
      }
      for (const loss of won) lines.push(`${loss.property} was losing to ${loss.winner}, so it is marked !important in ${OVERRIDES_PATH}.`);
      // An override that changes nothing is clutter the user would find in the Styles tab: take it back out.
      const kept = still.length > 0 ? await rewrite(still.map(loss => ({ property: loss.property, value: null }))) : null;
      for (const loss of still) lines.push(notApplied(loss, unmarked, kept));
    } else {
      // No page to read: the one loss that shows in the file is the element's own style attribute.
      const source = await readText(vfs, projectId, shown.file);
      const inline = inlineConflicts(source, shown.offset, sets.map(c => c.property));
      const fixed = inline.filter(property => !inlineImportant(source, shown.offset, property));
      const stuck = inline.filter(property => !fixed.includes(property));
      if (fixed.length > 0) {
        const unmarked = await rewrite([], fixed);
        const them = fixed.length === 1 ? 'it' : 'them';
        lines.push(unmarked === null
          ? `${fixed.join(', ')}: the element's own style attribute sets ${them} too, so ${fixed.length === 1 ? 'it is' : 'they are'} marked !important in ${OVERRIDES_PATH}.`
          : `NOT APPLIED: ${fixed.join(', ')}: the element's own style attribute sets ${them} too, and marking ${them} !important in ${OVERRIDES_PATH} was refused: ${unmarked}.`);
      }
      if (stuck.length > 0) {
        const kept = await rewrite(stuck.map(property => ({ property, value: null })));
        lines.push(`NOT APPLIED: ${stuck.join(', ')}: the element's own style attribute sets ${stuck.length === 1 ? 'it' : 'them'} with !important, which no stylesheet can beat. Remove ${stuck.length === 1 ? 'it' : 'them'} from the style attribute in the HTML. ${kept === null ? 'The override was taken out again.' : `The override is still in ${OVERRIDES_PATH}, as taking it out was refused: ${kept}.`}`);
      }
      lines.push(`Not checked on a rendered page: ${pageFile ? 'no open browser tab could render it' : `${shown.file} is a partial, and no page was named`}.`);
    }
  }
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
}
