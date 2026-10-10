import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import { clearWorkspaceOnResponse, setWorkspaceOnResponse, workspaceFromCookieString, workspaceFromRequest } from '../workspace-cookie';

/**
 * The selected-workspace cookie is `__Host-osw_workspace` on HTTPS (no cookie tossing from a sibling
 * subdomain). It picks the browser's local project database, so every reader also accepts the old
 * name: a selection made before the change carries over instead of showing an empty project list.
 */

afterEach(() => vi.unstubAllEnvs());

describe('reading the workspace', () => {
  it('prefers the prefixed cookie and falls back to the old name', () => {
    expect(workspaceFromCookieString('a=1; osw_workspace=old; __Host-osw_workspace=new')).toBe('new');
    expect(workspaceFromCookieString('a=1; osw_workspace=old')).toBe('old');
    expect(workspaceFromCookieString('xosw_workspace=nope')).toBeUndefined();
    const jar = (values: Record<string, string>) => ({ cookies: { get: (n: string) => (n in values ? { value: values[n] } : undefined) } });
    expect(workspaceFromRequest(jar({ osw_workspace: 'old', '__Host-osw_workspace': 'new' }))).toBe('new');
    expect(workspaceFromRequest(jar({ osw_workspace: 'old' }))).toBe('old');
  });
});

describe('on a response', () => {
  it('sets the prefixed name on a Secure install and clears the old one', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = NextResponse.json({});
    setWorkspaceOnResponse(res, 'ws-1');
    const headers = res.headers.getSetCookie();
    expect(headers.find(h => h.startsWith('__Host-osw_workspace=ws-1'))).toMatch(/Secure.*|Path=\//i);
    expect(headers.find(h => h.startsWith('__Host-osw_workspace=ws-1'))).not.toMatch(/HttpOnly/i);
    expect(headers.some(h => /^osw_workspace=;/.test(h))).toBe(true);
  });

  it('keeps the old name on plain HTTP', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SECURE_COOKIES', 'false');
    const res = NextResponse.json({});
    setWorkspaceOnResponse(res, 'ws-1');
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^osw_workspace=ws-1/)]);
  });

  it('clears the prefixed cookie with Secure, which a bare delete would not', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = NextResponse.json({});
    clearWorkspaceOnResponse(res);
    const prefixed = res.headers.getSetCookie().find(h => h.startsWith('__Host-osw_workspace='))!;
    expect(prefixed).toMatch(/Secure/i);
    expect(prefixed).toMatch(/Path=\//i);
  });

  it('clears only the plain name where cookies are not Secure, which cannot hold the prefix', () => {
    const res = NextResponse.json({});
    clearWorkspaceOnResponse(res);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^osw_workspace=;/)]);
  });
});
