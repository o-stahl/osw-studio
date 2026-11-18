// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StylesContent, type StylesContentHandle, type StylesContentProps } from '..';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * What the Styles tab leaves behind when it unmounts: the delayed re-ask after a width scope is
 * picked, and the "copied" tip's reset, are both timers the panel starts, and neither may run once
 * the panel is gone.
 */

const marked: FocusContextPayload = {
  domPath: 'html > body > p', tagName: 'P', nodeId: 'n1', outerHTML: '<p></p>', srcAttr: '/index.html:40',
  attributes: { 'data-osw-id': 'm1' },
};
const overrides = { byScope: new Map([['all' as const, { color: 'red' }]]), text: '[data-osw-id="m1"][data-osw-id] {\n  color: red;\n}', widths: [] };

let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
const ref = createRef<StylesContentHandle>();
let sendToFrame: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sendToFrame = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(over: Partial<StylesContentProps> = {}): Promise<void> {
  await act(async () => {
    root.render(withMessages(
      <StylesContent
        ref={ref}
        selection={marked}
        sendToFrame={sendToFrame}
        applyStyle={vi.fn()}
        onReadOverrides={async () => overrides}
        tokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
        {...over}
      />,
    ));
  });
}

function unmount(): void {
  act(() => root.unmount());
  mounted = false;
}

/** Pick the narrower of two width scopes: a phone-width frame beside the desktop one offers "up to 768". */
async function pickNarrowerScope(): Promise<void> {
  await mount({ breakpoints: [768], surfaceWidths: [1440, 390] });
  act(() => {
    ref.current!.handleStyleComputed({ type: 'style-computed', nodeId: 'n1', values: { display: 'block' }, viewportWidth: 1440 });
  });
  const narrower = container.querySelector<HTMLButtonElement>('[data-osw-group="scope"] button[aria-pressed="false"]')!;
  act(() => { narrower.click(); });
  sendToFrame.mockClear();
}

describe('a width scope picked', () => {
  it('asks the frame about the element again a moment later', async () => {
    await pickNarrowerScope();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(sendToFrame).toHaveBeenCalledWith(expect.objectContaining({ type: 'style-query', nodeId: 'n1' }));
  });
});

describe('after the Styles tab unmounts', () => {
  it('does not ask the frame again for a width scope picked just before', async () => {
    await pickNarrowerScope();
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(sendToFrame).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'style-query' }));
  });

  it('leaves no timer behind from copying the CSS', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
    await mount();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-osw-copy-css]')!.click(); });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
