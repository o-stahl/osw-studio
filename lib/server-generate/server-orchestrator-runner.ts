// lib/server-generate/server-orchestrator-runner.ts
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import { ServerConfigManager } from './server-config-manager';
import { runWithVFS } from './vfs-context';
import type { SSEEventBus } from './sse-event-bus';
import type { TaskManager } from './task-manager';
import type { ServerGenerationParams, ServerOrchestratorContext, StartGenerationRequest, BuildResult } from './types';
import { VirtualFileSystem } from '@/lib/vfs';

interface RunnerDeps {
  taskManager: TaskManager;
  eventBus: SSEEventBus;
  createVFS: (projectId: string) => Promise<VirtualFileSystem>;
  apiBaseUrl: string;
}

export async function runServerGeneration(
  taskId: string,
  request: StartGenerationRequest,
  deps: RunnerDeps,
): Promise<void> {
  const { taskManager, eventBus, createVFS, apiBaseUrl } = deps;
  const task = taskManager.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const params: ServerGenerationParams = {
    provider: request.providerConfig?.provider ?? 'openai',
    model: request.model,
    apiKey: request.apiKey,
    providerBaseUrl: request.providerConfig?.baseUrl,
    ...request.generationParams,
  };

  const serverConfig = new ServerConfigManager(params, taskId);
  const serverVFS = await createVFS(request.projectId);

  const serverContext: ServerOrchestratorContext = {
    apiBaseUrl,
    vfs: serverVFS,
    config: serverConfig as any,
    onEvent: (event, data) => {
      eventBus.emit(taskId, request.projectId, event, data, task.sessionId);
    },
  };

  const progressCallback = (event: string, data?: unknown) => {
    const eventData = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    eventBus.emit(taskId, request.projectId, event, eventData, task.sessionId);

    if (event === 'usage' && eventData.cost != null) {
      serverConfig.updateSessionCost(
        { promptTokens: (eventData as any).promptTokens, completionTokens: (eventData as any).completionTokens },
        eventData.cost as number,
      );
      eventBus.emit(taskId, request.projectId, 'usage_update', {
        promptTokens: (eventData as any).promptTokens,
        completionTokens: (eventData as any).completionTokens,
        cost: eventData.cost,
      }, task.sessionId);
    }
  };

  await runWithVFS(serverVFS, async () => {
    const orchestrator = new MultiAgentOrchestrator(
      request.projectId,
      'orchestrator',
      progressCallback,
      { model: request.model, serverContext },
    );

    task.orchestrator = orchestrator;

    try {
      if (request.conversationHistory?.length) {
        orchestrator.importConversation(request.conversationHistory as any[]);
      }

      const result = await orchestrator.execute(request.prompt);

      const session = serverConfig.getSessionCost();
      eventBus.emit(taskId, request.projectId, 'task_complete', {
        result: 'success',
        tokens: session.totalPromptTokens + session.totalCompletionTokens,
        cost: session.totalCost,
      }, task.sessionId);

      taskManager.completeTask(taskId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventBus.emit(taskId, request.projectId, 'error', { message, fatal: true }, task.sessionId);

      const session = serverConfig.getSessionCost();
      eventBus.emit(taskId, request.projectId, 'task_complete', {
        result: 'failed',
        tokens: session.totalPromptTokens + session.totalCompletionTokens,
        cost: session.totalCost,
        error: message,
      }, task.sessionId);

      taskManager.completeTask(taskId, 'failed');
    }
  });
}

export async function awaitBuildResult(taskId: string, deps: RunnerDeps): Promise<BuildResult> {
  const { taskManager, eventBus } = deps;
  const task = taskManager.getTask(taskId);
  if (!task) return { success: false, errors: ['Task not found'] };

  const files = await deps.createVFS(task.projectId).then((v) => v.getAllFilesAndDirectories(task.projectId));
  const manifest: Record<string, number> = {};
  for (const f of files.filter((f: any) => f.type === 'file')) {
    manifest[(f as any).path] = (f as any).updatedAt ?? Date.now();
  }

  eventBus.emit(taskId, task.projectId, 'build_requested', { taskId, fileManifest: manifest }, task.sessionId);

  const result = await Promise.race<BuildResult>([
    new Promise<BuildResult>((resolve) => {
      task.pendingBuildResolve = resolve;
    }),
    new Promise<BuildResult>((resolve) => {
      setTimeout(() => {
        task.pendingBuildResolve = null;
        task.buildDeferred = true;
        resolve({ success: true, errors: ['Build deferred — client disconnected'] });
      }, 30_000);
    }),
  ]);

  return result;
}
