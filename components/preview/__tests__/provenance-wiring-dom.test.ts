// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import { injectProvenance } from '@/lib/preview/provenance';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * The selector script, run for real against a DOM.
 *
 * `provenance-wiring.test.ts` proves the emitted stripper strips; this proves the script around it
 * does the right thing with a live document — that the payload names the *source* tag, counts every
 * rendered copy of it, and carries no provenance out to the host. Nothing else in the suite
 * executes this script, so it is the only place a wiring mistake inside the IIFE surfaces.
 *
 * Separate file rather than a `describe` block next door because vitest's environment directive is
 * per file (`vitest.config.ts` sets `node`), and the sibling's assertions are pure string work that
 * has no business paying for a DOM.
 */

/**
 * The builder returns HTML — `<script>` tags and all. Handing its return straight to `new Function`
 * throws `Unexpected token '<'`; the JS has to be unwrapped first.
 */
function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface PostedMessage {
  type?: string;
  payload?: FocusContextPayload;
}

describe('selector script against a live DOM', () => {
  it('posts a payload naming the source, with the right instance count and no leak', () => {
    // Three rendered articles from ONE source tag, as a {{#each}} produces: the same injected
    // string three times, so all three carry the same index.
    const one = injectProvenance('<article class="post"><h2>t</h2></article>', '/index.hbs');
    document.body.innerHTML = `<main>${one}${one}${one}</main>`;

    const posted: PostedMessage[] = [];
    // The script only posts when it believes it is framed (`window !== window.parent`), so this
    // stands in for the host frame. It has to be in place before the IIFE runs — that comparison is
    // captured once, on the way in.
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (message: unknown) => { posted.push(message as PostedMessage); } },
    });

    new Function(jsOf(generateNavigationScript('/index.html')))();
    window.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'selector-toggle', active: true }, source: window.parent }));

    // The *second* article, deliberately: the index reported has to be the one source tag's, not
    // the rendered element's. That is the property the whole design rests on — if provenance were
    // per-rendered-element, this would come back as the second article's own position.
    const article = document.querySelectorAll('article')[1] as HTMLElement;
    article.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const selection = posted.find(m => m.type === 'selector-selection');
    expect(selection, 'no selector-selection message was posted').toBeTruthy();
    const payload = selection?.payload as FocusContextPayload;

    // `:0` is the `<article` offset within the *source* string. Asserted exactly rather than as
    // `:\d+`: the second rendered article sits well past character 0 of the document, so an
    // implementation reporting the rendered position instead of the source position fails here.
    expect(payload.srcAttr).toBe('/index.hbs:0');
    expect(payload.instanceCount).toBe(3);

    // The three surfaces that reach the agent's prompt: attributes, outerHTML, domPath.
    expect(JSON.stringify(payload.attributes)).not.toContain('data-osw-src');
    expect(payload.outerHTML).not.toContain('data-osw-src');
    expect(payload.outerHTML).toBe('<article class="post"><h2>t</h2></article>');
    expect(payload.domPath).toBe('html > body > main > article:nth-of-type(2)');
  });
});
