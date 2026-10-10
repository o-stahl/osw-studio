import type { TreeNode } from './types';

/**
 * One expanded level of the Elements tree, as the serializer returns it.
 *
 * A bare array cannot carry `truncated`, and the panel has to be able to say how many siblings it is
 * not showing rather than silently rendering a short list.
 */
export interface SerializedLevel {
  nodes: TreeNode[];
  truncated: number;
}

/**
 * The Elements tree serializer, as JavaScript source for injection into the preview iframe.
 *
 * The host cannot read the frame's `contentDocument`, so the tree has to be built inside the frame
 * and posted up. That means this cannot be an imported module — it is interpolated into the script
 * template literals in `components/preview/multipage-preview.tsx`. It is authored here, as a
 * constant, for the reason `STRIP_PROVENANCE_JS` and `STRIP_NODE_ID_JS` are: the emitted text is the
 * only thing that runs, and the tests can execute *this* string.
 *
 * **No regex literals.** Anything hand-written inside those template literals loses one level of
 * escaping before it is emitted — `\s` becomes a literal `s`, a live bug at
 * `multipage-preview.tsx:370`. An interpolated constant is inserted verbatim and would be safe, but
 * this file avoids regexes entirely so the hazard cannot be reintroduced by the next edit: source
 * values are split with `lastIndexOf`/`slice` and compared as strings.
 *
 * ## Addressing
 *
 * Nodes are stamped `data-osw-node="<n>"` as they are serialized and resolved later with
 * `document.querySelector('[data-osw-node="17"]')`. Deliberately **not** a `Map` from id to element:
 * a map never releases a removed element, so a stale id resolves to a *detached* node —
 * `positionOverlay` then draws a 1x1 overlay at (0,0) and `buildDomPath` walks to a non-document
 * root, producing a path that resolves to nothing or to a different element. `querySelector`
 * returns `null`, which is the stale signal the panel wants.
 *
 * An element that is already stamped keeps its id. Re-expanding a level the panel has collapsed must
 * not strand an id the host is still holding for an element that never changed.
 *
 * ## What is in the tree
 *
 * Only elements carrying `data-osw-src`. `injectProvenance` tags every authored element and never
 * tags `script` or `style`, so this one rule excludes the selector overlay, the placement indicator
 * and its placeholders, the two scripts before `</body>`, and the head-injected bridge and blob-map
 * scripts — without the serializer having to recognise each piece of furniture individually.
 *
 * The tradeoff, stated rather than hidden: legitimately JS-built elements are absent from the tree
 * too. They have no source to annotate and no source to edit, so a row for them would be a row the
 * rest of the feature cannot act on. Bundled runtimes (react, preact, svelte, vue) emit no
 * provenance at all, so their tree is empty; that is the panel's business to report.
 *
 * ## Cost
 *
 * The shared-source counts come from a single `querySelectorAll('[data-osw-src]')` per call, reused
 * for every node in the level. Counting per node — as `buildSelectionPayload` does for its one
 * element — would be up to 200 full-document queries per expansion, on the main thread, inside the
 * frame the user is looking at.
 *
 * Emits `{ nodes, truncated }` matching {@link SerializedLevel}; each node matches {@link TreeNode}.
 */
export const SERIALIZE_TREE_JS = `
var __oswNodeSeq = 0;
// A level wider than this is a data table or a generated list; past a couple of hundred rows the
// tree stops being navigable and the post to the host stops being cheap. The overflow is reported,
// not dropped silently.
var __oswMaxLevelNodes = 200;

function __oswNodeId(el) {
  var existing = el.getAttribute('data-osw-node');
  if (existing) return existing;
  __oswNodeSeq++;
  var id = String(__oswNodeSeq);
  el.setAttribute('data-osw-node', id);
  return id;
}

// The same skip rule as the level walk, so a caret never opens an empty level.
function __oswHasTreeChildren(el) {
  var kids = el.children;
  for (var i = 0; i < kids.length; i++) {
    if (kids[i].getAttribute('data-osw-src') !== null) return true;
  }
  return false;
}

function __oswSourceCounts(doc) {
  var counts = new Map();
  var all = doc.querySelectorAll('[data-osw-src]');
  for (var i = 0; i < all.length; i++) {
    var v = all[i].getAttribute('data-osw-src');
    if (v === null) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

function __oswSerializeLevel(root) {
  var nodes = [];
  var truncated = 0;
  if (!root || !root.children) return { nodes: nodes, truncated: truncated };
  var counts = __oswSourceCounts(root.ownerDocument || document);
  var kids = root.children;
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    var src = el.getAttribute('data-osw-src');
    if (src === null) continue;
    if (nodes.length >= __oswMaxLevelNodes) { truncated++; continue; }
    var node = {
      id: __oswNodeId(el),
      tag: el.tagName.toLowerCase(),
      instances: counts.get(src) || 1,
      hasChildren: __oswHasTreeChildren(el)
    };
    var cls = el.getAttribute('class');
    if (cls) {
      cls = cls.trim();
      if (cls) node.className = cls;
    }
    // Split on the LAST colon: the path part may contain one, so indexOf would cut a path in half.
    var cut = src.lastIndexOf(':');
    if (cut > 0) {
      node.file = src.slice(0, cut);
      var line = parseInt(src.slice(cut + 1), 10);
      if (isFinite(line)) node.line = line;
    } else {
      node.file = src;
    }
    nodes.push(node);
  }
  return { nodes: nodes, truncated: truncated };
}
`;
