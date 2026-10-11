// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';

/**
 * The sidebar's unsynced count hydrates inside a Suspense boundary, after PageLayout has already
 * loaded the shared state. Reading that state during hydration put a badge into HTML the server
 * rendered without one, and React threw a hydration mismatch.
 */

const store = vi.hoisted(() => ({
  state: { statuses: new Map(), pendingCount: 0, loaded: false },
  listeners: new Set<(s: unknown) => void>(),
}));

vi.mock('@/lib/vfs/project-sync-state', () => ({
  getProjectSyncState: () => store.state,
  subscribeProjectSyncState: (listener: (s: unknown) => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
}));

import { useProjectSyncState } from '../use-project-sync-state';

function Count() {
  return <span data-count>{useProjectSyncState().pendingCount}</span>;
}

function setState(pendingCount: number) {
  store.state = { statuses: new Map(), pendingCount, loaded: true };
  store.listeners.forEach((listener) => listener(store.state));
}

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.state = { statuses: new Map(), pendingCount: 0, loaded: false };
  store.listeners.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('useProjectSyncState', () => {
  it('renders the empty state on the server, whatever the client has loaded', () => {
    setState(3);
    expect(renderToString(<Count />)).toContain('>0<');
  });

  it('hydrates without a mismatch and then shows the loaded count', async () => {
    container.innerHTML = renderToString(<Count />);
    setState(3);
    const recoverable = vi.fn();

    await act(async () => {
      root = hydrateRoot(container, <Count />, { onRecoverableError: recoverable });
    });

    expect(recoverable).not.toHaveBeenCalled();
    expect(container.querySelector('[data-count]')!.textContent).toBe('3');
  });

  it('follows later changes', async () => {
    container.innerHTML = renderToString(<Count />);
    await act(async () => { root = hydrateRoot(container, <Count />); });

    await act(async () => { setState(5); });

    expect(container.querySelector('[data-count]')!.textContent).toBe('5');
  });
});
