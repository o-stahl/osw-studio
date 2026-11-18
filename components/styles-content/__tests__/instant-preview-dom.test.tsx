// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { StylesContent, type StylesContentHandle } from '..';
import type { ApplyOptions } from '../commit';
import { applyChanges } from '@/lib/direct-edit/overrides-css';
import type { FocusContextPayload, OverrideMark } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';

/**
 * A change shows in the frames before it is written.
 *
 * The write waits for the commit debounce and then for storage; the frames do not. Every change not
 * yet written is laid over the file and handed to `onOverrides` on the next animation frame. An
 * element with no marker is marked in the frames with the id its write is then told to stamp, and the
 * mark is taken back when the write stamps another id or none.
 *
 * The assertions compare what was shown with `applyChanges` over what was written, so a preview that
 * drifts from the write fails here rather than in a browser.
 */

const FILE = '[data-osw-id="m0"][data-osw-id] {\n  color: red;\n}\n';
const SRC = '/index.html:40';

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > p',
  tagName: 'P',
  nodeId: 'n1',
  attributes: { class: 'card' },
  outerHTML: '<p></p>',
  ...over,
});
const marked = payload({ attributes: { class: 'card', 'data-osw-id': 'm1' }, srcAttr: SRC });
const unmarked = payload({ srcAttr: SRC });

type Write = (changes: StyleChange[], opts: ApplyOptions) => Promise<ApplyResult>;

/** The write as `applyStyleOverride` would answer it: the file with the changes, under the marker it used. */
const writes: Write = async (changes, opts) => {
  const markerId = opts.markerId ?? opts.newMarkerId!;
  return {
    ok: true,
    markerId,
    filesWritten: opts.markerId ? ['/overrides.css'] : ['/index.html', '/overrides.css'],
    css: applyChanges(FILE, markerId, opts.scope ?? 'all', changes),
  };
};

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();
let applyStyle: ReturnType<typeof vi.fn>;
let onOverrides: ReturnType<typeof vi.fn>;
let readOverridesText: ReturnType<typeof vi.fn>;

function mount(selection: FocusContextPayload, options: { write?: Write; reader?: boolean; breakpoints?: number[]; viewportWidth?: number } = {}): void {
  const write = options.write ?? writes;
  applyStyle = vi.fn((_selection: FocusContextPayload, changes: StyleChange[], opts: ApplyOptions) => write(changes, opts));
  onOverrides = vi.fn();
  readOverridesText = vi.fn(async () => FILE);
  act(() => {
    root.render(withMessages(
      <StylesContent
        ref={ref}
        selection={selection}
        sendToFrame={vi.fn()}
        applyStyle={applyStyle}
        onOverrides={onOverrides}
        readOverridesText={options.reader === false ? undefined : readOverridesText}
        breakpoints={options.breakpoints}
        tokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
      />,
    ));
  });
  act(() => {
    ref.current!.handleStyleComputed({ type: 'style-computed', nodeId: 'n1', values: { 'font-size': '16px' }, rootFontSize: '16px', viewportWidth: options.viewportWidth });
  });
}

const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });

/** The text size row's +, which only its name tells apart from its −. */
function press(): void {
  const label = ts('increase', { label: en.styleProps.labels['font-size'] });
  act(() => { document.querySelector<HTMLButtonElement>(`[data-osw-row="font-size"] [aria-label="${label}"]`)!.click(); });
}

/** One animation frame, and the read it may wait on. */
async function frame(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(20); });
}

/** Past the commit debounce, and the write it starts. */
async function settle(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(400); });
}

function shown(index = -1): { css: string; marks: OverrideMark[]; unmarks: string[] } {
  const call = onOverrides.mock.calls.at(index);
  expect(call, 'nothing was shown').toBeDefined();
  return { css: call![0], marks: call![1] ?? [], unmarks: call![2] ?? [] };
}

const writtenChanges = (index = 0): StyleChange[] => applyStyle.mock.calls[index][1];
const writtenOpts = (index = 0): ApplyOptions => applyStyle.mock.calls[index][2];

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

describe('a change on an element with a marker', () => {
  it('shows on the next frame, before the write, as the write will leave the file', async () => {
    mount(marked);
    press();
    await frame();

    expect(onOverrides).toHaveBeenCalledTimes(1);
    expect(applyStyle).not.toHaveBeenCalled();

    await settle();
    expect(applyStyle).toHaveBeenCalledTimes(1);
    expect(shown(0).css).toBe(applyChanges(FILE, 'm1', 'all', writtenChanges()));
    expect(shown(0).marks).toEqual([]);
  });

  it('shows every press of a run that is written once', async () => {
    mount(marked);
    for (let i = 0; i < 3; i++) {
      press();
      await frame();
    }

    const css = onOverrides.mock.calls.map(call => call[0]);
    expect(new Set(css).size).toBe(3);
    await settle();
    expect(applyStyle).toHaveBeenCalledTimes(1);
    expect(css[2]).toBe(applyChanges(FILE, 'm1', 'all', writtenChanges()));
  });

  it('goes on showing a change while its write is out', async () => {
    let land: () => void = () => {};
    mount(marked, {
      write: (changes, opts) => new Promise<ApplyResult>(resolve => { land = () => resolve(writes(changes, opts)); }),
    });
    press();
    await settle();
    await frame();

    expect(applyStyle).toHaveBeenCalledTimes(1);
    expect(shown().css).toBe(applyChanges(FILE, 'm1', 'all', writtenChanges()));
    await act(async () => { land(); });
  });

  it('keeps a change made while a write is out on screen when the write lands', async () => {
    let land: (result: ApplyResult) => void = () => {};
    let first: ApplyResult | null = null;
    mount(marked, {
      write: async (changes, opts) => {
        // Marked, so what is shown after it lands can only have come from the file it reports.
        const result = await writes(changes, opts);
        first = { ...result, css: `${result.css}/* as written */\n` };
        return new Promise<ApplyResult>(resolve => { land = resolve; });
      },
    });
    press();
    await settle();
    expect(applyStyle).toHaveBeenCalledTimes(1);

    press();
    await frame();
    await act(async () => { land(first!); });
    const after = shown().css;
    await settle();

    // The file as the first write left it, with the second change laid over it.
    expect(applyStyle).toHaveBeenCalledTimes(2);
    expect(after).toBe(applyChanges(first!.css!, 'm1', 'all', writtenChanges(1)));
  });

  it('takes back what it showed when the file changes under it', async () => {
    mount(marked);
    press();
    await frame();
    expect(shown().css).not.toBe(FILE);

    await act(async () => { ref.current!.handleOverridesChanged(); });
    expect(shown().css).toBe(FILE);
    await settle();
    expect(applyStyle).not.toHaveBeenCalled();
  });

  it('shows a write when it lands, and nothing before, without a reader', async () => {
    mount(marked, { reader: false });
    press();
    await frame();
    expect(onOverrides).not.toHaveBeenCalled();

    await settle();
    expect(shown().css).toBe(applyChanges(FILE, 'm1', 'all', writtenChanges()));
  });
});

describe('a first edit', () => {
  it('marks the element with the id its write is told to stamp', async () => {
    mount(unmarked);
    press();
    await frame();

    const [mark] = shown().marks;
    expect(mark.src).toBe(SRC);
    await settle();
    expect(writtenOpts().newMarkerId).toBe(mark.markerId);
    expect(shown(0).css).toBe(applyChanges(FILE, mark.markerId, 'all', writtenChanges()));
  });

  it('takes the change and the mark back when the write is refused', async () => {
    mount(unmarked, { write: async () => ({ ok: false, reason: 'stale-index', file: '/index.html', filesWritten: [] }) });
    press();
    await frame();
    const [mark] = shown().marks;
    await settle();

    expect(shown()).toEqual({ css: FILE, marks: [], unmarks: [mark.markerId] });
  });

  it('asks with a new id after a refusal, never the one it took back', async () => {
    mount(unmarked, { write: async () => ({ ok: false, reason: 'stale-index', file: '/index.html', filesWritten: [] }) });
    press();
    await settle();
    press();
    await settle();

    expect(writtenOpts(1).newMarkerId).toBeDefined();
    expect(writtenOpts(1).newMarkerId).not.toBe(writtenOpts(0).newMarkerId);
  });

  it('moves the mark to the marker source already had', async () => {
    mount(unmarked, {
      write: async changes => ({
        ok: true,
        markerId: 'm9',
        filesWritten: ['/overrides.css'],
        css: applyChanges(FILE, 'm9', 'all', changes),
      }),
    });
    press();
    await frame();
    const [mark] = shown().marks;
    await settle();

    expect(shown()).toEqual({
      css: applyChanges(FILE, 'm9', 'all', writtenChanges()),
      marks: [{ src: SRC, markerId: 'm9' }],
      unmarks: [mark.markerId],
    });
  });
});

describe('a handle drag from Canvas', () => {
  it('shows every step, and writes the last one once', async () => {
    mount(marked);
    act(() => { ref.current!.dragStyle('start', []); });
    act(() => { ref.current!.dragStyle('move', [{ property: 'padding-bottom', value: '40px' }]); });
    await frame();
    act(() => { ref.current!.dragStyle('move', [{ property: 'padding-bottom', value: '56px' }]); });
    await frame();
    expect(onOverrides.mock.calls.map(call => /padding-bottom: (\d+px)/.exec(call[0])?.[1])).toEqual(['40px', '56px']);
    expect(applyStyle).not.toHaveBeenCalled();
    await act(async () => { ref.current!.dragStyle('end', []); });
    expect(applyStyle).toHaveBeenCalledTimes(1);
    expect(writtenChanges()).toEqual([{ property: 'padding-bottom', value: '56px' }]);
  });

  it('puts every write of one drag in one undo group, and the next drag in another', async () => {
    mount(marked);
    act(() => { ref.current!.dragStyle('start', []); });
    act(() => { ref.current!.dragStyle('move', [{ property: 'padding-bottom', value: '40px' }]); });
    // Held still past the commit debounce: written once mid-drag, and again at the end.
    await settle();
    act(() => { ref.current!.dragStyle('move', [{ property: 'padding-bottom', value: '56px' }]); });
    await act(async () => { ref.current!.dragStyle('end', []); });
    act(() => { ref.current!.dragStyle('start', []); });
    act(() => { ref.current!.dragStyle('move', [{ property: 'padding-bottom', value: '64px' }]); });
    await act(async () => { ref.current!.dragStyle('end', []); });

    expect(applyStyle.mock.calls.map(call => call[1])).toEqual([
      [{ property: 'padding-bottom', value: '40px' }],
      [{ property: 'padding-bottom', value: '56px' }],
      [{ property: 'padding-bottom', value: '64px' }],
    ]);
    expect(writtenOpts(1).group).toBe(writtenOpts(0).group);
    expect(writtenOpts(2).group).not.toBe(writtenOpts(0).group);
  });
});

describe('the element menu\'s Hide and Clear', () => {
  it('run at the width the panel is on', async () => {
    // A 390px frame, below the 768 breakpoint: the panel edits the ≤ 768 block.
    mount(marked, { breakpoints: [768], viewportWidth: 390 });
    expect(ref.current!.currentScope()).toBe(768);

    act(() => { ref.current!.runCommand('toggle-hide'); });
    await settle();
    act(() => { ref.current!.runCommand('clear-scope'); });
    await settle();

    expect(applyStyle.mock.calls.map(call => [call[1], (call[2] as ApplyOptions).scope])).toEqual([
      [[{ property: 'display', value: 'none' }], 768],
      [[{ property: 'display', value: null }], 768],
    ]);
  });
});
