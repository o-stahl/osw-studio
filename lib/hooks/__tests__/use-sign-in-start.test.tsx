// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Inside the HuggingFace Space's frame a popup sign-in returns to the Space's page on
 * huggingface.co, whose frame shares this one's storage; anywhere else it returns to the app.
 */

const mocks = vi.hoisted(() => ({
  startSignIn: vi.fn(async () => true),
  prepareSignIn: vi.fn(async () => {}),
  embedded: false,
  spaceId: null as string | null,
  checkHFCapabilities: vi.fn(async () => ({ spaceId: mocks.spaceId })),
}));
vi.mock('@/lib/auth/provider-sign-in', () => ({ startSignIn: mocks.startSignIn, prepareSignIn: mocks.prepareSignIn }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: () => mocks.checkHFCapabilities() }));
vi.mock('@/lib/web/embedded', () => ({ isEmbedded: () => mocks.embedded }));

import { useSignInStart } from '../use-sign-in-start';

let container: HTMLElement;
let root: Root;
let hook: ReturnType<typeof useSignInStart>;
const start = (...args: Parameters<ReturnType<typeof useSignInStart>['start']>) => hook.start(...args);

async function mount() {
  function Probe() {
    hook = useSignInStart();
    return null;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.embedded = false;
  mocks.spaceId = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useSignInStart', () => {
  it('prepares the next sign-in on mount', async () => {
    await mount();
    expect(mocks.prepareSignIn).toHaveBeenCalled();
  });

  it('returns a popup sign-in to the Space page when embedded in a Space', async () => {
    mocks.embedded = true;
    mocks.spaceId = 'otst/osw-studio';
    await mount();
    await start('openrouter', { popup: true });
    expect(mocks.startSignIn).toHaveBeenLastCalledWith('openrouter', { popup: true, returnTo: 'https://huggingface.co/spaces/otst/osw-studio' });
  });

  it('adds no return page to a redirect, which never leaves this frame\'s storage', async () => {
    mocks.embedded = true;
    mocks.spaceId = 'otst/osw-studio';
    await mount();
    await start('openrouter', { popup: false });
    expect(mocks.startSignIn).toHaveBeenLastCalledWith('openrouter', { popup: false });
  });

  it('adds none when the page is not embedded, or is embedded somewhere other than a Space', async () => {
    mocks.spaceId = 'otst/osw-studio';
    await mount();
    await start('openrouter', { popup: true });
    expect(mocks.startSignIn).toHaveBeenLastCalledWith('openrouter', { popup: true });

    act(() => root.unmount());
    root = createRoot(container);
    mocks.embedded = true;
    mocks.spaceId = null;
    await mount();
    await start('openrouter', { popup: true });
    expect(mocks.startSignIn).toHaveBeenLastCalledWith('openrouter', { popup: true });
  });

  it('is not ready until the PKCE pair and, in a frame, the Space page are known', async () => {
    let finishPrepare!: () => void;
    mocks.prepareSignIn.mockImplementationOnce(() => new Promise<void>((r) => { finishPrepare = r; }));
    function Probe() {
      hook = useSignInStart();
      return null;
    }
    await act(async () => root.render(<Probe />));
    expect(hook.ready).toBe(false);
    await act(async () => { finishPrepare(); await Promise.resolve(); });
    expect(hook.ready).toBe(true);
  });

  it('in a frame, is not ready until the Space lookup resolves', async () => {
    mocks.embedded = true;
    let finishLookup!: (c: { spaceId: string }) => void;
    mocks.checkHFCapabilities.mockImplementationOnce(() => new Promise((r) => { finishLookup = r; }));
    await mount();
    expect(mocks.prepareSignIn).toHaveBeenCalled();
    expect(hook.ready).toBe(false);
    await act(async () => { finishLookup({ spaceId: 'otst/osw-studio' }); await Promise.resolve(); });
    expect(hook.ready).toBe(true);
    await start('openrouter', { popup: true });
    expect(mocks.startSignIn).toHaveBeenLastCalledWith('openrouter', { popup: true, returnTo: 'https://huggingface.co/spaces/otst/osw-studio' });
  });
});
