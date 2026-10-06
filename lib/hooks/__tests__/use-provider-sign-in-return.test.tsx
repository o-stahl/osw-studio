// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A provider sign-in coming back to the app: the code is traded for a key, the key stored like a
 * pasted one, and the address cleaned up. The exchange itself (`completeSignIn`) runs for real
 * against a stubbed `fetch`; the hook's own collaborators are mocked so each effect can be seen.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const config = vi.hoisted(() => ({ setProviderApiKey: vi.fn(), clearModelCache: vi.fn() }));
vi.mock('@/lib/config/storage', () => ({ configManager: config }));

const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/telemetry', () => ({ track }));

const settled = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));
vi.mock('@/lib/llm/models/global-auto-assign', () => ({ connectSettled: () => settled.fn() }));

import { useProviderSignInReturn } from '../use-provider-sign-in-return';

const PENDING_KEY = 'osw_provider_sign_ins';
const SIGNED_IN = 'osw-provider-signed-in';

function pending(nonce: string, returnProject: string | null = 'p1') {
  const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
  all[nonce] = { provider: 'openrouter', verifier: 'v'.repeat(43), redirectUri: 'http://localhost:3000/', returnProject, startedAt: Date.now() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(all));
}

const at = (search: string) => window.history.replaceState(null, '', `/${search}`);

let fetchMock: ReturnType<typeof vi.fn>;
let keyUpdates: Array<{ provider: string; hasKey: boolean }>;
const onKeyUpdated = (e: Event) => keyUpdates.push((e as CustomEvent).detail);

let container: HTMLElement;
let roots: Root[];

function mount() {
  function Probe() {
    useProviderSignInReturn();
    return null;
  }
  const root = createRoot(container.appendChild(document.createElement('div')));
  roots.push(root);
  act(() => root.render(<Probe />));
}

/** Let the exchange's promise chain run to its `finally`. */
async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.clearAllMocks();
  settled.fn = vi.fn(async () => {});
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: 'sk-or-v1-abc' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  keyUpdates = [];
  window.addEventListener('apiKeyUpdated', onKeyUpdated);
  container = document.createElement('div');
  document.body.appendChild(container);
  roots = [];
});

afterEach(async () => {
  await flush();
  act(() => roots.forEach((r) => r.unmount()));
  container.remove();
  window.removeEventListener('apiKeyUpdated', onKeyUpdated);
  Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  at('');
});

describe('a sign-in returning to this page', () => {
  it('stores the key, clears the model cache, announces it, and cleans up the address', async () => {
    pending('n1', 'p1');
    at('?code=xyz&osw_sign_in=n1');
    mount();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(config.setProviderApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-v1-abc');
    expect(config.clearModelCache).toHaveBeenCalledWith('openrouter');
    expect(track).toHaveBeenCalledWith('connection_added', { provider: 'openrouter', method: 'oauth' });
    expect(toast.success).toHaveBeenCalledWith('connect.connected');
    expect(keyUpdates).toEqual([{ provider: 'openrouter', hasKey: true }]);
    // Every return parameter is gone, and the project it started from is named in its place.
    expect(window.location.search).toBe('?project=p1');
  });

  it('keeps a project already in the address', async () => {
    pending('n1', 'p1');
    at('?code=xyz&osw_sign_in=n1&project=p2');
    mount();
    await flush();
    expect(window.location.search).toBe('?project=p2');
  });

  it('waits for the connect handling to settle before changing the address', async () => {
    let release!: () => void;
    settled.fn = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    pending('n1', 'p1');
    at('?code=xyz&osw_sign_in=n1');
    mount();
    await flush();

    expect(settled.fn).toHaveBeenCalled();
    expect(window.location.search).toContain('code=xyz');
    release();
    await flush();
    expect(window.location.search).toBe('?project=p1');
  });

  it('words a cancelled sign-in differently from a failed one, and still cleans up', async () => {
    pending('n1', 'p1');
    at('?error=access_denied&error_description=no&osw_sign_in=n1');
    mount();
    await flush();
    expect(toast.error).toHaveBeenCalledWith('connect.signInCancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(config.setProviderApiKey).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?project=p1');

    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 400 }));
    pending('n2', 'p1');
    at('?code=bad&osw_sign_in=n2');
    mount();
    await flush();
    expect(toast.error).toHaveBeenCalledWith('connect.signInFailed');
  });

  it('does nothing for a page that is not a return, even with a sign-in pending', async () => {
    pending('n1', 'p1');
    // The callback before the provider answered carries only the nonce.
    at('?osw_sign_in=n1');
    mount();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PENDING_KEY)!)).toHaveProperty('n1');
  });

  it('exchanges the code once when both roots mount the hook at the same time', async () => {
    pending('n1', 'p1');
    at('?code=xyz&osw_sign_in=n1');
    mount();
    mount();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('handles a later return after the first has finished', async () => {
    pending('n1', 'p1');
    at('?code=xyz&osw_sign_in=n1');
    mount();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending('n2', 'p1');
    at('?code=abc&osw_sign_in=n2');
    mount();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a sign-in finished in a popup', () => {
  it('tells the page that opened it, at this origin only, and closes', async () => {
    const opener = { closed: false, postMessage: vi.fn() };
    Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true });
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    pending('n1', null);
    at('?code=xyz&osw_sign_in=n1');
    mount();
    await flush();

    expect(config.setProviderApiKey).toHaveBeenCalledWith('openrouter', 'sk-or-v1-abc');
    expect(opener.postMessage).toHaveBeenCalledWith({ type: SIGNED_IN, provider: 'openrouter' }, window.location.origin);
    expect(close).toHaveBeenCalled();
    // The opener announces it; the popup does not.
    expect(toast.success).not.toHaveBeenCalled();
    expect(keyUpdates).toEqual([]);
  });

  it('is announced by the opener for a message from its own origin only', async () => {
    at('');
    mount();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.test', data: { type: SIGNED_IN, provider: 'openrouter' } }));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(keyUpdates).toEqual([]);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: SIGNED_IN, provider: 'openrouter' } }));
    });
    expect(toast.success).toHaveBeenCalledWith('connect.connected');
    expect(keyUpdates).toEqual([{ provider: 'openrouter', hasKey: true }]);
  });
});
