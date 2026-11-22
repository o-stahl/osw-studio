'use client';

import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { Project, VirtualFile } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { FileExplorer } from '@/components/file-explorer';
import { MultiTabEditor, openFileInEditor } from '@/components/editor/multi-tab-editor';
import { MultipagePreview, MultipagePreviewHandle } from '@/components/preview/multipage-preview';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MessageSquare, FolderTree, Code2, Eye, Frame, Settings, Save, Bug, RotateCcw, History, Terminal as TerminalIcon, Sparkles, ChevronDown, ChevronUp, EllipsisVertical, Upload, ListTree, Undo2, Redo2 } from 'lucide-react';
import { AppHeader, HeaderAction } from '@/components/ui/app-header';
import { PendingImage, PendingAudio, PendingFile } from '@/lib/llm/multi-agent-orchestrator';
import { configManager, migrateBackendKey } from '@/lib/config/storage';
import { DeployDialog } from '@/components/deploy-dialog';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import type { InterviewTemplate, InterviewHandoff } from '@/lib/interview/types';
import { track } from '@/lib/telemetry';
import { bucketInterviewTemplateId } from '@/lib/telemetry/tool-analytics';
import { panelOnScreen, shownLayout } from '@/lib/stores/slices/layout';
import type { FocusTarget } from '@/lib/stores/slices/project';
import { isPanelKey, type PanelKey } from '@/lib/workspace-layout';
import { DockArea } from '@/components/workspace/dock/dock-area';
import { LayoutMenu } from '@/components/workspace/dock/layout-menu';
import { useLayoutCommands, WORKSPACE_FOCUS_ATTR } from '@/components/workspace/dock/use-layout-commands';
import { useNoHistorySwipe } from '@/components/workspace/use-no-history-swipe';
import { isMac, modShortcut } from '@/lib/platform';
import { busyNotice } from '@/lib/stores/slices/orchestrator';
import { useCostSettings } from '@/lib/hooks/use-cost-settings';
import { resolveInputModalities } from '@/lib/llm/providers/registry';
import { isProjectProviderReady } from '@/lib/llm/models/project-assignment';
import type { ModelRef } from '@/lib/llm/models/assignment';
import { continueAfterStop } from '@/lib/llm/continue-prompt';
import { createOpenCheckpoint } from './open-checkpoint';
import { resolveActiveAssignment } from '@/lib/llm/models/template-store';
import { toast } from 'sonner';
import { debugEventsState } from '@/lib/llm/debug-events-state';
import { Tip } from '@/components/ui/tooltip';
import { checkpointManager, isEmptyPreview, type BackendRestorePreview } from '@/lib/vfs/checkpoint';
import { RestoreSecretsDialog } from '@/components/restore-secrets-dialog';
import { saveManager } from '@/lib/vfs/save-manager';
import { flushEditorToVfs } from '@/lib/vfs/flush-editor';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { useGuidedTour } from '@/components/guided-tour/context';
import { GuidedTourTranscriptEvent } from '@/components/guided-tour/types';
import { FocusContextPayload } from '@/lib/preview/types';
import { elementKind } from '@/lib/preview/toolbar-dom';
import { isSourcePlaced, type PlacedBlock } from '@/lib/semantic-blocks/types';
import type { PlacementResult, PreviewHostMessage, PreviewMessage, ToolbarAction } from '@/lib/preview/types';
import { getBlockById } from '@/lib/semantic-blocks/registry';
import { isPlace, placedBlocksPrompt, placeholderAt, resolvePlacedBlocks, sentBlocks } from '@/lib/semantic-blocks/placement';
import { newPlacementId } from '@/lib/semantic-blocks/placeholder';
import { DebugPanel } from '@/components/debug-panel';
import { ChatPanel } from '@/components/chat-panel';
import { DeploymentSelector } from '@/components/workspace/deployment-selector';
import { useTranslations } from 'next-intl';
import { translator } from '@/lib/i18n/runtime';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { CheckpointPanel } from '@/components/checkpoint-panel';
import { ProjectSettingsModal } from '@/components/project-backend';
import { SkillsPanel } from '@/components/workspace/skills-panel';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { ElementsPanel, type ElementsPanelHandle, type ElementsTab } from '@/components/elements-panel';
import { buildApplyStyle, newGroup, toPreviewSelection } from '@/components/styles-content/commit';
import { ImagePicker } from '@/components/image-picker';
import { applyImageSrc } from '@/lib/direct-edit/apply-image';
import { TextPopover } from '@/components/text-popover';
import { applyText, readSourceText } from '@/lib/direct-edit/apply-text';
import { useProjectStyleFacts } from '@/components/styles-content/use-tokens';
import { useSelectedImageUrl } from '@/components/styles-content/use-image-url';
import { variableKey } from '@/components/styles-content/theme-variables';
import { applyStyleOverride, OVERRIDES_PATH, OVERRIDES_WRITTEN_EVENT, readMarkerOverrides, sweepUnusedOverrides } from '@/lib/direct-edit/apply-style';
import { OverridesText } from '@/lib/direct-edit/overrides-text';
import { EditJournal, type JournalOutcome } from '@/lib/direct-edit/journal';
import { setEditHistory } from '@/lib/direct-edit/edit-history';
import { scopeOfWidth } from '@/lib/direct-edit/breakpoints';
import type { OverrideScope } from '@/lib/direct-edit/overrides-css';
import { applyStructure, type StructureApplyResult, type StructureOp } from '@/lib/direct-edit/apply-structure';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';
import { LOCK_ATTR } from '@/lib/direct-edit/structure';
import { applyVariable } from '@/lib/direct-edit/apply-variable';
import type { VariableDefinition } from '@/lib/direct-edit/css-variables';
import { styleHint } from '@/lib/direct-edit/style-hint';
import { parseElementTarget } from '@/lib/direct-edit/targets';
import { sourceRefOf } from '@/lib/direct-edit/source-line';
import type { PreviewSelection } from '@/lib/direct-edit/types';
import type { ElementAction } from '@/components/canvas/element-menu';
import type { OverrideMark } from '@/lib/preview/types';
import { CANVAS_DEVICE_ORDER, CANVAS_DEVICES } from '@/lib/canvas/types';
import { asText } from '@/lib/vfs/as-text';
import { ConsolePanel } from '@/components/console';
import { drainRuntimeErrors, peekRuntimeErrors, formatRuntimeErrors } from '@/lib/preview/runtime-errors';
import { canvasSupport, supportsDirectEditing } from '@/lib/runtimes/registry';
import { FALLBACK_RUNTIME, normalizeProjectSettings } from '@/lib/vfs/project-settings';
import { CanvasPanel, type CanvasPanelHandle } from '@/components/canvas/canvas-panel';
import { useMobileViewport } from '@/lib/hooks/use-mobile-viewport';
import { ChatThread } from '@/components/quick-edit/thread';
import { splitRuns } from '@/lib/quick-edit/runs';
import { undoTarget, redoTarget, retryStart } from '@/lib/quick-edit/undo';

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

/** What makes two focus selections "the same one" for the 400 ms click dedup. */
function focusSignature(selection: FocusContextPayload): string {
  return `${selection.domPath || ''}::${selection.tagName || ''}::${selection.outerHTML ? selection.outerHTML.length : 0}`;
}

/** The widths Applies to offers scopes for: the ones Canvas lays pages out at. */
const SURFACE_WIDTHS = CANVAS_DEVICE_ORDER.map(device => CANVAS_DEVICES[device].w);

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

/**
 * The Live Preview on screen. The desktop and mobile layouts are both mounted, the other only hidden
 * by CSS, so its frame is not the page the person sees.
 */
export function shownPreview<T>(mobileViewport: boolean, desktop: T | null, mobile: T | null): T | null {
  return mobileViewport ? mobile : desktop;
}

/**
 * Which surface the Inspector's `Select element` button addresses: the one on screen, or with both
 * or neither, the one the Inspector reads. Canvas has nothing to arm (its Select tool picks on every
 * click), so a press addressed to it puts Canvas on screen in that tool.
 */
export function selectElementSurface(input: {
  canvas: boolean;
  previewOnScreen: boolean;
  canvasOnScreen: boolean;
  target: 'preview' | 'canvas';
}): 'preview' | 'canvas' {
  if (!input.canvas) return 'preview';
  if (input.canvasOnScreen !== input.previewOnScreen) return input.canvasOnScreen ? 'canvas' : 'preview';
  return input.target;
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

/**
 * The surface a selection is recorded as made on, which MCP `canvas_selection` reports. The phone
 * layout has no Canvas, so a pick there is a Live Preview pick whatever the hidden desktop Inspector reads.
 */
export function pickedOn(surface: SelectionSurface, inspectTarget: 'preview' | 'canvas'): 'preview' | 'canvas' {
  return surface === 'mobile' ? 'preview' : inspectTarget;
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

/** The head and tail of a long snippet, so the agent sees the element's opening and its end. */
function truncateHtmlSnippet(html: string, maxLength: number = 1200): string {
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
}

/** Page content on one line of the context block, where a newline in it would start a line of its own. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ');

function describeFocusTarget(target: FocusContextPayload): string {
  const attributeEntries = Object.entries(target.attributes || {}).slice(0, 6);
  if (attributeEntries.length === 0) {
    return `<${target.tagName}>`;
  }
  const summary = attributeEntries
    .map(([key, raw]) => {
      const value = oneLine(raw);
      const trimmed = value.length > 40 ? `${value.slice(0, 37)}…` : value;
      return `${key}="${trimmed}"`;
    })
    .join(' ');
  return `<${target.tagName} ${summary}>`;
}

/**
 * The selected element as the agent is told of it, ahead of the user's words: that it was picked
 * and the request is about it, where it is (page and width, source position, marker), which are
 * what `style` and `inspect` take as the element, then what it is.
 *
 * This is also where the agent learns of `style`, with the element already filled in: the system
 * prompt does not teach it, so a project nobody selects in never gets an override file from the
 * agent. The line is there when the element is written in a file, which is when `style` can reach it.
 */
export function focusContextBlock(target: FocusContextPayload, source: string | null = null): string {
  const descriptor = describeFocusTarget(target);
  const snippet = truncateHtmlSnippet(target.outerHTML, 1200);
  const domPath = target.domPath || '(unknown path)';
  // The attribute is page content: only a value `style` reads as a marker is given as one.
  const stamped = target.attributes?.[MARKER_ATTR];
  const marker = stamped && parseElementTarget(`@${stamped}`).kind === 'marker' ? stamped : null;
  const instances = target.instanceCount ?? 1;
  const element = marker ? `@${marker}` : source;
  const locked = target.attributes ? LOCK_ATTR in target.attributes : false;
  // Longer than any run of backticks in the page's HTML, which could otherwise close it.
  const longestRun = Math.max(0, ...(snippet.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [
    'Selected element (the user picked it on the page, and the request below is about it):', // i18n-ignore: part of the context block sent to the agent
    ...(target.page ? [`- Page: ${oneLine(target.page)}${target.viewportWidth ? `, picked at ${target.viewportWidth} px wide` : ''}`] : []), // i18n-ignore: part of the context block sent to the agent
    ...(source ? [`- Source: ${source}`] : []), // i18n-ignore: part of the context block sent to the agent
    ...(marker ? [`- Marker: @${marker}`] : []), // i18n-ignore: part of the context block sent to the agent
    ...(instances > 1 ? [`- Rendered ${instances} times from this one source tag (a loop, or a partial used more than once): a change to it changes all ${instances}`] : []), // i18n-ignore: part of the context block sent to the agent
    `- Element: ${descriptor}`, // i18n-ignore: part of the context block sent to the agent
    `- DOM path: ${domPath}`, // i18n-ignore: part of the context block sent to the agent
    ...(locked ? ['- Locked by the user: restyle it freely, but do not move, remove or restructure it unless the request asks for that'] : []), // i18n-ignore: part of the context block sent to the agent
    ...(element ? [`- ${styleHint(element, target.viewportWidth)}`] : []),
    '- HTML:',
    `${fence}html`,
    snippet,
    fence
  ].join('\n');
}

/** One of the rail's panel buttons; `token` names its colour, and `fallback` stands in where a theme has none. */
interface RailButton {
  key: PanelKey;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  on: boolean;
  token: string | null;
  fallback?: string;
  unread?: boolean;
  /** Why the panel can't open for this project; the button is disabled and says so. */
  unavailable?: string;
}

/**
 * A panel button's tooltip in that panel's colour, on the app tooltip's tinted treatment: a 15% tint
 * of the colour on the popover surface, the colour as text, and a 40% border.
 */
function panelTooltipStyle(token: string, fallback?: string): React.CSSProperties {
  const colour = fallback ? `var(--button-${token}-active, ${fallback})` : `var(--button-${token}-active)`;
  return {
    backgroundColor: `color-mix(in oklab, ${colour} 15%, var(--popover))`,
    color: colour,
    borderColor: `color-mix(in oklab, ${colour} 40%, transparent)`,
  };
}

/** The guided tour holds the composer for the whole of its run, wrap-up included. */
export function tourLocksInput(tour: { status: string }): boolean {
  return tour.status === 'running';
}

/**
 * Whether leaving the workspace goes ahead. Unsaved changes ask first; during generation the user
 * leaves freely, as the generation shelf carries the run's status.
 */
export function mayLeave(state: { generating: boolean; isDirty: boolean }, ask: () => boolean): boolean {
  if (!state.generating && state.isDirty) return ask();
  return true;
}

/** Continue a stopped task, on the model the person picked on its card when they picked one. */
export function continueHandler(generate: (prompt: string) => unknown): (withModel?: ModelRef) => void {
  return (withModel) => continueAfterStop(withModel, generate);
}

export function Workspace({ project, onBack, backLabel, workspaceId, initialPreviewPath }: WorkspaceProps) {
  const t = useTranslations('workspace');
  const tc = useTranslations('common');
  const tp = useTranslations('preview');
  const tcanvas = useTranslations('canvas');
  const { number } = useLocalFormat();
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
   * rail, no Deploy or Settings, and the thread in its simple view.
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
  const elementsPanelRef = useRef<ElementsPanelHandle>(null);
  /**
   * The *desktop* preview's handle, specifically.
   *
   * The desktop block (`hidden md:flex`) and the mobile block (`flex md:hidden`) are both always in
   * the React tree — the mobile one is hidden by CSS, not unmounted, and its preview renders
   * whenever `activeMobilePanel === 'preview'`, which is the store's default. One ref shared by
   * both would hold whichever committed last: on a desktop viewport, the hidden mobile frame, which
   * was compiled without provenance. So each keeps its own, and `shownPreviewHandle` picks the one
   * on screen.
   */
  const desktopPreviewRef = useRef<MultipagePreviewHandle | null>(null);
  // Stable, so it runs on mount and unmount only.
  const attachDesktopPreview = useCallback((handle: MultipagePreviewHandle | null) => {
    desktopPreviewRef.current = handle;
  }, []);
  /**
   * The *mobile* preview's handle, for the same reason the desktop one is kept separately.
   *
   * The Inspector runs on both trees now, and `sendToFrame` addresses one iframe. On a phone the
   * desktop instance is mounted but CSS-hidden and its document is the wrong one to ask, so the
   * frame plumbing resolves the handle by viewport rather than reaching for either directly.
   */
  const mobilePreviewRef = useRef<MultipagePreviewHandle | null>(null);
  const attachMobilePreview = useCallback((handle: MultipagePreviewHandle | null) => {
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
  /** The Live Preview the person is looking at. */
  const shownPreviewHandle = useCallback(
    () => shownPreview(mobileViewportRef.current, desktopPreviewRef.current, mobilePreviewRef.current),
    [],
  );
  /** Canvas's handle, in the shape of the preview's: what the Inspector addresses while Canvas has it. */
  const canvasRef = useRef<CanvasPanelHandle | null>(null);
  /**
   * `/overrides.css` as the Inspector last wrote it, until a write that recompiles carries it. A page
   * Live Preview loads without a recompile (a link followed inside it) is built from the compile's
   * copy, so it is given this one.
   */
  const overridesRef = useRef<{ css: string; marks: OverrideMark[] } | null>(null);
  const resendOverrides = useCallback((preview: MultipagePreviewHandle | null) => {
    const held = overridesRef.current;
    if (held) preview?.sendToFrame({ type: 'overrides-preview', css: held.css, marks: held.marks });
  }, []);
  /**
   * The surface the desktop Inspector reads: the one that made the last pick. Replies from the other
   * one are dropped, or node ids from the wrong document would reach the Elements tree. The phone
   * layout has no Canvas.
   */
  const inspectTargetRef = useRef<'preview' | 'canvas'>('preview');
  /** The surface the Inspector reads now: the one that picked last, or the other when that one is closed. */
  const inspectTarget = useCallback((): 'preview' | 'canvas' => {
    if (inspectTargetRef.current === 'canvas') return canvasRef.current ? 'canvas' : 'preview';
    return desktopPreviewRef.current || !canvasRef.current ? 'preview' : 'canvas';
  }, []);
  const inspectorTargets = useCallback(() => (mobileViewportRef.current
    ? { panel: mobileElementsPanelRef.current, preview: mobilePreviewRef.current, surface: 'mobile' as const }
    : {
        panel: elementsPanelRef.current,
        preview: inspectTarget() === 'canvas' ? canvasRef.current : desktopPreviewRef.current,
        surface: 'desktop' as const,
      }), [inspectTarget]);
  /**
   * The desktop Inspector moves to the surface that made a pick. That surface's document numbers its
   * elements its own way, so the tree reads that document rather than keep the other one's rows.
   */
  const inspectOn = useCallback((target: 'preview' | 'canvas') => {
    if (inspectTargetRef.current === target) return;
    inspectTargetRef.current = target;
    elementsPanelRef.current?.handleStructureChanged();
  }, []);
  /**
   * The element a structural edit left selected, by its new `data-osw-src`, for the document the
   * recompile brings: the old document has it only where a patch showed the edit (never for a
   * partial or a loop). Given up when the person picks another element, or none, first.
   */
  const pendingSelectRef = useRef<string | null>(null);
  /** An inserted Text or Image, and what follows once it is selected: typing in it, or the image picker. */
  const afterInsertRef = useRef<{ src: string; then: 'text' | 'image' } | null>(null);
  /** Canvas holds a selection: a new one after none brings the Inspector on screen, not every click. */
  const canvasSelectedRef = useRef(false);
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
  const isTourLockingInput = tourLocksInput(tourState);

  // Keep generatingRef in sync for runtime error listener
  useEffect(() => { generatingRef.current = generating; }, [generating]);

  // Guard against accidental navigation away with unsaved changes
  // During generation, let the user leave freely — the generation shelf handles status
  const guardedBack = useCallback(() => {
    if (!mayLeave({ generating, isDirty }, () => window.confirm(t('leaveUnsavedConfirm')))) return;
    onBack();
  }, [generating, isDirty, onBack, t]);

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

    return resolveInputModalities(currentProvider, modelId, configManager.getCachedModels(currentProvider));
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
  const storeShowCanvas = useWorkspaceStore(s => s.showCanvas);
  const canvasAvailable = useWorkspaceStore(s => s.canvasAvailable);
  const storeShowCheckpoints = useWorkspaceStore(s => s.showCheckpoints);
  // Quick edit fixes the panel set without touching the store, so it never writes into the layout
  // the studio has saved.
  // With both quick panels off there is nothing to look at, so the preview stands in.
  const showChat = quick ? quickPanels.chat : storeShowChat;
  const showFiles = !quick && storeShowFiles;
  const showEditor = !quick && storeShowEditor;
  const showPreview = quick ? quickPanels.preview || !quickPanels.chat : storeShowPreview;
  // Not in quick edit, which keeps to chat, preview and the Inspector.
  const showCanvas = !quick && storeShowCanvas;
  const resolvedRuntime = projectRuntime ?? FALLBACK_RUNTIME;
  useEffect(() => {
    useWorkspaceStore.getState().setCanvasAvailable(canvasSupport(resolvedRuntime) !== null);
  }, [resolvedRuntime]);
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
  const hasUnreadConsole = useWorkspaceStore(s => s.hasUnreadConsole);
  // A background tab is open but not on screen, which is what the console's unread dot is about.
  const consoleOnScreen = useWorkspaceStore(s => panelOnScreen(s, 'console'));
  // Off screen, Canvas holds no live page and runs no background work.
  const canvasOnScreen = useWorkspaceStore(s => panelOnScreen(s, 'canvas'));
  // The chat lays itself out for the whole workspace when its cell is the only one on screen.
  const chatAlone = useWorkspaceStore(s => {
    const shown = shownLayout(s);
    return shown.columns.length === 1 && shown.columns[0].cells.length === 1 && shown.columns[0].cells[0].active === 'chat';
  });
  const commands = useLayoutCommands();
  useNoHistorySwipe();

  /**
   * What a control under the pointer would do to the layout, drawn over the workspace: `rail`, a rail
   * button's toggle; `reveal`, putting the panel on screen. Null clears it.
   */
  const handleSidebarHover = useCallback((key: string | null, kind: 'rail' | 'reveal' = 'rail') => {
    useWorkspaceStore.getState().setPanelHint(key && isPanelKey(key) ? { kind, panel: key } : null);
  }, []);

  const consoleBufferRef = useRef<{ level: string; text: string }[]>([]);
  // Mounted: open anywhere, a background tab included, which takes the output itself. On screen: in
  // front, where the person can see it, which is what clears the unread dot.
  const consoleMountedRef = useRef(showConsole);
  const consoleSeenRef = useRef(consoleOnScreen);

  useEffect(() => {
    consoleMountedRef.current = showConsole || activeMobilePanel === 'console';
    consoleSeenRef.current = (!quick && consoleOnScreen) || activeMobilePanel === 'console';
  }, [showConsole, consoleOnScreen, activeMobilePanel, quick]);

  // Buffer previewConsole events while the console is closed; mark them unread while it is out of sight.
  useEffect(() => {
    const handler = (e: Event) => {
      if (!consoleMountedRef.current) {
        const { level, args } = (e as CustomEvent<{ level: string; args: string[] }>).detail;
        consoleBufferRef.current.push({ level, text: args.join(' ') });
      }
      if (!consoleSeenRef.current) useWorkspaceStore.getState().setHasUnreadConsole(true);
    };
    window.addEventListener('previewConsole', handler);
    return () => window.removeEventListener('previewConsole', handler);
  }, []);

  // Clear the unread flag once the console is on screen (desktop or mobile)
  useEffect(() => {
    if ((!quick && consoleOnScreen) || activeMobilePanel === 'console') {
      useWorkspaceStore.getState().setHasUnreadConsole(false);
    }
  }, [consoleOnScreen, activeMobilePanel, quick]);

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
  
  // Quick edit's pair is not in the store, so it is counted from the flags it actually renders.
  const chatSolo = quick ? Number(showChat) + Number(showPreview) + Number(showElements) === 1 : chatAlone;

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return t('selectModel');
    const parts = modelId.split('/');
    const modelName = parts[parts.length - 1];
    return modelName
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };


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
      // Resolved as the preview compiles it: a project whose settings name no runtime still has the toolbar.
      supportsDirectEditing(state.projectRuntime ?? FALLBACK_RUNTIME),
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
    if (selection?.srcAttr !== pendingSelectRef.current) pendingSelectRef.current = null;
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
      timestamp: now,
      surface: pickedOn(surface, inspectTarget()),
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
    const madeOn = surface === 'mobile' ? mobilePreviewRef.current : inspectorTargets().preview;
    focusPathRef.current = madeOn?.getActivePath?.() ?? null;
  }, [carryFocusInclusion, clearFocusSelection, inspectorTargets, inspectTarget]);

  // One handler per mount, so the surface is stated in the JSX that already knows it rather than
  // guessed at from a viewport. `onFocusSelection` takes a one-argument callback, so this is also
  // the only place the extra argument can come from.
  const handleDesktopFocusSelection = useCallback((selection: FocusContextPayload | null) => {
    // A pick in the preview gives it the Inspector; letting go of one is the preview's only while it has it.
    if (selection) inspectOn('preview');
    else if (inspectTarget() !== 'preview') return;
    handleFocusSelection(selection, 'desktop');
  }, [handleFocusSelection, inspectTarget, inspectOn]);
  /** A pick on Canvas: the Inspector reads Canvas now, and a first pick brings it on screen. */
  const handleCanvasFocusSelection = useCallback((selection: FocusContextPayload | null) => {
    if (selection) inspectOn('canvas');
    else if (inspectTarget() !== 'canvas') return;
    handleFocusSelection(selection, 'desktop');
    if (selection && !canvasSelectedRef.current) useWorkspaceStore.getState().revealPanel('elements');
    canvasSelectedRef.current = !!selection;
  }, [handleFocusSelection, inspectTarget, inspectOn]);
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
    useWorkspaceStore.getState().setFocusContext({ ...payload, timestamp: now, surface: pickedOn(inspectorTargets().surface, inspectTarget()) });
    lastFocusSignatureRef.current = { signature: focusSignature(payload), timestamp: now };
  }, [carryFocusInclusion, clearFocusSelection, inspectorTargets, inspectTarget]);

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
    // A structural edit the old document could not show: its element, by where it now is.
    const pending = pendingSelectRef.current;
    if (pending) {
      pendingSelectRef.current = null;
      // The patched document may have selected it already: the answer, with this document's node
      // id, must not be dropped as a repeat of that pick.
      lastFocusSignatureRef.current = null;
      sendToPreviewFrame({ type: 'select-src', src: pending });
      return;
    }
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

  /** The desktop preview's Inspector replies, taken only while the Inspector reads the preview. */
  const previewInspector = useMemo(() => {
    const only = <M,>(fn: (m: M) => void) => (m: M) => { if (inspectTarget() === 'preview') fn(m); };
    return {
      treeLevel: only(handleTreeLevel),
      treeLevels: only(handleTreeLevels),
      treeStale: only(() => handleTreeStale()),
      styleComputed: only(handleStyleComputed),
      styleProbeResult: only(handleStyleProbeResult),
      selectionResolved: only(handleSelectionResolved),
      frameReady: () => {
        resendOverrides(desktopPreviewRef.current);
        if (inspectTarget() === 'preview') handleFrameReady();
      },
    };
  }, [handleTreeLevel, handleTreeLevels, handleTreeStale, handleStyleComputed, handleStyleProbeResult, handleSelectionResolved, handleFrameReady, inspectTarget, resendOverrides]);

  const handleMobileFrameReady = useCallback(() => {
    resendOverrides(mobilePreviewRef.current);
    handleFrameReady();
  }, [handleFrameReady, resendOverrides]);

  /** Canvas's Inspector replies, from the artboard it is reading, taken only while the Inspector reads Canvas. */
  const handleCanvasInspectorMessage = useCallback((message: PreviewMessage) => {
    if (inspectTarget() !== 'canvas') return;
    switch (message.type) {
      case 'tree-level': handleTreeLevel(message); return;
      case 'tree-levels': handleTreeLevels(message); return;
      case 'tree-stale': handleTreeStale(); return;
      case 'style-computed': handleStyleComputed(message); return;
      case 'style-probe-result': handleStyleProbeResult(message); return;
      case 'selection-resolved': handleSelectionResolved(message); return;
    }
  }, [handleTreeLevel, handleTreeLevels, handleTreeStale, handleStyleComputed, handleStyleProbeResult, handleSelectionResolved, inspectTarget]);

  const handleCanvasFrameReady = useCallback(() => {
    if (inspectTarget() === 'canvas') handleFrameReady();
  }, [handleFrameReady, inspectTarget]);

  /** Canvas's Inspector reads another artboard: the tree reads that artboard's document. */
  const handleCanvasInspectedBoardChange = useCallback(() => {
    if (inspectTarget() === 'canvas') elementsPanelRef.current?.handleStructureChanged();
  }, [inspectTarget]);

  /**
   * A button on the preview toolbar was pressed.
   *
   * The decision is `applyToolbarAction`, which also performs the panel side effect; this is the
   * dispatch for everything that needs React state or the frame.
   */
  /** Style opens the Inspector, so the hover draws where it would be put on screen. */
  const handleToolbarHover = useCallback((message: Extract<PreviewMessage, { type: 'toolbar-hover' }>) => {
    handleSidebarHover(message.action === 'style' ? 'elements' : null, 'reveal');
  }, [handleSidebarHover]);

  const handleToolbarAction = useCallback((message: Extract<PreviewMessage, { type: 'toolbar-action' }>) => {
    // What Style needs is "put the Inspector on screen", and togglePanel is only called when
    // showElements is false -- so a layout that always reports closed, paired with a setter that
    // opens rather than toggles, is both correct and immune to reading a stale flag out of this
    // callback's closure. Quick edit's opener is its own flag; the studio's also brings the Inspector
    // to the front of its tab group.
    const effect = applyToolbarAction(message.action, quick
      ? { showElements: false, togglePanel: () => setQuickPanels((p) => ({ ...p, elements: true })) }
      : { showElements: false, togglePanel: (panel) => { useWorkspaceStore.getState().revealPanel(panel); } });
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
    useWorkspaceStore.getState().revealPanel('preview');
  }, [quick]);

  /**
   * The surface the Inspector's `Select element` button addresses (see {@link selectElementSurface}).
   * The phone layout has no Canvas, whatever the hidden desktop layout shows.
   */
  const selectElementTarget = useCallback(() => {
    const store = useWorkspaceStore.getState();
    return selectElementSurface({
      canvas: !quick && store.canvasAvailable && !mobileViewportRef.current,
      previewOnScreen: panelOnScreen(store, 'preview'),
      canvasOnScreen: panelOnScreen(store, 'canvas'),
      target: inspectTarget(),
    });
  }, [quick, inspectTarget]);

  /** Arms the preview's element picker from the Inspector's empty state, or on desktop puts Canvas in its Select tool. */
  const handleArmFocusTool = useCallback(() => {
    // The hover preview belongs to the gesture that is now over. Cleared before the panel work,
    // because opening a panel is what decides the strip's contents.
    handleSidebarHover(null);
    const store = useWorkspaceStore.getState();
    // Both halves of the hover feedback end with the press, whichever way the toggle went. The
    // button clears them on the way in too; this is the guarantee that does not depend on it.
    store.setFocusToolHinted(false);
    const press = focusToolPress({ armed: store.focusToolArmed });
    if (press.armed && selectElementTarget() === 'canvas') {
      store.revealPanel('canvas');
      canvasRef.current?.selectTool();
      return;
    }
    if (press.openPreview) handleOpenPreviewPanel();
    store.setFocusToolArmed(press.armed);
  }, [handleSidebarHover, handleOpenPreviewPanel, selectElementTarget]);

  /** The pointer is on that button. See {@link previewHoverHighlight} for why this is two cases. */
  const handleSelectElementHover = useCallback((hovering: boolean) => {
    const store = useWorkspaceStore.getState();
    const surface = selectElementTarget();
    // The preview *panel* highlight below says where the press sends you; this says which control in
    // that panel it is about. One signal drives both, so the crosshair's tint cannot outlive the
    // panel outline, and it is written before the switch, whose every case returns. The crosshair
    // is Live Preview's; Canvas has none to tint.
    store.setFocusToolHinted(hovering && surface === 'preview');
    switch (previewHoverHighlight({ hovering, previewOpen: panelOnScreen(store, surface) })) {
      case 'panel':
        store.setPanelHint({ kind: 'outline', panel: surface });
        return;
      case 'route':
        handleSidebarHover(surface, 'reveal');
        return;
      case 'clear':
        handleSidebarHover(null);
        return;
    }
  }, [handleSidebarHover, selectElementTarget]);

  /**
   * Undo and redo for the Inspector's writes, for this project. Checked against the files before it
   * writes anything back (see `EditJournal`), so it never undoes over the agent's or the editor's work.
   */
  const journal = useMemo(() => new EditJournal({
    read: async (path) => {
      try {
        return (await vfs.fileExists(project.id, path)) ? asText((await vfs.readFile(project.id, path)).content) : null;
      } catch {
        return null;
      }
    },
    write: async (path, content, silent) => {
      if (await vfs.fileExists(project.id, path)) await vfs.updateFile(project.id, path, content, { silent });
      else await vfs.createFile(project.id, path, content, { silent });
    },
    remove: async (path, silent) => { await vfs.deleteFile(project.id, path, { silent }); },
  }), [project.id]);

  /** The file as it is now, which the Styles tab lays changes it has not written yet over. */
  const overridesText = useMemo(() => new OverridesText(async () => (
    (await vfs.fileExists(project.id, OVERRIDES_PATH)) ? asText((await vfs.readFile(project.id, OVERRIDES_PATH)).content) : ''
  )), [project.id]);
  const readOverridesText = useCallback(() => overridesText.read(), [overridesText]);

  useEffect(() => {
    // A write that is not silent: the agent, the editor, a sync, or a page the Styles tab stamped.
    const compiled = () => { overridesRef.current = null; overridesText.drop(); };
    window.addEventListener('filesChanged', compiled);
    return () => window.removeEventListener('filesChanged', compiled);
  }, [overridesText]);
  /**
   * `/overrides.css` as the Styles tab shows it, reaching every frame showing the project, Live Preview
   * and Canvas alike: a write's result, or a change not yet written.
   */
  const broadcastOverrides = useCallback((css: string, marks: OverrideMark[] = [], unmarks: string[] = []) => {
    overridesRef.current = { css, marks };
    const message = { type: 'overrides-preview' as const, css, marks, unmarks };
    desktopPreviewRef.current?.sendToFrame(message);
    mobilePreviewRef.current?.sendToFrame(message);
    canvasRef.current?.sendToFrame(message);
  }, []);

  useEffect(() => {
    // The agent's `style` command writes the file silently, as the Styles tab does, and is shown the
    // same way: the new rules go to every frame without a recompile.
    const written = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; css?: string }>).detail;
      if (!detail || detail.projectId !== project.id || typeof detail.css !== 'string') return;
      overridesText.set(detail.css);
      broadcastOverrides(detail.css);
      elementsPanelRef.current?.handleOverridesChanged();
      mobileElementsPanelRef.current?.handleOverridesChanged();
    };
    window.addEventListener(OVERRIDES_WRITTEN_EVENT, written);
    return () => window.removeEventListener(OVERRIDES_WRITTEN_EVENT, written);
  }, [project.id, overridesText, broadcastOverrides]);

  const afterJournal = useCallback((outcome: JournalOutcome, way: 'undo' | 'redo') => {
    if (!outcome.ok) {
      if (outcome.reason === 'changed') toast(t(way === 'undo' ? 'editUndoChanged' : 'editRedoChanged', { path: outcome.path }));
      if (outcome.reason === 'failed') toast.error(t(way === 'undo' ? 'editUndoFailed' : 'editRedoFailed', { path: outcome.path }));
      return;
    }
    const css = outcome.written.find(write => write.path === OVERRIDES_PATH);
    if (css) {
      overridesText.set(css.content ?? '');
      broadcastOverrides(css.content ?? '');
    }
    elementsPanelRef.current?.handleOverridesChanged();
    mobileElementsPanelRef.current?.handleOverridesChanged();
  }, [broadcastOverrides, overridesText, t]);

  useEffect(() => {
    setEditHistory({
      projectId: project.id,
      record: (group, kind, write) => journal.record(group, kind, write),
      undoAt: () => journal.undoAt(),
      redoAt: () => journal.redoAt(),
      undo: () => { void journal.undo().then(outcome => afterJournal(outcome, 'undo')); },
      redo: () => { void journal.redo().then(outcome => afterJournal(outcome, 'redo')); },
    });
    return () => setEditHistory(null);
  }, [journal, afterJournal, project.id]);

  /**
   * The Styles tab's Remove unused: the rules of markers no file has any more go, as one undo step,
   * and the frames get the file without them. Not while the agent is writing, which races it.
   */
  const handleSweepOverrides = useCallback(async (): Promise<number | null> => {
    if (useWorkspaceStore.getState().isProjectGenerating(project.id)) return null;
    const group = `sweep:${Date.now()}`;
    const { removed, css } = await sweepUnusedOverrides(project.id, { record: (write) => journal.record(group, 'style', write) });
    if (css !== null && removed.length > 0) {
      overridesText.set(css);
      broadcastOverrides(css);
      elementsPanelRef.current?.handleOverridesChanged();
      mobileElementsPanelRef.current?.handleOverridesChanged();
    }
    return removed.length;
  }, [project.id, journal, overridesText, broadcastOverrides]);

  /** isGenerating injected because lib/direct-edit/ must not import lib/stores/. */
  const applyStyle = useMemo(
    () => buildApplyStyle(project.id, {
      apply: (...args) => overridesText.track(() => applyStyleOverride(...args), result => (result.ok ? result.css : undefined)),
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
      record: (group, write) => journal.record(group, 'style', write),
    }),
    [project.id, journal, overridesText],
  );

  /**
   * The Styles tab's variable edits: written into the stylesheet that declares the variable, and
   * recorded for undo. Writes to one variable in quick succession (a colour being dragged) are one
   * undo step; a write given its step (`step`) goes in that one.
   */
  const variableGesture = useRef<{ key: string; group: string; at: number } | null>(null);
  const applyVariableEdit = useCallback((def: VariableDefinition, value: string, step?: string) => {
    const key = variableKey(def);
    const now = Date.now();
    const last = variableGesture.current;
    const group = step ?? (last && last.key === key && now - last.at < 1500 ? last.group : `variable:${now}:${Math.random().toString(36).slice(2)}`);
    if (!step) variableGesture.current = { key, group, at: now };
    return applyVariable(project.id, def, value, {
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
      record: (write) => journal.record(group, 'style', write),
    });
  }, [project.id, journal]);

  /** A variable's value shown on every frame before its stylesheet is written; `null` takes it back. */
  const previewVariable = useCallback((name: string, value: string | null) => {
    const message = { type: 'variable-preview' as const, name, value };
    desktopPreviewRef.current?.sendToFrame(message);
    mobilePreviewRef.current?.sendToFrame(message);
    canvasRef.current?.sendToFrame(message);
  }, []);

  /**
   * What `/overrides.css` already holds for one element, at every width: the Styles tab's dots and
   * Reset, after a reload.
   *
   * Bound to the project like the write, but with no generation gate: it reads a file and writes
   * nothing, and the removal it enables is gated where the race actually is.
   */
  const readOverrides = useMemo(
    () => (markerId: string) => readMarkerOverrides(project.id, markerId),
    [project.id],
  );

  // Re-read on every file change: a token the agent just renamed must not go on being offered.
  // Only while the panel is open — the read pulls every file's content out of storage, and the
  // panel is closed by default, so nobody who is not using this pays for it.
  const styleFacts = useProjectStyleFacts(showElements || activeMobilePanel === 'elements' ? project.id : null, refreshTrigger);
  const colorTokens = styleFacts.colorTokens;

  /**
   * Applies to, on the surface the Inspector reads: Canvas moves the selection to the artboard of a
   * width in that scope; Live Preview shows the page at a device size in it.
   */
  const handleStyleScope = useCallback((scope: OverrideScope) => {
    if (inspectTarget() === 'canvas') {
      canvasRef.current?.moveToScope(scope, styleFacts.breakpoints);
      return;
    }
    const devices = [['mobile', CANVAS_DEVICES.phone.w], ['tablet', CANVAS_DEVICES.tablet.w], ['desktop', CANVAS_DEVICES.desktop.w]] as const;
    const fit = devices.find(([, width]) => scopeOfWidth(width, styleFacts.breakpoints) === scope);
    if (fit) desktopPreviewRef.current?.setDevice(fit[0]);
  }, [inspectTarget, styleFacts.breakpoints]);

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
      toast.error(t('couldNotOpen', { path }));
    }
  }, [t, project.id]);

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
    store.revealPanel('chat');
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
    const group = newGroup();
    return applyImageSrc(project.id, toPreviewSelection(focus), path, {
      confirmedMultiInstance,
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
      record: write => journal.record(group, 'image', write),
    });
  }, [project.id, journal]);

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
   * element it is about. `asked` is that element when a confirmation toast, not the dialog, asked.
   *
   * **Not silent.** This writes a source file, so every `data-osw-src` after the edit shifts and the
   * recompile is what makes the preview and the toolbar agree with the file again. Nothing here asks
   * for the toolbar back: it returns through the `selection-resolve` handshake on frame-ready.
   */
  const handleApplyText = useCallback(async (text: string, confirmedMultiInstance: boolean, asked?: FocusTarget | null) => {
    const focus = asked ?? useWorkspaceStore.getState().focusContext;
    if (!focus) return { ok: false, reason: 'unresolvable' as const, filesWritten: [] };
    const group = newGroup();
    return applyText(project.id, toPreviewSelection(focus), text, {
      confirmedMultiInstance,
      isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
      record: write => journal.record(group, 'text', write),
    });
  }, [project.id, journal]);

  // ---------- structure: Canvas and the Elements tab ----------

  /** What Copy style took: the element's override blocks, by width. */
  const [styleClip, setStyleClip] = useState<Map<OverrideScope, Record<string, string>> | null>(null);
  const styleClipRef = useRef(styleClip);
  styleClipRef.current = styleClip;

  const structureRefusal = useCallback((result: StructureApplyResult): string => {
    switch (result.reason) {
      case 'locked': return t('structure.refused.locked');
      case 'crosses-template': return t('structure.refused.crossesTemplate');
      case 'into-itself': return t('structure.refused.intoItself');
      case 'not-a-frame': return t('structure.refused.notAFrame');
      case 'no-place': return t('structure.refused.noPlace');
      case 'cross-file': return t('structure.refused.crossFile');
      case 'unclosed': return t('structure.refused.unclosed', { file: result.file ?? '' });
      case 'stale-index': return t('structure.refused.stale');
      case 'missing-file': return t('structure.refused.missing', { file: result.file ?? '' });
      case 'generating': return t('structure.refused.generating');
      case 'ambiguous-stylesheet': return t('structure.refused.stylesheet', { message: result.message ?? '' });
      default: return t('structure.refused.unresolvable');
    }
  }, [t]);

  /**
   * One structural edit: written, shown in every frame at once where it can be, and the element it
   * leaves selected. `target` names the element when it is not the selection (a dragged tree row).
   */
  const runStructure = useCallback(async (
    op: StructureOp,
    opts: {
      target?: PreviewSelection;
      confirmed?: boolean;
      instances?: number;
      /** Told of the write, once it is made: after the confirmation, where one was asked for. */
      onWritten?: (result: StructureApplyResult) => void;
    } = {},
  ): Promise<void> => {
    const focus = useWorkspaceStore.getState().focusContext;
    const placing = op.kind === 'insert' || op.kind === 'block';
    const selection = placing ? null : opts.target ?? (focus ? toPreviewSelection(focus) : null);
    if (!placing && !selection?.srcAttr) {
      toast(t('structure.refused.unresolvable'));
      return;
    }
    const group = newGroup();
    let result: StructureApplyResult;
    try {
      result = await applyStructure(project.id, selection, op, {
        confirmed: opts.confirmed,
        instances: opts.instances,
        isGenerating: () => useWorkspaceStore.getState().isProjectGenerating(project.id),
        record: write => journal.record(group, 'structure', write),
      });
    } catch (error) {
      logger.error('[Workspace] A structural edit could not be written:', error);
      toast.error(t('structure.refused.writeFailed', { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (!result.ok) {
      if (result.reason === 'needs-confirmation') {
        const shared = result.file?.startsWith('/templates/') && (result.instances ?? 1) <= 1;
        // On the element asked about: the toast outlives the selection that raised it.
        toast(shared ? t('structure.confirmShared', { file: result.file ?? '' }) : t('structure.confirmMany', { count: result.instances ?? 2 }), {
          action: { label: t('structure.confirmAction'), onClick: () => { void runStructure(op, { ...opts, target: selection ?? undefined, confirmed: true }); } },
        });
        return;
      }
      toast.error(structureRefusal(result));
      return;
    }
    opts.onWritten?.(result);
    if (typeof result.css === 'string') {
      overridesText.set(result.css);
      broadcastOverrides(result.css);
    }
    if (result.patch) {
      const message = { type: 'structure-patch' as const, ...result.patch };
      desktopPreviewRef.current?.sendToFrame(message);
      mobilePreviewRef.current?.sendToFrame(message);
      canvasRef.current?.sendToFrame(message);
    }
    const { panel, surface } = inspectorTargets();
    panel?.handleStructureChanged();
    // Selected again in the recompiled document, patched or not: a frame the patch did not apply to
    // never has the element, and nothing reads its answer. An edit that wrote nothing is followed by
    // no recompile, so it leaves a selection still waiting for an earlier one as it was.
    if (result.filesWritten?.length) pendingSelectRef.current = result.select ?? null;
    if (result.select) {
      // A patched frame has the element now.
      if (result.patch) sendToPreviewFrame({ type: 'select-src', src: result.select });
      if (op.kind === 'insert' && (op.element === 'text' || op.element === 'image')) {
        afterInsertRef.current = { src: result.select, then: op.element };
      }
    } else if (result.select === null && (!opts.target || opts.target.srcAttr === focus?.srcAttr)) {
      // Only when the edit was on the selection: removing another element, a placed block's
      // placeholder for one, leaves the selection as it was.
      clearFocusSelection(surface);
      sendToPreviewFrame({ type: 'selection-clear' });
    }
  }, [project.id, journal, t, structureRefusal, overridesText, broadcastOverrides, inspectorTargets, sendToPreviewFrame, clearFocusSelection]);

  // A new Text is typed into where it was made, a new Image gets its picker: once it is the selection.
  useEffect(() => {
    const after = afterInsertRef.current;
    if (!after || focusContext?.srcAttr !== after.src) return;
    afterInsertRef.current = null;
    if (after.then === 'image') { setImagePickerOpen(true); return; }
    if (!mobileViewportRef.current && inspectTarget() === 'canvas') canvasRef.current?.editTextAt(after.src);
    else setTextPopoverOpen(true);
  }, [focusContext, inspectTarget]);

  /** Every width's overrides of `element` (from Canvas), or of the selection, for Paste style. */
  const copyStyle = useCallback(async (element?: FocusContextPayload) => {
    const marker = (element ?? useWorkspaceStore.getState().focusContext)?.attributes?.[MARKER_ATTR];
    const read = marker ? await readMarkerOverrides(project.id, marker) : null;
    const count = read ? [...read.byScope.values()].reduce((n, bag) => n + Object.keys(bag).length, 0) : 0;
    if (!read || count === 0) { toast(t('structure.nothingToCopy')); return; }
    setStyleClip(read.byScope);
    toast(t('structure.copied', { count }));
  }, [project.id, t]);

  /**
   * Every width's block Copy style took, onto the selection, or onto `asked`: the element Canvas
   * names, or the one a confirmation was about. One undo step.
   */
  const pasteStyle = useCallback(async (confirmed = false, asked?: FocusContextPayload) => {
    const clip = styleClipRef.current;
    const focus = asked ?? useWorkspaceStore.getState().focusContext;
    if (!clip || !focus) return;
    const group = newGroup();
    let markerId = focus.attributes?.[MARKER_ATTR] ?? null;
    let css: string | undefined;
    for (const [scope, bag] of clip) {
      const changes = Object.entries(bag).map(([property, value]) => ({ property, value }));
      const result = await applyStyle(focus, changes, { scope, markerId, confirmedMultiInstance: confirmed, group });
      if (!result.ok) {
        if (result.reason === 'needs-confirmation') {
          toast(t('structure.confirmMany', { count: result.instances ?? 2 }), {
            action: { label: t('structure.confirmAction'), onClick: () => { void pasteStyle(true, focus); } },
          });
        } else {
          toast.error(structureRefusal(result));
        }
        break;
      }
      markerId = result.markerId ?? markerId;
      if (typeof result.css === 'string') css = result.css;
    }
    if (css !== undefined) broadcastOverrides(css);
    inspectorTargets().panel?.handleOverridesChanged();
  }, [applyStyle, broadcastOverrides, inspectorTargets, structureRefusal, t]);

  /** What the element menu, the Canvas keys and the Elements tab's structure toolbar ask for. */
  const handleElementAction = useCallback((action: ElementAction, target?: PreviewSelection) => {
    const focus = useWorkspaceStore.getState().focusContext;
    switch (action) {
      case 'move-up': void runStructure({ kind: 'step', dir: -1 }, { target }); return;
      case 'move-down': void runStructure({ kind: 'step', dir: 1 }, { target }); return;
      case 'wrap':
      case 'unwrap':
      case 'duplicate':
      case 'delete':
        void runStructure({ kind: action }, { target });
        return;
      case 'copy-style': void copyStyle(); return;
      case 'paste-style': void pasteStyle(); return;
      case 'include':
      case 'edit-text':
        if (focus) handleToolbarAction({ type: 'toolbar-action', action: action === 'include' ? 'include' : 'text', nodeId: focus.nodeId });
        return;
      default:
    }
  }, [runStructure, copyStyle, pasteStyle, handleToolbarAction]);

  /** Text typed in place on an artboard: the same write the popover makes, on the selection or the element a confirmation was about. */
  const handleCanvasTextEdited = useCallback(async (text: string, confirmed = false, asked?: FocusTarget | null) => {
    const focus = asked ?? useWorkspaceStore.getState().focusContext;
    const result = await handleApplyText(text, confirmed, focus);
    if (result.ok) return;
    if (result.reason === 'needs-confirmation') {
      toast(t('structure.confirmMany', { count: result.instances ?? 2 }), {
        action: { label: t('structure.confirmAction'), onClick: () => { void handleCanvasTextEdited(text, true, focus); } },
      });
      return;
    }
    toast.error(structureRefusal(result));
  }, [handleApplyText, structureRefusal, t]);

  const handleRefreshPreviewForStyles = useCallback(() => {
    useWorkspaceStore.getState().bumpRefreshTrigger();
  }, []);

  const handlePlacementToggle = useCallback(() => {
    useWorkspaceStore.getState().setPaletteOpen(!useWorkspaceStore.getState().paletteOpen);
  }, []);

  /**
   * A block placed in Live Preview, or on a Canvas artboard showing `page`. On a page with source
   * positions its placeholder is written there (one undo step, every frame patched), and the chip
   * comes once the write is made.
   */
  const handlePlacementComplete = useCallback((payload: PlacementResult, page?: string) => {
    if ('place' in payload) {
      const block = getBlockById(payload.blockId);
      if (!block) return;
      if (!isPlace(payload.place)) { toast(t('structure.blockNoPlace')); return; }
      const where = page ?? (typeof payload.page === 'string' ? payload.page : null) ?? (shownPreviewHandle()?.getActivePath?.() || '/');
      const placementId = newPlacementId(block.id);
      inspectTargetRef.current = page ? 'canvas' : 'preview';
      void runStructure({ kind: 'block', place: payload.place, block: block.id, placementId }, {
        instances: Math.max(1, Number(payload.instances) || 1),
        onWritten: (result) => {
          const file = result.file;
          if (!file) return;
          useWorkspaceStore.setState(s => ({ placedBlocks: [...s.placedBlocks, { blockId: block.id, placementId, page: where, file }] }));
        },
      });
      return;
    }
    const currentPage = page ?? (shownPreviewHandle()?.getActivePath?.() || '/');
    useWorkspaceStore.setState(s => ({ placedBlocks: [...s.placedBlocks, {
      blockId: payload.blockId,
      placementId: payload.placementId,
      domPath: payload.domPath,
      position: payload.position,
      page: currentPage,
      htmlContext: payload.htmlContext,
    }] }));
  }, [runStructure, shownPreviewHandle, t]);

  /**
   * A placed block's placeholder, taken out: from its file as a structural delete (one undo step),
   * or from the frames that alone showed it, Live Preview's and Canvas's artboards.
   */
  const removePlaceholder = useCallback(async (placed: PlacedBlock) => {
    if (!isSourcePlaced(placed)) {
      desktopPreviewRef.current?.removePlaceholder(placed.placementId);
      mobilePreviewRef.current?.removePlaceholder(placed.placementId);
      canvasRef.current?.sendToFrame({ type: 'placement-remove', placementId: placed.placementId });
      return;
    }
    let at: number | null = null;
    try {
      at = placeholderAt(asText((await vfs.readFile(project.id, placed.file)).content), placed.placementId);
    } catch {
      at = null;
    }
    if (at === null) return;
    await runStructure({ kind: 'delete' }, { target: { srcAttr: `${placed.file}:${at}`, tagName: 'div' }, confirmed: true });
  }, [project.id, runStructure]);

  const handleRemovePlacedBlock = useCallback((placementId: string) => {
    const placed = useWorkspaceStore.getState().placedBlocks.find(b => b.placementId === placementId);
    useWorkspaceStore.setState(s => ({ placedBlocks: s.placedBlocks.filter(b => b.placementId !== placementId) }));
    if (placed) void removePlaceholder(placed);
  }, [removePlaceholder]);

  const handleClearPlacedBlocks = useCallback(() => {
    const placed = useWorkspaceStore.getState().placedBlocks;
    useWorkspaceStore.setState({ placedBlocks: [] });
    void (async () => { for (const b of placed) await removePlaceholder(b); })();
  }, [removePlaceholder]);

  /**
   * A placeholder deleted on the page, or its write undone, hides its chip, and coming back (a redo)
   * shows it again. Only the latest check counts, and only for the chips it read.
   */
  const placementCheckRef = useRef(0);
  useEffect(() => {
    const check = () => {
      const placed = useWorkspaceStore.getState().placedBlocks.filter(isSourcePlaced);
      if (placed.length === 0) return;
      const seq = ++placementCheckRef.current;
      void resolvePlacedBlocks(project.id, placed).then((resolved) => {
        if (seq !== placementCheckRef.current) return;
        const present = new Set(resolved.flatMap(b => ('file' in b ? [b.placementId] : [])));
        const read = new Set(placed.map(b => b.placementId));
        useWorkspaceStore.setState((s) => {
          let changed = false;
          const next = s.placedBlocks.map((b) => {
            if (!isSourcePlaced(b) || !read.has(b.placementId)) return b;
            const missing = !present.has(b.placementId);
            if (Boolean(b.missing) === missing) return b;
            changed = true;
            return { ...b, missing };
          });
          return changed ? { placedBlocks: next } : s;
        });
      });
    };
    window.addEventListener('filesChanged', check);
    return () => window.removeEventListener('filesChanged', check);
  }, [project.id]);
  const shownPlacedBlocks = useMemo(() => placedBlocks.filter(b => !(isSourcePlaced(b) && b.missing)), [placedBlocks]);

  /** The preview as it is, at a width a model can read, for the composer's Screenshot item. */
  const handleCaptureContextScreenshot = useCallback(
    () => shownPreviewHandle()?.captureScreenshot(false, { outputWidth: 1280 }) ?? Promise.resolve(null),
    [shownPreviewHandle],
  );

  const handleClosePreview = useCallback(() => {
    // Quick edit's panels are the workspace's own flags, not the store's.
    if (quick) setQuickPanels((p) => ({ ...p, preview: false }));
    else commands.close('preview');
  }, [quick, commands]);

  const handleEnterFullscreen = useCallback(() => {
    useWorkspaceStore.getState().setFullscreenPreview(true);
  }, []);

  const handleExitFullscreen = useCallback(() => {
    useWorkspaceStore.getState().setFullscreenPreview(false);
  }, []);

  // Listen for showPreview event (dispatched by AI preview command).
  // Only puts the panel on screen — never closes it if it is already there.
  useEffect(() => {
    const handler = () => { useWorkspaceStore.getState().revealPanel('preview'); };
    window.addEventListener('showPreview', handler);
    return () => window.removeEventListener('showPreview', handler);
  }, []);

  const handleSetEntryPoint = useCallback(async (path: string) => {
    try {
      const proj = await vfs.getProject(project.id);
      proj.settings = { ...proj.settings, previewEntryPoint: path };
      await vfs.updateProject(proj);
      vfs.scheduleAutoSync(proj.id);
      useWorkspaceStore.getState().updateProjectSettings({ previewEntryPoint: path });
      toast.success(t('entryPointSet', { path }));
    } catch (err) {
      logger.error('Failed to set entry point:', err);
      toast.error(t('setEntryPointFailed'));
    }
  }, [project.id, t]);

  const handleAddPromptFile = useCallback(async () => {
    try {
      const { getDomainPrompt } = await import('@/lib/llm/prompts');
      const runtime = projectRuntime || 'handlebars';
      await vfs.createFile(project.id, '/.PROMPT.md', getDomainPrompt(runtime));
      window.dispatchEvent(new CustomEvent('filesChanged', { detail: { projectId: project.id } }));
      toast.success(t('promptFileAdded'));
    } catch (err) {
      logger.error('Failed to add .PROMPT.md:', err);
      toast.error(t('promptFileAddFailed'));
    }
  }, [project.id, projectRuntime, t]);

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
        if (!latestProject.lastSavedCheckpointId) {
          try {
            const checkpointId = await createOpenCheckpoint(project.id);
            useWorkspaceStore.setState({ initialCheckpointId: checkpointId });
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
        useWorkspaceStore.getState().initLayout({
          canvas: canvasSupport(useWorkspaceStore.getState().projectRuntime ?? FALLBACK_RUNTIME) !== null,
          front: normalizeProjectSettings(latestProject.settings).opensIn,
        });
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
            description: `Tour checkpoint: ${event.content.substring(0, 60)}` // i18n-ignore: the guided tour, deferred
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
      // A newly opened editor mounts on the next render; one already open, if behind, comes to the front.
      if (useWorkspaceStore.getState().revealPanel('editor') === 'opened') {
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
      toast.success(t('projectSaved'));
    } catch (error) {
      logger.error('Failed to save project', error);
      toast.error(t('saveProjectFailed'));
    } finally {
      useWorkspaceStore.setState({ saveInProgress: false });
    }

  }, [project.id, t]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;
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
    const store = useWorkspaceStore.getState();
    if (!store.isProjectGenerating(project.id)) return false;
    toast.info(translator()(busyNotice(store.generationTasks.get(project.id))));
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
        toast.error(t('checkpointGone'));
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
          toast.success(t('restoredTo', { description: description || t('checkpointFallback') }));
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
          toast.error(t('restoreCheckpointFailed'));
        }
      });
    } catch (error) {
      logger.error('Error restoring checkpoint:', error);
      toast.error(t('restoreCheckpointFailed'));
    }
  }, [handleFilesChange, project.id, remountBackendContext, runRestore, refuseWhileGenerating, t]);

  const handleScrollToCheckpoint = useCallback((checkpointId: string) => {
    useWorkspaceStore.getState().revealPanel('chat');
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
      // `checkpointId` is the one the run finished on. Retry starts from the state before the run:
      // the checkpoint before that one, which is also where Undo goes. A server run snapshots the
      // project before it starts, so there it is exact; a browser run goes back to the last
      // checkpoint before it.
      const ids = (await checkpointManager.getCheckpoints(project.id)).map((c) => c.id).reverse();
      const startId = retryStart(ids, checkpointId);
      if (!startId) {
        toast.error(t('checkpointGoneRetry'));
        logger.warn(`[Workspace] No checkpoint before ${checkpointId} to retry from`);
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
        toast.error(t('noOriginalMessage'));
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
        toast.error(t('noMessageEvent'));
        logger.warn('[Workspace] User message event not found in debug events');
        return;
      }

      // Restore the state before the run
      await runRestore(startId, undefined, async () => {
        const success = await saveManager.runWithSuppressedDirty(project.id, () =>
          checkpointManager.restoreCheckpoint(startId)
        );
        if (!success) {
          toast.error(t('restoreCheckpointFailed'));
          return;
        }
        await remountBackendContext();

        const savedId = saveManager.getSavedCheckpointId(project.id);
        if (savedId && savedId === startId) {
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

        toast.success(t('restoringAndRetrying'));
        handleFilesChange();

        // Retry generation with the original user message.
        // Use setTimeout so handleGenerate (declared below) is available.
        setTimeout(() => handleGenerateRef.current?.(userMessageContent), 0);
      });
    } catch (error) {
      logger.error('Error during retry:', error);
      toast.error(t('retryFailed'));
    }
  }, [handleFilesChange, project.id, debugEvents, remountBackendContext, runRestore, refuseWhileGenerating, t]);

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
    const source = focusIncluded && focusContext?.srcAttr ? await sourceRefOf(project.id, focusContext.srcAttr) : null;
    const included = focusMessageContext(focusContext, focusIncluded, target => focusContextBlock(target, source));
    if (included.promptBlock) contextParts.push(included.promptBlock);
    const blocks = placedBlocks.length > 0 ? await resolvePlacedBlocks(project.id, placedBlocks) : [];
    if (blocks.length > 0) contextParts.push(placedBlocksPrompt(blocks));
    if (contextParts.length > 0) messageContent = contextParts.join('\n\n') + '\n\n' + messageContent;

    const started = await storeStartGeneration(messageContent, images, {
      mode,
      chatMode: mode === 'chat',
      projectId: project.id,
      focusContext: included.generationFocus,
      semanticBlocks: blocks.length > 0 ? sentBlocks(blocks) : undefined,
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
      // A placeholder written into the source stays there for the agent to replace.
      placedBlocks.forEach(b => { if (!isSourcePlaced(b)) void removePlaceholder(b); });
      useWorkspaceStore.setState({ placedBlocks: [] });
    }
  }, [storeStartGeneration, mode, activeInterview, project.id, focusContext, focusIncluded, placedBlocks, isTourLockingInput, handleFilesChange, releaseFocusInclusion, removePlaceholder]);

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

  const handleStop = useCallback(() => {
    stopGeneration();
  }, [stopGeneration]);

  const handleContinue = useMemo(() => continueHandler(handleGenerate), [handleGenerate]);

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
    if (undoTargetId) void handleRestoreCheckpoint(undoTargetId, t('previousChange'));
  }, [undoTargetId, handleRestoreCheckpoint, t]);
  const handleRedo = useCallback(() => {
    if (redoTargetId) void handleRestoreCheckpoint(redoTargetId, t('changeAfter'));
  }, [redoTargetId, handleRestoreCheckpoint, t]);

  const headerActions: HeaderAction[] = [
    {
      id: 'back',
      label: backLabel ?? t('backToProjects'),
      icon: ArrowLeft,
      onClick: guardedBack,
      variant: 'outline'
    }
  ];

  if (quick) {
    headerActions.push(
      {
        id: 'undo', label: tc('actions.undo'), icon: Undo2, onClick: handleUndo, variant: 'outline', disabled: !undoTargetId || generating,
        tip: generating ? t('tips.afterRun') : undoTargetId ? t('tips.undo') : t('tips.nothingToUndo'),
      },
      {
        id: 'redo', label: tc('actions.redo'), icon: Redo2, onClick: handleRedo, variant: 'outline', disabled: !redoTargetId || generating,
        tip: generating ? t('tips.afterRun') : redoTargetId ? t('tips.redo') : t('tips.nothingToRedo'),
      },
    );
  }

  headerActions.push({
    id: 'save',
    label: saveInProgress ? t('saving') : isDirty ? tc('actions.save') : t('saved'),
    icon: Save,
    onClick: handleSave,
    variant: isDirty ? 'default' : 'outline',
    disabled: !isDirty || saveInProgress,
    tip: saveInProgress ? undefined : isDirty ? t('tips.save', { shortcut: modShortcut('S') }) : t('tips.saved'),
  });

  const discardCheckpointId = saveManager.getSavedCheckpointId(project.id) ?? initialCheckpointId;

  if (discardCheckpointId && quick) {
    headerActions.push({
      id: 'discard',
      label: t('discardChanges'),
      icon: RotateCcw,
      onClick: () => handleRestoreCheckpoint(discardCheckpointId, t('lastSavedState'), { isDiscard: true }),
      variant: 'outline',
      disabled: saveInProgress || !isDirty,
      tip: isDirty ? t('tips.discard') : t('tips.nothingToDiscard'),
    });
  } else if (discardCheckpointId) {
    const discardDisabled = saveInProgress || !isDirty;
    headerActions.push({
      id: 'discard',
      label: t('discardChanges'),
      onClick: () => {},
      content: (
        <div className="flex items-center" data-tour-id="discard-changes-button">
          <Tip label={saveInProgress ? undefined : isDirty ? t('tips.discard') : t('tips.nothingToDiscard')} side="bottom">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRestoreCheckpoint(discardCheckpointId, t('lastSavedState'), { isDiscard: true })}
              disabled={discardDisabled}
              className="rounded-r-none border-r-0"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              {t('discardChanges')}
            </Button>
          </Tip>
          <Tip label={showCheckpoints ? t('closeCheckpoints') : t('allCheckpoints')} side="bottom">
            <Button
              variant="outline"
              size="sm"
              onClick={() => commands.toggle('checkpoints')}
              onMouseEnter={() => handleSidebarHover('checkpoints')}
              onMouseLeave={() => handleSidebarHover(null)}
              disabled={saveInProgress}
              className="rounded-l-none px-2 group/chev"
              aria-label={showCheckpoints ? t('closeCheckpointsPanel') : t('openCheckpointsPanel')}
            >
              {showCheckpoints
                ? <ChevronUp className="h-4 w-4 transition-transform group-hover/chev:-translate-y-0.5" />
                : <ChevronDown className="h-4 w-4 transition-transform group-hover/chev:translate-y-0.5" />}
            </Button>
          </Tip>
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
      <Tip label={t('tips.deploy')} side="bottom">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 flex items-center gap-2"
          onClick={() => setPublishOpen(true)}
          aria-label={t('deploy')}
        >
          <Upload className="h-4 w-4" />
          <span className="text-sm hidden lg:inline">{t('deploy')}</span>
        </Button>
      </Tip>

      {/* Settings — cost + all settings (app + project) in one modal */}
      <Tip
        label={shouldShowCosts ? `${t('tips.settings')} · ${t('projectCost', { cost: number(projectCost, { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }) })}` : t('tips.settings')}
        side="bottom"
        align="end"
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 flex items-center gap-2"
          onClick={() => useWorkspaceStore.getState().setShowProjectSettingsModal(true)}
          aria-label={tc('terms.settings')}
        >
          {shouldShowCosts && (
            <span className="text-sm font-medium">{number(projectCost, { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 })}</span>
          )}
          <Settings className="h-4 w-4" />
        </Button>
      </Tip>
    </div>
  );

  const mobileMenuContent = (
    <div className="space-y-2">
      {shouldShowCosts && (
        <div className="pb-2 border-b border-border/50">
          <span className="text-sm font-medium">
            {t('projectCost', { cost: number(projectCost, { style: 'currency', currency: 'USD', maximumFractionDigits: projectCost >= 10 ? 2 : 3, minimumFractionDigits: projectCost >= 10 ? 2 : 3 }) })}
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
        {tc('terms.settings')}
      </Button>
    </div>
  );

  // The conversation, which both views draw as the thread; quick edit's is the simple one. Declared
  // here rather than inside the branches below, so the hook runs on every render whichever surface
  // is showing. The starters are not among it: `simple` is what puts ChatPanel in the simple view,
  // and it picks QUICK_EDIT_PILLS and scopes them to the previewed page itself.
  const runs = useMemo(() => splitRuns(debugEvents), [debugEvents]);
  // Which view an approval came from, for telemetry.
  const approvalVia = quick ? 'quick' : 'chip';
  // One per composer: an answer is sent the way that composer sends, so on mobile it lets go of
  // the selection as a typed message does.
  const threadFor = (send: (prompt: string) => Promise<void>) => (
    <ChatThread
      runs={runs}
      simple={quick}
      generating={generating}
      isDirty={isDirty}
      onRestore={(id) => { void handleRestoreCheckpoint(id); }}
      onRetry={(id) => { void handleRetry(id); }}
      onContinue={handleContinue}
      onUndoLatest={undoTargetId ? handleUndo : null}
      onRedoLatest={redoTargetId ? handleRedo : null}
      onSave={() => { void handleSave(); }}
      onAllow={(gateKey, label) => {
        // The capability is persisted so the run, and later ones, proceed without asking again,
        // and the task restarts from history.
        track('approval_response', { via: approvalVia, decision: 'allow', gate: gateKey });
        configManager.setPermissionOverride(gateKey, 'allow');
        void send(`Approved ${label}. Continue the task.`); // i18n-ignore: sent to the agent as the user's message; English by decision
      }}
      onDeny={(gateKey, label) => {
        track('approval_response', { via: approvalVia, decision: 'deny', gate: gateKey });
        void send(`I declined ${label}. Continue without it.`); // i18n-ignore: sent to the agent as the user's message; English by decision
      }}
      onAnswer={(value) => {
        // The option picked is the next message.
        track('ask_response', { via: 'chip' });
        void send(value);
      }}
      onHandoff={handleHandoff}
    />
  );
  return (
    <>
      <div className="h-app-dvh flex flex-col">
        {/* Header */}
        <AppHeader
          leftText={project.name}
          leftSubtext={quick ? undefined : { chat: tc('terms.chat'), files: t('tabs.filesShort'), editor: t('tabs.editorShort'), preview: t('tabs.preview'), elements: t('tabs.inspector'), checkpoints: t('tabs.checkpoints'), console: t('tabs.console'), skills: tc('terms.skills'), debug: t('tabs.debugShort') }[activeMobilePanel]}
          onLogoClick={guardedBack}
          logoTip={backLabel ?? t('backToProjects')}
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
              toast.error(t('restoreCheckpointFailed'));
            });
          }}
        />

        {/* Desktop Workspace. Focusable, so that Ctrl+Z reaches the layout while nothing inside has focus. */}
        <div className="hidden md:flex flex-1 overflow-hidden bg-background outline-none" tabIndex={-1} {...{ [WORKSPACE_FOCUS_ATTR]: '' }}>
          {/* Left sidebar for panel toggles. Quick edit has the same rail with only its two panels. */}
          {quick && (
            <div className="w-10 bg-muted/70 border-r border-border flex flex-col items-center py-3 gap-1.5">
              {([
                { key: 'chat', label: tc('terms.chat'), Icon: MessageSquare, on: showChat, token: 'assistant' },
                { key: 'preview', label: tp('livePreview'), Icon: Eye, on: showPreview, token: 'preview' },
                { key: 'elements', label: t('tabs.inspector'), Icon: ListTree, on: showElements, token: 'elements' },
              ] as const).map(({ key, label, Icon, on, token }) => (
                <Tip key={key} label={label} side="right" tone={panelTooltipStyle(token)}>
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
                </Tip>
              ))}
            </div>
          )}
          {!quick && <div className="w-10 bg-muted/70 border-r border-border flex flex-col items-center py-3 gap-1.5">
            {([
              { key: 'chat', label: tc('terms.chat'), Icon: MessageSquare, on: showChat, token: 'assistant' },
              { key: 'files', label: t('tabs.fileExplorer'), Icon: FolderTree, on: showFiles, token: 'files' },
              { key: 'editor', label: t('tabs.codeEditor'), Icon: Code2, on: showEditor, token: 'editor' },
              { key: 'preview', label: t('tabs.preview'), Icon: Eye, on: showPreview, token: 'preview' },
              {
                key: 'canvas', label: t('tabs.canvas'), Icon: Frame, on: showCanvas, token: 'canvas',
                unavailable: canvasAvailable ? undefined : tcanvas('unavailable'),
              },
              { key: 'elements', label: t('tabs.inspector'), Icon: ListTree, on: showElements, token: 'elements' },
              { key: 'skills', label: tc('terms.skills'), Icon: Sparkles, on: showSkillsPanel, token: 'skills', fallback: '#a855f7' },
              { key: 'console', label: t('tabs.console'), Icon: TerminalIcon, on: showConsole, token: 'terminal', fallback: '#22c55e', unread: hasUnreadConsole && !consoleOnScreen },
              { key: 'checkpoints', label: t('tabs.checkpoints'), Icon: History, on: showCheckpoints, token: 'checkpoint' },
              // Debug has no colour of its own: it is drawn in the foreground, and its tooltip is the app's.
              { key: 'debug', label: t('tabs.debugEvents'), Icon: Bug, on: showDebugPanel, token: null },
            ] satisfies RailButton[]).map(({ key, label, Icon, on, token, fallback, unread, unavailable }: RailButton) => (
              <Tip
                key={key}
                label={unavailable ? `${label} · ${unavailable}` : unread ? `${label} · ${t('layout.unread')}` : label}
                side="right"
                tone={token && !unavailable ? panelTooltipStyle(token, fallback) : undefined}
              >
                <button
                  className={`relative h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all disabled:opacity-40 disabled:pointer-events-none ${
                    on
                      ? token ? 'shadow-sm' : 'bg-foreground shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  disabled={!!unavailable && !on}
                  style={token
                    ? { backgroundColor: on ? `var(--button-${token}-active-bg)` : undefined, color: on ? `var(--button-${token}-active-fg)` : undefined }
                    : { color: on ? 'var(--background)' : undefined }}
                  onClick={() => commands.toggle(key)}
                  onMouseEnter={() => handleSidebarHover(key)}
                  onMouseLeave={() => handleSidebarHover(null)}
                  aria-label={label}
                  aria-pressed={on}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {unread && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[var(--button-terminal-active,#22c55e)]" />
                  )}
                </button>
              </Tip>
            ))}

            <LayoutMenu />
          </div>}

          {/* The panels, in columns of cells of tabs. Quick edit keeps its fixed panels side by side. */}
          {(() => {
            const panelMap: Partial<Record<PanelKey, React.ReactNode>> = {};

            if (showChat) panelMap.chat = (
              <ChatPanel
                previewPath={previewPath}
                events={debugEvents}
                generating={generating}
                onGenerate={handleGenerate}
                onStop={handleStop}
                focusContext={includedFocus}
                onClearFocus={handleDesktopClearFocus}
                focusPreviewSnippet={focusPreviewSnippet}
                mode={mode}
                setMode={storeSetMode}
                activeInterview={activeInterview}
                onStartInterview={handleStartInterview}
                currentModel={currentModel}
                getModelDisplayName={getModelDisplayName}
                isTourLockingInput={isTourLockingInput}
                onClearChat={clearDebugEvents}
                onClose={quick ? () => setQuickPanels((p) => ({ ...p, chat: false })) : () => commands.close('chat')}
                thread={threadFor(handleGenerate)}
                simple={quick}
                solo={chatSolo}
                supportsVision={supportsVision}
                inputModalities={inputModalities}
                providerReady={providerReady}
                runtimeErrors={runtimeErrors}
                onSendRuntimeErrors={handleSendRuntimeErrors}
                onClearRuntimeErrors={handleClearRuntimeErrors}
                placedBlocks={shownPlacedBlocks}
                onRemovePlacedBlock={handleRemovePlacedBlock}
                onClearPlacedBlocks={handleClearPlacedBlocks}
              onCaptureContextScreenshot={handleCaptureContextScreenshot}
              />
            );

            if (showFiles) panelMap.files = (
              <div className="h-full border border-border rounded-lg shadow-sm overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-files-rgb), 0.01), rgba(var(--panel-files-rgb), 0.01)), var(--card)`, minWidth: '240px' }}>
                <FileExplorer
                  projectId={project.id}
                  onFileSelect={handleFileSelect}
                  onClose={() => commands.close('files')}
                  entryPoint={entryPoint}
                  onSetEntryPoint={handleSetEntryPoint}
                  onAddPromptFile={handleAddPromptFile}
                  onProjectUpdate={handleProjectSettingsUpdate}
                />
              </div>
            );

            if (showEditor) panelMap.editor = (
              <div className="h-full border border-border rounded-lg shadow-sm overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-editor-rgb), 0.01), rgba(var(--panel-editor-rgb), 0.01)), var(--card)`, minWidth: '240px' }}>
                <MultiTabEditor
                  projectId={project.id}
                  runtime={projectRuntime}
                  onClose={() => commands.close('editor')}
                />
              </div>
            );

            if (showConsole) panelMap.console = (
              <div className="h-full border border-border rounded-lg shadow-sm overflow-hidden relative" style={{ minWidth: '240px' }}>
                <ConsolePanel
                  projectId={project.id}
                  runtime={projectRuntime || 'handlebars'}
                  bufferedMessages={consoleBufferRef.current}
                  onBufferConsumed={() => { consoleBufferRef.current = []; }}
                  onClose={() => commands.close('console')}
                />
              </div>
            );

            if (showCanvas) panelMap.canvas = (
              <CanvasPanel
                ref={canvasRef}
                projectId={project.id}
                runtime={resolvedRuntime}
                onClose={() => commands.close('canvas')}
                onScreen={canvasOnScreen && !mobileViewport}
                onFocusSelection={handleCanvasFocusSelection}
                onToolbarAction={handleToolbarAction}
                onToolbarHover={handleToolbarHover}
                onInspectorMessage={handleCanvasInspectorMessage}
                onFrameReady={handleCanvasFrameReady}
                deploymentId={selectedDeploymentId}
                onStructure={(op, opts) => { inspectTargetRef.current = 'canvas'; void runStructure(op, opts); }}
                onElementAction={handleElementAction}
                onStyleCommand={(command, nodeId, where) => inspectorTargets().panel?.styleCommand(command, nodeId, where)}
                onStyleClip={(action, element) => { if (action === 'copy-style') void copyStyle(element); else void pasteStyle(false, element); }}
                onInspectedBoardChange={handleCanvasInspectedBoardChange}
                onHandleDrag={(phase, changes) => elementsPanelRef.current?.dragStyle(phase, changes)}
                onTextEdited={(text) => { void handleCanvasTextEdited(text); }}
                onHoverNode={(nodeId) => { if (inspectTarget() === 'canvas') elementsPanelRef.current?.highlightNode(nodeId); }}
                canStyle={showElements}
                canPasteStyle={styleClip !== null}
                breakpoints={styleFacts.breakpoints}
                onPlacementComplete={handlePlacementComplete}
              />
            );

            if (showPreview) panelMap.preview = (
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
                  onTreeLevel={previewInspector.treeLevel}
                  onTreeLevels={previewInspector.treeLevels}
                  onTreeStale={previewInspector.treeStale}
                  onSelectionResolved={previewInspector.selectionResolved}
                  onToolbarAction={handleToolbarAction}
                  onToolbarHover={handleToolbarHover}
                  onFrameReady={previewInspector.frameReady}
                  onStyleComputed={previewInspector.styleComputed}
                  onStyleProbeResult={previewInspector.styleProbeResult}
                />
              </div>
            );

            // The mobile tree has its own Elements entry, which keeps its preview mounted
            // alongside so there is a frame to query; see the mobile block. Each block keeps its own
            // preview handle, and the Inspector addresses the one on screen (`inspectorTargets()`).
            if (showElements) panelMap.elements = (
              <PanelContainer>
                <PanelHeader
                  icon={ListTree}
                  title={t('tabs.inspector')}
                  color="var(--button-elements-active)"
                  panelKey="elements"
                  onClose={quick
                    ? () => setQuickPanels((p) => ({ ...p, elements: false }))
                    : () => commands.close('elements')}
                />
                <ElementsPanel
                  ref={elementsPanelRef}
                  projectId={project.id}
                  runtime={projectRuntime || 'handlebars'}
                  previewOpen={showPreview || showCanvas}
                  onOpenPreview={handleOpenPreviewPanel}
                  sendToFrame={sendToPreviewFrame}
                  selection={focusContext}
                  applyStyle={applyStyle}
                  onReadOverrides={readOverrides}
                  colorTokens={colorTokens}
                  onOverrides={broadcastOverrides}
                  readOverridesText={readOverridesText}
                  breakpoints={styleFacts.breakpoints}
                  surfaceWidths={SURFACE_WIDTHS}
                  onScope={handleStyleScope}
                  fontTokens={styleFacts.fontTokens}
                  variables={styleFacts.variables}
                  variableUses={styleFacts.variableUses}
                  onApplyVariable={applyVariableEdit}
                  onPreviewVariable={previewVariable}
                  onReadText={handleReadText}
                  onApplyText={handleApplyText}
                  onReplaceImage={handleOpenImagePicker}
                  imageUrl={selectedImageUrl}
                  onOpenFile={handleOpenStyleFile}
                  onAskAgent={handleStyleAskAgent}
                  onSweepOverrides={handleSweepOverrides}
                  onRefreshPreview={handleRefreshPreviewForStyles}
                  onSelectElement={handleArmFocusTool}
                  onSelectElementHover={handleSelectElementHover}
                  focusToolArmed={focusToolArmed}
                  activeTab={elementsTab}
                  onTabChange={setElementsTab}
                  onElementAction={handleElementAction}
                  onStructure={(op, target) => { void runStructure(op, { target }); }}
                  canPasteStyle={styleClip !== null}
                />
              </PanelContainer>
            );

            if (showCheckpoints) panelMap.checkpoints = (
              <CheckpointPanel
                projectId={project.id}
                events={debugEvents}
                savedCheckpointId={saveManager.getSavedCheckpointId(project.id)}
                onRestore={handleRestoreCheckpoint}
                onScrollToTurn={handleScrollToCheckpoint}
                onClose={() => commands.close('checkpoints')}
                refreshKey={checkpointRefreshKey}
              />
            );

            if (showDebugPanel) panelMap.debug = (
              <DebugPanel events={debugEvents} onClear={clearDebugEvents} onClose={() => commands.close('debug')} />
            );

            if (showSkillsPanel) panelMap.skills = (
              <SkillsPanel onClose={() => commands.close('skills')} />
            );

            return (
              <DockArea
                panels={panelMap}
                quick={quick}
                badges={{ console: hasUnreadConsole ? 'unread' : null, chat: generating ? 'busy' : null }}
              />
            );
          })()}
        </div>

        {/* Mobile Workspace */}
        <div className="flex md:hidden flex-1 overflow-hidden bg-background flex-col">
          {/* Single active panel */}
          <div className="flex-1 pb-12 overflow-hidden">
            {activeMobilePanel === 'chat' && (
              <ChatPanel
                previewPath={previewPath}
                events={debugEvents}
                generating={generating}
                onGenerate={handleMobileGenerate}
                onStop={handleStop}
                focusContext={includedFocus}
                onClearFocus={handleMobileClearFocus}
                focusPreviewSnippet={focusPreviewSnippet}
                mode={mode}
                setMode={storeSetMode}
                activeInterview={activeInterview}
                onStartInterview={handleStartInterview}
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
                placedBlocks={shownPlacedBlocks}
                onRemovePlacedBlock={handleRemovePlacedBlock}
                onClearPlacedBlocks={handleClearPlacedBlocks}
                onCaptureContextScreenshot={handleCaptureContextScreenshot}
                thread={threadFor(handleMobileGenerate)}
                simple={quick}
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
                    onFrameReady={handleMobileFrameReady}
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
                      onReadOverrides={readOverrides}
                      colorTokens={colorTokens}
                      onOverrides={broadcastOverrides}
                      readOverridesText={readOverridesText}
                      breakpoints={styleFacts.breakpoints}
                      fontTokens={styleFacts.fontTokens}
                      variables={styleFacts.variables}
                      variableUses={styleFacts.variableUses}
                      onApplyVariable={applyVariableEdit}
                      onPreviewVariable={previewVariable}
                      onReadText={handleReadText}
                      onApplyText={handleApplyText}
                      onReplaceImage={handleOpenImagePicker}
                      imageUrl={selectedImageUrl}
                      onOpenFile={handleOpenStyleFile}
                      onAskAgent={handleStyleAskAgent}
                      onSweepOverrides={handleSweepOverrides}
                      onRefreshPreview={handleRefreshPreviewForStyles}
                      onSelectElement={handleArmFocusTool}
                      onSelectElementHover={handleSelectElementHover}
                      focusToolArmed={focusToolArmed}
                      activeTab={elementsTab}
                      onTabChange={setElementsTab}
                      onElementAction={handleElementAction}
                      onStructure={(op, target) => { void runStructure(op, { target }); }}
                      canPasteStyle={styleClip !== null}
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
                  savedCheckpointId={saveManager.getSavedCheckpointId(project.id)}
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
                aria-label={t('tabs.inspector')}
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
                        <span>{t('tabs.checkpoints')}</span>
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
                        <span>{t('tabs.console')}</span>
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
                        <span>{tc('terms.skills')}</span>
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
                        <span>{t('tabs.debugShort')}</span>
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

    </>
  );
}
