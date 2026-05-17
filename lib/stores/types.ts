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
  result: 'completed' | 'failed' | null;
  paused: boolean;
  pausedMessage: string | null;
  orchestratorInstance: MultiAgentOrchestrator | null;
  persistedInstance: MultiAgentOrchestrator | null;
  serverTaskId?: string;
}
