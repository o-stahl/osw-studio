// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StylesContent, type StylesContentHandle } from '..';
import type { ApplyOptions } from '../commit';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';

/**
 * The alignment pad of a flex container, mounted: nine cells, `x,y` across and down. In a row the
 * main axis runs across, so a cell's column is its `justify-content` and its row its `align-items`;
 * in a column the two swap. What is asserted is what a press writes, and which cell is lit for the
 * values the frame reports.
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

function mount(values: Record<string, string>): void {
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
      values: { 'font-size': '16px', display: 'flex', position: 'static', ...values },
    });
  });
}

const cell = (at: string) => {
  const el = container.querySelector<HTMLButtonElement>(`[data-osw-row="align"] [data-osw-pad="${at}"]`);
  if (!el) throw new Error(`no pad cell ${at}`);
  return el;
};
/** The cells lit, by place. */
const lit = () => [...container.querySelectorAll('[data-osw-row="align"] [data-osw-pad][aria-pressed="true"]')]
  .map(el => el.getAttribute('data-osw-pad'));

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

describe('a press on the pad', () => {
  it('in a column, writes the cell\'s row as justify-content and its column as align-items', async () => {
    mount({ 'flex-direction': 'column', 'justify-content': 'normal', 'align-items': 'normal' });
    act(() => { cell('2,0').click(); });
    expect(await written()).toEqual([
      { property: 'align-items', value: 'flex-end' },
      { property: 'justify-content', value: 'flex-start' },
    ]);
  });

  it('in a row, writes the cell\'s column as justify-content and its row as align-items', async () => {
    mount({ 'flex-direction': 'row', 'justify-content': 'normal', 'align-items': 'normal' });
    act(() => { cell('2,0').click(); });
    expect(await written()).toEqual([
      { property: 'align-items', value: 'flex-start' },
      { property: 'justify-content', value: 'flex-end' },
    ]);
  });
});

describe('the lit cell', () => {
  it('is where the computed values put the children, across in a row and down in a column', () => {
    mount({ 'flex-direction': 'row', 'justify-content': 'center', 'align-items': 'flex-end' });
    expect(lit()).toEqual(['1,2']);

    act(() => root.unmount());
    root = createRoot(container);
    mount({ 'flex-direction': 'column', 'justify-content': 'center', 'align-items': 'flex-end' });
    expect(lit()).toEqual(['2,1']);
  });
});
