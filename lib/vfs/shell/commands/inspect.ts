import type { ShellEnv, ShellResult } from '../types';
import type { InspectNode, InspectReport, InspectStyle } from '@/lib/canvas/render-types';
import { asGiven, parseRenderArgs, render, resolveTarget, sourceRefs } from './render-shared';
import { applyRedirectGuarded } from '../runtime';

const USAGE = `Usage: inspect <page> [element] [--width N] [--depth D]
  Reads a page as a browser lays it out (its scripts run), at N px wide (1440 by default).

  inspect /index.html                       the page's elements: tag, position in source, size and place
  inspect /index.html ".hero h1"            one element: its CSS values and the rule that sets each
  inspect /index.html ".hero h1" --width 375   the same on a phone-width screen
  inspect /index.html:16                    the element whose tag starts on line 16 of the file

  An element is a CSS selector, a position (/index.html:16 or :16:5) or a marker (@h7x2m4qp).
  Every element is printed with its position, which style and inspect take back as the element.
  --depth D lists D levels of children (0 to 6).`;

const fail = (message: string, exitCode = 1): ShellResult => ({ stdout: '', stderr: `inspect: ${message}`, exitCode });

/** Values the report leaves out unless a rule sets them: what an element has when nothing styles it. */
const QUIET: Record<string, (value: string) => boolean> = {
  position: (v) => v === 'static',
  'z-index': (v) => v === 'auto',
  // A relatively positioned element computes the offsets nobody set to 0px.
  top: (v) => v === 'auto' || v === '0px', right: (v) => v === 'auto' || v === '0px', bottom: (v) => v === 'auto' || v === '0px', left: (v) => v === 'auto' || v === '0px',
  'min-width': (v) => v === 'auto' || v === '0px', 'min-height': (v) => v === 'auto' || v === '0px',
  'max-width': (v) => v === 'none', 'max-height': (v) => v === 'none',
  'flex-direction': (v) => v === 'row', 'flex-wrap': (v) => v === 'nowrap',
  'justify-content': (v) => v === 'normal', 'align-items': (v) => v === 'normal', 'align-self': (v) => v === 'auto',
  'flex-grow': (v) => v === '0', 'flex-basis': (v) => v === 'auto',
  'row-gap': (v) => v === 'normal', 'column-gap': (v) => v === 'normal',
  'grid-template-columns': (v) => v === 'none', 'grid-template-rows': (v) => v === 'none',
  'letter-spacing': (v) => v === 'normal', 'text-align': (v) => v === 'start', 'text-transform': (v) => v === 'none',
  'background-image': (v) => v === 'none', 'box-shadow': (v) => v === 'none', opacity: (v) => v === '1',
  'overflow-x': (v) => v === 'visible', 'overflow-y': (v) => v === 'visible', transform: (v) => v === 'none',
  'border-top-style': (v) => v === 'none', 'border-top-color': () => true,
  'border-top-width': (v) => v === '0px', 'border-right-width': (v) => v === '0px', 'border-bottom-width': (v) => v === '0px', 'border-left-width': (v) => v === '0px',
  'border-top-left-radius': (v) => v === '0px', 'border-top-right-radius': (v) => v === '0px', 'border-bottom-right-radius': (v) => v === '0px', 'border-bottom-left-radius': (v) => v === '0px',
};

/** Longhands read back as their shorthand. */
const GROUPS: [string, string[]][] = [
  ['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
  ['padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
  ['border-width', ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']],
  ['border-radius', ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']],
  ['gap', ['row-gap', 'column-gap']],
];

/** `top right bottom left` as CSS writes it shortest. */
function sides(values: string[]): string {
  if (values.length === 2) return values[0] === values[1] ? values[0] : values.join(' ');
  const [t, r, b, l] = values;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return values.join(' ');
}

function source(style: InspectStyle): string {
  const d = style.declared;
  if (!d) return '';
  if (d.origin === 'inline style') return '  ← style attribute';
  const where = d.media ? `${d.origin}, @media ${d.media}` : d.origin;
  return `  ← ${d.selector} (${where})`;
}

/** The style lines: shorthands folded, unset defaults left out. */
export function styleLines(styles: readonly InspectStyle[]): string[] {
  const byName = new Map(styles.map((s) => [s.property, s]));
  const done = new Set<string>();
  const lines: string[] = [];
  for (const style of styles) {
    if (done.has(style.property)) continue;
    const group = GROUPS.find(([, longhands]) => longhands.includes(style.property));
    if (group) {
      const members = group[1].map((p) => byName.get(p)).filter((s): s is InspectStyle => !!s);
      members.forEach((s) => done.add(s.property));
      const declared = members.filter((s) => s.declared);
      const value = sides(members.map((s) => s.computed));
      const quiet = members.every((s) => QUIET[s.property]?.(s.computed));
      if (declared.length === 0 && quiet) continue;
      // The rules that set its sides, each once: one when a single rule sets them all.
      const rules = [...new Set(declared.map((s) => source(s).replace('  ← ', '')))];
      lines.push(`${group[0]}: ${value}${rules.length > 0 ? `  ← ${rules.join('; ')}` : ''}`);
      continue;
    }
    done.add(style.property);
    if (!style.declared && QUIET[style.property]?.(style.computed)) continue;
    lines.push(`${style.property}: ${style.computed}${source(style)}`);
  }
  return lines;
}

async function nodeLine(node: InspectNode, where: (src: string | null) => Promise<string>): Promise<string> {
  const name = `${node.tag}${node.id ? `#${node.id}` : ''}${node.classes.map((c) => `.${c}`).join('')}`;
  const parts = [name, await where(node.src)];
  if (node.marker) parts.push(`@${node.marker}`);
  parts.push(node.hidden ? '(hidden)' : `${node.box.w}×${node.box.h} at ${node.box.x},${node.box.y}`);
  if (node.text) parts.push(JSON.stringify(node.text));
  return parts.join('  ');
}

async function tree(node: InspectNode, where: (src: string | null) => Promise<string>, indent: string, out: string[]): Promise<void> {
  for (const child of node.children ?? []) {
    out.push(`${indent}${await nodeLine(child, where)}`);
    await tree(child, where, `${indent}  `, out);
  }
  if (node.more) out.push(`${indent}… ${node.more} more`);
}

export async function formatReport(report: InspectReport, target: string | undefined, where: (src: string | null) => Promise<string>): Promise<string> {
  const out = [`${report.page} at ${report.width} × ${report.height}, page ${report.pageHeight} px tall`];
  if (!report.node) return [...out, `Nothing matches ${JSON.stringify(target)}.`].join('\n');
  if (target) {
    if ((report.matches ?? 1) > 1) out.push(`${JSON.stringify(target)} matches ${report.matches} elements; this is the first. For another, use a narrower selector or its position.`);
    out.push(await nodeLine(report.node, where));
    for (const line of styleLines(report.styles ?? [])) out.push(`  ${line}`);
    if (report.node.children?.length || report.node.more) {
      out.push('children:');
      await tree(report.node, where, '  ', out);
    }
    return out.join('\n');
  }
  await tree(report.node, where, '', out);
  return out.join('\n');
}

/** `inspect` — a page rendered as visitors see it, read back as elements, positions and winning styles. */
export async function inspectCommand(env: ShellEnv): Promise<ShellResult> {
  if (env.args.includes('-h') || env.args.includes('--help')) return { stdout: USAGE, stderr: '', exitCode: 0 };
  const parsed = parseRenderArgs('inspect', env.args, { depth: true });
  if (typeof parsed === 'string') return fail(parsed, 2);
  const target = await resolveTarget(env, parsed.target);
  if (!target.ok) return fail(target.error);
  const result = await render(env, {
    kind: 'inspect', projectId: env.projectId, page: parsed.page, width: parsed.width, target: target.target, depth: parsed.depth,
  });
  if (!result.ok) return fail(asGiven(result.error, target.target, parsed.target));
  if (result.kind !== 'inspect') return fail('the page answered with something else');
  const stdout = await formatReport(result.report, parsed.target, sourceRefs(env.vfs, env.projectId));
  if (env.redirect) return applyRedirectGuarded(env.vfs, env.projectId, stdout, env.redirect, env.ctx);
  return { stdout, stderr: '', exitCode: 0 };
}
