import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { toast } from 'sonner';
import { setRuntimeTranslator, type RuntimeTranslator } from '@/lib/i18n/runtime';

const mockExecute = vi.fn();
vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
    stop: vi.fn(),
    importConversation: vi.fn(),
  })),
}));

setupOrchestratorMocks();

/**
 * Store toasts speak through `lib/i18n/runtime`, not hard-coded English.
 *
 * The other store tests register the English catalogue and assert English, which would also pass
 * if a toast went back to a literal. Here the registered translator marks what it returns, so only
 * text that actually went through it can match.
 */
describe('orchestrator toasts of a client-side run (prompt, completion, failure)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeTranslator(((key: string) => `«${key}»`) as unknown as RuntimeTranslator);
  });

  it('asks for a prompt in the registered language', async () => {
    const store = createTestStore();
    await store.getState().startGeneration('   ');
    expect(toast.error).toHaveBeenCalledWith('«orchestrator.noPrompt»');
  });

  it('announces a completed task in the registered language', async () => {
    mockExecute.mockResolvedValue({ success: true, summary: 'done', totalCost: 0, toolCount: 0, turnCount: 0, apiErrorCount: 0 });
    const store = createTestStore();
    await store.getState().startGeneration('build something');
    expect(toast.success).toHaveBeenCalledWith('«orchestrator.taskCompleted»');
  });

  it('reports a failure with no summary in the registered language', async () => {
    mockExecute.mockResolvedValue({ success: false, summary: '', totalCost: 0, toolCount: 0, turnCount: 0, apiErrorCount: 0 });
    const store = createTestStore();
    await store.getState().startGeneration('build something');
    expect(toast.error).toHaveBeenCalledWith('«orchestrator.generationFailed»', expect.anything());
  });

  it('reports a thrown failure with no message in the registered language', async () => {
    mockExecute.mockRejectedValue('not an Error');
    const store = createTestStore();
    await store.getState().startGeneration('build something');
    expect(toast.error).toHaveBeenCalledWith('«orchestrator.generationFailed»', expect.anything());
  });
});
