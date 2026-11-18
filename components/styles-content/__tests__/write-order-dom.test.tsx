// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { StylesContent, type StylesContentHandle, type StylesContentProps } from '..';
import type { ApplyOptions } from '../commit';
import { applyChanges } from '@/lib/direct-edit/overrides-css';
import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';

/**
 * The order the panel's writes reach the write path in, mounted. Each write reads `/overrides.css`,
 * changes it and writes it back, so a write that starts while another is out reads the file the other
 * has not written yet, and one of the two changes is lost. What is asserted is how many writes are
 * out at once, what the file holds when they are done, and which undo step each joins.
 */

const payload = (id: string, marker: string): FocusContextPayload => ({
  domPath: `html > body > p.${id}`,
  tagName: 'P',
  nodeId: id,
  srcAttr: `/index.html:${id === 'a' ? 10 : 20}`,
  attributes: { class: id, 'data-osw-id': marker },
  outerHTML: '<p></p>',
});

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();

/** `/overrides.css` as the fake write path keeps it. */
let file: string;
/** The most writes that were ever out at once. */
let most: number;
let applyStyle: ReturnType<typeof vi.fn>;

/** A write path that reads the file, waits as storage does, and writes it back. */
function storage(): ReturnType<typeof vi.fn> {
  let open = 0;
  return vi.fn(async (_s: FocusContextPayload, changes: StyleChange[], opts: ApplyOptions): Promise<ApplyResult> => {
    open++;
    most = Math.max(most, open);
    const read = file;
    await new Promise(resolve => setTimeout(resolve, 50));
    file = applyChanges(read, opts.markerId ?? 'm1', opts.scope, changes);
    open--;
    return { ok: true, markerId: opts.markerId ?? undefined, filesWritten: ['/overrides.css'], css: file };
  });
}

function render(selection: FocusContextPayload, over: Partial<StylesContentProps> = {}): void {
  act(() => {
    root.render(withMessages(
      <StylesContent ref={ref} selection={selection} sendToFrame={vi.fn()} applyStyle={applyStyle}
        tokens={[]} onOpenFile={vi.fn()} onAskAgent={vi.fn()} onRefreshPreview={vi.fn()} {...over} />,
    ));
  });
}

const computed = (nodeId: string, values: Record<string, string>) => act(() => {
  ref.current!.handleStyleComputed({ type: 'style-computed', nodeId, values, rootFontSize: '16px' });
});
const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });
/** The text size row's +, which only its name tells apart from its −. */
const increaseSize = () => document.querySelector<HTMLButtonElement>(
  `[data-osw-row="font-size"] [aria-label="${ts('increase', { label: en.styleProps.labels['font-size'] })}"]`,
)!;
/** The dot that resets the text colour row. */
const colourDot = () => document.querySelector<HTMLButtonElement>('[data-osw-row="color"] [data-osw-set-dot]')!;
/** Let timers run, and the writes they start settle, for `ms`. */
const elapse = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  most = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('writes made one after another', () => {
  it('starts a row\'s reset only once the change waiting before it has landed, so neither is lost', async () => {
    const before = applyChanges('', 'm1', 'all', [{ property: 'color', value: 'red' }]);
    file = before;
    applyStyle = storage();
    render(payload('a', 'm1'), {
      onReadOverrides: async () => ({ byScope: new Map([['all' as const, { color: 'red' }]]), text: 'x', widths: [] }),
    });
    await act(async () => { await Promise.resolve(); });
    computed('a', { 'font-size': '16px', color: 'rgb(255, 0, 0)' });

    act(() => { increaseSize().click(); });
    // The dot flushes the waiting change and then writes the reset.
    act(() => { colourDot().click(); });
    await elapse(500);

    expect(applyStyle.mock.calls.map(call => call[1])).toEqual([
      [{ property: 'font-size', value: '1.125rem' }],
      [{ property: 'color', value: null }],
    ]);
    const sized = applyChanges(before, 'm1', 'all', [{ property: 'font-size', value: '1.125rem' }]);
    expect(file).toBe(applyChanges(sized, 'm1', 'all', [{ property: 'color', value: null }]));
    expect(most).toBe(1);
  });

  it('starts the strengthen a probe asks for only once the write still out has landed', async () => {
    file = '';
    applyStyle = storage();
    const sendToFrame = vi.fn();
    render(payload('a', 'm1'), { sendToFrame });
    computed('a', { 'font-size': '16px' });

    act(() => { increaseSize().click(); });
    await elapse(500);
    expect(applyStyle).toHaveBeenCalledTimes(1);

    // A second change goes out, and while it is out the probe of the first says it lost.
    act(() => { increaseSize().click(); });
    await elapse(320);
    expect(applyStyle).toHaveBeenCalledTimes(2);
    act(() => { ref.current!.handleStyleProbeResult({ type: 'style-probe-result', nodeId: 'a', lost: ['font-size'], winner: '.a' }); });
    await elapse(500);

    expect(applyStyle).toHaveBeenCalledTimes(3);
    expect((applyStyle.mock.calls[2][2] as ApplyOptions).strengthen).toEqual(['font-size']);
    expect(most).toBe(1);
  });
});

describe('the undo step a strengthen goes into', () => {
  it('is the write\'s own when a probe of that write asks for it', async () => {
    file = '';
    applyStyle = storage();
    render(payload('a', 'm1'));
    computed('a', { 'font-size': '16px' });
    act(() => { increaseSize().click(); });
    await elapse(500);
    act(() => { ref.current!.handleStyleProbeResult({ type: 'style-probe-result', nodeId: 'a', lost: ['font-size'], winner: '.a' }); });
    await elapse(100);

    const [write, strengthen] = applyStyle.mock.calls.map(call => call[2] as ApplyOptions);
    expect(strengthen.strengthen).toEqual(['font-size']);
    expect(strengthen.group).toBe(write.group);
  });

  it('is a new one for Make it apply, not the last write\'s on another element', async () => {
    file = '';
    applyStyle = storage();
    render(payload('a', 'm1'));
    computed('a', { 'font-size': '16px' });
    act(() => { increaseSize().click(); });
    await elapse(500);
    const groupA = (applyStyle.mock.calls[0][2] as ApplyOptions).group;

    render(payload('b', 'm2'), {
      onReadOverrides: async () => ({ byScope: new Map([['all' as const, { color: 'red' }]]), text: 'x', widths: [] }),
    });
    await act(async () => { await Promise.resolve(); });
    computed('b', { 'font-size': '16px', color: 'rgb(255, 0, 0)' });
    act(() => {
      ref.current!.handleStyleProbeResult({ type: 'style-probe-result', nodeId: 'b', lost: ['color'], winner: '.b', written: ['color'], tag: 'earlier' });
    });
    act(() => { document.querySelector<HTMLButtonElement>('[data-osw-make-apply]')!.click(); });
    await elapse(100);

    const [selection, changes, opts] = applyStyle.mock.calls.at(-1)! as [FocusContextPayload, StyleChange[], ApplyOptions];
    expect(selection.nodeId).toBe('b');
    expect(changes).toEqual([]);
    expect(opts.strengthen).toEqual(['color']);
    expect(opts.group).not.toBe(groupA);
  });
});
