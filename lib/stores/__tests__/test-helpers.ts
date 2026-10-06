import { vi } from 'vitest';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import { createStore } from 'zustand/vanilla';
import { createOrchestratorSlice, OrchestratorSlice } from '../slices/orchestrator';
import { createProjectSlice, ProjectSlice } from '../slices/project';

type TestStoreState = OrchestratorSlice & ProjectSlice;

export function createTestStore() {
  return createStore<TestStoreState>()((...a) => ({
    ...createOrchestratorSlice(...a),
    ...createProjectSlice(...a),
  }));
}

export function setupOrchestratorMocks() {
  // The app registers the provider's translator through TranslatorBridge; store tests have no
  // provider, so they register the real English catalogue. Without it a toast receives its key
  // path, and an assertion like `not.toHaveBeenCalledWith('Task completed')` passes vacuously.
  registerEnglishTranslator();

  vi.mock('@/lib/llm/models/project-assignment', () => ({
    getProjectAssignment: vi.fn().mockResolvedValue({
      agent: { provider: 'openai', model: 'gpt-4' },
      imageGen: null,
      voiceInput: null,
      autoCompact: false,
      compactLimit: null,
    }),
  }));
  vi.mock('@/lib/config/storage', () => ({
    configManager: {
      getSelectedProvider: () => 'openai',
      getApiKey: () => 'sk-test',
      getDefaultModel: () => 'gpt-4',
      getProviderModel: () => 'gpt-4',
      getProviderApiKey: vi.fn(() => 'sk-test'),
      getCachedModels: () => null,
      getReasoningEnabled: () => false,
      isCompactionEnabled: () => false,
      getCompactionLimit: () => null,
      getLocalContextLength: vi.fn(() => undefined),
      getDebugStreamEnabled: () => false,
      getPermissionMode: () => 'auto',
      getPermissionOverrides: () => ({}),
      isWebSearchConfigured: () => false,
      getWebSearchProvider: () => null,
      getWebSearchKey: () => null,
      getSearxngUrl: () => null,
      getActiveAssignment: vi.fn(() => ({
        agent: { provider: 'openai', model: 'gpt-4' },
        imageGen: null,
        voiceInput: null,
        autoCompact: false,
        compactLimit: null,
      })),
      setActiveAssignment: vi.fn(),
    },
    migrateBackendKey: () => false,
  }));
  vi.mock('@/lib/llm/providers/registry', () => ({
    getProvider: vi.fn(() => ({ name: 'OpenAI', apiKeyRequired: true, isLocal: false, usesOAuth: false })),
    modelSupportsVision: () => false,
  }));
  vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
  vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), isTelemetryActive: vi.fn(() => true) }));
  vi.mock('@/lib/llm/debug-events-state', () => ({
    debugEventsState: { saveEvents: vi.fn(), clearEvents: vi.fn(), loadEvents: vi.fn().mockResolvedValue([]) },
  }));
  vi.mock('@/lib/vfs', () => ({ vfs: { hasServerContext: () => false, refreshServerContext: vi.fn() } }));
  vi.mock('@/lib/preview/runtime-errors', () => ({
    drainRuntimeErrors: () => [],
    peekRuntimeErrors: () => [],
    formatRuntimeErrors: () => '',
    resetRuntimeErrors: vi.fn(),
  }));
  vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
  vi.mock('@/lib/server-generate/sse-client', () => ({
    SSEClient: vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: () => false,
    })),
  }));
  vi.mock('@/lib/server-generate/file-sync-handler', () => ({
    handleFilesChanged: vi.fn().mockResolvedValue(undefined),
    cancelPendingFileSync: vi.fn(),
  }));
  vi.mock('@/lib/server-generate/build-delegation-handler', () => ({
    handleBuildRequested: vi.fn().mockResolvedValue(undefined),
  }));
  vi.mock('@/lib/utils/task-complete-sound', () => ({
    playTaskCompleteSound: vi.fn(),
    playTaskCompleteSoundSubtle: vi.fn(),
  }));
}
