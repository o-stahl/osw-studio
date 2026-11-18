// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { StylesContent, type StylesContentHandle } from '..';
import type { ApplyOptions } from '../commit';
import type { FocusContextPayload, SpecifiedValue } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';

/**
 * Typing into one of the fields the panel works out itself (a shadow's offsets, a blur's radius, a
 * gradient's angle), mounted: what reaches the write once the commit debounce has passed. Each field
 * has one unit, so a number in another unit is refused rather than written as this one.
 */

const selection: FocusContextPayload = {
  domPath: 'html > body > main > div',
  tagName: 'DIV',
  nodeId: 'n1',
  attributes: { 'data-osw-id': 'm1' },
  outerHTML: '<div></div>',
  srcAttr: '/index.html:40',
};

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();
let applyStyle: ReturnType<typeof vi.fn>;

/** The element as the frame describes it: its computed values over the defaults, and its declarations as written. */
function mount(reply: { values?: Record<string, string>; specified?: Record<string, SpecifiedValue | null> } = {}): void {
  applyStyle = vi.fn(async (_s: FocusContextPayload, _changes: StyleChange[], opts: ApplyOptions): Promise<ApplyResult> =>
    ({ ok: true, markerId: opts.markerId ?? 'm1', filesWritten: ['/overrides.css'], css: '' }));
  act(() => {
    root.render(withMessages(
      <StylesContent
        ref={ref}
        selection={selection}
        sendToFrame={vi.fn()}
        applyStyle={applyStyle}
        tokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
      />,
    ));
  });
  act(() => {
    ref.current!.handleStyleComputed({
      type: 'style-computed', nodeId: 'n1', rootFontSize: '16px', viewportWidth: 1440,
      values: { 'font-size': '16px', display: 'block', position: 'static', 'box-shadow': 'rgba(0, 0, 0, 0.16) 0px 8px 24px 0px', ...reply.values },
      specified: reply.specified,
    });
  });
}

/** As written in a stylesheet of the project's own. */
const declared = (value: string): SpecifiedValue => ({ value, origin: '/styles.css', ours: false });

const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });

/** Type into the field labelled `label` and press Enter. */
function type(label: string, text: string): void {
  const effects = container.querySelector<HTMLElement>('[data-osw-group="Effects"]')!;
  act(() => { effects.querySelector<HTMLButtonElement>(`[data-osw-stepper-value][aria-label="${ts('valueOf', { label })}"]`)!.click(); });
  const input = effects.querySelector<HTMLInputElement>('[data-osw-stepper-input]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

/** Past the commit debounce: the changes the write was given. */
async function written(): Promise<StyleChange[]> {
  await act(async () => { vi.advanceTimersByTime(400); });
  return applyStyle.mock.calls.flatMap(call => call[1] as StyleChange[]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('a shadow offset typed in', () => {
  it('writes a bare number, or one in the field\'s own unit', async () => {
    mount();
    type('X', '3');
    expect(await written()).toEqual([{ property: 'box-shadow', value: '3px 8px 24px 0px rgba(0, 0, 0, 0.16)' }]);
    applyStyle.mockClear();
    type('Y', '-2px');
    expect(await written()).toEqual([{ property: 'box-shadow', value: '3px -2px 24px 0px rgba(0, 0, 0, 0.16)' }]);
  });

  it('refuses a number in another unit rather than writing it as pixels', async () => {
    mount();
    type('X', '2rem');
    expect(await written()).toEqual([]);
  });

  it('refuses what is not a number', async () => {
    mount();
    type('X', '2px; color: red');
    type('Y', 'abc');
    expect(await written()).toEqual([]);
  });
});

describe('a shadow whose declaration the fields cannot read', () => {
  it('starts from the computed shadow when the declaration is a variable', async () => {
    mount({ values: { 'box-shadow': 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px' }, specified: { 'box-shadow': declared('var(--shadow-sm)') } });
    type('X', '3');
    expect(await written()).toEqual([{ property: 'box-shadow', value: '3px 1px 2px 0px rgba(0, 0, 0, 0.1)' }]);
  });

  it('starts from the computed shadow when the declaration is in rem', async () => {
    mount({ values: { 'box-shadow': 'rgba(0, 0, 0, 0.2) 0px 8px 16px 0px' }, specified: { 'box-shadow': declared('0 0.5rem 1rem rgba(0, 0, 0, 0.2)') } });
    type('X', '3');
    expect(await written()).toEqual([{ property: 'box-shadow', value: '3px 8px 16px 0px rgba(0, 0, 0, 0.2)' }]);
  });

  it('keeps a colour token where the lengths are in px', async () => {
    mount({ values: { 'box-shadow': 'rgb(0, 0, 0) 0px 2px 4px 0px' }, specified: { 'box-shadow': declared('0px 2px 4px 0px var(--shade)') } });
    type('X', '3');
    expect(await written()).toEqual([{ property: 'box-shadow', value: '3px 2px 4px 0px var(--shade)' }]);
  });
});

describe('the gradient fields and + Gradient', () => {
  const colour = () => container.querySelector<HTMLElement>('[data-osw-group="Colour"]')!;
  const fields = () => colour().querySelector('[data-osw-effect="gradient"]');
  const add = () => colour().querySelector('[data-osw-add-effect="gradient"]');

  it('offers neither for a gradient laid over an image, which a write of the fields would drop', () => {
    mount({ specified: { 'background-image': declared('linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), url("hero.jpg")') } });
    expect(fields()).toBeNull();
    expect(add()).toBeNull();
  });

  it('offers neither for a gradient with more stops than the fields have', () => {
    mount({ specified: { 'background-image': declared('linear-gradient(90deg, #fff, #888, #000)') } });
    expect(fields()).toBeNull();
    expect(add()).toBeNull();
  });

  it('offers no + Gradient over an image, which it would replace', () => {
    mount({ values: { 'background-image': 'url("https://example.com/hero.jpg")' } });
    expect(add()).toBeNull();
  });

  it('offers + Gradient where there is no image, and the fields for one two-colour gradient', () => {
    mount({ values: { 'background-image': 'none' } });
    expect(add()).not.toBeNull();
    mount({ specified: { 'background-image': declared('linear-gradient(to right, #ffffff, #000000)') } });
    expect(fields()).not.toBeNull();
    expect(colour().querySelector(`[data-osw-stepper-value][aria-label="${ts('valueOf', { label: ts('effects.angle') })}"]`)!.textContent).toBe('90');
  });
});

describe('− Gradient on the element\'s own gradient', () => {
  it('takes its own off, rather than writing none over a stylesheet\'s gradient laid on an image', async () => {
    mount({
      specified: {
        'background-image': {
          value: 'linear-gradient(90deg, #ffffff, #000000)', origin: '/overrides.css', ours: true,
          under: { value: 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), url("hero.jpg")', origin: '/styles.css' },
        },
      },
    });
    act(() => { container.querySelector<HTMLButtonElement>(`[data-osw-effect="gradient"] [aria-label="${ts('effects.removeGradient')}"]`)!.click(); });
    expect(await written()).toEqual([{ property: 'background-image', value: null }]);
  });
});
