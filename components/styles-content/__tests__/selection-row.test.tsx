import { describe, it, expect, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StylesContent, describeSelection, sourcePathOf } from '..';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * The selection row — what identifies the element the controls act on once the tree is hidden.
 *
 * The derivation is a pure function and is tested as one. The row is also rendered, because the
 * shared-source badge is the second place the user is warned that a local gesture has global effect,
 * and "it is in the summary object" is not the same claim as "it reaches the screen".
 *
 * Not covered here, and only reachable with a DOM: pressing anything. Every gesture's *decision*
 * lives in `state.ts`, `commit.ts` or `tokens.ts` and is asserted there.
 */

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > article',
  tagName: 'ARTICLE',
  nodeId: 'n1',
  attributes: { class: 'card featured' },
  outerHTML: '<article></article>',
  ...over,
});

function render(selection: FocusContextPayload | null) {
  return renderToStaticMarkup(withMessages(
    <StylesContent
      selection={selection}
      sendToFrame={vi.fn()}
      applyStyle={vi.fn()}
      tokens={[]}
      onOpenFile={vi.fn()}
      onAskAgent={vi.fn()}
      onRefreshPreview={vi.fn()}
    />
  ));
}

describe('describeSelection', () => {
  it('takes the tag, the first class and the source basename', () => {
    expect(describeSelection(payload({ srcAttr: '/partials/cards/card.hbs:120' }))).toEqual({
      tag: 'article',
      className: '.card',
      source: 'card.hbs',
      instances: 1,
    });
  });

  it('has no class and no source when the element carries neither', () => {
    expect(describeSelection(payload({ attributes: {} }))).toMatchObject({
      className: null,
      source: null,
    });
  });

  it('reports how many elements share the source tag', () => {
    expect(describeSelection(payload({ instanceCount: 6 })).instances).toBe(6);
  });
});

describe('sourcePathOf', () => {
  it('splits on the LAST colon, because a path may contain one', () => {
    expect(sourcePathOf('/a:b/index.html:120')).toBe('/a:b/index.html');
    expect(sourcePathOf('/index.html:0')).toBe('/index.html');
  });

  it('is null when there is no provenance', () => {
    expect(sourcePathOf(undefined)).toBeNull();
  });
});

describe('the rendered row', () => {
  it('names the element, its class and its file', () => {
    const html = render(payload({ srcAttr: '/partials/card.hbs:12' }));
    expect(html).toContain('article');
    expect(html).toContain('.card');
    expect(html).toContain('card.hbs');
  });

  it('shows the shared badge when one source tag renders several elements', () => {
    expect(render(payload({ instanceCount: 6 }))).toContain('6 shared');
    expect(render(payload({ instanceCount: 1 }))).not.toContain('shared');
  });

  it('says so when nothing is selected, instead of showing controls that act on nothing', () => {
    const html = render(null);
    expect(html).toContain('No element selected');
    expect(html).not.toContain('Corner radius');
  });

  it('renders a control for every group', () => {
    const html = render(payload());
    for (const group of ['Spacing', 'Type', 'Colour', 'Border', 'Layout']) {
      expect(html, `${group} group missing`).toContain(group);
    }
    expect(html).toContain('Padding, vertical');
    expect(html).toContain('Corner radius');
  });
});
