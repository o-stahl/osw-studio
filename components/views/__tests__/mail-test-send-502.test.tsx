// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A test send relays to the mail server, and the route answers 502 when that server refuses or is
 * unreachable. That says nothing about this app's backend, so a failed test send never raises the
 * app-wide "server unreachable" banner, not even until the next request clears it.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { MailView } from '../mail-view';
import { markBackendUp, subscribeBackendStatus } from '@/lib/api/backend-status';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const SERVER = { host: 'smtp.example.com', port: 587, secure: 'starttls', user: null, from: 'studio@example.com', smtpPasswordSet: false };
const INSTANCE = { enabled: true, configured: true, ...SERVER };
const WORKSPACE = { workspaceId: 'ws1', enabled: true, mode: 'own', displayName: null, instanceConfigured: true, ...SERVER };

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  markBackendUp();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  markBackendUp();
});

/** Whether the backend was marked down at any point during the test send. */
async function sendTest(testUrl: string, props: { workspaceId?: string }, isAdmin: boolean): Promise<boolean> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/me') return json({ user: { email: 'ann@example.com', isAdmin } });
    if (url === '/api/admin/mail') return json(INSTANCE);
    if (url === '/api/w/ws1/mail') return json(WORKSPACE);
    if (url === testUrl) return json({ error: 'Connection refused' }, 502);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { root.render(withMessages(<MailView {...props} />)); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  const buttons = Array.from(container.querySelectorAll('button')).filter(b => b.textContent === en.mail.sendTest);
  expect(buttons).toHaveLength(1);
  let wentDown = false;
  const unsubscribe = subscribeBackendStatus((s) => { if (s.backendDown) wentDown = true; });
  await act(async () => { buttons[0].click(); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  unsubscribe();
  expect(fetchMock).toHaveBeenCalledWith(testUrl, { method: 'POST' });
  return wentDown;
}

describe('a mail test send the mail server refuses', () => {
  it('does not mark the backend down from the workspace test', async () => {
    expect(await sendTest('/api/w/ws1/mail/test', { workspaceId: 'ws1' }, false)).toBe(false);
  });

  it('does not mark the backend down from the instance test', async () => {
    expect(await sendTest('/api/admin/mail/test', {}, true)).toBe(false);
  });
});
