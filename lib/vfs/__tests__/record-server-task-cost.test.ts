import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/lib/vfs';
import type { StorageAdapter } from '@/lib/vfs/adapters/types';
import type { Project } from '@/lib/vfs/types';

/**
 * A server run reports its task's running cost, and a reconnect replays events already sent. The
 * record has to count each dollar once however often the same total arrives.
 */
describe('VirtualFileSystem.recordServerTaskCost', () => {
  let stored: Project;
  let vfs: VirtualFileSystem;
  const updatedAt = new Date('2026-01-01T00:00:00Z');

  beforeEach(() => {
    stored = { id: 'p1', name: 'P', createdAt: updatedAt, updatedAt } as Project;
    const adapter = {
      getProject: async () => structuredClone(stored),
      updateProject: async (p: Project) => { stored = structuredClone(p); },
    } as unknown as StorageAdapter;
    vfs = new VirtualFileSystem(adapter);
    (vfs as unknown as { initialized: boolean }).initialized = true;
  });

  const report = (taskId: string, taskCost: number) => vfs.recordServerTaskCost('p1', {
    taskId, taskCost, provider: 'openrouter', tokenUsage: { input: 100, output: 10 },
  });

  it('adds only what a task has spent since its last report', async () => {
    expect(await report('t1', 0.01)).toBeCloseTo(0.01);
    expect(await report('t1', 0.03)).toBeCloseTo(0.03);
    expect(stored.costTracking?.providerBreakdown.openrouter.requestCount).toBe(2);
    expect(stored.costTracking?.providerBreakdown.openrouter.tokenUsage).toEqual({ input: 200, output: 20 });
  });

  it('ignores a replayed total', async () => {
    await report('t1', 0.01);
    await report('t1', 0.03);
    expect(await report('t1', 0.01)).toBeCloseTo(0.03);
    expect(await report('t1', 0.03)).toBeCloseTo(0.03);
    expect(stored.costTracking?.providerBreakdown.openrouter.requestCount).toBe(2);
  });

  it('adds separate tasks to the project total', async () => {
    stored.costTracking = { totalCost: 1, providerBreakdown: {} };
    await report('t1', 0.5);
    expect(await report('t2', 0.25)).toBeCloseTo(1.75);
    expect(stored.costTracking?.sessionHistory?.map(e => e.sessionId)).toEqual(['t1', 't2']);
  });

  it('counts a free model\'s calls by their tokens, once each', async () => {
    const free = (taskTokens: number) => vfs.recordServerTaskCost('p1', {
      taskId: 't1', taskCost: 0, taskTokens, provider: 'openrouter', tokenUsage: { input: 100, output: 10 },
    });
    await free(110);
    await free(220);
    await free(110);
    await free(220);
    const stats = stored.costTracking?.providerBreakdown.openrouter;
    expect(stats?.requestCount).toBe(2);
    expect(stats?.tokenUsage).toEqual({ input: 200, output: 20 });
    expect(stored.costTracking?.totalCost).toBe(0);
  });

  it('keeps the provider breakdown and the task entry in step with the total', async () => {
    await report('t1', 0.01);
    await report('t1', 0.03);
    expect(stored.costTracking?.providerBreakdown.openrouter.totalCost).toBeCloseTo(0.03);
    const entry = stored.costTracking?.sessionHistory?.find(e => e.sessionId === 't1');
    expect(entry?.cost).toBeCloseTo(0.03);
    expect(entry?.tokenUsage).toEqual({ input: 200, output: 20 });
  });

  it('never lowers what a task has counted when an older total arrives late', async () => {
    const send = (taskCost: number, taskTokens: number) => vfs.recordServerTaskCost('p1', {
      taskId: 't1', taskCost, taskTokens, provider: 'openrouter',
    });
    await send(0.02, 10);
    await send(0.01, 20);
    expect(await send(0.02, 20)).toBeCloseTo(0.02);
  });

  it('keeps the last 100 tasks in the history', async () => {
    for (let i = 0; i <= 100; i++) await report(`t${i}`, 0.001);
    const ids = stored.costTracking?.sessionHistory?.map(e => e.sessionId) ?? [];
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe('t1');
    expect(ids[99]).toBe('t100');
  });

  it('leaves updatedAt alone, so spend does not read as an unsynced edit', async () => {
    await report('t1', 0.01);
    expect(new Date(stored.updatedAt).getTime()).toBe(updatedAt.getTime());
  });
});
