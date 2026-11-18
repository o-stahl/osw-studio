import { StateCreator } from 'zustand';
import type { ProjectRuntime, PromptSuggestion } from '@/lib/vfs/types';
import type { FocusContextPayload } from '@/lib/preview/types';
import { track } from '@/lib/telemetry';

/** A selection as the workspace holds it: when it was made, and on which surface (MCP `canvas_selection` reports both). */
export type FocusTarget = FocusContextPayload & { timestamp: number; surface?: 'canvas' | 'preview' };

/**
 * What the agent is being asked to be: read-only, editing, or running an interview.
 *
 * This is the agent's mode, not the surface on screen -- it decides `chatMode` on a run and which
 * system prompt is built. Which surface is showing is `quickEdit`, a separate field, so that
 * offering the mode picker somewhere does not also decide what that somewhere looks like.
 */
export type WorkspaceMode = 'code' | 'chat' | 'interview';

export interface ActiveInterview {
  templateId: string;
  title: string;
}

export interface ProjectSlice {
  projectId: string;
  projectName: string;
  isDirty: boolean;
  saveInProgress: boolean;
  lastSavedAt: Date | null;
  entryPoint: string | undefined;
  projectRuntime: ProjectRuntime | undefined;
  /** The project's own chat starters, seeded by its template and editable in Settings. */
  promptSuggestions: PromptSuggestion[];
  modelConfigVersion: number;
  focusContext: FocusTarget | null;
  /**
   * Sibling of focusContext, not nested in it: recompiles rebuild focusContext wholesale,
   * which would drop a flag carried inside the payload.
   */
  focusIncluded: boolean;
  /**
   * Text handed to the chat composer without sending it.
   *
   * The Styles tab's "Ask the agent" writes here rather than starting a run: it knows what went
   * wrong, not what the person wants done about it, so the message is theirs to finish. In the
   * store because the panel that produces it and the composer that shows it are in different
   * subtrees, and there are two composers mounted (the desktop tree and the mobile one).
   *
   * `nonce` is what the composer keys off, so asking twice about the same property appends twice
   * instead of looking like nothing happened.
   */
  composerDraft: { text: string; nonce: number } | null;
  mode: WorkspaceMode;
  /**
   * Whether the workspace is showing quick edit rather than the studio.
   *
   * The surface, kept apart from `mode`: quick edit is the studio's panels and transcript replaced
   * by a preview and a thread of runs, over the same project, save and checkpoint wiring, with the
   * agent editing exactly as it does in `code`. Owned by whatever put it on screen -- the
   * `/quick/{projectId}` route in server mode, the selection in the simple view -- and restored by
   * that same effect on the way out.
   */
  quickEdit: boolean;
  activeInterview: ActiveInterview | null;
  backendEnabled: boolean;
  selectedDeploymentId: string | null;
  initialCheckpointId: string | null;
  checkpointRefreshKey: number;
  refreshTrigger: number;
  runtimeErrors: string[];
  workspaceReady: boolean;

  initProject: (project: { id: string; name: string; settings?: any; lastSavedAt?: Date | null }) => void;
  markDirty: () => void;
  markClean: () => void;
  bumpRefreshTrigger: () => void;
  bumpModelConfig: () => void;
  incrementCheckpointRefresh: () => void;
  updateProjectSettings: (settings: { runtime?: ProjectRuntime; previewEntryPoint?: string; promptSuggestions?: PromptSuggestion[] }) => void;
  setMode: (mode: WorkspaceMode) => void;
  setQuickEdit: (on: boolean) => void;
  setActiveInterview: (interview: ActiveInterview | null) => void;
  setBackendEnabled: (enabled: boolean) => void;
  setDeployment: (id: string | null) => void;
  setFocusContext: (ctx: FocusTarget | null) => void;
  setFocusIncluded: (included: boolean) => void;
  /** Add a paragraph to the composer's draft. Never sends. */
  appendComposerDraft: (text: string) => void;
  setRuntimeErrors: (errors: string[]) => void;
  resetProject: () => void;
}

type CombinedState = ProjectSlice & { generating: boolean; isProjectGenerating: (id: string) => boolean; resetOrchestrator: () => void };

export const createProjectSlice: StateCreator<CombinedState, [], [], ProjectSlice> = (set, get) => ({
  projectId: '',
  projectName: '',
  isDirty: false,
  saveInProgress: false,
  lastSavedAt: null,
  entryPoint: undefined,
  projectRuntime: undefined,
  promptSuggestions: [],
  modelConfigVersion: 0,
  focusContext: null,
  focusIncluded: false,
  composerDraft: null,
  mode: 'code',
  quickEdit: false,
  activeInterview: null,
  backendEnabled: false,
  selectedDeploymentId: null,
  initialCheckpointId: null,
  checkpointRefreshKey: 0,
  refreshTrigger: 0,
  runtimeErrors: [],
  workspaceReady: false,

  initProject: (project) => {
    set({
      projectId: project.id,
      projectName: project.name,
      entryPoint: project.settings?.previewEntryPoint,
      projectRuntime: project.settings?.runtime,
      promptSuggestions: project.settings?.promptSuggestions ?? [],
      lastSavedAt: project.lastSavedAt ?? null,
      isDirty: false,
    });
  },

  markDirty: () => set({ isDirty: true }),
  markClean: () => set({ isDirty: false }),

  bumpRefreshTrigger: () => set(s => ({ refreshTrigger: s.refreshTrigger + 1 })),
  bumpModelConfig: () => set(s => ({ modelConfigVersion: s.modelConfigVersion + 1 })),
  incrementCheckpointRefresh: () => set(s => ({ checkpointRefreshKey: s.checkpointRefreshKey + 1 })),

  updateProjectSettings: (settings) => {
    set(s => ({
      projectRuntime: settings.runtime ?? s.projectRuntime,
      entryPoint: settings.previewEntryPoint ?? s.entryPoint,
      // ?? rather than ||: emptying the list is a deliberate edit, and [] must not read as absent.
      promptSuggestions: settings.promptSuggestions ?? s.promptSuggestions,
      refreshTrigger: s.refreshTrigger + 1,
    }));
  },

  setMode: (mode: WorkspaceMode) => {
    const prevMode = get().mode;
    set({ mode });
    if (prevMode !== mode) {
      track('mode_switch', { from: prevMode, to: mode });
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem('osw-studio-mode', mode);
    }
    if (!get().generating) {
      get().resetOrchestrator();
    }
  },

  /**
   * Swap the surface. Deliberately touches nothing else.
   *
   * Not `setMode`'s business: that persists the mode picker's choice and drops the cached
   * orchestrator so the next run is built with the new prompt. Showing a different surface over the
   * same project is neither of those, and routing it through `setMode` overwrote the person's saved
   * mode with a surface name.
   */
  setQuickEdit: (on: boolean) => set({ quickEdit: on }),

  setActiveInterview: (interview: ActiveInterview | null) => {
    set({ activeInterview: interview });
    const pid = get().projectId;
    if (pid && typeof window !== 'undefined') {
      const key = `osw-interview-${pid}`;
      if (interview) {
        localStorage.setItem(key, JSON.stringify(interview));
      } else {
        localStorage.removeItem(key);
      }
    }
  },

  setBackendEnabled: (enabled: boolean) => {
    set({ backendEnabled: enabled });
    const pid = get().projectId;
    if (pid && typeof window !== 'undefined') {
      localStorage.setItem(`osw-backend-${pid}`, String(enabled));
    }
  },

  setDeployment: (id: string | null) => set({ selectedDeploymentId: id }),
  setFocusContext: (ctx) => set({ focusContext: ctx }),
  setFocusIncluded: (included) => set({ focusIncluded: included }),
  appendComposerDraft: (text) => set(state => ({
    composerDraft: { text, nonce: (state.composerDraft?.nonce ?? 0) + 1 },
  })),
  setRuntimeErrors: (errors) => set({ runtimeErrors: errors }),

  resetProject: () => {
    if (get().generating) return;
    set({
      projectId: '',
      projectName: '',
      isDirty: false,
      saveInProgress: false,
      lastSavedAt: null,
      entryPoint: undefined,
      projectRuntime: undefined,
      promptSuggestions: [],
      focusContext: null,
      focusIncluded: false,
      composerDraft: null,
      activeInterview: null,
      backendEnabled: false,
      selectedDeploymentId: null,
      initialCheckpointId: null,
      checkpointRefreshKey: 0,
      refreshTrigger: 0,
      runtimeErrors: [],
      workspaceReady: false,
    });
  },
});
