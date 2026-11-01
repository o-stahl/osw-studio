import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

/** The demo-import answer in the real webhook outbox: however often it comes, the gateway hears it once. */

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/auth/session', () => ({ requireAuth: async () => ({ userId: session.userId, email: 'a@a.test', isAdmin: false }) }));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-demo-import-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  vi.stubEnv('WEBHOOK_URL', 'https://gateway.example.com');
});

afterEach(async () => {
  const { closeSystemDatabase } = await import('@/lib/auth/system-database');
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The outbox and the route as this test's fresh modules have them, with users who can answer the offer. */
async function outbox() {
  const { createUser, createWorkspace, getSystemDatabase } = await import('@/lib/auth/system-database');
  const webhooks = await import('@/lib/webhooks/outbox');
  const { POST } = await import('../demo-import/route');
  const user = (email: string) => {
    const userId = createUser(email, 'x');
    const workspaceId = createWorkspace('Mine', userId);
    const answer = () => {
      session.userId = userId;
      return POST(new NextRequest(`http://localhost/api/w/${workspaceId}/demo-import`, { method: 'POST' }), { params: Promise.resolve({ workspaceId }) });
    };
    return { userId, answer };
  };
  const queued = () => getSystemDatabase()
    .prepare("SELECT id, payload, delivered FROM webhook_outbox WHERE event_type = 'user.demo_import_handled' ORDER BY id")
    .all() as Array<{ id: number; payload: string; delivered: number }>;
  return { ...webhooks, user, queued };
}

describe('POST /api/w/{id}/demo-import, through the outbox', () => {
  it('queues one event while one is waiting to be delivered, and a new one after', async () => {
    const { user, queued, markDelivered } = await outbox();
    const { userId, answer } = user('a@a.test');

    for (let i = 0; i < 3; i++) expect((await answer()).status).toBe(204);
    expect(queued()).toEqual([{ id: expect.any(Number), payload: JSON.stringify({ userId }), delivered: 0 }]);

    markDelivered(queued()[0].id);
    expect((await answer()).status).toBe(204);
    expect(queued().map((row) => row.delivered)).toEqual([1, 0]);
  });

  it("queues each user's answer, while another user's still waits", async () => {
    const { user, queued } = await outbox();
    const a = user('a@a.test');
    const b = user('b@b.test');
    await a.answer();
    await b.answer();
    expect(queued().map((row) => JSON.parse(row.payload))).toEqual([{ userId: a.userId }, { userId: b.userId }]);
  });

  it('is not held back by a waiting event of another type with the same payload', async () => {
    const { user, queued, enqueueEvent } = await outbox();
    const { userId, answer } = user('a@a.test');
    enqueueEvent('user.deactivated', { userId });
    await answer();
    expect(queued()).toEqual([{ id: expect.any(Number), payload: JSON.stringify({ userId }), delivered: 0 }]);
  });

  it('queues the answer again once the delivery has given up on the waiting one', async () => {
    const { user, queued, markFailed, getPendingEvents } = await outbox();
    const { answer } = user('a@a.test');
    await answer();
    const [{ id }] = queued();
    for (let i = 0; i < 9; i++) markFailed(id);
    await answer();
    expect(queued()).toHaveLength(1);

    markFailed(id);
    expect(getPendingEvents().map((event) => event.id)).not.toContain(id);
    await answer();
    expect(queued().map((row) => row.id)).toEqual([id, expect.any(Number)]);
  });

  it('queues nothing without a gateway to tell', async () => {
    vi.stubEnv('WEBHOOK_URL', undefined);
    const { user, queued } = await outbox();
    expect((await user('a@a.test').answer()).status).toBe(204);
    expect(queued()).toEqual([]);
  });
});
