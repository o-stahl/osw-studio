'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ElementsTreeRow } from './tree-node';
import { StylesContent, type StylesContentHandle } from '@/components/styles-content';
import type { ApplyStyle, ReadOverrides, RemoveStyle } from '@/components/styles-content/commit';
import type { ColorToken } from '@/components/styles-content/tokens';
import type { ApplyResult } from '@/lib/direct-edit/types';
import type { TextReadResult } from '@/lib/direct-edit/apply-text';
import type { FocusContextPayload, PreviewHostMessage, PreviewMessage, TreeNode } from '@/lib/preview/types';
import type { ProjectRuntime } from '@/lib/vfs/types';
import { getRuntimeConfig, isRuntimeBundled } from '@/lib/runtimes/registry';

/**
 * The Elements panel's state: a flat node map plus the level structure around it.
 *
 * Nodes are keyed by the frame's transient `data-osw-node` id, and the level map is keyed by parent
 * id with `null` for the body level — the same addressing the frame uses, so nothing here has to
 * invent a second identity for an element. Every id in here dies with the next `srcdoc`
 * reassignment; see {@link reduceTree}'s `frame-ready` case.
 */
export interface TreeState {
  nodes: Map<string, TreeNode>;
  /** Parent id (`null` = the body level) to the ordered ids of its serialized children. */
  children: Map<string | null, string[]>;
  /** Parent id to how many of its children the serializer dropped past its per-level cap. */
  truncated: Map<string | null, number>;
  expanded: Set<string>;
  selectedId: string | null;
}

export function emptyTreeState(): TreeState {
  return {
    nodes: new Map(),
    children: new Map(),
    truncated: new Map(),
    expanded: new Set(),
    selectedId: null,
  };
}

export type TreeEvent =
  /** The frame loaded a document — the first one, or a recompile's replacement. */
  | { type: 'frame-ready' }
  | { type: 'level'; parentId: string | null; nodes: TreeNode[]; truncated: number }
  /** The frame reported that an id the panel asked about no longer resolves. */
  | { type: 'stale' }
  | { type: 'toggle'; nodeId: string }
  | { type: 'select'; nodeId: string }
  | { type: 'hover'; nodeId: string | null }
  /** The user asked for the tree again — same handling as a load, without waiting for one. */
  | { type: 'refresh' }
  /**
   * The levels down to a node picked in the preview, with the ancestors to open.
   *
   * Applied as one transition rather than as a run of `level` events, because each level is only
   * mergeable once its parent is known: `level` drops a level whose parent it has not seen, to keep
   * replies from a replaced document from grafting orphan rows onto the live tree.
   */
  | { type: 'reveal'; levels: Array<{ parentId: string | null; nodes: TreeNode[]; truncated: number }>; path: string[] };

export interface TreeTransition {
  state: TreeState;
  /** Messages the panel must post into the frame for this transition. */
  requests: PreviewHostMessage[];
}

const REQUEST_ROOT: PreviewHostMessage[] = [{ type: 'tree-request', nodeId: null }];

/**
 * The whole panel's logic, as one pure function over {@link TreeState}.
 *
 * Collapse resets to root on reload (all ids die with the replaced document);
 * cached levels survive re-expand without a round trip.
 */
export function reduceTree(state: TreeState, event: TreeEvent): TreeTransition {
  switch (event.type) {
    case 'frame-ready':
    case 'refresh':
    case 'stale':
      return { state: emptyTreeState(), requests: REQUEST_ROOT };

    case 'level': {
      if (event.parentId === null) {
        // The body level defines a document. Anything the panel held belonged to the previous one.
        const next = emptyTreeState();
        for (const node of event.nodes) next.nodes.set(node.id, node);
        next.children.set(null, event.nodes.map(n => n.id));
        if (event.truncated > 0) next.truncated.set(null, event.truncated);
        return { state: next, requests: [] };
      }

      // A level for a parent this panel does not know about is a reply from a document that has
      // since been replaced. Merging it would graft orphan rows onto the live tree.
      if (!state.nodes.has(event.parentId)) {
        return { state, requests: [] };
      }

      const nodes = new Map(state.nodes);
      const children = new Map(state.children);
      const truncated = new Map(state.truncated);
      const expanded = new Set(state.expanded);

      if (event.nodes.length === 0) {
        expanded.delete(event.parentId);
        children.delete(event.parentId);
        truncated.delete(event.parentId);
        const parent = nodes.get(event.parentId)!;
        nodes.set(event.parentId, { ...parent, hasChildren: false });
        return { state: { ...state, nodes, children, truncated, expanded }, requests: [] };
      }

      for (const node of event.nodes) nodes.set(node.id, node);
      children.set(event.parentId, event.nodes.map(n => n.id));
      if (event.truncated > 0) truncated.set(event.parentId, event.truncated);
      else truncated.delete(event.parentId);
      return { state: { ...state, nodes, children, truncated, expanded }, requests: [] };
    }

    case 'toggle': {
      const node = state.nodes.get(event.nodeId);
      if (!node) return { state, requests: [] };
      const expanded = new Set(state.expanded);
      if (expanded.has(event.nodeId)) {
        expanded.delete(event.nodeId);
        return { state: { ...state, expanded }, requests: [] };
      }
      expanded.add(event.nodeId);
      // A level already serialized stays cached: re-expanding it must not cost a round trip, and
      // the frame keeps the same ids for elements it has already stamped.
      const requests: PreviewHostMessage[] = state.children.has(event.nodeId)
        ? []
        : [{ type: 'tree-request', nodeId: event.nodeId }];
      return { state: { ...state, expanded }, requests };
    }

    case 'reveal': {
      // Empty levels means the frame could not resolve the node. Nothing is dropped for that: the
      // tree on screen is still the live document's.
      if (event.levels.length === 0) return { state, requests: [] };

      // Rebuilt from the body level up, so this is the document the frame just described rather
      // than a merge into whatever the panel happened to be holding.
      const next = emptyTreeState();
      for (const level of event.levels) {
        for (const node of level.nodes) next.nodes.set(node.id, node);
        next.children.set(level.parentId, level.nodes.map((n) => n.id));
        if (level.truncated > 0) next.truncated.set(level.parentId, level.truncated);
      }
      // Every ancestor opens; the node itself is the last entry and is selected, not expanded.
      const selectedId = event.path.length > 0 ? event.path[event.path.length - 1] : state.selectedId;
      for (const id of event.path.slice(0, -1)) next.expanded.add(id);
      return { state: { ...next, selectedId }, requests: [] };
    }

    case 'select': {
      if (!state.nodes.has(event.nodeId)) return { state, requests: [] };
      return {
        state: { ...state, selectedId: event.nodeId },
        requests: [{ type: 'tree-select', nodeId: event.nodeId }],
      };
    }

    case 'hover':
      // No state of its own: the highlight lives in the frame's shared overlay, and mirroring it
      // here would be a second source of truth for what is highlighted.
      return { state, requests: [{ type: 'tree-highlight', nodeId: event.nodeId }] };
  }
}

export type TreeRow =
  | { kind: 'node'; node: TreeNode; depth: number; expanded: boolean; selected: boolean }
  | { kind: 'loading'; parentId: string; depth: number }
  | { kind: 'truncated'; parentId: string | null; count: number; depth: number };

/**
 * The visible rows, in document order, from the levels the panel has actually received.
 *
 * Only nodes reachable from the body level are emitted, so a level whose parent was collapsed and
 * whose ids are still cached contributes nothing.
 */
export function flattenTree(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (parentId: string | null, depth: number) => {
    const ids = state.children.get(parentId) || [];
    for (const id of ids) {
      const node = state.nodes.get(id);
      if (!node) continue;
      const expanded = state.expanded.has(id);
      rows.push({ kind: 'node', node, depth, expanded, selected: state.selectedId === id });
      if (!expanded) continue;
      if (state.children.has(id)) {
        walk(id, depth + 1);
      } else {
        rows.push({ kind: 'loading', parentId: id, depth: depth + 1 });
      }
    }
    const dropped = state.truncated.get(parentId) || 0;
    if (dropped > 0) rows.push({ kind: 'truncated', parentId, count: dropped, depth });
  };

  walk(null, 0);
  return rows;
}

/**
 * Why the tree cannot be shown, or `null` when it can be tried.
 *
 * Runtime is checked before the preview panel: a Python project's preview is a terminal, so telling
 * the user to open it would be sending them somewhere that cannot help.
 */
export type TreeUnavailable = 'no-project' | 'terminal-runtime' | 'bundled-runtime' | 'preview-closed';

export function describeUnavailable(input: {
  hasProject: boolean;
  previewOpen: boolean;
  runtime: ProjectRuntime;
}): TreeUnavailable | null {
  if (!input.hasProject) return 'no-project';
  if (getRuntimeConfig(input.runtime).previewMode === 'terminal') return 'terminal-runtime';
  if (isRuntimeBundled(input.runtime)) return 'bundled-runtime';
  if (!input.previewOpen) return 'preview-closed';
  return null;
}

export interface UnavailableCopy {
  title: string;
  hint: string;
  /** The only reason with something the user can do about it from here. */
  offersOpenPreview: boolean;
}

/** The keys `unavailableCopy` reads, named so a missing one is a type error and not English copy. */
type UnavailableKey =
  | 'noProjectOpen'
  | 'noProjectOpenHint'
  | 'noDocument'
  | 'terminalRuntimeHint'
  | 'notSupportedRuntime'
  | 'bundledRuntimeHint'
  | 'previewClosed'
  | 'previewClosedHint';

/**
 * The translator `unavailableCopy` needs.
 *
 * Typed to the keys above rather than to `string`: the panel passes `useTranslations`' own `t`,
 * whose parameter accepts only keys that exist in the messages, so a key named here and missing
 * from `en.json` fails to assign and `tsc` reports it.
 */
type UnavailableTranslator = (
  key: UnavailableKey,
  values?: Record<string, string>,
) => string;

/**
 * What the panel says when neither tab can work.
 *
 * Takes its translator as an argument rather than reading one itself, so it stays a plain function
 * the panel and its tests can both call.
 */
export function unavailableCopy(
  t: UnavailableTranslator,
  unavailable: TreeUnavailable,
  runtime: ProjectRuntime,
): UnavailableCopy {
  switch (unavailable) {
    case 'no-project':
      return {
        title: t('noProjectOpen'),
        hint: t('noProjectOpenHint'),
        offersOpenPreview: false,
      };
    case 'terminal-runtime':
      return {
        title: t('noDocument'),
        hint: t('terminalRuntimeHint', { runtime: getRuntimeConfig(runtime).label }),
        offersOpenPreview: false,
      };
    case 'bundled-runtime':
      return {
        title: t('notSupportedRuntime'),
        hint: t('bundledRuntimeHint', { runtime: getRuntimeConfig(runtime).label }),
        offersOpenPreview: false,
      };
    case 'preview-closed':
      return {
        title: t('previewClosed'),
        hint: t('previewClosedHint'),
        offersOpenPreview: true,
      };
  }
}

/** The panel's two tabs. The workspace holds the current one and owns the `'tree'` default. */
export type ElementsTab = 'tree' | 'styles';

export interface ElementsPanelHandle {
  /** A level arrived from the frame, lifted through the workspace. */
  handleTreeLevel: (message: Extract<PreviewMessage, { type: 'tree-level' }>) => void;
  /** The levels needed to reveal a node picked in the preview, and the ancestors to open. */
  handleTreeLevels: (message: Extract<PreviewMessage, { type: 'tree-levels' }>) => void;
  /** The frame could not resolve an id the panel sent. */
  handleTreeStale: () => void;
  /** The frame loaded a document — the reload signal, and the only safe moment to send. */
  handleFrameReady: () => void;
  /** The computed values a `style-query` asked for, for the Styles tab. */
  handleStyleComputed: (message: Extract<PreviewMessage, { type: 'style-computed' }>) => void;
  /** Which properties an override failed to produce, and what beat it. */
  handleStyleProbeResult: (message: Extract<PreviewMessage, { type: 'style-probe-result' }>) => void;
}

export interface ElementsPanelProps {
  projectId: string | null;
  runtime: ProjectRuntime;
  /** Whether the preview panel is open. Closed means there is no frame to query. */
  previewOpen: boolean;
  onOpenPreview: () => void;
  /** Post into the preview frame. A no-op when no frame is mounted. */
  sendToFrame: (message: PreviewHostMessage) => void;
  /**
   * The element the Styles tab acts on.
   *
   * The panel does not learn this from the tree: a `tree-select` goes to the *frame*, which answers
   * with `selector-selection` — the same message a click in the preview produces — and the workspace
   * lifts it into `focusContext`. That round trip is what makes a tree row and a preview click the
   * same gesture, so the payload has to come back down as a prop rather than be synthesised here.
   */
  selection: FocusContextPayload | null;
  /** The durable write, bound to the project. `null` disables the Styles tab's controls. */
  applyStyle: ApplyStyle | null;
  /**
   * The durable removal, bound to the project — the Styles tab's Reset.
   *
   * Optional and passed straight through, like the CONTENT section's halves: a host that omits it
   * gets no Reset control rather than one that refuses.
   */
  removeStyle?: RemoveStyle | null;
  /**
   * What `/overrides.css` already declares for an element — what makes the Styles tab's Reset
   * survive a reload. Optional and passed straight through, like the removal beside it.
   */
  onReadOverrides?: ReadOverrides;
  /** The project's own colour tokens. */
  colorTokens: readonly ColorToken[];
  /**
   * The Styles tab's CONTENT section: read and write the selected element's text, and open the
   * project's image picker for a selected image.
   *
   * Threaded down rather than performed here for the same reason `applyStyle` is: the workspace owns
   * the write path, the picker's mount and the generation gate, and this panel imports neither
   * `lib/vfs` nor `lib/stores`.
   *
   * Optional, and passed straight through — a host that omits them gets a Styles tab with no CONTENT
   * section, which is the same absence a container already produces. See `contentSection` in
   * `components/styles-content/content-state.ts`.
   */
  onReadText?: () => Promise<TextReadResult>;
  onApplyText?: (text: string, confirmedMultiInstance: boolean) => Promise<ApplyResult>;
  onReplaceImage?: () => void;
  /** A URL the app's document can load for the selected image, or `null`. */
  imageUrl?: string | null;
  onOpenFile: (path: string) => void;
  onAskAgent: (prompt: string) => void;
  onRefreshPreview: () => void;
  /**
   * The Styles tab's empty state offers to arm the preview's element picker. Both passed straight
   * through, and both optional for the same reason the CONTENT section's props are: the workspace is
   * the only host that can honour them, since arming means putting the *preview* where the user can
   * use it and only the mount knows which surface that is.
   *
   * See `onSelectElement` in `components/styles-content/index.tsx`.
   */
  onSelectElement?: () => void;
  onSelectElementHover?: (hovering: boolean) => void;
  /**
   * The picker is armed right now, so that button can show it and say that pressing it cancels.
   *
   * Passed down rather than read from the store for the reason `StylesContent` imports no store at
   * all: the flag is the host's, and a host that does not offer `onSelectElement` has no armed state
   * to report. Optional, defaulting to disarmed, so every fixture that renders this panel without it
   * keeps the markup it had.
   */
  focusToolArmed?: boolean;
  /**
   * Which tab is showing. Controlled, and owned by the workspace — the preview toolbar's `Style`
   * action has to open this panel *on the Styles tab*, and it cannot do that through the handle:
   * `if (showElements) panelMap['elements']` means opening the panel is what mounts it, so the ref
   * is still null at the moment the toggle runs and an imperative call is a silent no-op.
   */
  activeTab: ElementsTab;
  onTabChange: (tab: ElementsTab) => void;
}

function Unavailable({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {action}
    </div>
  );
}

/**
 * The rendered document as a tree, one lazily serialized level at a time.
 *
 * The panel is a sibling of the preview in the workspace's panel map, not a child of it, so it
 * neither owns the frame nor hears its messages: the workspace lifts `tree-level` / `tree-stale` /
 * frame-ready into this handle and hands down a `sendToFrame` bound to the preview's ref.
 *
 * Nothing is requested on mount. `postMessageToIframe` drops a message silently while the frame is
 * not ready and nothing retries, so the first request waits for `handleFrameReady` — which the
 * preview always reaches here, because opening this panel switches provenance on and that
 * recompiles.
 */
function panelTab(active: boolean): string {
  return [
    'flex-1 h-7 rounded-none px-2 -mb-px text-[10px] uppercase tracking-wider',
    'border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none',
    // Conditional class avoids a specificity tie between border-color utilities.
    active
      ? 'border-primary text-foreground font-semibold'
      : 'border-transparent text-muted-foreground hover:text-foreground',
  ].join(' ');
}

export const ElementsPanel = forwardRef<ElementsPanelHandle, ElementsPanelProps>(function ElementsPanel(
  {
    projectId,
    runtime,
    previewOpen,
    onOpenPreview,
    sendToFrame,
    selection,
    applyStyle,
    removeStyle,
    onReadOverrides,
    colorTokens,
    onReadText,
    onApplyText,
    onReplaceImage,
    imageUrl,
    onOpenFile,
    onAskAgent,
    onRefreshPreview,
    onSelectElement,
    onSelectElementHover,
    focusToolArmed,
    activeTab,
    onTabChange,
  },
  ref
) {
  const t = useTranslations('elementsPanel');
  const tmx = useTranslations('models');
  const stylesRef = useRef<StylesContentHandle>(null);
  const [state, setState] = useState<TreeState>(emptyTreeState);
  // The reducer runs against this rather than against a `setState` updater: the transition emits
  // messages, and an updater is not allowed to have side effects (StrictMode invokes it twice).
  const stateRef = useRef(state);
  const sendRef = useRef(sendToFrame);
  sendRef.current = sendToFrame;
  /** The node the tree was last opened onto, so one selection is not revealed twice. */
  const revealedRef = useRef<string | null>(null);

  const dispatch = useCallback((event: TreeEvent) => {
    const { state: next, requests } = reduceTree(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    for (const request of requests) sendRef.current(request);
  }, []);

  useImperativeHandle(ref, () => ({
    handleTreeLevel: (message) => {
      dispatch({
        type: 'level',
        parentId: message.parentId,
        nodes: message.nodes,
        truncated: message.truncated,
      });
    },
    handleTreeLevels: (message) => {
      dispatch({ type: 'reveal', levels: message.levels, path: message.path });
    },
    handleTreeStale: () => dispatch({ type: 'stale' }),
    handleFrameReady: () => {
      dispatch({ type: 'frame-ready' });
      // The ids died with the old document, so a node revealed in it is not the one an identical
      // id would name now. Forgetting it lets the same selection be revealed again.
      revealedRef.current = null;
      stylesRef.current?.handleFrameReady();
    },
    handleStyleComputed: (message) => stylesRef.current?.handleStyleComputed(message),
    handleStyleProbeResult: (message) => stylesRef.current?.handleStyleProbeResult(message),
  }), [dispatch]);

  const unavailable = describeUnavailable({ hasProject: Boolean(projectId), previewOpen, runtime });
  const copy = unavailable ? unavailableCopy(t, unavailable, runtime) : null;

  // Drop the tree when there is nothing behind it — a closed preview unmounts the frame, and its
  // ids die with it. Keeping the rows on screen would offer selections that all resolve to nothing.
  useEffect(() => {
    if (!unavailable) return;
    stateRef.current = emptyTreeState();
    setState(stateRef.current);
  }, [unavailable]);

  /**
   * Open the tree onto an element picked in the preview.
   *
   * Asked of the frame rather than worked out here: the panel holds only the levels it has
   * expanded, and nothing in a `TreeNode` says where it sits.
   *
   * Skipped when the row is already the selected one, which is what a click *in the tree* leaves
   * behind by the time its selection round-trips back through the workspace. Without that guard
   * every row click would rebuild the tree and collapse whatever else the person had opened.
   */
  useEffect(() => {
    const nodeId = selection?.nodeId ?? null;
    if (!nodeId || unavailable) return;
    if (stateRef.current.selectedId === nodeId || revealedRef.current === nodeId) return;
    revealedRef.current = nodeId;
    sendRef.current({ type: 'tree-path', nodeId });
  }, [selection, unavailable]);

  // Leaving the panel — closing it, or a reorder that unmounts it — must not strand the overlay in
  // the frame, which has no idea the panel is gone.
  useEffect(() => {
    const send = sendRef;
    return () => {
      send.current({ type: 'tree-highlight', nodeId: null });
    };
  }, []);

  const rows = flattenTree(state);

  const tree = (
    <div
      className="h-full overflow-auto p-1"
      onMouseLeave={() => dispatch({ type: 'hover', nodeId: null })}
    >
      {rows.length === 0 ? (
        <Unavailable
          title={t('noElements')}
          hint={t('nothingReadYet')}
          action={
            <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'refresh' })}>
              {t('refresh')}
            </Button>
          }
        />
      ) : (
        rows.map((row) => {
          if (row.kind === 'node') {
            return (
              <ElementsTreeRow
                key={row.node.id}
                node={row.node}
                depth={row.depth}
                expanded={row.expanded}
                selected={row.selected}
                onToggle={(nodeId) => dispatch({ type: 'toggle', nodeId })}
                onSelect={(nodeId) => dispatch({ type: 'select', nodeId })}
                onHover={(nodeId) => dispatch({ type: 'hover', nodeId })}
              />
            );
          }
          if (row.kind === 'loading') {
            return (
              <div
                key={`loading-${row.parentId}`}
                className="text-xs text-muted-foreground py-1"
                style={{ paddingLeft: `${row.depth * 12 + 24}px` }}
              >
                {tmx('loadingEllipsis')}
              </div>
            );
          }
          return (
            <div
              key={`truncated-${row.parentId ?? 'root'}`}
              className="text-xs text-muted-foreground italic py-1"
              style={{ paddingLeft: `${row.depth * 12 + 24}px` }}
            >
              {t('moreNotShown', { count: row.count })}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value === 'styles' ? 'styles' : 'tree')}
      className="flex-1 min-h-0 flex flex-col"
    >
      <TabsList className="h-7 w-full shrink-0 justify-stretch gap-0 rounded-none border-b bg-transparent p-0 text-muted-foreground">
        <TabsTrigger value="tree" className={panelTab(activeTab === 'tree')}>
          {t('tabElements')}
        </TabsTrigger>
        <TabsTrigger value="styles" className={panelTab(activeTab === 'styles')}>
          {t('tabStyles')}
        </TabsTrigger>
      </TabsList>

      {copy ? (
        // Both tabs read the rendered document, so one unavailable message covers both.
        <div className="flex-1 min-h-0">
          <Unavailable
            title={copy.title}
            hint={copy.hint}
            action={copy.offersOpenPreview ? (
              <Button variant="outline" size="sm" onClick={onOpenPreview}>
                {t('openPreview')}
              </Button>
            ) : undefined}
          />
        </div>
      ) : (
        <>
          {/*
            Both tabs force-mounted so the Styles tab keeps its state and receives style-computed
            replies while hidden. hidden attribute set explicitly because forceMount disables
            Radix's own hiding.
          */}
          <TabsContent
            value="tree"
            forceMount
            hidden={activeTab !== 'tree'}
            className="flex-1 min-h-0 mt-0"
          >
            {tree}
          </TabsContent>
          <TabsContent
            value="styles"
            forceMount
            hidden={activeTab !== 'styles'}
            className="flex-1 min-h-0 mt-0"
          >
            <StylesContent
              ref={stylesRef}
              selection={selection}
              sendToFrame={sendToFrame}
              applyStyle={applyStyle}
              removeStyle={removeStyle}
              onReadOverrides={onReadOverrides}
              tokens={colorTokens}
              onReadText={onReadText}
              onApplyText={onApplyText}
              onReplaceImage={onReplaceImage}
              imageUrl={imageUrl}
              onOpenFile={onOpenFile}
              onAskAgent={onAskAgent}
              onRefreshPreview={onRefreshPreview}
              onSelectElement={onSelectElement}
              onSelectElementHover={onSelectElementHover}
              focusToolArmed={focusToolArmed}
            />
          </TabsContent>
        </>
      )}
    </Tabs>
  );
});
