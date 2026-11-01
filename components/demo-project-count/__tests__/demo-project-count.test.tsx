// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The demo keeps its project count current from its own pages: on load, after files change, when the
 * tab is hidden. Never from inside a frame, where Safari's bridge sees no projects.
 */
const state = vi.hoisted(() => ({ projects: [] as unknown[], embedded: false }));
vi.mock('@/lib/vfs', () => ({ vfs: { init: vi.fn(async () => {}), listProjects: vi.fn(async () => state.projects) } }));
vi.mock('@/lib/web/embedded', () => ({ isEmbedded: () => state.embedded }));

import { DemoProjectCount } from '..';
import { DEMO_PROJECTS_COOKIE, readDemoProjectCount } from '@/lib/demo-bridge/project-count';

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.projects = [{}, {}];
  state.embedded = false;
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.cookie = `${DEMO_PROJECTS_COOKIE}=; path=/; max-age=0`;
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

const mount = async () => {
  act(() => root.render(<DemoProjectCount />));
  await flush();
};

describe('DemoProjectCount', () => {
  it('writes the count on load', async () => {
    await mount();
    expect(readDemoProjectCount()).toBe(2);
  });

  it('writes it again a moment after files change, and when the tab is hidden', async () => {
    vi.useFakeTimers();
    await mount();
    state.projects = [{}, {}, {}];
    window.dispatchEvent(new Event('filesChanged'));
    await flush();
    expect(readDemoProjectCount()).toBe(2);
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(readDemoProjectCount()).toBe(3);

    state.projects = [{}];
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    } finally {
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
    expect(readDemoProjectCount()).toBe(1);
  });

  it('writes nothing inside a frame, or on the bridge page', async () => {
    state.embedded = true;
    await mount();
    expect(readDemoProjectCount()).toBe(0);
    act(() => root.unmount());
    root = createRoot(container);

    state.embedded = false;
    window.history.replaceState(null, '', '/demo-bridge');
    await mount();
    expect(readDemoProjectCount()).toBe(0);
  });
});
