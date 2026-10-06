// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StylesContent } from '..';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult } from '@/lib/direct-edit/types';
import type { TextReadResult } from '@/lib/direct-edit/apply-text';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { deepMerge } from '@/lib/i18n/merge';
import { textRefusalAgentPrompt } from '@/components/text-popover/state';

/**
 * The CONTENT section, on the screen.
 *
 * Everything it *decides* is a pure function in `content-state.ts` and is asserted there. What needs
 * a DOM, and is therefore here, is four things a pure function cannot be wrong about:
 *
 * - which of the two shapes reached the screen, and that a container got neither. Asserted on the
 *   `data-osw-content-section` value, not on "a section is rendered": both shapes are written as
 *   separate conditional branches today, but an assertion that only asks whether *something* is there
 *   passes just as well against a panel that renders both at once and hides one.
 * - that the read is issued on selection and its answer lands in the field.
 * - that Save carries what is in the field into `onApplyText` — the workspace's `applyText` binding,
 *   which writes project source.
 * - that the section is **above SPACING**, which is the whole point of the maintainer's request.
 */

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > h1',
  tagName: 'H1',
  nodeId: 'n1',
  attributes: {},
  outerHTML: '<h1></h1>',
  textBearing: true,
  ...over,
});

const IMAGE = payload({
  tagName: 'IMG',
  attributes: { src: '/images/a.png' },
  textBearing: false,
});
const CONTAINER = payload({ tagName: 'DIV', textBearing: false });

let container: HTMLDivElement;
let root: Root;
const onReadText = vi.fn<() => Promise<TextReadResult>>();
const onApplyText = vi.fn<(text: string, confirmed: boolean) => Promise<ApplyResult>>();
const onReplaceImage = vi.fn();

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  onReadText.mockResolvedValue({ ok: true, text: 'Hello', file: '/index.html', instances: 1 });
  onApplyText.mockResolvedValue({ ok: true, file: '/index.html', filesWritten: ['/index.html'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(
  selection: FocusContextPayload | null,
  over: Partial<React.ComponentProps<typeof StylesContent>> = {},
) {
  await act(async () => {
    root.render(withMessages(
      <StylesContent
        selection={selection}
        sendToFrame={vi.fn()}
        applyStyle={vi.fn()}
        tokens={[]}
        onReadText={onReadText}
        onApplyText={onApplyText}
        onReplaceImage={onReplaceImage}
        imageUrl={null}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
        {...over}
      />,
    ));
  });
}

const section = () => container.querySelector('[data-osw-content-section]');
const field = () => container.querySelector('textarea[data-osw-content-text]') as HTMLTextAreaElement | null;
const save = () => container.querySelector('[data-osw-content-save]') as HTMLButtonElement | null;
const replace = () => container.querySelector('[data-osw-content-replace]') as HTMLButtonElement | null;

const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

/**
 * Retype the field.
 *
 * The native setter, then an `input` event: React holds the last value it rendered on the node and
 * discards a change event whose value it believes it already has, so assigning `.value` directly is
 * not enough to make a controlled component see a keystroke.
 */
const retype = async (text: string) => {
  const el = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, text);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('which shape the section takes', () => {
  it('is the text editor for a text element', async () => {
    await mount(payload());
    expect(section()?.getAttribute('data-osw-content-section')).toBe('text');
    expect(field()).toBeTruthy();
    expect(replace()).toBe(null);
  });

  it('is the image preview and Replace for an image', async () => {
    await mount(IMAGE);
    expect(section()?.getAttribute('data-osw-content-section')).toBe('image');
    expect(replace()).toBeTruthy();
    expect(field()).toBe(null);
    // Nothing to read: an <img> holds no text, and asking would refuse.
    expect(onReadText).not.toHaveBeenCalled();
  });

  it('is left out entirely for a container', async () => {
    await mount(CONTAINER);
    expect(section()).toBe(null);
    expect(container.textContent).not.toContain('Content');
    expect(onReadText).not.toHaveBeenCalled();
  });

  it('is left out when the host passed no way to do that edit', async () => {
    await mount(payload(), { onReadText: undefined, onApplyText: undefined });
    expect(section()).toBe(null);

    await mount(IMAGE, { onReplaceImage: undefined });
    expect(section()).toBe(null);
  });

  it('survives having no element selected', async () => {
    await mount(null);
    expect(section()).toBe(null);
    expect(container.textContent).toContain('No element selected');
  });
});

describe('where the section sits', () => {
  it('is above SPACING — the place the user looked for it', async () => {
    await mount(payload());
    // `Content` / `Spacing` in the markup, uppercased by the class every group heading carries.
    const text = container.textContent ?? '';
    expect(text).toContain('Content');
    expect(text).toContain('Spacing');
    expect(text.indexOf('Content')).toBeLessThan(text.indexOf('Spacing'));
    // First in the scrolling region, not merely somewhere before it.
    expect(section()?.previousElementSibling).toBe(null);
  });
});

describe('editing the text inline', () => {
  it('shows what the element says, read from source', async () => {
    await mount(payload());
    expect(onReadText).toHaveBeenCalledTimes(1);
    expect(field()?.value).toBe('Hello');
  });

  it('offers no Save until the words change', async () => {
    await mount(payload());
    expect(save()?.disabled).toBe(true);

    await retype('Goodbye');
    expect(save()?.disabled).toBe(false);
  });

  it('writes what is in the field', async () => {
    await mount(payload());
    await retype('Goodbye');
    await click(save()!);

    expect(onApplyText).toHaveBeenCalledWith('Goodbye', false);
  });

  it('re-reads the element the recompile handed back, not the words that were typed', async () => {
    await mount(payload());
    await retype('Goodbye');

    onReadText.mockResolvedValue({ ok: true, text: 'From the file', file: '/index.html', instances: 1 });
    // What `selection-resolve` produces on frame-ready: the same element, a new payload.
    await mount(payload({ nodeId: 'n2' }));

    expect(field()?.value).toBe('From the file');
    expect(save()?.disabled).toBe(true);
  });

  it('says why it will not edit text it cannot write, and offers the agent', async () => {
    onReadText.mockResolvedValue({ ok: false, reason: 'has-expression', file: '/index.hbs' });
    const onAskAgent = vi.fn();
    await mount(payload(), { onAskAgent });

    expect(field()).toBe(null);
    expect(container.textContent).toContain('This text comes from the template');

    const ask = Array.from(container.querySelectorAll('button'))
      .find(el => (el.textContent ?? '').includes('Ask the agent'))!;
    await click(ask);
    expect(onAskAgent).toHaveBeenCalledWith(expect.stringContaining('come from the template'));
  });

  it('asks the agent in English when the panel is in another language', async () => {
    onReadText.mockResolvedValue({ ok: false, reason: 'has-expression', file: '/index.hbs' });
    const onAskAgent = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={deepMerge(en, fi)}>
          <StylesContent
            selection={payload()}
            sendToFrame={vi.fn()}
            applyStyle={vi.fn()}
            tokens={[]}
            onReadText={onReadText}
            onApplyText={onApplyText}
            onReplaceImage={onReplaceImage}
            imageUrl={null}
            onOpenFile={vi.fn()}
            onAskAgent={onAskAgent}
            onRefreshPreview={vi.fn()}
          />
        </NextIntlClientProvider>,
      );
    });

    // The panel speaks Finnish…
    expect(container.textContent).toContain(fi.textPopover.msgExpression);
    const ask = Array.from(container.querySelectorAll('button'))
      .find(el => (el.textContent ?? '') === fi.styles.askAgent)!;
    await click(ask);
    // …and what goes to the agent is the English request, never the panel's own words.
    expect(onAskAgent).toHaveBeenCalledWith(textRefusalAgentPrompt({ reason: 'has-expression', file: '/index.hbs' }));
    expect(onAskAgent.mock.calls[0][0]).not.toContain(fi.textPopover.msgExpression);
  });

  it('asks before changing every instance of a shared tag, and names how many', async () => {
    onApplyText.mockResolvedValueOnce({
      ok: false,
      reason: 'needs-confirmation',
      instances: 4,
      file: '/card.hbs',
      filesWritten: [],
    });
    await mount(payload({ instanceCount: 4 }));
    await retype('Goodbye');
    await click(save()!);

    expect(container.textContent).toContain('rendered 4 times');

    const confirm = container.querySelector('[data-osw-content-confirm]') as HTMLButtonElement;
    expect(confirm.textContent).toContain('Change all 4');
    await click(confirm);

    // The flag, not a second unconfirmed attempt — which would refuse identically and for ever.
    expect(onApplyText).toHaveBeenLastCalledWith('Goodbye', true);
  });

  it('shows a refused write and keeps the words', async () => {
    onApplyText.mockResolvedValueOnce({
      ok: false,
      reason: 'stale-index',
      file: '/index.html',
      filesWritten: [],
    });
    await mount(payload());
    await retype('Goodbye');
    await click(save()!);

    expect(container.textContent).toContain('The preview is out of date');
    expect(field()?.value).toBe('Goodbye');
  });
});

describe('replacing the image', () => {
  it('opens the picker the toolbar already opens, rather than a second one', async () => {
    await mount(IMAGE);
    await click(replace()!);
    expect(onReplaceImage).toHaveBeenCalledTimes(1);
    // No dialog of its own: the picker is mounted by the workspace.
    expect(container.querySelector('[data-osw-image-list]')).toBe(null);
  });

  it('shows the picture when the host resolved one, and says so when it could not', async () => {
    await mount(IMAGE, { imageUrl: 'blob:stub' });
    const tile = container.querySelector('[data-osw-content-image]')!;
    expect(tile.getAttribute('data-osw-content-image')).toBe('shown');
    expect(tile.getAttribute('style')).toContain('blob:stub');
    expect(container.textContent).toContain('/images/a.png');

    await mount(IMAGE, { imageUrl: null });
    expect(container.querySelector('[data-osw-content-image]')?.getAttribute('data-osw-content-image'))
      .toBe('unavailable');
  });

  it('says there is no src rather than showing an empty path', async () => {
    await mount(payload({ tagName: 'IMG', attributes: {}, textBearing: false }));
    expect(container.textContent).toContain('no src');
  });
});
