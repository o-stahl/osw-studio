import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A `/w/{id}` page selects its workspace. The browser names its local project database, and the
 * workspace its API calls go to, after the cookie, so a link into a workspace other than the
 * selected one would show that URL over the selected workspace's projects and sync them into it.
 */

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('SESSION_SECRET', 'test-secret-value-that-is-long-enough');
});

afterEach(() => vi.unstubAllEnvs());

async function visit(path: string, selected?: string, signedIn = true, headers: Record<string, string> = {}) {
  const { NextRequest } = await import('next/server');
  const { createSession, sessionCookieName } = await import('@/lib/auth/session');
  const { middleware } = await import('@/middleware');
  const req = new NextRequest(`http://localhost:3000${path}`, { method: 'GET', headers: { host: 'localhost:3000', ...headers } });
  if (signedIn) req.cookies.set(sessionCookieName(), await createSession('user-1', 'u@a.test', false));
  if (selected) req.cookies.set('osw_workspace', selected);
  return middleware(req);
}

const selection = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('osw_workspace='));

describe('a workspace page request', () => {
  it('selects the workspace in its path when another is selected', async () => {
    expect(selection(await visit('/w/ws-b/projects', 'ws-a'))).toMatch(/^osw_workspace=ws-b;/);
  });

  it('selects it when none is selected yet', async () => {
    expect(selection(await visit('/w/ws-b/projects?project=p1'))).toMatch(/^osw_workspace=ws-b;/);
  });

  it('leaves a matching selection alone', async () => {
    expect(selection(await visit('/w/ws-a/projects', 'ws-a'))).toBeUndefined();
  });

  it('takes nothing that is not shaped like a workspace id', async () => {
    expect(selection(await visit('/w/a%3Bb/projects', 'ws-a'))).toBeUndefined();
  });

  // A link the router prefetches, or the browser speculatively loads, is not a page the user opened.
  it.each([
    ['the router prefetches it', { 'next-router-prefetch': '1' }],
    ['the browser prefetches it', { 'sec-purpose': 'prefetch' }],
    ['an older browser prefetches it', { purpose: 'prefetch' }],
  ])('selects nothing when %s', async (_why, headers) => {
    expect(selection(await visit('/w/ws-b/projects', 'ws-a', true, headers))).toBeUndefined();
  });

  it('selects nothing for a visitor who is not signed in', async () => {
    const res = await visit('/w/ws-b/projects', 'ws-a', false);
    expect(res.status).toBe(307);
    expect(selection(res)).not.toMatch(/=ws-b/);
  });
});
