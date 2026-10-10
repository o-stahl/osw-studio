import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The gateway hands a signed-in user to an instance with a one-time token and a redirect. The
 * redirect is followed only to a path on this instance, so a crafted handoff link cannot bounce the
 * user off-site with a fresh session. On a Secure install the session and the workspace land under
 * their `__Host-` names, which a published site on a sibling subdomain cannot overwrite. The
 * workspace comes from the redirect only when it is id-shaped; anything else selects the user's own
 * default.
 */

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  verifyHandoffToken: vi.fn(async (_t: string) => ({ userId: 'user-1' }) as { userId: string } | null),
  getUserDefaultWorkspace: vi.fn((_id: string) => 'default-ws'),
}));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  verifyHandoffToken: mocks.verifyHandoffToken,
}));
vi.mock('@/lib/auth/system-database', () => ({
  getUserById: (id: string) => ({ id, email: 'u@a.test', is_admin: 0 }),
  getUserDefaultWorkspace: mocks.getUserDefaultWorkspace,
}));
vi.mock('@/lib/auth/default-workspace', () => ({ ensureDefaultWorkspace: vi.fn(async () => {}) }));

const BASE = 'https://inst-1.oswstudio.com';
const WS = '0f8fad5b-d9cb-469f-a165-70867728950e';

async function handoff(redirect: string) {
  const { GET } = await import('../route');
  const url = `${BASE}/api/auth/handoff?${new URLSearchParams({ token: 'tok', redirect })}`;
  const res = await GET(new NextRequest(url));
  return { location: res.headers.get('location'), cookies: res.headers.getSetCookie() };
}
const cookie = (cookies: string[], name: string) => cookies.find(c => c.startsWith(`${name}=`));

beforeEach(() => {
  vi.resetModules();
  mocks.verifyHandoffToken.mockClear();
  mocks.getUserDefaultWorkspace.mockClear();
  vi.stubEnv('SESSION_SECRET', 'test-secret-value-that-is-long-enough');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', BASE);
});
afterEach(() => vi.unstubAllEnvs());

describe('the gateway handoff', () => {
  it.each(['//evil.com/x', '/\\evil.com', 'https://evil.com/'])('lands on / for the hostile redirect %s', async (redirect) => {
    expect((await handoff(redirect)).location).toBe(`${BASE}/`);
  });

  it('follows a redirect on this instance', async () => {
    expect((await handoff(`/w/${WS}/projects`)).location).toBe(`${BASE}/w/${WS}/projects`);
  });

  it('sets the session and the workspace under their __Host- names on a Secure install', async () => {
    const { cookies } = await handoff(`/w/${WS}/projects`);
    const session = cookie(cookies, '__Host-osw_session')!;
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/Path=\//i);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).not.toMatch(/Max-Age=0/i);
    const workspace = cookie(cookies, '__Host-osw_workspace')!;
    expect(workspace).toMatch(new RegExp(`^__Host-osw_workspace=${WS};`));
    expect(workspace).toMatch(/Secure/i);
    expect(workspace).toMatch(/Path=\//i);
    expect(mocks.getUserDefaultWorkspace).not.toHaveBeenCalled();
  });

  it('selects the user\'s default workspace when the one in the redirect is not an id', async () => {
    const { cookies } = await handoff('/w/not-a-uuid/projects');
    expect(cookie(cookies, '__Host-osw_workspace')).toMatch(/^__Host-osw_workspace=default-ws;/);
    expect(mocks.getUserDefaultWorkspace).toHaveBeenCalledWith('user-1');
  });

  it('signs nobody in without a valid token', async () => {
    mocks.verifyHandoffToken.mockResolvedValueOnce(null);
    const { location, cookies } = await handoff('/');
    expect(location).toBe(`${BASE}/admin/login`);
    expect(cookie(cookies, '__Host-osw_session')).toBeUndefined();
  });
});
