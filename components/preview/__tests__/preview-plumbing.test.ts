import { describe, it, expect } from 'vitest';
import { generateNavigationScript, generatePlacementScript, STRIP_NODE_ID_JS } from '../multipage-preview';

/**
 * The preview plumbing the Elements tree needs, asserted on the *emitted* iframe scripts.
 *
 * Two kinds of assertion live here, and they catch different things:
 *
 *  1. **Structural.** That there is exactly one place a focus payload is assembled, and exactly one
 *     place the highlight overlay is shown or hidden. A test that merely compared two payloads
 *     would pass just as happily against two copies of the logic — and would keep passing until
 *     the copies drifted, which is the failure it was supposed to prevent. Counting the
 *     construction sites is the assertion that cannot be satisfied by duplication.
 *  2. **Behavioural, out of the emitted text.** These scripts are template literals, so `\s`
 *     authored inside one is a literal `s` by the time the browser sees it. Reading the source
 *     proves nothing; the strippers are therefore extracted from the emitted string and run.
 */

/** Both builders emit `<script>…</script>`; the payload between is what the browser parses. */
function scriptSource(emitted: string): string {
  const openEnd = emitted.indexOf('>', emitted.indexOf('<script'));
  const closeStart = emitted.lastIndexOf('</script>');
  expect(openEnd).toBeGreaterThan(0);
  expect(closeStart).toBeGreaterThan(openEnd);
  return emitted.slice(openEnd + 1, closeStart);
}

/** The full text of a named function declaration, brace-matched out of a script. */
function functionText(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `no ${name} in the emitted script`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

const NAV = scriptSource(generateNavigationScript('/index.html'));

describe('the focus payload has exactly one construction site', () => {
  it('declares buildSelectionPayload once and builds the payload nowhere else', () => {
    expect(count(NAV, 'function buildSelectionPayload(')).toBe(1);
    // `domPath:` is the object literal's first key, so counting it counts payload literals. A
    // second caller that assembled its own — the shape the tree-select path could easily take —
    // makes this 2 while every payload-equality test still passes.
    expect(count(NAV, 'domPath:')).toBe(1);
    expect(functionText(NAV, 'buildSelectionPayload')).toContain('domPath:');
  });

  it('has handleClick delegate rather than assemble', () => {
    const handleClick = functionText(NAV, 'handleClick');
    expect(handleClick).toContain('buildSelectionPayload(target)');
    // The fields that used to be computed inline. Their absence is what says the extraction moved
    // the logic instead of copying it.
    expect(handleClick).not.toContain('domPath:');
    expect(handleClick).not.toContain('gatherAttributes(');
    expect(handleClick).not.toContain('querySelectorAll');
  });

  it('takes only the element, so a caller without an event can use it', () => {
    const builder = functionText(NAV, 'buildSelectionPayload');
    expect(builder.slice(0, builder.indexOf(')') + 1)).toBe('function buildSelectionPayload(target)');
    expect(builder).not.toContain('event');
  });
});

describe('the highlight overlay is identifiable and has one visibility control', () => {
  it('marks the overlay so it can be told from a user div', () => {
    expect(functionText(NAV, 'ensureOverlay')).toContain("setAttribute('data-osw-overlay', '1')");
  });

  it('routes every show and hide through setOverlayVisible', () => {
    expect(count(NAV, 'function setOverlayVisible(')).toBe(1);
    expect(functionText(NAV, 'handleMouseMove')).toContain('setOverlayVisible(target)');
    expect(functionText(NAV, 'handleMouseMove')).not.toContain('positionOverlay(');
    // Restores the selection's outline rather than blanking it. Clicking an element runs
    // disableSelector immediately after the toolbar starts tracking it, so 'setOverlayVisible(null)'
    // here is what used to leave a click-selected element unmarked while a tree-selected one kept
    // its outline. The behaviour is asserted in toolbar-chrome-dom.test.ts; this only pins that the
    // one visibility control is still the only route.
    expect(functionText(NAV, 'disableSelector')).toContain('setOverlayVisible(__oswToolbarState.tracked');
    expect(functionText(NAV, '__oswToolbarOnPlace')).toContain('setOverlayVisible(target, measured)');
    // The outline reuses the rect the toolbar placed itself from rather than measuring again. Two
    // measurements in one pass drift apart whenever layout is still settling — an image swap does
    // exactly that — and the bar and the outline then mark the element from different moments.
    expect(functionText(NAV, 'positionOverlay')).toContain('measured || target.getBoundingClientRect()');
  });

  it('never detaches the overlay', () => {
    // Detaching and re-appending churns document.body.children between serializations of the same
    // level, and the removal path was reachable only from disableSelector — so a highlight raised
    // with the selector off had no way back down.
    expect(NAV).not.toContain('clearOverlay');
    expect(NAV).not.toContain('removeChild(selectorState.overlay');
    expect(functionText(NAV, 'setOverlayVisible')).not.toContain('removeChild');
  });
});

const SCRIPTS: Array<[string, string]> = [
  ['selector script', generateNavigationScript('/index.html')],
  ['placement script', generatePlacementScript()],
];

describe.each(SCRIPTS)('%s — the emitted node-id stripper', (_name, emitted) => {
  const strip = new Function(`${functionText(scriptSource(emitted), '__oswStripNodeId')} return __oswStripNodeId;`)() as
    (h: string) => string;

  it('removes the tree stamp and the space in front of it', () => {
    // Exact equality, not `not.toContain`: a stripper whose `\s` collapsed to a literal `s` still
    // removes the attribute — it just leaves the space — and would pass the weaker assertion.
    expect(strip('<p class="a" data-osw-node="17">x</p>')).toBe('<p class="a">x</p>');
    expect(strip('<p data-osw-node="17" class="a">x</p>')).toBe('<p class="a">x</p>');
  });

  it('strips every stamp in a subtree, which is what an expanded level looks like', () => {
    expect(strip('<ul data-osw-node="1"><li data-osw-node="2">a</li><li data-osw-node="3">b</li></ul>'))
      .toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('handles the shapes the preview actually feeds it', () => {
    expect(strip('')).toBe('');
    expect(strip(undefined as unknown as string)).toBe('');
    const untouched = '<a href="/x" data-osw-id="h7x2m4qp">y</a>';
    expect(strip(untouched)).toBe(untouched);
  });
});

describe('the node-id stripper is authored once', () => {
  it('is interpolated from the shared constant, not hand-written into either script', () => {
    // Hand-writing it inside a template literal is the trap this whole arrangement avoids.
    expect(count(generateNavigationScript('/index.html'), STRIP_NODE_ID_JS)).toBe(1);
    expect(count(generatePlacementScript(), STRIP_NODE_ID_JS)).toBe(1);
  });

  it('mentions data-osw-node outside that constant only as a plain string literal', () => {
    for (const [, emitted] of SCRIPTS) {
      const rest = emitted.split(STRIP_NODE_ID_JS).join('');
      for (let at = rest.indexOf('data-osw-node'); at !== -1; at = rest.indexOf('data-osw-node', at + 1)) {
        const before = rest.slice(Math.max(0, at - 2), at);
        expect(before.endsWith("'") || before.endsWith("'["), `unquoted mention at ${at}`).toBe(true);
      }
    }
  });
});

describe('the placement script knows the overlay is not content', () => {
  // Consequence of the overlay becoming permanent: findDropTarget falls back to the last child of
  // body when the pointer is over bare body, and buildDomPath counts siblings. Both go through
  // isPlaceholderOrIndicator, so teaching it the marker covers both.
  const isFurniture = new Function(
    `${functionText(scriptSource(generatePlacementScript()), 'isPlaceholderOrIndicator')} return isPlaceholderOrIndicator;`
  )() as (el: unknown) => boolean;

  const el = (attr?: string, value = 'true') => ({
    getAttribute: (name: string) => (attr === name ? value : null),
  });

  it('recognises the overlay alongside the placement furniture', () => {
    expect(isFurniture(el('data-osw-overlay', '1'))).toBe(true);
    expect(isFurniture(el('data-semantic-indicator'))).toBe(true);
    expect(isFurniture(el('data-semantic-placeholder'))).toBe(true);
  });

  it('still treats a user element as a drop target', () => {
    expect(isFurniture(el('class', 'card'))).toBe(false);
    expect(isFurniture(el())).toBe(false);
    expect(isFurniture(null)).toBe(false);
  });
});

describe('preview-only attributes are skipped when gathering attributes', () => {
  it('skips the tree stamp alongside provenance', () => {
    const gather = functionText(NAV, 'gatherAttributes');
    expect(gather).toContain("if (name === 'data-osw-src')");
    expect(gather).toContain("if (name === 'data-osw-node')");
  });
});

describe('the page path in the script', () => {
  const path = "/it's/a\\b.html";
  const source = scriptSource(generateNavigationScript(path));

  it('parses for a page whose path has a quote or a backslash in it', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('resolves a relative link against that path', () => {
    const resolve = new Function('href', `${functionText(source, 'resolveInternalPath')}\nreturn resolveInternalPath(href);`);
    expect(resolve('next.html')).toBe("/it's/next");
  });
});
