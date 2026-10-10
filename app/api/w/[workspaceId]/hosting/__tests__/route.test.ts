import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The deployments view asks how sites are served so it can warn when they share the studio's
 * origin. Any member may ask (a viewer sees the same list), and the answer follows the install's
 * configuration, not anything about the workspace.
 */

const access = vi.hoisted(() => ({ role: 'viewer' as 'viewer' | 'editor' | null, signedIn: true }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/workspace-context', () => ({
  getWorkspaceContext: vi.fn(async (_params: unknown, role: 'viewer' | 'editor' | 'owner' = 'editor') => {
    if (!access.signedIn) throw new Error('Unauthorized');
    if (!access.role) throw new Error('Workspace access denied');
    if (role !== 'viewer' && access.role === 'viewer') throw new Error('Insufficient workspace permissions');
    return { session: { userId: 'u1' }, workspaceId: 'ws', adapter: {} };
  }),
}));

const ask = async () => {
  const { GET } = await import('../route');
  return GET(new NextRequest('http://x/api/w/ws/hosting'), { params: Promise.resolve({ workspaceId: 'ws' }) });
};

beforeEach(() => {
  access.role = 'viewer';
  access.signedIn = true;
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://studio.example.com');
  vi.stubEnv('STATIC_PROXY', '');
  vi.stubEnv('SITES_ORIGIN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/w/{id}/hosting', () => {
  it.each([
    [{}, 'same-origin'],
    [{ SITES_ORIGIN: 'https://sites.example.com' }, 'host'],
    [{ STATIC_PROXY: 'true', SITES_ORIGIN: 'https://sites.example.com' }, 'proxy'],
  ])('tells a viewer the sites mode for %o', async (env, mode) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sitesMode: mode });
  });

  it('answers 401 without a session and 403 to a non-member', async () => {
    access.signedIn = false;
    expect((await ask()).status).toBe(401);
    access.signedIn = true;
    access.role = null;
    const denied = await ask();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Workspace access denied' });
  });
});
