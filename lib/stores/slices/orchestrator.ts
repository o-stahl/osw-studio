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
import { handleFilesChanged } from '@/lib/server-generate/file-sync-handler';
import { handleBuildRequested } from '@/lib/server-generate/build-delegation-handler';

const MAX_DEBUG_EVENTS = 2000;
let debugIdCounter = 0;

const persistProjectIds = new Map<string, string>();
const saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  startServerGeneration: (projectId: string, prompt: string, chatMode: boolean) => Promise<void>;
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

    const debugEvent: DebugEvent = {
      id: `${Date.now()}-${debugIdCounter++}`,
      timestamp: Date.now(),
      event,
      data,
      count: 1,
      version: 1,
    };

    if (isBackground) {
      // User is viewing a different project — accumulate in shadow buffer, persist to IDB only
      let buffer = backgroundEventsMap.get(source) ?? [];
      const shouldCoalesce = event === 'assistant_delta' || event === 'tool_param_delta' || event === 'reasoning_delta';
      if (shouldCoalesce && buffer.length > 0) {
        const searchLimit = Math.max(0, buffer.length - 4);
        for (let i = buffer.length - 1; i >= searchLimit; i--) {
          if (buffer[i].event === event) {
            const target = buffer[i];
            buffer[i] = {
              ...target,
              timestamp: Date.now(),
              version: target.version + 1,
              count: target.count + 1,
              data: { all: target.data.all ? [...target.data.all, data] : [target.data, data] },
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

    set(state => {
      const prev = state.debugEvents;
      const shouldCoalesce = event === 'assistant_delta' || event === 'tool_param_delta' || event === 'reasoning_delta';

      if (shouldCoalesce && prev.length > 0) {
        const searchLimit = Math.max(0, prev.length - 4);
        for (let i = prev.length - 1; i >= searchLimit; i--) {
          if (prev[i].event === event) {
            const target = prev[i];
            const updatedEvent: DebugEvent = {
              ...target,
              timestamp: Date.now(),
              version: target.version + 1,
              count: target.count + 1,
              data: {
                all: target.data.all
                  ? [...target.data.all, data]
                  : [target.data, data],
              },
            };
            const newEvents = [...prev.slice(0, i), updatedEvent, ...prev.slice(i + 1)];
            return { debugEvents: newEvents };
          }
        }
      }

      let newEvents = [...prev, debugEvent];
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
      return get().startServerGeneration(projectId, message.trim(), !!options?.chatMode);
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
      await fetch('/api/server-generate/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.serverTaskId }),
      });
      const tasks = new Map(get().generationTasks);
      const updatedTask = { ...task, result: 'failed' as const, orchestratorInstance: null };
      tasks.set(targetId, updatedTask);
      const hasActive = [...tasks.values()].some((t) => !t.result);
      set({ generationTasks: tasks, generating: hasActive });
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
          handleFilesChanged(data as any);
          return;
        }
        if (event === 'build_requested') {
          handleBuildRequested(data as any);
          return;
        }
        if (event === 'task_complete') {
          const tasks = new Map(get().generationTasks);
          const task = [...tasks.values()].find((t) => t.serverTaskId && t.projectId === projectId);
          if (task) {
            task.result = data.result === 'success' ? 'completed' : 'failed';
            task.orchestratorInstance = null;
            tasks.set(task.projectId, { ...task });
            set({ generationTasks: tasks });
            const hasActive = [...tasks.values()].some((t) => !t.result);
            set({ generating: hasActive });
          }
          return;
        }
        if (event === 'usage_update') {
          set({ projectCost: (get().projectCost ?? 0) + ((data.cost as number) ?? 0) });
          return;
        }

        get().addDebugEvent(event, data, projectId);
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

  startServerGeneration: async (projectId: string, prompt: string, chatMode: boolean) => {
    const provider = configManager.getSelectedProvider();
    const apiKey = configManager.getProviderApiKey(provider);
    const model = configManager.getProviderModel(provider) || '';
    const projectName = get().projectName || 'Untitled';

    if (!apiKey) {
      toast.error('API key required');
      return;
    }

    const conversationHistory = get().debugEvents
      .filter((e) => e.event === 'conversation_message')
      .map((e) => e.data.message);

    const response = await fetch('/api/server-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        prompt,
        model,
        apiKey,
        providerConfig: { provider },
        conversationHistory,
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
      const error = await response.json();
      toast.error(error.error || 'Failed to start server generation');
      return;
    }

    const { taskId } = await response.json();

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
    set({ generationTasks: tasks, generating: true });

    get().connectSSE();
  },

  dismissGenerationResult: (projectId?: string) => {
    const targetId = projectId ?? get().projectId;
    const task = get().generationTasks.get(targetId);
    if (!task || task.result === null) return;
    const newTasks = new Map(get().generationTasks);
    newTasks.delete(targetId);
    set({ generationTasks: newTasks, ...deriveScalarFields(newTasks, get().projectId) });
  },
});
