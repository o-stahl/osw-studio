// lib/server-generate/server-orchestrator-runner.ts
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import { ServerConfigManager } from './server-config-manager';
import { runWithVFS } from './vfs-context';
import type { SSEEventBus } from './sse-event-bus';
import type { TaskManager } from './task-manager';
import type { ServerGenerationParams, ServerOrchestratorContext, StartGenerationRequest, BuildResult } from './types';
import { VirtualFileSystem } from '@/lib/vfs';
import type { VirtualFile } from '@/lib/vfs/types';

interface RunnerDeps {
  taskManager: TaskManager;
  eventBus: SSEEventBus;
  createVFS: (projectId: string) => Promise<VirtualFileSystem>;
  apiBaseUrl: string;
}

function trackVFSMutations(vfs: VirtualFileSystem, dirtyPaths: Set<string>): VirtualFileSystem {
  const origCreate = vfs.createFile.bind(vfs);
  const origUpdate = vfs.updateFile.bind(vfs);
  const origDelete = vfs.deleteFile.bind(vfs);
  const origRename = vfs.renameFile.bind(vfs);
  const origMove = vfs.moveFile.bind(vfs);
  const origDeleteDir = vfs.deleteDirectory.bind(vfs);
  const origCreateDir = vfs.createDirectory.bind(vfs);

  vfs.createFile = async (projectId, path, content, opts?) => {
    const result = await origCreate(projectId, path, content, opts);
    dirtyPaths.add(path);
    return result;
  };
  vfs.updateFile = async (projectId, path, content, opts?) => {
    const result = await origUpdate(projectId, path, content, opts);
    dirtyPaths.add(path);
    return result;
  };
  vfs.deleteFile = async (projectId, path, opts?) => {
    await origDelete(projectId, path, opts);
    dirtyPaths.add(path);
  };
  vfs.renameFile = async (projectId, oldPath, newPath) => {
    const result = await origRename(projectId, oldPath, newPath);
    dirtyPaths.add(oldPath);
    dirtyPaths.add(newPath);
    return result;
  };
  vfs.moveFile = async (projectId, oldPath, newPath) => {
    const result = await origMove(projectId, oldPath, newPath);
    dirtyPaths.add(oldPath);
    dirtyPaths.add(newPath);
    return result;
  };
  vfs.deleteDirectory = async (projectId, path) => {
    await origDeleteDir(projectId, path);
    dirtyPaths.add(path);
  };
  vfs.createDirectory = async (projectId, path) => {
    await origCreateDir(projectId, path);
    dirtyPaths.add(path);
  };

  return vfs;
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
  const dirtyPaths = new Set<string>();
  const serverVFS = trackVFSMutations(await createVFS(request.projectId), dirtyPaths);

  const serverContext: ServerOrchestratorContext = {
    apiBaseUrl,
    vfs: serverVFS,
    config: serverConfig as any,
    onEvent: (event, data) => {
      eventBus.emit(taskId, request.projectId, event, data, task.sessionId);
    },
    dirtyPaths,
  };

  const flushDirtyPaths = () => {
    if (dirtyPaths.size === 0) return;
    const paths = Array.from(dirtyPaths);
    dirtyPaths.clear();
    eventBus.emit(taskId, request.projectId, 'files_changed', { paths, taskId }, task.sessionId);
  };

  const progressCallback = (event: string, data?: unknown) => {
    const eventData = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    eventBus.emit(taskId, request.projectId, event, eventData, task.sessionId);

    if (event === 'tool_status' && eventData.status === 'completed') {
      flushDirtyPaths();
    }

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

      const result = await orchestrator.execute(request.prompt, request.executeOptions);

      flushDirtyPaths();

      const wasStopped = task.status === 'cancelled' || task.status === 'stopping' || task.status === 'paused';
      const session = serverConfig.getSessionCost();
      const finalResult = wasStopped ? 'stopped' : 'success';

      eventBus.emit(taskId, request.projectId, 'task_complete', {
        result: finalResult,
        tokens: session.totalPromptTokens + session.totalCompletionTokens,
        cost: session.totalCost,
      }, task.sessionId);

      taskManager.completeTask(taskId, wasStopped ? 'cancelled' : 'completed');
    } catch (error) {
      if (task.status === 'cancelled' || task.status === 'stopping' || task.status === 'paused') {
        flushDirtyPaths();
        const session = serverConfig.getSessionCost();
        eventBus.emit(taskId, request.projectId, 'task_complete', {
          result: 'stopped',
          tokens: session.totalPromptTokens + session.totalCompletionTokens,
          cost: session.totalCost,
        }, task.sessionId);
        taskManager.completeTask(taskId, 'cancelled');
        return;
      }

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

  const allEntries = await deps.createVFS(task.projectId).then((v) => v.getAllFilesAndDirectories(task.projectId));
  const manifest: Record<string, number> = {};
  for (const f of allEntries) {
    if ('id' in f) {
      const file = f as VirtualFile;
      manifest[file.path] = file.updatedAt ? new Date(file.updatedAt).getTime() : Date.now();
    }
  }

  eventBus.emit(taskId, task.projectId, 'build_requested', { taskId, fileManifest: manifest }, task.sessionId);

  let timeoutId: ReturnType<typeof setTimeout>;

  const result = await Promise.race<BuildResult>([
    new Promise<BuildResult>((resolve) => {
      task.pendingBuildResolve = (r: BuildResult) => {
        clearTimeout(timeoutId);
        resolve(r);
      };
    }),
    new Promise<BuildResult>((resolve) => {
      timeoutId = setTimeout(() => {
        task.pendingBuildResolve = null;
        task.buildDeferred = true;
        resolve({ success: true, errors: ['Build deferred — client disconnected'] });
      }, 30_000);
    }),
  ]);

  return result;
}
