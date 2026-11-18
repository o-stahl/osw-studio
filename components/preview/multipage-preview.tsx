'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useTranslations } from 'next-intl';
import { VirtualServer } from '@/lib/preview/virtual-server';
import {
  CompiledProject,
  PreviewMessage,
  FocusContextPayload,
  PreviewHostMessage
} from '@/lib/preview/types';
import { vfs } from '@/lib/vfs';
import { PreviewLifecycle } from '@/lib/preview/preview-lifecycle';
import { FrameScrollMemory, frameScrollReport, type FrameScroll } from '@/lib/preview/scroll-memory';
import { AckPairer } from '@/lib/preview/ack-pairing';
import { prependToHead, previewBridgeScript } from '@/lib/preview/preview-bridge';
import { previewShellHtml, sendShellContent } from '@/lib/preview/preview-shell';
import { pointPageAtBlobs } from '@/lib/preview/page-references';
import { answerFunctionCall } from '@/lib/preview/function-proxy';
import { getPreviewStorage, setPreviewStorageArea, storageReportProject } from '@/lib/preview/preview-storage';
import { PreviewCompileGate, mergeCompileRequests, observePreviewRoot } from '@/lib/preview/compile-gate';
import type { CompileRequest } from '@/lib/preview/compile-gate';
import { ESCAPE_CSS_IDENT_JS, STRIP_NODE_ID_JS, generateNavigationScript } from '@/lib/preview/navigation-script';
import { generatePlacementScript } from '@/lib/preview/placement-script';
import { PLACEHOLDER_CSS } from '@/lib/semantic-blocks/placeholder';
import { resolveToolbarTheme } from '@/lib/preview/toolbar-dom';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  RefreshCw,
  Smartphone,
  Tablet,
  Monitor,
  ChevronLeft,
  ChevronRight,
  Home,
  Eye,
  Crosshair,
  Maximize,
  Minimize,
  LayoutGrid,
} from 'lucide-react';
import { PanelHeader } from '@/components/ui/panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import { cn, logger } from '@/lib/utils';
import { captureIframeScreenshot } from '@/lib/utils/screenshot';
import type { ProjectRuntime } from '@/lib/vfs/types';
import type { PlacementResult, PlacementBlockInfo } from '@/lib/preview/types';
import { pushRuntimeError, clearRuntimeErrors } from '@/lib/preview/runtime-errors';
import { supportsDirectEditing } from '@/lib/runtimes/registry';
import { FALLBACK_RUNTIME } from '@/lib/vfs/project-settings';
import { PalettePanel } from '@/components/semantic-blocks/palette-panel';
import type { SemanticBlock } from '@/lib/semantic-blocks/types';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { PREVIEW_SANDBOX } from '@/lib/sandbox';

export { ESCAPE_CSS_IDENT_JS, STRIP_NODE_ID_JS, generateNavigationScript };
export { generatePlacementScript };

export interface MultipagePreviewHandle {
  /**
   * A JPEG data URL of the frame, full page, scaled to `outputWidth` (the thumbnail size when
   * omitted). Null when the frame is not ready or the capture fails.
   */
  captureScreenshot: (waitForContent?: boolean, options?: { outputWidth?: number }) => Promise<string | null>;
  startBlockDrag: (block: PlacementBlockInfo) => void;
  getActivePath: () => string;
  removePlaceholder: (placementId: string) => void;
  /**
   * Post a message to the preview frame.
   *
   * For panels that are siblings of the preview rather than children of it — the Elements tree is
   * the first — so they can talk to the frame without a second copy of the posting logic.
   *
   * There is no queue: a message sent before the frame holds the compiled document is delivered to
   * `about:blank`, or dropped outright when there is no contentWindow, and nothing retries it. Wait
   * for `onFrameReady` before the first send, and again after every reload.
   */
  sendToFrame: (message: PreviewHostMessage) => void;
  /** Show the page at a device's size, as the toolbar's toggles do: for the Styles tab's Applies to. */
  setDevice: (size: 'mobile' | 'tablet' | 'desktop') => void;
}

interface MultipagePreviewProps {
  projectId: string;
  /**
   * The page to show on the first compile, instead of the entry point.
   *
   * One-shot: consumed by the first compile that has nothing to preserve, so a later navigation
   * inside the preview is not undone the next time the project recompiles. Ignored when the page is
   * not in the build — a comment can outlive the page it was written on, and an error banner would
   * be a worse answer than the entry point.
   */
  initialPath?: string;
  /**
   * The file the preview is showing, reported whenever it changes.
   *
   * A file path rather than the requested one, so "/" and "/index.html" are one page and a rule
   * naming either matches both. `getActivePath()` on the ref handle reports the requested path and
   * stays for the three callers that read it imperatively and do not want a re-render.
   */
  onPathChange?: (path: string) => void;
  refreshTrigger?: number;
  onFocusSelection?: (selection: FocusContextPayload | null) => void;
  hasFocusTarget?: boolean;
  onClose?: () => void;
  deploymentId?: string | null;
  entryPoint?: string;
  runtime?: ProjectRuntime;
  onFullscreen?: () => void;
  isFullscreen?: boolean;
  /** Quick edit: the toolbar without the studio's semantic-blocks control. */
  simple?: boolean;
  placementActive?: boolean;
  onPlacementToggle?: () => void;
  onPlacementComplete?: (payload: PlacementResult) => void;
  /**
   * Render outside the workspace, from a dialog that opened this project itself.
   *
   * The compile normally waits for `workspaceReady`, which the workspace sets once it has finished
   * opening a project. A dialog in the project list or the template browser has no workspace to
   * wait for, so that flag is never set and the preview sits on "Compiling project..." forever.
   * This says there is nothing to wait for.
   */
  standalone?: boolean;
  /**
   * Compile with element provenance (`data-osw-src`) so a selected element can name its source.
   *
   * Off by default and per-instance rather than global: the publish, export and thumbnail paths
   * construct their own VirtualServer in the same browser tab, and this instrumentation must never
   * reach any of them. Toggling it recompiles in place without navigating.
   */
  provenance?: boolean;
  /**
   * A level of the Elements tree arrived from the frame.
   *
   * Lifted through the host because the panel is a sibling in the workspace's panel map, not a
   * child of this component, so it cannot receive the frame's messages itself.
   */
  onTreeLevel?: (message: Extract<PreviewMessage, { type: 'tree-level' }>) => void;
  /** The answer to `tree-path`: the levels needed to reveal one node. Lifted like `onTreeLevel`. */
  onTreeLevels?: (message: Extract<PreviewMessage, { type: 'tree-levels' }>) => void;
  /**
   * An id the consumer sent could not be resolved in the frame.
   *
   * Lifted for the same reason as `onTreeLevel`. Without this route the frame's `tree-stale` reply
   * reaches the host's listener and stops there, so a selection of a vanished element would look to
   * the panel exactly like a selection that was simply never answered.
   */
  onTreeStale?: (message: Extract<PreviewMessage, { type: 'tree-stale' }>) => void;
  /**
   * The computed values a `style-query` asked for.
   *
   * Lifted for the same reason as `onTreeLevel`: the panel that asked is a sibling in the
   * workspace's panel map, not a child of this component, so the frame's reply cannot reach it
   * directly. Must be `useCallback`-stable — this component is `React.memo` and this prop sits in
   * the message listener's dependency array.
   */
  onStyleComputed?: (message: Extract<PreviewMessage, { type: 'style-computed' }>) => void;
  /**
   * Whether an override actually took effect, and what beat it. Same routing and same stability
   * requirement as `onStyleComputed`.
   */
  onStyleProbeResult?: (message: Extract<PreviewMessage, { type: 'style-probe-result' }>) => void;
  /**
   * A fresh payload for a `selection-resolve`, or `null` when that path no longer resolves.
   *
   * The consumer here is the workspace rather than a panel: it owns the focus context, and a
   * recompile is exactly when the `nodeId` in it stops resolving.
   */
  onSelectionResolved?: (message: Extract<PreviewMessage, { type: 'selection-resolved' }>) => void;
  /**
   * A button on the selection toolbar was pressed inside the frame.
   *
   * Lifted to the workspace rather than answered here, because all three answers are workspace
   * state: which panel is open, which tab it is on, and what goes into the next message. Same
   * `useCallback` stability requirement as `onSelectionResolved` — it sits in the message
   * listener's dependency array.
   */
  onToolbarAction?: (message: Extract<PreviewMessage, { type: 'toolbar-action' }>) => void;
  onToolbarHover?: (message: Extract<PreviewMessage, { type: 'toolbar-hover' }>) => void;
  /**
   * The frame has loaded the document this component wrote, as its own `preview:ready` reports.
   *
   * Fires on every load, so it is also the reload signal: a `srcdoc` reassignment mints a new
   * document and every id a consumer holds for the old one is dead. A consumer that requests
   * anything on mount instead of on this callback is usually posting into `about:blank`.
   */
  onFrameReady?: () => void;
}

type DeviceSize = 'mobile' | 'tablet' | 'desktop' | 'responsive';

const DEVICE_SIZES: Record<DeviceSize, { width?: string; height?: string; maxHeight?: string; maxWidth?: string }> = {
  mobile: { width: '375px', height: '100%', maxHeight: '667px' },
  tablet: { width: '768px', height: '100%', maxHeight: '1024px' },
  desktop: { width: '100%', height: '100%', maxHeight: '900px', maxWidth: '1440px' },
  responsive: { width: '100%', height: '100%' }
};

// Watchdog for an *asynchronous* compile stall (e.g. a hung CDN fetch for an SFC compiler): reject
// so the catch clears the in-flight flag and shows an error instead of freezing recompiles forever.
// (A synchronous main-thread hang can't be timed out — the event loop is blocked; that's the
// heartbeat's job, not this.)
const COMPILE_TIMEOUT_MS = 30000;
/** How long after the frame's load event a document of ours has to report in before it counts as escaped. */
const ACK_TIMEOUT_MS = 3000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); // i18n-ignore: a compile error's detail
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}




/**
 * The extra classes the header's crosshair wears while the pointer is on the Inspector's
 * `Select element` button, which arms the very same tool from the other side of the workspace.
 *
 * The classes are the ghost variant's own `hover:` rule spelled without the pseudo-class, so a
 * remote hover and a real one land on the same colours and a restyle of `ghost` is one place, not
 * two.
 *
 * **Only when the button is not already tinted.** Armed, or holding a focus target, the crosshair
 * carries a state that means something — a hover hint painted over it would either be invisible
 * (the tint is an inline style and wins) or, worse, read as a state change.
 */
export function crosshairHintClass(input: {
  hinted: boolean;
  armed: boolean;
  hasFocusTarget: boolean;
}): string | undefined {
  if (!input.hinted) return undefined;
  if (input.armed || input.hasFocusTarget) return undefined;
  return 'bg-accent text-accent-foreground dark:bg-accent/50';
}

const MultipagePreviewComponent = forwardRef<MultipagePreviewHandle, MultipagePreviewProps>(({
  projectId,
  initialPath,
  onPathChange,
  refreshTrigger,
  onFocusSelection,
  hasFocusTarget = false,
  onClose,
  deploymentId,
  entryPoint,
  runtime,
  onFullscreen,
  isFullscreen = false,
  simple = false,
  placementActive,
  onPlacementToggle,
  onPlacementComplete,
  standalone = false,
  provenance = false,
  onTreeLevel,
  onTreeLevels,
  onTreeStale,
  onStyleComputed,
  onStyleProbeResult,
  onSelectionResolved,
  onToolbarAction,
  onToolbarHover,
  onFrameReady
}, ref) => {
  const t = useTranslations('preview');
  // The compile path reads the translator through a ref: as a dependency, switching language would
  // recompile the preview and send it back to the entry page.
  const previewTextRef = useRef(t);
  previewTextRef.current = t;
  const tc = useTranslations('common');
  const tw = useTranslations('workspace');
  const tsx = useTranslations('styles');
  // Only the selection toolbar reads this: its chrome lives inside the frame, where the app's
  // stylesheet does not reach, so the colours have to be resolved out here and posted in.
  const { resolvedTheme } = useTheme();
  const [compiledProject, setCompiledProject] = useState<CompiledProject | null>(null);
  const [activePath, setActivePath] = useState('/');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceSize, setDeviceSize] = useState<DeviceSize>(() => {
    try {
      const stored = localStorage.getItem('osw-preview-device-size');
      if (stored && stored in DEVICE_SIZES) return stored as DeviceSize;
    } catch {}
    return 'tablet';
  });
  const handleSetDeviceSize = useCallback((size: DeviceSize) => {
    setDeviceSize(size);
    try { localStorage.setItem('osw-preview-device-size', size); } catch {}
  }, []);
  const [navigationHistory, setNavigationHistory] = useState<string[]>(['/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [iframeReady, setIframeReady] = useState(false);
  // The preview "escaped": the frame navigated somewhere that isn't the document the host wrote (a form
  // submit, window.location, meta refresh, etc.). Drives the recovery overlay.
  const [escaped, setEscaped] = useState(false);
  /** The element picker, read out of the layout slice rather than held here. */
  /**
   * The runtime this preview actually renders with.
   *
   * `runtime` is absent for a project whose settings never named one, and every consumer has to
   * agree about what that means -- the compiler, and the features gated on it. Resolved once here
   * so it cannot be answered twice. See lib/vfs/project-settings.ts.
   */
  const resolvedRuntime = runtime ?? FALLBACK_RUNTIME;

  const selectorActive = useWorkspaceStore(s => s.focusToolArmed);
  const [draggingBlock, setDraggingBlock] = useState<PlacementBlockInfo | null>(null);
  // The block a drop made here is waiting on the frame for. The frame runs the project's scripts, so
  // a `placement-complete` it posts is taken only for this block, and only once.
  const pendingDropRef = useRef<string | null>(null);
  const [paletteVisible, setPaletteVisible] = useState(true);
  const [localPaletteOpen, setLocalPaletteOpen] = useState(false);
  const paletteStateRef = useRef({ localPaletteOpen: false, paletteVisible: true, draggingBlock: null as PlacementBlockInfo | null });
  useEffect(() => {
    paletteStateRef.current = { localPaletteOpen, paletteVisible, draggingBlock };
  }, [localPaletteOpen, paletteVisible, draggingBlock]);

  const crosshairButtonStyle = useMemo(() => {
    if (selectorActive) {
      return { backgroundColor: 'var(--button-preview-active)', color: 'white' };
    }
    if (hasFocusTarget) {
      return { backgroundColor: 'rgba(99, 102, 241, 0.12)', color: 'var(--button-preview-active)' };
    }
    return {};
  }, [selectorActive, hasFocusTarget]);

  /**
   * The pointer is on the Inspector's `Select element` button — the other control for this same
   * tool, in a panel with no ancestor short of the workspace. See `focusToolHinted`.
   */
  const crosshairHinted = useWorkspaceStore(s => s.focusToolHinted);
  const crosshairHintClasses = crosshairHintClass({
    hinted: crosshairHinted,
    armed: selectorActive,
    hasFocusTarget,
  });

  useEffect(() => {
    if (placementActive) {
      setPaletteVisible(true);
    }
  }, [placementActive]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Mirror iframeReady into a ref so functions captured in stale closures (e.g. the memoized
  // compileAndLoadInternal, which holds an old loadPage) read the *current* readiness rather than a
  // stale `false` from an early render — otherwise their loadPage defers forever.
  const iframeReadyRef = useRef(false);
  // Stable ref callback: an inline `ref={(el) => ...}` gets a new identity every render, so React
  // detaches (null) + reattaches (node) on every re-render, which made `iframeReady` oscillate.
  // A stable callback only runs on real mount/unmount.
  const setIframeEl = useCallback((el: HTMLIFrameElement | null) => {
    iframeRef.current = el;
    iframeReadyRef.current = !!el;
    setIframeReady(!!el);
  }, []);
  const serverRef = useRef<VirtualServer | null>(null);
  const compiledProjectRef = useRef<CompiledProject | null>(null);
  const activePathRef = useRef<string>('/');
  const pendingLoadPath = useRef<string | null>(null);
  // Per-load handshake / escape recovery. lifecycleRef holds the pure decision logic;
  // loadIdCounterRef mints monotonic ids; loadPageRef lets the stable escape handler reach the
  // latest loadPage closure (for the auto-reload).
  const lifecycleRef = useRef(new PreviewLifecycle());
  // Where the document that is about to be replaced was scrolled to. Written in `loadPage`, the one
  // place a document is ever written, and read back on the frame-ready for the same page — so no
  // scroll listener and no scroll message are involved at all.
  const scrollMemoryRef = useRef(new FrameScrollMemory());
  const loadIdCounterRef = useRef(0);
  const loadPageRef = useRef<((path: string, compiled?: CompiledProject, isRecovery?: boolean) => void) | null>(null);
  // Held in a ref rather than read from the prop: it is consumed by the first compile, and a prop
  // read would re-apply it on every recompile and yank the preview back off the page the user
  // navigated to.
  const pendingInitialPathRef = useRef<string | null>(initialPath ?? null);
  // Pairs each document's acks with the iframe's load events; a load with no ack inside
  // ACK_TIMEOUT_MS is a document that is not ours (`lib/preview/ack-pairing.ts`).
  const ackPairerRef = useRef(new AckPairer(ACK_TIMEOUT_MS));
  // The outgoing document's scroll position, as last reported by the frame itself.
  const frameScrollRef = useRef<FrameScroll | null>(null);
  // Read by the message handler, which is not re-registered when the deployment changes.
  const deploymentIdRef = useRef(deploymentId);
  deploymentIdRef.current = deploymentId;
  // The current load's page, for its shell to ask for (`lib/preview/preview-shell.ts`). Kept until
  // the next load: a page that reloads itself reloads the shell, which asks again. Its `projectId`
  // is the project the page belongs to, whatever the prop has moved on to since.
  const shellPageRef = useRef<{ loadId: number; html: string; blobUrls: string[]; cache: Map<string, Blob>; projectId: string } | null>(null);
  // Blobs already read for a compile, so a reload of the same compile does not read them again.
  const shellCacheRef = useRef(new WeakMap<object, Map<string, Blob>>());

  // Respond to a confident escape signal (a frame load with no `preview:ready` to pair it with: the
  // frame is no longer the host's document): one bounded auto-reload, then the recovery overlay. Stable — safe to call from
  // the load handler.
  const handleEscapeSignal = useCallback((loadId: number) => {
    const action = lifecycleRef.current.onEscapeSignal(loadId);
    if (action === 'auto-reload') {
      loadPageRef.current?.(activePathRef.current || '/', undefined, true);
    } else if (action === 'escaped') {
      setEscaped(true);
    }
  }, []);
  const selectorActiveRef = useRef(false);

  const postMessageToIframe = useCallback((message: PreviewHostMessage) => {
    if (!iframeRef.current || !iframeRef.current.contentWindow) {
      return;
    }
    try {
      iframeRef.current.contentWindow.postMessage(message, '*');
    } catch (err) {
      logger.warn('Failed to communicate with preview iframe', err);
    }
  }, []);

  const handlePlacementDragOver = useCallback((e: React.DragEvent) => {
    if (!draggingBlock) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const iframe = iframeRef.current;
    if (!iframe) return;
    const iframeRect = iframe.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(iframe);
    const transform = computedStyle.transform;
    let scale = 1;
    if (transform && transform !== 'none') {
      const match = transform.match(/matrix\(([^,]+)/);
      if (match) scale = parseFloat(match[1]) || 1;
    }
    const x = (e.clientX - iframeRect.left) / scale;
    const y = (e.clientY - iframeRect.top) / scale;
    postMessageToIframe({ type: 'placement-hover', x, y });
  }, [draggingBlock, postMessageToIframe]);

  const handlePlacementDrop = useCallback((e: React.DragEvent) => {
    if (!draggingBlock) return;
    e.preventDefault();
    pendingDropRef.current = draggingBlock.id;
    postMessageToIframe({ type: 'placement-drop' });
    setDraggingBlock(null);
    setPaletteVisible(true);
  }, [draggingBlock, postMessageToIframe]);

  const handlePlacementDragLeave = useCallback((e: React.DragEvent) => {
    if (!draggingBlock) return;
    const related = e.relatedTarget as Node | null;
    const leaving = !related || !e.currentTarget.contains(related);
    if (leaving) {
      postMessageToIframe({ type: 'placement-cancel' });
    }
  }, [draggingBlock, postMessageToIframe]);

  const startBlockDrag = useCallback((block: PlacementBlockInfo) => {
    pendingDropRef.current = null;
    setDraggingBlock(block);
    postMessageToIframe({ type: 'placement-start', block });
  }, [postMessageToIframe]);

  const handleBlockDragStart = useCallback((block: SemanticBlock) => {
    // Defer state updates — synchronous re-render during dragstart
    // repositions the drag source and browsers cancel the drag.
    setTimeout(() => {
      setPaletteVisible(false);
      startBlockDrag({ id: block.id, name: block.name, wireframeHtml: block.wireframeHtml });
    }, 0);
  }, [startBlockDrag]);

  // Expose captureScreenshot method via ref
  useImperativeHandle(ref, () => ({
    captureScreenshot: async (waitForContent?: boolean, options?: { outputWidth?: number }) => {
      if (!iframeRef.current || !iframeReady) {
        logger.warn('Cannot capture screenshot: iframe not ready');
        return null;
      }
      return await captureIframeScreenshot(
        iframeRef.current,
        undefined, undefined, options?.outputWidth, undefined, undefined,
        waitForContent ?? false,
        1500
      );
    },
    startBlockDrag,
    getActivePath: () => activePath || '/index.html',
    removePlaceholder: (placementId: string) => {
      postMessageToIframe({ type: 'placement-remove', placementId });
    },
    sendToFrame: postMessageToIframe,
    setDevice: handleSetDeviceSize,
  }), [iframeReady, startBlockDrag, activePath, postMessageToIframe, handleSetDeviceSize]);

  const compilingRef = useRef(false);
  const pendingCompileOptionsRef = useRef<CompileRequest | null>(null);
  const compileTimeoutRef = useRef<number | null>(null);
  const scheduledCompileOptionsRef = useRef<CompileRequest | null>(null);
  const compileGeneration = useRef(0);

  // Skipping the compile for a preview that has been measured at 0x0 — the duplicate mobile workspace
  // is hidden by CSS, not unmounted, so without this every change compiles the project twice. The gate
  // starts open and only a measurement closes it; see lib/preview/compile-gate.ts.
  const rootElementRef = useRef<HTMLDivElement | null>(null);
  const compileGateRef = useRef<PreviewCompileGate | null>(null);
  if (!compileGateRef.current) compileGateRef.current = new PreviewCompileGate();
  const rootObserverRef = useRef<ResizeObserver | null>(null);

  const Header = () => (
    isFullscreen ? null : <PanelHeader icon={Eye} title={t('livePreview')} color="var(--button-preview-active)" onClose={onClose} panelKey="preview" />
  );

  useEffect(() => {
    compiledProjectRef.current = compiledProject;
  }, [compiledProject]);

  useEffect(() => {
    selectorActiveRef.current = selectorActive;
    if (iframeReady) {
      postMessageToIframe({ type: 'selector-toggle', active: selectorActive });
    }
  }, [selectorActive, iframeReady, postMessageToIframe]);

  /**
   * Hand the frame the app's resolved colours for the selection toolbar.
   *
   * Sent on frame-ready and on theme change.
   */
  const postToolbarTheme = useCallback(() => {
    if (typeof document === 'undefined') return;
    postMessageToIframe({
      type: 'toolbar-theme',
      colors: resolveToolbarTheme(document.documentElement, resolvedTheme),
    });
  }, [postMessageToIframe, resolvedTheme]);

  const postToolbarThemeRef = useRef(postToolbarTheme);
  postToolbarThemeRef.current = postToolbarTheme;

  useEffect(() => {
    if (iframeReady) postToolbarTheme();
  }, [iframeReady, postToolbarTheme]);

  // Kept in a ref rather than in the load effect's dependencies: the consumer passes an inline
  // callback, so a dependency would tear down and re-add the load listener on every parent render —
  // and that effect also owns escape detection.
  const onFrameReadyRef = useRef(onFrameReady);
  onFrameReadyRef.current = onFrameReady;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }
    const ackPairer = ackPairerRef.current;
    const handleLoad = () => {
      postMessageToIframe({ type: 'selector-toggle', active: selectorActiveRef.current });
      const expected = lifecycleRef.current.loadId;
      if (expected === 0) return; // initial about:blank load, before we've written any document
      ackPairer.onFrameLoad(() => handleEscapeSignal(expected));
    };
    iframe.addEventListener('load', handleLoad);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      ackPairer.stop();
    };
  }, [iframeReady, postMessageToIframe, handleEscapeSignal]);

  /** A shell the host wrote is asking for its page. */
  const handleShellReady = useCallback((loadId: number) => {
    if (!ackPairerRef.current.onAck(loadId)) return;
    const page = shellPageRef.current;
    const target = iframeRef.current?.contentWindow;
    if (!page || page.loadId !== loadId || loadId !== lifecycleRef.current.loadId || !target) return;
    sendShellContent(target, loadId, page.html, page.blobUrls, page.cache, getPreviewStorage(page.projectId)).catch((err) => {
      logger.error('[Preview] Could not send the page to the preview frame:', err);
    });
  }, []);

  /** The current document reached its load event. */
  const handleReadyAck = useCallback((loadId: number) => {
    if (!ackPairerRef.current.onAck(loadId)) return;
    if (!lifecycleRef.current.onAck(loadId)) return;
    setEscaped(false);
    // Before the consumer, deliberately. Frame-ready is answered with a `selection-resolve`,
    // and resolving is what re-anchors the toolbar — whose side is chosen from the viewport. Put
    // the document back where the user had it first, or the bar is placed against scroll 0 and
    // the user is then shown scroll 500. Both are `postMessage` into the same frame, so the
    // frame handles them in this order.
    const restore = scrollMemoryRef.current.take(activePathRef.current);
    if (restore) {
      postMessageToIframe({ type: 'scroll-restore', scrollX: restore.x, scrollY: restore.y });
    }
    // Only here: this is the first moment a message posted into the frame reaches the document
    // the host wrote. Announced on every load, because each one invalidates whatever the consumer knows
    // about the old document.
    onFrameReadyRef.current?.();
    // After the consumer, not before: this document is brand new and has no toolbar colours
    // at all until they are sent again, and the selection the consumer is about to re-resolve
    // is what mounts the toolbar that reads them.
    postToolbarThemeRef.current();
  }, [postMessageToIframe]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);


  useEffect(() => {
    if (iframeReady && pendingLoadPath.current && compiledProjectRef.current) {
      const pathToLoad = pendingLoadPath.current;
      pendingLoadPath.current = null;
      loadPage(pathToLoad, compiledProjectRef.current);
    }
  }, [iframeReady]);

  // Listen for previewNavigate event (dispatched by AI preview command)
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (!path) return;

      if (compiledProjectRef.current) {
        loadPage(path, compiledProjectRef.current);
      } else {
        pendingLoadPath.current = path;
      }
    };
    window.addEventListener('previewNavigate', handler);
    return () => window.removeEventListener('previewNavigate', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (compileTimeoutRef.current) {
        window.clearTimeout(compileTimeoutRef.current);
      }
    };
  }, []);

  const compileAndLoadInternal = useCallback(async (preserveCurrentPath = false, showLoading = true) => {
    const gen = ++compileGeneration.current;

    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      await vfs.init();

      const currentPath = preserveCurrentPath ? activePathRef.current : null;

      if (serverRef.current) {
        serverRef.current.cleanupBlobUrls();
      }

      const server = new VirtualServer(vfs, projectId, { deploymentId: deploymentId || undefined, entryPoint, runtime: resolvedRuntime, provenance, blobModules: true });
      serverRef.current = server;

      const compiled = await withTimeout(server.compileProject(), COMPILE_TIMEOUT_MS, 'Compile');

      // A newer compile started while we were awaiting — discard this result
      if (gen !== compileGeneration.current) return;

      setCompiledProject(compiled);
      compiledProjectRef.current = compiled;

      let pathToLoad = currentPath;

      // The caller's requested page, spent once. Only honoured when the build actually contains it,
      // so a stale request falls through to the entry point rather than raising "Page not found".
      if (!pathToLoad && pendingInitialPathRef.current) {
        const requested = pendingInitialPathRef.current;
        pendingInitialPathRef.current = null;
        const known =
          compiled.routes.some(route => route.path === requested) ||
          compiled.files.some(file => file.path === requested);
        if (known) pathToLoad = requested;
      }

      if (!pathToLoad) {
        const ep = compiled.entryPoint || '/index.html';
        if (ep !== '/index.html' && compiled.blobUrls.has(ep)) {
          // Non-default entry point — navigate directly to it
          pathToLoad = ep;
        } else {
          pathToLoad = compiled.blobUrls.has(ep) ? '/' :
                       (compiled.routes.length > 0 ? compiled.routes[0].path : '/');
        }
      }

      loadPage(pathToLoad, compiled);
    } catch (err) {
      setError(err instanceof Error ? err.message : previewTextRef.current('compileFailed'));
      logger.error('Compilation error:', err);
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [projectId, deploymentId, entryPoint, resolvedRuntime, provenance]);

  const compileAndLoad = useCallback((preserveCurrentPath: boolean = false, showLoading: boolean = true) => {
    // Ahead of the in-flight check on purpose: a hidden preview's request is parked in the gate's own
    // slot, not in pendingCompileOptionsRef, which belongs to the in-flight queue and would drain into
    // a compile when the current one finishes.
    const gate = compileGateRef.current!;
    let incoming = { preserve: preserveCurrentPath, showLoading };
    if (gate.isHidden()) {
      // Re-measure before parking again. The ResizeObserver is the primary way the gate reopens, but
      // its callbacks are delivered with the rendering steps, so a tab that is not rendering receives
      // none — and a CSS-only reveal (crossing the `md` breakpoint) re-renders no React, so nothing
      // re-attaches the callback ref either. Every request is a free opportunity to find out that the
      // box came back, and it costs one getBoundingClientRect on a preview that is not compiling.
      const revived = gate.measure(rootElementRef.current?.getBoundingClientRect());
      if (revived) incoming = mergeCompileRequests(revived, incoming);
    }
    const requested = gate.request(incoming);
    if (!requested) return;

    if (compilingRef.current) {
      pendingCompileOptionsRef.current = mergeCompileRequests(pendingCompileOptionsRef.current, requested);
      return;
    }

    const run = async (preserve: boolean, loadingFlag: boolean) => {
      compilingRef.current = true;
      try {
        await compileAndLoadInternal(preserve, loadingFlag);
      } finally {
        compilingRef.current = false;
        const pending = pendingCompileOptionsRef.current;
        pendingCompileOptionsRef.current = null;
        if (pending) {
          compileAndLoad(pending.preserve, pending.showLoading);
        }
      }
    };

    void run(requested.preserve, requested.showLoading);
  }, [compileAndLoadInternal]);

  const scheduleCompile = useCallback((preserveCurrentPath = false, showLoading = false) => {
    scheduledCompileOptionsRef.current = mergeCompileRequests(
      scheduledCompileOptionsRef.current,
      { preserve: preserveCurrentPath, showLoading }
    );

    if (compileTimeoutRef.current) {
      window.clearTimeout(compileTimeoutRef.current);
    }

    compileTimeoutRef.current = window.setTimeout(() => {
      const options = scheduledCompileOptionsRef.current;
      scheduledCompileOptionsRef.current = null;
      compileTimeoutRef.current = null;
      if (options) {
        compileAndLoad(options.preserve, options.showLoading);
      }
    }, 150);
  }, [compileAndLoad]);

  // The observer outlives any one render, so it reaches the current compileAndLoad through a ref
  // rather than being torn down and re-established whenever that callback's identity changes.
  const compileAndLoadRef = useRef(compileAndLoad);
  compileAndLoadRef.current = compileAndLoad;

  // Attached to whichever root this component renders (loading, error, or the preview itself). A
  // callback ref rather than useRef + useEffect because the root element is a different node in each
  // of those three branches, and only a callback ref is told when it is swapped.
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    // Kept so a compile request can re-measure without waiting for an observation. See compileAndLoad.
    rootElementRef.current = node;
    rootObserverRef.current?.disconnect();
    rootObserverRef.current = observePreviewRoot(node, compileGateRef.current!, request => {
      // observePreviewRoot probes synchronously, so this can land inside React's commit; a microtask
      // puts the compile's setState after the commit instead of inside it.
      queueMicrotask(() => compileAndLoadRef.current(request.preserve, request.showLoading));
    });
  }, []);

  const workspaceReadyFlag = useWorkspaceStore(s => s.workspaceReady);
  // A standalone preview owns its project, so there is no opening sequence to wait behind.
  const workspaceReady = standalone || workspaceReadyFlag;
  const workspaceReadyRef = useRef(workspaceReady);
  workspaceReadyRef.current = workspaceReady;

  useEffect(() => {
    if (!workspaceReady) return;
    compileAndLoad();
  }, [projectId, workspaceReady, compileAndLoad]);

  // Toggling provenance changes the compiled output, so it needs a recompile — but only when the
  // flag itself changed. The guard is on the previous *value*, not on "is this the first run":
  // compileAndLoad's identity also changes with projectId/deploymentId/entryPoint/runtime, and a
  // first-run guard would then fire here on every project switch. Because compileAndLoad OR-merges
  // pending options, that would force preserve: true onto the fresh-navigation compile the effect
  // above is already doing, plus a redundant second compile.
  const prevProvenance = useRef(provenance);
  useEffect(() => {
    if (prevProvenance.current === provenance) return;
    prevProvenance.current = provenance;
    // Keep the current page, no loading flash — the user is looking at the page they selected in.
    compileAndLoad(true, false);
  }, [provenance, compileAndLoad]);

  // refreshTrigger bumps coalesce with concurrent filesChanged events through
  // the same debounce so a bulk operation produces one compile, not two.
  const isFirstRefreshTrigger = useRef(true);
  useEffect(() => {
    if (isFirstRefreshTrigger.current) {
      isFirstRefreshTrigger.current = false;
      return;
    }
    if (!workspaceReadyRef.current) return;
    scheduleCompile(true);
  }, [refreshTrigger, scheduleCompile]);

  useEffect(() => {
    const handleFileChange = () => {
      if (!workspaceReadyRef.current) return;
      scheduleCompile(true);
    };

    const handleFileContentChange = (event: Event) => {
      if (!workspaceReadyRef.current) return;
      const customEvent = event as CustomEvent<{ projectId?: string }>;
      if (!customEvent.detail || customEvent.detail.projectId === projectId) {
        scheduleCompile(true);
      }
    };

    window.addEventListener('filesChanged', handleFileChange as EventListener);
    window.addEventListener('fileContentChanged', handleFileContentChange as EventListener);
    return () => {
      window.removeEventListener('filesChanged', handleFileChange as EventListener);
      window.removeEventListener('fileContentChanged', handleFileContentChange as EventListener);
    };
  }, [projectId, scheduleCompile]);


  const loadPage = (path: string, compiled?: CompiledProject, isRecovery = false) => {
    const projectToUse = compiled || compiledProjectRef.current || compiledProject;

    if (!projectToUse) {
      logger.warn('No compiled project available');
      return;
    }

    // Read the store rather than the ref mirror: the mirror is populated by an effect, so on a fresh
    // mount it still says `false` while the flag may already be armed, and the else-branch would
    // leave the store armed against a document that is being replaced.
    if (useWorkspaceStore.getState().focusToolArmed) {
      useWorkspaceStore.getState().setFocusToolArmed(false);
    } else {
      postMessageToIframe({ type: 'selector-toggle', active: false });
    }

    if (!iframeRef.current || !iframeReadyRef.current) {
      pendingLoadPath.current = path;
      return;
    }

    let normalizedPath = path;
    if (!normalizedPath.startsWith('/')) {
      normalizedPath = '/' + normalizedPath;
    }

    const route = projectToUse.routes.find(r => r.path === normalizedPath);
    let filePath: string;
    if (route) {
      filePath = route.file;
    } else if (normalizedPath === '/') {
      filePath = '/index.html';
    } else if (normalizedPath.endsWith('.html')) {
      // Already a full file path (e.g., entry point like /.renderer/index.html)
      filePath = normalizedPath;
    } else if (normalizedPath.endsWith('/')) {
      // Directory path - look for index.html
      filePath = normalizedPath + 'index.html';
    } else {
      filePath = normalizedPath + '.html';
    }

    let htmlFile = projectToUse.files.find(f => f.path === filePath);

    // If not found and path doesn't end with /, try directory index as fallback
    if (!htmlFile && !normalizedPath.endsWith('/')) {
      const dirIndexPath = normalizedPath + '/index.html';
      htmlFile = projectToUse.files.find(f => f.path === dirIndexPath);
      if (htmlFile) {
        filePath = dirIndexPath;
      }
    }

    if (!htmlFile) {
      setError(t('pageNotFound', { path }));
      const indexFile = projectToUse.files.find(f => f.path === '/index.html' || f.path === 'index.html');
      if (indexFile && path !== '/') {
        loadPage('/', compiled);
      }
      return;
    }

    let processedHtml = typeof htmlFile.content === 'string' 
      ? htmlFile.content 
      : new TextDecoder().decode(htmlFile.content as ArrayBuffer);
    
    // The stylesheets, scripts and images the page names, resolved from the page's own folder.
    processedHtml = pointPageAtBlobs(processedHtml, filePath, projectToUse.blobUrls);

    // The resolved runtime, not the prop: a project whose settings never named one is compiled as
    // the fallback, and asking `supportsDirectEditing` about `undefined` answered "no toolbar" for a
    // document that had just been stamped with the provenance the toolbar runs on.
    const navigationScript = generateNavigationScript(normalizedPath, supportsDirectEditing(resolvedRuntime), '', filePath);
    
    const placementScript = generatePlacementScript(filePath);
    const injectedScripts = navigationScript + placementScript;
    if (processedHtml.includes('</body>')) {
      processedHtml = processedHtml.replace('</body>', injectedScripts + '</body>');
    } else {
      processedHtml += injectedScripts;
    }

    // Expose the blob-URL map to the iframe so the runtime fetch/XHR interceptor can resolve any
    // VFS path (e.g. fetch('/components/nav.html')). A compiled page carries no map of its own, so
    // whoever renders one has to supply it; `injectVfsBlobMap` is the same script for renderers
    // that inject it alone, and the two have to stay in step.
    const vfsMapJson = JSON.stringify(Object.fromEntries(projectToUse.blobUrls)).replace(/</g, '\\u003c');
    const vfsMapScript = `<script>window.__oswVfsBlobUrls = ${vfsMapJson};</script>`;

    // Where the outgoing document was scrolled to, as it last reported, keyed on the page it was
    // showing — `activePathRef` is still the old path here, and is updated below. A recompile
    // reloads the same path and gets it back; a navigation does not, and opens at the top.
    scrollMemoryRef.current.remember(activePathRef.current, frameScrollRef.current);
    frameScrollRef.current = null;

    // Per-load handshake: the document reports its own load and scroll position by message, with a
    // fresh loadId (runs during parse, before app JS). See `previewBridgeScript`.
    const loadId = ++loadIdCounterRef.current;
    lifecycleRef.current.beginLoad(loadId, isRecovery);
    ackPairerRef.current.begin(loadId);
    const bridgeScript = previewBridgeScript(loadId);
    // Placeholders of Semantic blocks have no look in the source: the preview gives them one.
    const headInject = bridgeScript + vfsMapScript + `<style data-osw-placeholder>${PLACEHOLDER_CSS}</style>`;
    processedHtml = prependToHead(processedHtml, headInject);

    // Clear stale runtime errors before loading new content —
    // only errors from this compilation should be in the buffer.
    clearRuntimeErrors();
    // The frame is first given the shell, which asks for this page and makes its own URLs for the
    // project's files: see `lib/preview/preview-shell.ts`.
    let cache = shellCacheRef.current.get(projectToUse);
    if (!cache) {
      cache = new Map();
      shellCacheRef.current.set(projectToUse, cache);
    }
    shellPageRef.current = { loadId, html: processedHtml, blobUrls: [...projectToUse.blobUrls.values()], cache, projectId };
    iframeRef.current.srcdoc = previewShellHtml(loadId);
    setActivePath(normalizedPath);
    activePathRef.current = normalizedPath;
    // The resolved file, not the requested path. A link to "/" and one to "/index.html" are the
    // same page, and a scoped chat suggestion has to treat them as one: every built-in template
    // links home as href="/", so a rule naming /index.html would stop matching the moment someone
    // clicked Home. `activePath` stays as requested, for the callers that reload from it.
    onPathChange?.(filePath);
  };

  // Keep a ref to the latest loadPage so stable callbacks (escape timer, message handler) can call it.
  loadPageRef.current = loadPage;

  // Push a new entry (truncating any forward history). Kept separate from loadPage so that
  // Back/Forward (which re-render a page without changing history) don't re-append — the old
  // bug where loadPage always pushed made Back immediately return to the end.
  const pushHistory = useCallback((path: string) => {
    const normalized = path.startsWith('/') ? path : '/' + path;
    setHistoryIndex(currentIndex => {
      setNavigationHistory(currentHistory => [...currentHistory.slice(0, currentIndex + 1), normalized]);
      return currentIndex + 1;
    });
  }, []);

  const handleNavigation = useCallback((path: string) => {
    loadPage(path);
    pushHistory(path);
  }, [compiledProject, pushHistory]);

  const handleBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      loadPage(navigationHistory[newIndex]);
    }
  };

  const handleForward = () => {
    if (historyIndex < navigationHistory.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      loadPage(navigationHistory[newIndex]);
    }
  };

  const handleHome = () => {
    loadPage('/');
    pushHistory('/');
  };

  const handleRefresh = () => {
    compileAndLoad(true, false);
  };


  useEffect(() => {
    const handleMessage = (event: MessageEvent<PreviewMessage>) => {
      // Only handle messages from our own iframe.
      //
      // The missing-ref case is a rejection, not a pass. The workspace mounts this component twice —
      // a desktop tree and a mobile one — and only the visible mount renders an iframe, so in the
      // other one `iframeRef.current` is null. Guarding on `iframeRef.current &&` made that mount
      // accept every message the *visible* frame posted: a click in the desktop preview reached the
      // mobile mount's `onFocusSelection` as well, which carries `surface: 'mobile'`, and the mobile
      // rule includes every selection in the next message. Selecting an element attached it to the
      // prompt with nothing pressed.
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== 'object') {
        return;
      }

      if (data.type === 'preview:shell-ready' && typeof data.loadId === 'number') {
        handleShellReady(data.loadId);
        return;
      }

      if (data.type === 'preview:function-call') {
        answerFunctionCall(data, deploymentIdRef.current, event.source as Window, () => lifecycleRef.current.loadId).catch((err) => {
          logger.error('[Preview] Could not answer a function call from the preview frame:', err);
        });
        return;
      }

      if (data.type === 'preview:storage') {
        const reportFor = storageReportProject(data.loadId, lifecycleRef.current.loadId, shellPageRef.current);
        if (reportFor !== null) setPreviewStorageArea(reportFor, data.area, data.data);
        return;
      }

      if (data.type === 'preview:shell-error') {
        logger.error('[Preview] The preview frame could not build the page:', data.error);
        return;
      }

      if (data.type === 'preview:ready' && typeof data.loadId === 'number') {
        handleReadyAck(data.loadId);
        return;
      }

      const scroll = data.type === 'preview:scroll' ? frameScrollReport(data, lifecycleRef.current.loadId) : null;
      if (scroll) {
        frameScrollRef.current = scroll;
        return;
      }

      if (data.type === 'console') {
        window.dispatchEvent(new CustomEvent('previewConsole', {
          detail: { level: data.level, args: data.args },
        }));
        if (data.level === 'error') {
          pushRuntimeError(data.args.join(' '));
        }
        return;
      }

      if (data.type === 'navigate' && data.path) {
        handleNavigation(data.path);
        return;
      }

      if (data.type === 'preview:external' && data.href) {
        // External link from the preview. The iframe runs untrusted content, so validate the scheme
        // before opening — only http(s) web links, never javascript:/data:/etc. (which window.open
        // would execute/render). Then confirm and open a new tab from the host context with
        // noopener,noreferrer so the target gets no window.opener handle and no referrer.
        let url: URL;
        try { url = new URL(data.href, window.location.href); } catch { return; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        const href = url.href;
        toast(t('openExternalLink'), {
          description: url.host,
          action: {
            label: tc('actions.openInNewTab'),
            onClick: () => { window.open(href, '_blank', 'noopener,noreferrer'); },
          },
        });
        return;
      }

      if (data.type === 'selector-selection' && data.payload) {
        useWorkspaceStore.getState().setFocusToolArmed(false);
        onFocusSelection?.(data.payload);
        return;
      }

      if (data.type === 'selector-cancelled') {
        useWorkspaceStore.getState().setFocusToolArmed(false);
        return;
      }

      if (data.type === 'placement-complete' && data.payload) {
        if (pendingDropRef.current === null || data.payload.blockId !== pendingDropRef.current) return;
        pendingDropRef.current = null;
        setPaletteVisible(true);
        onPlacementComplete?.(data.payload);
        return;
      }

      if (data.type === 'placement-cancelled') {
        pendingDropRef.current = null;
        setDraggingBlock(null);
        setPaletteVisible(true);
        return;
      }

      if (data.type === 'tree-level') {
        onTreeLevel?.(data);
        return;
      }

      if (data.type === 'tree-levels') {
        onTreeLevels?.(data);
        return;
      }

      if (data.type === 'tree-stale') {
        onTreeStale?.(data);
        return;
      }

      if (data.type === 'style-computed') {
        onStyleComputed?.(data);
        return;
      }

      if (data.type === 'style-probe-result') {
        onStyleProbeResult?.(data);
        return;
      }

      if (data.type === 'selection-resolved') {
        onSelectionResolved?.(data);
        return;
      }

      if (data.type === 'toolbar-action') {
        onToolbarAction?.(data);
        return;
      }

      if (data.type === 'toolbar-hover') {
        onToolbarHover?.(data);
        return;
      }

      if (data.type === 'iframe-click') {
        const ps = paletteStateRef.current;
        if (ps.localPaletteOpen && ps.paletteVisible && !ps.draggingBlock) {
          setLocalPaletteOpen(false);
          setTimeout(() => onPlacementToggle?.(), 0);
        }
        return;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleNavigation, handleReadyAck, handleShellReady, onFocusSelection, onPlacementComplete, onTreeLevel, onTreeLevels, onTreeStale,
      onStyleComputed, onStyleProbeResult, onSelectionResolved, onToolbarAction, onToolbarHover, t, tc]);


  useEffect(() => {
    return () => {
      if (serverRef.current) {
        serverRef.current.cleanupBlobUrls();
      }
    };
  }, []);

  useEffect(() => {
    if (placementActive && selectorActive) {
      useWorkspaceStore.getState().setFocusToolArmed(false);
    }
  }, [placementActive, selectorActive]);

  useEffect(() => {
    if (!draggingBlock) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        postMessageToIframe({ type: 'placement-cancel' });
        setDraggingBlock(null);
        setPaletteVisible(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draggingBlock, postMessageToIframe]);

  if (loading) {
    return (
      <div ref={attachRoot} className="h-full flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto text-primary" />
            <p className="text-muted-foreground">{t('compiling')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div ref={attachRoot} className="h-full flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-destructive space-y-2">
            <p className="font-medium">{tc('labels.error')}</p>
            <p className="text-sm mt-2">{error}</p>
            <Button onClick={handleRefresh} className="mt-4">
              {tc('actions.tryAgain')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // The navigation and tool buttons, the same in the phone row and the desktop one.
  const selectTip = selectorActive ? tsx('cancelSelectionLong') : hasFocusTarget ? t('replaceFocused') : tw('selectElement');
  const navButtons = (
    <>
      <Tip label={t('tips.back')} side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={handleBack}
          disabled={historyIndex === 0}
          aria-label={t('tips.back')}
        >
          <ChevronLeft className="h-3 w-3" />
        </Button>
      </Tip>
      <Tip label={t('tips.forward')} side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={handleForward}
          disabled={historyIndex >= navigationHistory.length - 1}
          aria-label={t('tips.forward')}
        >
          <ChevronRight className="h-3 w-3" />
        </Button>
      </Tip>
      <Tip label={t('tips.home')} side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={handleHome}
          aria-label={t('tips.home')}
        >
          <Home className="h-3 w-3" />
        </Button>
      </Tip>
      <Tip label={t('reload')} side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={handleRefresh}
          aria-label={t('reload')}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </Tip>
      <Tip label={selectTip} side="bottom">
        <Button
          size="icon"
          variant="ghost"
          className={cn('h-5 w-5 rounded-sm', crosshairHintClasses)}
          onClick={() => {
            const next = !selectorActive;
            useWorkspaceStore.getState().setFocusToolArmed(next);
            if (next && localPaletteOpen) {
              setLocalPaletteOpen(false);
              setTimeout(() => onPlacementToggle?.(), 0);
            }
          }}
          disabled={!iframeReady}
          style={crosshairButtonStyle}
          aria-label={selectTip}
          aria-pressed={selectorActive}
          data-tour-id="focus-crosshair-button"
        >
          <Crosshair className="h-3 w-3" />
        </Button>
      </Tip>
      {!simple && (
        <Tip label={t('tips.semanticBlocks')} side="bottom">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 rounded-sm"
            onClick={() => {
              setLocalPaletteOpen(prev => !prev);
              setTimeout(() => onPlacementToggle?.(), 0);
            }}
            disabled={!iframeReady}
            aria-label={t('semanticBlocks')}
            aria-pressed={localPaletteOpen}
            style={localPaletteOpen ? { backgroundColor: 'var(--button-preview-active)', color: 'white' } : {}}
          >
            <LayoutGrid className="h-3 w-3" />
          </Button>
        </Tip>
      )}
    </>
  );

  return (
    <div ref={attachRoot} className="h-full flex flex-col">
      <Header />
      {/* Mobile Layout - Single row with navigation and page selector. Shown in quick edit too,
          where the preview shares the screen with the Inspector and this is the only way to
          drive it. */}
      <div className="border-b p-2 flex items-center gap-2 md:hidden">
        <div className="flex items-center gap-1">
          {navButtons}
        </div>

        {/* Page selector takes remaining space */}
        {compiledProject && compiledProject.routes.length > 1 && (
          <Select value={activePath} onValueChange={handleNavigation}>
            <Tip label={t('tips.page')} side="bottom" wrap wrapClassName="flex flex-1 min-w-0 max-w-full">
              <SelectTrigger className="flex-1 h-8 min-w-0 max-w-full" aria-label={t('tips.page')}>
                <SelectValue className="truncate" />
              </SelectTrigger>
            </Tip>
            <SelectContent>
              {compiledProject.routes.map(route => (
                <SelectItem key={route.path} value={route.path}>
                  {route.title || route.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Desktop Layout - Single row */}
      <div className="border-b p-2 hidden md:flex items-center gap-2">
        <div className="flex items-center gap-1">
          {navButtons}
        </div>

        <div className="flex-1 px-3 py-1 bg-muted rounded text-sm">
          {activePath}
        </div>

        {compiledProject && compiledProject.routes.length > 1 && (
          <Select value={activePath} onValueChange={handleNavigation}>
            <Tip label={t('tips.page')} side="bottom" wrap>
              <SelectTrigger className="w-[200px] h-8" aria-label={t('tips.page')}>
                <SelectValue />
              </SelectTrigger>
            </Tip>
            <SelectContent>
              {compiledProject.routes.map(route => (
                <SelectItem key={route.path} value={route.path}>
                  {route.title || route.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex items-center gap-1 border-l pl-2">
          <Tip label={t('tips.phone')} side="bottom">
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 rounded-sm"
              style={{
                backgroundColor: deviceSize === 'mobile' ? 'var(--button-preview-active)' : undefined,
                color: deviceSize === 'mobile' ? 'white' : undefined
              }}
              onClick={() => handleSetDeviceSize('mobile')}
              aria-label={t('tips.phone')}
              aria-pressed={deviceSize === 'mobile'}
            >
              <Smartphone className="h-3 w-3" />
            </Button>
          </Tip>
          <Tip label={t('tips.tablet')} side="bottom">
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 rounded-sm"
              style={{
                backgroundColor: deviceSize === 'tablet' ? 'var(--button-preview-active)' : undefined,
                color: deviceSize === 'tablet' ? 'white' : undefined
              }}
              onClick={() => handleSetDeviceSize('tablet')}
              aria-label={t('tips.tablet')}
              aria-pressed={deviceSize === 'tablet'}
            >
              <Tablet className="h-3 w-3" />
            </Button>
          </Tip>
          <Tip label={t('tips.desktop')} side="bottom">
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 rounded-sm"
              style={{
                backgroundColor: deviceSize === 'desktop' ? 'var(--button-preview-active)' : undefined,
                color: deviceSize === 'desktop' ? 'white' : undefined
              }}
              onClick={() => handleSetDeviceSize('desktop')}
              aria-label={t('tips.desktop')}
              aria-pressed={deviceSize === 'desktop'}
            >
              <Monitor className="h-3 w-3" />
            </Button>
          </Tip>
          {isFullscreen ? (
            <Tip label={t('exitFullSize')} side="bottom" align="end">
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 rounded-sm"
                onClick={onClose}
                aria-label={t('exitFullSize')}
              >
                <Minimize className="h-3 w-3" />
              </Button>
            </Tip>
          ) : onFullscreen ? (
            <Tip label={t('fullSize')} side="bottom" align="end">
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 rounded-sm"
                onClick={onFullscreen}
                aria-label={t('fullSize')}
              >
                <Maximize className="h-3 w-3" />
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>

      {/* Preview Frame */}
      <div
        className={cn("flex-1 bg-muted/20 dark:bg-muted/10 overflow-auto min-h-0 relative", !isFullscreen && "p-4")}
        onClick={() => {
          if (localPaletteOpen && paletteVisible && !draggingBlock) {
            setLocalPaletteOpen(false);
            setTimeout(() => onPlacementToggle?.(), 0);
          }
        }}
      >
        <PalettePanel
          onDragStart={handleBlockDragStart}
          onClose={() => { setLocalPaletteOpen(false); setTimeout(() => onPlacementToggle?.(), 0); }}
          collapsed={!localPaletteOpen || !paletteVisible}
        />
        {escaped && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="max-w-xs rounded-lg border border-border bg-card p-4 text-center shadow-lg">
              <p className="text-sm font-medium">{t('navigatedAway')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('navigatedAwayHint')}
              </p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => loadPageRef.current?.(activePathRef.current || '/', undefined, false)}
              >
                {t('reload')}
              </Button>
            </div>
          </div>
        )}
        <div
          className={cn(
            "bg-white mx-auto transition-all duration-300",
            !isFullscreen && "shadow-2xl",
            !isFullscreen && deviceSize !== 'responsive' && "rounded-lg"
          )}
          style={{
            width: DEVICE_SIZES[deviceSize].width || '100%',
            height: DEVICE_SIZES[deviceSize].height || '100%',
            maxHeight: DEVICE_SIZES[deviceSize].maxHeight || '100%',
            maxWidth: DEVICE_SIZES[deviceSize].maxWidth || '100%',
            ...(draggingBlock ? { cursor: 'crosshair' } : {}),
          }}
          onDragOver={handlePlacementDragOver}
          onDrop={handlePlacementDrop}
          onDragLeave={handlePlacementDragLeave}
        >
          <iframe
            ref={setIframeEl}
            className={cn("w-full h-full", !isFullscreen && "rounded-lg")}
            // No allow-same-origin: project code runs here, and must not reach the app's origin.
            sandbox={PREVIEW_SANDBOX}
            title={tw('tabs.preview')}
            style={draggingBlock ? { pointerEvents: 'none' } : undefined}
          />
        </div>
      </div>
    </div>
  );
});

MultipagePreviewComponent.displayName = 'MultipagePreview';

export const MultipagePreview = React.memo(MultipagePreviewComponent);
