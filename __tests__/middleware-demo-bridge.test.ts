import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The demo's bridge page may be framed only by the hosted instances it answers, and by nobody when
 * the list is unavailable. Nothing else on the demo, and nothing anywhere else, gets the header.
 */
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ bridgeOrigins: vi.fn(async () => ['https://inst-1.example.com', 'https://inst-2.example.com']) }));
vi.mock('@/lib/demo-bridge/origins', () => ({ bridgeOrigins: mocks.bridgeOrigins }));

beforeEach(() => {
  vi.resetModules();
  mocks.bridgeOrigins.mockClear();
  vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
});
afterEach(() => vi.unstubAllEnvs());

async function get(path: string) {
  const { NextRequest } = await import('next/server');
  const { middleware } = await import('@/middleware');
  return middleware(new NextRequest(`https://try.example.com${path}`, { headers: { host: 'try.example.com' } }));
}

describe('the demo bridge page', () => {
  it('may be framed by the listed instances only', async () => {
    const res = await get('/demo-bridge');
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors https://inst-1.example.com https://inst-2.example.com');
  });

  it('may be framed by nobody when no instance is listed', async () => {
    mocks.bridgeOrigins.mockResolvedValueOnce([]);
    const res = await get('/demo-bridge');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('leaves the rest of the demo alone, and a Browser Mode install that is not a demo', async () => {
    expect((await get('/')).headers.get('content-security-policy')).toBeNull();
    vi.stubEnv('DEMO_GATEWAY_URL', '');
    expect((await get('/demo-bridge')).headers.get('content-security-policy')).toBeNull();
    expect(mocks.bridgeOrigins).not.toHaveBeenCalled();
  });
});
