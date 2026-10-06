// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * What the app does with the model when a provider connects, and on load: assign one only when none
 * works yet, and in both cases fit it to what the account can use. Both are tracked, so a message
 * held for a connection waits until they have finished.
 */

const assign = vi.hoisted(() => ({
  reconcile: vi.fn(async () => {}),
  activate: vi.fn(async (_provider: string) => {}),
  fit: vi.fn(async (_provider: string) => {}),
  track: vi.fn((_work: Promise<void>) => {}),
  shouldAssign: vi.fn(() => true),
}));

vi.mock('@/lib/llm/models/global-auto-assign', () => ({
  reconcileActiveProviderIfConnected: () => assign.reconcile(),
  activateProviderAsGlobalDefault: (p: string) => assign.activate(p),
  fitModelToAccount: (p: string) => assign.fit(p),
  trackConnectSettling: (work: Promise<void>) => assign.track(work),
}));
vi.mock('@/lib/llm/models/project-assignment', () => ({ shouldAutoAssignAgent: () => assign.shouldAssign() }));
vi.mock('@/lib/config/storage', () => ({
  configManager: { getActiveAssignment: () => ({ agent: { provider: 'openrouter', model: 'm' } }) },
}));

import { useProviderAutoAssign } from '../use-provider-auto-assign';

let container: HTMLElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

function mount() {
  function Probe() {
    useProviderAutoAssign();
    return null;
  }
  act(() => root.render(<Probe />));
}

const connect = (provider: string, hasKey = true) =>
  window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey } }));

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  assign.shouldAssign.mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useProviderAutoAssign', () => {
  it('on load, reconciles the active provider and then fits its model to the account, tracked', async () => {
    mount();
    await flush();
    expect(assign.reconcile).toHaveBeenCalledTimes(1);
    expect(assign.fit).toHaveBeenCalledWith('openrouter');
    expect(assign.reconcile.mock.invocationCallOrder[0]).toBeLessThan(assign.fit.mock.invocationCallOrder[0]);
    expect(assign.track).toHaveBeenCalledTimes(1);
    expect(assign.track.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it('assigns a freshly connected provider when no model works yet, then fits it', async () => {
    mount();
    await flush();
    vi.clearAllMocks();

    connect('groq');
    await flush();
    expect(assign.activate).toHaveBeenCalledWith('groq');
    expect(assign.fit).toHaveBeenCalledWith('groq');
    expect(assign.activate.mock.invocationCallOrder[0]).toBeLessThan(assign.fit.mock.invocationCallOrder[0]);
    expect(assign.track).toHaveBeenCalledTimes(1);
  });

  it('keeps a working model the person already chose, but still fits it to the account', async () => {
    assign.shouldAssign.mockReturnValue(false);
    mount();
    await flush();
    vi.clearAllMocks();

    connect('groq');
    await flush();
    expect(assign.activate).not.toHaveBeenCalled();
    expect(assign.fit).toHaveBeenCalledWith('groq');
  });

  it('ignores a key being removed', async () => {
    mount();
    await flush();
    vi.clearAllMocks();

    connect('groq', false);
    await flush();
    expect(assign.activate).not.toHaveBeenCalled();
    expect(assign.fit).not.toHaveBeenCalled();
    expect(assign.track).not.toHaveBeenCalled();
  });
});
