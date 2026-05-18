'use client';

import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { Project, VirtualFile } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { FileExplorer } from '@/components/file-explorer';
import { MultiTabEditor, openFileInEditor } from '@/components/editor/multi-tab-editor';
import { MultipagePreview, MultipagePreviewHandle } from '@/components/preview/multipage-preview';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MessageSquare, FolderTree, Code2, Eye, Settings, Save, Bug, RotateCcw, History, Settings2, Terminal as TerminalIcon, Sparkles, ChevronDown, ChevronUp, EllipsisVertical } from 'lucide-react';
import { AppHeader, HeaderAction } from '@/components/ui/app-header';
import { PendingImage } from '@/lib/llm/multi-agent-orchestrator';
import { configManager, migrateBackendKey } from '@/lib/config/storage';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { PANEL_MAP } from '@/lib/stores/slices/layout';
import { useCostSettings } from '@/lib/hooks/use-cost-settings';
import { getProvider, modelSupportsVision } from '@/lib/llm/providers/registry';
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
import { checkpointManager } from '@/lib/vfs/checkpoint';
import { saveManager } from '@/lib/vfs/save-manager';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SettingsPanel } from '@/components/settings';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { useGuidedTour } from '@/components/guided-tour/context';
import { GuidedTourTranscriptEvent } from '@/components/guided-tour/types';
import { FocusContextPayload } from '@/lib/preview/types';
import type { PlacedBlock } from '@/lib/semantic-blocks/types';
import type { PlacementResult } from '@/lib/preview/types';
import { getBlockById } from '@/lib/semantic-blocks/registry';
import { DebugPanel } from '@/components/debug-panel';
import { ChatPanel } from '@/components/chat-panel';
import { DeploymentSelector } from '@/components/workspace/deployment-selector';
import { CheckpointPanel } from '@/components/checkpoint-panel';
import { ProjectSettingsModal } from '@/components/project-backend';
import { SkillsPanel } from '@/components/workspace/skills-panel';
import { PanelDragProvider } from '@/components/ui/panel';
import { ConsolePanel } from '@/components/console';
import { getRuntimeConfig } from '@/lib/runtimes/registry';
import { drainRuntimeErrors, peekRuntimeErrors, formatRuntimeErrors } from '@/lib/preview/runtime-errors';

interface WorkspaceProps {
  project: Project;
  onBack: () => void;
  workspaceId?: string;
}

type FocusTarget = FocusContextPayload & { timestamp: number };

export function Workspace({ project, onBack, workspaceId }: WorkspaceProps) {
  const refreshTrigger = useWorkspaceStore(s => s.refreshTrigger);
  const generating = useWorkspaceStore(s => s.generating);
  const debugEvents = useWorkspaceStore(s => s.debugEvents);
  const currentModel = useWorkspaceStore(s => s.currentModel);
  const projectCost = useWorkspaceStore(s => s.projectCost);
  const addDebugEvent = useWorkspaceStore(s => s.addDebugEvent);
  const isDirty = useWorkspaceStore(s => s.isDirty);
  const saveInProgress = useWorkspaceStore(s => s.saveInProgress);
  const entryPoint = useWorkspaceStore(s => s.entryPoint);
  const projectRuntime = useWorkspaceStore(s => s.projectRuntime);
  const focusContext = useWorkspaceStore(s => s.focusContext);
  const chatMode = useWorkspaceStore(s => s.chatMode);
  const runtimeErrors = useWorkspaceStore(s => s.runtimeErrors);
  const initialCheckpointId = useWorkspaceStore(s => s.initialCheckpointId);
  const checkpointRefreshKey = useWorkspaceStore(s => s.checkpointRefreshKey);
  const backendEnabled = useWorkspaceStore(s => s.backendEnabled);
  const selectedDeploymentId = useWorkspaceStore(s => s.selectedDeploymentId);
  const activeMobilePanel = useWorkspaceStore(s => s.activeMobilePanel);
  const mobileOverflowOpen = useWorkspaceStore(s => s.mobileOverflowOpen);
  const placedBlocks = useWorkspaceStore(s => s.placedBlocks);
  const paletteOpen = useWorkspaceStore(s => s.paletteOpen);
  const lastFocusSignatureRef = useRef<{ signature: string; timestamp: number } | null>(null);
  const previewRef = useRef<MultipagePreviewHandle>(null);
  const generatingRef = useRef(false);
  const handleGenerateRef = useRef<((promptText?: string, images?: PendingImage[]) => Promise<void>) | null>(null);
  const setCurrentModel = useWorkspaceStore(s => s.setCurrentModel);
  const storeChatMode = useWorkspaceStore(s => s.setChatMode);
  const storeFocusContext = useWorkspaceStore(s => s.setFocusContext);
  const { state: tourState, start: startTour, setWorkspaceHandler } = useGuidedTour();
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

  // Listen for runtime changes from the CLI shell (e.g., LLM runs `runtime handlebars`)
  useEffect(() => {
    const handler = (e: Event) => {
      const runtime = (e as CustomEvent).detail?.runtime;
      if (runtime) useWorkspaceStore.getState().updateProjectSettings({ runtime });
    };
    window.addEventListener('runtimeChanged', handler);
    return () => window.removeEventListener('runtimeChanged', handler);
  }, []);

  // Get cost settings for conditional display
  const { shouldShowCosts } = useCostSettings();

  // Check if current model supports vision for image input
  const supportsVision = useMemo(() => {
    const currentProvider = configManager.getSelectedProvider();
    const modelId = currentModel || configManager.getDefaultModel();

    // Check cached discovered models first (has accurate modality data from API)
    const cached = configManager.getCachedModels(currentProvider);
    if (cached) {
      const model = (cached.models as import('@/lib/llm/providers/types').ProviderModel[])
        .find(m => m.id === modelId);
      if (model?.supportsVision !== undefined) {
        return model.supportsVision;
      }
    }

    // Fall back to name-based heuristics for hardcoded providers
    return modelSupportsVision(currentProvider, modelId);
  }, [currentModel]);

  // Check if current provider has credentials configured
  const providerReady = useMemo(() => {
    const provider = configManager.getSelectedProvider();
    const config = getProvider(provider);
    if (config.isLocal) return true;
    if (config.apiKeyRequired || config.usesOAuth) return !!configManager.getProviderApiKey(provider);
    return true;
  }, [currentModel]);
  
  // Console panel — visible by default for terminal-mode runtimes (Python, Lua), togglable for all
  const isTerminalRuntime = getRuntimeConfig(projectRuntime || 'handlebars').previewMode === 'terminal';

  const showChat = useWorkspaceStore(s => s.showChat);
  const showFiles = useWorkspaceStore(s => s.showFiles);
  const showEditor = useWorkspaceStore(s => s.showEditor);
  const showPreview = useWorkspaceStore(s => s.showPreview);
  const showCheckpoints = useWorkspaceStore(s => s.showCheckpoints);
  const showDebugPanel = useWorkspaceStore(s => s.showDebugPanel);
  const showProjectSettingsModal = useWorkspaceStore(s => s.showProjectSettingsModal);
  const showSkillsPanel = useWorkspaceStore(s => s.showSkillsPanel);
  const showConsole = useWorkspaceStore(s => s.showConsole);
  const fullscreenPreview = useWorkspaceStore(s => s.fullscreenPreview);
  const panelReplacePreview = useWorkspaceStore(s => s.panelReplacePreview);
  const panelInsertPreview = useWorkspaceStore(s => s.panelInsertPreview);
  const hasUnreadConsole = useWorkspaceStore(s => s.hasUnreadConsole);
  // Ref to imperatively reset panel sizes after reorder
  const panelGroupRef = useRef<import('react-resizable-panels').ImperativePanelGroupHandle | null>(null);

  const panelOrder = useWorkspaceStore(s => s.panelOrder);
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
      // Capture current sizes keyed by panel identity before reordering
      const visibleBefore = panelOrder.filter(k => {
        if (k === 'chat') return showChat;
        if (k === 'files') return showFiles;
        if (k === 'editor') return showEditor;
        if (k === 'console') return showConsole;
        if (k === 'preview') return showPreview;
        if (k === 'checkpoints') return showCheckpoints;
        if (k === 'debug') return showDebugPanel;
        if (k === 'skills') return showSkillsPanel;
        return false;
      });
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
  }, [draggingPanel, dropTarget, panelOrder, showChat, showFiles, showEditor, showConsole, showPreview, showCheckpoints, showDebugPanel, showSkillsPanel]);

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
    for (let i = allPanels.length - 1; i >= 0; i--) {
      if (allPanels[i].open && allPanels[i].key !== key) {
        store.setPanelReplacePreview(allPanels[i].key);
        return;
      }
    }
    store.setPanelReplacePreview(null);
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
  }, [project.id]);
  
  const visiblePanelCount = [showChat, showFiles, showEditor, showConsole, showPreview, showCheckpoints, showDebugPanel, showSkillsPanel].filter(Boolean).length;
  const baseSize = visiblePanelCount > 0 ? Math.floor(100 / visiblePanelCount) : 100;
  // Last panel absorbs remainder so sizes sum to exactly 100 (avoids layout normalization warnings)
  const lastPanelSize = visiblePanelCount > 0 ? 100 - baseSize * (visiblePanelCount - 1) : 100;

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

  const handleFocusSelection = useCallback((selection: FocusContextPayload | null) => {
    if (!selection) {
      useWorkspaceStore.getState().setFocusContext(null);
      lastFocusSignatureRef.current = null;
      return;
    }
    const signature = `${selection.domPath || ''}::${selection.tagName || ''}::${selection.outerHTML ? selection.outerHTML.length : 0}`;
    const now = Date.now();
    if (lastFocusSignatureRef.current && lastFocusSignatureRef.current.signature === signature && (now - lastFocusSignatureRef.current.timestamp) < 400) {
      return;
    }
    const nextTarget: FocusTarget = {
      ...selection,
      timestamp: now
    };
    useWorkspaceStore.getState().setFocusContext(nextTarget);
    toast.info('Focus context set', {
      description: describeFocusTarget(nextTarget)
    });
    lastFocusSignatureRef.current = { signature, timestamp: now };
  }, [describeFocusTarget]);

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

  const handleClosePreview = useCallback(() => {
    useWorkspaceStore.getState().togglePanel('preview');
  }, []);

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

  const focusPreviewSnippet = focusContext ? truncateHtmlSnippet(focusContext.outerHTML, 240) : '';

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

        // Skip checkpoint restore if an orchestrator session is active
        // (generation ran or is running while the workspace was unmounted)
        if (!useWorkspaceStore.getState().isProjectGenerating(project.id)) {
          await saveManager.syncProjectSaveState(project.id);
          const savedCheckpointId = saveManager.getSavedCheckpointId(project.id);

          if (savedCheckpointId) {
            const exists = await checkpointManager.checkpointExists(savedCheckpointId);
            if (exists) {
              const restored = await saveManager.restoreLastSaved(project.id);
              if (restored) {
                if (!isMounted) return;
                useWorkspaceStore.setState({ initialCheckpointId: savedCheckpointId });
              }
            } else {
              // Stale reference — checkpoint was pruned or deleted
              const proj = await vfs.getProject(project.id);
              proj.lastSavedCheckpointId = null;
              await vfs.updateProject(proj);
            }
          }

          if (!isMounted) return;
        }

        const latestProject = await vfs.getProject(project.id);
        if (!isMounted) return;
        useWorkspaceStore.getState().initProject(latestProject);
        if (saveManager.isDirty(project.id)) useWorkspaceStore.getState().markDirty();
        // Initialize chatMode from localStorage
        if (typeof window !== 'undefined') {
          const stored = localStorage.getItem('osw-studio-chat-mode');
          if (stored === 'true') useWorkspaceStore.setState({ chatMode: true });
        }
        // Initialize backendEnabled from localStorage
        if (migrateBackendKey(project.id)) {
          useWorkspaceStore.getState().setBackendEnabled(true);
        }

        logger.debug(`[Workspace] Initializing workspace for project: ${project.id}`);

        // Initialize store persistence and load debug events
        useWorkspaceStore.getState().initPersistence(project.id);
        useWorkspaceStore.getState().dismissGenerationResult(project.id);
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
      } catch (error) {
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

      // Flush any pending sync for this project before leaving
      vfs.flushSyncTimeout(projectId);

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

  const handleFilesChange = useCallback(() => {
    useWorkspaceStore.getState().bumpRefreshTrigger();
  }, []);

  const handleSave = useCallback(async () => {
    if (useWorkspaceStore.getState().saveInProgress) {
      return;
    }

    useWorkspaceStore.setState({ saveInProgress: true });
    try {
      const checkpoint = await saveManager.save(project.id);
      const latestProject = await vfs.getProject(project.id);

      useWorkspaceStore.setState({ lastSavedAt: latestProject.lastSavedAt ?? new Date(checkpoint.timestamp) });
      useWorkspaceStore.getState().incrementCheckpointRefresh();
      toast.success('Project saved');
    } catch (error) {
      logger.error('Failed to save project', error);
      toast.error('Failed to save project');
    } finally {
      useWorkspaceStore.setState({ saveInProgress: false });
    }

  }, [project.id]);

  const handleCaptureScreenshot = useCallback(async (screenshot: string) => {
    try {
      const proj = await vfs.getProject(project.id);
      proj.previewImage = screenshot;
      proj.previewUpdatedAt = new Date();
      await vfs.updateProject(proj);
      toast.success('Thumbnail updated');
    } catch (err) {
      logger.error('Failed to save screenshot:', err);
      toast.error('Failed to save thumbnail');
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

  const handleRestoreCheckpoint = useCallback(async (checkpointId: string, description?: string) => {
    try {
      // First check if checkpoint exists
      const exists = await checkpointManager.checkpointExists(checkpointId);
      if (!exists) {
        toast.error('Checkpoint no longer exists - it may have been cleaned up');
        logger.warn(`[Workspace] Checkpoint ${checkpointId} no longer exists`);
        return;
      }

      const success = await saveManager.runWithSuppressedDirty(project.id, () =>
        checkpointManager.restoreCheckpoint(checkpointId)
      );
      if (success) {
        toast.success(`Restored to: ${description || 'checkpoint'}`);
        handleFilesChange();

        const savedId = saveManager.getSavedCheckpointId(project.id);
        if (savedId && savedId === checkpointId) {
          saveManager.markClean(project.id);
          const latestProject = await vfs.getProject(project.id);
          useWorkspaceStore.setState({ lastSavedAt: latestProject.lastSavedAt ?? null });
        } else {
          saveManager.markDirty(project.id);
        }
      } else {
        toast.error('Failed to restore checkpoint');
      }
    } catch (error) {
      logger.error('Error restoring checkpoint:', error);
      toast.error('Failed to restore checkpoint');
    }
  }, [handleFilesChange, project.id]);

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
      const success = await saveManager.runWithSuppressedDirty(project.id, () =>
        checkpointManager.restoreCheckpoint(checkpointId)
      );
      if (!success) {
        toast.error('Failed to restore checkpoint');
        return;
      }

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

    } catch (error) {
      logger.error('Error during retry:', error);
      toast.error('Failed to retry');
    }
  }, [handleFilesChange, project.id, debugEvents]);

  const storeStartGeneration = useWorkspaceStore(s => s.startGeneration);

  const handleGenerate = useCallback(async (promptText?: string, images?: PendingImage[]) => {
    // Clear runtime errors
    useWorkspaceStore.getState().setRuntimeErrors([]);

    let messageContent = (promptText ?? '').trim();
    const contextParts: string[] = [];
    if (focusContext) contextParts.push(formatFocusContextBlock(focusContext));
    if (placedBlocks.length > 0) contextParts.push(formatPlacedBlocksContext(placedBlocks));
    if (contextParts.length > 0) messageContent = contextParts.join('\n\n') + '\n\n' + messageContent;

    await storeStartGeneration(messageContent, images, {
      chatMode,
      projectId: project.id,
      focusContext,
      placedBlocks,
      isTourLockingInput,
      displayPrompt: (promptText ?? '').trim(),
    });

    // Post-generation UI cleanup
    handleFilesChange();
    if (focusContext) useWorkspaceStore.getState().setFocusContext(null);
    if (placedBlocks.length > 0) {
      placedBlocks.forEach(b => previewRef.current?.removePlaceholder(b.placementId));
      useWorkspaceStore.setState({ placedBlocks: [] });
    }
  }, [storeStartGeneration, chatMode, project.id, focusContext, placedBlocks, isTourLockingInput, handleFilesChange, formatFocusContextBlock, formatPlacedBlocksContext]);

  handleGenerateRef.current = handleGenerate;

  const stopGeneration = useWorkspaceStore(s => s.stopGeneration);
  const continueGeneration = useWorkspaceStore(s => s.continueGeneration);

  const handleStop = useCallback(() => {
    stopGeneration();
  }, [stopGeneration]);

  const handleContinue = useCallback(() => {
    continueGeneration();
  }, [continueGeneration]);

  const handleSendRuntimeErrors = useCallback(() => {
    const errors = drainRuntimeErrors();
    if (errors.length === 0) return;
    useWorkspaceStore.getState().setRuntimeErrors([]);
    handleGenerate(formatRuntimeErrors(errors));
  }, [handleGenerate]);

  const handleClearRuntimeErrors = useCallback(() => {
    drainRuntimeErrors();
    useWorkspaceStore.getState().setRuntimeErrors([]);
  }, []);

  const headerActions: HeaderAction[] = [
    {
      id: 'back',
      label: 'Back to projects',
      icon: ArrowLeft,
      onClick: guardedBack,
      variant: 'outline'
    }
  ];

  headerActions.push({
    id: 'save',
    label: saveInProgress ? 'Saving…' : isDirty ? 'Save' : 'Saved',
    icon: Save,
    onClick: handleSave,
    variant: isDirty ? 'default' : 'outline',
    disabled: !isDirty || saveInProgress
  });

  if (initialCheckpointId) {
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
            onClick={() => handleRestoreCheckpoint(initialCheckpointId, 'Last saved state')}
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
                className="rounded-l-none px-2"
                aria-label={showCheckpoints ? 'Close checkpoints panel' : 'Open checkpoints panel'}
              >
                {showCheckpoints ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
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

      {/* Project settings button */}
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-3 flex items-center gap-2"
        onClick={() => useWorkspaceStore.getState().setShowProjectSettingsModal(true)}
        title="Project Settings"
      >
        <Settings2 className="h-4 w-4" />
        <span className="text-sm hidden lg:inline">Project</span>
      </Button>

      {/* Settings popover */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 flex items-center gap-2"
            title="Project cost and settings"
          >
            {shouldShowCosts && (
              <span className="text-sm font-medium">
                ${projectCost.toFixed(3)}
              </span>
            )}
            <Settings className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[460px] max-h-[min(720px,calc(100vh-5rem))] overflow-hidden flex flex-col" align="end">
          <SettingsPanel />
        </PopoverContent>
      </Popover>
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
        <Settings2 className="h-4 w-4 mr-2" />
        Project Settings
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
          >
            <Settings className="h-4 w-4 mr-2" />
            Settings
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[460px] max-w-[calc(100vw-2rem)] max-h-[min(720px,calc(100vh-5rem))] overflow-hidden flex flex-col" align="start">
          <SettingsPanel />
        </PopoverContent>
      </Popover>
    </div>
  );

  return (
    <TooltipProvider>
      <div className="h-[100dvh] flex flex-col">
        {/* Header */}
        <AppHeader
          leftText={project.name}
          leftSubtext={{ chat: 'Chat', files: 'Files', editor: 'Editor', preview: 'Preview', checkpoints: 'Checkpoints', console: 'Console', skills: 'Skills', debug: 'Debug' }[activeMobilePanel]}
          onLogoClick={guardedBack}
          actions={headerActions}
          mobileMenuContent={mobileMenuContent}
          desktopOnlyContent={desktopHeaderContent}
          mobileVisibleActions={isDirty ? ['save'] : []}
        />

        {/* Desktop Workspace */}
        <div className="hidden md:flex flex-1 overflow-hidden bg-background">
          {/* Left sidebar for panel toggles */}
          <div className="w-10 bg-muted/70 border-r border-border flex flex-col items-center py-3 gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showChat
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showChat ? 'var(--button-assistant-active)' : undefined,
                    color: showChat ? 'white' : undefined
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
                <p>Chat</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showFiles
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showFiles ? 'var(--button-files-active)' : undefined,
                    color: showFiles ? 'white' : undefined
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
                <p>File Explorer</p>
              </TooltipContent>
            </Tooltip>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showEditor 
                      ? 'shadow-sm' 
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showEditor ? 'var(--button-editor-active)' : undefined,
                    color: showEditor ? 'white' : undefined
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
                <p>Code Editor</p>
              </TooltipContent>
            </Tooltip>
            
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 mx-1 rounded-sm flex items-center justify-center transition-all ${
                    showPreview
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showPreview ? 'var(--button-preview-active)' : undefined,
                    color: showPreview ? 'white' : undefined
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
                <p>Preview</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showSkillsPanel
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showSkillsPanel ? 'var(--button-skills-active, #a855f7)' : undefined,
                    color: showSkillsPanel ? 'white' : undefined
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
                <p>Skills</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`relative h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showConsole
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showConsole ? 'var(--button-terminal-active, #22c55e)' : undefined,
                    color: showConsole ? 'white' : undefined
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
                <p>Console</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
                    showCheckpoints
                      ? 'shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                  style={{
                    backgroundColor: showCheckpoints ? 'var(--button-checkpoint-active)' : undefined,
                    color: showCheckpoints ? 'white' : undefined
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
                <p>Checkpoints</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={`h-5 w-5 px-1 rounded-sm flex items-center justify-center transition-all ${
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
                <p>Debug Events</p>
              </TooltipContent>
            </Tooltip>

          </div>
          
          {/* Main content area — slot-based layout (max 3 panels) */}
          <div
            ref={panelContainerRef}
            className="flex-1 p-2 overflow-hidden"
            data-tour-id="workspace-panels"
            onMouseMove={draggingPanel ? handleDragMouseMove : undefined}
            onMouseUp={draggingPanel ? handlePanelDragEnd : undefined}
          >
          <PanelDragProvider value={{ onDragStart: handlePanelDragStart, draggingPanel }}>
          <ResizablePanelGroup ref={panelGroupRef} direction="horizontal" autoSaveId="workspace-slots">
            {(() => {
              // Build ordered list of visible panels using panelOrder
              const panelMap: Record<string, { minSize: number; content: React.ReactNode }> = {};

              if (showChat) panelMap['chat'] = { minSize: 15, content: (
                <ChatPanel
                  events={debugEvents}
                  onRestore={handleRestoreCheckpoint}
                  onRetry={handleRetry}
                  generating={generating}
                  onGenerate={handleGenerate}
                  onStop={handleStop}
                  onContinue={handleContinue}
                  focusContext={focusContext}
                  setFocusContext={storeFocusContext}
                  focusPreviewSnippet={focusPreviewSnippet}
                  chatMode={chatMode}
                  setChatMode={storeChatMode}
                  currentModel={currentModel}
                  setCurrentModel={setCurrentModel}
                  getModelDisplayName={getModelDisplayName}
                  isTourLockingInput={isTourLockingInput}
                  onClearChat={clearDebugEvents}
                  onClose={() => useWorkspaceStore.getState().togglePanel('chat')}
                  supportsVision={supportsVision}
                  providerReady={providerReady}
                  runtimeErrors={runtimeErrors}
                  onSendRuntimeErrors={handleSendRuntimeErrors}
                  onClearRuntimeErrors={handleClearRuntimeErrors}
                  placedBlocks={placedBlocks}
                  onRemovePlacedBlock={handleRemovePlacedBlock}
                  onClearPlacedBlocks={handleClearPlacedBlocks}
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
                    ref={previewRef}
                    projectId={project.id}
                    refreshTrigger={refreshTrigger}
                    onFocusSelection={handleFocusSelection}
                    hasFocusTarget={Boolean(focusContext)}
                    onClose={fullscreenPreview ? handleExitFullscreen : handleClosePreview}
                    deploymentId={selectedDeploymentId}
                    onCaptureScreenshot={handleCaptureScreenshot}
                    entryPoint={entryPoint}
                    runtime={projectRuntime}
                    placementActive={paletteOpen}
                    onPlacementToggle={handlePlacementToggle}
                    onPlacementComplete={handlePlacementComplete}
                    onFullscreen={handleEnterFullscreen}
                    isFullscreen={fullscreenPreview}
                  />
                </div>
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
                events={debugEvents}
                onRestore={handleRestoreCheckpoint}
                onRetry={handleRetry}
                generating={generating}
                onGenerate={handleGenerate}
                onStop={handleStop}
                onContinue={handleContinue}
                focusContext={focusContext}
                setFocusContext={storeFocusContext}
                focusPreviewSnippet={focusPreviewSnippet}
                chatMode={chatMode}
                setChatMode={storeChatMode}
                currentModel={currentModel}
                setCurrentModel={setCurrentModel}
                getModelDisplayName={getModelDisplayName}
                isTourLockingInput={isTourLockingInput}
                onClearChat={clearDebugEvents}
                supportsVision={supportsVision}
                providerReady={providerReady}
                runtimeErrors={runtimeErrors}
                onSendRuntimeErrors={handleSendRuntimeErrors}
                onClearRuntimeErrors={handleClearRuntimeErrors}
                placedBlocks={placedBlocks}
                onRemovePlacedBlock={handleRemovePlacedBlock}
                onClearPlacedBlocks={handleClearPlacedBlocks}
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

            {activeMobilePanel === 'preview' && (
              <div className="h-full overflow-hidden relative" style={{ background: `linear-gradient(0deg, rgba(var(--panel-preview-rgb), 0.01), rgba(var(--panel-preview-rgb), 0.01)), var(--card)` }}>
                <MultipagePreview
                  ref={previewRef}
                  projectId={project.id}
                  refreshTrigger={refreshTrigger}
                  onFocusSelection={handleFocusSelection}
                  hasFocusTarget={Boolean(focusContext)}
                  onClose={handleClosePreview}
                  deploymentId={selectedDeploymentId}
                  onCaptureScreenshot={handleCaptureScreenshot}
                  entryPoint={entryPoint}
                  runtime={projectRuntime}
                  placementActive={paletteOpen}
                  onPlacementToggle={handlePlacementToggle}
                  onPlacementComplete={handlePlacementComplete}
                />
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

              <button
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
              </button>

              <button
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
              </button>

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

              {/* Overflow menu */}
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
                        <span>Checkpoints</span>
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
                        <span>Console</span>
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
                        <span>Skills</span>
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
                        <span>Debug</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
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
