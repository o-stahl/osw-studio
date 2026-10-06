// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Loading Monaco for the editor: reuse an instance already loaded, cancel the load when the editor
 * goes first, and treat that cancellation as the normal outcome it is rather than an error.
 */
type Loading = Promise<unknown> & { cancel: () => void };
const mocks = vi.hoisted(() => ({
  instance: null as unknown,
  init: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  loader: { __getMonacoInstance: () => mocks.instance, init: mocks.init },
}));
vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig<object>()),
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));
vi.mock('@/lib/vfs', () => ({ vfs: {} }));
vi.mock('@/lib/hooks/use-typescript-intellisense', () => ({ useTypescriptIntelliSense: () => {} }));

import { useLoadedMonaco } from '../multi-tab-editor';

/** A load that settles when the test says, and records being cancelled. */
function controllable() {
  let resolve: (v: unknown) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const p = new Promise((res, rej) => { resolve = res; reject = rej; }) as Loading;
  p.cancel = vi.fn(() => reject({ type: 'cancelation', msg: 'operation is manually canceled' }));
  return { p, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let seen: unknown[] = [];

function Probe() {
  seen.push(useLoadedMonaco());
  return null;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.instance = null;
  seen = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
});

describe('useLoadedMonaco', () => {
  it('uses an instance that is already loaded, without loading again', () => {
    mocks.instance = { editor: {} };
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBe(mocks.instance);
    expect(mocks.init).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('loads it and hands it over when it arrives', async () => {
    const load = controllable();
    mocks.init.mockReturnValue(load.p);
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBeNull();

    const monaco = { editor: {} };
    await act(async () => { load.resolve(monaco); });
    expect(seen.at(-1)).toBe(monaco);
    act(() => root.unmount());
  });

  it('cancels the load when the editor closes first, quietly', async () => {
    const load = controllable();
    mocks.init.mockReturnValue(load.p);
    act(() => root.render(<Probe />));

    await act(async () => { root.unmount(); });
    expect(load.p.cancel).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('reports a load that really failed', async () => {
    const load = controllable();
    mocks.init.mockReturnValue(load.p);
    act(() => root.render(<Probe />));

    await act(async () => { load.reject(new Error('CDN unreachable')); });
    expect(mocks.loggerError).toHaveBeenCalledWith('[Editor] Monaco failed to load:', expect.any(Error));
    act(() => root.unmount());
  });
});
