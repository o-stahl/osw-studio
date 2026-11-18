/**
 * What runs inside an artboard's frame.
 *
 * The frame runs project code on an opaque origin, so the host never reads it: everything Canvas
 * needs to know about a page is asked for and answered by message. The head shims go in ahead of the
 * page's own scripts; the bridge runs inside the navigation script's closure
 * (`generateNavigationScript`'s `extra`), so a canvas pick produces the same selection payload and
 * the same node ids as a click in Live Preview, and the Inspector works on either.
 *
 * Plain JavaScript in strings, like `STYLE_QUERY_JS`: it runs in a frame the bundler never sees.
 *
 * Host to frame:
 * - `canvas:pick {reqId, x, y}`: the elements from source files under a point, outermost first.
 * - `canvas:describe {reqId, nodeId}`, `{reqId, src, index}` or `{reqId, childOf}`: one element (or the
 *   first child from source of one), as a pick describes it, or null.
 * - `canvas:watch {targets}`: report these elements' boxes whenever they change, with the first one's
 *   padding, gap and parent layout for the selection's handles.
 * - `canvas:drop-at {reqId, x, y}`: where a new element would go under a point (`canvas:dropped`).
 * - `canvas:edit-text {nodeId}`: type the element's text in place; `canvas:text-done` says how it ended.
 * - `canvas:pace {paused}`: hold or release the page's animation frames.
 * - `canvas:interact {on}`: forward the wheel while the page has the pointer.
 * - `canvas:freeze {reqId}`: a copy of the page as it is now, for the still it becomes.
 * - `canvas:fields {kept}`: what was typed into the page before it last unloaded.
 * - `canvas:inspect {reqId, target, depth, props}`: the agent's `inspect` (`canvas:inspected`).
 *
 * Frame to host: `canvas:ready`, `canvas:height`, `canvas:picked`, `canvas:described`, `canvas:rects`,
 * `canvas:dropped`, `canvas:text-done`, `canvas:frozen`, `canvas:inspected`,
 * `canvas:settled` (settle frames only, with their `loadId`), `canvas:traced` (live frames), `canvas:wheel`, `canvas:awake`, `canvas:key`, and the
 * navigation script's own `navigate` and Inspector replies.
 */

export type CanvasFrameMode = 'live' | 'settle' | 'still';

/**
 * Every observed element counts as on screen, so content that waits to be scrolled to shows: on an
 * artboard the whole page is on screen at once, and a still is taken without anyone scrolling.
 */
export const REVEAL_SHIM_JS = `(function(){function IO(cb){this.cb=cb;this.els=new Set();}
IO.prototype.observe=function(el){var s=this;s.els.add(el);setTimeout(function(){if(!s.els.has(el))return;var r=el.getBoundingClientRect();s.cb([{target:el,isIntersecting:true,intersectionRatio:1,boundingClientRect:r,intersectionRect:r,rootBounds:null,time:performance.now()}],s);},0);};
IO.prototype.unobserve=function(el){this.els.delete(el);};IO.prototype.disconnect=function(){this.els.clear();};IO.prototype.takeRecords=function(){return[];};
window.IntersectionObserver=IO;})();`;

/**
 * The page's animation frames wait while the host says so (`__oswPace(true)`) and run when it lets
 * go. Timers, events and CSS animations are left alone.
 */
export const PAUSE_SHIM_JS = `(function(){var raf=window.requestAnimationFrame.bind(window),caf=window.cancelAnimationFrame.bind(window),paused=false,n=0,calls={};
function run(id){var c=calls[id];c.real=raf(function(t){delete calls[id];c.cb(t);});}
window.__oswPace=function(p){paused=p;if(!p)for(var id in calls)if(!calls[id].real)run(id);};
window.requestAnimationFrame=function(cb){var id=++n;calls[id]={cb:cb,real:0};if(!paused)run(id);return id;};
window.cancelAnimationFrame=function(id){var c=calls[id];if(c){if(c.real)caf(c.real);delete calls[id];}};})();`;

/** Motion stops in stills and settles: an entrance animation shows where it ends. */
export const FREEZE_MOTION_CSS = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important}html{scroll-behavior:auto!important}';

/**
 * The bridge, for `generateNavigationScript`'s closure. In scope there: `__oswPageFile`,
 * `__oswNodeId`, `__oswResolveNode`, `__oswStripNodeId`, `__oswTreeRow`, `__oswSelectorFor`,
 * `__oswWithSrc`, `__oswRankDeclaration`. `loadId` is the load the document was written for.
 */
export function canvasBridgeJs(mode: CanvasFrameMode, deviceHeight: number, loadId: number): string {
  return `
var __cv = { mode: ${JSON.stringify(mode)}, devH: ${Math.round(deviceHeight)}, loadId: ${Math.trunc(loadId)}, watched: [], last: '', interactive: false, h: 0 };
function __cvPost(m) { window.parent.postMessage(m, '*'); }
function __cvSourced(el) { return !!(el && el.getAttribute && el.getAttribute('data-osw-src') !== null); }
function __cvRect(el) { var r = el.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }; }
function __cvSourcedParent(el) { var p = el.parentElement; while (p && p !== document.body) { if (__cvSourced(p)) return p; p = p.parentElement; } return null; }
// Which of the elements sharing its data-osw-src this one is, in document order: how the same element
// is found on the page's other artboards, where the node ids are another document's.
function __cvIndexOf(el) {
  return Math.max(0, __oswWithSrc(el.getAttribute('data-osw-src')).indexOf(el));
}
function __cvFind(t) {
  if (!t) return null;
  if (t.childOf) {
    var parent = __oswResolveNode(t.childOf), inner = parent ? parent.querySelectorAll('[data-osw-src]') : [];
    for (var c = 0; c < inner.length; c++) if (__cvSourcedParent(inner[c]) === parent) return inner[c];
    return null;
  }
  if (t.nodeId) return __oswResolveNode(t.nodeId);
  return typeof t.index === 'number' ? __oswWithSrc(t.src)[t.index] || null : null;
}
function __cvItem(el) {
  var p = __cvSourcedParent(el), cls = (el.getAttribute('class') || '').trim();
  return {
    nodeId: __oswNodeId(el), parentId: p ? __oswNodeId(p) : null, rect: __cvRect(el), height: el.getBoundingClientRect().height,
    tag: el.tagName.toLowerCase(), cls: cls ? cls.split(/\\s+/).slice(0, 2) : [], src: el.getAttribute('data-osw-src'), index: __cvIndexOf(el),
    leafText: !el.children.length && !!(el.textContent || '').trim() && el.tagName !== 'IMG'
  };
}
function __cvChain(x, y) {
  var el = document.elementFromPoint(x - window.scrollX, y - window.scrollY), chain = [];
  while (el && el !== document.body && el !== document.documentElement) { if (__cvSourced(el)) chain.unshift(el); el = el.parentElement; }
  return chain;
}
// The page's height: what its content reaches, at least one screen. scrollHeight never drops below the
// frame's own height, so it only counts when the content overflows the frame.
function __cvHeight() {
  var b = document.body, h = __cv.devH;
  if (b) {
    for (var i = 0; i < b.children.length; i++) { var r = b.children[i].getBoundingClientRect(); if (r.width || r.height) h = Math.max(h, r.bottom + window.scrollY); }
    var cs = getComputedStyle(b); h += (parseFloat(cs.marginBottom) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }
  var sh = document.documentElement.scrollHeight;
  if (sh > window.innerHeight + 1) h = Math.max(h, sh);
  return Math.ceil(h);
}
// Where the page's visible elements came from: written in a project file (the compile stamped
// data-osw-src on them) or not, which is what the page's script built; and how much of the first
// screen is under <canvas> elements, which draw without elements. Counted up to a limit: a page of
// tens of thousands of elements has said what it is long before the end.
var __cvNotElements = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1, BASE: 1, TITLE: 1, BR: 1, WBR: 1 };
function __cvTraced() {
  var source = 0, script = 0, area = 0, vw = window.innerWidth || 1, vh = __cv.devH || window.innerHeight || 1;
  var all = document.body ? document.body.getElementsByTagName('*') : [];
  for (var i = 0; i < all.length && i < 6000; i++) {
    var el = all[i];
    if (__cvNotElements[el.tagName] || !el.getClientRects().length) continue;
    if (el.closest('[data-osw-overlay],[data-osw-toolbar]')) continue;
    if (el.hasAttribute('data-osw-src')) source++; else script++;
    if (el.tagName === 'CANVAS') {
      var r = el.getBoundingClientRect();
      var w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom + window.scrollY, vh) - Math.max(r.top + window.scrollY, 0);
      if (w > 0 && h > 0) area += w * h;
    }
  }
  return { source: source, script: script, drawn: Math.min(1, area / (vw * vh)) };
}
// What the handles on a selection need: its padding, how its parent lays it out, and the gap between
// its first two children when it lays them out itself.
function __cvMetrics(el) {
  var cs = getComputedStyle(el), px = function (v) { return Math.round(parseFloat(v) || 0); };
  var pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
  var m = { pt: px(cs.paddingTop), pr: px(cs.paddingRight), pb: px(cs.paddingBottom), pl: px(cs.paddingLeft),
    rowGap: px(cs.rowGap), columnGap: px(cs.columnGap), parentRow: !!pcs && pcs.display.indexOf('flex') !== -1 && pcs.flexDirection.indexOf('row') === 0,
    gap: null, tag: el.tagName.toLowerCase() };
  if (cs.display.indexOf('flex') !== -1 || cs.display.indexOf('grid') !== -1) {
    var kids = [];
    for (var i = 0; i < el.children.length && kids.length < 2; i++) if (__cvSourced(el.children[i]) && el.children[i].getClientRects().length) kids.push(el.children[i]);
    if (kids.length === 2) {
      var a = __cvRect(kids[0]), b = __cvRect(kids[1]);
      if (b.x >= a.x + a.w - 1 && Math.abs(b.y - a.y) < a.h) m.gap = { x: a.x + a.w, y: Math.min(a.y, b.y), w: b.x - a.x - a.w, h: Math.max(a.h, b.h), across: true };
      else if (b.y >= a.y + a.h - 1) m.gap = { x: Math.min(a.x, b.x), y: a.y + a.h, w: Math.max(a.w, b.w), h: b.y - a.y - a.h, across: false };
    }
  }
  return m;
}
function __cvReport(force) {
  var rects = [], metrics = null;
  for (var i = 0; i < __cv.watched.length; i++) {
    var el = __cvFind(__cv.watched[i]);
    rects.push(el ? __cvRect(el) : null);
    if (i === 0 && el && __cv.watched[i].nodeId) metrics = __cvMetrics(el);
  }
  var h = __cvHeight(), key = JSON.stringify(rects) + '|' + JSON.stringify(metrics) + '|' + h;
  if (!force && key === __cv.last) return;
  __cv.last = key;
  if (Math.abs(h - __cv.h) > 1) { __cv.h = h; __cvPost({ type: 'canvas:height', height: h }); }
  __cvPost({ type: 'canvas:rects', rects: rects, metrics: metrics });
}
// ---------- the dropper ----------
var __cvContainers = ['section', 'div', 'article', 'header', 'nav', 'main', 'footer', 'aside', 'ul', 'ol', 'form', 'figure'];
function __cvAxis(p) { var cs = getComputedStyle(p); if (cs.display.indexOf('flex') !== -1) return cs.flexDirection.indexOf('row') === 0 ? 'x' : 'y'; if (cs.display.indexOf('grid') !== -1) return cs.gridTemplateColumns.split(' ').length > 1 ? 'x' : 'y'; return 'y'; }
function __cvKids(p) { var out = []; for (var i = 0; i < p.children.length; i++) if (__cvSourced(p.children[i])) out.push(p.children[i]); return out; }
function __cvFileOf(el) { var v = el.getAttribute('data-osw-src'), cut = v ? v.lastIndexOf(':') : -1; return cut > 0 ? v.slice(0, cut) : null; }
function __cvLabel(el) { var cls = (el.getAttribute('class') || '').trim().split(' ').filter(Boolean).slice(0, 2); return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''); }
// Where a new element would go under the point: the parent, the place in source terms, and the line to
// draw. A place between two elements of other files (a partial's) has no name in this page's source.
function __cvDropAt(x, y) {
  var t = document.elementFromPoint(x - window.scrollX, y - window.scrollY);
  while (t && t !== document.body && t !== document.documentElement && !__cvSourced(t)) t = t.parentElement;
  if (!t) return null;
  var parent, idx, kids;
  if (t === document.body || t === document.documentElement) {
    kids = __cvKids(document.body);
    if (!kids.length) return null;
    parent = null;
    idx = kids.length;
    for (var i = 0; i < kids.length; i++) { var r0 = kids[i].getBoundingClientRect(); if (y - window.scrollY < r0.top + r0.height / 2) { idx = i; break; } }
  } else {
    var r = t.getBoundingClientRect(), lx = x - window.scrollX, ly = y - window.scrollY, inset = Math.min(r.width, r.height) * 0.2;
    var inner = lx > r.left + inset && lx < r.right - inset && ly > r.top + inset && ly < r.bottom - inset;
    if (__cvContainers.indexOf(t.tagName.toLowerCase()) !== -1 && (inner || !__cvKids(t).length)) {
      parent = t;
      kids = __cvKids(t);
      var ax = __cvAxis(t);
      idx = kids.length;
      for (var j = 0; j < kids.length; j++) { var rk = kids[j].getBoundingClientRect(); if (ax === 'x' ? lx < rk.left + rk.width / 2 : ly < rk.top + rk.height / 2) { idx = j; break; } }
    } else {
      parent = __cvSourcedParent(t);
      kids = parent ? __cvKids(parent) : __cvKids(document.body);
      var axis = parent ? __cvAxis(parent) : 'y';
      var before = axis === 'x' ? lx < r.left + r.width / 2 : ly < r.top + r.height / 2;
      idx = kids.indexOf(t) + (before ? 0 : 1);
    }
  }
  var file = parent ? __cvFileOf(parent) : (kids[0] ? __cvFileOf(kids[0]) : null);
  var next = kids[idx] || null, prev = idx > 0 ? kids[idx - 1] : null, place = null;
  if (next && __cvFileOf(next) === file) place = { before: next.getAttribute('data-osw-src') };
  else if (prev && __cvFileOf(prev) === file) place = { after: prev.getAttribute('data-osw-src') };
  else if (parent && idx === kids.length) place = { parent: parent.getAttribute('data-osw-src'), at: 'end' };
  else if (parent && idx === 0) place = { parent: parent.getAttribute('data-osw-src'), at: 'start' };
  var box = parent ? __cvRect(parent) : __cvRect(document.body), T = 3, line;
  var dir = parent ? __cvAxis(parent) : 'y';
  if (!kids.length) {
    var pcs = getComputedStyle(parent);
    line = { x: box.x + (parseFloat(pcs.paddingLeft) || 0), y: box.y + (parseFloat(pcs.paddingTop) || 0), w: Math.max(20, box.w - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0)), h: T };
  } else if (next) {
    var k = __cvRect(next);
    line = dir === 'x' ? { x: k.x - T * 1.5, y: k.y, w: T, h: k.h } : { x: k.x, y: k.y - T * 1.5, w: k.w, h: T };
  } else {
    var l = __cvRect(prev);
    line = dir === 'x' ? { x: l.x + l.w + T / 2, y: l.y, w: T, h: l.h } : { x: l.x, y: l.y + l.h + T / 2, w: l.w, h: T };
  }
  var owner = parent || document.body, src = parent ? parent.getAttribute('data-osw-src') : null, count = 0;
  if (src) { var same = document.querySelectorAll('[data-osw-src]'); for (var q = 0; q < same.length; q++) if (same[q].getAttribute('data-osw-src') === src) count++; }
  return { place: place, line: line, box: box, locked: !!(owner.closest && owner.closest('[data-osw-lock]')), parentName: parent ? __cvLabel(parent) : 'body', instances: count || 1 };
}
// ---------- text typed in place ----------
function __cvEditText(nodeId) {
  var el = __oswResolveNode(nodeId);
  if (!el || el.children.length) { __cvPost({ type: 'canvas:text-done', nodeId: nodeId, cancelled: true }); return; }
  var before = el.textContent, done = false;
  el.setAttribute('contenteditable', 'true');
  el.focus();
  var range = document.createRange(); range.selectNodeContents(el);
  var sel = window.getSelection ? window.getSelection() : null; if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  function finish(commit) {
    if (done) return;
    done = true;
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('keydown', onKey, true);
    el.removeAttribute('contenteditable');
    var after = el.textContent;
    if (!commit) el.textContent = before;
    __cvPost({ type: 'canvas:text-done', nodeId: nodeId, text: after, changed: commit && after !== before && after.trim() !== '', cancelled: !commit });
  }
  function onBlur() { finish(true); }
  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); el.blur(); }
  }
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onKey, true);
}
var __cvTimer = 0;
function __cvSoon() { if (__cvTimer) return; __cvTimer = setTimeout(function () { __cvTimer = 0; __cvReport(false); }, 60); }
// On an artboard the whole page is the viewport, so position: fixed would put a bottom bar at the
// foot of the page. Each fixed element stays where it is on the first screen.
function __cvPinFixed() {
  var els = document.querySelectorAll('body *');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.hasAttribute('data-osw-overlay')) continue;
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed') continue;
    var r = el.getBoundingClientRect();
    var top = cs.top === 'auto' && cs.bottom !== 'auto' ? __cv.devH - (window.innerHeight - r.top) : r.top;
    var set = [['position', 'absolute'], ['top', Math.round(top) + 'px'], ['left', Math.round(r.left) + 'px'], ['right', 'auto'], ['bottom', 'auto'], ['width', Math.round(r.width) + 'px']];
    for (var j = 0; j < set.length; j++) el.style.setProperty(set[j][0], set[j][1], 'important');
  }
}
// ---------- what was typed into the page's fields ----------
var __cvFieldSel = 'input, textarea, select', __cvNotKept = /^(password|file|hidden|submit|button|reset|image)$/i;
function __cvReadFields() {
  var all = document.querySelectorAll(__cvFieldSel), list = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.tagName === 'INPUT' && __cvNotKept.test(el.type)) continue;
    var f = { k: el.getAttribute('data-osw-src') + '#' + __cvIndexOf(el), i: i };
    if (el.tagName === 'SELECT') {
      var sel = [], changed = false;
      for (var j = 0; j < el.options.length; j++) { sel.push(el.options[j].selected); if (el.options[j].selected !== el.options[j].defaultSelected) changed = true; }
      if (changed) { f.sel = sel; list.push(f); }
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) { f.checked = el.checked; list.push(f); }
    } else if (el.value !== el.defaultValue) { f.value = el.value; list.push(f); }
  }
  return list.length ? { count: all.length, list: list } : null;
}
// By element where the field came from a source file, else by position when the page has as many fields as it had.
function __cvFieldAt(root, f, all, same) {
  var hash = f.k.lastIndexOf('#'), src = f.k.slice(0, hash), idx = parseInt(f.k.slice(hash + 1), 10);
  if (src !== 'null') {
    var n = 0, sourced = root.querySelectorAll('[data-osw-src]');
    for (var i = 0; i < sourced.length; i++) { if (sourced[i].getAttribute('data-osw-src') !== src) continue; if (n === idx) return sourced[i]; n++; }
  }
  return same ? all[f.i] || null : null;
}
function __cvFieldsToMarkup(root, kept) {
  if (!kept) return;
  var all = root.querySelectorAll(__cvFieldSel), same = all.length === kept.count;
  for (var i = 0; i < kept.list.length; i++) {
    var f = kept.list[i], el = __cvFieldAt(root, f, all, same);
    if (!el) continue;
    if (f.sel) { for (var j = 0; j < el.options.length; j++) { if (f.sel[j]) el.options[j].setAttribute('selected', ''); else el.options[j].removeAttribute('selected'); } }
    else if ('checked' in f) { if (f.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked'); }
    else if (el.tagName === 'TEXTAREA') el.textContent = f.value;
    else el.setAttribute('value', f.value);
  }
}
function __cvRestoreFields(kept) {
  if (!kept) return 0;
  var all = document.querySelectorAll(__cvFieldSel), same = all.length === kept.count, n = 0;
  for (var i = 0; i < kept.list.length; i++) {
    var f = kept.list[i], el = __cvFieldAt(document, f, all, same);
    if (!el) continue;
    if (f.sel) { for (var j = 0; j < el.options.length; j++) el.options[j].selected = !!f.sel[j]; }
    else if ('checked' in f) el.checked = f.checked;
    else el.value = f.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    n++;
  }
  return n;
}
// A copy of the page as it is: no scripts and none of the preview's furniture, typed values written in,
// and the frame's own file URLs back as the host's, which outlive this frame.
function __cvSnapshot() {
  var kept = __cvReadFields(), clone = document.documentElement.cloneNode(true);
  var drop = clone.querySelectorAll('script,[data-osw-overlay],[data-osw-toolbar],style[data-osw-canvas],link[rel="modulepreload"]');
  for (var i = 0; i < drop.length; i++) drop[i].remove();
  __cvFieldsToMarkup(clone, kept);
  var html = '<!doctype html>\\n' + __oswStripNodeId(clone.outerHTML), urls = window.__oswShellUrls || {};
  for (var host in urls) if (urls[host]) html = html.split(urls[host]).join(host);
  return { html: html, fields: kept };
}
// The page's load event, or a while after its DOM is in, whichever comes first: a font or script from
// the network can hold the load event back for as long as the network takes.
function __cvWhenLoaded(cap, done) {
  var fired = false;
  function go() { if (!fired) { fired = true; done(); } }
  if (document.readyState === 'complete') { go(); return; }
  window.addEventListener('load', go);
  function arm() { setTimeout(go, cap); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm); else arm();
}
function __cvQuiet(idle, max, done) {
  var last = Date.now(), start = last, mo = new MutationObserver(function () { last = Date.now(); });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  (function tick() { var now = Date.now(); if (now - last >= idle || now - start >= max) { mo.disconnect(); done(); } else setTimeout(tick, 40); })();
}
// What the agent's inspect command reads: the target (or the body) and its children to a depth, and
// for a target, each asked property's computed value and the rule that sets it.
function __cvInspectFind(t) {
  var all, list = [], i;
  if (!t) return { list: [document.body] };
  if (t.charAt(0) === '@') {
    all = document.querySelectorAll('[data-osw-id]');
    for (i = 0; i < all.length; i++) if (all[i].getAttribute('data-osw-id') === t.slice(1)) list.push(all[i]);
  } else if (t.charAt(0) === '/') {
    list = __oswWithSrc(t);
  } else {
    try { list = Array.prototype.slice.call(document.querySelectorAll(t)); } catch (err) { return { error: 'bad-selector' }; }
  }
  return { list: list };
}
function __cvInspectText(el) {
  if (el.children.length || el.tagName === 'IMG') return '';
  var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 79) + '\u2026' : t;
}
function __cvInspectNode(el, depth) {
  var r = el.getBoundingClientRect(), cls = (el.getAttribute('class') || '').trim(), kids = [], more = 0;
  var node = { tag: el.tagName.toLowerCase(), classes: cls ? cls.split(/\\s+/).slice(0, 4) : [], src: el.getAttribute('data-osw-src'), marker: el.getAttribute('data-osw-id'),
    box: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) } };
  if (el.id) node.id = el.id;
  if (getComputedStyle(el).display === 'none' || !el.getClientRects().length) node.hidden = true;
  var text = __cvInspectText(el);
  if (text) node.text = text;
  for (var i = 0; i < el.children.length; i++) {
    var c = el.children[i];
    if (!__oswTreeRow(c)) continue;
    if (depth > 0 && kids.length < 40) kids.push(__cvInspectNode(c, depth - 1)); else more++;
  }
  if (kids.length) node.children = kids;
  if (more) node.more = more;
  return node;
}
// A computed value with the preview's blob URLs back as the project's paths: url("/assets/hero.jpg").
function __cvPaths(value) {
  if (typeof value !== 'string' || value.indexOf('blob:') === -1) return value;
  var files = window.__oswVfsBlobUrls || {}, shell = window.__oswShellUrls || {}, byUrl = {};
  for (var path in files) { var host = files[path]; byUrl[host] = path; if (shell[host]) byUrl[shell[host]] = path; }
  return value.replace(/blob:[^"')\\s]+/g, function (url) { return byUrl[url] || url; });
}
function __cvInspect(d) {
  var found = __cvInspectFind(d.target || null);
  var out = { page: __oswPageFile, width: window.innerWidth, height: __cv.devH, pageHeight: __cvHeight(), node: null };
  if (found.error) { out.error = found.error; return out; }
  if (d.target) out.matches = found.list.length;
  var el = found.list[0] || null;
  if (!el) return out;
  out.node = __cvInspectNode(el, Math.max(0, Math.min(6, d.depth | 0)));
  if (d.target && Array.isArray(d.props)) {
    var ours = __oswSelectorFor(el.getAttribute('data-osw-id')), cs = getComputedStyle(el), styles = [];
    for (var k = 0; k < d.props.length; k++) {
      var best = __oswRankDeclaration(el, d.props[k], ours), row = { property: d.props[k], computed: __cvPaths(cs.getPropertyValue(d.props[k])) };
      if (best) {
        row.declared = { value: String(best.value || ''), selector: best.selector || '', origin: best.origin };
        if (best.media) row.declared.media = best.media;
        if (best.ours) row.declared.ours = true;
      }
      styles.push(row);
    }
    out.styles = styles;
  }
  return out;
}
window.addEventListener('message', function (e) {
  if (e.source !== window.parent) return;
  var d = e.data;
  if (!d || typeof d.type !== 'string' || d.type.indexOf('canvas:') !== 0) return;
  if (d.type === 'canvas:pick') { var chain = __cvChain(d.x, d.y), items = []; for (var i = 0; i < chain.length; i++) items.push(__cvItem(chain[i])); __cvPost({ type: 'canvas:picked', reqId: d.reqId, chain: items }); }
  else if (d.type === 'canvas:describe') { var one = __cvFind(d.childOf ? { childOf: d.childOf } : d.nodeId ? { nodeId: d.nodeId } : { src: d.src, index: d.index }); __cvPost({ type: 'canvas:described', reqId: d.reqId, item: one ? __cvItem(one) : null }); }
  else if (d.type === 'canvas:watch') { __cv.watched = Array.isArray(d.targets) ? d.targets : []; __cvReport(true); }
  else if (d.type === 'canvas:drop-at') { __cvPost({ type: 'canvas:dropped', reqId: d.reqId, drop: __cvDropAt(d.x, d.y) }); }
  else if (d.type === 'canvas:edit-text') __cvEditText(d.nodeId);
  else if (d.type === 'canvas:inspect') { var report; try { report = __cvInspect(d); } catch (err) { report = { error: String(err && err.message || err) }; } __cvPost({ type: 'canvas:inspected', reqId: d.reqId, report: report }); }
  else if (d.type === 'canvas:pace') { if (window.__oswPace) window.__oswPace(!!d.paused); }
  else if (d.type === 'canvas:interact') __cv.interactive = !!d.on;
  else if (d.type === 'canvas:freeze') { var snap = __cvSnapshot(); __cvPost({ type: 'canvas:frozen', reqId: d.reqId, html: snap.html, fields: snap.fields, height: __cvHeight() }); }
  else if (d.type === 'canvas:fields') {
    // Again a moment later for fields the page's scripts build after load.
    if (d.kept && __cvRestoreFields(d.kept) < d.kept.list.length) setTimeout(function () { __cvRestoreFields(d.kept); }, 600);
  }
});
new MutationObserver(__cvSoon).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
if (window.ResizeObserver) new ResizeObserver(__cvSoon).observe(document.documentElement);
document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
document.addEventListener('wheel', function (e) {
  if (!__cv.interactive) return;
  e.preventDefault();
  __cvPost({ type: 'canvas:wheel', dx: e.deltaX, dy: e.deltaY, deltaMode: e.deltaMode, zoom: e.ctrlKey || e.metaKey, x: e.clientX, y: e.clientY });
}, { passive: false });
// While the page has the keyboard, V still goes back to Canvas's Select tool, unless it is being typed.
document.addEventListener('keydown', function (e) {
  if (!__cv.interactive || e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'v' && e.key !== 'V')) return;
  var t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  __cvPost({ type: 'canvas:key', key: e.key });
}, true);
var __cvAwakeAt = 0;
document.addEventListener('pointermove', function () { var now = Date.now(); if (now - __cvAwakeAt < 250) return; __cvAwakeAt = now; __cvPost({ type: 'canvas:awake' }); }, { passive: true });
__cvWhenLoaded(__cv.mode === 'settle' ? 3000 : 800, function () {
  if (__cv.mode === 'settle') {
    var finish = function () {
      __cvQuiet(200, 1200, function () {
        try { document.getAnimations().forEach(function (a) { try { if (isFinite(a.effect.getComputedTiming().endTime)) a.finish(); } catch (err) {} }); } catch (err) {}
        __cvPinFixed();
        var snap = __cvSnapshot();
        __cvPost({ type: 'canvas:settled', loadId: __cv.loadId, html: snap.html, height: __cvHeight(), traced: __cvTraced() });
      });
    };
    // Fonts from the network can keep fonts.ready waiting as long as the network takes.
    var once = false, go = function () { if (!once) { once = true; finish(); } };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go);
    setTimeout(go, 1000);
    return;
  }
  if (__cv.mode === 'live') __cvPinFixed();
  __cv.h = __cvHeight();
  __cvPost({ type: 'canvas:ready', height: __cv.h });
  // A page on screen is never settled, so it says what it is made of itself: once its scripts have
  // had a moment to build what they build.
  if (__cv.mode === 'live') setTimeout(function () { __cvPost({ type: 'canvas:traced', traced: __cvTraced() }); }, 1500);
});
`;
}
