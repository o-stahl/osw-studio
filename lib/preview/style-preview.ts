import { MARKER_SELECTOR_TEMPLATE } from '@/lib/direct-edit/overrides-css';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';

/** Style-reading scripts injected into the preview frame as source text. */

/**
 * Maps CSS shorthands to their longhands for `getComputedStyle` expansion.
 * Absent properties pass through untouched.
 */
export const SHORTHAND_LONGHANDS: Readonly<Record<string, readonly string[]>> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  gap: ['row-gap', 'column-gap'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
};

/**
 * Computed-value reader injected into the preview iframe.
 *
 * `__oswReadComputed(el, properties)` returns values keyed by expanded property names (null element
 * yields `{}`; missing values are `''`). `__oswRootFontSize()` returns the document's root font
 * size for rem conversion -- read from the frame because the host has no id for `<html>`.
 */
export const STYLE_QUERY_JS = `
var __oswLonghands = ${JSON.stringify(SHORTHAND_LONGHANDS)};

function __oswExpandProperties(properties) {
  var out = [];
  var seen = Object.create(null);
  // Array.isArray, not a length check: a bare string has a length and would be walked one
  // character at a time, so 'padding' would ask the engine about 'p', 'a', 'd'...
  if (!Array.isArray(properties)) return out;
  for (var i = 0; i < properties.length; i++) {
    var property = properties[i];
    if (typeof property !== 'string' || property === '') continue;
    var expanded = Object.prototype.hasOwnProperty.call(__oswLonghands, property)
      ? __oswLonghands[property]
      : [property];
    for (var j = 0; j < expanded.length; j++) {
      if (seen[expanded[j]]) continue;
      seen[expanded[j]] = true;
      out.push(expanded[j]);
    }
  }
  return out;
}

function __oswReadComputed(el, properties) {
  var values = {};
  if (!el) return values;
  var computed = window.getComputedStyle(el);
  var wanted = __oswExpandProperties(properties);
  for (var i = 0; i < wanted.length; i++) {
    var value = computed.getPropertyValue(wanted[i]);
    values[wanted[i]] = value == null ? '' : String(value);
  }
  return values;
}

function __oswRootFontSize() {
  var root = document.documentElement;
  if (!root) return '';
  var value = window.getComputedStyle(root).getPropertyValue('font-size');
  return value == null ? '' : String(value);
}
`;

/**
 * The attribute on the `<style>` that stands in for `/overrides.css` once the Inspector has written
 * it, and on the `<link>` to the file where a document builder marks it.
 *
 * One source: the frame source below interpolates it, the Canvas document builder writes it, and
 * anything that later has to exclude the element from what reaches the agent reads it from here.
 */
export const OVERRIDES_STYLE_ATTR = 'data-osw-overrides';

/** Shared selector template emitted once so multiple constants don't redeclare `__oswSelectorFor`. */
const SELECTOR_FOR_JS = `
var __oswSelectorTemplate = ${JSON.stringify(MARKER_SELECTOR_TEMPLATE)};

function __oswSafeMarkerId(markerId) {
  if (typeof markerId !== 'string' || markerId.length === 0) return false;
  for (var i = 0; i < markerId.length; i++) {
    var c = markerId.charAt(i);
    var ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
      || c === '-' || c === '_';
    if (!ok) return false;
  }
  return true;
}

function __oswSelectorFor(markerId) {
  if (!__oswSafeMarkerId(markerId)) return null;
  // split/join, not replace: a replacement pattern in the id has no meaning here either way, and
  // this needs no second argument to say so.
  return __oswSelectorTemplate.split('{id}').join(markerId);
}
`;

/**
 * Swaps a new `/overrides.css` into the frame, where the file's `<link>` was, so an Inspector write
 * shows without a recompile. The whole file, not one rule: width blocks keep their order, several
 * elements' edits stay, and a removed declaration is gone. The link is found by its mark, else by
 * the URL the page's file map gives `/overrides.css`; a page without one gets the style at the end
 * of its head, where the link would be. A recompile mints a new document with the file in it.
 */
export const STYLE_PREVIEW_JS = `${SELECTOR_FOR_JS}
var __oswOverridesAttr = ${JSON.stringify(OVERRIDES_STYLE_ATTR)};

function __oswOverridesStyle() {
  return document.querySelector('style[' + __oswOverridesAttr + ']');
}

function __oswOverridesLink() {
  var marked = document.querySelector('link[' + __oswOverridesAttr + ']');
  if (marked) return marked;
  var map = window.__oswVfsBlobUrls;
  var url = map && typeof map === 'object' ? map['/overrides.css'] : null;
  if (typeof url !== 'string' || url === '') return null;
  var links = document.querySelectorAll('link');
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute('href') === url) return links[i];
  }
  return null;
}

function __oswApplyOverrides(css) {
  if (typeof css !== 'string') return null;
  var el = __oswOverridesStyle();
  if (!el) {
    el = document.createElement('style');
    el.setAttribute(__oswOverridesAttr, '');
    var link = __oswOverridesLink();
    if (link && link.parentNode) {
      link.parentNode.insertBefore(el, link);
      link.parentNode.removeChild(link);
    } else {
      var head = document.head || document.documentElement;
      if (!head) return null;
      head.appendChild(el);
    }
  }
  if (el.textContent !== css) el.textContent = css;
  return el;
}

var __oswMarkerAttr = ${JSON.stringify(MARKER_ATTR)};

/** Elements this document marked itself, as against markers its source carries. */
var __oswProvisional = typeof WeakSet === 'function' ? new WeakSet() : null;

function __oswWithSrc(src) {
  var all = document.querySelectorAll('[data-osw-src]');
  var out = [];
  for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-osw-src') === src) out.push(all[i]);
  return out;
}

function __oswMarkElements(marks, unmarks) {
  // An element's first edit: the frame shows it at once on the marker the write is about to stamp
  // into source, on every element that source tag renders, as the stamp will. One already marked
  // keeps its own. A write that did not stamp takes its marker back, and only where this document
  // put it.
  if (Array.isArray(unmarks)) {
    for (var u = 0; u < unmarks.length; u++) {
      if (!__oswSafeMarkerId(unmarks[u])) continue;
      var held = document.querySelectorAll('[' + __oswMarkerAttr + '="' + unmarks[u] + '"]');
      for (var h = 0; h < held.length; h++) {
        if (__oswProvisional && __oswProvisional.has(held[h])) {
          held[h].removeAttribute(__oswMarkerAttr);
          __oswProvisional.delete(held[h]);
        }
      }
    }
  }
  if (!Array.isArray(marks)) return;
  for (var i = 0; i < marks.length; i++) {
    var mark = marks[i];
    if (!mark || typeof mark.src !== 'string' || !__oswSafeMarkerId(mark.markerId)) continue;
    var found = __oswWithSrc(mark.src);
    for (var j = 0; j < found.length; j++) {
      if (found[j].hasAttribute(__oswMarkerAttr)) continue;
      found[j].setAttribute(__oswMarkerAttr, mark.markerId);
      if (__oswProvisional) __oswProvisional.add(found[j]);
    }
  }
}
`;

/** Where the rule that carries a marker's override lives, and what to call the place. */
export interface OverrideRuleLocation {
  /**
   * The `<style>` or `<link>` the rule came from.
   *
   * The element and not just the sheet, because a `CSSStyleSheet` handle outlives its owning node:
   * the probe's gate is "our rule is *in the document*", and only the element answers that. Turning
   * a sheet back into its node is not an option either — `sheet.ownerNode` is `undefined` in jsdom,
   * measured, so that direction is unavailable exactly where the unit tests run.
   */
  element: Element;
  sheet: CSSStyleSheet;
  rule: CSSStyleRule;
  /** A VFS path where one is knowable, else `a stylesheet`. Never a blob id. */
  origin: string;
}

/**
 * Finds which CSS rule overrides the override (`__oswLocateOverrideRule`), ranks every declaration
 * that reaches the element (`__oswRankDeclaration`), and reads the winning declarations' values
 * (`__oswSpecifiedValues`).
 *
 * Requires {@link STYLE_PREVIEW_JS} in scope (uses `__oswSelectorFor`, `__oswOverridesStyle`,
 * `__oswMarkerAttr`).
 *
 * Known limits: only `@media` grouping rules are walked (and only while matching);
 * `:not()`/`:is()` arguments do not contribute to specificity; UA defaults are not walked.
 */
export const STYLE_LOCATOR_JS = `
function __oswNormalizeSelectorText(text) {
  if (typeof text !== 'string') return '';
  var out = '';
  var pendingSpace = false;
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    // Everything at or below the space code unit is whitespace or a control character. Written as
    // a comparison rather than a set of escapes, which a template literal would eat one level of.
    if (c <= ' ') {
      if (out !== '') pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += c;
  }
  return out;
}

// Whether a sheet's own media query, from its element's media attribute, holds in this frame now. No
// attribute is every medium.
function __oswSheetMediaApplies(element) {
  var text = element.getAttribute('media');
  if (text === null || text.trim() === '') return true;
  try { return window.matchMedia(text).matches; } catch (e) { return false; }
}

// The sheets in force: a disabled one, or one whose media does not match, sets nothing here.
function __oswStyleSheetEntries() {
  var out = [];
  var nodes = document.querySelectorAll('style, link');
  for (var i = 0; i < nodes.length; i++) {
    var sheet = null;
    try { sheet = nodes[i].sheet; } catch (e) { sheet = null; }
    if (!sheet || sheet.disabled || !__oswSheetMediaApplies(nodes[i])) continue;
    out.push({ element: nodes[i], sheet: sheet });
  }
  return out;
}

function __oswRulesOf(sheet) {
  // A cross-origin sheet throws on access. Nothing in the preview is cross-origin — a blob sheet
  // shares the parent's origin and srcdoc inherits it — but a user's own CDN <link> is not ours.
  try { return sheet.cssRules || []; } catch (e) { return []; }
}

function __oswResolveSheetOrigin(href, blobMap) {
  if (typeof href !== 'string' || href === '') return null;
  // The map is path -> blob URL, so naming the file means inverting it. Every preview stylesheet is
  // rewritten to a blob URL, which is why this is not optional: the raw href reads
  // 'blob:http://host/8c39ad3e-...', and a UUID in a message is the kind of message people learn
  // to ignore.
  if (blobMap && typeof blobMap === 'object') {
    for (var path in blobMap) {
      if (!Object.prototype.hasOwnProperty.call(blobMap, path)) continue;
      if (blobMap[path] === href) return path;
    }
  }
  // An unmapped blob URL names nothing a user has ever seen; a real URL does.
  if (href.indexOf('blob:') === 0) return null;
  return href;
}

function __oswSheetOrigin(entry) {
  // The Inspector's copy of the file, swapped in where its link was.
  if (entry.element === __oswOverridesStyle()) return '/overrides.css';
  var href = null;
  try { href = entry.sheet.href; } catch (e) { href = null; }
  var resolved = __oswResolveSheetOrigin(href, window.__oswVfsBlobUrls);
  return resolved === null ? 'a stylesheet' : resolved;
}

function __oswFindRuleIn(rules, selector) {
  var found = null;
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule) continue;
    if (typeof rule.selectorText !== 'string' || !rule.style) {
      // A width block of /overrides.css, or any other group: our rule in it is still ours.
      var nested = null;
      try { nested = rule.cssRules; } catch (e) { nested = null; }
      if (nested && nested.length > 0) {
        var inner = __oswFindRuleIn(nested, selector);
        if (inner) found = inner;
      }
      continue;
    }
    if (__oswNormalizeSelectorText(rule.selectorText) !== selector) continue;
    // The LAST match wins, here and in upsertDeclaration, for the same reason: duplicates of one
    // selector have equal specificity, so the later one is the one the user is looking at.
    found = rule;
  }
  return found;
}

function __oswFindRuleBySelector(sheet, selector) {
  return __oswFindRuleIn(__oswRulesOf(sheet), selector);
}

function __oswLocateOverrideRule(markerId) {
  var selector = __oswSelectorFor(markerId);
  if (selector === null) return null;
  var entries = __oswStyleSheetEntries();
  var best = null;
  for (var i = 0; i < entries.length; i++) {
    var rule = __oswFindRuleBySelector(entries[i].sheet, selector);
    if (!rule) continue;
    best = {
      element: entries[i].element,
      sheet: entries[i].sheet,
      rule: rule,
      origin: __oswSheetOrigin(entries[i])
    };
  }
  return best;
}

function __oswIsIdentStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c > '~';
}

function __oswSkipIdent(selector, i) {
  while (i < selector.length) {
    var c = selector.charAt(i);
    var ok = __oswIsIdentStart(c) || (c >= '0' && c <= '9') || c === '-';
    if (!ok) return i;
    i++;
  }
  return i;
}

function __oswSkipString(selector, i) {
  var quote = selector.charAt(i);
  i++;
  while (i < selector.length) {
    // 92 is the backslash. Spelled as a code unit because a literal one would need doubling twice
    // over to survive both this template literal and the one that emits it.
    if (selector.charCodeAt(i) === 92) { i += 2; continue; }
    if (selector.charAt(i) === quote) return i + 1;
    i++;
  }
  return i;
}

function __oswSkipTo(selector, i, close) {
  while (i < selector.length) {
    var c = selector.charAt(i);
    if (c === '"' || c === "'") { i = __oswSkipString(selector, i); continue; }
    if (c === close) return i + 1;
    i++;
  }
  return i;
}

function __oswSpecificity(selector) {
  var ids = 0;
  var classes = 0;
  var types = 0;
  var i = 0;
  while (i < selector.length) {
    var c = selector.charAt(i);
    if (c === '#') { ids++; i = __oswSkipIdent(selector, i + 1); continue; }
    if (c === '.') { classes++; i = __oswSkipIdent(selector, i + 1); continue; }
    if (c === '[') { classes++; i = __oswSkipTo(selector, i + 1, ']'); continue; }
    if (c === ':') {
      if (selector.charAt(i + 1) === ':') { types++; i = __oswSkipIdent(selector, i + 2); }
      else { classes++; i = __oswSkipIdent(selector, i + 1); }
      if (selector.charAt(i) === '(') i = __oswSkipTo(selector, i + 1, ')');
      continue;
    }
    if (__oswIsIdentStart(c)) { types++; i = __oswSkipIdent(selector, i); continue; }
    i++;
  }
  return ids * 10000 + classes * 100 + types;
}

// The selectors of a list, cut at its own commas: not at one inside parentheses, brackets, a quoted
// value or an escape.
function __oswSelectorParts(selector) {
  var parts = [];
  var start = 0;
  var depth = 0;
  var i = 0;
  while (i < selector.length) {
    var c = selector.charAt(i);
    if (selector.charCodeAt(i) === 92) { i += 2; continue; }
    if (c === '"' || c === "'") { i = __oswSkipString(selector, i); continue; }
    if (c === '[') { i = __oswSkipTo(selector, i + 1, ']'); continue; }
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (c === ',' && depth === 0) { parts.push(selector.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(selector.slice(start));
  return parts;
}

// A rule's specificity for one element: that of the most specific selector in its list that matches
// the element, as the cascade counts it. A list as a whole has no specificity of its own.
function __oswMatchedSpecificity(el, selector) {
  var parts = __oswSelectorParts(selector);
  var best = 0;
  for (var i = 0; i < parts.length; i++) {
    var hit = false;
    try { hit = el.matches(parts[i]); } catch (e) { hit = false; }
    if (!hit) continue;
    var specificity = __oswSpecificity(parts[i]);
    if (specificity > best) best = specificity;
  }
  return best;
}

function __oswBeats(candidate, best) {
  if (best === null) return true;
  if (candidate.important !== best.important) return candidate.important;
  if (candidate.specificity !== best.specificity) return candidate.specificity > best.specificity;
  return candidate.order >= best.order;
}


function __oswGroupApplies(rule) {
  // See the "known limits" note above: @media only, and only while it matches right now. Anything
  // else answers false and its rules are left out of the ranking.
  var text = null;
  try { text = rule.media ? rule.media.mediaText : null; } catch (e) { text = null; }
  if (typeof text !== 'string' || text === '') return false;
  try { return window.matchMedia(text).matches; } catch (e) { return false; }
}

// The shorthands that can set a longhand. A shorthand written with var() is kept whole until the
// value is computed, and the rule's style then answers '' for each of its longhands: without this
// the rule would not be seen to declare them, and the next rule down would be named as the winner.
function __oswShorthandsOf(property) {
  // By axis, in horizontal writing as the panel's side names assume: '-block' sets top and bottom,
  // '-inline' left and right.
  var m = /^(margin|padding)-(top|bottom|block-start|block-end|left|right|inline-start|inline-end)$/.exec(property);
  if (m) return [m[1], m[1] + (/^(top|bottom|block-)/.test(m[2]) ? '-block' : '-inline')];
  m = /^(margin|padding)-(block|inline)$/.exec(property);
  if (m) return [m[1]];
  if (/^border-.*-radius$/.test(property)) return ['border-radius'];
  m = /^border-(top|right|bottom|left)-(width|style|color)$/.exec(property);
  if (m) return ['border-' + m[2], 'border-' + m[1], 'border'];
  if (property === 'row-gap' || property === 'column-gap') return ['gap'];
  if (property === 'overflow-x' || property === 'overflow-y') return ['overflow'];
  if (/^background-/.test(property)) return ['background'];
  if (/^font-(size|weight|style|family)$/.test(property) || property === 'line-height') return ['font'];
  if (/^flex-(grow|shrink|basis)$/.test(property)) return ['flex'];
  if (/^flex-(direction|wrap)$/.test(property)) return ['flex-flow'];
  if (property === 'top' || property === 'right' || property === 'bottom' || property === 'left') return ['inset'];
  if (/^grid-template-(columns|rows)$/.test(property)) return ['grid-template', 'grid'];
  return [];
}

// What a rule's style declares for a property: its own value, or the var() shorthand that sets it.
function __oswDeclared(style, property) {
  var value = style.getPropertyValue(property);
  if (value !== '') return { value: value, name: property };
  var shorthands = __oswShorthandsOf(property);
  for (var i = 0; i < shorthands.length; i++) {
    var whole = style.getPropertyValue(shorthands[i]);
    if (whole !== '' && whole.indexOf('var(') !== -1) return { value: whole, name: shorthands[i] };
  }
  return null;
}

function __oswRankRules(el, property, ourSelector, rules, entry, state, media) {
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule) continue;
    if (typeof rule.selectorText !== 'string' || !rule.style) {
      // A grouping rule — @media, @supports, @layer. Its children are ordinary style rules and
      // belong in the ranking whenever the group is in force.
      var nested = null;
      try { nested = rule.cssRules; } catch (e) { nested = null; }
      if (nested && nested.length > 0 && __oswGroupApplies(rule)) {
        var groupMedia = null;
        try { groupMedia = rule.media ? rule.media.mediaText : null; } catch (e) { groupMedia = null; }
        __oswRankRules(el, property, ourSelector, nested, entry, state, groupMedia || media || null);
      }
      continue;
    }
    // Counted before the two filters, so order is document order over every style rule and does
    // not shift as rules stop declaring the property being asked about.
    state.order++;
    var declared = __oswDeclared(rule.style, property);
    if (!declared) continue;
    var matched = false;
    // An invalid or unsupported selector throws here rather than returning false.
    try { matched = el.matches(rule.selectorText); } catch (e) { matched = false; }
    if (!matched) continue;
    var candidate = {
      important: rule.style.getPropertyPriority(declared.name) === 'important',
      specificity: __oswMatchedSpecificity(el, rule.selectorText),
      order: state.order,
      // Resolved here rather than per sheet: inverting the blob map is a scan of its own, and
      // most sheets contribute no candidate at all.
      origin: __oswSheetOrigin(entry),
      value: declared.value,
      // For a reader: the inspect command names the rule that sets each value.
      selector: rule.selectorText,
      media: media || null,
      // Ours by selector, not by sheet: the same doubled marker selector is in the swapped-in
      // <style> before a recompile and in /overrides.css after one, and both are the override.
      // Nothing else writes that selector — it names one marker on one element — so a rule
      // carrying it is the override wherever it turns up, including a hand-edit of the file.
      ours: __oswNormalizeSelectorText(rule.selectorText) === ourSelector
    };
    if (__oswBeats(candidate, state.best)) state.best = candidate;
    if (!candidate.ours && __oswBeats(candidate, state.other)) state.other = candidate;
  }
}

function __oswRankDeclaration(el, property, ourSelector) {
  if (!el || typeof property !== 'string' || property === '') return null;
  var state = { order: 0, best: null, other: null };
  // The element's own style attribute, as a candidate rather than an early return: it outranks
  // every normal rule whatever their specificity, but an !important rule still outranks it.
  var inline = null;
  try { inline = el.style ? __oswDeclared(el.style, property) : null; } catch (e) { inline = null; }
  if (inline) {
    state.best = {
      important: el.style.getPropertyPriority(inline.name) === 'important',
      specificity: Infinity,
      order: -1,
      origin: 'inline style',
      value: inline.value,
      selector: '',
      media: null,
      ours: false
    };
    state.other = state.best;
  }
  var entries = __oswStyleSheetEntries();
  for (var i = 0; i < entries.length; i++) {
    __oswRankRules(el, property, ourSelector, __oswRulesOf(entries[i].sheet), entries[i], state);
  }
  if (state.best) state.best.under = state.other;
  return state.best;
}

// A logical side and its physical twin set the same value, and whichever declaration wins between
// them is what the element has: 'margin: 0 auto' declares 'margin-left', which the panel reads as
// 'margin-inline-start'. Horizontal writing, left to right, as the panel's side names assume.
var __oswSidesTwin = {
  'padding-block-start': 'padding-top', 'padding-block-end': 'padding-bottom',
  'padding-inline-start': 'padding-left', 'padding-inline-end': 'padding-right',
  'margin-block-start': 'margin-top', 'margin-block-end': 'margin-bottom',
  'margin-inline-start': 'margin-left', 'margin-inline-end': 'margin-right'
};

// The variable a property's winning declaration is, when it is one reference and nothing else
// ('var(--space-4)'): what the Styles tab shows beside the row, and offers to edit. A logical side is
// looked for under its physical name too, as most stylesheets write it. Nothing is said of a value
// the element inherits: only a rule that reaches the element itself counts.
function __oswVariablesOf(el, properties) {
  var out = {};
  if (!el || !Array.isArray(properties)) return out;
  for (var i = 0; i < properties.length; i++) {
    var property = properties[i];
    if (typeof property !== 'string' || property === '') continue;
    var best = __oswRankDeclaration(el, property, null);
    var twin = Object.prototype.hasOwnProperty.call(__oswSidesTwin, property) ? __oswSidesTwin[property] : null;
    if (twin) {
      var physical = __oswRankDeclaration(el, twin, null);
      if (physical && __oswBeats(physical, best)) best = physical;
    }
    // Doubled backslashes: this is a template literal, which would take single ones for itself.
    var m = best ? /^var\\(\\s*(--[A-Za-z0-9_-]+)\\s*(?:,[^)]*)?\\)$/.exec(String(best.value || '').trim()) : null;
    if (m) out[property] = m[1];
  }
  return out;
}

function __oswSpecifiedValues(el, properties) {
  // What the stylesheets say rather than what the engine computed: 'width: 100%' and
  // 'fit-content' both compute to pixels, and the Size controls need to tell them apart.
  var out = {};
  if (!el || !Array.isArray(properties)) return out;
  var ourSelector = __oswSelectorFor(el.getAttribute ? el.getAttribute(__oswMarkerAttr) : null);
  for (var i = 0; i < properties.length; i++) {
    var property = properties[i];
    if (typeof property !== 'string' || property === '') continue;
    var best = __oswRankDeclaration(el, property, ourSelector);
    var twin = Object.prototype.hasOwnProperty.call(__oswSidesTwin, property) ? __oswSidesTwin[property] : null;
    if (twin) {
      var physical = __oswRankDeclaration(el, twin, ourSelector);
      if (physical && __oswBeats(physical, best)) best = physical;
    }
    if (!best) { out[property] = null; continue; }
    var entry = { value: String(best.value || ''), origin: best.origin, ours: best.ours };
    // What would apply without the element's own override: what taking it off leaves behind.
    if (best.ours) entry.under = best.under ? { value: String(best.under.value || ''), origin: best.under.origin } : null;
    out[property] = entry;
  }
  return out;
}
`;

/**
 * Compares declared vs computed to detect overridden declarations: ranks every declaration of
 * the property that reaches the element and checks whether the cascade winner is ours.
 *
 * Requires {@link STYLE_QUERY_JS} (`__oswExpandProperties`) and {@link STYLE_LOCATOR_JS} in scope.
 */
export const STYLE_PROBE_JS = `
function __oswProbeStyleLoss(el, markerId, properties) {
  var wanted = el ? __oswExpandProperties(properties) : [];
  if (wanted.length === 0) return { lost: [], winner: null, written: [] };
  var located = __oswLocateOverrideRule(markerId);
  // Nothing of ours is in the document, so nothing of ours can have been beaten. Reporting every
  // requested property as lost here would light up the whole panel the first time a marker is
  // probed before its rule has been written.
  if (!located || !located.element || !located.element.parentNode) return { lost: [], winner: null, written: [] };

  var ourSelector = __oswSelectorFor(markerId);
  var lost = [];
  var winner = null;
  for (var i = 0; i < wanted.length; i++) {
    var best = __oswRankDeclaration(el, wanted[i], ourSelector);
    // best === null: nothing reachable declares this longhand — not even ours, which happens when
    // the engine does not expand the shorthand we wrote under the name we are asking about. There
    // is no verdict to give, and "lost" would be a guess dressed as a measurement.
    if (best === null || best.ours) continue;
    lost.push(wanted[i]);
    if (winner === null) winner = best.origin;
  }
  // The asked-about names themselves that lost somewhere: 'padding' when 'padding-top' did. A caller
  // that asked with the names a file declares gets back the declarations to act on.
  var written = [];
  for (var w = 0; w < properties.length && lost.length > 0; w++) {
    var names = __oswExpandProperties([properties[w]]);
    for (var n = 0; n < names.length; n++) {
      if (lost.indexOf(names[n]) !== -1) { written.push(properties[w]); break; }
    }
  }
  return { lost: lost, winner: winner, written: written };
}
`;
