// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { STYLE_QUERY_JS, STYLE_PREVIEW_JS, STYLE_LOCATOR_JS, STYLE_PROBE_JS } from '../style-preview';

/**
 * The probe — rank every declaration of a property, and see whether ours is the one that wins —
 * run out of the *emitted* text.
 *
 * ## What is deliberately NOT in this file, and why
 *
 * **jsdom's own cascade detects exactly one loss: an inline `style` attribute.** Measured, not
 * reasoned: jsdom ranks specificity above importance, so the override's doubled `(0,2,0)` selector
 * beats an `!important` rule and beats `#id` there. The probe no longer *reads* jsdom's cascade —
 * it ranks declarations itself with {@link __oswBeats}, which gets importance right — but the
 * assertions in this file still have to be ones a reader can confirm against the environment, so
 * the full matrix of what beats an override lives in `e2e/style-probe.test.ts` and runs in Chrome.
 *
 * What jsdom *can* prove is exactly the part that was wrong: an override whose value agrees with
 * what the element already had is **in force**, not lost. That is a property of the ranking, not of
 * the engine, and it is checked below.
 */
const frame = new Function(
  `${STYLE_QUERY_JS}${STYLE_PREVIEW_JS}${STYLE_LOCATOR_JS}${STYLE_PROBE_JS}\nreturn {
     swap: __oswApplyOverrides,
     probe: __oswProbeStyleLoss
   };`,
)() as {
  swap: (css: string) => Element | null;
  probe: (el: Element | null, markerId: string, properties: unknown) => { lost: string[]; winner: string | null; written: string[] };
};

const SELECTOR = '[data-osw-id="m1"][data-osw-id]';

/** The Inspector's write, as the frame receives it: a whole /overrides.css with this one rule. */
const apply = (css: string) => frame.swap(`${SELECTOR} { ${css} }`);

function marked(): Element {
  return document.querySelector('[data-osw-id="m1"]')!;
}

/**
 * A stylesheet that is NOT the swapped-in one — the shape our rule has after a recompile, when
 * `/overrides.css` carries it. jsdom never loads `<link>`, so a `<style>` stands in; what it stands
 * in for is "a sheet nothing about its element marks as ours", which is the whole point: the
 * ranking recognises our declaration by its marker selector, wherever it happens to live.
 */
function pageSheet(css: string): HTMLStyleElement {
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

function computed(property: string): string {
  return window.getComputedStyle(marked()).getPropertyValue(property);
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div class="card" id="hero" data-osw-id="m1">marked</div>';
});

describe('answering when there is nothing to answer about', () => {
  it('reports nothing lost for an element that no longer resolves', () => {
    // The host is waiting on a reply. `lost: []` is the answer; silence is indistinguishable from a
    // frame that has not got round to it.
    expect(frame.probe(null, 'm1', ['color'])).toEqual({ lost: [], winner: null, written: [] });
  });

  it('reports nothing lost when no sheet carries the marker at all', () => {
    // Nothing of ours is in the document, so nothing of ours can have been beaten. The tempting
    // alternative — "our value is not showing, so every property lost" — lights the whole panel up
    // the first time a marker is probed before its block has been written.
    pageSheet('.card { color: rgb(7, 7, 7); }');

    expect(frame.probe(marked(), 'm1', ['color'])).toEqual({ lost: [], winner: null, written: [] });
  });

  it('reports nothing lost for a property nothing reachable declares', () => {
    // Our rule is in the document — the gate above is satisfied — and it says nothing about this
    // property. Neither does anything else, so the value comes from the UA default or from an
    // ancestor and there is no declaration to have beaten. "Lost, to something the preview cannot
    // name" is the shape of message the panel exists to stop showing.
    apply('color: rgb(1, 2, 3);');

    expect(frame.probe(marked(), 'm1', ['padding-left'])).toEqual({ lost: [], winner: null, written: [] });
  });

  it('reports nothing lost for an empty or malformed property list', () => {
    apply('color: rgb(1, 2, 3);');

    expect(frame.probe(marked(), 'm1', [])).toEqual({ lost: [], winner: null, written: [] });
    // `properties` crosses postMessage, so the frame is not the only writer.
    expect(frame.probe(marked(), 'm1', 'color')).toEqual({ lost: [], winner: null, written: [] });
    expect(frame.probe(marked(), 'm1', undefined)).toEqual({ lost: [], winner: null, written: [] });
  });
});

describe('the one loss jsdom gets right', () => {
  it('reports a property beaten by an inline style, and names it', () => {
    apply('color: rgb(1, 2, 3);');
    (marked() as HTMLElement).style.color = 'rgb(3, 3, 3)';
    // The precondition, stated: without it this test also passes against a probe that reports
    // everything lost unconditionally.
    expect(computed('color')).toBe('rgb(3, 3, 3)');

    const out = frame.probe(marked(), 'm1', ['color']);

    expect(out.lost).toEqual(['color']);
    expect(out.winner).toBe('inline style');
  });

  it('reports nothing lost when the override is the thing in force', () => {
    // The control. A probe hard-wired to "lost" fails here; one hard-wired to "not lost" fails
    // above. The competing rule is not decoration: without something for the override to *beat*,
    // a ranking that left our own declaration out would find no candidate at all and answer "not
    // lost" for the wrong reason, which is a fake pass on the case the panel is built around.
    pageSheet('.card { color: rgb(7, 7, 7); }');
    apply('color: rgb(1, 2, 3);');
    expect(computed('color')).toBe('rgb(1, 2, 3)');

    expect(frame.probe(marked(), 'm1', ['color'])).toEqual({ lost: [], winner: null, written: [] });
  });
});

describe('an override that agrees with what the element already had', () => {
  it('is in force, not lost — the false positive the whole rewrite is about', () => {
    // The maintainer's report, at its smallest: padding 0 on an element already at 0, or a margin
    // stepped away and back to 0. The old probe removed our rule, saw the value not move, and
    // called it lost. Nothing had beaten it; it simply agreed with the element's natural value.
    //
    // Staged as the post-recompile shape — our rule in an ordinary sheet rather than the transient
    // <style> — because that is where the report came from, and because a scan that recognises our
    // rule only by which element carries it would answer wrongly here.
    pageSheet(`${SELECTOR} { padding-left: 0px; }`);
    expect(computed('padding-left')).toBe('0px');

    expect(frame.probe(marked(), 'm1', ['padding-left'])).toEqual({ lost: [], winner: null, written: [] });
  });

  it('is still lost when something else is the reason the values agree', () => {
    // The converse, and the reason "the values are equal" is not a shortcut for "not lost": an
    // inline declaration of the very same colour still beats us, and the user's next edit to this
    // property will do nothing.
    apply('color: rgb(3, 3, 3);');
    (marked() as HTMLElement).style.color = 'rgb(3, 3, 3)';

    const out = frame.probe(marked(), 'm1', ['color']);

    expect(out.lost).toEqual(['color']);
    expect(out.winner).toBe('inline style');
  });
});

describe('the page is left exactly as it was found', () => {
  it('touches neither the document nor a computed value', () => {
    // Guaranteed by construction now — the probe ranks declarations and mutates nothing — and
    // asserted anyway, because the hazard the previous remove-and-reinsert implementation carried
    // was not hypothetical: a probe that removes our rule and fails to put it back has silently
    // deleted the user's edit, and the only symptom is the preview reverting a moment later.
    const ours = pageSheet(`${SELECTOR} { color: rgb(1, 2, 3); padding-left: 7px; }`);
    const later = pageSheet(`.card { font-weight: 700; }`);
    const orderBefore = Array.from(document.head.children);
    const before = ['color', 'padding-left', 'display', 'font-weight'].map(computed);
    expect(orderBefore).toEqual([ours, later]);

    frame.probe(marked(), 'm1', ['color', 'padding-left']);

    expect(ours.isConnected).toBe(true);
    expect(Array.from(document.head.children)).toEqual(orderBefore);
    expect(['color', 'padding-left', 'display', 'font-weight'].map(computed)).toEqual(before);
    expect(computed('color')).toBe('rgb(1, 2, 3)');
  });
});

describe('the properties it answers about', () => {
  it('expands a shorthand, so a per-side control is told which side lost', () => {
    // Same expansion `style-query` uses, so `lost` and `values` are keyed alike. The loss is staged
    // as an inline `padding`, this environment's one detectable one.
    (marked() as HTMLElement).setAttribute('style', 'padding: 5px');
    apply('padding: 9px;');
    expect(computed('padding-left')).toBe('5px');

    const out = frame.probe(marked(), 'm1', ['padding']);

    expect(out.lost).toEqual([
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    ]);
    // Named as longhands, never as the shorthand the host happened to ask with.
    expect(out.lost).not.toContain('padding');
    expect(out.winner).toBe('inline style');
    // The name as asked comes back beside them: what a caller that asked with a file's own
    // declarations acts on.
    expect(out.written).toEqual(['padding']);
  });

  it('names, of several asked about, only the ones that lost', () => {
    (marked() as HTMLElement).setAttribute('style', 'padding: 5px');
    apply('padding: 9px; color: rgb(1, 2, 3);');
    const out = frame.probe(marked(), 'm1', ['color', 'padding', 'gap']);
    expect(out.written).toEqual(['padding']);
  });
});
