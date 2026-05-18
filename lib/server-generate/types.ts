// lib/server-generate/types.ts
import type { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import type { VirtualFileSystem } from '@/lib/vfs';
import type { ProviderId } from '@/lib/llm/providers/types';

/** Passed to MultiAgentOrchestrator when running server-side */
export interface ServerOrchestratorContext {
  apiBaseUrl: string;
  vfs: VirtualFileSystem;
  config: ServerGenerationParams;
  onEvent: (event: string, data: Record<string, unknown>) => void;
  /** Paths mutated since last flush — populated by VFS mutation proxy */
  dirtyPaths: Set<string>;
}

/** All config the server needs from the client to run generation */
export interface ServerGenerationParams {
  provider: ProviderId;
  model: string;
  apiKey: string;
  providerBaseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEnabled?: boolean;
  compactionEnabled?: boolean;
  compactionLimit?: number;
  debugStreamEnabled?: boolean;
  modelPricing?: Record<string, { prompt: number; completion: number }>;
  cachedModels?: Array<{ id: string; name: string; context_length?: number }>;
}

/** Server-side task state */
export interface ServerTask {
  taskId: string;
  projectId: string;
  sessionId: string;
  workspaceId?: string;
  status: 'running' | 'paused' | 'stopping' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  orchestrator: MultiAgentOrchestrator | null;
  buildDeferred: boolean;
  /** Resolve function for pending build delegation */
  pendingBuildResolve: ((result: BuildResult) => void) | null;
  /** Metadata for client display (shelf) */
  prompt?: string;
  model?: string;
  projectName?: string;
}

export interface BuildResult {
  success: boolean;
  errors?: string[];
}

/** SSE event envelope */
export interface SSEEvent {
  id: number;
  event: string;
  data: Record<string, unknown> & { sourceProjectId: string };
  buffered: boolean; // false for delta events (not stored in replay buffer)
}

/** Start generation request body */
export interface StartGenerationRequest {
  projectId: string;
  prompt: string;
  model: string;
  apiKey: string;
  workspaceId?: string;
  projectName?: string;
  providerConfig?: { baseUrl?: string; provider?: ProviderId };
  conversationHistory: unknown[];
  executeOptions?: {
    images?: Array<{ data: string; mediaType: string }>;
    focusContext?: { domPath: string; snippet: string };
    semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
    displayPrompt?: string;
  };
  generationParams: Omit<ServerGenerationParams, 'provider' | 'model' | 'apiKey' | 'providerBaseUrl'>;
}

/** Batch file fetch request */
export interface FileFetchRequest {
  taskId: string;
  paths: string[];
}

/** Batch file fetch response item */
export interface FileFetchResponseItem {
  path: string;
  content: string;
  binary: boolean;
}
