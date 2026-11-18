// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
import { toast } from 'sonner';
import { StylesContent, type StylesContentHandle } from '..';
import { FOLD_IN_PROMPT } from '../state';
import type { FocusContextPayload } from '@/lib/preview/types';
import { logger } from '@/lib/utils';

/**
 * The whole file's two actions, under the element's CSS: Move into stylesheets hands the agent the
 * fold-in task through the composer, and Remove unused runs the sweep and says what it did.
 */

const marked: FocusContextPayload = {
  domPath: 'html > body > p', tagName: 'P', nodeId: 'n1', outerHTML: '<p></p>', srcAttr: '/index.html:40',
  attributes: { 'data-osw-id': 'm1' },
};
const overrides = { byScope: new Map([['all' as const, { color: 'red' }]]), text: '[data-osw-id="m1"][data-osw-id] {\n  color: red;\n}', widths: [] };

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();
let onAskAgent: ReturnType<typeof vi.fn>;
let onSweepOverrides: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(toast).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function mount(sweep: number | null) {
  onAskAgent = vi.fn();
  onSweepOverrides = vi.fn(async () => sweep);
  await act(async () => {
    root.render(withMessages(
      <StylesContent ref={ref} selection={marked} sendToFrame={vi.fn()} applyStyle={vi.fn()} onReadOverrides={async () => overrides}
        tokens={[]} onOpenFile={vi.fn()} onAskAgent={onAskAgent} onSweepOverrides={onSweepOverrides} onRefreshPreview={vi.fn()} />,
    ));
  });
}

const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });
const button = (attr: string) => container.querySelector<HTMLButtonElement>(`[${attr}]`)!;

describe('the overrides file actions', () => {
  it('hands the agent the fold-in task', async () => {
    await mount(0);
    act(() => { button('data-osw-fold-in').click(); });
    expect(onAskAgent).toHaveBeenCalledWith(FOLD_IN_PROMPT);
  });

  it('runs the sweep and says how many elements lost their rules', async () => {
    await mount(2);
    await act(async () => { button('data-osw-sweep').click(); });
    expect(onSweepOverrides).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(ts('css.swept', { count: 2 }));
  });

  it('says when nothing was unused, and nothing when it could not run', async () => {
    await mount(0);
    await act(async () => { button('data-osw-sweep').click(); });
    expect(toast).toHaveBeenCalledWith(en.styles.css.sweptNone);
    vi.mocked(toast).mockClear();
    await mount(null);
    await act(async () => { button('data-osw-sweep').click(); });
    expect(toast).not.toHaveBeenCalled();
  });

  it('says nothing, as when it could not run, when the sweep throws', async () => {
    const failure = new Error('storage is full');
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await mount(0);
      onSweepOverrides.mockRejectedValue(failure);
      await act(async () => { button('data-osw-sweep').click(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
      expect(toast).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      logged.mockRestore();
    }
  });
});
