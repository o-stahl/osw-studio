import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiFetch, getBackendStatus, markBackendUp } from '../backend-status';

/**
 * The mail test answers 502 when the mail server refuses or cannot be reached. That is the route's
 * answer about another server, so it must not raise the "backend down" banner.
 */

function respond(status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
}

beforeEach(() => markBackendUp());
afterEach(() => vi.unstubAllGlobals());

describe('apiFetch and a relayed upstream 502', () => {
  it('does not raise the banner for a 502 the route relays', async () => {
    respond(502);
    await apiFetch('/api/w/ws1/mail/test', { method: 'POST' }, { relaysUpstream: true });
    expect(getBackendStatus().backendDown).toBe(false);
  });

  it('still raises it for a 502 on an ordinary call, and for a 500 on a relaying one', async () => {
    respond(502);
    await apiFetch('/api/w/ws1/projects');
    expect(getBackendStatus().backendDown).toBe(true);

    markBackendUp();
    respond(500);
    await apiFetch('/api/w/ws1/mail/test', { method: 'POST' }, { relaysUpstream: true });
    expect(getBackendStatus().backendDown).toBe(true);
  });
});
