import type { PendingImageRequest } from './image-requests';
// lib/server-generate/types.ts
import type { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import type { VirtualFileSystem } from '@/lib/vfs';
import type { ProviderId } from '@/lib/llm/providers/types';
import type { WebSearchProviderId } from '@/lib/web-search/types';

/** Web-search config the client sends so the server can run a search when no browser is
 *  connected (the headless fallback). Carries the provider key, same boundary as the LLM key. */
export interface ServerWebSearchConfig {
  provider: WebSearchProviderId;
  key?: string;
  searxngUrl?: string;
}

/** Passed to MultiAgentOrchestrator when running server-side */
export interface ServerOrchestratorContext {
  apiBaseUrl: string;
  vfs: VirtualFileSystem;
  config: ServerGenerationParams;
  onEvent: (event: string, data: Record<string, unknown>) => void;
  /** Paths mutated since last flush — populated by VFS mutation proxy */
  dirtyPaths: Set<string>;
  /** Delegate a build to the connected browser session. */
  onBuildRequested?: () => Promise<BuildResult>;
  /** Delegate a web search to the connected browser session (its provider/key run it). */
  onSearchRequested?: (args: string[]) => Promise<SearchDelegationResult>;
  /** Client has a web-search provider configured — drives whether `search` is advertised. */
  webSearchAvailable?: boolean;
  /** Delegate an image generation to the connected browser (its image model and key run it). */
  onImageRequested?: (prompt: string, opts: { aspectRatio?: string; imageSize?: string }) => Promise<ImageDelegationResult>;
  /** Client has an image-capable model assigned — drives whether `generate-image` is advertised. */
  imageGenAvailable?: boolean;
}

/** Result of a browser-delegated image generation: the image, or why there is none. */
export type ImageDelegationResult = { base64: string; mimeType: string } | { error: string };

/** Result of a browser-delegated search: the `search` command's own stdout/stderr/exit. */
export interface SearchDelegationResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
  /** Context length a local provider is loaded with (see lib/llm/local-context.ts). */
  localContextLength?: number;
  debugStreamEnabled?: boolean;
  modelPricing?: Record<string, { prompt: number; completion: number }>;
  cachedModels?: Array<{ id: string; name: string; context_length?: number }>;
  /**
   * For "Free models": the free models the browser ranks best, in order, minus those cooling down.
   * The run stays on the first and moves down the list only when one is busy, gone or refuses.
   * The ranking lives in the browser, so without this a server run sends OpenRouter's free router,
   * which picks a different model on every request.
   */
  freeModelCandidates?: string[];
}

/** Server-side task state */
export interface ServerTask {
  taskId: string;
  projectId: string;
  sessionId: string;
  workspaceId?: string;
  status: 'running' | 'paused' | 'stopping' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  /** Last status-change time. Drives retention/prune so terminal tasks expire on a terminal clock. */
  updatedAt: number;
  orchestrator: MultiAgentOrchestrator | null;
  buildDeferred: boolean;
  /** Resolve function for pending build delegation */
  pendingBuildResolve: ((result: BuildResult) => void) | null;
  /** Resolve function for a pending browser-delegated search */
  pendingSearchResolve?: ((result: SearchDelegationResult) => void) | null;
  /** Browser-delegated image generations in flight, by request id (`lib/server-generate/image-requests.ts`). */
  pendingImages?: Map<string, PendingImageRequest>;
  /** Set when the run paused on a gated command awaiting the user's Allow/Deny. Persisted so it
   *  survives the user leaving/returning and a process restart. Cleared on task restart. */
  pendingApproval?: { gateKey: string; command: string } | null;
  /** Metadata for client display (shelf) */
  prompt?: string;
  model?: string;
  projectName?: string;
  /** Present when a process restart interrupted an in-flight generation. */
  failureReason?: string;
}

/** Serializable task state. API keys and live orchestrators are never persisted. */
export type PersistedServerTask = Pick<
  ServerTask,
  'taskId' | 'projectId' | 'sessionId' | 'workspaceId' | 'status' | 'startedAt' | 'updatedAt' | 'buildDeferred'
  | 'prompt' | 'model' | 'projectName' | 'failureReason' | 'pendingApproval'
>;

export interface BuildResult {
  success: boolean;
  errors?: string[];
}

/** SSE event envelope */
export interface SSEEvent {
  id: number;
  event: string;
  data: Record<string, unknown> & { sourceProjectId: string; sourceTaskId?: string };
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
  permissionMode?: 'auto' | 'ask' | 'custom';
  permissionOverrides?: Record<string, 'ask' | 'allow'>;
  /** Whether the client has a web-search provider configured. The server advertises the `search`
   *  command based on this (the search itself is delegated back to the browser to run). */
  webSearchAvailable?: boolean;
  /** Provider + key for the server-side search fallback (used only when no browser is connected). */
  webSearch?: ServerWebSearchConfig;
  /** Whether the project has an image-capable model. Generation is delegated back to the browser. */
  imageGenAvailable?: boolean;
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
