import { describe, it, expect, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { ElementsPanel, unavailableCopy, type TreeUnavailable } from '..';
import type { ProjectRuntime } from '@/lib/vfs/types';
import en from '@/messages/en.json';

/**
 * The real translator over the shipped English, not a stub: a key renamed out of `en.json` then
 * fails here instead of quietly matching a fixture, and the assertions below stay readable.
 */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'elementsPanel' });

/**
 * The tab strip, rendered.
 *
 * There is no React Testing Library here, and this is the one thing in the panel that a pure
 * function cannot cover: the failure being guarded against is *structural* — the panel used to
 * return early four times before its body, so a tab strip added around "the body" disappears in
 * every state but the happy one, and no assertion about a helper function would notice.
 *
 * `renderToStaticMarkup` is enough for that: effects do not run, nothing is clicked, and the only
 * questions asked are "is this element in the output" — which is exactly the question. Everything
 * behavioural about the panel lives in `reduceTree` and `reduceStyles` and is tested there. What
 * remains out of reach here is the half of the controlled contract that needs an event: that a
 * press reports upward instead of switching the tab locally. That is `controlled-tab.test.tsx`.
 */

function render(props: Partial<React.ComponentProps<typeof ElementsPanel>> = {}) {
  return renderToStaticMarkup(withMessages(
    <ElementsPanel
      projectId="p1"
      runtime="handlebars"
      previewOpen
      onOpenPreview={vi.fn()}
      sendToFrame={vi.fn()}
      selection={null}
      applyStyle={vi.fn()}
      colorTokens={[]}
      onOpenFile={vi.fn()}
      onAskAgent={vi.fn()}
      onRefreshPreview={vi.fn()}
      activeTab="tree"
      onTabChange={vi.fn()}
      {...props}
    />
  ));
}

/** The strip is two `role="tab"` buttons. Counting them catches "rendered, but only one of them". */
function tabs(html: string): string[] {
  return Array.from(html.matchAll(/role="tab"[^>]*>([^<]*)</g), m => m[1]);
}

/**
 * Each pane's `data-state`, whether it carries the `hidden` attribute, and which tab it belongs to.
 *
 * The name comes from Radix's own `aria-labelledby`, which points at the pane's trigger — the only
 * thing in the markup that says which pane this is. Without it "the Styles pane is rendered" is
 * true in every state, both panes being force-mounted, and an assertion that reads it would pass
 * against a panel that ignores `activeTab` entirely.
 */
function panes(html: string): { name: string | undefined; state: string | undefined; hidden: boolean }[] {
  return Array.from(html.matchAll(/<div([^>]*role="tabpanel"[^>]*)>/g), m => ({
    name: /aria-labelledby="[^"]*-trigger-(\w+)"/.exec(m[1])?.[1],
    state: /data-state="(\w+)"/.exec(m[1])?.[1],
    hidden: /\shidden=""/.test(m[1]),
  }));
}

/** The one pane the user can actually see. */
function shown(html: string): string | undefined {
  return panes(html).find(pane => !pane.hidden)?.name;
}

const UNAVAILABLE: { name: TreeUnavailable; props: Partial<React.ComponentProps<typeof ElementsPanel>> }[] = [
  { name: 'no-project', props: { projectId: null } },
  { name: 'terminal-runtime', props: { runtime: 'python' as ProjectRuntime } },
  { name: 'bundled-runtime', props: { runtime: 'react' as ProjectRuntime } },
  { name: 'preview-closed', props: { previewOpen: false } },
];

describe('the tab strip', () => {
  it('is there when the panel is working', () => {
    expect(tabs(render())).toEqual(['Elements', 'Styles']);
  });

  it.each(UNAVAILABLE)('survives $name', ({ props }) => {
    expect(tabs(render(props))).toEqual(['Elements', 'Styles']);
  });

  it.each(UNAVAILABLE)('shows one message for both tabs in $name', ({ name, props }) => {
    const html = render(props);
    const copy = unavailableCopy(t, name, (props.runtime as ProjectRuntime) ?? 'handlebars');
    expect(html).toContain(copy.title);
    // Once, not once per tab: every reason here removes the document both tabs read from.
    expect(html.split(copy.title)).toHaveLength(2);
  });

  it('offers to open the preview only for the state that has one to open', () => {
    expect(render({ previewOpen: false })).toContain('Open preview');
    expect(render({ projectId: null })).not.toContain('Open preview');
  });

  it('mounts both tabs when the panel is working, so neither loses its state to a glance', () => {
    // Radix unmounts an inactive tab by default. The Styles tab would then forget its confirmation,
    // its committed properties and its marker every time the user looked at the tree — and would
    // drop the `style-computed` replies that arrive while it is hidden.
    const html = render();
    expect(html).toContain('No elements yet');
    expect(html).toContain('No element selected');
  });

  it('shows only ONE of the two mounted panes', () => {
    // `forceMount` is what keeps both alive, and it is also what stops Radix hiding either: it
    // computes `hidden={!present}` and `present` is forced true. Without the explicit `hidden` the
    // tree rows and the Styles tab's body render stacked on top of each other, both visible, and
    // every other assertion in this file still passes — "it is in the markup" and "the user can see
    // it" are the same sentence only for the pane that is meant to be showing.
    const found = panes(render());
    expect(found).toHaveLength(2);
    expect(found.filter(pane => !pane.hidden)).toHaveLength(1);
    expect(found.find(pane => pane.state === 'active')?.hidden).toBe(false);
    expect(found.find(pane => pane.state === 'inactive')?.hidden).toBe(true);
  });

  it('shows the tab it is handed, not one it picked for itself', () => {
    // The panel holds no tab state of its own: the workspace does, because the Style action on the
    // preview toolbar has to open this panel *on Styles*, and the panel does not exist yet at the
    // moment that decision is made. Both panes are force-mounted, so presence proves nothing — the
    // only evidence the prop is wired is which of the two is the visible one.
    expect(shown(render())).toBe('tree');
    expect(shown(render({ activeTab: 'styles' }))).toBe('styles');

    const styles = panes(render({ activeTab: 'styles' }));
    expect(styles.find(pane => pane.name === 'styles')?.state).toBe('active');
    expect(styles.find(pane => pane.name === 'tree')?.hidden).toBe(true);
  });
});

describe('the Styles tab\'s host hooks', () => {
  it('passes the Select element handler down, so the empty state can offer it', () => {
    // Pass-through, and the failure it guards is the quiet one: a prop accepted at this boundary and
    // never forwarded to `StylesContent` type-checks, renders, and produces a button that is simply
    // never there. `styles-content/__tests__/select-element.test.tsx` owns what the button does; this
    // owns that the workspace's handler reaches it.
    expect(render({ onSelectElement: vi.fn() })).toContain('Select element');
  });

  it('offers no such button when the host passes no handler', () => {
    // The default fixture above — every container but the workspace.
    expect(render()).not.toContain('Select element');
  });
});

describe('what the panel says when it cannot work', () => {
  it('gives each reason its own wording', () => {
    const messages = UNAVAILABLE.map(({ name, props }) =>
      unavailableCopy(t, name, (props.runtime as ProjectRuntime) ?? 'handlebars').title);
    expect(new Set(messages).size).toBe(UNAVAILABLE.length);
  });

  it('names the runtime it is talking about', () => {
    expect(unavailableCopy(t, 'terminal-runtime', 'python').hint).toContain('Python');
    expect(unavailableCopy(t, 'bundled-runtime', 'react').hint).toContain('React');
  });
});
