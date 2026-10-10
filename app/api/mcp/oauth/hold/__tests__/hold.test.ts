import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The half of the consent round trip that parks the request before sending the visitor to an
 * external login. What it must not do is store a request for a client this instance does not know,
 * which would let a stray link redirect someone's next page view.
 */

vi.mock('server-only', () => ({}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-mcp-hold-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  vi.stubEnv('MCP_ENABLED', 'true');
  // The endpoint requires server mode as well as the flag.
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', 'https://gateway.oswstudio.com');
});

afterEach(async () => {
  const { closeSystemDatabase } = await import('@/lib/auth/system-database');
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(query: string) {
  const { GET } = await import('../route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest(`https://inst-1.oswstudio.com/api/mcp/oauth/hold?${query}`));
}

async function registerClient() {
  const { registerMcpClient } = await import('@/lib/mcp/store');
  return registerMcpClient('Test client', ['https://claude.ai/api/mcp/auth_callback']);
}

describe('holding an authorization request', () => {
  it('parks a registered client\'s request and sends the visitor to the gateway', async () => {
    const client = await registerClient();
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();

    const res = await call(`client_id=${client.client_id}&state=s1&code_challenge=xyz`);

    expect(res.headers.get('location')).toBe('https://gateway.oswstudio.com/login');
    const held = res.cookies.get(PENDING_MCP_COOKIE);
    expect(held?.value).toContain(`client_id=${client.client_id}`);
    expect(held?.value).toContain('state=s1');
    expect(held?.httpOnly).toBe(true);
    expect(held?.sameSite).toBe('lax');
  });

  it('holds nothing for a client this instance does not know', async () => {
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();

    const res = await call('client_id=not-registered&state=s1');

    expect(res.headers.get('location')).not.toContain('gateway');
    expect(res.cookies.get(PENDING_MCP_COOKIE)?.value ?? '').toBe('');
  });

  it('holds nothing when the query is not an authorization request', async () => {
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();

    const res = await call('state=s1&response_type=code');

    expect(res.cookies.get(PENDING_MCP_COOKIE)?.value ?? '').toBe('');
  });

  it('does not exist when the connector is disabled', async () => {
    vi.stubEnv('MCP_ENABLED', 'false');
    const res = await call('client_id=abc');
    expect(res.status).toBe(404);
  });

  it('falls back to the instance login when there is no external login', async () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', '');
    const client = await registerClient();
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();

    const res = await call(`client_id=${client.client_id}`);

    expect(res.headers.get('location')).toContain('/admin/login');
    expect(res.cookies.get(PENDING_MCP_COOKIE)?.value ?? '').toBe('');
  });
});

describe('the held authorization cookie name', () => {
  it('is __Host- prefixed exactly when cookies are Secure', async () => {
    const { pendingMcpCookieName, pendingMcpCookieOptions } = await import('@/lib/mcp/pending');
    vi.stubEnv('NODE_ENV', 'production');
    expect([pendingMcpCookieName(), pendingMcpCookieOptions(0)]).toEqual(['__Host-osw_mcp_pending', { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0, path: '/' }]);
    vi.stubEnv('SECURE_COOKIES', 'false');
    expect(pendingMcpCookieName()).toBe('osw_mcp_pending');
    vi.unstubAllEnvs();
  });
});
