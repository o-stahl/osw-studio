/**
 * The script every preview document carries: in-page navigation, the element selector, and the frame
 * half of the Inspector (the Elements tree, the Styles tab's reads and transient styles, selection
 * re-resolve). Live Preview writes it into the page it shows; Canvas writes it into each artboard,
 * with its own bridge in the same closure.
 */

import { STRIP_PROVENANCE_JS } from './provenance';
import { SERIALIZE_TREE_JS } from './element-tree';
import { STYLE_QUERY_JS, STYLE_PREVIEW_JS, STYLE_LOCATOR_JS, STYLE_PROBE_JS } from './style-preview';
import { STRUCTURE_PATCH_JS } from './structure-patch';
import { TOOLBAR_DOM_JS, TOOLBAR_HOST_ATTR } from './toolbar-dom';

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
 * The preview's navigation + element-selector script, as source for the iframe.
 *
 * Module level and exported so a test can assert on the *emitted* text. These literals are the
 * one place in this file where an authored `\s` silently collapses to a literal `s` before it is
 * ever emitted, so the emitted string — not the source — is what has to be checked.
 *
 * `extra` is more script for the same closure, so it shares the payload builder and the node ids:
 * Canvas's artboard bridge (`lib/canvas/bridge.ts`). The preview passes none.
 *
 * `pageFile` is the file the document was compiled from (`/about.html` for the route `/about`), which
 * every selection payload names as its page.
 */
export function generateNavigationScript(normalizedPath: string, directEdit: boolean = true, extra: string = '', pageFile: string = normalizedPath): string {
  return `
      <script>
        (function() {
          var __oswPageFile = ${JSON.stringify(pageFile).replace(/</g, '\\u003c')};
          ${STRIP_PROVENANCE_JS}
          ${STRIP_NODE_ID_JS}
          ${SERIALIZE_TREE_JS}
          ${STYLE_QUERY_JS}
          ${STYLE_PREVIEW_JS}
          ${STRUCTURE_PATCH_JS}
          ${STYLE_LOCATOR_JS}
          ${STYLE_PROBE_JS}
          ${ESCAPE_CSS_IDENT_JS}
          var __oswDirectEdit = ${directEdit ? 'true' : 'false'};
          ${TOOLBAR_DOM_JS}
          const isInIframe = window !== window.parent;

          function resolveInternalPath(href) {
            let path = href;
            if (!path.startsWith('/')) {
              const currentPath = ${JSON.stringify(normalizedPath).replace(/</g, '\\u003c')};
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
            // marked handled. Never hijack those: taking the click over breaks framework routing.
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
            // Internal, not app-handled → host serves the file (no server behind srcdoc). Storage
            // written just before the click goes first, or the next page starts without it.
            e.preventDefault();
            if (window.__oswFlushStorage) window.__oswFlushStorage();
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
            // The one thing that tells this div apart from a user's own, and so the only way a
            // serializer walking document.body, or anything else that has to leave the overlay out,
            // can recognise it.
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
          // gives a highlight raised while the click-selector is off a way back down: disableSelector
          // early-returns when the selector is inactive, so a teardown reachable only from there
          // would leave that highlight up.
          function setOverlayVisible(target, measured) {
            if (isElement(target)) {
              positionOverlay(target, measured);
              return;
            }
            if (selectorState.overlay) {
              selectorState.overlay.style.opacity = '0';
            }
          }

          // The outline the toolbar asks for. Selection is not a momentary act: the toolbar stays on
          // the element and so must the mark saying which element it is, otherwise the two disagree
          // about what is selected the moment the picker disarms.
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
                // else. Ordinary ids come through unchanged. (No backticks in this comment: it lives
                // inside a template literal, and one would terminate it.)
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
              // A marker this document put on for an edit not written yet, which source may never
              // carry: a write trusts the marker a payload names, and would skip the stamp.
              if (name === __oswMarkerAttr && __oswProvisional && __oswProvisional.has(element)) {
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
            // The selected element is kept here, in the one builder all three paths reach, because
            // nothing else holds it once the selection is made: handleClick calls disableSelector,
            // which nulls lastTarget, and neither tree-select nor selection-resolve keeps the
            // element, yet the toolbar has to stay anchored to it. Tracking here rather than in each
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
            // the frame. __oswWithSrc compares attribute values rather than building a selector
            // string: no escaping, so there is nothing to get wrong.
            var srcAttr = target.getAttribute ? target.getAttribute('data-osw-src') : null;
            var instanceCount = srcAttr ? __oswWithSrc(srcAttr).length : 0;
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
              locked: !!(target.closest && target.closest('[data-osw-lock]')),
              frame: target.hasAttribute ? target.hasAttribute('data-osw-frame') : false,
              page: __oswPageFile,
              // The width the page was laid out at: an artboard's, or the preview's device or panel.
              viewportWidth: Math.round(window.innerWidth),
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
            // immediately after tracking it, so clearing here would take the mark off a
            // click-selected element while a tree-selected one kept it.
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
            // Messages from any window but the host (a page project code opened) are ignored.
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
              // The chain is the target and every ancestor below the body, outermost first, so the
              // level that holds the target is always serialized and the path ends with the target
              // itself, one the page's script built included. An ancestor without a source (a
              // script-built container, a tbody the parser added) is on the path too: its row has
              // no caret, so this reveal is the one thing that opens it.
              const chain = [];
              let walk = target;
              while (walk && walk !== document.body) {
                chain.unshift(walk);
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
                  rootFontSize: __oswRootFontSize(),
                  specified: __oswSpecifiedValues(queried, data.specified),
                  variables: __oswVariablesOf(queried, data.variables),
                  viewportWidth: window.innerWidth,
                  parent: queried && queried.parentElement
                    ? (function (cs) { return { display: cs.display, flexDirection: cs.flexDirection }; })(window.getComputedStyle(queried.parentElement))
                    : null
                }, '*');
              }
              return;
            }

            if (data.type === 'structure-patch') {
              // A structural edit the host just wrote: shown now, named as the file now names it,
              // until the recompile replaces this document. The reply says whether the patch
              // applied; the host refreshes its tree and selection when it sends the patch, and
              // nothing in it reads the reply.
              var patched = false;
              try {
                patched = __oswStructurePatch(data);
              } catch (err) {
                patched = false;
              }
              __oswToolbarReposition();
              if (isInIframe) window.parent.postMessage({ type: 'structure-patched', ok: patched }, '*');
              return;
            }

            if (data.type === 'select-src') {
              // The element an edit left selected, by the provenance value it now has. Answered
              // the way a tree selection is, so it is an ordinary selection to the host.
              const named = __oswFindSrc(data.src);
              if (named && isInIframe) {
                window.parent.postMessage({ type: 'selector-selection', payload: buildSelectionPayload(named) }, '*');
              }
              return;
            }

            if (data.type === 'variable-preview') {
              // A custom property being edited in the Styles tab, shown before its stylesheet is
              // written: set on the root element, where it stands in for a :root declaration, and
              // gone with this document when the write recompiles the page. null takes it off.
              if (typeof data.name === 'string' && /^--[A-Za-z0-9_-]+$/.test(data.name)) {
                if (typeof data.value === 'string') document.documentElement.style.setProperty(data.name, data.value);
                else document.documentElement.style.removeProperty(data.name);
                __oswToolbarReposition();
              }
              return;
            }

            if (data.type === 'overrides-preview') {
              // No reply: the host is not waiting on one, and the next style-query reads the
              // result out of the live document anyway.
              //
              // The frame keeps no copy of its own. The host sends its held copy again on
              // frame-ready, for a page loaded without a recompile, and holds none once a write
              // recompiles, so a stale copy never masks the next edit the agent makes to the file.
              __oswMarkElements(data.marks, data.unmarks);
              __oswApplyOverrides(data.css);
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
                const reply = { type: 'style-probe-result', nodeId: data.nodeId, lost: outcome.lost, written: outcome.written };
                // Which of the host's questions this answers, handed back as given.
                if (typeof data.tag === 'string') reply.tag = data.tag;
                // Only when there is one to name. An always-present winner:null would have the
                // Styles tab's loss message branching on a value that is null in the ordinary case.
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
              // A recompile mints a new document, and a new document starts at the top. Every Text or
              // Replace edit writes a source file, which recompiles, so without this each one would
              // throw the user back to the top of the page, away from the element they were working
              // on.
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
                  // templates set that to smooth, so restoring a position that way animates a scroll
                  // over a document that has only just been replaced, which reads as a lurch rather
                  // than as the page opening where it was left. 'instant' overrides the CSS; 'auto'
                  // defers to it and lurches the same way.
                  window.scrollTo({ left: restoreX, top: restoreY, behavior: 'instant' });
                } catch (err) {
                  // A document old enough to reject the options form still scrolls the plain way.
                  try {
                    window.scrollTo(restoreX, restoreY);
                  } catch (err2) {
                    // Best effort. A frame that refuses to scroll opens at the top, where a fresh
                    // document starts anyway: not a reason to stop.
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
              // nothing else. querySelector is wrapped because the host's path is not certain to
              // parse: it may not have come through the escaping above, or may hold an id the escape
              // does not cover, and a SyntaxError here would abort the rest of this handler.
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
          ${extra}
        })();
      </script>
    `;
}
