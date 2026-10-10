import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PATCH, POST, PUT } from '../route';
import { codexCookieName, codexLoginCookieName } from '../../cookie';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

type CodexGlobal = typeof globalThis & {
  oswCodexCallbackServer?: Promise<void>;
  oswCodexFlows?: Map<string, unknown>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  const g = globalThis as CodexGlobal;
  delete g.oswCodexCallbackServer;
  g.oswCodexFlows?.clear();
});

// Start a remote (manual-callback) flow and return the login cookie + state, without
// binding the localhost callback server (remote host => manualCallback === true).
async function startRemoteFlow() {
  const start = await POST(new NextRequest('https://host.example/api/auth/codex/connect', { method: 'POST' }));
  const flowCookie = start.cookies.get(codexLoginCookieName())?.value as string;
  const state = new URL((await start.json()).authorizationUrl).searchParams.get('state') as string;
  return { flowCookie, state };
}

function patchWith(flowCookie: string | undefined, redirectUrl: string) {
  return PATCH(new NextRequest('https://host.example/api/auth/codex/connect', {
    method: 'PATCH',
    headers: {
      ...(flowCookie ? { cookie: `${codexLoginCookieName()}=${flowCookie}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ redirectUrl }),
  }));
}

describe('Codex interactive login', () => {
  it('starts browser PKCE with automatic callback for localhost', async () => {
    (globalThis as typeof globalThis & { oswCodexCallbackServer?: Promise<void> }).oswCodexCallbackServer = Promise.resolve();

    const start = await POST(new NextRequest('http://localhost/api/auth/codex/connect', { method: 'POST' }));
    const login = await start.json();
    const authUrl = new URL(login.authorizationUrl);

    expect(login.manualCallback).toBe(false);
    expect(authUrl.pathname).toBe('/oauth/authorize');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('accepts a copied redirect URL when the callback server is remote', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json({ access_token: 'remote-access', refresh_token: 'remote-refresh', expires_in: 3600 }),
    ));

    const start = await POST(new NextRequest('https://example.hf.space/api/auth/codex/connect', { method: 'POST' }));
    const flowCookie = start.cookies.get(codexLoginCookieName())?.value;
    const login = await start.json();
    const state = new URL(login.authorizationUrl).searchParams.get('state');
    expect(login.manualCallback).toBe(true);

    const complete = await PATCH(new NextRequest('https://example.hf.space/api/auth/codex/connect', {
      method: 'PATCH',
      headers: {
        cookie: `${codexLoginCookieName()}=${flowCookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ redirectUrl: `http://localhost:1455/auth/callback?code=remote-code&state=${state}` }),
    }));

    expect(await complete.json()).toMatchObject({ access_token: 'remote-access' });
    expect(complete.cookies.get(codexCookieName())?.value).toBe('remote-refresh');
  });
});

describe('Codex login rejects invalid completions', () => {
  it('PATCH without a login cookie is unauthorized', async () => {
    const res = await patchWith(undefined, 'http://localhost:1455/auth/callback?code=c&state=s');
    expect(res.status).toBe(401);
  });

  it('PATCH rejects a redirect URL that is not the localhost:1455 callback', async () => {
    const { flowCookie, state } = await startRemoteFlow();
    const res = await patchWith(flowCookie, `http://evil.example:1455/auth/callback?code=c&state=${state}`);
    expect(res.status).toBe(400);
  });

  it('PATCH rejects a redirect URL whose state does not match the flow', async () => {
    const { flowCookie } = await startRemoteFlow();
    const res = await patchWith(flowCookie, 'http://localhost:1455/auth/callback?code=c&state=not-the-state');
    expect(res.status).toBe(400);
  });

  it('PATCH rejects a redirect URL with no authorization code', async () => {
    const { flowCookie, state } = await startRemoteFlow();
    const res = await patchWith(flowCookie, `http://localhost:1455/auth/callback?state=${state}`);
    expect(res.status).toBe(400);
  });

  it('PATCH rejects an oversized redirect URL', async () => {
    const { flowCookie } = await startRemoteFlow();
    const res = await patchWith(flowCookie, `http://localhost:1455/auth/callback?code=${'x'.repeat(10_001)}`);
    expect(res.status).toBe(400);
  });

  it('none of the rejected completions issue a refresh-token cookie', async () => {
    const { flowCookie, state } = await startRemoteFlow();
    const res = await patchWith(flowCookie, `http://evil.example:1455/auth/callback?code=c&state=${state}`);
    expect(res.cookies.get(codexCookieName())?.value).toBeFalsy();
  });

  it('PUT without a login cookie is unauthorized', async () => {
    const res = await PUT(new NextRequest('https://host.example/api/auth/codex/connect', { method: 'PUT' }));
    expect(res.status).toBe(401);
  });

  it('PUT reports pending while the callback has not completed', async () => {
    const { flowCookie } = await startRemoteFlow();
    const res = await PUT(new NextRequest('https://host.example/api/auth/codex/connect', {
      method: 'PUT',
      headers: { cookie: `${codexLoginCookieName()}=${flowCookie}` },
    }));
    expect(res.status).toBe(202);
  });
});
