import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: () => ({ pullProjectWithFiles: vi.fn(), pullBackendFeatures: vi.fn() }) }));
vi.mock('@/lib/vfs/save-manager', () => ({ saveManager: { runWithSuppressedDirty: (_id: string, fn: () => Promise<void>) => fn() } }));
vi.mock('@/lib/vfs/checkpoint', () => ({ checkpointManager: { createCheckpoint: vi.fn() } }));
vi.mock('@/lib/vfs/auto-sync', () => ({ localHasUnackedEdits: () => false, markSyncNeedsRetry: vi.fn() }));
const recordModelOutcome = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/suggestions/observed', async (orig) => ({ ...(await orig<object>()), recordModelOutcome }));

/**
 * A server-side run cannot write this browser's record of how models did, so the tab notes a stop
 * that is about the model as the event arrives; the next suggestion then passes that model over.
 */
describe('orchestrator slice — a server run stopping on a model', () => {
  let store: ReturnType<typeof createTestStore>;

  async function deliver(data: Record<string, unknown>) {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent('api_stopped', { sourceProjectId: 'p1', sourceTaskId: 't1', ...data });
  }

  beforeEach(() => {
    recordModelOutcome.mockClear();
    store = createTestStore();
    store.setState({ projectId: 'p1' });
  });

  it('records a refusal, a busy model and a missing one', async () => {
    await deliver({ provider: 'openrouter', model: 'gated:free', errorCategory: 'blocked' });
    await deliver({ provider: 'openrouter', model: 'busy:free', errorCategory: 'model_busy' });
    await deliver({ provider: 'openrouter', model: 'gone:free', errorCategory: 'model_not_found' });
    expect(recordModelOutcome.mock.calls).toEqual([
      ['openrouter', 'gated:free', 'refused'],
      ['openrouter', 'busy:free', 'busy'],
      ['openrouter', 'gone:free', 'unavailable'],
    ]);
  });

  it('records the model a server run on "Free models" moved past', async () => {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent('model_switched', {
      sourceProjectId: 'p1', sourceTaskId: 't1', provider: 'openrouter', fromModel: 'busy:free', toModel: 'next:free', reason: 'busy',
    });
    expect(recordModelOutcome).toHaveBeenCalledWith('openrouter', 'busy:free', 'busy');
  });

  it('records nothing for a stop about the key, or for OpenRouter\'s free router', async () => {
    await deliver({ provider: 'openrouter', model: 'm', errorCategory: 'auth_expired' });
    await deliver({ provider: 'openrouter', model: 'openrouter/free', errorCategory: 'model_busy' });
    expect(recordModelOutcome).not.toHaveBeenCalled();
  });
});
