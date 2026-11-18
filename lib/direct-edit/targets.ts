import type { VirtualFileSystem } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { carriesProvenance, readOpenTagAt } from '@/lib/preview/provenance';
import { readMarkerAt } from './marker';
import { isHidden } from './apply-style';
import { isPageFile } from './breakpoints';
import { lineAt, lineRange, parseSrc, sourceRef } from './resolution';
import { scanElements } from './structure';

/**
 * The elements the agent's `style`, `inspect` and `screenshot` commands act on, named the ways the
 * focus block and `inspect` print them: by marker (`@h7x2m4qp`), by source position
 * (`/index.html:16:5`, or `/index.html:16` for the one element that starts on that line), or by a
 * CSS selector on a page.
 */
export type ElementTarget =
  | { kind: 'marker'; id: string }
  | { kind: 'position'; file: string; line: number; col: number | null }
  | { kind: 'selector'; selector: string };

/** An element as a compiled page has it: its `data-osw-src` (null when nothing in source made it) and tag. */
export interface MatchedElement {
  src: string | null;
  tag: string;
}

/**
 * The elements of a compiled page a selector matches, in document order. The browser parses with
 * the DOM; the server, which has none, is given one (`lib/server-generate/match-elements.ts`).
 * Throws on a selector the parser rejects.
 */
export type ElementMatcher = (html: string, selector: string) => MatchedElement[] | Promise<MatchedElement[]>;

/** One element in source, found from a target. */
export interface SourceElement {
  /** As `data-osw-src` spells it: the file and a code-unit offset. For the app, never printed. */
  src: string;
  /** As the agent reads and writes it: `/index.html:16:5`. */
  ref: string;
  file: string;
  offset: number;
  line: number;
  tag: string;
  marker: string | null;
  /** How many elements the page renders from this tag, when a compile of the page was read. */
  instances: number | null;
}

export type TargetResult = { ok: true; element: SourceElement } | { ok: false; error: string };

/** A target argument: `@id`, `/file:line[:col]`, or anything else as a selector. */
export function parseElementTarget(arg: string): ElementTarget {
  if (/^@[A-Za-z0-9_-]+$/.test(arg)) return { kind: 'marker', id: arg.slice(1) };
  const m = arg.startsWith('/') ? /^(.+?):(\d+)(?::(\d+))?$/.exec(arg) : null;
  if (m) return { kind: 'position', file: m[1], line: Number(m[2]), col: m[3] === undefined ? null : Number(m[3]) };
  return { kind: 'selector', selector: arg };
}

/** The file a page path names, as the preview and `curl localhost/…` resolve it. */
export function pageFileFor(path: string): string {
  let file = path.startsWith('/') ? path : `/${path}`;
  if (file === '/') return '/index.html';
  if (file.endsWith('/')) return `${file}index.html`;
  if (!/\.[A-Za-z0-9]+$/.test(file.slice(file.lastIndexOf('/')))) file += '.html';
  return file;
}

/** Files a marker can be stamped in: pages and partials, outside the hidden folders. */
export const isMarkupFile = (path: string) => isPageFile(path) && !isHidden(path);

async function readText(fs: VirtualFileSystem, projectId: string, path: string): Promise<string | null> {
  try {
    return asText((await fs.readFile(projectId, path)).content);
  } catch {
    return null;
  }
}

function describe(file: string, offset: number, content: string, instances: number | null): SourceElement | null {
  const tag = readOpenTagAt(content, offset);
  if (!tag) return null;
  return {
    src: `${file}:${offset}`,
    ref: sourceRef(file, content, offset),
    file,
    offset,
    line: lineAt(content, offset),
    tag: tag.tagName,
    marker: readMarkerAt(content, offset),
    instances,
  };
}

/** The element whose open tag carries marker `id`, searched for in every page and partial. */
export async function findMarker(fs: VirtualFileSystem, projectId: string, id: string): Promise<TargetResult> {
  const found: SourceElement[] = [];
  for (const path of await fs.listFilePaths(projectId)) {
    if (!isMarkupFile(path)) continue;
    const content = await readText(fs, projectId, path);
    if (!content || !content.includes(id)) continue;
    for (const node of scanElements(content)) {
      if (readMarkerAt(content, node.start) !== id) continue;
      const element = describe(path, node.start, content, null);
      if (element) found.push(element);
    }
  }
  if (found.length === 0) return { ok: false, error: `no element carries the marker @${id}` };
  if (found.length > 1) {
    return { ok: false, error: `the marker @${id} is on ${found.length} elements (${found.map(e => `<${e.tag}> ${e.ref}`).join(', ')}), so they share its styles. Name one by its position, or give all but one a marker of their own by removing data-osw-id="${id}" from them` };
  }
  return { ok: true, element: found[0] };
}

/** The elements the compile tags whose open tags start on `line`, in order. */
function startingOn(file: string, content: string, line: number): SourceElement[] {
  const range = lineRange(content, line);
  if (!range) return [];
  const out: SourceElement[] = [];
  for (const node of scanElements(content)) {
    if (node.start < range.start || node.start > range.end || !carriesProvenance(node.tag)) continue;
    const element = describe(file, node.start, content, null);
    if (element) out.push(element);
  }
  return out;
}

const listed = (elements: readonly SourceElement[]) => elements.map(e => `  <${e.tag}>  ${e.ref}`).join('\n');

/**
 * The element at a source position: the one whose open tag starts at `line:col`, or with no column
 * the one element that starts on that line. A miss lists what does start there or nearby, so the
 * next try can name one.
 */
export async function findPosition(fs: VirtualFileSystem, projectId: string, file: string, line: number, col: number | null): Promise<TargetResult> {
  const content = await readText(fs, projectId, file);
  if (content === null) return { ok: false, error: `${file} does not exist` };
  const range = lineRange(content, line);
  if (!range) return { ok: false, error: `${file} has ${lineAt(content, content.length)} lines; there is no line ${line}` };
  const here = startingOn(file, content, line);
  if (col !== null) {
    const exact = here.find(e => e.offset === range.start + col - 1);
    if (exact) return { ok: true, element: exact };
  } else if (here.length === 1) {
    return { ok: true, element: here[0] };
  }
  const where = col === null ? `${file}:${line}` : `${file}:${line}:${col}`;
  if (here.length > 0) {
    return { ok: false, error: `${col === null ? `${here.length} elements start on line ${line} of ${file}` : `no element starts at ${where}`}. On that line:\n${listed(here)}\nName one of these` };
  }
  const near: SourceElement[] = [];
  for (let n = Math.max(1, line - 3); n <= line + 3; n++) if (n !== line) near.push(...startingOn(file, content, n));
  return {
    ok: false,
    error: `no element's open tag starts on line ${line} of ${file} (the file may have changed since that position was read)`
      + (near.length > 0 ? `. Near it:\n${listed(near.slice(0, 8))}` : ''),
  };
}

/**
 * A target as an artboard frame is asked for it: a position becomes the `data-osw-src` value the
 * compile stamps; a marker or a selector goes as written.
 */
export async function frameTarget(fs: VirtualFileSystem, projectId: string, arg: string): Promise<{ ok: true; target: string } | { ok: false; error: string }> {
  const target = parseElementTarget(arg);
  if (target.kind !== 'position') return { ok: true, target: arg };
  const found = await findPosition(fs, projectId, target.file, target.line, target.col);
  return found.ok ? { ok: true, target: found.element.src } : found;
}

/** The DOM's matcher, where there is a DOM. */
export const domMatcher: ElementMatcher = (html, selector) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll(selector), el => ({ src: el.getAttribute('data-osw-src'), tag: el.tagName.toLowerCase() }));
};

/**
 * The one source element `selector` matches on the compiled page `html`. Several elements from one
 * source tag (a loop, a partial used twice) are one element; elements from several tags are
 * refused with their positions listed, so the agent can pick one.
 */
export async function findBySelector(
  fs: VirtualFileSystem,
  projectId: string,
  page: string,
  html: string,
  selector: string,
  match: ElementMatcher,
): Promise<TargetResult> {
  let matched: MatchedElement[];
  try {
    matched = await match(html, selector);
  } catch {
    return { ok: false, error: `"${selector}" is not a selector the parser accepts` };
  }
  if (matched.length === 0) return { ok: false, error: `nothing on ${page} matches "${selector}"` };
  const counts = new Map<string, number>();
  for (const el of matched) if (el.src) counts.set(el.src, (counts.get(el.src) ?? 0) + 1);
  if (counts.size === 0) {
    return { ok: false, error: `"${selector}" matches only elements of ${page} that are not written in the project's HTML (a script builds them, or the browser adds them, as it adds <tbody> to a table). style needs an element that is written in a file` };
  }
  if (counts.size > 1) {
    const lines: string[] = [];
    for (const src of [...counts.keys()].slice(0, 6)) {
      const parts = parseSrc(src);
      if (!parts) {
        lines.push('  an element with an unreadable source position');
        continue;
      }
      const content = await readText(fs, projectId, parts[0]);
      const element = content ? describe(parts[0], parts[1], content, null) : null;
      lines.push(element ? `  <${element.tag}>  ${element.ref}${element.marker ? `  @${element.marker}` : ''}` : `  an element of ${parts[0]}`);
    }
    const more = counts.size > 6 ? `\n  …and ${counts.size - 6} more` : '';
    return { ok: false, error: `"${selector}" matches ${matched.length} elements on ${page}, written in ${counts.size} places:\n${lines.join('\n')}${more}\nstyle changes one element. Name one of these by its position, or use a narrower selector. To change them all, edit the rule for "${selector}" in the project's stylesheet` };
  }
  const [src, instances] = [...counts.entries()][0];
  const parts = parseSrc(src);
  if (!parts) return { ok: false, error: `"${selector}" matched an element with an unreadable source position` };
  const content = await readText(fs, projectId, parts[0]);
  const element = content ? describe(parts[0], parts[1], content, instances) : null;
  if (!element) return { ok: false, error: `the source of the element "${selector}" matches has changed since the page compiled; try again` };
  return { ok: true, element };
}
