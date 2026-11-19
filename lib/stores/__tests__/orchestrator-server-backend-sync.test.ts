import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

const pullBackendFeatures = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: () => ({ pullBackendFeatures }) }));
vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: { createCheckpoint: vi.fn().mockResolvedValue({ id: 'cp1', description: '', timestamp: 0 }) },
}));
vi.mock('@/lib/inference/allowance-status', () => ({ checkAllowance: vi.fn(async () => 'unavailable') }));

setupOrchestratorMocks();

describe('starting a server run', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ taskId: 't1' }) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('brings the project\'s backend features in step before the server starts', async () => {
    const store = createTestStore();
    store.setState({ connectSSE: vi.fn() });
    await store.getState().startServerGeneration('p1', 'go', false);

    expect(pullBackendFeatures).toHaveBeenCalledWith('p1');
    expect(pullBackendFeatures.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it('still starts when that sync fails', async () => {
    pullBackendFeatures.mockRejectedValueOnce(new Error('down'));
    const store = createTestStore();
    store.setState({ connectSSE: vi.fn() });
    await store.getState().startServerGeneration('p1', 'go', false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
