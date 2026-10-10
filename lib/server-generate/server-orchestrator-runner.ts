// lib/server-generate/server-orchestrator-runner.ts
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import { ServerConfigManager } from './server-config-manager';
import { runWithVFS } from './vfs-context';
import type { SSEEventBus } from './sse-event-bus';
import type { TaskManager } from './task-manager';
import type { ServerGenerationParams, ServerOrchestratorContext, StartGenerationRequest, BuildResult, SearchDelegationResult, ImageDelegationResult, ServerWebSearchConfig } from './types';
import { VirtualFileSystem } from '@/lib/vfs';
import { randomUUID } from 'crypto';
import { addImageRequest, dropImageRequest } from './image-requests';
import { imageDelegationTimeoutMs } from '@/lib/llm/image-gen-timeout';
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
    config: serverConfig,
    onEvent: (event, data) => {
      eventBus.emit(taskId, request.projectId, event, data, task.sessionId);
    },
    dirtyPaths,
    onBuildRequested: () => awaitBuildResult(taskId, deps),
    onSearchRequested: (args) => awaitSearchResult(taskId, deps, args, request.webSearch),
    webSearchAvailable: request.webSearchAvailable,
    onImageRequested: (prompt, opts) => awaitImageResult(taskId, deps, prompt, opts),
    imageGenAvailable: request.imageGenAvailable,
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
    }

    // A gated command with no standing allow pauses the run (awaiting_user). Record what needs
    // approval so the client can show a persisted Allow/Deny prompt after the user returns; the
    // event above already reached the client live for the in-session case.
    if (event === 'approval_required') {
      task.pendingApproval = {
        gateKey: String(eventData.gateKey ?? ''),
        command: String(eventData.command ?? ''),
      };
      void taskManager.updateTask(task).catch(() => { /* best-effort persist */ });
    }
  };

  await runWithVFS(serverVFS, async () => {
    const orchestrator = new MultiAgentOrchestrator(
      request.projectId,
      'orchestrator',
      progressCallback,
      {
        model: request.model,
        serverContext,
        permissionMode: request.permissionMode,
        permissionOverrides: request.permissionOverrides,
        // No auto-deny: the presence of serverContext makes the orchestrator pause gated
        // commands (awaiting_user) instead, surfacing an Allow/Deny prompt to the client.
      },
    );

    task.orchestrator = orchestrator;

    try {
      if (request.conversationHistory?.length) {
        orchestrator.importConversation(request.conversationHistory as any[]);
      }

      const result = await orchestrator.execute(request.prompt, request.executeOptions);

      flushDirtyPaths();

      const wasStopped = task.status === 'cancelled' || task.status === 'stopping' || task.status === 'paused'
        || result.exitReason === 'stopped' || result.exitReason === 'error_stop';
      const session = serverConfig.getSessionCost();
      const finalResult = wasStopped ? 'stopped' : (result.success ? 'success' : 'failed');

      eventBus.emit(taskId, request.projectId, 'task_complete', {
        result: finalResult,
        // exitReason lets the client tell a genuine finish from a pause (awaiting_user, e.g. a
        // gated command awaiting approval) so it doesn't celebrate a run that is actually waiting.
        exitReason: result.exitReason,
        ...(finalResult === 'failed' ? { error: result.summary } : {}),
        tokens: session.totalPromptTokens + session.totalCompletionTokens,
        cost: session.totalCost,
      }, task.sessionId);

      await taskManager.completeTask(taskId, wasStopped ? 'cancelled' : (result.success ? 'completed' : 'failed'));
    } catch (error) {
      if (task.status === 'cancelled' || task.status === 'stopping' || task.status === 'paused') {
        flushDirtyPaths();
        const session = serverConfig.getSessionCost();
        eventBus.emit(taskId, request.projectId, 'task_complete', {
          result: 'stopped',
          tokens: session.totalPromptTokens + session.totalCompletionTokens,
          cost: session.totalCost,
        }, task.sessionId);
        await taskManager.completeTask(taskId, 'cancelled');
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

      await taskManager.completeTask(taskId, 'failed');
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

/**
 * Delegate an image generation to the connected browser, which holds the image model's key: emits
 * `image_requested`, and the client generates and POSTs the image back. Image models can take a
 * while, so the wait is long; with no browser answering, the agent is told to continue without it.
 */
export async function awaitImageResult(
  taskId: string,
  deps: RunnerDeps,
  prompt: string,
  opts: { aspectRatio?: string; imageSize?: string },
): Promise<ImageDelegationResult> {
  const { taskManager, eventBus } = deps;
  const task = taskManager.getTask(taskId);
  if (!task) return { error: 'task not found' };

  const requestId = randomUUID();
  let timeoutId: ReturnType<typeof setTimeout>;
  const answered = new Promise<ImageDelegationResult>((resolve) => {
    addImageRequest(task, requestId, (r) => {
      clearTimeout(timeoutId);
      resolve(r);
    });
  });
  eventBus.emit(taskId, task.projectId, 'image_requested', { taskId, requestId, prompt, ...opts }, task.sessionId);

  return Promise.race<ImageDelegationResult>([
    answered,
    new Promise<ImageDelegationResult>((resolve) => {
      timeoutId = setTimeout(() => {
        dropImageRequest(task, requestId);
        resolve({ error: 'no connected browser answered the image request. Continue without it.' });
      }, imageDelegationTimeoutMs());
    }),
  ]);
}

/**
 * Delegate a web search to the connected browser (its configured provider/key run it). Emits
 * `search_requested`; the client runs the `search` command and POSTs the result back. On a
 * disconnect timeout, returns a graceful error so the agent continues without it. (Piece B2 will
 * replace this fallback with a native server-side search when no browser is connected.)
 */
export async function awaitSearchResult(
  taskId: string,
  deps: RunnerDeps,
  args: string[],
  webSearch?: ServerWebSearchConfig,
): Promise<SearchDelegationResult> {
  const { taskManager, eventBus } = deps;
  const task = taskManager.getTask(taskId);
  if (!task) return { stdout: '', stderr: 'search: task not found', exitCode: 1 };

  eventBus.emit(taskId, task.projectId, 'search_requested', { taskId, args }, task.sessionId);

  let timeoutId: ReturnType<typeof setTimeout>;

  const result = await Promise.race<SearchDelegationResult>([
    new Promise<SearchDelegationResult>((resolve) => {
      task.pendingSearchResolve = (r: SearchDelegationResult) => {
        clearTimeout(timeoutId);
        resolve(r);
      };
    }),
    new Promise<SearchDelegationResult>((resolve) => {
      timeoutId = setTimeout(async () => {
        task.pendingSearchResolve = null;
        // No browser answered (headless/disconnected). Fall back to a server-side search when the
        // client supplied provider config; otherwise tell the agent to continue without it.
        if (webSearch) {
          const { runServerSideSearch } = await import('./server-side-search');
          resolve(await runServerSideSearch(args, webSearch));
        } else {
          resolve({
            stdout: '',
            stderr: 'search: no connected browser to run the search and no server-side provider configured. Continue without it.',
            exitCode: 1,
          });
        }
      }, 30_000);
    }),
  ]);

  return result;
}
