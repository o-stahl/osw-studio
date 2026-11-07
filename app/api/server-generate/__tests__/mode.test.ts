import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * A server run takes the mode picked in the chat and, for an interview, its template. The request
 * carried neither, so every server run was the building agent: Chat mode wrote files and an interview
 * built the site it was meant to plan. The template is checked here because it goes into the run's
 * system prompt and its completion check.
 */

const mocks = vi.hoisted(() => ({
  runServerGeneration: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ userId: 'admin', email: '', isAdmin: true, exp: 0 }) }));
vi.mock('@/lib/auth/system-database', () => ({ verifyWorkspaceAccess: vi.fn() }));
vi.mock('@/lib/server-generate/singleton', () => ({
  taskManager: { initialize: vi.fn(), updateTask: vi.fn(), getTask: () => ({ id: 'task-1' }), createTask: () => 'task-1' },
  eventBus: {},
}));
vi.mock('@/lib/server-generate/server-orchestrator-runner', () => ({ runServerGeneration: mocks.runServerGeneration }));

const start = async (body: Record<string, unknown>) => {
  const { POST } = await import('../route');
  return POST({ json: async () => ({ projectId: 'p1', prompt: 'x', model: 'm', apiKey: 'k', ...body }) } as unknown as NextRequest);
};

const template = {
  id: 'custom-x', title: 'Custom X', description: 'A custom interview',
  items: [{ id: 'a', elicit: 'Who is it for', completion: [{ type: 'judge', criteria: 'Names the audience', description: 'Audience' }] }],
  artifacts: [{ path: '/.interviews/x.md' }],
  handoff: { label: 'Build it', prompt: 'Build from /.interviews/x.md', mode: 'code' },
};

beforeEach(() => vi.clearAllMocks());

describe('the mode a server run starts in', () => {
  it('refuses a mode it does not know', async () => {
    expect((await start({ mode: 'build-everything' })).status).toBe(400);
    expect(mocks.runServerGeneration).not.toHaveBeenCalled();
  });

  it.each([
    ['no items', { ...template, items: undefined }],
    ['a check that does not exist', { ...template, items: [{ id: 'a', elicit: 'e', completion: [{ type: 'run_shell' }] }] }],
    ['a hand-off to a mode that does not exist', { ...template, handoff: { label: 'l', prompt: 'p', mode: 'interview' } }],
  ])('refuses an interview template with %s', async (_, bad) => {
    expect((await start({ mode: 'interview', interviewTemplate: bad })).status).toBe(400);
    expect(mocks.runServerGeneration).not.toHaveBeenCalled();
  });

  it('hands the run its template without the browser\'s bookkeeping', async () => {
    const res = await start({ mode: 'interview', interviewTemplate: { ...template, isBuiltIn: false, createdAt: '2026-11-03' } });

    expect(res.status).toBe(200);
    const body = (mocks.runServerGeneration.mock.calls[0] as unknown[])[1] as { mode: string; interviewTemplate: unknown };
    expect(body.mode).toBe('interview');
    expect(body.interviewTemplate).toEqual(template);
  });
});
