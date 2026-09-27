'use client';

import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { Project, VirtualFile } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { FileExplorer } from '@/components/file-explorer';
import { MultiTabEditor, openFileInEditor } from '@/components/editor/multi-tab-editor';
import { MultipagePreview, MultipagePreviewHandle } from '@/components/preview/multipage-preview';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MessageSquare, FolderTree, Code2, Eye, Settings, Save, Bug, RotateCcw, History, Terminal as TerminalIcon, Sparkles, ChevronDown, ChevronUp, EllipsisVertical, Upload, ListTree, Undo2, Redo2 } from 'lucide-react';
import { AppHeader, HeaderAction } from '@/components/ui/app-header';
import { PendingImage, PendingAudio, PendingFile } from '@/lib/llm/multi-agent-orchestrator';
import { configManager, migrateBackendKey } from '@/lib/config/storage';
import { DeployDialog } from '@/components/deploy-dialog';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import type { InterviewTemplate, InterviewHandoff } from '@/lib/interview/types';
import { track } from '@/lib/telemetry';
import { bucketInterviewTemplateId } from '@/lib/telemetry/tool-analytics';
import { PANEL_MAP, pickEvictionTarget, visiblePanelKeys } from '@/lib/stores/slices/layout';
import { PROJECT_BUSY_NOTICE } from '@/lib/stores/slices/orchestrator';
import { useCostSettings } from '@/lib/hooks/use-cost-settings';
import { getModelInputModalities } from '@/lib/llm/providers/registry';
import { isProjectProviderReady } from '@/lib/llm/models/project-assignment';
import { resolveActiveAssignment } from '@/lib/llm/models/template-store';
import { toast } from 'sonner';
import { debugEventsState } from '@/lib/llm/debug-events-state';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { checkpointManager, isEmptyPreview, type BackendRestorePreview } from '@/lib/vfs/checkpoint';
import { useTranslation } from '@/components/providers/locale-provider';
import { RestoreSecretsDialog } from '@/components/restore-secrets-dialog';
import { saveManager } from '@/lib/vfs/save-manager';
import { flushEditorToVfs } from '@/lib/vfs/flush-editor';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { useGuidedTour } from '@/components/guided-tour/context';
import { GuidedTourTranscriptEvent } from '@/components/guided-tour/types';
import { FocusContextPayload } from '@/lib/preview/types';
import { elementKind } from '@/lib/preview/toolbar-dom';
import type { PlacedBlock } from '@/lib/semantic-blocks/types';
import type { PlacementResult, PreviewHostMessage, PreviewMessage, ToolbarAction } from '@/lib/preview/types';
import { getBlockById } from '@/lib/semantic-blocks/registry';
import { DebugPanel } from '@/components/debug-panel';
import { ChatPanel } from '@/components/chat-panel';
import { DeploymentSelector } from '@/components/workspace/deployment-selector';
import { CheckpointPanel } from '@/components/checkpoint-panel';
import { ProjectSettingsModal } from '@/components/project-backend';
import { SkillsPanel } from '@/components/workspace/skills-panel';
import { PanelDragProvider, PanelContainer, PanelHeader } from '@/components/ui/panel';
import { ElementsPanel, type ElementsPanelHandle, type ElementsTab } from '@/components/elements-panel';
import { buildApplyStyle, buildRemoveStyle, toPreviewSelection } from '@/components/styles-content/commit';
import { ImagePicker } from '@/components/image-picker';
import { applyImageSrc } from '@/lib/direct-edit/apply-image';
import { TextPopover } from '@/components/text-popover';
import { applyText, readSourceText } from '@/lib/direct-edit/apply-text';
import { useProjectColorTokens } from '@/components/styles-content/use-tokens';
import { useSelectedImageUrl } from '@/components/styles-content/use-image-url';
import { applyStyleOverride, readOverriddenProperties, removeStyleOverride } from '@/lib/direct-edit/apply-style';
import { ConsolePanel } from '@/components/console';
import { drainRuntimeErrors, peekRuntimeErrors, formatRuntimeErrors } from '@/lib/preview/runtime-errors';
import { supportsDirectEditing } from '@/lib/runtimes/registry';
import { useMobileViewport } from '@/lib/hooks/use-mobile-viewport';
import { SimpleThread } from '@/components/quick-edit/thread';
import { splitRuns } from '@/lib/quick-edit/runs';
import { undoTarget, redoTarget } from '@/lib/quick-edit/undo';

interface WorkspaceProps {
  project: Project;
  onBack: () => void;
  /** Names the page Back returns to, which is whichever one the project was opened over. */
  backLabel?: string;
  workspaceId?: string;
  /**
   * The page the preview should open on, when the caller opened this project to look at something
   * specific — the review comment inbox is the first. One-shot: the preview uses it for the first
   * compile only, so navigating away from it sticks.
   */
  initialPreviewPath?: string;
}

type FocusTarget = FocusContextPayload & { timestamp: number };

/** What makes two focus selections "the same one" for the 400 ms click dedup. */
function focusSignature(selection: FocusContextPayload): string {
  return `${selection.domPath || ''}::${selection.tagName || ''}::${selection.outerHTML ? selection.outerHTML.length : 0}`;
}

/**
 * What to do with the focus context when the preview frame announces a fresh document.
 *
 * @param selectedOnPath the preview path the selection was made on, or null when unrecorded
 * @param activePath     the path the frame has just loaded
 */
export function focusReloadAction(
  focus: FocusContextPayload | null,
  selectedOnPath: string | null,
  activePath: string | null,
): { kind: 'none' } | { kind: 'clear' } | { kind: 'resolve'; domPath: string } {
  // Nothing selected, or a selection with no positional handle to re-resolve by. Clearing here
  // would take away a selection the recompile did not actually invalidate.
  if (!focus || !focus.domPath) return { kind: 'none' };
  // An unrecorded path is not evidence of a navigation — a selection can predate the recording —
  // so it re-resolves. The domPath still has to match an element, and null is the answer if it does
  // not; a navigation, by contrast, is a positive signal and clears.
  if (selectedOnPath !== null && selectedOnPath !== activePath) return { kind: 'clear' };
  return { kind: 'resolve', domPath: focus.domPath };
}

/** Controls whether provenance is injected into the preview. */
export const STYLE_DISMISSES_TOOLBAR = false;

/** Opens the Inspector if not already open, avoiding a redundant togglePanel call. */
export function applyToolbarAction(
  action: ToolbarAction,
  layout: { showElements: boolean; togglePanel: (panel: string) => void },
  styleDismisses: boolean = STYLE_DISMISSES_TOOLBAR,
): {
  tab: ElementsTab | null;
  clearSelection: boolean;
  include: boolean;
  replaceImage: boolean;
  editText: boolean;
} {
  const base = { tab: null, clearSelection: false, include: false, replaceImage: false, editText: false };
  if (action === 'dismiss') {
    return { ...base, clearSelection: true };
  }
  if (action === 'replace') {
    // The picker opens over the workspace and the selection stays exactly as it is: the write it
    // performs is resolved from *this* selection, and the recompile that follows is what brings the
    // toolbar back. Clearing here would take away the element the dialog is about.
    return { ...base, replaceImage: true };
  }
  if (action === 'text') {
    // Same bargain as `replace`, and for the same reason: the popover reads and writes through
    // *this* selection's provenance, so clearing it here would leave the dialog about nothing.
    return { ...base, editText: true };
  }
  if (action === 'include') {
    // The selection is untouched: including it in the message is not selecting it again, and the
    // toolbar has to survive the send. What `include` *means* is the behaviour split.
    return { ...base, include: true };
  }
  if (!layout.showElements) layout.togglePanel('elements');
  return { ...base, tab: 'styles', clearSelection: styleDismisses };
}

/** Which preview a selection was made in. Desktop only: the mobile mount has no toolbar wiring. */
export type SelectionSurface = 'desktop' | 'mobile';

/**
 * Where the dashed outline goes while the pointer is on the Styles tab's `Select element` button.
 * 'panel' when the preview is already open; 'route' when closed (routed through sidebar hover).
 */
export type PreviewHoverHighlight = 'clear' | 'panel' | 'route';

export function previewHoverHighlight(input: { hovering: boolean; previewOpen: boolean }): PreviewHoverHighlight {
  if (!input.hovering) return 'clear';
  return input.previewOpen ? 'panel' : 'route';
}

/** Toggles the focus picker. Both controls (header crosshair, Inspector button) share this flag. */
export function focusToolPress(input: { armed: boolean }): { armed: boolean; openPreview: boolean } {
  return input.armed ? { armed: false, openPreview: false } : { armed: true, openPreview: true };
}

/**
 * Returns whether a selection should auto-include as chat context.
 * Mobile and non-direct-edit runtimes always include; desktop includes only when the
 * toolbar's include button was pressed and the domPath has not changed.
 */
export function focusInclusionAfterWrite(
  previous: { domPath: string } | null,
  next: { domPath: string } | null,
  included: boolean,
  surface: SelectionSurface,
  directEdit: boolean = true,
): boolean {
  // A deselect lowers the flag on both surfaces, and it is checked first for that reason: on mobile
  // every *selection* raises it, and reading that rule before this one would raise it on the way out.
  if (!next) return false;
  // The rule is not really about the surface: it is about whether a control exists that can raise
  // the flag deliberately. Mobile has no toolbar, and neither does a runtime whose elements carry no
  // provenance — so in both, selecting *is* the act of including, or the selection could never reach
  // the agent at all.
  if (surface === 'mobile' || !directEdit) return true;
  if (!included) return false;
  if (!previous) return false;
  if (!previous.domPath || !next.domPath) return false;
  return previous.domPath === next.domPath;
}

/** Desktop keeps the selection on release; mobile clears both selection and inclusion. */
export function focusInclusionRelease(surface: SelectionSurface): { clearSelection: boolean } {
  return { clearSelection: surface === 'mobile' };
}

/** Formats the selection as chat context only when focusIncluded is true. */
export function focusMessageContext<T extends { domPath: string }>(
  focus: T | null,
  included: boolean,
  formatBlock: (target: T) => string,
): { promptBlock: string | null; generationFocus: T | null } {
  if (!focus || !included) return { promptBlock: null, generationFocus: null };
  return { promptBlock: formatBlock(focus), generationFocus: focus };
}

/** The panel set quick edit shows, in order; the store's order is not consulted. */
const QUICK_PANEL_ORDER = ['chat', 'preview', 'elements'];

export function Workspace({ project, onBack, backLabel, workspaceId, initialPreviewPath }: WorkspaceProps) {
  const { t } = useTranslation();
  // The page the preview is on, for suggestions that are scoped to particular pages. Null until the
  // preview reports one, which selectPromptSuggestions reads as "offer everything".
  const [previewPath, setPreviewPath] = useState<string | null>(initialPreviewPath ?? null);
  const refreshTrigger = useWorkspaceStore(s => s.refreshTrigger);
  const generating = useWorkspaceStore(s => s.generating);
  const debugEvents = useWorkspaceStore(s => s.debugEvents);
  const currentModel = useWorkspaceStore(s => s.currentModel);
  const modelConfigVersion = useWorkspaceStore(s => s.modelConfigVersion);
  const projectCost = useWorkspaceStore(s => s.projectCost);
  const addDebugEvent = useWorkspaceStore(s => s.addDebugEvent);
  const isDirty = useWorkspaceStore(s => s.isDirty);

  useEffect(() => {
    const onNeedsRetry = (event: Event) => {
      const id = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (id === project.id) useWorkspaceStore.getState().markDirty();
    };
    window.addEventListener('osw-sync-needs-retry', onNeedsRetry);
    return () => window.removeEventListener('osw-sync-needs-retry', onNeedsRetry);
  }, [project.id]);
  const saveInProgress = useWorkspaceStore(s => s.saveInProgress);
  const entryPoint = useWorkspaceStore(s => s.entryPoint);
  const projectRuntime = useWorkspaceStore(s => s.projectRuntime);
  const focusContext = useWorkspaceStore(s => s.focusContext);
  const focusIncluded = useWorkspaceStore(s => s.focusIncluded);
  const mode = useWorkspaceStore(s => s.mode);
  /**
   * Quick edit: the same desktop tree with the studio parts left out. Chat and preview only, no
   * rail, no Deploy or Settings, the conversation as a thread of runs rather than a transcript.
   * On a phone it is the site with the dock over it instead of the panel switcher.
   */
  const quick = useWorkspaceStore(s => s.quickEdit);
  // Once per project opened on the quick surface. `mode_switch` covers the agent's mode, not the
  // surface, so without this the analytics could not say whether quick edit is used at all.
  useEffect(() => {
    if (quick) track('quick_edit_opened');
  }, [quick, project.id]);
  const [checkpointIds, setCheckpointIds] = useState<string[]>([]);
  const [undoCursor, setUndoCursor] = useState<string | null>(null);
  /** Quick edit's own panel pair, kept out of the store so the studio's saved layout is untouched. */
  // The inspector starts closed: quick edit opens on the conversation and the page, and the
  // inspector is something you reach for. Opened by its rail button, or by the preview
  // toolbar's Style action on a selection.
  const [quickPanels, setQuickPanels] = useState({ chat: true, preview: true, elements: false });
  const activeInterview = useWorkspaceStore(s => s.activeInterview);
  const runtimeErrors = useWorkspaceStore(s => s.runtimeErrors);
  const initialCheckpointId = useWorkspaceStore(s => s.initialCheckpointId);
  const checkpointRefreshKey = useWorkspaceStore(s => s.checkpointRefreshKey);
  const backendEnabled = useWorkspaceStore(s => s.backendEnabled);
  const selectedDeploymentId = useWorkspaceStore(s => s.selectedDeploymentId);
  const activeMobilePanel = useWorkspaceStore(s => s.activeMobilePanel);
  // Which of the two trees is on screen. Only the Inspector's frame plumbing reads it, to pick the
  // iframe and the panel it is allowed to address.
  const mobileViewport = useMobileViewport();
  const mobileOverflowOpen = useWorkspaceStore(s => s.mobileOverflowOpen);
  const placedBlocks = useWorkspaceStore(s => s.placedBlocks);
  const paletteOpen = useWorkspaceStore(s => s.paletteOpen);
  const [publishOpen, setPublishOpen] = useState(false);
  // Set when a restore would cost a stored secret value; held until the user confirms or cancels.
  const [pendingRestore, setPendingRestore] = useState<{
    preview: BackendRestorePreview;
    description?: string;
    restore: () => Promise<void>;
  } | null>(null);

  // After an OAuth round-trip started from Deploy (grant/reconnect), reopen the Deploy dialog
  // for this project so the user lands back where they left off instead of in the workspace.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('hf_oauth_resume_deploy') === project.id) {
        sessionStorage.removeItem('hf_oauth_resume_deploy');
        setPublishOpen(true);
      }
    } catch { /* sessionStorage unavailable */ }
  }, [project.id]);

  const lastFocusSignatureRef = useRef<{ signature: string; timestamp: number } | null>(null);
  /**
   * The preview path the current focus context was selected on, or null when there is no selection.
   *
   * `FocusContextPayload.domPath` carries no page identity, so this is the only thing that can tell
   * a recompile of the same page (re-resolve) from a navigation to another one (clear).
   */
  const focusPathRef = useRef<string | null>(null);
  const previewRef = useRef<MultipagePreviewHandle>(null);
  const elementsPanelRef = useRef<ElementsPanelHandle>(null);
  /**
   * The *desktop* preview's handle, specifically.
   *
   * The desktop block (`hidden md:flex`) and the mobile block (`flex md:hidden`) are both always in
   * the React tree — the mobile one is hidden by CSS, not unmounted, and its preview renders
   * whenever `activeMobilePanel === 'preview'`, which is the store's default. Both pass
   * `previewRef`, and the mobile instance commits last, so on a desktop viewport `previewRef` points
   * at a hidden frame that was compiled without provenance.
   *
   * That is a pre-existing hazard for every consumer of `previewRef` and is deliberately left
   * alone. The Elements tree cannot live with it: `sendToFrame` addresses one specific iframe, and
   * addressing the hidden one would serialize a document with no `data-osw-src` in it at all. So the
   * tree keeps its own reference to the instance whose props it is wired to.
   */
  const desktopPreviewRef = useRef<MultipagePreviewHandle | null>(null);
  // Stable, so it runs on mount and unmount only. An inline callback ref would re-run on every
  // render and start reordering which instance `previewRef` ends up holding.
  const attachDesktopPreview = useCallback((handle: MultipagePreviewHandle | null) => {
    previewRef.current = handle;
    desktopPreviewRef.current = handle;
  }, []);
  /**
   * The *mobile* preview's handle, for the same reason the desktop one is kept separately.
   *
   * The Inspector runs on both trees now, and `sendToFrame` addresses one iframe. On a phone the
   * desktop instance is mounted but CSS-hidden and its document is the wrong one to ask, so the
   * frame plumbing resolves the handle by viewport rather than reaching for either directly.
   *
   * It still writes `previewRef` because the mobile mount always did (it was `ref={previewRef}`),
   * and that ref's instance-ordering hazard is documented above and deliberately left as it was.
   */
  const mobilePreviewRef = useRef<MultipagePreviewHandle | null>(null);
  const attachMobilePreview = useCallback((handle: MultipagePreviewHandle | null) => {
    previewRef.current = handle;
    mobilePreviewRef.current = handle;
  }, []);
  /**
   * The mobile Inspector's own handle, for the same reason as the previews: both trees are
   * mounted, so one shared ref would be owned by whichever committed last — the hidden one.
   */
  const mobileElementsPanelRef = useRef<ElementsPanelHandle>(null);
  /**
   * The visible tree, as a ref.
   *
   * The frame's replies are dispatched by handlers that sit in the preview's message-listener
   * dependencies, so they have to keep stable identities; reading the viewport as a value would
   * make each of them change when the breakpoint is crossed. A ref keeps them at `[]` deps and
   * still answers with the current surface.
   */
  const mobileViewportRef = useRef(false);
  mobileViewportRef.current = mobileViewport;
  const inspectorTargets = useCallback(() => (mobileViewportRef.current
    ? { panel: mobileElementsPanelRef.current, preview: mobilePreviewRef.current, surface: 'mobile' as const }
    : { panel: elementsPanelRef.current, preview: desktopPreviewRef.current, surface: 'desktop' as const }), []);
  const generatingRef = useRef(false);
  const handleGenerateRef = useRef<((promptText?: string, images?: PendingImage[], audio?: PendingAudio[], files?: PendingFile[]) => Promise<void>) | null>(null);
  // Both declared before their handlers, which the Styles tab's callbacks need and which are defined
  // further down this component.
  const handleFileSelectRef = useRef<((file: VirtualFile) => void) | null>(null);
  const storeSetMode = useWorkspaceStore(s => s.setMode);
  const storeSetActiveInterview = useWorkspaceStore(s => s.setActiveInterview);
  const { state: tourState, setWorkspaceHandler } = useGuidedTour();
  const tourStep = tourState.currentStep?.id;
  const tourRunning = tourState.status === 'running';
  const isTourLockingInput = tourRunning && tourStep !== 'wrap-up';

  // Keep generatingRef in sync for runtime error listener
  useEffect(() => { generatingRef.current = generating; }, [generating]);

  // Guard against accidental navigation away with unsaved changes
  // During generation, let the user leave freely — the generation shelf handles status
  const guardedBack = useCallback(() => {
    if (!generating && isDirty) {
      if (!window.confirm('You have unsaved changes. Leave anyway?')) return;
    }
    onBack();
  }, [generating, isDirty, onBack]);

  // Reattach to any server-side tasks that were running before page reload
  useEffect(() => {
    useWorkspaceStore.getState().reattachServerTasks();
  }, []);

  // Browser beforeunload — warn when dirty or generating
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useWorkspaceStore.getState().isAnyGenerating() || isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Subscribe to runtime errors that arrive after generation completes
  useEffect(() => {
    const handler = () => {
      if (!generatingRef.current) {
        useWorkspaceStore.getState().setRuntimeErrors(peekRuntimeErrors());
      }
    };
    window.addEventListener('runtimeErrorsChanged', handler);
    return () => window.removeEventListener('runtimeErrorsChanged', handler);
  }, []);

  // The reactive model-config signal bump (apiKeyUpdated + modelConfigChanged -> bumpModelConfig)
  // lives in the useModelConfigSignal hook, mounted at the always-present mode roots (StudioInner
  // and PageWrapperInner). Mounting it there (not here) makes modelConfigVersion bump globally so
  // ChatPanels rendered outside the Workspace subtree (describe-mode, project-manager) also react.

  // Listen for runtime changes from the CLI (e.g., LLM runs `runtime handlebars`)
  useEffect(() => {
    const handler = (e: Event) => {
      const runtime = (e as CustomEvent).detail?.runtime;
      if (runtime) useWorkspaceStore.getState().updateProjectSettings({ runtime });
    };
    window.addEventListener('runtimeChanged', handler);
    return () => window.removeEventListener('runtimeChanged', handler);
  }, []);

  // The GLOBAL model auto-assign on provider connect (apiKeyUpdated -> activateProviderAsGlobalDefault)
  // lives in the useProviderAutoAssign hook, mounted at the always-present mode roots (StudioInner and
  // PageWrapperInner). It cannot live here: the Connections UI is reachable outside a workspace
  // (dashboard -> Settings -> Connections), where Workspace is not mounted.

  // Get cost settings for conditional display
  const { shouldShowCosts } = useCostSettings();

  // Input modalities of the active agent model (drives image/voice affordances).
  // Resolve from the globally-resolved active assignment, falling back to the
  // global selectedProvider/currentModel.
  const inputModalities = useMemo(() => {
    const agent = resolveActiveAssignment().agent;
    const currentProvider = agent?.provider ?? configManager.getSelectedProvider();
    const modelId = agent?.model || currentModel || configManager.getDefaultModel();

    // Check cached discovered models first (has accurate modality data from API)
    const cached = configManager.getCachedModels(currentProvider);
    if (cached) {
      const model = (cached.models as import('@/lib/llm/providers/types').ProviderModel[])
        .find(m => m.id === modelId);
      if (model?.inputModalities) return model.inputModalities;
      if (model?.supportsVision !== undefined) {
        return model.supportsVision ? ['text' as const, 'image' as const] : ['text' as const];
      }
    }

    return getModelInputModalities(currentProvider, modelId);
  }, [modelConfigVersion, currentModel]);

  const supportsVision = inputModalities.includes('image');

  // Readiness keys off the globally-resolved active agent provider
  // (see isProjectProviderReady), recomputed on modelConfigVersion bumps.
  const providerReady = useMemo(
    () => isProjectProviderReady(),
    [modelConfigVersion],
  );
  
  // Console panel — visible by default for terminal-mode runtimes (Python, Lua), togglable for all

  const storeShowChat = useWorkspaceStore(s => s.showChat);
  const storeShowFiles = useWorkspaceStore(s => s.showFiles);
  const storeShowEditor = useWorkspaceStore(s => s.showEditor);
  const storeShowPreview = useWorkspaceStore(s => s.showPreview);
  const storeShowCheckpoints = useWorkspaceStore(s => s.showCheckpoints);
  // Quick edit fixes the panel set without touching the store, so it never writes into the layout
  // the studio has saved.
  // With both quick panels off there is nothing to look at, so the preview stands in.
  const showChat = quick ? quickPanels.chat : storeShowChat;
  const showFiles = !quick && storeShowFiles;
  const showEditor = !quick && storeShowEditor;
  const showPreview = quick ? quickPanels.preview || !quickPanels.chat : storeShowPreview;
  const showCheckpoints = !quick && storeShowCheckpoints;
  const showDebugPanel = useWorkspaceStore(s => s.showDebugPanel);
  const showProjectSettingsModal = useWorkspaceStore(s => s.showProjectSettingsModal);
  const showSkillsPanel = useWorkspaceStore(s => s.showSkillsPanel);
  const storeShowConsole = useWorkspaceStore(s => s.showConsole);
  const showConsole = !quick && storeShowConsole;
  // Gates the preview's provenance instrumentation, which is off for everyone else: the publish,
  // export and thumbnail paths must never see `data-osw-src`, and flipping this recompiles.
  const storeShowElements = useWorkspaceStore(s => s.showElements);
  const showElements = quick ? quickPanels.elements : storeShowElements;
  // Subscribed, not read through `getState()`, because the Inspector's `Select element` button has
  // to *look* armed: the flag is set from two controls in two components, so only a subscription
  // re-renders this one when the other moves it.
  const focusToolArmed = useWorkspaceStore(s => s.focusToolArmed);
  // The Inspector's tab, held out here rather than inside the panel: the panel is only mounted
  // while `showElements` is on, so anything that wants to open it *on a particular tab* has to be
  // able to set the tab from outside — the panel's own state would not exist yet at that moment.
  const [elementsTab, setElementsTab] = useState<ElementsTab>('tree');
  // The toolbar's Replace dialog. Held here rather than in the preview because the write it performs
  // needs the project and the focus context, neither of which the frame has.
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  // The toolbar's Text dialog, held here for the same reason.
  const [textPopoverOpen, setTextPopoverOpen] = useState(false);
  const fullscreenPreview = useWorkspaceStore(s => s.fullscreenPreview);
  const panelReplacePreview = useWorkspaceStore(s => s.panelReplacePreview);
  const panelInsertPreview = useWorkspaceStore(s => s.panelInsertPreview);
  const hasUnreadConsole = useWorkspaceStore(s => s.hasUnreadConsole);
  // Ref to imperatively reset panel sizes after reorder
  const panelGroupRef = useRef<import('react-resizable-panels').ImperativePanelGroupHandle | null>(null);

  const storePanelOrder = useWorkspaceStore(s => s.panelOrder);
  const panelOrder = quick ? QUICK_PANEL_ORDER : storePanelOrder;
  const draggingPanel = useWorkspaceStore(s => s.draggingPanel);
  const dropTarget = useWorkspaceStore(s => s.dropTarget);

  const handlePanelDragStart = useCallback((panelKey: string) => {
    // Capture the dragged panel's center X for "stay put" distance comparison
    const container = panelContainerRef.current;
    if (container) {
      const panelEl = container.querySelector(`[data-panel-id="${panelKey}"]`);
      if (panelEl) {
        const rect = panelEl.getBoundingClientRect();
        draggedPanelCenter.current = rect.left + rect.width / 2;
      }
    }
    document.body.style.cursor = 'grabbing';
    useWorkspaceStore.getState().startDrag(panelKey);
  }, []);

  const handlePanelDragEnd = useCallback(() => {
    if (draggingPanel && dropTarget !== null) {
      // Capture current sizes keyed by panel identity before reordering. Derived from PANEL_MAP
      // rather than a hardcoded key→flag chain: this list indexes the drop zones, so a panel
      // missing from it silently shifts every drop target to the right of it.
      const visibleBefore = visiblePanelKeys(useWorkspaceStore.getState(), panelOrder);
      const currentLayout = panelGroupRef.current?.getLayout() || [];
      const sizeByKey: Record<string, number> = {};
      visibleBefore.forEach((key, i) => {
        if (i < currentLayout.length) sizeByKey[key] = currentLayout[i];
      });

      {
        const prevOrder = panelOrder;
        const newOrder = prevOrder.filter(k => k !== draggingPanel);
        const targetKey = visibleBefore[dropTarget];
        if (targetKey) {
          const insertIdx = newOrder.indexOf(targetKey);
          newOrder.splice(insertIdx, 0, draggingPanel);
        } else {
          newOrder.push(draggingPanel);
        }
        useWorkspaceStore.getState().setPanelOrder(newOrder);
      }

      // Restore sizes in the new order after React re-renders
      requestAnimationFrame(() => {
        if (panelGroupRef.current && visibleBefore.length > 0) {
          // Compute new visible order
          const newVisible = [...visibleBefore];
          const dragIdx = newVisible.indexOf(draggingPanel);
          if (dragIdx >= 0) newVisible.splice(dragIdx, 1);
          const targetKey = visibleBefore[dropTarget];
          const insertIdx = targetKey ? newVisible.indexOf(targetKey) : newVisible.length;
          newVisible.splice(insertIdx >= 0 ? insertIdx : newVisible.length, 0, draggingPanel);

          const sizes = newVisible.map(k => sizeByKey[k] || Math.floor(100 / newVisible.length));
          // Normalize to exactly 100
          const total = sizes.reduce((a, b) => a + b, 0);
          if (total !== 100 && sizes.length > 0) {
            sizes[sizes.length - 1] += 100 - total;
          }
          panelGroupRef.current.setLayout(sizes);
        }
      });
    }
    useWorkspaceStore.getState().endDrag();
    draggedPanelCenter.current = null;
    document.body.style.cursor = '';
  }, [draggingPanel, dropTarget, panelOrder]);

  // Document-level mouseup listener — ends drag whether inside or outside the container.
  // If mouseUp is inside the container, the container's own onMouseUp handles it (with drop logic).
  // If mouseUp is outside, this fires and cancels the drag.
  useEffect(() => {
    if (!draggingPanel) return;
    const handleDocumentMouseUp = () => {
      // Only cancel if still dragging — the container's onMouseUp may have already handled it
      if (useWorkspaceStore.getState().draggingPanel) {
        useWorkspaceStore.getState().endDrag();
        draggedPanelCenter.current = null;
        document.body.style.cursor = '';
      }
    };
    document.addEventListener('mouseup', handleDocumentMouseUp);
    return () => document.removeEventListener('mouseup', handleDocumentMouseUp);
  }, [draggingPanel]);

  // During drag: track mouse X and find closest drop zone
  const panelContainerRef = useRef<HTMLDivElement>(null);
  const dropZonePositions = useRef<Map<number, number>>(new Map()); // position index → X center
  const draggedPanelCenter = useRef<number | null>(null); // X center of the panel being dragged

  const registerDropZone = useCallback((position: number, el: HTMLDivElement | null) => {
    if (el) {
      const rect = el.getBoundingClientRect();
      dropZonePositions.current.set(position, rect.left + rect.width / 2);
    } else {
      dropZonePositions.current.delete(position);
    }
  }, []);

  const handleDragMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingPanel) return;
    const positions = dropZonePositions.current;
    if (positions.size === 0) return;

    // Check distance to each drop zone
    let closest: number | null = null;
    let closestDist = Infinity;
    for (const [pos, x] of positions) {
      const dist = Math.abs(e.clientX - x);
      if (dist < closestDist) {
        closestDist = dist;
        closest = pos;
      }
    }

    // If the mouse is closer to the dragged panel's own center, stay put (no move)
    if (draggedPanelCenter.current !== null) {
      const distToSelf = Math.abs(e.clientX - draggedPanelCenter.current);
      if (distToSelf <= closestDist) {
        useWorkspaceStore.getState().setDropTarget(null);
        return;
      }
    }

    useWorkspaceStore.getState().setDropTarget(closest);
  }, [draggingPanel]);

  const togglePanel = useWorkspaceStore(s => s.togglePanel);

  const handleSidebarHover = useCallback((key: string | null) => {
    const store = useWorkspaceStore.getState();
    if (!key) { store.setPanelReplacePreview(null); store.setPanelInsertPreview(null); return; }
    const panelStateKey = PANEL_MAP[key];
    if (!panelStateKey || store[panelStateKey]) { store.setPanelReplacePreview(null); store.setPanelInsertPreview(null); return; }
    const allPanels = store.panelOrder
      .filter(k => PANEL_MAP[k] !== undefined)
      .map(k => ({ key: k, open: !!store[PANEL_MAP[k]] }));
    const visibleCount = allPanels.filter(p => p.open).length;
    const MAX_VISIBLE_PANELS = 3;
    if (visibleCount < MAX_VISIBLE_PANELS) {
      store.setPanelInsertPreview(visibleCount);
      store.setPanelReplacePreview(null);
      return;
    }
    store.setPanelInsertPreview(null);
    // Same picker togglePanel uses, so the highlighted panel is the one that will actually close.
    store.setPanelReplacePreview(pickEvictionTarget(allPanels, key));
  }, []);

  const consoleBufferRef = useRef<{ level: string; text: string }[]>([]);
  const showConsoleRef = useRef(showConsole);

  // Keep showConsoleRef in sync for buffering logic (tracks both desktop and mobile)
  useEffect(() => {
    showConsoleRef.current = showConsole || activeMobilePanel === 'console';
  }, [showConsole, activeMobilePanel]);

  // Buffer previewConsole events when console is hidden
  useEffect(() => {
    const handler = (e: Event) => {
      if (!showConsoleRef.current) {
        const { level, args } = (e as CustomEvent<{ level: string; args: string[] }>).detail;
        consoleBufferRef.current.push({ level, text: args.join(' ') });
        useWorkspaceStore.getState().setHasUnreadConsole(true);
      }
    };
    window.addEventListener('previewConsole', handler);
    return () => window.removeEventListener('previewConsole', handler);
  }, []);

  // Clear unread flag when console opens (desktop or mobile)
  useEffect(() => {
    if (showConsole || activeMobilePanel === 'console') {
      useWorkspaceStore.getState().setHasUnreadConsole(false);
    }
  }, [showConsole, activeMobilePanel]);

  const clearDebugEvents = useCallback(async () => {
    await useWorkspaceStore.getState().clearChat(project.id);
    // Clear auto-checkpoints when conversation is cleared (keep manual saves)
    await checkpointManager.clearAutoCheckpoints(project.id);
    // Clearing the chat also ends any active interview (returns to the picker).
    // Note: this counts as abandoned even if the interview had already completed
    // and the user is just clearing up afterwards; acceptable minor over-count.
    const endingInterview = useWorkspaceStore.getState().activeInterview;
    if (endingInterview) {
      track('interview_abandoned', { template: bucketInterviewTemplateId(endingInterview.templateId) });
    }
    useWorkspaceStore.getState().setActiveInterview(null);
  }, [project.id]);
  
  // Derived from PANEL_MAP for the same reason as visibleBefore above: a panel missing from this
  // count sizes every rendered panel as if there were one fewer.
  const storeVisiblePanelCount = useWorkspaceStore(s => visiblePanelKeys(s).length);
  // Quick edit's pair is not in the store, so it is counted from the flags it actually renders.
  const visiblePanelCount = quick ? Number(showChat) + Number(showPreview) + Number(showElements) : storeVisiblePanelCount;
  const baseSize = visiblePanelCount > 0 ? Math.floor(100 / visiblePanelCount) : 100;

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return 'Select Model';
    const parts = modelId.split('/');
    const modelName = parts[parts.length - 1];
    return modelName
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  const truncateHtmlSnippet = useCallback((html: string, maxLength: number = 1200) => {
    if (!html) {
      return '';
    }
    if (html.length <= maxLength) {
      return html;
    }
    const headLength = Math.max(0, Math.floor(maxLength * 0.6));
    const tailLength = Math.max(0, Math.floor(maxLength * 0.3));
    const head = html.slice(0, headLength);
    const tail = tailLength > 0 ? html.slice(-tailLength) : '';
    return `${head}\n  (...truncated...)\n${tail}`;
  }, []);

  // Truncate an HTML snippet so the given marker comment stays visible with
  // surrounding context on both sides. Used for semantic block drops where the
  // marker's position is the whole point of the snippet — head/tail truncation
  // would drop the marker whenever it falls in the middle of a large parent.
  const truncateHtmlAroundMarker = useCallback((html: string, marker: string, maxLength: number = 1200) => {
    if (!html) return '';
    if (html.length <= maxLength) return html;
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
      // Fall back to head/tail when the marker isn't present
      const headLength = Math.max(0, Math.floor(maxLength * 0.6));
      const tailLength = Math.max(0, Math.floor(maxLength * 0.3));
      const head = html.slice(0, headLength);
      const tail = tailLength > 0 ? html.slice(-tailLength) : '';
      return `${head}\n  (...truncated...)\n${tail}`;
    }
    const half = Math.max(0, Math.floor((maxLength - marker.length) / 2));
    const start = Math.max(0, markerIdx - half);
    const end = Math.min(html.length, markerIdx + marker.length + half);
    const prefix = start > 0 ? '(...truncated...)\n' : '';
    const suffix = end < html.length ? '\n(...truncated...)' : '';
    return `${prefix}${html.slice(start, end)}${suffix}`;
  }, []);

  const describeFocusTarget = useCallback((target: FocusTarget) => {
    const attributeEntries = Object.entries(target.attributes || {}).slice(0, 6);
    if (attributeEntries.length === 0) {
      return `<${target.tagName}>`;
    }
    const summary = attributeEntries
      .map(([key, value]) => {
        const trimmed = value.length > 40 ? `${value.slice(0, 37)}…` : value;
        return `${key}="${trimmed}"`;
      })
      .join(' ');
    return `<${target.tagName} ${summary}>`;
  }, []);

  const formatFocusContextBlock = useCallback((target: FocusTarget) => {
    const descriptor = describeFocusTarget(target);
    const snippet = truncateHtmlSnippet(target.outerHTML, 1200);
    const domPath = target.domPath || '(unknown path)';
    return [
      'Focus context:',
      `- Target: ${descriptor}`,
      `- DOM path: ${domPath}`,
      '- HTML snippet:',
      '```html',
      snippet,
      '```'
    ].join('\n');
  }, [describeFocusTarget, truncateHtmlSnippet]);

  const formatPlacedBlocksContext = useCallback((blocks: PlacedBlock[]) => {
    if (blocks.length === 0) return '';
    const lines = [
      'Semantic blocks to implement:',
      'The user has placed the following semantic blocks at specific positions in the preview. Each block\'s HTML context below contains an HTML comment marker of the form `<!-- INSERT <block name> HERE -->` at the exact drop position — implement the block at that location. The user chose this position intentionally, so honor it precisely; adapt the block\'s layout and content to fit the surrounding context, and match the existing project\'s styling, colors, fonts, and conventions. Use placeholder/sample content where needed.',
      '',
    ];
    blocks.forEach((placed, index) => {
      const block = getBlockById(placed.blockId);
      if (!block) return;
      lines.push(`[${index + 1}] ${block.name} (page: ${placed.page})`);
      lines.push(`    Description: ${block.description}`);
      if (placed.htmlContext) {
        const marker = `<!-- INSERT ${block.name} HERE -->`;
        const snippet = truncateHtmlAroundMarker(placed.htmlContext, marker, 1200);
        lines.push(`    Insert position in context (look for \`${marker}\`):`);
        lines.push('    ```html');
        lines.push(`    ${snippet}`);
        lines.push('    ```');
      } else {
        lines.push(`    Position: insert ${placed.position} ${placed.domPath}`);
      }
      lines.push('');
    });
    return lines.join('\n');
  }, [truncateHtmlAroundMarker]);

  /**
   * Apply the inclusion rule to a pending write of `next` over the current selection.
   *
   * Called *before* `setFocusContext`, because the decision reads the selection being replaced. One
   * accessor rather than the rule spelled out at each of the four selection writers — the decision
   * itself is `focusInclusionAfterWrite`, this is only the dispatch.
   */
  const carryFocusInclusion = useCallback((next: FocusContextPayload | null, surface: SelectionSurface) => {
    const state = useWorkspaceStore.getState();
    state.setFocusIncluded(focusInclusionAfterWrite(
      state.focusContext,
      next,
      state.focusIncluded,
      surface,
      supportsDirectEditing(state.projectRuntime),
    ));
  }, []);

  /** Clears both the selection and the inclusion flag together. */
  const clearFocusSelection = useCallback((surface: SelectionSurface) => {
    carryFocusInclusion(null, surface);
    useWorkspaceStore.getState().setFocusContext(null);
    lastFocusSignatureRef.current = null;
    focusPathRef.current = null;
  }, [carryFocusInclusion]);

  /**
   * Release the inclusion, and let the surface decide whether the selection goes with it.
   *
   * Shared by the composer chip's ✕ and the post-send cleanup, because they are the same event:
   * the element's turn in the message is over.
   */
  const releaseFocusInclusion = useCallback((surface: SelectionSurface) => {
    if (focusInclusionRelease(surface).clearSelection) {
      clearFocusSelection(surface);
      return;
    }
    useWorkspaceStore.getState().setFocusIncluded(false);
  }, [clearFocusSelection]);

  const handleFocusSelection = useCallback((selection: FocusContextPayload | null, surface: SelectionSurface) => {
    if (!selection) {
      clearFocusSelection(surface);
      return;
    }
    const signature = focusSignature(selection);
    const now = Date.now();
    if (lastFocusSignatureRef.current && lastFocusSignatureRef.current.signature === signature && (now - lastFocusSignatureRef.current.timestamp) < 400) {
      return;
    }
    const nextTarget: FocusTarget = {
      ...selection,
      timestamp: now
    };
    carryFocusInclusion(selection, surface);
    useWorkspaceStore.getState().setFocusContext(nextTarget);
    lastFocusSignatureRef.current = { signature, timestamp: now };
    // Which page the selection was made on. `domPath` carries no page identity, so this is the only
    // thing that stops a re-resolve after an in-preview navigation binding the selection to
    // whatever element the same path happens to hit on the new page.
    // Asked of the surface the selection was made on, which the caller states. The mobile tree
    // can make selections now that the Inspector runs there, and the desktop instance's active
    // path is not the one this selection belongs to.
    const madeOn = surface === 'mobile' ? mobilePreviewRef.current : desktopPreviewRef.current;
    focusPathRef.current = madeOn?.getActivePath?.() ?? null;
  }, [carryFocusInclusion, clearFocusSelection]);

  // One handler per mount, so the surface is stated in the JSX that already knows it rather than
  // guessed at from a viewport. `onFocusSelection` takes a one-argument callback, so this is also
  // the only place the extra argument can come from.
  const handleDesktopFocusSelection = useCallback(
    (selection: FocusContextPayload | null) => handleFocusSelection(selection, 'desktop'),
    [handleFocusSelection]);
  const handleMobileFocusSelection = useCallback(
    (selection: FocusContextPayload | null) => handleFocusSelection(selection, 'mobile'),
    [handleFocusSelection]);

  /** A re-resolved selection, taken silently. Separate from the click path for dedup reasons. */
  const handleSelectionResolved = useCallback((message: Extract<PreviewMessage, { type: 'selection-resolved' }>) => {
    const payload = message.payload;
    const now = Date.now();
    if (!payload) {
      // The element is gone — edited away, or the page changed under us. Keeping the old payload
      // would send the agent the `outerHTML` of something that no longer exists.
      clearFocusSelection('desktop');
      return;
    }
    carryFocusInclusion(payload, 'desktop');
    useWorkspaceStore.getState().setFocusContext({ ...payload, timestamp: now });
    lastFocusSignatureRef.current = { signature: focusSignature(payload), timestamp: now };
  }, [carryFocusInclusion, clearFocusSelection]);

  // The Elements panel is a sibling of the preview in the panel map, so the frame's tree replies
  // have to be lifted through here. Stable identities: `onTreeLevel`/`onTreeStale` sit in the
  // preview's message-listener dependencies, and an inline arrow would tear that listener down and
  // re-add it on every workspace render.
  // Every one of these goes to the Inspector the viewport is showing: both trees can have one
  // mounted, and a reply delivered to the hidden instance is a reply the person never sees.
  const handleTreeLevel = useCallback((message: Extract<PreviewMessage, { type: 'tree-level' }>) => {
    inspectorTargets().panel?.handleTreeLevel(message);
  }, [inspectorTargets]);

  const handleTreeLevels = useCallback((message: Extract<PreviewMessage, { type: 'tree-levels' }>) => {
    inspectorTargets().panel?.handleTreeLevels(message);
  }, [inspectorTargets]);

  const handleTreeStale = useCallback(() => {
    inspectorTargets().panel?.handleTreeStale();
  }, [inspectorTargets]);

  const handleStyleComputed = useCallback((message: Extract<PreviewMessage, { type: 'style-computed' }>) => {
    inspectorTargets().panel?.handleStyleComputed(message);
  }, [inspectorTargets]);

  const handleStyleProbeResult = useCallback((message: Extract<PreviewMessage, { type: 'style-probe-result' }>) => {
    inspectorTargets().panel?.handleStyleProbeResult(message);
  }, [inspectorTargets]);

  // Declared before `handleFrameReady`, which needs it: the frame-ready path is the one that asks
  // the new document to resolve the selection again.
  /**
   * The preview the Inspector is looking at: the one the viewport is showing.
   *
   * Both trees are mounted at once, so "the preview" is ambiguous without this. Reading it through
   * a function rather than choosing a ref object keeps the choice current at call time, which
   * matters because a viewport can change under a mounted panel.
   */
  const sendToPreviewFrame = useCallback((message: PreviewHostMessage) => {
    inspectorTargets().preview?.sendToFrame(message);
  }, [inspectorTargets]);

  const handleFrameReady = useCallback(() => {
    const { panel, preview, surface } = inspectorTargets();
    panel?.handleFrameReady();
    // A recompile mints a new document, so the `nodeId` in the focus context is dead while the
    // context itself survives — nothing clears it on frame-ready. `domPath` is the handle that
    // outlives the document, and this turns it back into one the frame can be asked about. The
    // decision, guard included, is `focusReloadAction`; this is only the dispatch.
    const action = focusReloadAction(
      useWorkspaceStore.getState().focusContext,
      focusPathRef.current,
      preview?.getActivePath?.() ?? null,
    );
    if (action.kind === 'none') return;
    if (action.kind === 'clear') {
      clearFocusSelection(surface);
      return;
    }
    sendToPreviewFrame({ type: 'selection-resolve', domPath: action.domPath });
  }, [sendToPreviewFrame, clearFocusSelection, inspectorTargets]);

  /**
   * A button on the preview toolbar was pressed.
   *
   * The decision is `applyToolbarAction`, which also performs the panel side effect; this is the
   * dispatch for everything that needs React state or the frame.
   */
  /** Routes through handleSidebarHover so the dashed outline matches the panel togglePanel would close. */
  const handleToolbarHover = useCallback((message: Extract<PreviewMessage, { type: 'toolbar-hover' }>) => {
    handleSidebarHover(message.action === 'style' ? 'elements' : null);
  }, [handleSidebarHover]);

  const handleToolbarAction = useCallback((message: Extract<PreviewMessage, { type: 'toolbar-action' }>) => {
    // Quick edit keeps its panel flags in local state, so the store's showElements/togglePanel
    // would report and flip the wrong thing. What Style needs is "ensure the inspector is open",
    // and togglePanel is only called when showElements is false -- so a layout that always reports
    // closed, paired with a setter that opens rather than toggles, is both correct and immune to
    // reading a stale flag out of this callback's closure.
    const effect = applyToolbarAction(message.action, quick
      ? { showElements: false, togglePanel: () => setQuickPanels((p) => ({ ...p, elements: true })) }
      : useWorkspaceStore.getState());
    // The toolbar is mounted against whichever preview is on screen, so the press is attributed
    // to that surface.
    const { surface } = inspectorTargets();
    if (effect.tab) {
      setElementsTab(effect.tab);
      // Opening the Inspector is a panel flag, which on a phone is the active panel rather than
      // one of a set shown side by side. Without this, Style opened a panel off screen.
      if (surface === 'mobile') useWorkspaceStore.getState().setActiveMobilePanel('elements');
    }
    if (effect.replaceImage) setImagePickerOpen(true);
    if (effect.editText) setTextPopoverOpen(true);
    if (effect.clearSelection) {
      clearFocusSelection(surface);
      // The frame never decides a selection is over, so the toolbar outlives the tool that made it
      // until this says otherwise.
      sendToPreviewFrame({ type: 'selection-clear' });
    }
    if (effect.include) {
      // The one place the flag is raised. Everything else either lowers it or, for a write naming
      // the same element, carries it — see `focusInclusionAfterWrite`.
      useWorkspaceStore.getState().setFocusIncluded(true);
      // On a phone one panel is on screen at a time, so including an element and leaving the
      // person on the preview hides the very thing they just added it to. Desktop shows the chat
      // alongside and needs no move.
      if (surface === 'mobile') useWorkspaceStore.getState().setActiveMobilePanel('chat');
    }
  }, [sendToPreviewFrame, clearFocusSelection, quick, inspectorTargets]);

  const handleOpenPreviewPanel = useCallback(() => {
    // Same split as the toolbar action: in quick edit the preview is a local flag, not the store's.
    if (quick) {
      setQuickPanels((p) => ({ ...p, preview: true }));
      return;
    }
    if (!useWorkspaceStore.getState().showPreview) {
      useWorkspaceStore.getState().togglePanel('preview');
    }
  }, [quick]);

  /** Desktop only. Arms the preview's element picker from the Inspector's empty state. */
  const handleArmFocusTool = useCallback(() => {
    // The hover preview belongs to the gesture that is now over. Cleared before the panel work,
    // because opening a panel is what decides the strip's contents.
    handleSidebarHover(null);
    const store = useWorkspaceStore.getState();
    // Both halves of the hover feedback end with the press, whichever way the toggle went. The
    // button clears them on the way in too; this is the guarantee that does not depend on it.
    store.setFocusToolHinted(false);
    const press = focusToolPress({ armed: store.focusToolArmed });
    if (press.openPreview) handleOpenPreviewPanel();
    store.setFocusToolArmed(press.armed);
  }, [handleSidebarHover, handleOpenPreviewPanel]);

  /** The pointer is on that button. See {@link previewHoverHighlight} for why this is two cases. */
  const handleSelectElementHover = useCallback((hovering: boolean) => {
    const store = useWorkspaceStore.getState();
    // The preview *panel* highlight below says where the press sends you; this says which control in
    // that panel it is about. One signal drives both, so the crosshair's tint cannot outlive the
    // panel outline — and it is written before the switch, whose every case returns.
    store.setFocusToolHinted(hovering);
    switch (previewHoverHighlight({ hovering, previewOpen: store.showPreview })) {
      case 'panel':
        store.setPanelInsertPreview(null);
        store.setPanelReplacePreview('preview');
        return;
      case 'route':
        handleSidebarHover('preview');
        return;
      case 'clear':
        handleSidebarHover(null);
        return;
    }
  }, [handleSidebarHover]);

  /** isGenerating injected because lib/direct-edit/ must not import lib/stores/. */
  const applyStyle = useMemo(
    () => buildApplyStyle(project.id, {
      apply: applyStyleOverride,
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
    }),
    [project.id],
  );

  /** Separate from applyStyle; different arguments and independently optional. */
  const removeStyle = useMemo(
    () => buildRemoveStyle(project.id, {
      remove: removeStyleOverride,
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
    }),
    [project.id],
  );

  /**
   * What `/overrides.css` already declares for one element — the Styles tab's Reset, after a reload.
   *
   * Bound to the project like the two above, but with no generation gate: it reads a file and writes
   * nothing, and the removal it enables is gated where the race actually is.
   */
  const readOverrides = useMemo(
    () => (markerId: string) => readOverriddenProperties(project.id, markerId),
    [project.id],
  );

  // Re-read on every file change: a token the agent just renamed must not go on being offered.
  // Only while the panel is open — the read pulls every file's content out of storage, and the
  // panel is closed by default, so nobody who is not using this pays for it.
  const colorTokens = useProjectColorTokens(showElements ? project.id : null, refreshTrigger);

  /**
   * The bytes behind the selected image, for the Styles tab's CONTENT preview.
   *
   * Gated on the element actually being an image — `elementKind` is the same decision the toolbar's
   * middle slot and the CONTENT section are built from — so a `<script src>` or an `<iframe src>`
   * does not send the hook looking for a picture. Gated on the panel being open for the reason
   * `colorTokens` is: this reads a file out of storage, and nobody who is not using the Inspector
   * should pay for it.
   */
  const selectedImageSrc = focusContext && elementKind(focusContext) === 'image'
    ? focusContext.attributes?.src
    : undefined;
  const selectedImageUrl = useSelectedImageUrl(
    showElements ? project.id : null,
    selectedImageSrc,
    refreshTrigger,
  );

  /**
   * The Styles tab's **Replace** control, opening the picker the toolbar's `Replace` already opens.
   *
   * The same `imagePickerOpen` state and the same `handleReplaceImage` write, deliberately: the
   * picker resolves its target from `focusContext` at apply time, so one mount serves both entry
   * points and there is no second dialog to keep in step.
   */
  const handleOpenImagePicker = useCallback(() => setImagePickerOpen(true), []);

  const handleOpenStyleFile = useCallback(async (path: string) => {
    try {
      handleFileSelectRef.current?.(await vfs.readFile(project.id, path));
    } catch {
      toast.error(`Could not open ${path}`);
    }
  }, [project.id]);

  /**
   * The Styles tab handing a message to the chat rather than starting a run.
   *
   * The panel knows a property did not take, not what the person wants instead, so the text lands
   * in the composer for them to finish and send. The chat is brought into view with it: on a phone
   * that means making it the active panel, and in quick edit opening the panel if it is closed.
   */
  const handleStyleAskAgent = useCallback((prompt: string) => {
    const store = useWorkspaceStore.getState();
    store.appendComposerDraft(prompt);
    if (inspectorTargets().surface === 'mobile') {
      store.setActiveMobilePanel('chat');
      return;
    }
    if (quick) {
      setQuickPanels((p) => ({ ...p, chat: true }));
      return;
    }
    if (!store.showChat) store.togglePanel('chat');
  }, [inspectorTargets, quick]);

  /**
   * The toolbar's **Replace** write, bound to this project.
   *
   * Reads the selection at call time rather than closing over it, for the same reason the style
   * commit does: the dialog can outlive the click that opened it, and the write must be against the
   * element it is about. A selection that has gone away between the press and the pick is reported
   * as `unresolvable` — the picker's banner for "nothing to replace here" — rather than written
   * against whatever is selected now.
   *
   * **Not silent.** This writes a source file, so every `data-osw-src` after the edit shifts and the
   * recompile is what makes the preview and the toolbar agree with the file again. Nothing here asks
   * for the toolbar back: it returns through the `selection-resolve` handshake on frame-ready.
   */
  const handleReplaceImage = useCallback(async (path: string, confirmedMultiInstance: boolean) => {
    const focus = useWorkspaceStore.getState().focusContext;
    if (!focus) return { ok: false, reason: 'unresolvable' as const, filesWritten: [] };
    return applyImageSrc(project.id, toPreviewSelection(focus), path, {
      confirmedMultiInstance,
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
    });
  }, [project.id]);

  /**
   * What the selected element says, for the toolbar's **Text** popover.
   *
   * Read from source rather than taken off the selection payload: the payload carries the *rendered*
   * text, and the rendered text is not what will be written. A run the template computes renders
   * perfectly well and is refused — a verdict only the source can give.
   */
  const handleReadText = useCallback(async () => {
    const focus = useWorkspaceStore.getState().focusContext;
    if (!focus) return { ok: false as const, reason: 'unresolvable' as const };
    return readSourceText(project.id, toPreviewSelection(focus));
  }, [project.id]);

  /**
   * The toolbar's **Text** write, bound to this project.
   *
   * Reads the selection at call time rather than closing over it, for the same reason the Replace
   * write does: the dialog can outlive the click that opened it, and the write must be against the
   * element it is about.
   *
   * **Not silent.** This writes a source file, so every `data-osw-src` after the edit shifts and the
   * recompile is what makes the preview and the toolbar agree with the file again. Nothing here asks
   * for the toolbar back: it returns through the `selection-resolve` handshake on frame-ready.
   */
  const handleApplyText = useCallback(async (text: string, confirmedMultiInstance: boolean) => {
    const focus = useWorkspaceStore.getState().focusContext;
    if (!focus) return { ok: false, reason: 'unresolvable' as const, filesWritten: [] };
    return applyText(project.id, toPreviewSelection(focus), text, {
      confirmedMultiInstance,
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
    });
  }, [project.id]);

  const handleRefreshPreviewForStyles = useCallback(() => {
    useWorkspaceStore.getState().bumpRefreshTrigger();
  }, []);

  const handlePlacementToggle = useCallback(() => {
    useWorkspaceStore.getState().setPaletteOpen(!useWorkspaceStore.getState().paletteOpen);
  }, []);

  const handlePlacementComplete = useCallback((payload: PlacementResult) => {
    const currentPage = previewRef.current?.getActivePath?.() || '/';
    useWorkspaceStore.setState(s => ({ placedBlocks: [...s.placedBlocks, {
      blockId: payload.blockId,
      placementId: payload.placementId,
      domPath: payload.domPath,
      position: payload.position,
      page: currentPage,
      htmlContext: payload.htmlContext,
    }] }));
  }, []);

  const handleRemovePlacedBlock = useCallback((placementId: string) => {
    useWorkspaceStore.setState(s => ({ placedBlocks: s.placedBlocks.filter(b => b.placementId !== placementId) }));
    previewRef.current?.removePlaceholder(placementId);
  }, []);

  const handleClearPlacedBlocks = useCallback(() => {
    placedBlocks.forEach(b => previewRef.current?.removePlaceholder(b.placementId));
    useWorkspaceStore.setState({ placedBlocks: [] });
  }, [placedBlocks]);

  /** The preview as it is, at a width a model can read, for the composer's Screenshot item. */
  const handleCaptureContextScreenshot = useCallback(
    () => previewRef.current?.captureScreenshot(false, { outputWidth: 1280 }) ?? Promise.resolve(null),
    [],
  );

  const handleClosePreview = useCallback(() => {
    // Quick edit's panels are the workspace's own flags, not the store's.
    if (quick) setQuickPanels((p) => ({ ...p, preview: false }));
    else useWorkspaceStore.getState().togglePanel('preview');
  }, [quick]);

  const handleEnterFullscreen = useCallback(() => {
    useWorkspaceStore.getState().setFullscreenPreview(true);
  }, []);

  const handleExitFullscreen = useCallback(() => {
    useWorkspaceStore.getState().setFullscreenPreview(false);
  }, []);

  // Listen for showPreview event (dispatched by AI preview command).
  // Only opens the panel — never toggles it closed if already open.
  const showPreviewRef = useRef(showPreview);
  showPreviewRef.current = showPreview;
  useEffect(() => {
    const handler = () => {
      if (!showPreviewRef.current) togglePanel('preview');
    };
    window.addEventListener('showPreview', handler);
    return () => window.removeEventListener('showPreview', handler);
  }, [togglePanel]);

  const handleSetEntryPoint = useCallback(async (path: string) => {
    try {
      const proj = await vfs.getProject(project.id);
      proj.settings = { ...proj.settings, previewEntryPoint: path };
      await vfs.updateProject(proj);
      vfs.scheduleAutoSync(proj.id);
      useWorkspaceStore.getState().updateProjectSettings({ previewEntryPoint: path });
      toast.success(`Entry point set to ${path}`);
    } catch (err) {
      logger.error('Failed to set entry point:', err);
      toast.error('Failed to set entry point');
    }
  }, [project.id]);

  const handleAddPromptFile = useCallback(async () => {
    try {
      const { getDomainPrompt } = await import('@/lib/llm/prompts');
      const runtime = projectRuntime || 'handlebars';
      await vfs.createFile(project.id, '/.PROMPT.md', getDomainPrompt(runtime));
      window.dispatchEvent(new CustomEvent('filesChanged', { detail: { projectId: project.id } }));
      toast.success('.PROMPT.md added to project');
    } catch (err) {
      logger.error('Failed to add .PROMPT.md:', err);
      toast.error('Failed to add .PROMPT.md');
    }
  }, [project.id, projectRuntime]);

  /**
   * The selection *as the composer sees it* — the third read on the send path, and the one that is
   * visible. Gated separately from `focusMessageContext` rather than through it, so that removing
   * either gate leaves the other standing and the disagreement is a test failure rather than a
   * silent leak past an empty-looking composer.
   */
  const includedFocus = focusIncluded ? focusContext : null;
  const focusPreviewSnippet = includedFocus ? truncateHtmlSnippet(includedFocus.outerHTML, 240) : '';

  /**
   * The composer chip's ✕, once per mount.
   *
   * On desktop it is a retarget, not a deselect: the user is taking the element out of their
   * message, not out of the Inspector, and clearing `focusContext` would take the toolbar and the
   * Styles tab down with it. On mobile it clears the selection outright, which is both what it does
   * today and the only coherent answer where selecting is the act of including — see
   * `focusInclusionRelease`.
   */
  const handleDesktopClearFocus = useCallback(() => releaseFocusInclusion('desktop'), [releaseFocusInclusion]);
  const handleMobileClearFocus = useCallback(() => releaseFocusInclusion('mobile'), [releaseFocusInclusion]);

  useEffect(() => {
    const dirty = saveManager.isDirty(project.id);
    if (dirty) useWorkspaceStore.getState().markDirty();
    else useWorkspaceStore.getState().markClean();
    const unsubscribe = saveManager.subscribe(({ projectId, dirty: d }) => {
      if (projectId === project.id) {
        if (d) useWorkspaceStore.getState().markDirty();
        else useWorkspaceStore.getState().markClean();
      }
    });
    return () => unsubscribe();
  }, [project.id]);

  useEffect(() => {
    let isMounted = true;

    const initializeWorkspace = async () => {
      // Dismiss immediately so the generation shelf clears even if async init is slow
      useWorkspaceStore.getState().dismissGenerationResult(project.id);

      try {
        // In server mode, check if server has newer version before loading
        if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true') {
          try {
            const { checkServerUpdates, pullServerUpdates, setAutoSyncWorkspaceId } = await import('@/lib/vfs/auto-sync');
            if (workspaceId) {
              setAutoSyncWorkspaceId(workspaceId);
            }
            const hasUpdates = await checkServerUpdates(project.id);
            if (hasUpdates) {
              await pullServerUpdates(project.id, false);
              logger.debug(`[Workspace] Pulled server updates for project ${project.id}`);
            }
          } catch (syncErr) {
            logger.warn('[Workspace] Server check failed, using local state:', syncErr);
          }
        }

        // Discard uses lastSavedCheckpointId. Do not restore files on open: that discarded
        // unsaved work (and any server files just pulled) under a document-editor rule that
        // fights two-store sync.
        await saveManager.syncProjectSaveState(project.id);
        const savedCheckpointId = saveManager.getSavedCheckpointId(project.id);
        if (savedCheckpointId) {
          const exists = await checkpointManager.checkpointExists(savedCheckpointId);
          if (exists) {
            useWorkspaceStore.setState({ initialCheckpointId: savedCheckpointId });
          } else {
            // Stale reference — checkpoint was pruned or deleted.
            // preserveUpdatedAt: checkpoint bookkeeping is local-only and is not pushed, so
            // bumping updatedAt would leave the project permanently reading as "Local newer".
            const proj = await vfs.getProject(project.id);
            proj.lastSavedCheckpointId = null;
            await vfs.updateProject(proj, { preserveUpdatedAt: true });
          }
        }

        if (!isMounted) return;

        const latestProject = await vfs.getProject(project.id);
        if (!isMounted) return;
        useWorkspaceStore.getState().initProject(latestProject);
        const savedAt = latestProject.lastSavedAt ? new Date(latestProject.lastSavedAt).getTime() : NaN;
        const syncedAt = latestProject.lastSyncedAt ? new Date(latestProject.lastSyncedAt).getTime() : NaN;
        const updatedAt = latestProject.updatedAt ? new Date(latestProject.updatedAt).getTime() : NaN;
        const baseline = Number.isFinite(savedAt) ? savedAt : syncedAt;
        if (Number.isFinite(baseline) && Number.isFinite(updatedAt) && updatedAt > baseline) {
          saveManager.markDirty(project.id);
        }
        if (saveManager.isDirty(project.id)) useWorkspaceStore.getState().markDirty();

        // Ensure a starting-point checkpoint exists so the user can always roll back.
        // preserveUpdatedAt: this fires on the first open of every project, including one that
        // was just imported and pushed. Bumping updatedAt here is a local write nothing pushes,
        // so it left freshly imported projects stuck on "Local newer" in Server Sync.
        if (!latestProject.lastSavedCheckpointId) {
          try {
            const cp = await checkpointManager.createCheckpoint(project.id, 'Project opened', { kind: 'auto' });
            latestProject.lastSavedCheckpointId = cp.id;
            latestProject.lastSavedAt = latestProject.updatedAt;
            await vfs.updateProject(latestProject, { preserveUpdatedAt: true });
            useWorkspaceStore.setState({ initialCheckpointId: cp.id });
          } catch { /* non-fatal */ }
        }
        // Initialize mode from localStorage (migrating the legacy chat-mode key)
        if (typeof window !== 'undefined') {
          const storedMode = localStorage.getItem('osw-studio-mode');
          if (storedMode === 'chat' || storedMode === 'interview' || storedMode === 'code') {
            useWorkspaceStore.setState({ mode: storedMode });
          } else if (localStorage.getItem('osw-studio-chat-mode') === 'true') {
            useWorkspaceStore.setState({ mode: 'chat' });
            localStorage.setItem('osw-studio-mode', 'chat');
          }
        }
        // Initialize the active interview from localStorage (per project)
        if (typeof window !== 'undefined') {
          let restored = null;
          const stored = localStorage.getItem(`osw-interview-${project.id}`);
          if (stored) {
            try {
              const parsed = JSON.parse(stored);
              if (parsed && typeof parsed.templateId === 'string' && typeof parsed.title === 'string') {
                restored = { templateId: parsed.templateId, title: parsed.title };
              }
            } catch { /* ignore malformed */ }
          }
          useWorkspaceStore.setState({ activeInterview: restored });
        }
        // Initialize backendEnabled from localStorage
        if (migrateBackendKey(project.id)) {
          useWorkspaceStore.getState().setBackendEnabled(true);
        }

        logger.debug(`[Workspace] Initializing workspace for project: ${project.id}`);

        // Initialize store persistence and load debug events
        useWorkspaceStore.getState().initPersistence(project.id);
        useWorkspaceStore.getState().initLayout();
        useWorkspaceStore.getState().setCurrentModel(configManager.getDefaultModel());
        try {
          await useWorkspaceStore.getState().loadDebugEvents(project.id);
          if (!isMounted) return;
        } catch (error) {
          if (!isMounted) return;
          logger.error('Failed to load debug events:', error);
        }
        useWorkspaceStore.setState({ workspaceReady: true });
      } catch (error) {
        if (!isMounted) return;
        logger.error('Failed to initialize workspace:', error);
        useWorkspaceStore.setState({ workspaceReady: true });
      }
    };

    initializeWorkspace();

    const updateProjectCost = async () => {
      try {
        const currentProject = await vfs.getProject(project.id);
        if (!isMounted) return;
        if (currentProject?.costTracking?.totalCost) {
          useWorkspaceStore.getState().setProjectCost(currentProject.costTracking.totalCost);
        } else {
          useWorkspaceStore.getState().setProjectCost(0);
        }
      } catch {
        if (!isMounted) return;
        useWorkspaceStore.getState().setProjectCost(0);
      }
    };

    updateProjectCost();
    const interval = setInterval(updateProjectCost, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [project.id]);

  useEffect(() => {
    if (!tourRunning) return;

    if (tourStep === 'provider-settings') {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tour-open-provider-settings'));
      }
    }
  }, [tourRunning, tourStep]);

  useEffect(() => {
    if (!tourRunning) {
      setWorkspaceHandler(null);
      return;
    }

    const handler = async (event: GuidedTourTranscriptEvent) => {
      // Convert tour events to debug events for ChatPanel display
      if (event.role === 'clear' && event.action === 'conversation') {
        await clearDebugEvents();
        return;
      }

      if (event.role === 'user') {
        // User message → conversation_message event
        await addDebugEvent('conversation_message', {
          message: {
            role: 'user',
            content: event.content
          }
        });
      } else if (event.role === 'assistant') {
        // Assistant message → conversation_message event
        const message: any = {
          role: 'assistant',
          content: event.content
        };

        // Store checkpoint ID in UI metadata if present
        if (event.checkpointId) {
          message.ui_metadata = {
            checkpointId: event.checkpointId
          };
        }

        await addDebugEvent('conversation_message', { message });

        // Emit checkpoint_created event if checkpoint ID is present
        if (event.checkpointId) {
          await addDebugEvent('checkpoint_created', {
            checkpointId: event.checkpointId,
            description: `Tour checkpoint: ${event.content.substring(0, 60)}`
          });
        }
      } else if (event.role === 'tool') {
        // Tool call → simulate tool execution sequence
        // 1. Tool call initiated
        const toolCall = {
          id: `tour-tool-${Date.now()}`,
          function: {
            name: event.name,
            arguments: JSON.stringify({ command: event.command })
          }
        };

        await addDebugEvent('toolCalls', {
          toolCalls: [toolCall]
        });

        // 2. Tool status (executing)
        await addDebugEvent('tool_status', {
          toolId: toolCall.id,
          name: event.name,
          status: 'executing'
        });

        // 3. Tool result
        await addDebugEvent('tool_result', {
          toolId: toolCall.id,
          name: event.name,
          result: event.output,
          status: 'completed'
        });

        // 4. Tool message in conversation
        await addDebugEvent('conversation_message', {
          message: {
            role: 'tool',
            content: event.output,
            tool_call_id: toolCall.id
          }
        });
      }
    };

    setWorkspaceHandler(handler);

    return () => {
      setWorkspaceHandler(null);
    };
  }, [tourRunning, tourStep, tourState.isBusy, setWorkspaceHandler, clearDebugEvents, addDebugEvent]);

  // Clear orchestrator when project changes (chatMode changes handled inside setChatMode action)
  useEffect(() => {
    if (!useWorkspaceStore.getState().generating) {
      useWorkspaceStore.getState().resetOrchestrator();
    }
  }, [project.id]);

  // Auto-mount/unmount project backend context based on enabled toggle
  useEffect(() => {
    let cancelled = false;
    if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true' && backendEnabled) {
      vfs.mountProjectBackendContext(project.id).then(() => {
        if (!cancelled) {
          useWorkspaceStore.getState().bumpRefreshTrigger();
        }
      });
    } else {
      vfs.unmountBackendContext();
      useWorkspaceStore.getState().bumpRefreshTrigger();
    }
    return () => { cancelled = true; };
  }, [project.id, backendEnabled]);

  // MEMORY CLEANUP: Unload project data from singletons when leaving the workspace
  // This prevents memory accumulation across project switches
  useEffect(() => {
    const projectId = project.id;

    return () => {
      const thisProjectGenerating = useWorkspaceStore.getState().isProjectGenerating(projectId);

      // Stash foreground events to background buffer before clearing, so the
      // generation shelf and re-entry can access them.
      if (thisProjectGenerating) {
        useWorkspaceStore.getState().stashForegroundEvents(projectId);
      }

      // Clear caches only if not generating (data still needed for active generation)
      if (!thisProjectGenerating) {
        checkpointManager.unloadProject(projectId);
        debugEventsState.unloadProject(projectId);
      }

      // Clean up store persistence only if not generating (debounce timer still needed)
      if (!thisProjectGenerating) {
        useWorkspaceStore.getState().cleanupPersistence();
        useWorkspaceStore.getState().resetOrchestrator();
        useWorkspaceStore.getState().clearDebugEvents();
      }
      useWorkspaceStore.getState().resetLayout();

      // Cleanup cannot be async. Flush buffers then the pending sync, same fire-and-forget
      // as the previous flushSyncTimeout-only path.
      void flushEditorToVfs().then(() => vfs.flushSyncTimeout(projectId));

      // Unmount backend context when leaving workspace
      vfs.unmountBackendContext();

      // Reset project slice state
      if (!thisProjectGenerating) {
        useWorkspaceStore.getState().resetProject();
      } else {
        // During generation, still reset workspaceReady so the next project shows loading spinners
        useWorkspaceStore.setState({ workspaceReady: false });
      }

      logger.debug(`[Workspace] Cleaned up memory for project ${projectId}`);
    };
  }, [project.id]);

  // Handle deployment selection change - mount/unmount backend context
  const handleDeploymentChange = useCallback(async (deploymentId: string | null, deploymentName: string | null) => {
    useWorkspaceStore.getState().setDeployment(deploymentId);

    // Reset orchestrator so it picks up new backend context on next message
    useWorkspaceStore.getState().resetOrchestrator();

    if (deploymentId && deploymentName) {
      await vfs.mountDeploymentRuntimeContext(deploymentId);
      logger.info(`[Workspace] Connected deployment runtime: ${deploymentName}`);
    } else {
      vfs.unmountDeploymentRuntimeContext();
      logger.info('[Workspace] Disconnected deployment runtime');
    }

    // Refresh file tree
    useWorkspaceStore.getState().bumpRefreshTrigger();
  }, []);

  // Handle backend toggle
  const handleBackendToggle = useCallback((enabled: boolean) => {
    useWorkspaceStore.getState().setBackendEnabled(enabled);
  }, []);

  // Handle project settings updates (runtime, entry point)
  const handleProjectSettingsUpdate = useCallback((updated: Project) => {
    useWorkspaceStore.getState().updateProjectSettings({
      runtime: updated.settings?.runtime,
      previewEntryPoint: updated.settings?.previewEntryPoint,
      promptSuggestions: updated.settings?.promptSuggestions ?? [],
    });
  }, []);

  const handleFileSelect = useCallback((file: VirtualFile) => {
    // Check if we're on mobile (matches Tailwind's md breakpoint)
    const isMobile = window.innerWidth < 768;

    if (isMobile) {
      // On mobile, switch to editor panel and open file
      useWorkspaceStore.getState().setActiveMobilePanel('editor');
      setTimeout(() => {
        openFileInEditor(file);
      }, 0);
    } else {
      // Desktop behavior remains the same
      if (!useWorkspaceStore.getState().showEditor) {
        useWorkspaceStore.getState().togglePanel('editor');
        setTimeout(() => {
          openFileInEditor(file);
        }, 0);
      } else {
        openFileInEditor(file);
      }
    }
  }, []);
  handleFileSelectRef.current = handleFileSelect;

  const handleFilesChange = useCallback(() => {
    useWorkspaceStore.getState().bumpRefreshTrigger();
  }, []);

  const handleSave = useCallback(async () => {
    if (useWorkspaceStore.getState().saveInProgress) {
      return;
    }

    useWorkspaceStore.setState({ saveInProgress: true });
    try {
      await flushEditorToVfs();
      const checkpoint = await saveManager.save(project.id);
      const latestProject = await vfs.getProject(project.id);

      useWorkspaceStore.setState({
        lastSavedAt: latestProject.lastSavedAt ?? new Date(checkpoint.timestamp),
        initialCheckpointId: checkpoint.id,
      });
      useWorkspaceStore.getState().incrementCheckpointRefresh();
      toast.success('Project saved');
    } catch (error) {
      logger.error('Failed to save project', error);
      toast.error('Failed to save project');
    } finally {
      useWorkspaceStore.setState({ saveInProgress: false });
    }

  }, [project.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform?.toLowerCase().includes('mac');
      const modifierPressed = isMac ? event.metaKey : event.ctrlKey;
      if (!modifierPressed) return;

      if (event.key.toLowerCase() === 's') {
        // Check if Monaco editor has focus - if so, let Monaco handle the save
        const activeElement = document.activeElement;
        const isMonacoFocused = activeElement?.closest('.monaco-editor') !== null;

        if (isMonacoFocused) {
          // Monaco editor will handle file save
          return;
        }

        // Otherwise, save the project
        event.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // The /.server/ mount is built from the backend records as they were when the project opened,
  // so a restore that rewrote those records leaves it describing the wrong ones to the AI and the
  // file tree. Returns early in browser mode, where nothing is mounted.
  const remountBackendContext = useCallback(async () => {
    if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true' || !backendEnabled) return;
    await vfs.mountProjectBackendContext(project.id);
    useWorkspaceStore.getState().bumpRefreshTrigger();
  }, [backendEnabled, project.id]);

  /**
   * Run a restore, first confirming any stored secret value it would cost. A checkpoint holds a
   * secret's name and not its value, so a restore can leave a secret empty or remove it outright;
   * nothing else a restore does is unrecoverable, and every other case goes straight through.
   */
  const runRestore = useCallback(async (
    checkpointId: string,
    description: string | undefined,
    restore: () => Promise<void>
  ) => {
    const preview = await checkpointManager.previewRestore(checkpointId);
    if (!preview || isEmptyPreview(preview)) {
      await restore();
      return;
    }
    setPendingRestore({ preview, description, restore });
  }, []);

  /**
   * Refuse anything that rewinds the project while a run is working on it.
   *
   * Restore and Retry roll files back, and Retry also truncates the conversation, both before the
   * generation they end with is attempted. That generation is refused while a task is live, which
   * would leave the rollback standing on its own: files and history rewound, no new run, and the
   * original still going and about to write over what was just undone.
   */
  const refuseWhileGenerating = useCallback(() => {
    if (!useWorkspaceStore.getState().isProjectGenerating(project.id)) return false;
    toast.info(PROJECT_BUSY_NOTICE);
    return true;
  }, [project.id]);

  const handleRestoreCheckpoint = useCallback(async (checkpointId: string, description?: string, options?: { isDiscard?: boolean }) => {
    if (refuseWhileGenerating()) return;
    try {
      const targetId = options?.isDiscard
        ? (saveManager.getSavedCheckpointId(project.id) ?? checkpointId)
        : checkpointId;
      const exists = await checkpointManager.checkpointExists(targetId);
      if (!exists) {
        toast.error('Checkpoint no longer exists - it may have been cleaned up');
        logger.warn(`[Workspace] Checkpoint ${targetId} no longer exists`);
        return;
      }

      await runRestore(targetId, description, async () => {
        const success = options?.isDiscard
          ? await saveManager.restoreLastSaved(project.id)
          : await saveManager.runWithSuppressedDirty(project.id, () =>
              checkpointManager.restoreCheckpoint(targetId)
            );
        if (success) {
          setUndoCursor(checkpointId);
          await remountBackendContext();
          toast.success(`Restored to: ${description || 'checkpoint'}`);
          track(options?.isDiscard ? 'changes_discarded' : 'checkpoint_restore');
          handleFilesChange();

          const savedId = saveManager.getSavedCheckpointId(project.id);
          if (savedId && savedId === targetId) {
            saveManager.markClean(project.id);
            const latestProject = await vfs.getProject(project.id);
            useWorkspaceStore.setState({ lastSavedAt: latestProject.lastSavedAt ?? null });
          } else {
            saveManager.markDirty(project.id);
          }
        } else {
          toast.error('Failed to restore checkpoint');
        }
      });
    } catch (error) {
      logger.error('Error restoring checkpoint:', error);
      toast.error('Failed to restore checkpoint');
    }
  }, [handleFilesChange, project.id, remountBackendContext, runRestore, refuseWhileGenerating]);

  const handleScrollToCheckpoint = useCallback((checkpointId: string) => {
    if (!useWorkspaceStore.getState().showChat) useWorkspaceStore.getState().togglePanel('chat');
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-checkpoint-id="${checkpointId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-primary/50');
        setTimeout(() => el.classList.remove('ring-2', 'ring-primary/50'), 2000);
      }
    });
  }, []);

  const handleRetry = useCallback(async (checkpointId: string) => {
    if (refuseWhileGenerating()) return;
    try {
      // First check if checkpoint exists
      const exists = await checkpointManager.checkpointExists(checkpointId);
      if (!exists) {
        toast.error('Checkpoint no longer exists - cannot retry');
        logger.warn(`[Workspace] Checkpoint ${checkpointId} no longer exists`);
        return;
      }

      // Find the user message associated with this checkpoint
      // Search backwards from the checkpoint to find the most recent user message
      let userMessageContent = null;
      const checkpointEventIndex = debugEvents.findIndex(
        e => e.event === 'checkpoint_created' && e.data?.checkpointId === checkpointId
      );

      if (checkpointEventIndex >= 0) {
        // Search backwards from checkpoint event to find user message (in conversation_message events)
        for (let i = checkpointEventIndex - 1; i >= 0; i--) {
          if (debugEvents[i].event === 'conversation_message' &&
              debugEvents[i].data?.message?.role === 'user') {
            userMessageContent = debugEvents[i].data.message.content;
            break;
          }
        }
      }

      if (!userMessageContent) {
        toast.error('Cannot find original user message to retry');
        logger.warn('[Workspace] No user message found before checkpoint');
        return;
      }

      // Find the user message event index to truncate debug events
      let userMessageIndex = -1;
      for (let i = checkpointEventIndex - 1; i >= 0; i--) {
        if (debugEvents[i].event === 'conversation_message' &&
            debugEvents[i].data?.message?.role === 'user' &&
            debugEvents[i].data.message.content === userMessageContent) {
          userMessageIndex = i;
          break;
        }
      }

      if (userMessageIndex === -1) {
        toast.error('Cannot find user message event to truncate');
        logger.warn('[Workspace] User message event not found in debug events');
        return;
      }

      // Restore the checkpoint
      await runRestore(checkpointId, undefined, async () => {
        const success = await saveManager.runWithSuppressedDirty(project.id, () =>
          checkpointManager.restoreCheckpoint(checkpointId)
        );
        if (!success) {
          toast.error('Failed to restore checkpoint');
          return;
        }
        await remountBackendContext();

        const savedId = saveManager.getSavedCheckpointId(project.id);
        if (savedId && savedId === checkpointId) {
          saveManager.markClean(project.id);
          const latestProject = await vfs.getProject(project.id);
          useWorkspaceStore.setState({ lastSavedAt: latestProject.lastSavedAt ?? null });
        } else {
          saveManager.markDirty(project.id);
        }

        // Truncate debug events to remove the user message and all subsequent events
        // The user message will be re-added by the orchestrator when generation runs
        const truncatedEvents = debugEvents.slice(0, userMessageIndex);
        useWorkspaceStore.setState({ debugEvents: truncatedEvents });
        useWorkspaceStore.getState().resetOrchestrator();
        await debugEventsState.truncateEvents(project.id, truncatedEvents);

        toast.success('Restored checkpoint and retrying...');
        handleFilesChange();

        // Retry generation with the original user message.
        // Use setTimeout so handleGenerate (declared below) is available.
        setTimeout(() => handleGenerateRef.current?.(userMessageContent), 0);
      });
    } catch (error) {
      logger.error('Error during retry:', error);
      toast.error('Failed to retry');
    }
  }, [handleFilesChange, project.id, debugEvents, remountBackendContext, runRestore, refuseWhileGenerating]);

  const storeStartGeneration = useWorkspaceStore(s => s.startGeneration);

  const handleGenerate = useCallback(async (promptText?: string, images?: PendingImage[], audio?: PendingAudio[], files?: PendingFile[], surface: SelectionSurface = 'desktop') => {
    // Clear runtime errors
    useWorkspaceStore.getState().setRuntimeErrors([]);

    let messageContent = (promptText ?? '').trim();
    const contextParts: string[] = [];
    // Both of the send path's reads of the selection, from one gate. `generationFocus` reaches the
    // sent message's context card *and* `/api/server-generate` (`orchestrator.ts`, `uiMeta` and
    // `executeOptions`), so ungating either read here puts an element the user only *selected* in
    // front of the agent.
    const included = focusMessageContext(focusContext, focusIncluded, formatFocusContextBlock);
    if (included.promptBlock) contextParts.push(included.promptBlock);
    if (placedBlocks.length > 0) contextParts.push(formatPlacedBlocksContext(placedBlocks));
    if (contextParts.length > 0) messageContent = contextParts.join('\n\n') + '\n\n' + messageContent;

    const started = await storeStartGeneration(messageContent, images, {
      mode,
      chatMode: mode === 'chat',
      projectId: project.id,
      focusContext: included.generationFocus,
      placedBlocks,
      isTourLockingInput,
      displayPrompt: (promptText ?? '').trim(),
      // Resuming an interview: keep the template's agenda available so it is
      // re-injected if the system message ever has to be rebuilt fresh.
      templateId: mode === 'interview' ? activeInterview?.templateId : undefined,
      audio,
      files,
    });

    // Nothing was sent: the project was already busy, or there is no model or key configured. The
    // request is still in the composer, so spending the inclusion and dropping the attachments and
    // placed blocks here would throw away the context for a message the person still has to send.
    if (!started) return;

    // Post-generation UI cleanup.
    //
    // The inclusion is spent either way; whether the *selection* goes with it is the surface's call
    // (`focusInclusionRelease`). On desktop it stays — the toolbar is still anchored to that element
    // and the Styles tab is still showing it, and both would go dark on every send if this cleared
    // `focusContext` the way it used to. On mobile it goes, exactly as it does today.
    handleFilesChange();
    releaseFocusInclusion(surface);
    if (placedBlocks.length > 0) {
      placedBlocks.forEach(b => previewRef.current?.removePlaceholder(b.placementId));
      useWorkspaceStore.setState({ placedBlocks: [] });
    }
  }, [storeStartGeneration, mode, activeInterview, project.id, focusContext, focusIncluded, placedBlocks, isTourLockingInput, handleFilesChange, formatFocusContextBlock, formatPlacedBlocksContext, releaseFocusInclusion]);

  /**
   * The mobile composer's send.
   *
   * The surface cannot be defaulted here the way it is for every other caller: `handleGenerate` is
   * shared by both mounts, the runtime-error shelf and the guided tour, and only the JSX knows
   * which composer the user pressed.
   */
  const handleMobileGenerate = useCallback(
    (promptText?: string, images?: PendingImage[], audio?: PendingAudio[], files?: PendingFile[]) =>
      handleGenerate(promptText, images, audio, files, 'mobile'),
    [handleGenerate]);

  const handleStartInterview = useCallback(async (template: InterviewTemplate) => {
    if (!project.id) return;
    // Ahead of clearChat: an interview starts from an empty conversation, so the wipe happens
    // before the start and a refused start would have destroyed the transcript for nothing.
    if (refuseWhileGenerating()) return;
    track('interview_started', { template: bucketInterviewTemplateId(template.id) });
    // Start fresh: an interview should not append onto a prior conversation.
    await useWorkspaceStore.getState().clearChat(project.id);
    storeSetActiveInterview({ templateId: template.id, title: template.title });
    await storeStartGeneration(template.title, undefined, {
      mode: 'interview',
      projectId: project.id,
      templateId: template.id,
    });
  }, [project.id, storeSetActiveInterview, storeStartGeneration, refuseWhileGenerating]);

  const handleHandoff = useCallback(async (handoff: InterviewHandoff) => {
    if (!project.id) return;
    // Same wipe, same ordering. The button is already disabled while generating; this is the
    // guarantee that does not depend on the button.
    if (refuseWhileGenerating()) return;
    track('handoff_used', { mode: handoff.mode });
    // End the interview and start the follow-up task fresh in its target mode.
    storeSetActiveInterview(null);
    storeSetMode(handoff.mode);
    await useWorkspaceStore.getState().clearChat(project.id);
    await storeStartGeneration(handoff.prompt, undefined, {
      mode: handoff.mode,
      chatMode: handoff.mode === 'chat',
      projectId: project.id,
    });
  }, [project.id, storeSetActiveInterview, storeSetMode, storeStartGeneration, refuseWhileGenerating]);

  handleGenerateRef.current = handleGenerate;

  const stopGeneration = useWorkspaceStore(s => s.stopGeneration);
  const continueGeneration = useWorkspaceStore(s => s.continueGeneration);
  const canContinue = useWorkspaceStore(s => s.canContinueGeneration());

  const handleStop = useCallback(() => {
    stopGeneration();
  }, [stopGeneration]);

  const handleContinue = useCallback(() => {
    continueGeneration();
  }, [continueGeneration]);

  const handleSendRuntimeErrors = useCallback(() => {
    const storeErrors = useWorkspaceStore.getState().runtimeErrors;
    const bufferErrors = drainRuntimeErrors(); // also clears the live buffer
    const errors = storeErrors.length > 0 ? storeErrors : bufferErrors;
    if (errors.length === 0) return;
    useWorkspaceStore.getState().setRuntimeErrors([]);
    handleGenerate(formatRuntimeErrors(errors));
  }, [handleGenerate]);

  const handleClearRuntimeErrors = useCallback(() => {
    drainRuntimeErrors();
    useWorkspaceStore.getState().setRuntimeErrors([]);
  }, []);

  /**
   * Undo and redo walk the project's checkpoints, oldest first.
   *
   * The list is re-read whenever a checkpoint lands, and the cursor goes back to the newest at the
   * same moment, because a new checkpoint after an undo is a new branch: there is nothing to redo
   * into any more. Restoring anything, from here or the thread, moves the cursor to it.
   */
  const latestCheckpointEventId = useMemo(() => {
    for (let i = debugEvents.length - 1; i >= 0; i--) {
      if (debugEvents[i].event === 'checkpoint_created') return debugEvents[i].id;
    }
    return null;
  }, [debugEvents]);
  useEffect(() => {
    let cancelled = false;
    setUndoCursor(null);
    checkpointManager.getCheckpoints(project.id).then((list) => {
      // getCheckpoints is newest first.
      if (!cancelled) setCheckpointIds(list.map((c) => c.id).reverse());
    }).catch(() => { /* a failed read leaves undo where it was */ });
    return () => { cancelled = true; };
  }, [project.id, latestCheckpointEventId]);
  const undoTargetId = undoTarget(checkpointIds, undoCursor);
  const redoTargetId = redoTarget(checkpointIds, undoCursor);
  const handleUndo = useCallback(() => {
    if (undoTargetId) void handleRestoreCheckpoint(undoTargetId, 'the previous change');
  }, [undoTargetId, handleRestoreCheckpoint]);
  const handleRedo = useCallback(() => {
    if (redoTargetId) void handleRestoreCheckpoint(redoTargetId, 'the change after');
  }, [redoTargetId, handleRestoreCheckpoint]);

  const headerActions: HeaderAction[] = [
    {
      id: 'back',
      label: backLabel ?? 'Back to projects',
      icon: ArrowLeft,
      onClick: guardedBack,
      variant: 'outline'
    }
  ];

  if (quick) {
    headerActions.push(
      { id: 'undo', label: 'Undo', icon: Undo2, onClick: handleUndo, variant: 'outline', disabled: !undoTargetId || generating },
      { id: 'redo', label: 'Redo', icon: Redo2, onClick: handleRedo, variant: 'outline', disabled: !redoTargetId || generating },
    );
  }

  headerActions.push({
    id: 'save',
    label: saveInProgress ? 'Saving…' : isDirty ? 'Save' : 'Saved',
    icon: Save,
    onClick: handleSave,
    variant: isDirty ? 'default' : 'outline',
    disabled: !isDirty || saveInProgress
  });

  const discardCheckpointId = saveManager.getSavedCheckpointId(project.id) ?? initialCheckpointId;

  if (discardCheckpointId && quick) {
    headerActions.push({
      id: 'discard',
      label: 'Discard Changes',
      icon: RotateCcw,
      onClick: () => handleRestoreCheckpoint(discardCheckpointId, 'Last saved state', { isDiscard: true }),
      variant: 'outline',
      disabled: saveInProgress || !isDirty,
    });
  } else if (discardCheckpointId) {
    const discardDisabled = saveInProgress || !isDirty;
    headerActions.push({
      id: 'discard',
      label: 'Discard Changes',
      onClick: () => {},
      content: (
        <div className="flex items-center" data-tour-id="discard-changes-button">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleRestoreCheckpoint(discardCheckpointId, 'Last saved state', { isDiscard: true })}
            disabled={discardDisabled}
            className="rounded-r-none border-r-0"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Discard Changes
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => togglePanel('checkpoints')}
                onMouseEnter={() => {
                  if (showCheckpoints) {
                    useWorkspaceStore.getState().setPanelReplacePreview('checkpoints');
                  } else {
                    handleSidebarHover('checkpoints');
                  }
                }}
                onMouseLeave={() => {
                  useWorkspaceStore.getState().setPanelReplacePreview(null);
                  useWorkspaceStore.getState().setPanelInsertPreview(null);
                }}
                disabled={saveInProgress}
                className="rounded-l-none px-2 group/chev"
                aria-label={showCheckpoints ? 'Close checkpoints panel' : 'Open checkpoints panel'}
              >
                {showCheckpoints
                  ? <ChevronUp className="h-4 w-4 transition-transform group-hover/chev:-translate-y-0.5" />
                  : <ChevronDown className="h-4 w-4 transition-transform group-hover/chev:translate-y-0.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showCheckpoints ? 'Close checkpoints' : 'All checkpoints'}
            </TooltipContent>
          </Tooltip>
        </div>
      )
    });
  }

  // Deploy is always available — every project can at least be exported as a ZIP. The modal's
  // target picker handles per-target availability (HuggingFace Space, this OSW Studio instance,
  // ZIP) and shows connection/enable paths for the ones that aren't ready.

  // Desktop header content: Deployment selector + Settings
  const desktopHeaderContent = (
    <div className="flex items-center gap-3">
      {/* Deployment selector for backend context */}
      <DeploymentSelector
        projectId={project.id}
        selectedDeploymentId={selectedDeploymentId}
        onDeploymentChange={handleDeploymentChange}
        workspaceId={workspaceId}
      />

      {/* Deploy (HuggingFace Space, OSW Studio instance, or ZIP) */}
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-3 flex items-center gap-2"
        onClick={() => setPublishOpen(true)}
        title={t.workspace.deployTooltip}
      >
        <Upload className="h-4 w-4" />
        <span className="text-sm hidden lg:inline">{t.workspace.deploy}</span>
      </Button>

      {/* Settings — cost + all settings (app + project) in one modal */}
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-3 flex items-center gap-2"
        onClick={() => useWorkspaceStore.getState().setShowProjectSettingsModal(true)}
        title={t.workspace.settings}
      >
        {shouldShowCosts && (
          <span className="text-sm font-medium">${projectCost.toFixed(3)}</span>
        )}
        <Settings className="h-4 w-4" />
      </Button>
    </div>
  );

  const mobileMenuContent = (
    <div className="space-y-2">
      {shouldShowCosts && (
        <div className="pb-2 border-b border-border/50">
          <span className="text-sm font-medium">
            Project cost: ${projectCost.toFixed(projectCost >= 10 ? 2 : 3)}
          </span>
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start"
        onClick={() => useWorkspaceStore.getState().setShowProjectSettingsModal(true)}
      >
        <Settings className="h-4 w-4 mr-2" />
        Settings
      </Button>
    </div>
  );

  // Quick edit's derived state. Declared here rather than inside the branch below, so these hooks
  // run on every render whichever surface is showing. The starters are not among them: passing
  // `simpleThread` is what puts ChatPanel in simple mode, and it picks QUICK_EDIT_PILLS and scopes
  // them to the previewed page itself.
  const quickRuns = useMemo(() => (quick ? splitRuns(debugEvents) : []), [quick, debugEvents]);

  const quickThread = quick ? (
    <SimpleThread
      runs={quickRuns}
      generating={generating}
      isDirty={isDirty}
      onRestore={(id) => { void handleRestoreCheckpoint(id, 'an earlier change'); }}
      onUndoLatest={undoTargetId ? handleUndo : null}
      onRedoLatest={redoTargetId ? handleRedo : null}
      onSave={() => { void handleSave(); }}
      onAllow={(gateKey, label) => {
        // Mirrors the transcript's Allow: the capability is persisted so the run, and later ones,
        // proceed without asking again, and the task restarts from history.
        track('approval_response', { via: 'quick', decision: 'allow', gate: gateKey });
        configManager.setPermissionOverride(gateKey, 'allow');
        void handleGenerate(`Approved ${label}. Continue the task.`);
      }}
      onDeny={(label) => {
        track('approval_response', { via: 'quick', decision: 'deny' });
        void handleGenerate(`I declined ${label}. Continue without it.`);
      }}
    />
  ) : undefined;
  return (
    <TooltipProvider>
      <div className="h-[100dvh] flex flex-col">
        {/* Header */}
        <AppHeader
          leftText={project.name}
          leftSubtext={quick ? undefined : { chat: 'Chat', files: 'Files', editor: 'Editor', preview: 'Preview', elements: 'Inspector', checkpoints: 'Checkpoints', console: 'Console', skills: 'Skills', debug: 'Debug' }[activeMobilePanel]}
          onLogoClick={guardedBack}
          actions={headerActions}
          mobileMenuContent={quick ? undefined : mobileMenuContent}
          desktopOnlyContent={quick ? undefined : desktopHeaderContent}
          mobileVisibleActions={quick || isDirty ? ['save'] : []}
        />

        <DeployDialog
          open={publishOpen}
          projectId={project.id}
          onOpenChange={setPublishOpen}
        />

        <ImagePicker
          open={imagePickerOpen}
          projectId={project.id}
          currentSrc={focusContext?.attributes?.src}
          onOpenChange={setImagePickerOpen}
          onApply={handleReplaceImage}
          onAskAgent={handleStyleAskAgent}
        />

        <TextPopover
          open={textPopoverOpen}
          onOpenChange={setTextPopoverOpen}
          onRead={handleReadText}
          onApply={handleApplyText}
          onAskAgent={handleStyleAskAgent}
        />

        <RestoreSecretsDialog
          open={pendingRestore !== null}
          description={pendingRestore?.description}
          preview={pendingRestore?.preview ?? null}
          onCancel={() => setPendingRestore(null)}
          onConfirm={() => {
            const pending = pendingRestore;
            setPendingRestore(null);
            pending?.restore().catch(error => {
              logger.error('Error restoring checkpoint:', error);
              toast.error('Failed to restore checkpoint');
            });
          }}
        />

        {/* Desktop Workspace */}
        <div className="hidden md:flex flex-1 overflow-hidden bg-background">
          {/* Left sidebar for panel toggles. Quick edit has the same rail with only its two panels. */}
          {quick && (
            <div className="w-10 bg-muted/70 border-r border-border flex flex-col items-center py-3 gap-1.5">
              {([
                { key: 'chat', label: 'Chat', Icon: MessageSquare, on: showChat, token: 'assistant' },
                { key: 'preview', label: 'Live Preview', Icon: Eye, on: showPreview, token: 'preview' },
                { key: 'elements', label: 'Inspector', Icon: ListTree, on: showElements, token: 'elements' },
              ] as const).map(({ key, label, Icon, on, token }) => (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <button
                      className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                        on ? 'shadow-sm' : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                      }`}
                      style={{
                        backgroundColor: on ? `var(--button-${token}-active-bg)` : undefined,
                        color: on ? `var(--button-${token}-active-fg)` : undefined,
                      }}
                      onClick={() => setQuickPanels((p) => ({ ...p, [key]: !p[key] }))}
                      aria-pressed={on}
                      aria-label={label}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    className="border-0"
                    style={{ backgroundColor: `var(--button-${token}-active)`, color: 'white' }}
                    arrowStyle={{ backgroundColor: `var(--button-${token}-active)`, fill: `var(--button-${token}-active)` }}
                  >
                    <p>{label}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
          {!quick && <div className="w-10 bg-muted/70 border-r border-border flex flex-col items-center py-3 gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showChat
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showChat ? 'var(--button-assistant-active-bg)' : undefined,
                    color: showChat ? 'var(--button-assistant-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('chat')}
                  onMouseEnter={() => handleSidebarHover('chat')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-assistant-active)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-assistant-active)',
                  fill: 'var(--button-assistant-active)'
                }}
              >
                <p>{t.workspace.tabs.chat}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showFiles
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showFiles ? 'var(--button-files-active-bg)' : undefined,
                    color: showFiles ? 'var(--button-files-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('files')}
                  onMouseEnter={() => handleSidebarHover('files')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <FolderTree className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-files-active)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-files-active)',
                  fill: 'var(--button-files-active)'
                }}
              >
                <p>{t.workspace.tabs.fileExplorer}</p>
              </TooltipContent>
            </Tooltip>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showEditor 
                      ? 'shadow-sm' 
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showEditor ? 'var(--button-editor-active-bg)' : undefined,
                    color: showEditor ? 'var(--button-editor-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('editor')}
                  onMouseEnter={() => handleSidebarHover('editor')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <Code2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent 
                side="right" 
                className="border-0"
                style={{ 
                  backgroundColor: 'var(--button-editor-active)', 
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-editor-active)',
                  fill: 'var(--button-editor-active)'
                }}
              >
                <p>{t.workspace.tabs.codeEditor}</p>
              </TooltipContent>
            </Tooltip>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 mx-1 rounded-sm flex items-center justify-center transition-all ${
                    showPreview
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showPreview ? 'var(--button-preview-active-bg)' : undefined,
                    color: showPreview ? 'var(--button-preview-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('preview')}
                  onMouseEnter={() => handleSidebarHover('preview')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-preview-active)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-preview-active)',
                  fill: 'var(--button-preview-active)'
                }}
              >
                <p>{t.workspace.tabs.preview}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showElements
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showElements ? 'var(--button-elements-active-bg)' : undefined,
                    color: showElements ? 'var(--button-elements-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('elements')}
                  onMouseEnter={() => handleSidebarHover('elements')}
                  onMouseLeave={() => handleSidebarHover(null)}
                  aria-label={showElements ? 'Close inspector panel' : 'Open inspector panel'}
                >
                  <ListTree className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-elements-active)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-elements-active)',
                  fill: 'var(--button-elements-active)'
                }}
              >
                <p>{t.workspace.tabs.inspector}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showSkillsPanel
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showSkillsPanel ? 'var(--button-skills-active-bg)' : undefined,
                    color: showSkillsPanel ? 'var(--button-skills-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('skills')}
                  onMouseEnter={() => handleSidebarHover('skills')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-skills-active, #a855f7)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-skills-active, #a855f7)',
                  fill: 'var(--button-skills-active, #a855f7)'
                }}
              >
                <p>{t.workspace.tabs.skills}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`relative h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showConsole
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showConsole ? 'var(--button-terminal-active-bg)' : undefined,
                    color: showConsole ? 'var(--button-terminal-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('console')}
                  onMouseEnter={() => handleSidebarHover('console')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <TerminalIcon className="h-3.5 w-3.5" />
                  {hasUnreadConsole && !showConsole && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[var(--button-terminal-active,#22c55e)]" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-terminal-active, #22c55e)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-terminal-active, #22c55e)',
                  fill: 'var(--button-terminal-active, #22c55e)'
                }}
              >
                <p>{t.workspace.tabs.console}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showCheckpoints
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showCheckpoints ? 'var(--button-checkpoint-active-bg)' : undefined,
                    color: showCheckpoints ? 'var(--button-checkpoint-active-fg)' : undefined
                  }}
                  onClick={() => togglePanel('checkpoints')}
                  onMouseEnter={() => handleSidebarHover('checkpoints')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <History className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0"
                style={{
                  backgroundColor: 'var(--button-checkpoint-active)',
                  color: 'white'
                }}
                arrowStyle={{
                  backgroundColor: 'var(--button-checkpoint-active)',
                  fill: 'var(--button-checkpoint-active)'
                }}
              >
                <p>{t.workspace.tabs.checkpoints}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showDebugPanel
                      ? 'bg-foreground shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    color: showDebugPanel ? 'var(--background)' : undefined
                  }}
                  onClick={() => togglePanel('debug')}
                  onMouseEnter={() => handleSidebarHover('debug')}
                  onMouseLeave={() => handleSidebarHover(null)}
                >
                  <Bug className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="border-0 bg-foreground text-background"
                arrowStyle={{
                  backgroundColor: 'var(--foreground)',
                  fill: 'var(--foreground)'
                }}
              >
                <p>{t.workspace.tabs.debugEvents}</p>
              </TooltipContent>
            </Tooltip>

          </div>}

          {/* Main content area — slot-based layout (max 3 panels) */}
          <div
            ref={panelContainerRef}
            className="flex-1 p-2 overflow-hidden"
            data-tour-id="workspace-panels"
            onMouseMove={draggingPanel ? handleDragMouseMove : undefined}
            onMouseUp={draggingPanel ? handlePanelDragEnd : undefined}
          >
          <PanelDragProvider value={{ onDragStart: handlePanelDragStart, draggingPanel }}>
          <ResizablePanelGroup ref={panelGroupRef} direction="horizontal" autoSaveId={quick ? 'quick-edit-slots' : 'workspace-slots'}>
            {(() => {
              // Build ordered list of visible panels using panelOrder
              const panelMap: Record<string, { minSize: number; content: React.ReactNode }> = {};

              if (showChat) panelMap['chat'] = { minSize: 15, content: (
                <ChatPanel
                  previewPath={previewPath}
                  events={debugEvents}
                  onRestore={handleRestoreCheckpoint}
                  onRetry={handleRetry}
                  generating={generating}
                  onGenerate={handleGenerate}
                  onStop={handleStop}
                  onContinue={canContinue ? handleContinue : undefined}
                  focusContext={includedFocus}
                  onClearFocus={handleDesktopClearFocus}
                  focusPreviewSnippet={focusPreviewSnippet}
                  mode={mode}
                  setMode={storeSetMode}
                  activeInterview={activeInterview}
                  onStartInterview={handleStartInterview}
                  onHandoff={handleHandoff}
                  currentModel={currentModel}
                  getModelDisplayName={getModelDisplayName}
                  isTourLockingInput={isTourLockingInput}
                  onClearChat={clearDebugEvents}
                  onClose={quick ? () => setQuickPanels((p) => ({ ...p, chat: false })) : () => useWorkspaceStore.getState().togglePanel('chat')}
                  simpleThread={quickThread}
                  solo={visiblePanelCount === 1}
                  supportsVision={supportsVision}
                  inputModalities={inputModalities}
                  providerReady={providerReady}
                  runtimeErrors={runtimeErrors}
                  onSendRuntimeErrors={handleSendRuntimeErrors}
                  onClearRuntimeErrors={handleClearRuntimeErrors}
                  placedBlocks={placedBlocks}
                  onRemovePlacedBlock={handleRemovePlacedBlock}
                  onClearPlacedBlocks={handleClearPlacedBlocks}
                onCaptureContextScreenshot={handleCaptureContextScreenshot}
                />
              )};

              if (showFiles) panelMap['files'] = { minSize: 14, content: (
                <div className="h-full border border-border rounded-lg shadow-sm overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-files-rgb), 0.01), rgba(var(--panel-files-rgb), 0.01)), var(--card)`, minWidth: '240px' }}>
                  <FileExplorer
                    projectId={project.id}
                    onFileSelect={handleFileSelect}
                    onClose={() => useWorkspaceStore.getState().togglePanel('files')}
                    entryPoint={entryPoint}
                    onSetEntryPoint={handleSetEntryPoint}
                    onAddPromptFile={handleAddPromptFile}
                    onProjectUpdate={handleProjectSettingsUpdate}
                  />
                </div>
              )};

              if (showEditor) panelMap['editor'] = { minSize: 20, content: (
                <div className="h-full border border-border rounded-lg shadow-sm overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-editor-rgb), 0.01), rgba(var(--panel-editor-rgb), 0.01)), var(--card)`, minWidth: '240px' }}>
                  <MultiTabEditor
                    projectId={project.id}
                    runtime={projectRuntime}
                    onClose={() => useWorkspaceStore.getState().togglePanel('editor')}
                  />
                </div>
              )};

              if (showConsole) panelMap['console'] = { minSize: 15, content: (
                <div className="h-full border border-border rounded-lg shadow-sm overflow-hidden relative" style={{ minWidth: '240px' }}>
                  <ConsolePanel
                    projectId={project.id}
                    runtime={projectRuntime || 'handlebars'}
                    bufferedMessages={consoleBufferRef.current}
                    onBufferConsumed={() => { consoleBufferRef.current = []; }}
                    onClose={() => useWorkspaceStore.getState().togglePanel('console')}
                  />
                </div>
              )};

              if (showPreview) panelMap['preview'] = { minSize: 20, content: (
                <div
                  className={fullscreenPreview
                    ? "fixed inset-0 z-50 bg-background flex flex-col"
                    : "h-full border border-border rounded-lg shadow-sm overflow-hidden relative"}
                  style={fullscreenPreview ? undefined : { background: `linear-gradient(0deg, rgba(var(--panel-preview-rgb), 0.01), rgba(var(--panel-preview-rgb), 0.01)), var(--card)`, minWidth: '240px' }}
                >
                  <MultipagePreview
                    ref={attachDesktopPreview}
                    projectId={project.id}
                    initialPath={initialPreviewPath}
                    onPathChange={setPreviewPath}
                    refreshTrigger={refreshTrigger}
                    onFocusSelection={handleDesktopFocusSelection}
                    hasFocusTarget={Boolean(focusContext)}
                    onClose={fullscreenPreview ? handleExitFullscreen : handleClosePreview}
                    deploymentId={selectedDeploymentId}
                    simple={quick}
                    entryPoint={entryPoint}
                    runtime={projectRuntime}
                    placementActive={paletteOpen}
                    onPlacementToggle={handlePlacementToggle}
                    onPlacementComplete={handlePlacementComplete}
                    onFullscreen={handleEnterFullscreen}
                    isFullscreen={fullscreenPreview}
                    provenance
                    onTreeLevel={handleTreeLevel}
                    onTreeLevels={handleTreeLevels}
                    onTreeStale={handleTreeStale}
                    onSelectionResolved={handleSelectionResolved}
                    onToolbarAction={handleToolbarAction}
                    onToolbarHover={handleToolbarHover}
                    onFrameReady={handleFrameReady}
                    onStyleComputed={handleStyleComputed}
                    onStyleProbeResult={handleStyleProbeResult}
                  />
                </div>
              )};

              // The mobile tree has its own Elements entry, which keeps its preview mounted
              // alongside so there is a frame to query; see the mobile block. Note that both
              // blocks pass `ref={previewRef}` — a pre-existing hazard, untouched here: the
              // Inspector addresses `inspectorPreview()` rather than that ref.
              if (showElements) panelMap['elements'] = { minSize: 14, content: (
                <PanelContainer>
                  <PanelHeader
                    icon={ListTree}
                    title="Inspector"
                    color="var(--button-elements-active)"
                    panelKey="elements"
                    onClose={quick
                      ? () => setQuickPanels((p) => ({ ...p, elements: false }))
                      : () => useWorkspaceStore.getState().togglePanel('elements')}
                  />
                  <ElementsPanel
                    ref={elementsPanelRef}
                    projectId={project.id}
                    runtime={projectRuntime || 'handlebars'}
                    previewOpen={showPreview}
                    onOpenPreview={handleOpenPreviewPanel}
                    sendToFrame={sendToPreviewFrame}
                    selection={focusContext}
                    applyStyle={applyStyle}
                    removeStyle={removeStyle}
                    onReadOverrides={readOverrides}
                    colorTokens={colorTokens}
                    onReadText={handleReadText}
                    onApplyText={handleApplyText}
                    onReplaceImage={handleOpenImagePicker}
                    imageUrl={selectedImageUrl}
                    onOpenFile={handleOpenStyleFile}
                    onAskAgent={handleStyleAskAgent}
                    onRefreshPreview={handleRefreshPreviewForStyles}
                    onSelectElement={handleArmFocusTool}
                    onSelectElementHover={handleSelectElementHover}
                    focusToolArmed={focusToolArmed}
                    activeTab={elementsTab}
                    onTabChange={setElementsTab}
                  />
                </PanelContainer>
              )};

              if (showCheckpoints) panelMap['checkpoints'] = { minSize: 12, content: (
                <CheckpointPanel
                  projectId={project.id}
                  events={debugEvents}
                  currentCheckpointId={checkpointManager.getCurrentCheckpoint()?.id}
                  onRestore={handleRestoreCheckpoint}
                  onScrollToTurn={handleScrollToCheckpoint}
                  onClose={() => useWorkspaceStore.getState().togglePanel('checkpoints')}
                  refreshKey={checkpointRefreshKey}
                />
              )};

              if (showDebugPanel) panelMap['debug'] = { minSize: 15, content: (
                <DebugPanel events={debugEvents} onClear={clearDebugEvents} onClose={() => useWorkspaceStore.getState().togglePanel('debug')} />
              )};

              if (showSkillsPanel) panelMap['skills'] = { minSize: 10, content: (
                <SkillsPanel onClose={() => useWorkspaceStore.getState().togglePanel('skills')} />
              )};

              // Order visible panels by panelOrder
              const visiblePanels = panelOrder
                .filter(key => key in panelMap)
                .map(key => ({ key, ...panelMap[key] }));

              // Render panels with either resize handles (normal) or drop zones (during drag)
              const elements: React.ReactNode[] = [];
              const isDragging = !!draggingPanel;

              // Helper: render a drop zone that matches resize handle dimensions (w-2 mx-1)
              const dropZone = (position: number) => (
                <div
                  key={`drop-${position}`}
                  ref={(el) => registerDropZone(position, el)}
                  className={`shrink-0 rounded-[3px] border border-dashed animate-expand-indicator ${
                    dropTarget === position
                      ? 'bg-primary/40 border-primary/60'
                      : 'bg-muted/50 border-muted-foreground'
                  }`}
                />
              );

              const dragIdx = isDragging ? visiblePanels.findIndex(p => p.key === draggingPanel) : -1;

              // Insert-position indicator (shown when hovering sidebar to add a panel when there's room)
              const insertIndicator = (position: number) => (
                <div
                  key={`insert-${position}`}
                  className="shrink-0 rounded-[3px] bg-primary/40 border border-dashed border-primary/60 animate-expand-indicator"
                />
              );

              visiblePanels.forEach((panel, idx) => {
                // Left edge drop zone (before first panel)
                if (isDragging && idx === 0 && dragIdx !== 0) {
                  elements.push(dropZone(0));
                }
                if (idx > 0) {
                  if (isDragging) {
                    const isDroppable = !(idx === dragIdx || idx === dragIdx + 1);
                    // Hide resize handle inside a collapsing wrapper (animates out as drop zone animates in)
                    elements.push(
                      <div key={`handle-wrap-${idx}`} className="animate-collapse-indicator shrink-0 overflow-hidden">
                        <ResizableHandle key={`handle-${idx}`} withHandle className="pointer-events-none opacity-0" />
                      </div>
                    );
                    if (isDroppable) {
                      elements.push(dropZone(idx));
                    } else {
                      elements.push(<div key={`spacer-${idx}`} className="w-2 mx-1 shrink-0" />);
                    }
                  } else {
                    elements.push(<ResizableHandle key={`handle-${idx}`} withHandle />);
                  }
                }

                elements.push(
                  <ResizablePanel
                    key={panel.key}
                    id={`panel-${panel.key}`}
                    order={idx + 1}
                    defaultSize={baseSize}
                    minSize={panel.minSize}
                  >
                    <div
                      className="h-full rounded-lg relative"
                      data-panel-id={panel.key}
                    >
                      {/* Replace-preview / drag highlight overlay — renders on top of panel border */}
                      {((isDragging && panel.key === draggingPanel) || panelReplacePreview === panel.key) && (
                        <div
                          className="absolute inset-0 rounded-lg pointer-events-none z-50"
                          style={{
                            border: `1px dashed ${
                              (isDragging && panel.key === draggingPanel && dropTarget !== null)
                                ? 'var(--color-muted-foreground)'
                                : 'var(--color-primary)'
                            }`,
                          }}
                        />
                      )}
                      {panel.content}
                    </div>
                  </ResizablePanel>
                );

                // Insert preview after last panel
                if (!isDragging && panelInsertPreview === idx + 1 && idx === visiblePanels.length - 1) {
                  elements.push(insertIndicator(idx + 1));
                }
              });

              // Right edge drop zone
              if (isDragging && dragIdx !== visiblePanels.length - 1) {
                elements.push(dropZone(visiblePanels.length));
              }

              return elements;
            })()}

          </ResizablePanelGroup>
          </PanelDragProvider>
          </div>
        </div>

        {/* Mobile Workspace */}
        <div className="flex md:hidden flex-1 overflow-hidden bg-background flex-col">
          {/* Single active panel */}
          <div className="flex-1 pb-12 overflow-hidden">
            {activeMobilePanel === 'chat' && (
              <ChatPanel
                previewPath={previewPath}
                events={debugEvents}
                onRestore={handleRestoreCheckpoint}
                onRetry={handleRetry}
                generating={generating}
                onGenerate={handleMobileGenerate}
                onStop={handleStop}
                onContinue={canContinue ? handleContinue : undefined}
                focusContext={includedFocus}
                onClearFocus={handleMobileClearFocus}
                focusPreviewSnippet={focusPreviewSnippet}
                mode={mode}
                setMode={storeSetMode}
                activeInterview={activeInterview}
                onStartInterview={handleStartInterview}
                onHandoff={handleHandoff}
                currentModel={currentModel}
                getModelDisplayName={getModelDisplayName}
                isTourLockingInput={isTourLockingInput}
                onClearChat={clearDebugEvents}
                supportsVision={supportsVision}
                inputModalities={inputModalities}
                providerReady={providerReady}
                runtimeErrors={runtimeErrors}
                onSendRuntimeErrors={handleSendRuntimeErrors}
                onClearRuntimeErrors={handleClearRuntimeErrors}
                placedBlocks={placedBlocks}
                onRemovePlacedBlock={handleRemovePlacedBlock}
                onClearPlacedBlocks={handleClearPlacedBlocks}
                onCaptureContextScreenshot={handleCaptureContextScreenshot}
                simpleThread={quickThread}
              />
            )}

            {activeMobilePanel === 'files' && (
              <div className="h-full overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-files-rgb), 0.01), rgba(var(--panel-files-rgb), 0.01)), var(--card)` }}>
                <FileExplorer
                  projectId={project.id}
                  onFileSelect={handleFileSelect}
                  onClose={() => useWorkspaceStore.getState().togglePanel('files')}
                  entryPoint={entryPoint}
                  onSetEntryPoint={handleSetEntryPoint}
                  onAddPromptFile={handleAddPromptFile}
                  onProjectUpdate={handleProjectSettingsUpdate}
                />
              </div>
            )}

            {activeMobilePanel === 'editor' && (
              <div className="h-full overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-editor-rgb), 0.01), rgba(var(--panel-editor-rgb), 0.01)), var(--card)` }}>
                <MultiTabEditor
                  projectId={project.id}
                  runtime={projectRuntime}
                  onClose={() => useWorkspaceStore.getState().togglePanel('editor')}
                />
              </div>
            )}

            {/* Preview and Inspector share this branch, and the preview element keeps one position
                in the tree across both, so switching between them never remounts the frame or
                costs a recompile. The Inspector needs a live frame to query, and it stays
                *visible* rather than hidden behind it: a `display:none` iframe is not guaranteed to
                lay out, and the styles tab reads computed values. */}
            {(activeMobilePanel === 'preview' || activeMobilePanel === 'elements') && (
              <div className="h-full flex flex-col overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-preview-rgb), 0.01), rgba(var(--panel-preview-rgb), 0.01)), var(--card)` }}>
                <div className={`overflow-hidden relative ${activeMobilePanel === 'elements' ? 'h-[45%] shrink-0 border-b border-border' : 'flex-1'}`}>
                  <MultipagePreview
                    ref={attachMobilePreview}
                    projectId={project.id}
                    initialPath={initialPreviewPath}
                    onPathChange={setPreviewPath}
                    refreshTrigger={refreshTrigger}
                    onFocusSelection={handleMobileFocusSelection}
                    hasFocusTarget={Boolean(focusContext)}
                    onClose={handleClosePreview}
                    deploymentId={selectedDeploymentId}
                    entryPoint={entryPoint}
                    runtime={projectRuntime}
                    placementActive={paletteOpen}
                    onPlacementToggle={handlePlacementToggle}
                    onPlacementComplete={handlePlacementComplete}
                    simple={quick}
                    provenance={activeMobilePanel === 'elements'}
                    onTreeLevel={handleTreeLevel}
                    onTreeLevels={handleTreeLevels}
                    onTreeStale={handleTreeStale}
                    onSelectionResolved={handleSelectionResolved}
                    onFrameReady={handleFrameReady}
                    onStyleComputed={handleStyleComputed}
                    onStyleProbeResult={handleStyleProbeResult}
                    onToolbarAction={handleToolbarAction}
                  />
                </div>
                {activeMobilePanel === 'elements' && (
                  // flex-col, not just flex-1: the panel's root is `flex-1 min-h-0 flex flex-col`
                  // and only sizes itself inside a flex column. In a plain block it grew to fit its
                  // content, so neither tab's overflow-auto pane ever had a bounded height and
                  // neither scrolled. This mirrors PanelContainer, which is what wraps it on desktop.
                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    <ElementsPanel
                      ref={mobileElementsPanelRef}
                      projectId={project.id}
                      runtime={projectRuntime || 'handlebars'}
                      previewOpen
                      onOpenPreview={handleOpenPreviewPanel}
                      sendToFrame={sendToPreviewFrame}
                      selection={focusContext}
                      applyStyle={applyStyle}
                      removeStyle={removeStyle}
                      onReadOverrides={readOverrides}
                      colorTokens={colorTokens}
                      onReadText={handleReadText}
                      onApplyText={handleApplyText}
                      onReplaceImage={handleOpenImagePicker}
                      imageUrl={selectedImageUrl}
                      onOpenFile={handleOpenStyleFile}
                      onAskAgent={handleStyleAskAgent}
                      onRefreshPreview={handleRefreshPreviewForStyles}
                      onSelectElement={handleArmFocusTool}
                      onSelectElementHover={handleSelectElementHover}
                      focusToolArmed={focusToolArmed}
                      activeTab={elementsTab}
                      onTabChange={setElementsTab}
                    />
                  </div>
                )}
              </div>
            )}

            {activeMobilePanel === 'checkpoints' && (
              <div className="h-full overflow-hidden relative">
                <CheckpointPanel
                  projectId={project.id}
                  events={debugEvents}
                  currentCheckpointId={checkpointManager.getCurrentCheckpoint()?.id}
                  onRestore={handleRestoreCheckpoint}
                  onScrollToTurn={handleScrollToCheckpoint}
                  onClose={() => useWorkspaceStore.getState().setActiveMobilePanel('chat')}
                  refreshKey={checkpointRefreshKey}
                />
              </div>
            )}

            {activeMobilePanel === 'console' && (
              <div className="h-full overflow-hidden relative">
                <ConsolePanel
                  projectId={project.id}
                  runtime={projectRuntime || 'handlebars'}
                  bufferedMessages={consoleBufferRef.current}
                  onBufferConsumed={() => { consoleBufferRef.current = []; }}
                />
              </div>
            )}

            {activeMobilePanel === 'skills' && (
              <div className="h-full overflow-hidden relative">
                <SkillsPanel onClose={() => useWorkspaceStore.getState().setActiveMobilePanel('chat')} />
              </div>
            )}

            {activeMobilePanel === 'debug' && (
              <div className="h-full overflow-hidden relative">
                <DebugPanel events={debugEvents} onClear={clearDebugEvents} onClose={() => useWorkspaceStore.getState().setActiveMobilePanel('chat')} />
              </div>
            )}
          </div>

          {/* Bottom Navigation Bar */}
          <div className="fixed bottom-0 left-0 right-0 z-20 bg-card border-t border-border">
            <div className="flex justify-center items-center p-2 gap-2">
              <button
                className={`flex items-center justify-center py-2 px-2 rounded-lg transition-all shadow-sm ${
                  activeMobilePanel === 'chat'
                    ? 'text-white'
                    : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                }`}
                style={{
                  backgroundColor: activeMobilePanel === 'chat' ? 'var(--button-assistant-active)' : undefined,
                }}
                onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('chat'); }}
              >
                <MessageSquare className="h-4 w-4" />
              </button>

              {!quick && <button
                className={`flex items-center justify-center py-2 px-2 rounded-lg transition-all shadow-sm ${
                  activeMobilePanel === 'files'
                    ? 'text-white'
                    : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                }`}
                style={{
                  backgroundColor: activeMobilePanel === 'files' ? 'var(--button-files-active)' : undefined,
                }}
                onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('files'); }}
              >
                <FolderTree className="h-4 w-4" />
              </button>}

              {!quick && <button
                className={`flex items-center justify-center py-2 px-2 rounded-lg transition-all shadow-sm ${
                  activeMobilePanel === 'editor'
                    ? 'text-white'
                    : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                }`}
                style={{
                  backgroundColor: activeMobilePanel === 'editor' ? 'var(--button-editor-active)' : undefined,
                }}
                onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('editor'); }}
              >
                <Code2 className="h-4 w-4" />
              </button>}

              <button
                className={`flex items-center justify-center py-2 px-2 rounded-lg transition-all shadow-sm ${
                  activeMobilePanel === 'preview'
                    ? 'text-white'
                    : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                }`}
                style={{
                  backgroundColor: activeMobilePanel === 'preview' ? 'var(--button-preview-active)' : undefined,
                }}
                onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('preview'); }}
              >
                <Eye className="h-4 w-4" />
              </button>

              <button
                className={`flex items-center justify-center py-2 px-2 rounded-lg transition-all shadow-sm ${
                  activeMobilePanel === 'elements'
                    ? 'text-white'
                    : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                }`}
                style={{
                  backgroundColor: activeMobilePanel === 'elements' ? 'var(--button-elements-active)' : undefined,
                }}
                onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('elements'); }}
                aria-label="Inspector"
              >
                <ListTree className="h-4 w-4" />
              </button>

              {/* Overflow menu. Quick edit has nothing in it: checkpoints, console, skills and
                  debug are all outside what it offers. */}
              {!quick && 
              <div className="relative">
                <button
                  className={`relative flex items-center justify-center py-2 px-2 rounded-lg transition-all shadow-sm ${
                    mobileOverflowOpen || ['checkpoints', 'console', 'skills', 'debug'].includes(activeMobilePanel)
                      ? 'text-white bg-muted'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  onClick={() => useWorkspaceStore.getState().setMobileOverflowOpen(!mobileOverflowOpen)}
                >
                  <EllipsisVertical className="h-4 w-4" />
                  {hasUnreadConsole && activeMobilePanel !== 'console' && (
                    <span className="absolute top-1 right-0.5 h-2 w-2 rounded-full bg-[var(--button-terminal-active,#22c55e)]" />
                  )}
                </button>

                {mobileOverflowOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => useWorkspaceStore.getState().setMobileOverflowOpen(false)} />
                    <div className="absolute bottom-full right-0 mb-2 z-40 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
                      <button
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                          activeMobilePanel === 'checkpoints' ? 'text-white' : 'text-foreground hover:bg-muted'
                        }`}
                        style={{
                          backgroundColor: activeMobilePanel === 'checkpoints' ? 'var(--button-checkpoint-active)' : undefined,
                        }}
                        onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('checkpoints'); }}
                      >
                        <History className="h-4 w-4" />
                        <span>{t.workspace.checkpointsShort}</span>
                      </button>
                      <button
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                          activeMobilePanel === 'console' ? 'text-white' : 'text-foreground hover:bg-muted'
                        }`}
                        style={{
                          backgroundColor: activeMobilePanel === 'console' ? 'var(--button-terminal-active, #22c55e)' : undefined,
                        }}
                        onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('console'); }}
                      >
                        <TerminalIcon className="h-4 w-4" />
                        <span>{t.workspace.consoleShort}</span>
                        {hasUnreadConsole && activeMobilePanel !== 'console' && (
                          <span className="ml-auto h-2 w-2 rounded-full bg-[var(--button-terminal-active,#22c55e)]" />
                        )}
                      </button>
                      <button
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                          activeMobilePanel === 'skills' ? 'text-white' : 'text-foreground hover:bg-muted'
                        }`}
                        style={{
                          backgroundColor: activeMobilePanel === 'skills' ? 'var(--button-skills-active, #a855f7)' : undefined,
                        }}
                        onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('skills'); }}
                      >
                        <Sparkles className="h-4 w-4" />
                        <span>{t.workspace.skillsShort}</span>
                      </button>
                      <button
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                          activeMobilePanel === 'debug' ? 'text-white' : 'text-foreground hover:bg-muted'
                        }`}
                        style={{
                          backgroundColor: activeMobilePanel === 'debug' ? 'var(--button-debug-active, #ef4444)' : undefined,
                        }}
                        onClick={() => { useWorkspaceStore.getState().setActiveMobilePanel('debug'); }}
                      >
                        <Bug className="h-4 w-4" />
                        <span>{t.workspace.debugShort}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>}
            </div>
          </div>
        </div>
      </div>

      <GuidedTourOverlay location="workspace" />
      <GuidedTourOverlay location="settings" />

      <ProjectSettingsModal
        project={project}
        isOpen={showProjectSettingsModal}
        onClose={() => useWorkspaceStore.getState().setShowProjectSettingsModal(false)}
        onProjectUpdate={handleProjectSettingsUpdate}
        enabled={backendEnabled}
        onToggleEnabled={handleBackendToggle}
        workspaceId={workspaceId}
      />

    </TooltipProvider>
  );
}
