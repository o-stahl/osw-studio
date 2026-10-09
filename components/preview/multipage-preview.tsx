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
import { FrameScrollMemory, type FrameScroll } from '@/lib/preview/scroll-memory';
import { previewBridgeScript } from '@/lib/preview/preview-bridge';
import { previewShellHtml, sendShellContent } from '@/lib/preview/preview-shell';
import { runFunctionCall } from '@/lib/preview/function-proxy';
import { PreviewCompileGate, mergeCompileRequests, observePreviewRoot } from '@/lib/preview/compile-gate';
import type { CompileRequest } from '@/lib/preview/compile-gate';
import { STRIP_PROVENANCE_JS } from '@/lib/preview/provenance';
import { SERIALIZE_TREE_JS } from '@/lib/preview/element-tree';
import { STYLE_QUERY_JS, STYLE_PREVIEW_JS, STYLE_LOCATOR_JS, STYLE_PROBE_JS } from '@/lib/preview/style-preview';
import { TOOLBAR_DOM_JS, TOOLBAR_HOST_ATTR, resolveToolbarTheme } from '@/lib/preview/toolbar-dom';
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
   * The frame has loaded the document this component wrote, verified by its load marker.
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
 * Strip the Elements tree's transient node id, as JavaScript source for injection into the iframe.
 *
 * `data-osw-node` is stamped onto live elements as the tree is serialized, so anything read out of
 * the frame's DOM after an expansion carries it: the focus payload's `outerHTML` and the placement
 * request's `htmlContext` both do, and both end up in the agent's prompt.
 */
export const STRIP_NODE_ID_JS =
  `function __oswStripNodeId(h){return String(h||'').replace(/\\s?data-osw-node="[^"]*"/g,'');}`;

/**
 * Escape an element id for use inside a CSS selector, as JavaScript source for the iframe.
 *
 * `CSS.escape` is absent in jsdom, so this is hand-written.
 */
export const ESCAPE_CSS_IDENT_JS = `
function __oswEscapeIdent(value) {
  var s = String(value == null ? '' : value);
  var bs = String.fromCharCode(92);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '-' || c > '~') {
      out += c;
      continue;
    }
    if (c >= '0' && c <= '9') {
      // A digit is an ordinary ident character anywhere but the front.
      out += i === 0 ? bs + '3' + c + ' ' : c;
      continue;
    }
    out += bs + c;
  }
  return out;
}
`;

/**
 * The preview's semantic-block placement script, as source for the iframe.
 *
 * Exported for the same reason as generateNavigationScript below: the escaping of anything authored
 * inside this template literal is only observable in the emitted string.
 */
export function generatePlacementScript(): string {
  return `<script>(function() {
    ${STRIP_PROVENANCE_JS}
    ${STRIP_NODE_ID_JS}
    var state = {
      active: false,
      block: null,
      indicator: null,
      currentTarget: null,
      currentPosition: 'after',
      lastX: 0,
      lastY: 0,
      scrollRaf: null,
      scrollSpeed: 0
    };

    function createIndicator() {
      if (state.indicator) return state.indicator;
      var el = document.createElement('div');
      el.setAttribute('data-semantic-indicator', 'true');
      el.style.cssText = 'position:fixed;height:0;border:2px solid rgba(99,102,241,0.95);border-radius:12px;box-shadow:0 0 0 4px rgba(99,102,241,0.32);pointer-events:none;transition:top 0.15s ease-out,left 0.15s ease-out,width 0.15s ease-out,opacity 0.15s;opacity:0;z-index:2147483646;box-sizing:border-box;';
      document.body.appendChild(el);
      state.indicator = el;
      return el;
    }

    function removeIndicator() {
      if (state.indicator) {
        state.indicator.style.opacity = '0';
      }
    }

    function isPlaceholderOrIndicator(el) {
      if (!el || !el.getAttribute) return false;
      return el.getAttribute('data-semantic-placeholder') === 'true' ||
             el.getAttribute('data-semantic-indicator') === 'true' ||
             // The selector's highlight overlay. It stays in the document once created — hidden
             // rather than detached — so findDropTarget's fallback, which returns the last body
             // child when the pointer is over bare body, would otherwise pick it and hand the agent
             // a domPath into preview furniture.
             el.getAttribute('data-osw-overlay') !== null ||
             // The selection toolbar, for the same reason and more sharply: it is *appended* on
             // every selection, so it is the last body child whenever anything is selected — which
             // is precisely when a user is dragging a block around. The fallback walks backwards and
             // would hand back the toolbar every time.
             el.getAttribute('${TOOLBAR_HOST_ATTR}') !== null;
    }

    function getInsertPosition(el, x, y) {
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el.parentNode || el);
      var isHorizontal = style.display === 'flex' && (style.flexDirection === 'row' || style.flexDirection === 'row-reverse');

      if (isHorizontal) {
        return (x - rect.left) < (rect.width / 2) ? 'before' : 'after';
      }
      return (y - rect.top) < (rect.height / 2) ? 'before' : 'after';
    }

    function findDropTarget(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement || el === document.body) {
        var children = document.body.children;
        for (var i = children.length - 1; i >= 0; i--) {
          if (!isPlaceholderOrIndicator(children[i]) && children[i].tagName !== 'SCRIPT') {
            return children[i];
          }
        }
        return null;
      }
      while (el && (isPlaceholderOrIndicator(el) || el.tagName === 'SCRIPT')) {
        el = el.parentElement;
      }
      if (el && el !== document.body && el !== document.documentElement) {
        var pos = window.getComputedStyle(el).position;
        if (pos === 'absolute' || pos === 'fixed') {
          el = el.parentElement;
        }
      }
      return el && el !== document.body && el !== document.documentElement ? el : null;
    }

    function buildDomPath(el) {
      var parts = [];
      while (el && el !== document.body && el !== document.documentElement) {
        var tag = el.tagName.toLowerCase();
        if (el.id) {
          parts.unshift(tag + '#' + el.id);
          break;
        }
        var parent = el.parentElement;
        if (parent) {
          var siblings = Array.prototype.filter.call(parent.children, function(c) {
            return c.tagName === el.tagName && !isPlaceholderOrIndicator(c);
          });
          if (siblings.length > 1) {
            var idx = siblings.indexOf(el) + 1;
            tag += ':nth-of-type(' + idx + ')';
          }
        }
        parts.unshift(tag);
        el = parent;
      }
      return 'body > ' + parts.join(' > ');
    }

    function showIndicator(target, position) {
      var indicator = createIndicator();
      var rect = target.getBoundingClientRect();
      var y = position === 'before' ? rect.top : rect.bottom;
      indicator.style.top = y + 'px';
      indicator.style.left = rect.left + 'px';
      indicator.style.width = rect.width + 'px';
      indicator.offsetHeight;
      indicator.style.opacity = '1';
      state.currentTarget = target;
      state.currentPosition = position;
    }

    function startAutoScroll() {
      if (state.scrollRaf) return;
      function tick() {
        if (state.scrollSpeed !== 0) {
          window.scrollBy(0, state.scrollSpeed);
        }
        state.scrollRaf = requestAnimationFrame(tick);
      }
      state.scrollRaf = requestAnimationFrame(tick);
    }

    function stopAutoScroll() {
      if (state.scrollRaf) {
        cancelAnimationFrame(state.scrollRaf);
        state.scrollRaf = null;
      }
      state.scrollSpeed = 0;
    }

    function updateAutoScroll(y) {
      var vh = window.innerHeight;
      var edgeZone = vh * 0.08;
      var maxSpeed = 12;
      if (y < edgeZone) {
        // Top edge — scroll up, faster closer to edge
        state.scrollSpeed = -maxSpeed * (1 - y / edgeZone);
        startAutoScroll();
      } else if (y > vh - edgeZone) {
        // Bottom edge — scroll down
        state.scrollSpeed = maxSpeed * (1 - (vh - y) / edgeZone);
        startAutoScroll();
      } else {
        state.scrollSpeed = 0;
      }
    }

    function handleHover(x, y) {
      if (!state.active) return;
      state.lastX = x;
      state.lastY = y;
      updateAutoScroll(y);
      var target = findDropTarget(x, y);
      if (!target) {
        removeIndicator();
        state.currentTarget = null;
        return;
      }
      var position = getInsertPosition(target, x, y);
      if (target === state.currentTarget && position === state.currentPosition) return;
      showIndicator(target, position);
    }

    function buildHtmlContext(target, position, blockName) {
      // Get the parent element that contains the insertion point
      var parent = target.parentNode;
      if (!parent || parent === document.body || parent === document.documentElement) {
        parent = target; // use target itself if parent is body
      }
      // Clone the parent to insert a marker comment without modifying the real DOM
      var clone = parent.cloneNode(true);
      // Find the corresponding target in the clone
      var children = Array.prototype.slice.call(parent.children);
      var cloneChildren = Array.prototype.slice.call(clone.children);
      var targetIndex = -1;
      for (var i = 0; i < children.length; i++) {
        if (children[i] === target) { targetIndex = i; break; }
      }
      if (targetIndex >= 0 && targetIndex < cloneChildren.length) {
        var marker = document.createComment(' INSERT ' + blockName + ' HERE ');
        if (position === 'before') {
          clone.insertBefore(marker, cloneChildren[targetIndex]);
        } else {
          clone.insertBefore(marker, cloneChildren[targetIndex].nextSibling);
        }
      }
      // Remove any semantic placeholders/indicators from the clone, and the selection toolbar with
      // them. The toolbar's chrome is in a shadow root and never serialises, but its host is an
      // ordinary empty div and does — and this string becomes the placement request's htmlContext.
      //
      // Belt and braces, measured as such: the clone root is either the target's parent or the
      // target itself, and the toolbar host is only ever a direct child of document.body, so it can
      // land inside this clone only when it *is* the target — which findDropTarget above no longer
      // hands back. The same is already true of the indicator beside it, which is also body-only.
      // Both stay, because nothing enforces "body child" as an invariant.
      var placeholders = clone.querySelectorAll('[data-semantic-placeholder],[data-semantic-indicator],[${TOOLBAR_HOST_ATTR}]');
      for (var j = placeholders.length - 1; j >= 0; j--) {
        placeholders[j].parentNode.removeChild(placeholders[j]);
      }
      // Remove script tags from clone
      var scripts = clone.querySelectorAll('script');
      for (var k = scripts.length - 1; k >= 0; k--) {
        scripts[k].parentNode.removeChild(scripts[k]);
      }
      // Preview-only instrumentation must not reach the agent: this string becomes the placement
      // request's htmlContext. A separate code path from the focus-context payload, so both
      // strippers have to be applied here too.
      return __oswStripNodeId(__oswStripProv(clone.outerHTML));
    }

    function handleDrop() {
      stopAutoScroll();
      if (!state.active || !state.currentTarget || !state.block) return;
      var domPath = buildDomPath(state.currentTarget);
      var position = state.currentPosition;

      // Capture HTML context BEFORE inserting placeholder
      var htmlContext = buildHtmlContext(state.currentTarget, position, state.block.name);

      removeIndicator();
      var wrapper = document.createElement('div');
      var placementId = 'sb-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

      wrapper.innerHTML = state.block.wireframeHtml;
      var placeholder = wrapper.firstChild;
      if (placeholder) {
        // Tag with placementId so it can be removed later
        if (placeholder.setAttribute) placeholder.setAttribute('data-placement-id', placementId);
        if (position === 'before') {
          state.currentTarget.parentNode.insertBefore(placeholder, state.currentTarget);
        } else {
          state.currentTarget.parentNode.insertBefore(placeholder, state.currentTarget.nextSibling);
        }
      }

      window.parent.postMessage({
        type: 'placement-complete',
        payload: {
          blockId: state.block.id,
          placementId: placementId,
          domPath: domPath,
          position: position,
          htmlContext: htmlContext
        }
      }, '*');

      state.currentTarget = null;
      state.currentPosition = 'after';
    }

    function activate(block) {
      state.active = true;
      state.block = block;
      document.body.style.cursor = 'crosshair';
    }

    function deactivate(cancelled) {
      stopAutoScroll();
      state.active = false;
      state.block = null;
      state.currentTarget = null;
      removeIndicator();
      document.body.style.cursor = '';
      if (cancelled) {
        window.parent.postMessage({ type: 'placement-cancelled' }, '*');
      }
    }

    document.addEventListener('click', function(event) {
      // A press on the selection toolbar is not a click in the page. The host reacts to this
      // message by closing the block palette and firing onPlacementToggle, so relaying it would
      // make a toolbar button toggle unrelated UI.
      //
      // One check on event.target is enough, and no composed-path walk is needed: the toolbar's
      // chrome is inside a shadow root, so a click on a button in it arrives at this listener
      // already retargeted to the host — the element carrying the attribute.
      var t = event && event.target;
      if (t && t.getAttribute && t.getAttribute('${TOOLBAR_HOST_ATTR}') !== null) return;
      window.parent.postMessage({ type: 'iframe-click' }, '*');
    });

    window.addEventListener('message', function(event) {
      // Only the host drives the preview; project code in this frame, or a page it opened, does not.
      if (event.source !== window.parent) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'placement-start') {
        activate(data.block);
      } else if (data.type === 'placement-hover') {
        handleHover(data.x, data.y);
      } else if (data.type === 'placement-drop') {
        handleDrop();
      } else if (data.type === 'placement-cancel') {
        deactivate(true);
      } else if (data.type === 'placement-remove') {
        var pid = data.placementId;
        // The doubled backslash below is deliberate: this is a template literal, so a single one
        // would collapse before the script is emitted and the guard would match a literal "d"
        // rather than a digit, rejecting every real id. Same doubling as the external-link test.
        if (typeof pid === 'string' && /^sb-\\d+-[a-z0-9]+$/.test(pid)) {
          var el = document.querySelector('[data-placement-id="' + pid + '"]');
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
      }
    });
  })();<\/script>`;
}

/**
 * The preview's navigation + element-selector script, as source for the iframe.
 *
 * Module level and exported so a test can assert on the *emitted* text. These literals are the
 * one place in this file where an authored `\s` silently collapses to a literal `s` before it is
 * ever emitted, so the emitted string — not the source — is what has to be checked.
 */
export function generateNavigationScript(normalizedPath: string, directEdit: boolean = true): string {
  return `
      <script>
        (function() {
          ${STRIP_PROVENANCE_JS}
          ${STRIP_NODE_ID_JS}
          ${SERIALIZE_TREE_JS}
          ${STYLE_QUERY_JS}
          ${STYLE_PREVIEW_JS}
          ${STYLE_LOCATOR_JS}
          ${STYLE_PROBE_JS}
          ${ESCAPE_CSS_IDENT_JS}
          var __oswDirectEdit = ${directEdit ? 'true' : 'false'};
          ${TOOLBAR_DOM_JS}
          const isInIframe = window !== window.parent;

          function resolveInternalPath(href) {
            let path = href;
            if (!path.startsWith('/')) {
              const currentPath = '${normalizedPath}';
              const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/'));
              path = currentDir + '/' + path;
            }

            if (path.endsWith('.html')) {
              path = path.slice(0, -5);
            }
            if (path === '/index') {
              path = '/';
            }
            return path;
          }

          document.addEventListener('click', function(e) {
            // Respect app-handled navigation: a client router (react-router, vue-router,
            // svelte Link) calls preventDefault at/near the link, which bubbles to us already
            // marked handled. Never hijack those — that is what broke framework routing.
            if (e.defaultPrevented) return;
            const target = e.target && e.target.closest ? e.target.closest('a') : null;
            if (!target || !target.getAttribute) return;
            const href = target.getAttribute('href');
            if (!href) return;

            // Hash links: a srcdoc document resolves '#x' against the PARENT's base URL, so letting
            // the browser navigate would load the parent app into the frame. Instead, set the hash
            // on the current document — this scrolls to '#section' and fires hashchange for a hash
            // router, with no navigation. (A router that handles the click itself already
            // preventDefaulted above, so we don't reach here for those.)
            if (href.charAt(0) === '#') {
              e.preventDefault();
              var id = href.length > 1 ? href.slice(1) : '';
              var scrollEl = id ? document.getElementById(id) : null;
              if (scrollEl) {
                scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
              } else {
                // No matching element — likely a hash-router route (e.g. #/about); set the hash to
                // fire hashchange so the router responds. No navigation in either case.
                try { window.location.hash = href; } catch (e) { /* best-effort */ }
              }
              return;
            }
            // Native schemes and downloads — let the browser handle them.
            if (/^(mailto:|tel:|javascript:)/i.test(href) || target.hasAttribute('download')) return;

            if (!isInIframe) return;

            // External: don't let the frame navigate away (that replaces the preview). Hand off
            // to the host, which confirms and opens a new tab with noopener,noreferrer.
            if (/^(https?:)?\\/\\//i.test(href)) {
              e.preventDefault();
              window.parent.postMessage({ type: 'preview:external', href: href }, '*');
              return;
            }
            // Internal, not app-handled → host serves the file (no server behind srcdoc).
            e.preventDefault();
            window.parent.postMessage({ type: 'navigate', path: resolveInternalPath(href) }, '*');
          });

          const selectorState = {
            active: false,
            overlay: null,
            lastTarget: null,
            previousCursor: ''
          };

          function isElement(node) {
            return node && node.nodeType === 1;
          }

          // Is this event target the selection toolbar?
          //
          // Checking the target alone is sufficient and is not a shortcut: the toolbar's chrome
          // lives in a shadow root, and an event that starts on a button inside it is *retargeted*
          // before any document-level listener sees it — event.target is the host, which is the
          // element carrying the attribute. There is no composed path to walk.
          function isToolbarTarget(node) {
            return !!(isElement(node) && node.getAttribute && node.getAttribute('${TOOLBAR_HOST_ATTR}') !== null);
          }

          function ensureOverlay() {
            if (selectorState.overlay) {
              // Re-attach if something replaced the body's children out from under us — a user
              // project's own script can do it, and so can an agent edit. The node is cached, so
              // without this the overlay stays detached and the highlight silently stops working for
              // the rest of the document's life.
              if (!selectorState.overlay.isConnected && document.body) {
                document.body.appendChild(selectorState.overlay);
              }
              return selectorState.overlay;
            }
            const overlay = document.createElement('div');
            // The one thing that tells this div apart from a user's own. Nothing could recognise it
            // before, so neither a serializer walking document.body nor any future consumer could
            // exclude it.
            overlay.setAttribute('data-osw-overlay', '1');
            overlay.style.position = 'absolute';
            overlay.style.pointerEvents = 'none';
            overlay.style.border = '2px solid rgba(99, 102, 241, 0.95)';
            overlay.style.background = 'rgba(99, 102, 241, 0.08)';
            overlay.style.boxShadow = '0 0 0 4px rgba(99, 102, 241, 0.32), 0 20px 40px rgba(15, 23, 42, 0.28)';
            overlay.style.borderRadius = '12px';
            overlay.style.zIndex = '2147483647';
            overlay.style.transition = 'top 0.12s ease-out, left 0.12s ease-out, width 0.12s ease-out, height 0.12s ease-out';
            overlay.style.willChange = 'top, left, width, height';
            selectorState.overlay = overlay;
            document.body.appendChild(overlay);
            return overlay;
          }

          // The second argument is an optional rect the caller already took. The toolbar passes the
          // very rect it placed itself from, so the bar and the outline cannot be positioned from two
          // different moments in a layout that is still settling. Omitted by the hover path, which has
          // no rect of its own and wants the current one.
          function positionOverlay(target, measured) {
            if (!isElement(target)) {
              return;
            }
            const overlay = ensureOverlay();
            const rect = measured || target.getBoundingClientRect();
            overlay.style.top = (rect.top + window.scrollY) + 'px';
            overlay.style.left = (rect.left + window.scrollX) + 'px';
            overlay.style.width = Math.max(rect.width, 1) + 'px';
            overlay.style.height = Math.max(rect.height, 1) + 'px';
            overlay.style.opacity = '1';
          }

          // The single entry point for the highlight: an element to show it on, or null to hide it.
          //
          // Hides rather than removes, and every path goes through here. Detaching and re-appending
          // the node would churn document.body.children between two serializations of the same
          // level, which is exactly the instability the Elements tree has to be immune to. It also
          // means a highlight raised while the click-selector is off has a way back down — the old
          // teardown was reachable only from disableSelector, which early-returns when the selector
          // is inactive.
          function setOverlayVisible(target, measured) {
            if (isElement(target)) {
              positionOverlay(target, measured);
              return;
            }
            if (selectorState.overlay) {
              selectorState.overlay.style.opacity = '0';
            }
          }

          // The outline the toolbar asks for. Selection is no longer a momentary act — the toolbar
          // stays on the element and so must the mark saying which element it is, otherwise the two
          // disagree about what is selected the moment the picker disarms.
          //
          // Hover wins while the picker is armed: handleMouseMove is writing the outline to whatever
          // is under the pointer, and a reposition from the ResizeObserver must not yank it back to
          // the previous selection mid-hover. disableSelector restores it on the way out.
          function __oswToolbarOnPlace(target, measured) {
            if (selectorState.active) {
              return;
            }
            setOverlayVisible(target, measured);
          }

          function buildDomPath(element) {
            if (!isElement(element)) {
              return '';
            }
            const segments = [];
            let current = element;
            while (current && current.nodeType === 1) {
              let segment = current.tagName.toLowerCase();
              if (current.id) {
                // Escaped, because this path is fed back to querySelector by selection-resolve
                // after a recompile. A raw '#' + id makes an id starting with a digit or containing
                // '.', ':' or '/' either throw a SyntaxError or — worse — quietly select something
                // else. Ordinary ids come through unchanged, so the emitted format is untouched for
                // everything that already worked. (No backticks in this comment: it lives inside a
                // template literal, and one would terminate it.)
                segment += '#' + __oswEscapeIdent(current.id);
                segments.unshift(segment);
                break;
              }
              const parent = current.parentElement;
              if (parent) {
                const siblings = parent.children;
                let index = 0;
                for (let i = 0; i < siblings.length; i++) {
                  if (siblings[i].tagName === current.tagName) {
                    index++;
                  }
                  if (siblings[i] === current) {
                    if (index > 1) {
                      segment += ':nth-of-type(' + index + ')';
                    } else {
                      const hasSame = Array.from(siblings).some(function(child, childIndex) {
                        return childIndex !== i && child.tagName === current.tagName;
                      });
                      if (hasSame) {
                        segment += ':nth-of-type(' + index + ')';
                      }
                    }
                    break;
                  }
                }
              }
              segments.unshift(segment);
              current = parent;
            }
            return segments.join(' > ');
          }

          function gatherAttributes(element) {
            const attributes = {};
            if (!isElement(element) || !element.attributes) {
              return attributes;
            }
            const maxAttributes = 25;
            for (let i = 0; i < element.attributes.length && i < maxAttributes; i++) {
              const attr = element.attributes[i];
              if (!attr) continue;
              const name = attr.name;
              if (!name || name === 'style' || name.startsWith('on')) {
                continue;
              }
              // Preview-only instrumentation. Injection lands immediately after the tag name, so
              // this is always attribute index 0 — describeFocusTarget renders the first six
              // attributes into the prompt, so leaving it in would both show it to the agent and
              // evict a real attribute.
              if (name === 'data-osw-src') {
                continue;
              }
              // Same reasoning for the Elements tree's transient node id: stamped on the live
              // element as the tree serializes it, so it would otherwise be attribute index 1 of
              // anything the user has expanded to.
              if (name === 'data-osw-node') {
                continue;
              }
              attributes[name] = attr.value;
            }
            return attributes;
          }

          // The one place a focus payload is built. Every field derives from the target element
          // alone — nothing comes from the click event — so any caller holding an element can
          // produce the identical payload, and the Elements tree's select path does exactly that.
          //
          // The guarantee has to live in this function rather than in a test comparing two copies:
          // a comparison test passes right up until the copies drift, which is the next change.
          function buildSelectionPayload(target) {
            // The frame used to discard the selection the moment it was made — handleClick calls
            // disableSelector, which nulls lastTarget, and neither tree-select nor selection-resolve
            // held the element either. The toolbar has to stay anchored to it, so the one builder
            // all three paths reach is where the element is kept. Tracking here rather than in each
            // caller is what makes a tree selection and a click produce the same toolbar; the
            // observer it re-targets is constructed once, at script init, so this cannot stack.
            // No toolbar where nothing it offers can work. In a bundled runtime the framework
            // draws the element, so it carries no provenance and Style, Text and Replace would each
            // refuse; a bar of four dead buttons is worse than no bar. The selection itself still
            // happens, and still reaches the agent.
            if (__oswDirectEdit) __oswToolbarTrack(target);
            // Stamped before anything else is read, so the attribute is genuinely on the element by
            // the time outerHTML is taken — the stripper is then what keeps it out of the payload,
            // rather than the order these fields happen to be evaluated in. __oswNodeId hands back
            // an existing id, so an element the tree already serialized keeps the id the host holds.
            var nodeId = __oswNodeId(target);
            // Provenance is read here and counted here: the host cannot reach into
            // contentDocument, so anything derived from the live DOM has to be computed inside
            // the frame. Attribute values are compared in a loop rather than built into a
            // selector string — no escaping, so there is nothing to get wrong.
            var srcAttr = target.getAttribute ? target.getAttribute('data-osw-src') : null;
            var instanceCount = 0;
            if (srcAttr) {
              var all = document.querySelectorAll('[data-osw-src]');
              for (var q = 0; q < all.length; q++) {
                if (all[q].getAttribute('data-osw-src') === srcAttr) instanceCount++;
              }
            }
            return {
              domPath: buildDomPath(target),
              tagName: target.tagName.toLowerCase(),
              attributes: gatherAttributes(target),
              outerHTML: __oswStripNodeId(__oswStripProv(target.outerHTML || '')),
              srcAttr: srcAttr || undefined,
              instanceCount: instanceCount || undefined,
              // Read off the live element, not recovered from the outerHTML above: the host would
              // have to parse a string to learn what two property accesses say here, and the string
              // it would parse has already been through the provenance stripper. Always a boolean,
              // because "no element children and no text" is an answer.
              textBearing: __oswToolbarTextBearing(target),
              nodeId: nodeId
            };
          }

          function handleMouseMove(event) {
            if (!selectorState.active) {
              return;
            }
            // The toolbar sits right beside the element it is anchored to, so reaching for one of
            // its buttons means moving the pointer over it. Leave the highlight where it is rather
            // than painting it onto preview furniture. lastTarget is left alone deliberately: it
            // still names the highlighted element, so moving back off the toolbar onto that same
            // element is correctly a no-op rather than a re-paint.
            if (isToolbarTarget(event.target)) {
              return;
            }
            const target = isElement(event.target) ? event.target : (event.target && event.target.parentElement);
            if (!isElement(target) || target === selectorState.lastTarget) {
              return;
            }
            selectorState.lastTarget = target;
            setOverlayVisible(target);
          }

          function handleClick(event) {
            if (!selectorState.active) {
              return;
            }
            // A press on the toolbar is not a selection of the toolbar. Returned before
            // preventDefault and before disableSelector, both deliberately: the toolbar's own
            // button handlers live inside the shadow root and still need the event, and the tool
            // the user armed stays armed, still waiting for the element they meant to pick.
            if (isToolbarTarget(event.target)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') {
              event.stopImmediatePropagation();
            }
            const target = isElement(event.target) ? event.target : (event.target && event.target.parentElement);
            if (!isElement(target)) {
              disableSelector(false);
              return;
            }
            const payload = buildSelectionPayload(target);
            if (isInIframe) {
              window.parent.postMessage({ type: 'selector-selection', payload: payload }, '*');
            }
            disableSelector(false);
          }

          function handleContextMenu(event) {
            if (!selectorState.active) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
          }

          function handleKeyDown(event) {
            if (!selectorState.active) {
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              disableSelector(true);
            }
          }

          function enableSelector() {
            if (selectorState.active) {
              return;
            }
            selectorState.active = true;
            selectorState.previousCursor = document.body.style.cursor;
            const overlay = ensureOverlay();
            overlay.style.opacity = '0';
            document.body.style.cursor = 'crosshair';
            document.addEventListener('mousemove', handleMouseMove, true);
            document.addEventListener('click', handleClick, true);
            document.addEventListener('contextmenu', handleContextMenu, true);
            document.addEventListener('keydown', handleKeyDown, true);
          }

          function disableSelector(notifyCancel) {
            if (!selectorState.active) {
              return;
            }
            selectorState.active = false;
            selectorState.lastTarget = null;
            // Back to the selection's own outline, not blank. Clicking an element runs this
            // immediately after tracking it, so clearing here is what used to make a click-selected
            // element lose its mark while a tree-selected one kept it.
            setOverlayVisible(__oswToolbarState.tracked || null);
            document.body.style.cursor = selectorState.previousCursor || '';
            document.removeEventListener('mousemove', handleMouseMove, true);
            document.removeEventListener('click', handleClick, true);
            document.removeEventListener('contextmenu', handleContextMenu, true);
            document.removeEventListener('keydown', handleKeyDown, true);
            if (notifyCancel && isInIframe) {
              window.parent.postMessage({ type: 'selector-cancelled' }, '*');
            }
          }

          // Resolve an Elements-tree node id back to its live element, or null when it is gone.
          // querySelector rather than a Map of id to element: a map hands back a *detached* node
          // for a removed element, which positions a 1x1 overlay at (0,0) and builds a domPath from
          // a non-document root. null is the stale signal the panel wants.
          //
          // The selector is assembled by concatenation, and the id is checked to be decimal digits
          // first. Inside this frame ids can only be digits — __oswSerializeLevel mints them as
          // String(counter) — but the value arriving here came from the host over postMessage, so
          // the frame is not the only writer. A quote in it injects nothing (querySelector executes
          // nothing) but does throw a SyntaxError, which would abort the rest of this handler; the
          // digit check makes that unreachable without needing to reason about escaping.
          function __oswResolveNode(nodeId) {
            if (typeof nodeId !== 'string' || nodeId.length === 0) {
              return null;
            }
            for (let i = 0; i < nodeId.length; i++) {
              const c = nodeId.charAt(i);
              if (c < '0' || c > '9') return null;
            }
            return document.querySelector('[data-osw-node="' + nodeId + '"]');
          }

          window.addEventListener('message', function(event) {
            // Only the host drives the preview; project code in this frame, or a page it opened, does not.
            if (event.source !== window.parent) {
              return;
            }
            const data = event.data;
            if (!data || typeof data !== 'object') {
              return;
            }
            if (data.type === 'selector-toggle') {
              if (data.active) {
                enableSelector();
              } else {
                disableSelector(false);
              }
            }

            if (data.type === 'tree-request') {
              // null id is the body level. An id that no longer resolves passes null through to the
              // serializer, which returns an empty level — the reply still names the parent the
              // host asked about, so an expansion of a vanished branch resolves as empty rather
              // than leaving the panel waiting for a message that never comes.
              const root = data.nodeId == null ? document.body : __oswResolveNode(data.nodeId);
              const level = __oswSerializeLevel(root);
              if (isInIframe) {
                window.parent.postMessage({
                  type: 'tree-level',
                  parentId: data.nodeId == null ? null : data.nodeId,
                  nodes: level.nodes,
                  truncated: level.truncated
                }, '*');
              }
              return;
            }

            if (data.type === 'tree-path') {
              // Every level from the body down to the node's parent, in one reply. The host cannot
              // walk this itself: a TreeNode carries no path, and the reducer drops a level whose
              // parent it has not seen, so the levels have to arrive in order and together.
              const target = __oswResolveNode(data.nodeId);
              if (!target) {
                if (isInIframe) {
                  window.parent.postMessage({ type: 'tree-levels', levels: [], path: [] }, '*');
                }
                return;
              }
              // Only elements carrying provenance are rows, so the chain skips everything else.
              // A target without provenance of its own (built by JS at runtime) therefore reveals
              // its nearest ancestor that does have a row, rather than nothing. The attribute name
              // appears here only as a string literal, which provenance-wiring.test.ts enforces.
              const chain = [];
              let walk = target;
              while (walk && walk !== document.body) {
                if (walk.getAttribute('data-osw-src') !== null) chain.unshift(walk);
                walk = walk.parentElement;
              }
              const bodyLevel = __oswSerializeLevel(document.body);
              const levels = [{ parentId: null, nodes: bodyLevel.nodes, truncated: bodyLevel.truncated }];
              // The node itself is not expanded, so its own level is not serialized.
              for (let i = 0; i < chain.length - 1; i++) {
                const lvl = __oswSerializeLevel(chain[i]);
                levels.push({ parentId: __oswNodeId(chain[i]), nodes: lvl.nodes, truncated: lvl.truncated });
              }
              const path = [];
              for (let j = 0; j < chain.length; j++) path.push(__oswNodeId(chain[j]));
              if (isInIframe) {
                window.parent.postMessage({ type: 'tree-levels', levels: levels, path: path }, '*');
              }
              return;
            }

            if (data.type === 'tree-highlight') {
              // The click selector's overlay, through its one visibility control — not a second
              // highlight mechanism, so a hover from the tree and a hover in the preview cannot
              // both be showing at once.
              setOverlayVisible(data.nodeId == null ? null : __oswResolveNode(data.nodeId));
              return;
            }

            if (data.type === 'tree-select') {
              const selected = __oswResolveNode(data.nodeId);
              if (!selected) {
                // Stop here. Falling through would build a payload for a detached or absent
                // element and hand the agent a domPath that resolves to nothing, or to something
                // else. The host is told the id is dead instead.
                if (isInIframe) {
                  window.parent.postMessage({ type: 'tree-stale', nodeId: data.nodeId }, '*');
                }
                return;
              }
              // The same builder the click path uses, so the two selections cannot differ.
              if (isInIframe) {
                window.parent.postMessage({ type: 'selector-selection', payload: buildSelectionPayload(selected) }, '*');
              }
              return;
            }

            if (data.type === 'style-query') {
              // Answered unconditionally, including for an id that no longer resolves:
              // __oswReadComputed returns {} for a null element. Returning early instead would
              // leave the host unable to tell a dead id from a frame that has not replied yet.
              const queried = __oswResolveNode(data.nodeId);
              if (isInIframe) {
                window.parent.postMessage({
                  type: 'style-computed',
                  nodeId: data.nodeId,
                  values: __oswReadComputed(queried, data.properties),
                  // What one rem is worth in this document, on the same reply as the values it is
                  // the divisor for. Sent even when the node is dead, because it is a fact about
                  // the document rather than about the element.
                  rootFontSize: __oswRootFontSize()
                }, '*');
              }
              return;
            }

            if (data.type === 'style-preview') {
              // No reply: the host is not waiting on one, and the next style-query reads the
              // result out of the live document anyway.
              //
              // Deliberately not re-applied on frame-ready. A recompile mints a new document and
              // takes the transient <style> with it, which is the wanted behaviour — by then
              // /overrides.css carries the rule, and putting a stale copy back would mask the next
              // edit the agent makes to the same element.
              __oswApplyStylePreview(data.markerId, data.css);
              // The element may have just changed size — padding, font-size, border-width all do it
              // — with no scroll, no message and no recompile to prompt a new position. The
              // ResizeObserver covers the real browser; this covers the same instant synchronously
              // and is the only path that works where ResizeObserver is absent.
              __oswToolbarReposition();
              return;
            }

            if (data.type === 'style-probe') {
              // Answered unconditionally, for the same reason style-query is: a dead id, a marker
              // with no rule in the document and an override that is simply winning all look
              // identical to a host that got no reply.
              const probed = __oswResolveNode(data.nodeId);
              const outcome = __oswProbeStyleLoss(probed, data.markerId, data.properties);
              if (isInIframe) {
                const reply = { type: 'style-probe-result', nodeId: data.nodeId, lost: outcome.lost };
                // Only when there is one to name. An always-present winner:null would have 4b's
                // message renderer branching on a value that is null in the ordinary case.
                if (outcome.winner) reply.winner = outcome.winner;
                window.parent.postMessage(reply, '*');
              }
              return;
            }

            if (data.type === 'toolbar-theme') {
              // Kept whether or not a toolbar exists yet: this arrives on frame-ready, which is
              // before any selection has mounted one for the colours to land on.
              __oswToolbarTheme(data.colors);
              return;
            }

            if (data.type === 'scroll-restore') {
              // A recompile mints a new document, and a new document starts at the top. That now
              // matters far more than it used to: every Text or Replace edit writes a source file,
              // which recompiles, which used to throw the user back to the top of the page away from
              // the element they were working on.
              //
              // The host captured this off the outgoing document and only sends it back for the same
              // page, so navigating somewhere else cannot restore a stale position.
              //
              // Applied synchronously, and the host sends it *before* the selection-resolve that
              // re-anchors the toolbar: the bar's side is chosen from the viewport, so placing it
              // against scroll 0 and then scrolling to 500 would decide it against a viewport the
              // user never saw.
              //
              // A message naming no position at all is not a request to go to the top — that is
              // where an untouched fresh document already is, and acting on it would turn a
              // malformed message into a jump.
              if (typeof data.scrollY !== 'number' && typeof data.scrollX !== 'number') return;
              var restoreY = typeof data.scrollY === 'number' ? data.scrollY : 0;
              var restoreX = typeof data.scrollX === 'number' ? data.scrollX : 0;
              if (typeof window.scrollTo === 'function') {
                try {
                  // The options form, with behavior 'instant'. Not scrollTo(x, y): the two-argument
                  // form obeys the document's own scroll-behavior, and three of the built-in
                  // templates set that to smooth — so restoring a position animated a scroll over a
                  // document that had only just been replaced, which reads as a lurch rather than as
                  // the page opening where it was left. 'instant' overrides the CSS; 'auto' defers
                  // to it, which is the bug.
                  window.scrollTo({ left: restoreX, top: restoreY, behavior: 'instant' });
                } catch (err) {
                  // A document old enough to reject the options form still scrolls the plain way.
                  try {
                    window.scrollTo(restoreX, restoreY);
                  } catch (err2) {
                    // Best effort. A frame that refuses to scroll is a frame that opens at the top,
                    // which is exactly the behaviour this replaces — not a reason to stop.
                  }
                }
              }
              // For the case where a toolbar is somehow already up when this arrives. On the ordinary
              // frame-ready path there is none yet, which is the point of the ordering above.
              __oswToolbarCheckFit();
              return;
            }

            if (data.type === 'selection-clear') {
              // The only way the frame lets go of a selection. Nothing else releases it: the click
              // selector disarms itself after a selection but the element stays tracked, which is
              // the point — the toolbar outlives the tool that made it.
              __oswToolbarRelease();
              return;
            }

            if (data.type === 'selection-resolve') {
              // The recompile took every node id with it, so the host is holding a domPath and
              // nothing else. querySelector is wrapped because the path can predate the escaping
              // above — a selection made before this version, or an id the escape does not cover —
              // and a SyntaxError here would abort the rest of this handler.
              let resolved = null;
              try {
                resolved = typeof data.domPath === 'string' && data.domPath !== ''
                  ? document.querySelector(data.domPath)
                  : null;
              } catch (err) {
                resolved = null;
              }
              if (isInIframe) {
                // The same builder the click and tree paths use, so a re-resolved selection is not
                // a second, subtly different kind of selection.
                window.parent.postMessage({
                  type: 'selection-resolved',
                  payload: resolved ? buildSelectionPayload(resolved) : null
                }, '*');
              }
              return;
            }
          });
        })();
      </script>
    `;
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
  // The preview "escaped": the frame navigated somewhere that isn't the document we wrote (a form
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
  // Each document we write posts `preview:ready` from its own load event, and the iframe element
  // fires `load` in this window. The two arrive in either order (a cross-origin frame runs in its
  // own process), so they are paired by count: a load with no ack inside ACK_TIMEOUT_MS is a
  // document that is not ours, the frame having navigated to an external site.
  const unpairedAcksRef = useRef(0);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The outgoing document's scroll position, as last reported by the frame itself.
  const frameScrollRef = useRef<FrameScroll | null>(null);
  // The page waiting for its shell to ask for it (`lib/preview/preview-shell.ts`).
  // Read by the message handler, which is not re-registered when the deployment changes.
  const deploymentIdRef = useRef(deploymentId);
  deploymentIdRef.current = deploymentId;
  const pendingShellRef = useRef<{ loadId: number; html: string; blobUrls: string[]; cache: Map<string, Blob> } | null>(null);
  // Blobs already read for a compile, so a reload of the same compile does not read them again.
  const shellCacheRef = useRef(new WeakMap<object, Map<string, Blob>>());

  // Respond to a confident escape signal (the load-event marker check found the frame is no longer
  // our document): one bounded auto-reload, then the recovery overlay. Stable — safe to call from
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
        undefined, undefined, options?.outputWidth, undefined, undefined, undefined,
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
  }), [iframeReady, startBlockDrag, activePath, postMessageToIframe]);

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
    const handleLoad = () => {
      postMessageToIframe({ type: 'selector-toggle', active: selectorActiveRef.current });
      const expected = lifecycleRef.current.loadId;
      if (expected === 0) return; // initial about:blank load, before we've written any document

      if (unpairedAcksRef.current > 0) {
        unpairedAcksRef.current -= 1;
        return;
      }
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => {
        ackTimerRef.current = null;
        if (unpairedAcksRef.current > 0) {
          unpairedAcksRef.current -= 1;
          return;
        }
        handleEscapeSignal(expected);
      }, ACK_TIMEOUT_MS);
    };
    iframe.addEventListener('load', handleLoad);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    };
  }, [iframeReady, postMessageToIframe, handleEscapeSignal]);

  /** One of our documents loaded: pair it with the iframe load event it belongs to. */
  const pairAck = useCallback(() => {
    if (ackTimerRef.current) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    } else {
      unpairedAcksRef.current += 1;
    }
  }, []);

  /** A shell we wrote is asking for its page. */
  const handleShellReady = useCallback((loadId: number) => {
    pairAck();
    const pending = pendingShellRef.current;
    const target = iframeRef.current?.contentWindow;
    if (!pending || pending.loadId !== loadId || loadId !== lifecycleRef.current.loadId || !target) return;
    pendingShellRef.current = null;
    sendShellContent(target, loadId, pending.html, pending.blobUrls, pending.cache).catch((err) => {
      logger.error('[Preview] Could not send the page to the preview frame:', err);
    });
  }, [pairAck]);

  /** A document we wrote reached its load event. Any loadId counts as ours; only the current one is ready. */
  const handleReadyAck = useCallback((loadId: number) => {
    pairAck();
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
    // we wrote. Announced on every load, because each one invalidates whatever the consumer knows
    // about the old document.
    onFrameReadyRef.current?.();
    // After the consumer, not before: this document is brand new and has no toolbar colours
    // at all until they are sent again, and the selection the consumer is about to re-resolve
    // is what mounts the toolbar that reads them.
    postToolbarThemeRef.current();
  }, [pairAck, postMessageToIframe]);

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

      const server = new VirtualServer(vfs, projectId, { deploymentId: deploymentId || undefined, entryPoint, runtime: resolvedRuntime, provenance });
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
    
    processedHtml = processedHtml.replace(/href="([^"]+)"/g, (match, href) => {
      // Skip if not a CSS file or if it's an external URL
      if (!href.endsWith('.css') || href.startsWith('http') || href.startsWith('//')) {
        return match;
      }
      
      const normalizedHref = href.startsWith('/') ? href : '/' + href;
      const blobUrl = projectToUse.blobUrls.get(normalizedHref);
      
      if (blobUrl) {
        return `href="${blobUrl}"`;
      }
      return match;
    });
    
    // Replace JavaScript sources
    processedHtml = processedHtml.replace(/src="([^"]+)"/g, (match, src) => {
      if (!src.endsWith('.js') || src.startsWith('http') || src.startsWith('//')) {
        return match;
      }
      
      const normalizedSrc = src.startsWith('/') ? src : '/' + src;
      const blobUrl = projectToUse.blobUrls.get(normalizedSrc);
      
      if (blobUrl) {
        return `src="${blobUrl}"`;
      }
      return match;
    });
    
    processedHtml = processedHtml.replace(/src="([^"]+\.(png|jpg|jpeg|gif|svg|webp))"/gi, (match, imgPath) => {
      const normalizedImgPath = imgPath.startsWith('/') ? imgPath : '/' + imgPath;
      const blobUrl = projectToUse.blobUrls.get(normalizedImgPath);
      return blobUrl ? `src="${blobUrl}"` : match;
    });

    // The resolved runtime, not the prop: a project whose settings never named one is compiled as
    // the fallback, and asking `supportsDirectEditing` about `undefined` answered "no toolbar" for a
    // document that had just been stamped with the provenance the toolbar runs on.
    const navigationScript = generateNavigationScript(normalizedPath, supportsDirectEditing(resolvedRuntime));
    
    const placementScript = generatePlacementScript();
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
    unpairedAcksRef.current = 0;
    const markerScript = previewBridgeScript(loadId);
    const headInject = markerScript + vfsMapScript;
    if (processedHtml.includes('<head>')) {
      processedHtml = processedHtml.replace('<head>', '<head>' + headInject);
    } else {
      processedHtml = headInject + processedHtml;
    }

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
    pendingShellRef.current = { loadId, html: processedHtml, blobUrls: [...projectToUse.blobUrls.values()], cache };
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
        const target = event.source as Window;
        runFunctionCall(data, deploymentIdRef.current).then((reply) => {
          target.postMessage(reply, '*', reply.body ? [reply.body] : []);
        });
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

      if (data.type === 'preview:scroll' && data.loadId === lifecycleRef.current.loadId
        && Number.isFinite(data.x) && Number.isFinite(data.y)) {
        frameScrollRef.current = { x: data.x, y: data.y };
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
        setPaletteVisible(true);
        onPlacementComplete?.(data.payload);
        return;
      }

      if (data.type === 'placement-cancelled') {
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

  return (
    <div ref={attachRoot} className="h-full flex flex-col">
      <Header />
      {/* Mobile Layout - Single row with navigation and page selector. Shown in quick edit too,
          where the preview shares the screen with the Inspector and this is the only way to
          drive it. */}
      <div className="border-b p-2 flex items-center gap-2 md:hidden">
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleBack}
            disabled={historyIndex === 0}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleForward}
            disabled={historyIndex >= navigationHistory.length - 1}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleHome}
          >
            <Home className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleRefresh}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={cn('h-5 w-5', crosshairHintClasses)}
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
            title={selectorActive ? tsx('cancelSelectionLong') : hasFocusTarget ? t('replaceFocused') : tw('selectElement')}
            data-tour-id="focus-crosshair-button"
          >
            <Crosshair className="h-3 w-3" />
          </Button>
          {!simple && (
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={() => {
              setLocalPaletteOpen(prev => !prev);
              setTimeout(() => onPlacementToggle?.(), 0);
            }}
            disabled={!iframeReady}
            title={t('semanticBlocks')}
            style={localPaletteOpen ? { backgroundColor: 'var(--button-preview-active)', color: 'white' } : {}}
          >
            <LayoutGrid className="h-3 w-3" />
          </Button>
          )}
        </div>

        {/* Page selector takes remaining space */}
        {compiledProject && compiledProject.routes.length > 1 && (
          <Select value={activePath} onValueChange={handleNavigation}>
            <SelectTrigger className="flex-1 h-8 min-w-0 max-w-full">
              <SelectValue className="truncate" />
            </SelectTrigger>
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
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleBack}
            disabled={historyIndex === 0}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleForward}
            disabled={historyIndex >= navigationHistory.length - 1}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleHome}
          >
            <Home className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={handleRefresh}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={cn('h-5 w-5', crosshairHintClasses)}
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
            title={selectorActive ? tsx('cancelSelectionLong') : hasFocusTarget ? t('replaceFocused') : tw('selectElement')}
            data-tour-id="focus-crosshair-button"
          >
            <Crosshair className="h-3 w-3" />
          </Button>
          {!simple && (
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={() => {
              setLocalPaletteOpen(prev => !prev);
              setTimeout(() => onPlacementToggle?.(), 0);
            }}
            disabled={!iframeReady}
            title={t('semanticBlocks')}
            style={localPaletteOpen ? { backgroundColor: 'var(--button-preview-active)', color: 'white' } : {}}
          >
            <LayoutGrid className="h-3 w-3" />
          </Button>
          )}
        </div>

        <div className="flex-1 px-3 py-1 bg-muted rounded text-sm">
          {activePath}
        </div>

        {compiledProject && compiledProject.routes.length > 1 && (
          <Select value={activePath} onValueChange={handleNavigation}>
            <SelectTrigger className="w-[200px] h-8">
              <SelectValue />
            </SelectTrigger>
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
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 rounded-sm"
            style={{
              backgroundColor: deviceSize === 'mobile' ? 'var(--button-preview-active)' : undefined,
              color: deviceSize === 'mobile' ? 'white' : undefined
            }}
            onClick={() => handleSetDeviceSize('mobile')}
          >
            <Smartphone className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 rounded-sm"
            style={{
              backgroundColor: deviceSize === 'tablet' ? 'var(--button-preview-active)' : undefined,
              color: deviceSize === 'tablet' ? 'white' : undefined
            }}
            onClick={() => handleSetDeviceSize('tablet')}
          >
            <Tablet className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 rounded-sm"
            style={{
              backgroundColor: deviceSize === 'desktop' ? 'var(--button-preview-active)' : undefined,
              color: deviceSize === 'desktop' ? 'white' : undefined
            }}
            onClick={() => handleSetDeviceSize('desktop')}
          >
            <Monitor className="h-3 w-3" />
          </Button>
          {isFullscreen ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 rounded-sm"
              onClick={onClose}
              title={t('exitFullSize')}
            >
              <Minimize className="h-3 w-3" />
            </Button>
          ) : onFullscreen ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 rounded-sm"
              onClick={onFullscreen}
              title={t('fullSize')}
            >
              <Maximize className="h-3 w-3" />
            </Button>
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
            sandbox="allow-scripts allow-forms"
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
