/**
 * Compile-time provenance for the preview.
 *
 * Inserts `data-osw-src="<path>:<index>"` into element open tags so a rendered element can name the
 * source that produced it.
 *
 * **Value format.** `<path>:<index>`. A path may itself contain `:`, so a consumer must split on the
 * *last* colon — `v.slice(0, v.lastIndexOf(':'))` and `v.slice(v.lastIndexOf(':') + 1)` — never
 * `split(':')`.
 *
 * **Why code units.** `<index>` is a UTF-16 code-unit index into the file's string content. File
 * content is a JS string throughout the compile pipeline and `slice`/`indexOf` are code-unit
 * indexed, so a byte or code-point offset would desynchronise on the first non-ASCII character. The
 * built-in templates are full of them.
 *
 * **Path escaping is one-way.** A `"` in `filePath` is escaped to `&quot;` so it cannot terminate
 * the attribute, and nothing reverses it. A path containing `"` therefore does not round-trip, and a
 * consumer must not assume the emitted path compares equal to the VFS path. No VFS path contains `"`
 * today.
 *
 * Preview-only instrumentation. It must never reach project source or published output; see the
 * `provenance` option on VirtualServer, which is off unless the preview asks for it.
 *
 * Used by the preview's navigation and placement scripts (`STRIP_PROVENANCE_JS`), which strip the
 * attribute out of everything the agent sees, and by `curl -o` (`stripProvenance`), the one path
 * that writes compiled HTML back into project source.
 */

/**
 * Never tagged.
 *
 * `html`, `head` and `body` are excluded because code downstream matches the *opening* tag as a
 * literal string: `lib/preview/inject-vfs-blob-map.ts` does `html.includes('<head>')`, and
 * `lib/preview/virtual-server.ts` falls back to `content.includes('<body>')`. A tagged
 * `<head data-osw-src="...">` fails that test and sends the blob map down a fallback branch that
 * prepends it *before* the doctype, putting the whole preview into quirks mode. The rest are
 * head-region or non-visual tags that are never direct-edit targets, so excluding them costs
 * nothing.
 */
export const UNTAGGED_TAGS = [
  'html', 'head', 'body', 'title', 'meta', 'link', 'base', 'script', 'style',
] as const;
const EXCLUDED_TAGS = new Set<string>(UNTAGGED_TAGS);

/**
 * Elements whose content is text, not markup, so the scanner must skip to the closing tag.
 *
 * `title` and `textarea` are RCDATA: `<title>a<div>b</title>` contains no element. Missing them
 * would tag text as if it were a tag. `textarea` is not in EXCLUDED_TAGS because the element itself
 * is a legitimate styling target; only its content is skipped.
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);

/** Whether the compile stamps `data-osw-src` on a tag of this (lowercase) name. */
export function carriesProvenance(tagName: string): boolean {
  return !EXCLUDED_TAGS.has(tagName);
}

/**
 * The attribute name.
 *
 * Renaming it means editing STRIP_RE and STRIP_PROVENANCE_JS below in the same change: both spell
 * the name out literally, because a regex source cannot interpolate this constant without
 * re-escaping it. A rename that misses one does not fail to compile — it silently breaks the
 * inject/strip inverse. The round-trip tests are what catch that.
 */
const ATTR = 'data-osw-src';

function isAsciiLetter(c: string | undefined): boolean {
  if (!c) return false;
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * True at a character that ends a tag name.
 *
 * The HTML tokenizer ends a tag name only at whitespace, `/` or `>`, so every other character is
 * part of the name — including `_` and `.`, which are legal in custom element names, and non-ASCII
 * characters. Testing for terminators rather than enumerating permitted characters is what keeps
 * `<my_el>` from being read as `<my` (which splices the attribute into the middle of the name, so
 * the browser sees a `<my>` element with an `_el` attribute and every `my_el` selector stops
 * matching in the preview but not in the published site) and `<style_guide>` from being read as
 * `<style>` (excluded *and* raw-text, so its whole subtree would silently lose provenance).
 *
 * `<` is not a spec terminator but is included so malformed markup like `<p>a <b</p>` cannot run the
 * name to end of file.
 */
function isTagNameEnd(c: string | undefined): boolean {
  return c === undefined || c === ' ' || c === '\t' || c === '\n' ||
    c === '\f' || c === '\r' || c === '/' || c === '>' || c === '<';
}

/** Index just past the `>` ending an open tag, starting from `from` (already past the tag name). */
function findTagEnd(s: string, from: number): number {
  const n = s.length;
  let i = from;
  while (i < n) {
    // A mustache can hold a quote or a `>`; treat it as opaque so it cannot end the tag early.
    // `{{> partial}}` is the common case — its `>` sits one character in.
    if (s.startsWith('{{{', i)) { const e = s.indexOf('}}}', i + 3); i = e === -1 ? n : e + 3; continue; }
    if (s.startsWith('{{', i))  { const e = s.indexOf('}}', i + 2);  i = e === -1 ? n : e + 2; continue; }
    const c = s[i];
    if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); i = e === -1 ? n : e + 1; continue; }
    if (c === '>') return i + 1;
    i++;
  }
  return n;
}

/** What `readOpenTagAt` reports about an element open tag. */
export interface OpenTag {
  /** Lowercased, so callers compare against a lowercase set without repeating the fold. */
  tagName: string;
  /** Index just past the tag name — the insertion point for an attribute, before author ones. */
  nameEnd: number;
  /** Index just past the `>` that ends the open tag. */
  tagEnd: number;
}

/**
 * Read the element open tag that starts at `index`, or `null` if one does not start there.
 *
 * The single shared tag scanner. `injectProvenance` uses it below; `lib/direct-edit/marker.ts`
 * uses it to stamp a marker, to read an existing one, and to validate that an index handed over
 * from a possibly-stale compile still points at the element it claims to. Hand-rolled copies would
 * each have to re-derive the tag-name rule (see `isTagNameEnd` — this scanner already shipped a bug
 * where `<my_el>` read as `<my`) and the mustache-opaque `>` search, and would diverge.
 *
 * `index` points at the `<`; the name scan starts one past it. Starting the scan *at* `index` looks
 * equivalent but is not — `isTagNameEnd('<')` is `true`, so the scan returns immediately, the name
 * is empty, and every stamped attribute lands inside the tag name.
 */
export function readOpenTagAt(content: string, index: number): OpenTag | null {
  if (content[index] !== '<' || !isAsciiLetter(content[index + 1])) return null;
  const n = content.length;
  let j = index + 1;
  while (j < n && !isTagNameEnd(content[j])) j++;
  return {
    tagName: content.slice(index + 1, j).toLowerCase(),
    nameEnd: j,
    tagEnd: findTagEnd(content, j),
  };
}

export function injectProvenance(content: string, filePath: string): string {
  const path = filePath.replace(/"/g, '&quot;');
  const inserts: Array<{ at: number; text: string }> = [];
  const n = content.length;
  let i = 0;
  let lower: string | undefined;

  while (i < n) {
    if (content.startsWith('{{!--', i)) { const e = content.indexOf('--}}', i + 5); i = e === -1 ? n : e + 4; continue; }
    if (content.startsWith('{{{', i))   { const e = content.indexOf('}}}', i + 3);  i = e === -1 ? n : e + 3; continue; }
    if (content.startsWith('{{', i))    { const e = content.indexOf('}}', i + 2);   i = e === -1 ? n : e + 2; continue; }
    if (content.startsWith('<!--', i))  {
      // `<!-->` and `<!--->` are legal abrupt-closing empty comments. Searching for `-->` from
      // i + 4 starts past their terminator, finds nothing, and swallows the rest of the file.
      if (content.startsWith('>', i + 4))  { i += 5; continue; }
      if (content.startsWith('->', i + 4)) { i += 6; continue; }
      const e = content.indexOf('-->', i + 4); i = e === -1 ? n : e + 3; continue;
    }
    if (content.startsWith('<![CDATA[', i)) { const e = content.indexOf(']]>', i + 9); i = e === -1 ? n : e + 3; continue; }
    if (content.startsWith('<!', i))    { const e = content.indexOf('>', i + 2);    i = e === -1 ? n : e + 1; continue; }
    if (content.startsWith('</', i))    { const e = content.indexOf('>', i + 2);    i = e === -1 ? n : e + 1; continue; }

    const tag = readOpenTagAt(content, i);
    if (tag) {
      const { tagName, nameEnd, tagEnd } = tag;

      if (!EXCLUDED_TAGS.has(tagName)) {
        inserts.push({ at: nameEnd, text: ` ${ATTR}="${path}:${i}"` });
      }

      if (RAW_TEXT_TAGS.has(tagName)) {
        // Lowercased at most once per file rather than once per raw-text element. toLowerCase()
        // preserves length for everything these templates realistically contain; a few exotic code
        // points (U+0130) expand and would shift this index.
        lower ??= content.toLowerCase();
        const close = lower.indexOf(`</${tagName}`, tagEnd);
        i = close === -1 ? n : close;
      } else {
        i = tagEnd;
      }
      continue;
    }

    i++;
  }

  if (inserts.length === 0) return content;

  // Build forward in one pass. Splicing backwards with slice() would be quadratic, and this runs on
  // every page of every preview compile — a path already known to be performance-sensitive (see the
  // 621-page note on processInternalReferences).
  const parts: string[] = [];
  let cursor = 0;
  for (const ins of inserts) {
    parts.push(content.slice(cursor, ins.at), ins.text);
    cursor = ins.at;
  }
  parts.push(content.slice(cursor));
  return parts.join('');
}

const STRIP_RE = /\s?data-osw-src="[^"]*:\d+"/g;

/**
 * Remove provenance attributes from a markup string. Inverse of injectProvenance for anything
 * injectProvenance produced.
 *
 * Deliberately not described as total. This is a text substitution, so author content that looks
 * exactly like an emitted attribute — the literal `data-osw-src="…:<digits>"`, most plausibly inside
 * a `<code>` sample documenting this very mechanism — is removed too. The `:<digits>` requirement
 * exists to make that collision unlikely rather than merely possible: without it, prose as ordinary
 * as `data-osw-src="mine"` was silently deleted. The residual false positive is accepted because
 * `curl -o` writes the stripped result back into project source, where a false positive is data
 * loss rather than a display glitch, and narrowing further would risk missing real attributes.
 */
export function stripProvenance(html: string): string {
  return html.replace(STRIP_RE, '');
}

/**
 * The same stripper, as JavaScript source for injection into the preview iframe.
 *
 * The selector script (`navigation-script.ts`) and the placement script (`placement-script.ts`) are
 * template literals stringified into the iframe, so they cannot import this module. Interpolating
 * this constant keeps one authored copy instead of three, and avoids hand-escaping a regex inside a
 * template literal, where `\s` would collapse to a literal `s` before being emitted.
 *
 * The doubled backslashes below are deliberate: this is a template literal, so `\\s` here is `\s`
 * and `\\d` is `\d` in the emitted JavaScript. The pattern must stay identical to STRIP_RE above —
 * the tests assert on the emitted text and on agreement between the two copies.
 */
export const STRIP_PROVENANCE_JS =
  `function __oswStripProv(h){return String(h||'').replace(/\\s?data-osw-src="[^"]*:\\d+"/g,'');}`;
