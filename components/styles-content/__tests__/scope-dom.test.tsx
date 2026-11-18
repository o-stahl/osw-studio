// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { StylesContent, type StylesContentHandle, type StylesContentProps } from '..';
import type { ApplyOptions } from '../commit';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';

/**
 * Applies to, mounted: which width block a change is written to once a width has been picked, and
 * what the controls show after the pick. Both turn on the panel's own state across a write and a
 * scope switch, which only a mount goes through.
 */

const base: FocusContextPayload = {
  domPath: 'html > body > p', tagName: 'P', nodeId: 'n1', srcAttr: '/index.html:10',
  attributes: { class: 'card' }, outerHTML: '<p></p>',
};

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();
let applyStyle: ReturnType<typeof vi.fn>;

function render(selection: FocusContextPayload, over: Partial<StylesContentProps> = {}): void {
  act(() => {
    root.render(withMessages(
      <StylesContent ref={ref} selection={selection} sendToFrame={vi.fn()} applyStyle={applyStyle}
        breakpoints={[768]} tokens={[]} onOpenFile={vi.fn()} onAskAgent={vi.fn()} onRefreshPreview={vi.fn()} {...over} />,
    ));
  });
}
const reply = (nodeId: string, viewportWidth: number, fontSize = '16px') => act(() => {
  ref.current!.handleStyleComputed({ type: 'style-computed', nodeId, values: { 'font-size': fontSize }, rootFontSize: '16px', viewportWidth });
});
const settle = async () => { await act(async () => { vi.advanceTimersByTime(500); }); };
const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });
/** A width in Applies to, named as the control names it. */
const scopeButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-osw-group="scope"] button'))
  .find(b => b.textContent === label)!;
const increase = () => act(() => {
  document.querySelector<HTMLButtonElement>(`[data-osw-row="font-size"] [aria-label="${ts('increase', { label: en.styleProps.labels['font-size'] })}"]`)!.click();
});
const sizeShown = () => document.querySelector('[data-osw-row="font-size"] [data-osw-stepper-value]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  applyStyle = vi.fn(async (_s: FocusContextPayload, _c: StyleChange[], opts: ApplyOptions): Promise<ApplyResult> => ({
    ok: true, markerId: opts.markerId ?? opts.newMarkerId, filesWritten: opts.markerId ? ['/overrides.css'] : ['/index.html', '/overrides.css'], css: '',
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('a width picked in Applies to', () => {
  it('stays picked after the first write stamps the element with its marker', async () => {
    render(base);
    reply('n1', 390);
    act(() => { scopeButton(ts('scope.all')).click(); });
    increase();
    await settle();
    const first = applyStyle.mock.calls[0][2] as ApplyOptions;
    expect(first.scope).toBe('all');

    // The recompile hands back the same element, now carrying the marker its first write stamped.
    act(() => { ref.current!.handleFrameReady(); });
    render({ ...base, nodeId: 'n2', attributes: { class: 'card', 'data-osw-id': first.newMarkerId! } });
    reply('n2', 390);
    increase();
    await settle();

    expect((applyStyle.mock.calls[1][2] as ApplyOptions).scope).toBe('all');
    expect(document.querySelector('[data-osw-group="scope"] [aria-pressed="true"]')?.textContent).toBe(ts('scope.all'));
  });
});

describe('switching to another width', () => {
  it('shows the value the frame has at the new width, not the one asked for at the old', async () => {
    render(base, { surfaceWidths: [1440, 768], onScope: vi.fn() });
    reply('n1', 1440);
    increase();
    await settle();
    expect(sizeShown()).toBe('1.125');

    act(() => { scopeButton(ts('scope.upTo', { width: 768 })).click(); });
    await settle();
    // At 768 a narrower rule makes the text 12px.
    reply('n1', 768, '12px');

    expect(sizeShown()).toBe('0.75');
  });
});
