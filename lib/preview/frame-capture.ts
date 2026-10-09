import { TOOLBAR_HOST_ATTR } from './toolbar-dom';
import { PREVIEW_BRIDGE_ATTR, previewBridgeJs } from './preview-bridge';

/**
 * Screenshots of a preview document, taken inside its own frame.
 *
 * The host cannot read the preview's DOM: project code runs there, so the frame is kept off the
 * app's origin. The host sends this runtime with a `preview:capture` request; the frame's bridge
 * runs it, it loads the two painters from `/preview-capture/` (copied there from node_modules by
 * `postinstall`), paints `document`, and posts the canvas back as an `ImageBitmap`. Scaling and
 * JPEG encoding stay with the host.
 *
 * Plain JavaScript in a string, like `STYLE_QUERY_JS`: it runs in a frame the bundler never sees,
 * so it may not depend on anything the bundler would add or rename.
 */

export const CAPTURE_LIB_PATH = '/preview-capture/';

export interface FrameCaptureOptions {
  captureWidth: number;
  captureHeight: number;
  fullPage: boolean;
  waitForContent: boolean;
  minWaitDelay: number;
}

export const CAPTURE_RUNTIME_JS = `
var opts = msg.opts, toolbarAttr = msg.toolbarAttr;
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
  if (!window.__oswCaptureLibs) {
    window.__oswCaptureLibs = Promise.all([
      window.modernScreenshot ? null : load(msg.libBase + 'modern-screenshot.js'),
      window.html2canvas ? null : load(msg.libBase + 'html2canvas.js')
    ]);
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
function prepareClone(doc) {
  Array.prototype.forEach.call(doc.querySelectorAll('[' + toolbarAttr + ']'), function (el) { el.remove(); });
  Array.prototype.forEach.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (link) {
    var href = link.getAttribute('href');
    if (href && /^https?:\\/\\//.test(href)) link.remove();
  });
  var view = doc.defaultView;
  if (!view) return;
  Array.prototype.forEach.call(doc.querySelectorAll('*'), function (el) {
    var cs = view.getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage.indexOf('gradient') !== -1) {
      el.style.backgroundImage = 'none';
      var bg = cs.backgroundColor;
      el.style.backgroundColor = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : '#64748b';
    }
  });
}
function timeout(p, ms, label) {
  return Promise.race([p, delay(ms).then(function () { throw new Error(label + ' timed out'); })]);
}
function paint() {
  var root = document.documentElement, body = document.body;
  var height = opts.fullPage
    ? Math.max(body.scrollHeight, body.offsetHeight, root.clientHeight, root.scrollHeight, root.offsetHeight)
    : opts.captureHeight;
  var width = Math.max(root.clientWidth, body.scrollWidth, 1);
  var scale = width < opts.captureWidth ? Math.min(2, opts.captureWidth / width) : 1;
  return timeout(window.modernScreenshot.domToCanvas(root, {
    width: width, height: height, scale: scale, backgroundColor: '#ffffff', timeout: 3000,
    filter: function (node) { return !(node instanceof Element && node.hasAttribute(toolbarAttr)); }
  }), 6000, 'foreignObject render').then(function (canvas) {
    if (!canvas.width || !canvas.height) throw new Error('empty canvas');
    return canvas;
  }).catch(function () {
    return timeout(window.html2canvas(body, {
      width: opts.captureWidth, height: height, scale: 1, useCORS: true, allowTaint: true,
      logging: false, windowWidth: opts.captureWidth, windowHeight: height, scrollX: 0, scrollY: 0,
      imageTimeout: 3000, backgroundColor: '#ffffff', removeContainer: true, onclone: prepareClone
    }), 4000, 'html2canvas');
  });
}
function paintWithRetry() {
  return paint().catch(function (err) {
    if (/non-finite|addColorStop|CanvasGradient/.test(String(err))) return delay(500).then(paint);
    throw err;
  });
}
(opts.waitForContent ? waitForResources(opts.minWaitDelay, 8000) : Promise.resolve())
  .then(libs)
  .then(paintWithRetry)
  .then(function (canvas) { return createImageBitmap(canvas); })
  .then(function (bitmap) { reply({ bitmap: bitmap }, [bitmap]); })
  .catch(function (err) { reply({ error: String(err && err.message || err) }); });
`;

let nextRequestId = 1;

/**
 * Make sure a same-origin frame that was not written by the preview (a published deployment loaded
 * by URL) has the bridge that answers capture requests. A frame the host cannot read is one the
 * preview wrote, and it carries the bridge already.
 */
function ensureBridge(iframe: HTMLIFrameElement): void {
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    return;
  }
  if (!doc || doc.querySelector(`script[${PREVIEW_BRIDGE_ATTR}]`)) return;
  const script = doc.createElement('script');
  script.setAttribute(PREVIEW_BRIDGE_ATTR, '');
  script.textContent = previewBridgeJs(0);
  (doc.head || doc.documentElement).appendChild(script);
}

/** Ask the frame to paint itself. Resolves with the painted page, or rejects with the frame's reason. */
export function requestFrameCapture(
  iframe: HTMLIFrameElement,
  opts: FrameCaptureOptions,
  timeoutMs: number,
): Promise<ImageBitmap> {
  const target = iframe.contentWindow;
  if (!target) return Promise.reject(new Error('frame has no window'));
  ensureBridge(iframe);
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
      if (data.bitmap) resolve(data.bitmap);
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
