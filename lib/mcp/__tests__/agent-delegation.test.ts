import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The request a tool opens and the answer a route settles have to meet in the same place.
 *
 * They are separate entry points, and each can receive its own instance of this module, so the map
 * that holds pending requests is pinned to globalThis. Without that the answer landed in a second
 * copy: the route replied 404, the tool waited out its timeout, and the task it had started ran to
 * completion unreported.
 */

vi.mock('server-only', () => ({}));

const bus = vi.hoisted(() => ({ listeners: new Set<string>(), emitted: [] as { event: string; data: Record<string, unknown> }[] }));
vi.mock('@/lib/server-generate/singleton', () => ({
  eventBus: {
    hasListener: (id: string) => bus.listeners.has(id),
    emit: (_t: string, _p: string, event: string, data: Record<string, unknown>) => { bus.emitted.push({ event, data }); },
    clearTask: () => {},
  },
}));

beforeEach(() => {
  bus.listeners.clear();
  bus.emitted.length = 0;
  delete (globalThis as { __mcpPendingRuns?: unknown }).__mcpPendingRuns;
  vi.resetModules();
});
afterEach(() => vi.useRealTimers());

const args = { userId: 'u1', projectId: 'p1', prompt: 'go', chatMode: false, clientLabel: 'Claude' };

describe('agent delegation', () => {
  it('refuses at once when no tab is attached, rather than waiting out the timeout', async () => {
    const { requestRunFromClient } = await import('@/lib/mcp/agent-delegation');

    const result = await requestRunFromClient(args);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/tab is open/i);
    expect(bus.emitted).toHaveLength(0);
  });

  it('resolves with the task the tab reports, through a separately imported module instance', async () => {
    bus.listeners.add('u1');
    const { requestRunFromClient } = await import('@/lib/mcp/agent-delegation');
    const pendingRun = requestRunFromClient(args);
    await Promise.resolve();

    // A fresh import stands in for the answering route being its own entry point.
    vi.resetModules();
    const { settleRunRequest } = await import('@/lib/mcp/agent-delegation');
    const requestId = [...(globalThis as unknown as { __mcpPendingRuns: Map<string, unknown> }).__mcpPendingRuns.keys()][0];
    expect(settleRunRequest(requestId, 'u1', { ok: true, taskId: 't9' })).toBe(true);

    expect(await pendingRun).toMatchObject({ ok: true, taskId: 't9' });
    expect(bus.emitted.map(e => e.event)).toEqual(['mcp_run_requested']);
  });

  it('refuses an answer from another account', async () => {
    bus.listeners.add('u1');
    const { requestRunFromClient, settleRunRequest } = await import('@/lib/mcp/agent-delegation');
    void requestRunFromClient(args);
    await Promise.resolve();
    const requestId = [...(globalThis as unknown as { __mcpPendingRuns: Map<string, unknown> }).__mcpPendingRuns.keys()][0];

    expect(settleRunRequest(requestId, 'someone-else', { ok: true, taskId: 't9' })).toBe(false);
  });

  it('lets exactly one tab take a request, however many are listening', async () => {
    bus.listeners.add('u1');
    const { requestRunFromClient, claimRunRequest } = await import('@/lib/mcp/agent-delegation');
    void requestRunFromClient(args);
    await Promise.resolve();
    const requestId = [...(globalThis as unknown as { __mcpPendingRuns: Map<string, unknown> }).__mcpPendingRuns.keys()][0];

    // Three tabs race for the same request; two of them must do nothing.
    const outcomes = ['tab-a', 'tab-b', 'tab-c'].map(tab => claimRunRequest(requestId, 'u1', tab));

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a claim from another account, and an unknown request', async () => {
    bus.listeners.add('u1');
    const { requestRunFromClient, claimRunRequest } = await import('@/lib/mcp/agent-delegation');
    void requestRunFromClient(args);
    await Promise.resolve();
    const requestId = [...(globalThis as unknown as { __mcpPendingRuns: Map<string, unknown> }).__mcpPendingRuns.keys()][0];

    expect(claimRunRequest(requestId, 'someone-else', 'tab-a')).toBe(false);
    expect(claimRunRequest('no-such-request', 'u1', 'tab-a')).toBe(false);
    // And the real owner can still take it.
    expect(claimRunRequest(requestId, 'u1', 'tab-a')).toBe(true);
  });

  it('asks the tab to start a fresh conversation by default', async () => {
    bus.listeners.add('u1');
    const { requestRunFromClient } = await import('@/lib/mcp/agent-delegation');
    void requestRunFromClient(args);
    await Promise.resolve();

    expect(bus.emitted[0]).toMatchObject({ event: 'mcp_run_requested', data: { projectId: 'p1', prompt: 'go' } });
  });
});

describe('a tab that takes a request and is slow to start it', () => {
  const pendingId = () => [...(globalThis as unknown as { __mcpPendingRuns: Map<string, unknown> }).__mcpPendingRuns.keys()][0];

  it('is waited for: a task reported 45 s after the claim reaches the caller', async () => {
    vi.useFakeTimers();
    bus.listeners.add('u1');
    const { requestRunFromClient, claimRunRequest, settleRunRequest } = await import('@/lib/mcp/agent-delegation');
    const run = requestRunFromClient(args);
    await vi.advanceTimersByTimeAsync(1_000);
    const id = pendingId();
    expect(claimRunRequest(id, 'u1', 'tab-a')).toBe(true);
    // Pushing the project and taking a checkpoint come before the task exists.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(settleRunRequest(id, 'u1', { ok: true, taskId: 't-late' })).toBe(true);
    expect(await run).toMatchObject({ ok: true, taskId: 't-late' });
  });

  it('says nothing was started when no tab takes the request, and refuses a claim after that', async () => {
    vi.useFakeTimers();
    bus.listeners.add('u1');
    const { requestRunFromClient, claimRunRequest } = await import('@/lib/mcp/agent-delegation');
    const run = requestRunFromClient(args);
    await vi.advanceTimersByTimeAsync(0);
    const id = pendingId();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await run;
    // Refused, and nothing can start it afterwards: a tab that claims it now is turned away.
    expect(result.ok).toBe(false);
    expect(claimRunRequest(id, 'u1', 'tab-a')).toBe(false);
  });

  it('when a taken request never reports back, says the task may still start and where to look', async () => {
    vi.useFakeTimers();
    bus.listeners.add('u1');
    const { requestRunFromClient, claimRunRequest } = await import('@/lib/mcp/agent-delegation');
    const run = requestRunFromClient(args);
    await vi.advanceTimersByTimeAsync(0);
    const id = pendingId();
    claimRunRequest(id, 'u1', 'tab-a');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/agent_list/);
  });
});
