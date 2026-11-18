/**
 * A structural edit, shown in a frame before the recompile replaces it.
 *
 * The host wrote the page and knows how every old offset of the file maps to a new one
 * (`StructurePatch` from `lib/direct-edit/apply-structure.ts`). The frame makes the same change to
 * its DOM and rewrites the file's `data-osw-src` values to match, so a click, the Elements tree and
 * the next edit all name the elements as the file now has them. Live Preview and Canvas frames run
 * the same code; elements from other files are left alone.
 *
 * Interpolated into `generateNavigationScript`'s template literal like `STYLE_PREVIEW_JS`, so it
 * may not contain a backtick, a regex literal or a `${`. It reads `__oswMarkerAttr` and
 * `__oswWithSrc` from that constant, which is emitted before it.
 */

import { UNTAGGED_TAGS } from './provenance';

export const STRUCTURE_PATCH_JS = `
var __oswUntaggedTags = ${JSON.stringify(UNTAGGED_TAGS)};

function __oswSrcOf(el) {
  var v = el && el.getAttribute ? el.getAttribute('data-osw-src') : null;
  if (!v) return null;
  var cut = v.lastIndexOf(':');
  if (cut <= 0) return null;
  var at = Number(v.slice(cut + 1));
  return isFinite(at) ? { file: v.slice(0, cut), at: at } : null;
}

/** The first element whose provenance value is exactly this. */
function __oswFindSrc(src) {
  return __oswWithSrc(src)[0] || null;
}

function __oswMapOffset(pieces, old) {
  var at = 0;
  for (var i = 0; i < pieces.length; i++) {
    var p = pieces[i];
    if (typeof p === 'number') { at += p; continue; }
    if (old >= p[0] && old < p[1]) return at + old - p[0];
    at += p[1] - p[0];
  }
  return null;
}

/** Where a place puts an element: its parent node and the node it goes before. */
function __oswPatchPlace(place) {
  if (!place) return null;
  var ref;
  if (typeof place.before === 'string') {
    ref = __oswFindSrc(place.before);
    return ref && ref.parentNode ? { parent: ref.parentNode, before: ref } : null;
  }
  if (typeof place.after === 'string') {
    ref = __oswFindSrc(place.after);
    return ref && ref.parentNode ? { parent: ref.parentNode, before: ref.nextSibling } : null;
  }
  if (typeof place.parent === 'string') {
    ref = __oswFindSrc(place.parent);
    return ref ? { parent: ref, before: place.at === 'start' ? ref.firstChild : null } : null;
  }
  return null;
}

function __oswParseOne(html) {
  if (typeof html !== 'string') return null;
  var t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild;
}

/** The element and its descendants, in document order, that pass the test. */
function __oswWalk(root, test) {
  var out = [];
  var visit = function (el) {
    if (test(el)) out.push(el);
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) visit(c);
  };
  visit(root);
  return out;
}

function __oswStructurePatch(d) {
  if (!d || typeof d.file !== 'string' || !Array.isArray(d.pieces) || !d.op || !Array.isArray(d.created)) return false;
  var op = d.op;
  var file = d.file;
  var target = __oswFindSrc(op.target);
  // The file's elements as they are named now, read before anything moves.
  var known = [];
  var all = document.querySelectorAll('[data-osw-src]');
  for (var i = 0; i < all.length; i++) {
    var s = __oswSrcOf(all[i]);
    if (s && s.file === file) known.push({ el: all[i], at: s.at });
  }
  var made = [];
  var to;
  if (op.kind === 'move') {
    to = __oswPatchPlace(op.place);
    if (!target || !to) return false;
    to.parent.insertBefore(target, to.before === target ? target.nextSibling : to.before);
  } else if (op.kind === 'delete') {
    if (!target || !target.parentNode) return false;
    target.parentNode.removeChild(target);
  } else if (op.kind === 'wrap') {
    var wrapper = __oswParseOne(op.html);
    if (!target || !target.parentNode || !wrapper) return false;
    target.parentNode.insertBefore(wrapper, target);
    wrapper.appendChild(target);
    made = [wrapper];
  } else if (op.kind === 'unwrap') {
    if (!target || !target.parentNode) return false;
    while (target.firstChild) target.parentNode.insertBefore(target.firstChild, target);
    target.parentNode.removeChild(target);
  } else if (op.kind === 'duplicate') {
    if (!target || !target.parentNode) return false;
    var copy = target.cloneNode(true);
    var ids = op.ids || {};
    __oswWalk(copy, function () { return true; }).forEach(function (el) {
      var id = el.getAttribute(__oswMarkerAttr);
      if (id && Object.prototype.hasOwnProperty.call(ids, id)) el.setAttribute(__oswMarkerAttr, ids[id]);
      // Node ids name one element each; the copy's are made when the tree reads it.
      el.removeAttribute('data-osw-node');
    });
    made = __oswWalk(copy, function (el) { var c = __oswSrcOf(el); return !!c && c.file === file; });
    // The copy's elements take the copy's tags in order, which holds only one for one: a loop or a
    // condition inside it renders a tag some other number of times, and the recompile names those.
    if (made.length !== d.created.length) return false;
    target.parentNode.insertBefore(copy, target.nextSibling);
  } else if (op.kind === 'insert') {
    to = __oswPatchPlace(op.place);
    var el = __oswParseOne(op.html);
    if (!to || !el) return false;
    to.parent.insertBefore(el, to.before);
    made = __oswWalk(el, function (n) { return __oswUntaggedTags.indexOf(n.tagName.toLowerCase()) === -1; });
  } else {
    return false;
  }
  for (var k = 0; k < known.length; k++) {
    if (!known[k].el.isConnected) continue;
    var next = __oswMapOffset(d.pieces, known[k].at);
    if (next !== null) known[k].el.setAttribute('data-osw-src', file + ':' + next);
  }
  for (var m = 0; m < made.length && m < d.created.length; m++) {
    made[m].setAttribute('data-osw-src', file + ':' + d.created[m]);
  }
  return true;
}
`;
