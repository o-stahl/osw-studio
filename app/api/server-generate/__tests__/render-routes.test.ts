import { describe, it, expect, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * The routes a browser tab answers the server's render and selection questions on: each reads a
 * JSON object, and a body that is not one is the caller's mistake, answered as such.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ userId: 'user-1' }) }));

import { POST as CLAIM } from '../render-claim/route';
import { POST as RESULT } from '../render-result/route';
import { POST as SELECTION } from '../selection-result/route';

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe('/api/server-generate render and selection routes', () => {
  it.each([
    ['render-claim', CLAIM],
    ['render-result', RESULT],
    ['selection-result', SELECTION],
  ])('%s answers 400 for a JSON body of null, and for one without a request id', async (_route, post) => {
    expect((await post(req(null))).status).toBe(400);
    expect((await post(req({}))).status).toBe(400);
  });

  it('reads the request id out of a body that is an object', async () => {
    expect(await (await CLAIM(req({ requestId: 'unknown' }))).json()).toEqual({ granted: false });
    expect((await RESULT(req({ requestId: 'unknown', result: { ok: false } }))).status).toBe(404);
    expect((await SELECTION(req({ requestId: 'unknown', selection: null }))).status).toBe(404);
  });
});
