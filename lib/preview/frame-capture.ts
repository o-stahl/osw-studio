import { TOOLBAR_HOST_ATTR } from './toolbar-dom';

/**
 * Screenshots of a preview document, taken inside its own frame.
 *
 * The host cannot read the preview's DOM: project code runs there, so the frame is kept off the
 * app's origin. The host sends this runtime with a `preview:capture` request; the frame's bridge
 * runs it, it loads modern-screenshot from `/preview-capture/` (copied there from node_modules by
 * `postinstall`), paints `document`, and posts the canvas back as an `ImageBitmap`. Scaling and
 * JPEG encoding stay with the host.
 *
 * There is no html2canvas fallback: it renders by cloning the page into a nested frame and reading
 * it, and in this sandbox a nested frame cannot be read.
 *
 * The painter draws a copy of the page as an SVG image, which sees neither the page's stylesheets
 * nor the network, so three things are handed to it: the root's own background, the web fonts of
 * stylesheets the frame cannot read (Google Fonts, say), and the CSS on `<symbol>` shapes.
 *
 * Plain JavaScript in a string, like `STYLE_QUERY_JS`: it runs in a frame the bundler never sees,
 * so it may not depend on anything the bundler would add or rename.
 */

const CAPTURE_LIB_PATH = '/preview-capture/';

interface FrameCaptureOptions {
  captureWidth: number;
  captureHeight: number;
  fullPage: boolean;
  waitForContent: boolean;
  minWaitDelay: number;
  /** Paint at this scale instead of the one worked out from `captureWidth`: Canvas's thumbnails are a quarter. */
  scale?: number;
}

export const CAPTURE_RUNTIME_JS = `
var opts = msg.opts, toolbarAttr = msg.toolbarAttr, CAPTURE_ATTR = 'data-osw-capture';
function reply(m, transfer) { post(Object.assign({ type: 'preview:capture-result', reqId: msg.reqId }, m), transfer); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function load(src) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('could not load ' + src)); };
    (document.head || document.documentElement).appendChild(s);
  });
}
function libs() {
  if (!window.modernScreenshot && !window.__oswCaptureLibs) {
    window.__oswCaptureLibs = load(msg.libBase + 'modern-screenshot.js');
  }
  return window.__oswCaptureLibs;
}
function waitForResources(minDelay, timeout) {
  var waits = [delay(minDelay)];
  if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready.catch(function () {}));
  Array.prototype.forEach.call(document.querySelectorAll('img'), function (img) {
    if (!img.complete) waits.push(new Promise(function (r) {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
    }));
  });
  waits.push(new Promise(function (r) {
    if (window.requestIdleCallback) window.requestIdleCallback(r, { timeout: 500 }); else setTimeout(r, 500);
  }));
  return Promise.race([Promise.all(waits), delay(timeout)]);
}
// modern-screenshot reads browser-default styles out of an iframe it creates. In this sandbox a
// nested frame gets an origin of its own and cannot be read, so it is handed a shadow root in this
// document instead: \`all: initial\` on the host keeps the page's styles out, and the user-agent
// stylesheet still applies inside it.
function shadowSandbox() {
  var host = document.createElement('div');
  host.setAttribute(CAPTURE_ATTR, '');
  host.style.cssText = 'all:initial;position:fixed;width:0;height:0;overflow:hidden;visibility:hidden';
  var body = document.createElement('div');
  host.attachShadow({ mode: 'open' }).appendChild(body);
  (document.body || document.documentElement).appendChild(host);
  return {
    contentWindow: {
      document: {
        body: body,
        createElement: function (tag) { return document.createElement(tag); },
        createElementNS: function (ns, tag) { return document.createElementNS(ns, tag); }
      },
      getComputedStyle: function (el, pseudo) { return window.getComputedStyle(el, pseudo); }
    },
    remove: function () { host.remove(); }
  };
}
// The painter sets this colour on the root, over the page's own; white only where the page has none.
function pageBackground() {
  var color = getComputedStyle(document.documentElement).backgroundColor;
  return !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)' ? '#ffffff' : color;
}
// The painter embeds the @font-face rules it can read. Those of a cross-origin stylesheet are fetched
// into a sheet of their own, as far as the page has loaded them. "not all" keeps the page from
// applying them, which would swap its fonts while it is on screen; the painter reads them regardless.
function remoteFontStyle() {
  var links = Array.prototype.filter.call(document.querySelectorAll('link[rel~="stylesheet"]'), function (link) {
    try { return !!link.sheet && !link.sheet.cssRules; } catch (err) { return true; }
  });
  if (!links.length || !document.fonts || !window.CSSStyleSheet) return Promise.resolve(null);
  function face(family, style, range) { return family.replace(/["']/g, '') + '|' + style + '|' + range; }
  var loaded = {};
  document.fonts.forEach(function (font) {
    if (font.status === 'loaded') loaded[face(font.family, font.style, font.unicodeRange)] = true;
  });
  var css = Promise.all(links.map(function (link) {
    return fetch(link.href).then(function (res) { return res.ok ? res.text() : ''; }).catch(function () { return ''; });
  })).then(function (texts) {
    var kept = '';
    texts.forEach(function (text) {
      var sheet = new CSSStyleSheet();
      try { sheet.replaceSync(text); } catch (err) { return; }
      Array.prototype.forEach.call(sheet.cssRules, function (rule) {
        if (rule.type !== 5) return;
        var s = rule.style;
        var key = face(s.getPropertyValue('font-family'), s.getPropertyValue('font-style') || 'normal', s.getPropertyValue('unicode-range') || 'U+0-10FFFF');
        if (loaded[key]) kept += rule.cssText + ' ';
      });
    });
    return kept;
  });
  return Promise.race([css, delay(1500).then(function () { return ''; })]).then(function (text) {
    if (!text) return null;
    var style = document.createElement('style');
    style.setAttribute(CAPTURE_ATTR, '');
    style.media = 'not all';
    style.textContent = text;
    (document.head || document.documentElement).appendChild(style);
    return style;
  });
}
// The painter copies what a <use> refers to without its CSS. What a rule gave a shape goes on the copy;
// attributes and inherited values stay as they are, since they resolve where the <use> stands.
var SHAPE_STYLES = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity'];
function copyShapeStyles(from, to) {
  var own = getComputedStyle(from), parent = from.parentElement ? getComputedStyle(from.parentElement) : null;
  SHAPE_STYLES.forEach(function (prop) {
    if (from.hasAttribute(prop) || (from.style && from.style.getPropertyValue(prop))) return;
    var value = own.getPropertyValue(prop);
    if (!value || (parent && value === parent.getPropertyValue(prop))) return;
    if ((prop === 'fill' || prop === 'stroke') && value === own.color) value = 'currentColor';
    to.style.setProperty(prop, value);
  });
  for (var i = 0; i < from.children.length && i < to.children.length; i++) copyShapeStyles(from.children[i], to.children[i]);
}
function keepShapeStyles(svg) {
  Array.prototype.forEach.call(svg.children, function (defs) {
    if (defs.localName !== 'defs') return;
    Array.prototype.forEach.call(defs.children, function (copy) {
      var from = copy.id && document.getElementById(copy.id);
      if (from) copyShapeStyles(from, copy);
    });
  });
}
function paint() {
  var root = document.documentElement, body = document.body;
  var height = opts.fullPage
    ? Math.max(body.scrollHeight, body.offsetHeight, root.clientHeight, root.scrollHeight, root.offsetHeight)
    : opts.captureHeight;
  var width = Math.max(root.clientWidth, body.scrollWidth, 1);
  var scale = opts.scale || (width < opts.captureWidth ? Math.min(2, opts.captureWidth / width) : 1);
  var ms = window.modernScreenshot;
  return remoteFontStyle().then(function (fontStyle) {
    function clear() { if (fontStyle) fontStyle.remove(); }
    return ms.createContext(root, {
      width: width, height: height, scale: scale, backgroundColor: pageBackground(), timeout: 3000, autoDestruct: true,
      onCreateForeignObjectSvg: keepShapeStyles,
      filter: function (node) {
        return !(node instanceof Element && (node.hasAttribute(toolbarAttr) || node.hasAttribute(CAPTURE_ATTR)));
      }
    }).then(function (context) {
      context.sandbox = shadowSandbox();
      return Promise.race([
        ms.domToCanvas(context),
        delay(10000).then(function () { throw new Error('render timed out'); })
      ]);
    }).then(function (canvas) {
      clear();
      if (!canvas.width || !canvas.height) throw new Error('empty canvas');
      return canvas;
    }, function (err) { clear(); throw err; });
  });
}
(opts.waitForContent ? waitForResources(opts.minWaitDelay, 8000) : Promise.resolve())
  .then(libs)
  .then(paint)
  .then(function (canvas) { return createImageBitmap(canvas); })
  .then(function (bitmap) { reply({ bitmap: bitmap }, [bitmap]); })
  .catch(function (err) { reply({ error: String(err && err.message || err) }); });
`;

let nextRequestId = 1;

/** Ask the frame to paint itself. Resolves with the painted page, or rejects with the frame's reason. */
export function requestFrameCapture(
  iframe: HTMLIFrameElement,
  opts: FrameCaptureOptions,
  timeoutMs: number,
): Promise<ImageBitmap> {
  const target = iframe.contentWindow;
  if (!target) return Promise.reject(new Error('frame has no window'));
  const reqId = nextRequestId++;

  return new Promise<ImageBitmap>((resolve, reject) => {
    const finish = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target) return;
      const data = event.data as { type?: string; reqId?: number; bitmap?: ImageBitmap; error?: string } | null;
      if (!data || data.type !== 'preview:capture-result' || data.reqId !== reqId) return;
      finish();
      if (data.bitmap instanceof ImageBitmap) resolve(data.bitmap);
      else reject(new Error(data.error || 'capture failed'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    window.addEventListener('message', onMessage);
    target.postMessage({
      type: 'preview:capture',
      reqId,
      opts,
      toolbarAttr: TOOLBAR_HOST_ATTR,
      libBase: window.location.origin + CAPTURE_LIB_PATH,
      runtime: CAPTURE_RUNTIME_JS,
    }, '*');
  });
}
