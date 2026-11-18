import { STRIP_PROVENANCE_JS } from './provenance';
import { STRIP_NODE_ID_JS } from './navigation-script';
import { TOOLBAR_HOST_ATTR } from './toolbar-dom';

/**
 * The preview's semantic-block placement script, as source for the iframe.
 *
 * On a page compiled with source positions (`data-osw-src`), a block goes beside an element the
 * source has, and the drop is reported as a place in source terms for the host to write the
 * placeholder at; `pageFile` is the page's file, which names the places between the page's top-level
 * elements. On a page without, the frame shows the placeholder itself and reports where it put it.
 *
 * Exported for the same reason as generateNavigationScript in `navigation-script.ts`: the escaping
 * of anything authored inside this template literal is only observable in the emitted string.
 */
export function generatePlacementScript(pageFile: string | null = null): string {
  return `<script>(function() {
    ${STRIP_PROVENANCE_JS}
    ${STRIP_NODE_ID_JS}
    var PAGE_FILE = ${JSON.stringify(pageFile).replace(/</g, '\\u003c')};
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

    function hasSource() {
      return document.querySelector('[data-osw-src]') !== null;
    }

    function sourced(el) {
      return !!(el && el.getAttribute && el.getAttribute('data-osw-src') !== null);
    }

    function fileOf(el) {
      var v = el.getAttribute('data-osw-src'), cut = v ? v.lastIndexOf(':') : -1;
      return cut > 0 ? v.slice(0, cut) : null;
    }

    function sourcedParent(el) {
      var p = el.parentElement;
      while (p && p !== document.body) {
        if (sourced(p)) return p;
        p = p.parentElement;
      }
      return null;
    }

    function countSrc(src) {
      var all = document.querySelectorAll('[data-osw-src]'), n = 0;
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-osw-src') === src) n++;
      return n;
    }

    // Not a place to put a block beside: preview furniture, a script, or on a page with source
    // positions, an element the source does not have.
    function skippable(el, source) {
      return isPlaceholderOrIndicator(el) || el.tagName === 'SCRIPT' || (source && !sourced(el));
    }

    // The drop as a place in source terms: beside the target when it comes from the page or from the
    // file its parent does. A partial's top element is the exception: the place goes beside a
    // neighbour from its parent's file (the page's, at the top level), or first or last in the
    // parent, and there is none between elements of other files, which that file has no name for.
    function sourcePlace(target, position) {
      var src = target.getAttribute('data-osw-src');
      var own = position === 'before' ? { before: src } : { after: src };
      var parent = sourcedParent(target);
      var file = parent ? fileOf(parent) : PAGE_FILE;
      if (!file || fileOf(target) === file || fileOf(target) === PAGE_FILE) return own;
      var scope = parent || document.body, kids = [];
      for (var i = 0; i < scope.children.length; i++) if (sourced(scope.children[i])) kids.push(scope.children[i]);
      var at = kids.indexOf(target);
      if (at === -1) return own;
      var idx = at + (position === 'after' ? 1 : 0), next = kids[idx], prev = kids[idx - 1];
      if (next && fileOf(next) === file) return { before: next.getAttribute('data-osw-src') };
      if (prev && fileOf(prev) === file) return { after: prev.getAttribute('data-osw-src') };
      if (parent && idx === kids.length) return { parent: parent.getAttribute('data-osw-src'), at: 'end' };
      if (parent && idx === 0) return { parent: parent.getAttribute('data-osw-src'), at: 'start' };
      return null;
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
      var source = hasSource();
      var el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement || el === document.body) {
        var children = document.body.children;
        for (var i = children.length - 1; i >= 0; i--) {
          if (!skippable(children[i], source)) return children[i];
        }
        return null;
      }
      var inPage = function (n) { return n && n !== document.body && n !== document.documentElement; };
      while (inPage(el) && skippable(el, source)) el = el.parentElement;
      if (inPage(el)) {
        var pos = window.getComputedStyle(el).position;
        if (pos === 'absolute' || pos === 'fixed') {
          el = el.parentElement;
          while (inPage(el) && skippable(el, source)) el = el.parentElement;
        }
      }
      return inPage(el) ? el : null;
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
      // land inside this clone only when it *is* the target, which findDropTarget above never
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
      if (!state.active || !state.block) return;
      // Nowhere to put it: the drag ends with nothing placed, and the host stops waiting for it.
      if (!state.currentTarget) { deactivate(true); return; }
      var position = state.currentPosition;

      if (sourced(state.currentTarget)) {
        // The host writes the placeholder into the source; every frame shows it from there.
        var target = state.currentTarget, owner = sourcedParent(target);
        removeIndicator();
        state.currentTarget = null;
        state.currentPosition = 'after';
        window.parent.postMessage({
          type: 'placement-complete',
          payload: {
            blockId: state.block.id,
            place: sourcePlace(target, position),
            instances: owner ? countSrc(owner.getAttribute('data-osw-src')) : 1,
            page: PAGE_FILE
          }
        }, '*');
        return;
      }

      var domPath = buildDomPath(state.currentTarget);

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
      // Messages from any window but the host (a page project code opened) are ignored.
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
