// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The connected ChatGPT (Codex) row: how long its token has left, and the reconcile that drops a
 * login this browser remembers but the server no longer holds.
 */
const mocks = vi.hoisted(() => ({
  auth: null as null | { expires_at?: number; user_email?: string },
  clearCodexAuth: vi.fn(),
  checkCodexStatus: vi.fn(),
  disconnectCodex: vi.fn(),
}));

vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getCodexAuth: () => mocks.auth,
    clearCodexAuth: () => { mocks.clearCodexAuth(); mocks.auth = null; },
    setCodexAuth: vi.fn(),
  },
}));
vi.mock('@/lib/auth/codex-auth', () => ({
  checkCodexStatus: mocks.checkCodexStatus,
  disconnectCodex: mocks.disconnectCodex,
  startCodexLogin: vi.fn(),
  completeCodexLogin: vi.fn(),
  pollCodexLogin: vi.fn(),
}));
vi.mock('@/components/settings/connection-badge', () => ({
  ConnectionBadge: ({ info }: { info?: string }) => <div data-info={info ?? ''} />,
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CodexAuthPanel } from '../codex-auth-panel';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

const NOW = new Date('2026-10-05T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.checkCodexStatus.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(onAuthChange?: () => void) {
  await act(async () => { root.render(withMessages(<CodexAuthPanel onAuthChange={onAuthChange} />)); });
}
const info = () => container.querySelector('[data-info]')?.getAttribute('data-info');

describe('the token\'s remaining time', () => {
  it('counts minutes under an hour', async () => {
    mocks.auth = { expires_at: nowSec + 30 * 60 + 20, user_email: 'a@b.c' };
    await mount();
    expect(info()).toBe('Expires in 30m');
  });

  it('counts hours and minutes past an hour', async () => {
    mocks.auth = { expires_at: nowSec + 125 * 60, user_email: 'a@b.c' };
    await mount();
    expect(info()).toBe('Expires in 2h 5m');
  });

  it('says it has expired, and will refresh, once the time is up', async () => {
    mocks.auth = { expires_at: nowSec, user_email: 'a@b.c' };
    await mount();
    expect(info()).toBe('Expired (will auto-refresh)');
  });

  it('says nothing without an expiry', async () => {
    mocks.auth = { user_email: 'a@b.c' };
    await mount();
    expect(info()).toBe('');
  });
});

describe('reconciling with the server', () => {
  it('forgets a login the server no longer holds and tells the app', async () => {
    mocks.auth = { expires_at: nowSec + 3600, user_email: 'a@b.c' };
    mocks.checkCodexStatus.mockResolvedValue(false);
    const onAuthChange = vi.fn();
    const announced = vi.fn();
    window.addEventListener('apiKeyUpdated', announced);
    await mount(onAuthChange);
    window.removeEventListener('apiKeyUpdated', announced);

    expect(mocks.clearCodexAuth).toHaveBeenCalled();
    expect(onAuthChange).toHaveBeenCalled();
    expect((announced.mock.calls[0][0] as CustomEvent).detail).toEqual({ provider: 'openai-codex', hasKey: false });
    expect(info()).toBeUndefined();
  });

  it('ends a server session this browser has no login for', async () => {
    mocks.auth = null;
    mocks.checkCodexStatus.mockResolvedValue(true);
    await mount();
    expect(mocks.disconnectCodex).toHaveBeenCalled();
  });

  it('calls nothing when neither side has a login', async () => {
    mocks.auth = null;
    mocks.checkCodexStatus.mockResolvedValue(false);
    await mount();
    expect(mocks.disconnectCodex).not.toHaveBeenCalled();
  });

  it('leaves a matching login alone', async () => {
    mocks.auth = { expires_at: nowSec + 3600, user_email: 'a@b.c' };
    await mount();
    expect(mocks.clearCodexAuth).not.toHaveBeenCalled();
    expect(mocks.disconnectCodex).not.toHaveBeenCalled();
  });
});
