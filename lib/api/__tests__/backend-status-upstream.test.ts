import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiFetch, getBackendStatus, markBackendDown, markBackendUp } from '../backend-status';

/**
 * The mail test answers 502 when the mail server refuses or cannot be reached. That is the route's
 * answer about another server, so it must neither raise the "backend down" banner nor clear it.
 */

function respond(status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
}

/** A route's own error, which a route handler answers as JSON. */
function respondJson(status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'x' }, { status })));
}

beforeEach(() => markBackendUp());
afterEach(() => vi.unstubAllGlobals());

describe('apiFetch and a relayed upstream 502', () => {
  it('does not raise the banner for a 502 the route relays', async () => {
    respond(502);
    await apiFetch('/api/w/ws1/mail/test', { method: 'POST' }, { relaysUpstream: true });
    expect(getBackendStatus().backendDown).toBe(false);
  });

  it("does not raise the banner for a relaying route's own JSON answer about another server", async () => {
    // /api/generate answers 503 with its JSON error when the model's server cannot be reached.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'not available', code: 'model_unavailable' }, { status: 503 })));
    await apiFetch('/api/generate', { method: 'POST' }, { relaysUpstream: true });
    expect(getBackendStatus().backendDown).toBe(false);
  });

  it("leaves a raised banner up for a relayed 502 and for a relaying route's own JSON answer", async () => {
    // Neither is a sign of life: a proxy in front of a stopped backend answers 502 too.
    markBackendDown();
    respond(502);
    await apiFetch('/api/w/ws1/mail/test', { method: 'POST' }, { relaysUpstream: true });
    expect(getBackendStatus().backendDown).toBe(true);

    respondJson(503);
    await apiFetch('/api/generate', { method: 'POST' }, { relaysUpstream: true });
    expect(getBackendStatus().backendDown).toBe(true);
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

  it("raises it for an ordinary route's own JSON 500", async () => {
    // Only a relaying route's error can be about another server; any other route's is this backend failing.
    respondJson(500);
    await apiFetch('/api/w/ws1/projects');
    expect(getBackendStatus().backendDown).toBe(true);
  });
});
