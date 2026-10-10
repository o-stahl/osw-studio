export interface ProcessedFile {
  path: string;
  content: string | ArrayBuffer;
  mimeType: string;
  blobUrl?: string;
}

export interface Route {
  path: string;
  file: string;
  title?: string;
}

export interface CompiledProject {
  entryPoint: string;
  files: ProcessedFile[];
  routes: Route[];
  blobUrls: Map<string, string>;
}

export interface FocusContextPayload {
  domPath: string;
  tagName: string;
  /**
   * Stable handle to a clicked element; `domPath` is positional and `srcAttr` is ambiguous when
   * `instanceCount > 1`. Frame-scoped: a recompile invalidates it.
   */
  nodeId: string;
  attributes: Record<string, string>;
  /** Provenance-stripped: `data-osw-src` never reaches a consumer of this payload. */
  outerHTML: string;
  /**
   * Raw `data-osw-src` value: `"<path>:<index>"`. Split on the *last* colon — a path may contain
   * one. Absent when the preview was compiled without provenance, and for elements built by JS at
   * runtime rather than emitted by the compiler.
   */
  srcAttr?: string;
  /**
   * How many rendered elements in the page share this `srcAttr`. `> 1` means one source tag
   * produced many elements — a `{{#each}}` loop, or a partial included more than once.
   */
  instanceCount?: number;
  /**
   * Reported by the frame rather than derived from `outerHTML` in the host.
   * Absent means "not stated", read as not text by `elementKind`.
   */
  textBearing?: boolean;
}

/**
 * One row of the Elements tree, as serialized inside the preview frame.
 * `instances` is the same concept as `FocusContextPayload.instanceCount`.
 */
export interface TreeNode {
  /**
   * The element's `data-osw-node` value. Frame-scoped and transient: every `srcdoc` reassignment
   * mints a new document, so an id held by the host after a recompile resolves to nothing.
   */
  id: string;
  tag: string;
  className?: string;
  /** Path part of `data-osw-src` — the substring before its *last* colon. */
  file?: string;
  /** Index part of `data-osw-src`, a UTF-16 code-unit offset into that file. */
  line?: number;
  /** How many rendered elements in the page share this node's `data-osw-src`. */
  instances: number;
  hasChildren: boolean;
}

export interface PlacementBlockInfo {
  id: string;
  name: string;
  wireframeHtml: string;
}

export interface PlacementResult {
  blockId: string;
  placementId: string;
  domPath: string;
  position: 'before' | 'after';
  htmlContext: string;
}

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export type PreviewMessage =
  /** The document stamped with `loadId` reached its load event. See `previewBridgeScript`. */
  | { type: 'preview:ready'; loadId: number }
  /** The shell written for `loadId` is asking for its page. See `lib/preview/preview-shell.ts`. */
  | { type: 'preview:shell-ready'; loadId: number }
  | { type: 'preview:shell-error'; loadId: number; error: string }
  /** An edge-function call the host makes for the frame. See `lib/preview/function-proxy.ts`. */
  | import('./function-proxy').FunctionCall
  /** One storage area of the frame's stand-ins, whole. See `lib/preview/preview-storage.ts`. */
  | { type: 'preview:storage'; loadId: number; area: string; data: Record<string, string> }
  /** Where that document is scrolled to, sent while scrolling (at most every 100 ms). */
  | { type: 'preview:scroll'; loadId: number; x: number; y: number }
  | { type: 'navigate'; path: string }
  | { type: 'preview:external'; href: string }
  | { type: 'reload' }
  | { type: 'error'; error: string }
  | { type: 'selector-selection'; payload: FocusContextPayload }
  | { type: 'selector-cancelled' }
  | { type: 'console'; level: ConsoleLevel; args: string[] }
  | { type: 'placement-complete'; payload: PlacementResult }
  | { type: 'placement-cancelled' }
  | { type: 'iframe-click' }
  /**
   * One expanded level of the Elements tree. `parentId` is null for the body level. `truncated` is
   * how many siblings were dropped past the per-level cap, so the panel can say so rather than
   * silently showing a short list.
   */
  | { type: 'tree-level'; parentId: string | null; nodes: TreeNode[]; truncated: number }
  /**
   * The answer to `tree-path`: the levels from the body down to the requested node's parent, in
   * that order, plus the ancestor ids to expand. `path` ends with the requested node itself.
   *
   * Empty `levels` means the id did not resolve; the panel leaves its tree alone.
   */
  | {
      type: 'tree-levels';
      levels: Array<{ parentId: string | null; nodes: TreeNode[]; truncated: number }>;
      path: string[];
    }
  /**
   * The id the host asked to select no longer resolves to an element in the frame — the document was
   * replaced by a recompile, or the element was edited away. Nothing was selected; the panel's rows
   * for that document are dead and it should collapse to root rather than keep offering them.
   */
  | { type: 'tree-stale'; nodeId: string }
  /**
   * The answer to a `style-query`, always sent — an id that no longer resolves gets `values: {}`
   * rather than silence, which the host cannot tell apart from a frame that has not replied yet.
   *
   * Keyed by the *expanded* property names: a request for `padding` comes back as its four sides.
   * See `SHORTHAND_LONGHANDS` in `lib/preview/style-preview.ts` for why. A property the engine has
   * no value for is present with an empty string, so the key set is the request's, not the engine's.
   */
  | {
      type: 'style-computed';
      nodeId: string;
      values: Record<string, string>;
      /**
       * The document's root font size, as the engine resolved it — `'16px'`, `'10px'`, `''` where
       * there is no document element.
       *
       * Not a property of the queried element: it is what one `rem` is worth here, and it rides on
       * this reply because every `rem` the Styles panel shows or writes is computed through it and
       * there is no other message that could carry it. Optional so a frame built before this reply
       * carried it is still a valid message; the host's answer to its absence is "not known yet",
       * never 16.
       */
      rootFontSize?: string;
    }
  /**
   * The answer to a `style-probe`: which of the asked-about properties the override did **not**
   * actually produce, and — when something did beat it — where the winning declaration came from.
   *
   * `lost` is keyed the same way `style-computed`'s `values` is, on the *expanded* property names,
   * so a request about `padding` names the side that lost. Empty means the override is in force for
   * everything asked about, which is also the answer for a stale `nodeId` or a marker with no rule
   * anywhere: the host is waiting on a reply and cannot tell silence from a slow frame.
   *
   * `winner` is a VFS path where one is knowable, else `inline style` / `a stylesheet` — never a
   * blob id. Absent when nothing was lost, and also when something was lost to a cause the scan
   * cannot name (a UA default, or a rule inside an `@media` block, which is deliberately not walked).
   */
  | { type: 'style-probe-result'; nodeId: string; lost: string[]; winner?: string }
  /** A fresh payload for a `selection-resolve`, or `null` when that `domPath` no longer resolves. */
  | { type: 'selection-resolved'; payload: FocusContextPayload | null }
  /**
   * Relayed to the host because every action depends on host state (panels, tabs, message inclusion).
   */
  | { type: 'toolbar-action'; action: ToolbarAction; nodeId: string }
  /**
   * The pointer entered or left a toolbar button, so the host can show what pressing it would do.
   *
   * `action` is null on leave. Only the buttons whose consequence is invisible until it happens are
   * worth announcing: `style` rearranges the panels, and which panel it closes is not guessable from
   * the button.
   */
  | { type: 'toolbar-hover'; action: ToolbarAction | null };

/** The kind-specific slot: `text` or `replace`, decided per selection. */
export type ToolbarAction = 'style' | 'text' | 'replace' | 'include' | 'dismiss';

export type PreviewHostMessage =
  | { type: 'selector-toggle'; active: boolean }
  | { type: 'placement-start'; block: PlacementBlockInfo }
  | { type: 'placement-hover'; x: number; y: number }
  | { type: 'placement-drop' }
  | { type: 'placement-cancel' }
  | { type: 'placement-remove'; placementId: string }
  /** Serialize one level of the tree and post it back. `nodeId` null means the body level. */
  | { type: 'tree-request'; nodeId: string | null }
  /**
   * Serialize every level from the body down to this node's parent, so the tree can reveal an
   * element that was picked in the preview rather than clicked in the tree.
   *
   * One message rather than the host walking up level by level: it does not know the ancestors
   * (`TreeNode` carries no path), and a level whose parent has not arrived yet is dropped by the
   * reducer as an orphan, so the levels have to come back in order and together.
   */
  | { type: 'tree-path'; nodeId: string }
  /** Show the shared highlight overlay on this node; `nodeId` null hides it. */
  | { type: 'tree-highlight'; nodeId: string | null }
  /**
   * Select this node, producing the same `selector-selection` a click on it would. A node id that no
   * longer resolves gets `tree-stale` back instead.
   */
  | { type: 'tree-select'; nodeId: string }
  /**
   * Read this node's rendered style. `nodeId` is a {@link FocusContextPayload.nodeId} — the same
   * frame-scoped id the tree mints — so a clicked element can be asked about, not just a tree row.
   * Shorthands in `properties` are expanded before they are read; the reply names what came back.
   */
  | { type: 'style-query'; nodeId: string; properties: string[] }
  /**
   * `markerId` identifies the rule; `css` is the element's whole accumulated block (needed because
   * silent writes skip recompile). `null` clears the transient style.
   */
  | { type: 'style-preview'; markerId: string; css: string | null }
  /**
   * Both `nodeId` and `markerId` needed: one identifies the element, the other identifies the rule
   * to lift out.
   */
  | { type: 'style-probe'; nodeId: string; markerId: string; properties: string[] }
  /** Uses `domPath` because a recompile mints new `nodeId`s but `domPath` survives. */
  | { type: 'selection-resolve'; domPath: string }
  /** Clears the toolbar anchor. Not needed after a recompile (the new document has no selection). */
  | { type: 'selection-clear' }
  /**
   * The frame cannot read the app's CSS variables; colours sent explicitly as resolved values.
   * Re-sent on every frame-ready and on theme change.
   */
  | { type: 'toolbar-theme'; colors: Record<string, string> }
  /**
   * Restores scroll position after a `srcdoc` reassignment. Only sent for the same `activePath`;
   * sent before `selection-resolve` so the toolbar anchors at the restored position.
   */
  | { type: 'scroll-restore'; scrollX: number; scrollY: number };
