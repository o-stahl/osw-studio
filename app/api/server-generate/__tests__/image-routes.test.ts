import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ServerTask, ImageDelegationResult } from '@/lib/server-generate/types';
import { addImageRequest } from '@/lib/server-generate/image-requests';

/**
 * The two routes a browser tab uses for an image a server-side run delegated to it: claim the
 * request (only one tab generates and pays), then hand back the result. Both act only for the
 * account that owns the task.
 */

let session: { userId: string } | null = { userId: 'user-1' };
vi.mock('@/lib/auth/session', () => ({ getSession: async () => session }));

const tasks = new Map<string, ServerTask>();
vi.mock('@/lib/server-generate/singleton', () => ({
  taskManager: { initialize: vi.fn(async () => {}), getTask: (id: string) => tasks.get(id) },
}));

import { POST as CLAIM } from '../image-claim/route';
import { POST as RESULT } from '../image-result/route';

function req(body: unknown, broken = false): NextRequest {
  return { json: async () => { if (broken) throw new SyntaxError('bad json'); return body; } } as unknown as NextRequest;
}

let resolved: ImageDelegationResult[];
beforeEach(() => {
  session = { userId: 'user-1' };
  tasks.clear();
  resolved = [];
  const task = { id: 't1', sessionId: 'user-1' } as unknown as ServerTask;
  addImageRequest(task, 'r1', (r) => resolved.push(r));
  tasks.set('t1', task);
});

describe('/api/server-generate/image-claim', () => {
  it('grants the first claim and refuses the next', async () => {
    expect(await (await CLAIM(req({ taskId: 't1', requestId: 'r1' }))).json()).toEqual({ granted: true });
    expect(await (await CLAIM(req({ taskId: 't1', requestId: 'r1' }))).json()).toEqual({ granted: false });
  });

  it('answers 401 without a session', async () => {
    session = null;
    expect((await CLAIM(req({ taskId: 't1', requestId: 'r1' }))).status).toBe(401);
  });

  it('answers 403 for another account\'s task, leaving the request unclaimed', async () => {
    session = { userId: 'user-2' };
    expect((await CLAIM(req({ taskId: 't1', requestId: 'r1' }))).status).toBe(403);
    session = { userId: 'user-1' };
    expect(await (await CLAIM(req({ taskId: 't1', requestId: 'r1' }))).json()).toEqual({ granted: true });
  });

  it('answers 404 for an unknown task, 400 for missing ids or broken JSON', async () => {
    expect((await CLAIM(req({ taskId: 'nope', requestId: 'r1' }))).status).toBe(404);
    expect((await CLAIM(req({ taskId: 't1' }))).status).toBe(400);
    expect((await CLAIM(req({ requestId: 'r1' }))).status).toBe(400);
    expect((await CLAIM(req(null, true))).status).toBe(400);
  });
});

describe('/api/server-generate/image-result', () => {
  it('settles the request with the image', async () => {
    const res = await RESULT(req({ taskId: 't1', requestId: 'r1', base64: 'AAAA', mimeType: 'image/png' }));
    expect(await res.json()).toEqual({ ok: true });
    expect(resolved).toEqual([{ base64: 'AAAA', mimeType: 'image/png' }]);
  });

  it('settles with an error when the payload is not an image', async () => {
    await RESULT(req({ taskId: 't1', requestId: 'r1', base64: 'AAAA', mimeType: 'text/html' }));
    expect(resolved).toEqual([{ error: 'image generation failed' }]);
  });

  it('passes the browser\'s error on', async () => {
    await RESULT(req({ taskId: 't1', requestId: 'r1', error: 'Insufficient pollen' }));
    expect(resolved).toEqual([{ error: 'Insufficient pollen' }]);
  });

  it('answers 401 without a session and 403 for another account, settling nothing', async () => {
    session = null;
    expect((await RESULT(req({ taskId: 't1', requestId: 'r1', base64: 'A', mimeType: 'image/png' }))).status).toBe(401);
    session = { userId: 'user-2' };
    expect((await RESULT(req({ taskId: 't1', requestId: 'r1', base64: 'A', mimeType: 'image/png' }))).status).toBe(403);
    expect(resolved).toEqual([]);
  });

  it('answers 404 for an unknown task and 400 for broken JSON', async () => {
    expect((await RESULT(req({ taskId: 'nope', requestId: 'r1' }))).status).toBe(404);
    expect((await RESULT(req(null, true))).status).toBe(400);
  });
});
