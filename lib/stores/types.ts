import type { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';

export interface DebugEvent {
  id: string;
  timestamp: number;
  event: string;
  data: any;
  count: number;
  version: number;
}

export interface GenerationTask {
  projectId: string;
  projectName: string;
  prompt: string;
  model: string;
  startedAt: number;
  // 'unavailable' = a server task the client can no longer reattach to (expired from both the
  // in-memory manager and the durable store); its outcome is unknown, not a success or failure.
  result: 'completed' | 'failed' | 'unavailable' | null;
  paused: boolean;
  orchestratorInstance: MultiAgentOrchestrator | null;
  persistedInstance: MultiAgentOrchestrator | null;
  serverTaskId?: string;
}
