import { describe, it, expect } from 'vitest';
import { generateNavigationScript, generatePlacementScript } from '../multipage-preview';
import { STRIP_PROVENANCE_JS, injectProvenance, stripProvenance } from '@/lib/preview/provenance';

/**
 * These tests guard the one hazard that is invisible in the source of this file's subject.
 *
 * The preview's iframe scripts are JavaScript template literals, stringified and handed to a
 * `srcdoc` frame. Inside a template literal `\s` collapses to a literal `s` and `\\"` collapses to
 * `"` *before the string is ever emitted*, so a regex that reads correctly in the editor can be a
 * different regex by the time the browser parses it. There is a live instance of exactly this at
 * the `/^sb-\d+-[a-z0-9]+$/` in `generatePlacementScript`, which emits `/^sb-d+-[a-z0-9]+$/`.
 *
 * The defence is to author the strip regex once, in `lib/preview/provenance.ts`, and interpolate
 * `STRIP_PROVENANCE_JS` into both scripts. So the assertions below are:
 *
 *  1. each emitted script carries a stripper that *actually strips* — evaluated out of the emitted
 *     text, not read from source, because only the emitted text tells the truth about escaping;
 *  2. neither script mentions `data-osw-src` in a regex of its own.
 *
 * Test 1 alone is not sufficient: a hand-authored copy with a collapsed backslash would still
 * *contain* the words. It is caught because the extracted function is then run.
 */

/** Both builders emit `<script>…</script>`; the payload between is what the browser parses. */
function scriptSource(emitted: string): string {
  const openEnd = emitted.indexOf('>', emitted.indexOf('<script'));
  const closeStart = emitted.lastIndexOf('</script>');
  expect(openEnd).toBeGreaterThan(0);
  expect(closeStart).toBeGreaterThan(openEnd);
  return emitted.slice(openEnd + 1, closeStart);
}

/**
 * Pull `__oswStripProv` out of the emitted script and make it callable.
 *
 * The script as a whole cannot be evaluated here — it is an IIFE that touches `window` and
 * `document` on the way in. Brace-matching the one function out of it keeps this a node test while
 * still exercising the emitted characters rather than the authored ones.
 */
function extractStripper(emitted: string): (h: string) => string {
  const source = scriptSource(emitted);
  const start = source.indexOf('function __oswStripProv(');
  expect(start, 'no __oswStripProv in the emitted script').toBeGreaterThanOrEqual(0);

  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  expect(end, 'unbalanced braces around __oswStripProv').toBeGreaterThan(start);

  const fn = new Function(`${source.slice(start, end)} return __oswStripProv;`)();
  return fn as (h: string) => string;
}

/** Byte offsets of every `data-osw-src` in a string. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const SCRIPTS: Array<[string, string]> = [
  ['selector script', generateNavigationScript('/index.html')],
  ['placement script', generatePlacementScript()],
];

describe.each(SCRIPTS)('%s — emitted stripper', (_name, emitted) => {
  it('strips a provenance attribute, exactly as the module copy does', () => {
    const strip = extractStripper(emitted);

    const src = '<div class="a"><p>x</p><img src="/i.png"></div>';
    const tagged = injectProvenance(src, '/index.html');
    expect(tagged).toContain('data-osw-src');

    // Not `not.toContain('data-osw-src')` — a stripper with a collapsed `\s` removes the attribute
    // but leaves the space in front of it, and would pass that weaker assertion.
    expect(strip(tagged)).toBe(src);
    expect(strip(tagged)).toBe(stripProvenance(tagged));
  });

  it('handles the shapes the preview actually feeds it', () => {
    const strip = extractStripper(emitted);
    expect(strip('')).toBe('');
    expect(strip(undefined as unknown as string)).toBe('');
    const untagged = '<a href="/x">y</a>';
    expect(strip(untagged)).toBe(untagged);
    // The provenance attribute goes, the marker attribute stays.
    expect(strip('<p data-osw-src="/i.html:0" data-osw-id="h7x2m4qp">x</p>'))
      .toBe('<p data-osw-id="h7x2m4qp">x</p>');
  });
});

describe.each(SCRIPTS)('%s — no hand-authored provenance regex', (_name, emitted) => {
  it('interpolates the shared constant exactly once', () => {
    expect(occurrences(emitted, STRIP_PROVENANCE_JS)).toHaveLength(1);
  });

  it('mentions data-osw-src only inside string literals, never in a regex of its own', () => {
    // Remove the one sanctioned copy; every remaining mention must be a plain string literal
    // ('data-osw-src' or '[data-osw-src]'), i.e. an attribute name passed to a DOM API. A regex
    // literal would be preceded by `/` or `[^"]*` and fail this.
    const rest = emitted.split(STRIP_PROVENANCE_JS).join('');
    const hits = occurrences(rest, 'data-osw-src');
    for (const at of hits) {
      const before = rest.slice(Math.max(0, at - 2), at);
      expect(before.endsWith("'") || before.endsWith("'["), `unquoted mention at ${at}`).toBe(true);
    }
  });
});

describe('selector script — provenance never reaches the agent', () => {
  const emitted = generateNavigationScript('/index.html');

  it('skips data-osw-src when gathering attributes', () => {
    expect(emitted).toContain("if (name === 'data-osw-src')");
  });

  it('strips the outerHTML it sends to the host', () => {
    // Nested inside the node-id stripper since the Elements tree stamps live elements; see
    // preview-plumbing.test.ts, which runs both strippers out of the emitted text.
    expect(emitted).toContain('outerHTML: __oswStripNodeId(__oswStripProv(target.outerHTML');
  });

  it('counts instances without building a selector out of a source value', () => {
    // Building `[data-osw-src="' + srcAttr + '"]` would need escaping inside a template literal —
    // the trap this whole file exists for. The count itself, for a source whose path holds a quote
    // and a backslash, is run in a document in selection-page-dom.test.ts.
    expect(emitted).not.toContain('[data-osw-src="');
  });
});

describe('placement script — provenance never reaches the agent', () => {
  it('strips the htmlContext it sends to the host', () => {
    expect(generatePlacementScript()).toContain('return __oswStripNodeId(__oswStripProv(clone.outerHTML));');
  });
});
