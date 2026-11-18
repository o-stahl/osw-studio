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
 * The Styles tab's keyword values and the basic options beside them, mounted: what a row shows and
 * what reaches the write (`applyStyle`) once the commit debounce has passed.
 *
 * Margins, offsets, minimums and maximums take `auto` or `none` from the unit menu or typed; a
 * declared `auto` shows as `auto`, though the frame computes it to pixels.
 */

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > div',
  tagName: 'DIV',
  nodeId: 'n1',
  attributes: { 'data-osw-id': 'm1' },
  outerHTML: '<div></div>',
  srcAttr: '/index.html:40',
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();
let applyStyle: ReturnType<typeof vi.fn>;

const declared = (value: string): SpecifiedValue => ({ value, origin: '/styles.css', ours: false });

function mount(values: Record<string, string>, specified: Record<string, SpecifiedValue | null> = {}, selection = payload()): void {
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
      values: { 'font-size': '16px', display: 'block', position: 'static', ...values },
      specified,
    });
  });
}

const rowOf = (id: string) => {
  const el = container.querySelector<HTMLElement>(`[data-osw-row="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};
const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });
/** A row's +, which only its name tells apart from its −: the row's label in the app's language. */
const increaseIn = (id: string, label: string) =>
  rowOf(id).querySelector<HTMLButtonElement>(`[aria-label="${ts('increase', { label })}"]`)!;
const shownIn = (id: string) => rowOf(id).querySelector('[data-osw-stepper-value]')!.textContent;
const menuOf = (id: string) => rowOf(id).querySelector<HTMLSelectElement>('[data-osw-stepper-unit]')!;

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function type(id: string, text: string): void {
  act(() => { rowOf(id).querySelector<HTMLButtonElement>('[data-osw-stepper-value]')!.click(); });
  const input = rowOf(id).querySelector<HTMLInputElement>('[data-osw-stepper-input]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

/** Past the commit debounce: the changes the write was given. */
async function written(): Promise<StyleChange[]> {
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(applyStyle).toHaveBeenCalled();
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

describe('a margin', () => {
  const pixels = { 'margin-inline-start': '240px', 'margin-inline-end': '240px', 'margin-block-start': '0px', 'margin-block-end': '0px' };

  it('offers auto after its units, and writes it', async () => {
    mount(pixels);
    expect([...menuOf('margin-inline').options].map(o => o.textContent)).toEqual(['rem', 'px', 'auto']);
    choose(menuOf('margin-inline'), 'keyword:auto');
    expect(shownIn('margin-inline')).toBe('auto');
    expect(await written()).toEqual([{ property: 'margin-inline', value: 'auto' }]);
  });

  it('shows a declared auto, which the frame computes to pixels', () => {
    mount(pixels, { 'margin-inline-start': declared('auto'), 'margin-inline-end': declared('auto'), 'margin-block-start': null, 'margin-block-end': null });
    expect(shownIn('margin-inline')).toBe('auto');
    expect(menuOf('margin-inline').value).toBe('keyword:auto');
    // The other row has no keyword declared: its pixels, in its unit.
    expect(shownIn('margin-block')).toBe('0');
  });

  it('takes auto typed, and a number typed over it in the unit on screen', async () => {
    mount(pixels, { 'margin-inline-start': declared('auto'), 'margin-inline-end': declared('auto') });
    type('margin-block', 'auto');
    type('margin-inline', '2');
    expect(await written()).toEqual([{ property: 'margin-block', value: 'auto' }, { property: 'margin-inline', value: '2rem' }]);
  });
});

describe('the sizes', () => {
  it('shows a maximum of none, and steps it from the element\'s own width', async () => {
    mount({ width: '600px', 'max-width': 'none' }, { 'max-width': null });
    act(() => { container.querySelector<HTMLButtonElement>('[data-osw-stepper-expand]')?.click(); });
    expect(shownIn('max-width')).toBe('none');
    act(() => { increaseIn('max-width', en.styleProps.labels['max-width']).click(); });
    expect(await written()).toEqual([{ property: 'max-width', value: '601px' }]);
  });

  it('offers viewport units for a height, and none to lift a declared maximum', async () => {
    mount({ height: '300px', 'max-height': '500px' }, { 'max-height': declared('500px') });
    act(() => { rowOf('max-width').querySelector<HTMLButtonElement>('[data-osw-stepper-expand]')!.click(); });
    expect([...menuOf('min-height').options].map(o => o.textContent)).toEqual(['px', '%', 'rem', 'vh', 'auto']);
    choose(menuOf('max-height'), 'keyword:none');
    expect(await written()).toEqual([{ property: 'max-height', value: 'none' }]);
  });

  it('offers a fit for an image and for nothing else', () => {
    mount({ 'object-fit': 'fill' });
    expect(container.querySelector('[data-osw-row="object-fit"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mount({ 'object-fit': 'fill' }, {}, payload({ tagName: 'IMG' }));
    expect(rowOf('object-fit').querySelector('select')!.value).toBe('fill');
  });
});

describe('a positioned element', () => {
  it('has all four offsets, auto where nothing declares one, and Fixed among the positions', async () => {
    mount({ position: 'absolute', left: '12px', top: '40px', right: '1180px', bottom: '600px', 'z-index': 'auto' },
      { left: declared('12px'), top: declared('40px'), right: null, bottom: null });
    expect(shownIn('left')).toBe('12');
    expect(shownIn('right')).toBe('auto');
    expect(shownIn('bottom')).toBe('auto');
    expect(shownIn('z-index')).toBe('auto');
    const position = rowOf('position').querySelector('select')!;
    expect([...position.options].map(o => o.value)).toContain('fixed');
    choose(position, 'fixed');
    // Stepping an auto offset starts from the pixels it comes to.
    act(() => { increaseIn('right', en.styleProps.sides.right).click(); });
    choose(menuOf('left'), 'keyword:auto');
    expect(await written()).toEqual([
      { property: 'position', value: 'fixed' },
      { property: 'right', value: '1181px' },
      { property: 'left', value: 'auto' },
    ]);
  });
});

describe('type and layout', () => {
  it('writes italic, justify, a light weight and capitals at each word', async () => {
    mount({ 'font-style': 'normal', 'text-align': 'start', 'font-weight': '400', 'text-transform': 'none' });
    act(() => { rowOf('font-style').querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    act(() => { rowOf('text-align').querySelector<HTMLButtonElement>('button[aria-pressed]:last-of-type')!.click(); });
    choose(rowOf('font-weight').querySelector('select')!, '300');
    act(() => { [...rowOf('text-transform').querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Ab')!.click(); });
    expect(await written()).toEqual([
      { property: 'font-style', value: 'italic' },
      { property: 'text-align', value: 'justify' },
      { property: 'font-weight', value: '300' },
      { property: 'text-transform', value: 'capitalize' },
    ]);
  });

  it('makes a flex container inline and back, and a box scroll', async () => {
    mount({ display: 'flex', 'flex-direction': 'row', 'overflow-x': 'visible', 'overflow-y': 'visible' });
    const inline = rowOf('inline').querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(inline.getAttribute('aria-checked')).toBe('false');
    act(() => { inline.click(); });
    choose(rowOf('overflow').querySelector('select')!, 'auto');
    expect(await written()).toEqual([{ property: 'display', value: 'inline-flex' }, { property: 'overflow', value: 'auto' }]);
  });

  it('shows the weight in force, and a weight none of its options name as itself', () => {
    mount({ 'font-weight': '300' });
    const weight = rowOf('font-weight').querySelector<HTMLSelectElement>('[data-osw-select]')!;
    expect(weight.value).toBe('300');
    expect(weight.selectedOptions[0].textContent).toBe(en.styleProps.options.weight['300']);

    act(() => root.unmount());
    root = createRoot(container);
    mount({ 'font-weight': '350' });
    const odd = rowOf('font-weight').querySelector<HTMLSelectElement>('[data-osw-select]')!;
    // Not the nearest option, nor the first: the value as the element has it, which cannot be picked.
    expect(odd.selectedOptions).toHaveLength(1);
    expect(odd.selectedOptions[0].textContent).toBe('350');
    expect(odd.selectedOptions[0].disabled).toBe(true);
  });

  it('lights Block and the Inline switch for an inline-block', () => {
    mount({ display: 'inline-block' });
    expect(rowOf('inline').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    const pressed = [...rowOf('display').querySelectorAll('button[aria-pressed="true"]')].map(b => b.textContent);
    expect(pressed).toEqual(['Block']);
  });
});
