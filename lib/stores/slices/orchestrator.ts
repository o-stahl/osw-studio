import { StateCreator } from 'zustand';
import type { DebugEvent, GenerationTask } from '../types';
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import type { PendingImage } from '@/lib/llm/multi-agent-orchestrator';
import { configManager } from '@/lib/config/storage';
import { getProvider } from '@/lib/llm/providers/registry';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';
import { vfs } from '@/lib/vfs';
import type { ProjectRuntime } from '@/lib/vfs/types';
import { debugEventsState } from '@/lib/llm/debug-events-state';
import { drainRuntimeErrors } from '@/lib/preview/runtime-errors';
import { logger } from '@/lib/utils';
import { SSEClient } from '@/lib/server-generate/sse-client';
import { handleFilesChanged, cancelPendingFileSync } from '@/lib/server-generate/file-sync-handler';
import { handleBuildRequested } from '@/lib/server-generate/build-delegation-handler';
import { playTaskCompleteSound, playTaskCompleteSoundSubtle } from '@/lib/utils/task-complete-sound';

const MAX_DEBUG_EVENTS = 2000;
let debugIdCounter = 0;

const persistProjectIds = new Map<string, string>();
const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Batched delta flushing — accumulates coalesced deltas and flushes once per animation frame
let pendingDeltaFlush: number | null = null;
const pendingDeltas = new Map<string, { eventId: string; fragments: any[] }>();

// When the user views a different project while generation runs, events accumulate
// here instead of in the store's debugEvents (which shows the viewed project's history).
const backgroundEventsMap = new Map<string, DebugEvent[]>();

function isServerMode(): boolean {
  if (typeof window === 'undefined') return false;
  return process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
}

function debouncedSave(projectId: string, events: DebugEvent[]) {
  if (!persistProjectIds.has(projectId)) return;
  const existing = saveDebounceTimers.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    Promise.resolve(debugEventsState.saveEvents(projectId, events)).catch(error => {
      logger.error('Failed to persist debug events:', error);
    });
  }, 500);
  saveDebounceTimers.set(projectId, timer);
}

function flushSave(projectId: string, events: DebugEvent[]) {
  const existing = saveDebounceTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    saveDebounceTimers.delete(projectId);
  }
  Promise.resolve(debugEventsState.saveEvents(projectId, events)).catch(error => {
    logger.error('Failed to flush debug events:', error);
  });
}

function deriveScalarFields(tasks: Map<string, GenerationTask>, viewedProjectId: string) {
  const viewedTask = tasks.get(viewedProjectId);
  return {
    generating: viewedTask?.result === null ? true : false,
  };
}

interface StartGenerationOptions {
  chatMode?: boolean;
  projectId: string;
  focusContext?: any;
  placedBlocks?: any[];
  isTourLockingInput?: boolean;
  displayPrompt?: string;
}

export interface OrchestratorSlice {
  generationTasks: Map<string, GenerationTask>;
  debugEvents: DebugEvent[];
  currentModel: string;
  projectCost: number;
  sseClient: SSEClient | null;

  generating: boolean;

  isProjectGenerating: (projectId: string) => boolean;
  isAnyGenerating: () => boolean;

  // Event methods
  addDebugEvent: (event: string, data: any, sourceProjectId?: string) => void;
  clearDebugEvents: () => void;
  getGenerationEvents: (projectId?: string) => DebugEvent[];

  // Generation lifecycle
  startGeneration: (message: string, images?: PendingImage[], options?: StartGenerationOptions) => Promise<void>;
  stopGeneration: (projectId?: string) => void | Promise<void>;
  connectSSE: () => void;
  disconnectSSE: () => void;
  startServerGeneration: (projectId: string, prompt: string, chatMode: boolean, images?: PendingImage[], options?: StartGenerationOptions) => Promise<void>;
  continueGeneration: () => void;
  resetOrchestrator: () => void;

  // Settings
  setCurrentModel: (model: string) => void;
  setProjectCost: (cost: number) => void;

  // Persistence
  stashForegroundEvents: (projectId: string) => void;
  loadDebugEvents: (projectId: string) => Promise<void>;
  clearChat: (projectId: string) => Promise<void>;
  initPersistence: (projectId: string) => void;
  cleanupPersistence: () => void;
  dismissGenerationResult: (projectId?: string) => void;
  reattachServerTasks: () => Promise<void>;
}

type CombinedState = OrchestratorSlice & {
  projectId: string;
  projectName: string;
  markDirty: () => void;
  bumpRefreshTrigger: () => void;
  updateProjectSettings: (settings: { runtime?: ProjectRuntime }) => void;
};

export const createOrchestratorSlice: StateCreator<CombinedState, [], [], OrchestratorSlice> = (set, get) => ({
  generationTasks: new Map<string, GenerationTask>(),
  debugEvents: [],
  currentModel: '',
  projectCost: 0,
  sseClient: null,
  generating: false,

  isProjectGenerating: (projectId: string) => {
    const task = get().generationTasks.get(projectId);
    return task?.result === null ? true : false;
  },

  isAnyGenerating: () => {
    for (const task of get().generationTasks.values()) {
      if (task.result === null) return true;
    }
    return false;
  },

  addDebugEvent: (event: string, data: any, sourceProjectId?: string) => {
    const { projectId } = get();
    const source = sourceProjectId ?? projectId;
    const isBackground = source !== projectId;
    const shouldCoalesce = event === 'assistant_delta' || event === 'tool_param_delta' || event === 'reasoning_delta';

    const debugEvent: DebugEvent = {
      id: `${Date.now()}-${debugIdCounter++}`,
      timestamp: Date.now(),
      event,
      data,
      count: 1,
      version: 1,
    };

    if (isBackground) {
      let buffer = backgroundEventsMap.get(source) ?? [];
      if (shouldCoalesce && buffer.length > 0) {
        const searchLimit = Math.max(0, buffer.length - 4);
        for (let i = buffer.length - 1; i >= searchLimit; i--) {
          if (buffer[i].event === event) {
            const target = buffer[i];
            const all = target.data.all ?? [target.data];
            all.push(data);
            buffer[i] = {
              ...target,
              timestamp: Date.now(),
              version: target.version + 1,
              count: target.count + 1,
              data: { all },
            };
            backgroundEventsMap.set(source, buffer);
            debouncedSave(source, buffer);
            return;
          }
        }
      }
      buffer.push(debugEvent);
      if (buffer.length > MAX_DEBUG_EVENTS) {
        buffer = buffer.slice(-MAX_DEBUG_EVENTS);
      }
      backgroundEventsMap.set(source, buffer);
      debouncedSave(source, buffer);
      return;
    }

    // For delta events in the foreground, batch updates to avoid per-chunk React re-renders
    if (shouldCoalesce) {
      // Find the target event id to coalesce into
      const prev = get().debugEvents;
      let targetId: string | null = null;
      const searchLimit = Math.max(0, prev.length - 4);
      for (let i = prev.length - 1; i >= searchLimit; i--) {
        if (prev[i].event === event) {
          targetId = prev[i].id;
          break;
        }
      }

      if (targetId) {
        // Accumulate in the pending buffer — no Zustand set() yet
        let pending = pendingDeltas.get(targetId);
        if (!pending) {
          pending = { eventId: targetId, fragments: [] };
          pendingDeltas.set(targetId, pending);
        }
        pending.fragments.push(data);
      } else {
        // First delta of its kind — add the event, then future deltas coalesce into it
        set(state => {
          let newEvents = [...state.debugEvents, debugEvent];
          if (newEvents.length > MAX_DEBUG_EVENTS) newEvents = newEvents.slice(-MAX_DEBUG_EVENTS);
          return { debugEvents: newEvents };
        });
      }

      // Flush pending deltas into Zustand state
      const flushPendingDeltas = () => {
        if (pendingDeltas.size === 0) return;
        set(state => {
          const events = [...state.debugEvents];
          for (const [eventId, pending] of pendingDeltas) {
            let idx = -1;
            for (let i = events.length - 1; i >= Math.max(0, events.length - 10); i--) {
              if (events[i].id === eventId) { idx = i; break; }
            }
            if (idx === -1) continue;
            const target = events[idx];
            const existingAll = target.data.all ?? [target.data];
            const all = [...existingAll, ...pending.fragments];
            events[idx] = {
              ...target,
              timestamp: Date.now(),
              version: target.version + pending.fragments.length,
              count: target.count + pending.fragments.length,
              data: { all },
            };
          }
          pendingDeltas.clear();
          return { debugEvents: events };
        });
        debouncedSave(source, get().debugEvents);
      };

      if (typeof requestAnimationFrame !== 'undefined') {
        if (pendingDeltaFlush === null) {
          pendingDeltaFlush = requestAnimationFrame(() => {
            pendingDeltaFlush = null;
            flushPendingDeltas();
          });
        }
      } else {
        flushPendingDeltas();
      }
      return;
    }

    // Non-delta events: flush any pending deltas first, then add the new event
    if (pendingDeltas.size > 0) {
      if (pendingDeltaFlush !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(pendingDeltaFlush);
        pendingDeltaFlush = null;
      }
      // Inline flush
      set(state => {
        const events = [...state.debugEvents];
        for (const [eventId, pending] of pendingDeltas) {
          let idx = -1;
          for (let i = events.length - 1; i >= Math.max(0, events.length - 10); i--) {
            if (events[i].id === eventId) { idx = i; break; }
          }
          if (idx === -1) continue;
          const target = events[idx];
          const existingAll = target.data.all ?? [target.data];
          const all = [...existingAll, ...pending.fragments];
          events[idx] = {
            ...target,
            timestamp: Date.now(),
            version: target.version + pending.fragments.length,
            count: target.count + pending.fragments.length,
            data: { all },
          };
        }
        pendingDeltas.clear();
        return { debugEvents: events };
      });
    }

    set(state => {
      let newEvents = [...state.debugEvents, debugEvent];
      if (newEvents.length > MAX_DEBUG_EVENTS) {
        newEvents = newEvents.slice(-MAX_DEBUG_EVENTS);
      }
      return { debugEvents: newEvents };
    });
    debouncedSave(source, get().debugEvents);
  },

  clearDebugEvents: () => {
    set({ debugEvents: [] });
  },

  getGenerationEvents: (projectId?: string) => {
    const target = projectId ?? get().projectId;
    const viewedProjectId = get().projectId;
    const buffer = backgroundEventsMap.get(target);
    if (target !== viewedProjectId && buffer && buffer.length > 0) {
      return buffer;
    }
    return get().debugEvents;
  },

  startGeneration: async (message: string, images?: PendingImage[], options?: StartGenerationOptions) => {
    if (options?.isTourLockingInput) return;

    const projectId = options?.projectId || '';

    if (isServerMode()) {
      return get().startServerGeneration(projectId, message.trim(), !!options?.chatMode, images, options);
    }

    // Guard on per-project generation, not global
    if (get().isProjectGenerating(projectId)) return;

    drainRuntimeErrors();

    const trimmedPrompt = message.trim();
    if (!trimmedPrompt && (!images || images.length === 0)) {
      toast.error('Please enter a prompt');
      return;
    }

    const currentProvider = configManager.getSelectedProvider();
    const providerConfig = getProvider(currentProvider);
    const apiKey = configManager.getApiKey();

    if (providerConfig.apiKeyRequired && !apiKey) {
      toast.error(`Please set your ${providerConfig.name} API key in settings`);
      return;
    }

    if (providerConfig.isLocal) {
      const localModel = configManager.getProviderModel(currentProvider);
      if (!localModel) {
        toast.error(`No model selected for ${providerConfig.name}. Please select a model in settings.`);
        return;
      }
    }

    const chatMode = options?.chatMode ?? false;
    let modelToUse = configManager.getProviderModel(currentProvider) || configManager.getDefaultModel();
    if (typeof window !== 'undefined') {
      const useSeparateChatModel = localStorage.getItem(`osw-studio-use-separate-chat-model-${currentProvider}`) === 'true';
      if (useSeparateChatModel) {
        if (chatMode) {
          const chatModel = localStorage.getItem(`osw-studio-chat-model-${currentProvider}`);
          if (chatModel) modelToUse = chatModel;
        } else {
          const codeModel = localStorage.getItem(`osw-studio-code-model-${currentProvider}`);
          if (codeModel) modelToUse = codeModel;
        }
      }
    }

    if (!modelToUse) {
      toast.error(`No model selected for ${chatMode ? 'chat' : 'code'} mode. Please select a model in settings.`);
      return;
    }

    const projectName = get().projectName || 'Untitled';

    // Create the GenerationTask entry
    const newTask: GenerationTask = {
      projectId,
      projectName,
      prompt: trimmedPrompt,
      model: modelToUse,
      startedAt: Date.now(),
      result: null,
      paused: false,
      pausedMessage: null,
      orchestratorInstance: null,
      persistedInstance: get().generationTasks.get(projectId)?.persistedInstance ?? null,
    };

    const newTasks = new Map(get().generationTasks);
    newTasks.set(projectId, newTask);
    set({
      generationTasks: newTasks,
      currentModel: modelToUse,
      ...deriveScalarFields(newTasks, get().projectId),
    });

    // Register persist target before any saves
    persistProjectIds.set(projectId, projectId);

    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('generationStateChanged', { detail: { generating: true, projectId } }));
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    track('task_started', { provider: currentProvider, model: modelToUse, task_id: taskId });
    const taskStartTime = Date.now();

    // Project-scoped progress callback
    const progressCallback = (event: string, data: any) => {
      get().addDebugEvent(event, data, projectId);
      const isViewingThis = get().projectId === projectId;
      if (event === 'tool_status' && data?.status === 'completed' && isViewingThis) {
        get().markDirty();
        get().bumpRefreshTrigger();
      }
      if (event === 'usage' && data?.totalCost != null && isViewingThis) {
        set({ projectCost: data.totalCost });
      }
      if (event === 'runtimeChanged' && data?.runtime && isViewingThis) {
        get().updateProjectSettings({ runtime: data.runtime });
      }
      if (event === 'error_paused') {
        const tasks = new Map(get().generationTasks);
        const t = tasks.get(projectId);
        if (t) {
          tasks.set(projectId, { ...t, paused: true, pausedMessage: data?.message || 'API error' });
          set({ generationTasks: tasks });
        }
      }
      if (event === 'iteration' || event === 'tool_status') {
        const t = get().generationTasks.get(projectId);
        if (t?.paused) {
          const tasks = new Map(get().generationTasks);
          tasks.set(projectId, { ...t, paused: false, pausedMessage: null });
          set({ generationTasks: tasks });
        }
      }
    };

    try {
      let orchestrator = newTask.persistedInstance;

      if (!orchestrator) {
        orchestrator = new MultiAgentOrchestrator(
          projectId,
          'orchestrator',
          progressCallback,
          { chatMode, model: modelToUse },
        );

        // Only bootstrap conversation if viewing this project
        if (get().projectId === projectId) {
          const conversationMessages = get().debugEvents
            .filter(event => event.event === 'conversation_message')
            .map(event => event.data.message);

          if (conversationMessages.length > 0) {
            orchestrator.importConversation(conversationMessages);
          }
        }
      }

      // Update task with orchestrator instances
      const tasksWithOrch = new Map(get().generationTasks);
      const currentTask = tasksWithOrch.get(projectId);
      if (currentTask) {
        tasksWithOrch.set(projectId, { ...currentTask, orchestratorInstance: orchestrator, persistedInstance: orchestrator });
        set({ generationTasks: tasksWithOrch, ...deriveScalarFields(tasksWithOrch, get().projectId) });
      }

      const imageData = images?.map(img => ({ data: img.data, mediaType: img.mediaType }));
      const executeOptions: Record<string, any> = {};
      if (imageData?.length) executeOptions.images = imageData;

      const result = await orchestrator.execute(
        trimmedPrompt,
        Object.keys(executeOptions).length > 0 ? executeOptions : undefined,
      );

      if (result.success) {
        if (vfs.hasServerContext()) {
          await vfs.refreshServerContext();
        }
        track('task_complete', {
          provider: currentProvider, model: modelToUse,
          duration_ms: Date.now() - taskStartTime, task_id: taskId,
          tool_count: result.toolCount ?? 0, turn_count: result.turnCount ?? 0,
          api_error_count: result.apiErrorCount ?? 0,
        });

        const successTasks = new Map(get().generationTasks);
        const successTask = successTasks.get(projectId);
        if (successTask) {
          successTasks.set(projectId, { ...successTask, result: 'completed' });
          set({ generationTasks: successTasks, ...deriveScalarFields(successTasks, get().projectId) });
        }
        if (document.hidden || get().projectId !== projectId) {
          playTaskCompleteSound();
        } else {
          playTaskCompleteSoundSubtle();
        }
        toast.success('Task completed');
      } else {
        track('task_fail', {
          provider: currentProvider, model: modelToUse, reason: 'api_error',
          duration_ms: Date.now() - taskStartTime, task_id: taskId,
          tool_count: result.toolCount ?? 0, turn_count: result.turnCount ?? 0,
          api_error_count: result.apiErrorCount ?? 0,
        });

        const failTasks = new Map(get().generationTasks);
        const failTask = failTasks.get(projectId);
        if (failTask) {
          failTasks.set(projectId, { ...failTask, result: 'failed' });
          set({ generationTasks: failTasks, ...deriveScalarFields(failTasks, get().projectId) });
        }
        toast.error(result.summary || 'Generation failed', { duration: 5000, position: 'bottom-center' });
      }
    } catch (error) {
      logger.error('Generation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate';
      track('task_fail', {
        provider: currentProvider, model: modelToUse, reason: 'api_error',
        duration_ms: Date.now() - taskStartTime, task_id: taskId,
      });

      const errorTasks = new Map(get().generationTasks);
      const errorTask = errorTasks.get(projectId);
      if (errorTask) {
        errorTasks.set(projectId, { ...errorTask, result: 'failed' });
        set({ generationTasks: errorTasks, ...deriveScalarFields(errorTasks, get().projectId) });
      }
      get().addDebugEvent('error', { message: errorMessage }, projectId);
      toast.error(errorMessage, { duration: 5000, position: 'bottom-center' });
    } finally {
      // Clear orchestratorInstance but keep persistedInstance
      const finalTasks = new Map(get().generationTasks);
      const finalTask = finalTasks.get(projectId);
      if (finalTask) {
        finalTasks.set(projectId, { ...finalTask, orchestratorInstance: null });
        set({ generationTasks: finalTasks, ...deriveScalarFields(finalTasks, get().projectId) });
      }

      // Flush buffered events
      const buffer = backgroundEventsMap.get(projectId);
      if (buffer && buffer.length > 0) {
        flushSave(projectId, buffer);
      } else {
        flushSave(projectId, get().debugEvents);
      }

      if (typeof globalThis.dispatchEvent === 'function') {
        globalThis.dispatchEvent(new CustomEvent('generationStateChanged', { detail: { generating: false, projectId } }));
      }
    }
  },

  stopGeneration: async (projectId?: string) => {
    const targetId = projectId ?? get().projectId;
    const task = get().generationTasks.get(targetId);

    if (task?.serverTaskId) {
      // Soft stop: abort the current inference but let the server emit task_complete
      await fetch('/api/server-generate/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.serverTaskId }),
      });
      return;
    }

    if (task?.orchestratorInstance) {
      task.orchestratorInstance.stop();
      track('task_fail', {
        provider: configManager.getSelectedProvider(),
        model: get().currentModel || configManager.getDefaultModel(),
        reason: 'stopped',
      });
    }
    if (task) {
      const newTasks = new Map(get().generationTasks);
      newTasks.set(targetId, { ...task, result: 'failed', orchestratorInstance: null });
      set({ generationTasks: newTasks, ...deriveScalarFields(newTasks, get().projectId) });
    }
    // Flush buffered events
    const buffer = backgroundEventsMap.get(targetId);
    if (buffer && buffer.length > 0) flushSave(targetId, buffer);
    // Dispatch event
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('generationStateChanged', { detail: { generating: false, projectId: targetId } }));
    }
  },

  continueGeneration: () => {
    const task = get().generationTasks.get(get().projectId);
    if (task?.orchestratorInstance) {
      task.orchestratorInstance.continue();
      toast.info('Resuming task...');
    }
  },

  resetOrchestrator: () => {
    const viewedId = get().projectId;
    if (get().isProjectGenerating(viewedId)) return;
    const newTasks = new Map(get().generationTasks);
    const task = newTasks.get(viewedId);
    if (task) {
      newTasks.set(viewedId, { ...task, orchestratorInstance: null, persistedInstance: null });
      set({ generationTasks: newTasks });
    }
  },

  setCurrentModel: (model: string) => set({ currentModel: model }),

  setProjectCost: (cost: number) => set({ projectCost: cost }),

  stashForegroundEvents: (projectId: string) => {
    if (!get().isProjectGenerating(projectId)) return;
    const events = get().debugEvents;
    if (events.length > 0) {
      backgroundEventsMap.set(projectId, [...events]);
    }
  },

  loadDebugEvents: async (projectId: string) => {
    // Re-derive scalar fields for the new viewed project
    set(deriveScalarFields(get().generationTasks, projectId));

    // If the orchestrator is running for THIS project, in-memory events are authoritative.
    if (get().isProjectGenerating(projectId)) {
      const buffer = backgroundEventsMap.get(projectId);
      if (buffer && buffer.length > 0) {
        set({ debugEvents: buffer });
        backgroundEventsMap.delete(projectId);
      }
      return;
    }

    try {
      const savedEvents = await debugEventsState.loadEvents(projectId);
      if (savedEvents.length > 0) {
        const normalized: DebugEvent[] = savedEvents.map(e => ({
          ...e,
          count: (e as any).count ?? 1,
          version: (e as any).version ?? 1,
        }));
        set({ debugEvents: normalized });
      } else {
        set({ debugEvents: [] });
      }
    } catch (error) {
      logger.error('Failed to load debug events:', error);
    }
  },

  clearChat: async (projectId: string) => {
    const newTasks = new Map(get().generationTasks);
    const task = newTasks.get(projectId);
    if (task) {
      newTasks.set(projectId, { ...task, persistedInstance: null });
      set({ debugEvents: [], generationTasks: newTasks });
    } else {
      set({ debugEvents: [] });
    }
    try {
      await debugEventsState.clearEvents(projectId);
    } catch (error) {
      logger.error('Failed to clear debug events:', error);
    }
  },

  initPersistence: (projectId: string) => {
    for (const task of get().generationTasks.values()) {
      if (task.result === null) persistProjectIds.set(task.projectId, task.projectId);
    }
    persistProjectIds.set(projectId, projectId);
  },

  cleanupPersistence: () => {
    const viewedId = get().projectId;
    const timer = saveDebounceTimers.get(viewedId);
    if (timer) { clearTimeout(timer); saveDebounceTimers.delete(viewedId); }
    persistProjectIds.delete(viewedId);
  },

  connectSSE: () => {
    if (get().sseClient) return;

    const client = new SSEClient({
      onEvent: (event, data) => {
        const projectId = data.sourceProjectId as string;

        if (event === 'files_changed') {
          handleFilesChanged(data as any).then(() => {
            if (get().projectId === projectId) {
              get().markDirty();
              get().bumpRefreshTrigger();
            }
          });
          return;
        }
        if (event === 'build_requested') {
          handleBuildRequested(data as any);
          return;
        }
        if (event === 'task_complete') {
          // Cancel any queued file sync — the full pull below supersedes them
          cancelPendingFileSync();

          const tasks = new Map(get().generationTasks);
          const task = [...tasks.values()].find((t) => t.serverTaskId && t.projectId === projectId);
          if (task) {
            const result = data.result === 'success' || data.result === 'stopped'
              ? 'completed' as const
              : 'failed' as const;
            tasks.set(task.projectId, { ...task, result, orchestratorInstance: null });
            set({ generationTasks: tasks, ...deriveScalarFields(tasks, get().projectId) });
            if (result === 'completed') {
              if (data.result !== 'stopped') {
                if (document.hidden || get().projectId !== projectId) {
                  playTaskCompleteSound();
                } else {
                  playTaskCompleteSoundSubtle();
                }
              }
              toast.success(data.result === 'stopped' ? 'Task stopped' : 'Task completed');
              // Pull all files from server to sync IndexedDB with server-side changes
              (async () => {
                try {
                  const { getSyncManager } = await import('@/lib/vfs/sync-manager');
                  const syncMgr = getSyncManager();
                  const pullResult = await syncMgr.pullProjectWithFiles(projectId);
                  if (pullResult.success && pullResult.project && pullResult.files) {
                    await vfs.updateProject(pullResult.project);
                    const existingFiles = await vfs.getAllFilesAndDirectories(projectId);
                    const existingFilePaths = new Set(
                      existingFiles
                        .filter((f): f is import('@/lib/vfs/types').VirtualFile => !('type' in f && f.type === 'directory'))
                        .map(f => f.path)
                    );
                    for (const file of pullResult.files) {
                      if (existingFilePaths.has(file.path)) {
                        await vfs.updateFile(projectId, file.path, file.content, { silent: true });
                      } else {
                        await vfs.createFile(projectId, file.path, file.content, { silent: true });
                      }
                    }
                    const serverPaths = new Set(pullResult.files.map(f => f.path));
                    for (const p of existingFilePaths) {
                      if (!serverPaths.has(p)) {
                        try { await vfs.deleteFile(projectId, p, { silent: true }); } catch {}
                      }
                    }
                    if (get().projectId === projectId) {
                      window.dispatchEvent(new Event('filesChanged'));
                      get().markDirty();
                      get().bumpRefreshTrigger();
                    }
                  }
                } catch (err) {
                  logger.warn('[ServerGen] Post-completion pull failed:', err);
                }
              })();
            } else if (data.error) {
              toast.error(String(data.error), { duration: 5000 });
            }
          }
          get().addDebugEvent(event, data, projectId);
          return;
        }
        if (event === 'usage_update') {
          if (data.cost != null) {
            set({ projectCost: (get().projectCost ?? 0) + (data.cost as number) });
          }
          return;
        }
        if (event === 'usage') {
          if (data.totalCost != null) {
            set({ projectCost: data.totalCost as number });
          }
          // Don't return — let it fall through to addDebugEvent so chat panel gets usage info
        }

        // Handle duplicate user message from server
        if (event === 'conversation_message' && (data as any).message?.role === 'user') {
          const localIdx = get().debugEvents.findLastIndex(
            (e) => e.event === 'conversation_message' && e.data?.message?.role === 'user'
          );
          if (localIdx >= 0) {
            // Server's version has projectContext — merge it into the local event
            const serverMeta = (data as any).message?.ui_metadata;
            if (serverMeta?.projectContext) {
              set((state) => {
                const events = [...state.debugEvents];
                const existing = { ...events[localIdx] };
                existing.data = {
                  ...existing.data,
                  message: { ...existing.data.message, ui_metadata: { ...existing.data.message?.ui_metadata, ...serverMeta } },
                };
                existing.version = (existing.version ?? 1) + 1;
                events[localIdx] = existing;
                return { debugEvents: events };
              });
            }
            return;
          }
        }

        get().addDebugEvent(event, data, projectId);

        const isViewingThis = get().projectId === projectId;
        if (event === 'error_paused') {
          const tasks = new Map(get().generationTasks);
          const t = [...tasks.values()].find((tt) => tt.serverTaskId && tt.projectId === projectId);
          if (t) {
            tasks.set(projectId, { ...t, paused: true, pausedMessage: (data?.message as string) || 'API error' });
            set({ generationTasks: tasks });
          }
        }
        if ((event === 'iteration' || event === 'tool_status') && isViewingThis) {
          const t = get().generationTasks.get(projectId);
          if (t?.paused) {
            const tasks = new Map(get().generationTasks);
            tasks.set(projectId, { ...t, paused: false, pausedMessage: null });
            set({ generationTasks: tasks });
          }
        }
      },
      onSyncGap: (_projectId) => {
        // Full project sync needed — placeholder for future implementation
      },
    });

    client.connect();
    set({ sseClient: client });
  },

  disconnectSSE: () => {
    get().sseClient?.disconnect();
    set({ sseClient: null });
  },

  startServerGeneration: async (projectId: string, prompt: string, chatMode: boolean, images?: PendingImage[], options?: StartGenerationOptions) => {
    const provider = configManager.getSelectedProvider();
    const apiKey = configManager.getProviderApiKey(provider);
    const model = configManager.getProviderModel(provider) || '';
    const projectName = get().projectName || 'Untitled';

    if (!apiKey) {
      toast.error('API key required');
      return;
    }

    // Push project files to server before generation so the server VFS has current state
    try {
      const { getSyncManager } = await import('@/lib/vfs/sync-manager');
      const syncMgr = getSyncManager();
      const project = await vfs.getProject(projectId);
      const allItems = await vfs.getAllFilesAndDirectories(projectId);
      const files = allItems.filter((f): f is import('@/lib/vfs/types').VirtualFile => !('type' in f && f.type === 'directory'));
      if (project) {
        const result = await syncMgr.pushSingleProject(projectId, project, files);
        if (!result.success) {
          logger.warn('[ServerGen] Pre-generation sync failed:', result.error);
        }
      }
    } catch (err) {
      logger.warn('[ServerGen] Pre-generation sync error:', err);
    }

    // Connect SSE before starting generation to avoid missing early events
    get().connectSSE();

    // Build ui_metadata for the local user message (mirrors what the orchestrator produces)
    const displayPrompt = options?.displayPrompt ?? prompt;
    const uiMeta: Record<string, any> = { displayContent: displayPrompt };
    if (options?.focusContext) uiMeta.focusContext = { domPath: options.focusContext.domPath, snippet: options.focusContext.outerHTML };
    if (options?.placedBlocks?.length) uiMeta.semanticBlocks = options.placedBlocks.map((b: any) => ({ name: b.name, domPath: b.domPath, position: b.position, description: b.description }));

    get().addDebugEvent('conversation_message', {
      message: {
        role: 'user',
        content: prompt,
        ui_metadata: uiMeta,
      },
    }, projectId);
    get().addDebugEvent('waiting', {}, projectId);

    const conversationHistory = get().debugEvents
      .filter((e) => e.event === 'conversation_message')
      .map((e) => e.data.message);

    // Extract workspace ID from URL path (/w/{workspaceId}/...)
    const wsMatch = typeof window !== 'undefined' ? window.location.pathname.match(/^\/w\/([^/]+)/) : null;
    const workspaceId = wsMatch?.[1];

    // Build execute options for the server orchestrator
    const imageData = images?.map(img => ({ data: img.data, mediaType: img.mediaType }));
    const executeOptions: Record<string, any> = {};
    if (imageData?.length) executeOptions.images = imageData;
    if (options?.focusContext) executeOptions.focusContext = { domPath: options.focusContext.domPath, snippet: options.focusContext.outerHTML };
    if (options?.placedBlocks?.length) executeOptions.semanticBlocks = options.placedBlocks.map((b: any) => ({ name: b.name, domPath: b.domPath, position: b.position, description: b.description }));
    if (options?.displayPrompt) executeOptions.displayPrompt = options.displayPrompt;

    let taskId: string;
    try {
      const response = await fetch('/api/server-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          projectName,
          prompt,
          model,
          apiKey,
          workspaceId,
          providerConfig: { provider },
          conversationHistory,
          ...(Object.keys(executeOptions).length > 0 ? { executeOptions } : {}),
          generationParams: {
            reasoningEnabled: configManager.getReasoningEnabled(model),
            compactionEnabled: configManager.isCompactionEnabled(provider),
            compactionLimit: configManager.getCompactionLimit(provider),
            debugStreamEnabled: configManager.getDebugStreamEnabled(),
            modelPricing: {},
            cachedModels: configManager.getCachedModels(provider)?.models ?? [],
          },
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        toast.error((error as any).error || 'Failed to start server generation');
        return;
      }

      ({ taskId } = await response.json());
    } catch {
      toast.error('Failed to connect to server for generation');
      return;
    }

    const tasks = new Map(get().generationTasks);
    tasks.set(projectId, {
      projectId,
      projectName,
      prompt,
      model,
      startedAt: Date.now(),
      result: null,
      paused: false,
      pausedMessage: null,
      orchestratorInstance: null,
      persistedInstance: null,
      serverTaskId: taskId,
    });
    set({ generationTasks: tasks, ...deriveScalarFields(tasks, get().projectId) });
  },

  dismissGenerationResult: (projectId?: string) => {
    const targetId = projectId ?? get().projectId;
    const task = get().generationTasks.get(targetId);
    if (!task || task.result === null) return;
    const newTasks = new Map(get().generationTasks);
    newTasks.delete(targetId);
    set({ generationTasks: newTasks, ...deriveScalarFields(newTasks, get().projectId) });
  },

  reattachServerTasks: async () => {
    if (!isServerMode()) return;

    try {
      const response = await fetch('/api/server-generate/status');
      if (!response.ok) return;

      const { tasks } = await response.json();
      if (!tasks?.length) return;

      const generationTasks = new Map(get().generationTasks);
      let hasRunning = false;

      for (const serverTask of tasks) {
        if (serverTask.status === 'running' || serverTask.status === 'paused') {
          hasRunning = true;
          generationTasks.set(serverTask.projectId, {
            projectId: serverTask.projectId,
            projectName: serverTask.projectName || '',
            prompt: serverTask.prompt || '',
            model: serverTask.model || '',
            startedAt: serverTask.startedAt,
            result: null,
            paused: serverTask.status === 'paused',
            pausedMessage: null,
            orchestratorInstance: null,
            persistedInstance: null,
            serverTaskId: serverTask.taskId,
          });
        }
      }

      if (hasRunning) {
        set({ generationTasks, ...deriveScalarFields(generationTasks, get().projectId) });
        get().connectSSE();
      }
    } catch {
      // Reattach failed — non-critical, tasks will be picked up on next page load
    }
  },
});
