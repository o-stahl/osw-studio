import { prependToHead, previewBridgeScript } from '@/lib/preview/preview-bridge';
import { pointPageAtBlobs } from '@/lib/preview/page-references';
import { generateNavigationScript } from '@/lib/preview/navigation-script';
import { generatePlacementScript } from '@/lib/preview/placement-script';
import { canvasBridgeJs, FREEZE_MOTION_CSS, PAUSE_SHIM_JS, REVEAL_SHIM_JS, type CanvasFrameMode } from './bridge';
import { pinPageViewportUnits, viewportRule } from './viewport-units';
import { OVERRIDES_STYLE_ATTR } from '@/lib/preview/style-preview';
import { PLACEHOLDER_CSS } from '@/lib/semantic-blocks/placeholder';
import { OVERRIDES_PATH } from '@/lib/direct-edit/overrides-css';

/**
 * The documents an artboard's frames are given, built from the compiled project the way Live Preview
 * builds its page (`loadPage`), with Canvas's rules on top:
 *
 * - `live`: the page and its scripts, with the reveal and pause shims ahead of them.
 * - `settle`: the same in the hidden job frame, motion frozen; it posts back the page as it settles.
 * - `still`: a snapshot of a page, no scripts but the bridge, which a CSP nonce lets through.
 *
 * All three pin `vh` to the device height, give Semantic block placeholders their look
 * (`PLACEHOLDER_CSS`) and carry the bridge.
 */

export interface CanvasDocInput {
  /** The page's file, `/about.html`. Relative references resolve from its folder. */
  page: string;
  /** The compiled page, or for a still the snapshot (with asset tokens; see `toAssetTokens`). */
  html: string;
  /** The compile's file map: VFS path to the host's blob URL. */
  blobUrls: ReadonlyMap<string, string>;
  mode: CanvasFrameMode;
  deviceHeight: number;
  /** Stamps the preview bridge's `preview:ready` and storage reports, and a settle's `canvas:settled`. */
  loadId: number;
  /** For stills: the only script allowed to run carries it. */
  nonce?: string;
  /**
   * `/overrides.css` as the Inspector last wrote it, when that is newer than the compile: it goes in
   * where the file's link was. `null` leaves the compile's file, its link marked for a later swap.
   */
  overrides?: string | null;
}

/** `markup` just before the last `</body>`. A replacer function, so a `$&` in the script stays as written. */
const insertBeforeBodyEnd = (html: string, markup: string) =>
  /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${markup}</body>`) : html + markup;

/** Lazy images load at once: on an artboard every image is on screen. */
const eagerImages = (html: string) => html.replace(/(<img\b[^>]*\sloading\s*=\s*)(["'])lazy\2/gi, '$1$2eager$2');

const vfsMapScript = (blobUrls: ReadonlyMap<string, string>) =>
  `<script>window.__oswVfsBlobUrls = ${JSON.stringify(Object.fromEntries(blobUrls)).replace(/</g, '\\u003c')};</script>`;

export function canvasDocument({ page, html, blobUrls, mode, deviceHeight, loadId, nonce, overrides = null }: CanvasDocInput): string {
  const rules = `<style data-osw-canvas>${viewportRule(deviceHeight)}${PLACEHOLDER_CSS}${mode === 'live' ? '' : FREEZE_MOTION_CSS}</style>`;
  const bridge = generateNavigationScript(page, false, canvasBridgeJs(mode, deviceHeight, loadId));

  if (mode === 'still') {
    if (!nonce) throw new Error('a still needs a nonce for its bridge');
    const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">`;
    let doc = stripScripts(fromAssetTokens(withOverrides(html, `${TOKEN}${OVERRIDES_PATH}`, overrides), blobUrls));
    doc = insertBeforeBodyEnd(doc, bridge.replace('<script>', `<script nonce="${nonce}">`));
    return prependToHead(doc, csp + rules);
  }

  let doc = pointPageAtBlobs(eagerImages(pinPageViewportUnits(html)), page, blobUrls);
  const href = blobUrls.get(OVERRIDES_PATH);
  if (href || overrides !== null) doc = withOverrides(doc, href ?? null, overrides);
  // Live artboards take Semantic blocks the way Live Preview does.
  doc = insertBeforeBodyEnd(doc, mode === 'live' ? bridge + generatePlacementScript(page) : bridge);
  const shims = `<script data-osw-shim>${REVEAL_SHIM_JS}${mode === 'live' ? PAUSE_SHIM_JS : ''}</script>`;
  return prependToHead(doc, previewBridgeScript(loadId) + vfsMapScript(blobUrls) + rules + shims);
}

const SWAPPED_RE = new RegExp(`<style\\b[^>]*\\b${OVERRIDES_STYLE_ATTR}\\b[^>]*>[\\s\\S]*?</style\\s*>`, 'i');
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The page with `/overrides.css` as given: `css` in a `<style>` where the file's link (or an earlier
 * swapped-in copy) was, or with `css` null, the link to `href`, marked so the frame can swap it later.
 * A page with neither gets the style at the end of its head, where the link would go.
 */
export function withOverrides(html: string, href: string | null, css: string | null): string {
  const style = css === null ? null : `<style ${OVERRIDES_STYLE_ATTR}>${css.replace(/<\/(style)/gi, '<\\/$1')}</style>`;
  if (SWAPPED_RE.test(html)) {
    const link = href ? `<link rel="stylesheet" href="${href}" ${OVERRIDES_STYLE_ATTR}>` : '';
    return html.replace(SWAPPED_RE, () => style ?? link);
  }
  const linkRe = href ? new RegExp(`<link\\b[^>]*\\bhref\\s*=\\s*(["'])${escapeRe(href)}\\1[^>]*>`, 'i') : null;
  if (linkRe && linkRe.test(html)) {
    return html.replace(linkRe, (tag) => style ?? (tag.includes(OVERRIDES_STYLE_ATTR) ? tag : tag.replace(/^<link\b/i, `<link ${OVERRIDES_STYLE_ATTR}`)));
  }
  if (!style) return html;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${style}</head>`) : style + html;
}

/** A snapshot has no scripts already; stripped again here so a still never runs one, whatever made its HTML. */
function stripScripts(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
}

const TOKEN = 'osw-asset:';

/**
 * A snapshot names its files by the host's blob URLs, which die with the next compile. Stored, they
 * become tokens naming the file instead, and a still made from it later gets that compile's URLs.
 */
export function toAssetTokens(html: string, blobUrls: ReadonlyMap<string, string>): string {
  let out = html;
  for (const [path, url] of blobUrls) if (url && out.includes(url)) out = out.split(url).join(TOKEN + path);
  return out;
}

export function fromAssetTokens(html: string, blobUrls: ReadonlyMap<string, string>): string {
  if (!html.includes(TOKEN)) return html;
  // Longest paths first, so `/a.png` does not eat the front of `/a.png.bak`.
  const paths = [...blobUrls.keys()].sort((a, b) => b.length - a.length);
  let out = html;
  for (const path of paths) {
    const token = TOKEN + path;
    if (out.includes(token)) out = out.split(token).join(blobUrls.get(path)!);
  }
  return out;
}

/** A fresh nonce for a still's bridge. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
