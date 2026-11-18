import { vfs } from '@/lib/vfs';
import { PROJECT_SANDBOX, createSandboxedFrame } from '@/lib/sandbox';
import { previewShellHtml, sendShellContent } from '@/lib/preview/preview-shell';
import { requestFrameCapture } from '@/lib/preview/frame-capture';
import { answerFunctionCall, type FunctionCall } from '@/lib/preview/function-proxy';
import { getPreviewStorage } from '@/lib/preview/preview-storage';
import { canvasSupport } from '@/lib/runtimes/registry';
import { resolveRuntime } from '@/lib/vfs/project-settings';
import { logger } from '@/lib/utils';
import { canvasDocument } from './compile';
import { compileForCanvas, pageForPath } from './project-compile';
import { CANVAS_DEVICES } from './types';
import type { InspectReport, RenderJob, RenderResult, ScreenshotImage } from './render-types';

/**
 * A page rendered for the agent, in a hidden frame of this tab: the Canvas settle (the page's
 * scripts run, scroll-triggered content shows, motion is frozen where it ends, fixed elements are
 * pinned where the first screen has them), then `inspect` reads it or `screenshot` paints it. The
 * frame has the preview's sandbox and shell, like an artboard's, and is removed when the job ends.
 */

/** The properties `inspect` reports for a target, as longhands; the report folds sides back together. */
const INSPECT_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'flex-grow', 'flex-basis',
  'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'color',
  'background-color', 'background-image',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'opacity', 'overflow-x', 'overflow-y', 'transform',
];

const SETTLE_TIMEOUT_MS = 15000;
const INSPECT_TIMEOUT_MS = 5000;
const CAPTURE_TIMEOUT_MS = 20000;
/** A model reads an image up to about 1.15 megapixels and 1568 px on its long side before scaling it down. */
const MAX_IMAGE_AREA = 1_150_000;
const MAX_IMAGE_SIDE = 1568;
/** `--full` sends at most this many tiles; a longer page is cut and says so. */
export const MAX_TILES = 6;
/** Room around an element's crop, so its edges show. */
const CROP_MARGIN = 16;

let nextLoadId = 1;
let nextReqId = 1;

/** The height of the device a width is nearest to, as Canvas lays pages out. */
export function deviceHeightFor(width: number): number {
  if (width <= 600) return CANVAS_DEVICES.phone.h;
  if (width <= 1100) return CANVAS_DEVICES.tablet.h;
  return CANVAS_DEVICES.desktop.h;
}

/** How tall a tile `width` px wide can be and still reach the model at full size. */
export function tileHeightFor(width: number): number {
  return Math.max(200, Math.min(MAX_IMAGE_SIDE, Math.floor(MAX_IMAGE_AREA / Math.max(1, width))));
}

/** A last slice shorter than this share of a tile joins the one before it. */
const SLIVER = 0.15;

/**
 * The slices a region is cut into: each as tall as a tile can be, at most `MAX_TILES`. A short
 * remainder joins the slice before it rather than going out as a strip of its own: a first screen
 * 1440 × 900 is one image, a little over the size a model reads unscaled, not 798 px and 102 px.
 */
export function tilesOf(y: number, h: number, width: number): { tiles: { y: number; h: number }[]; cut: boolean } {
  const tile = tileHeightFor(width);
  const tiles: { y: number; h: number }[] = [];
  for (let top = y; top < y + h && tiles.length < MAX_TILES; top += tile) {
    const rest = y + h - top;
    if (tiles.length > 0 && rest < tile * SLIVER) { tiles[tiles.length - 1].h += rest; break; }
    const take = rest < tile * (1 + SLIVER) ? rest : tile;
    tiles.push({ y: top, h: take });
    if (take === rest) break;
  }
  const covered = tiles.length > 0 ? tiles[tiles.length - 1].y + tiles[tiles.length - 1].h : y;
  return { tiles, cut: covered < y + h };
}

/** At most this much of a frame's error reaches the agent. */
const MAX_REASON = 200;

/** A frame's error as one short plain line: the frame runs the page's scripts, which can post anything. */
function oneLine(error: unknown): string {
  const line = (typeof error === 'string' ? error : '').split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!line) return 'the frame gave no reason';
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON)}…` : line;
}

interface Settled {
  frame: HTMLIFrameElement;
  height: number;
  devH: number;
  ask<T>(message: Record<string, unknown>, reply: string, timeoutMs: number): Promise<T | null>;
}

async function settle(job: RenderJob): Promise<{ settled: Settled; close: () => void } | { error: string }> {
  await vfs.init();
  let runtime;
  try {
    runtime = resolveRuntime((await vfs.getProject(job.projectId))?.settings);
  } catch {
    return { error: 'the project does not exist in this tab' };
  }
  if (!canvasSupport(runtime)) return { error: `a ${runtime} project has no pages to render` };

  const { project, dispose } = await compileForCanvas(vfs, job.projectId, runtime);
  const page = pageForPath(project.routes, project.pages, job.page);
  const compiled = page ? project.compile.pages.get(page) : undefined;
  if (!page || !compiled) {
    dispose();
    return { error: `${job.page} is not a page of this project (pages: ${project.pages.map(p => p.file).join(', ') || 'none'})` };
  }

  const width = Math.round(Math.min(3840, Math.max(240, job.width)));
  const devH = deviceHeightFor(width);
  const frame = createSandboxedFrame(PROJECT_SANDBOX);
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-20000px;top:0;border:0;pointer-events:none;visibility:hidden;width:${width}px;height:${devH}px`;
  const loadId = nextLoadId++;
  const doc = canvasDocument({ page, html: compiled.html, blobUrls: project.compile.blobUrls, mode: 'settle', deviceHeight: devH, loadId });
  const cache = new Map<string, Blob>();
  const waiting = new Map<string, (data: Record<string, unknown>) => void>();
  const deploymentId = vfs.getRuntimeDeploymentId();
  /** Why the frame could not build the page, when it said so. */
  let shellError: string | null = null;

  const onMessage = (event: MessageEvent) => {
    const win = frame.contentWindow;
    if (!win || event.source !== win) return;
    const data = event.data as { type?: string; loadId?: number; reqId?: number } & Record<string, unknown>;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'preview:shell-ready' && data.loadId === loadId) {
      void sendShellContent(win, loadId, doc, project.compile.blobUrls.values(), cache, getPreviewStorage(job.projectId)).catch((err) => {
        logger.error('[Canvas] Could not send a page to the render frame:', err);
      });
      return;
    }
    if (data.type === 'preview:function-call') {
      void answerFunctionCall(data as unknown as FunctionCall, deploymentId, win, () => loadId).catch((err) => {
        logger.error('[Canvas] Could not answer a function call from the render frame:', err);
      });
      return;
    }
    if (data.type === 'preview:shell-error' && data.loadId === loadId) {
      logger.error('[Canvas] The render frame could not build the page:', data.error);
      shellError = oneLine(data.error);
      // The page will never settle: the job ends now rather than when the wait runs out.
      const settled = waiting.get('canvas:settled');
      if (settled) { waiting.delete('canvas:settled'); settled(data); }
      return;
    }
    const key = typeof data.reqId === 'number' ? `${data.type}:${data.reqId}` : data.type;
    const resolve = waiting.get(key);
    if (resolve) { waiting.delete(key); resolve(data); }
  };
  window.addEventListener('message', onMessage);
  const close = () => {
    window.removeEventListener('message', onMessage);
    frame.remove();
    dispose();
  };

  const wait = (key: string, timeoutMs: number) => new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => { waiting.delete(key); resolve(null); }, timeoutMs);
    waiting.set(key, (data) => { clearTimeout(timer); resolve(data); });
  });

  document.body.appendChild(frame);
  const settledReply = wait('canvas:settled', SETTLE_TIMEOUT_MS);
  frame.srcdoc = previewShellHtml(loadId);
  const done = await settledReply;
  if (shellError !== null) {
    close();
    return { error: `${page} could not be loaded: ${shellError}` };
  }
  if (!done) {
    close();
    return { error: `${page} did not finish loading within ${SETTLE_TIMEOUT_MS / 1000} s` };
  }
  const height = Math.max(devH, Math.round(Number(done.height) || devH));
  return {
    settled: {
      frame,
      height,
      devH,
      ask: async <T,>(message: Record<string, unknown>, reply: string, timeoutMs: number) => {
        const reqId = nextReqId++;
        const answer = wait(`${reply}:${reqId}`, timeoutMs);
        frame.contentWindow?.postMessage({ ...message, reqId }, '*');
        return (await answer) as T | null;
      },
    },
    close,
  };
}

async function inspectReport(settled: Settled, job: RenderJob): Promise<InspectReport | { error: string }> {
  const reply = await settled.ask<{ report?: InspectReport & { error?: string } }>(
    { type: 'canvas:inspect', target: job.target ?? null, depth: job.depth ?? (job.target ? 2 : 3), props: job.target ? job.props ?? INSPECT_PROPERTIES : null },
    'canvas:inspected',
    INSPECT_TIMEOUT_MS,
  );
  const report = reply?.report;
  if (!report) return { error: 'the page did not answer' };
  if (report.error === 'bad-selector') return { error: `"${job.target}" is not a selector the browser accepts` };
  if (report.error) return { error: report.error };
  return report;
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('the screenshot could not be encoded');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Cut `region` (page CSS px) out of the painted page, as JPEG tiles. */
async function cut(bitmap: ImageBitmap, region: { x: number; y: number; w: number; h: number }): Promise<{ images: ScreenshotImage[]; cut: boolean }> {
  // Painted at scale 1 (below), so a page pixel is an image pixel; a page wider than its frame is
  // painted wider, and the region still starts at its own x.
  const { tiles, cut: wasCut } = tilesOf(region.y, region.h, region.w);
  const images: ScreenshotImage[] = [];
  for (const tile of tiles) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(region.w));
    canvas.height = Math.max(1, Math.round(tile.h));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, region.x, tile.y, region.w, tile.h, 0, 0, canvas.width, canvas.height);
    images.push({ mediaType: 'image/jpeg', data: await toJpeg(canvas), width: canvas.width, height: canvas.height, region: { x: region.x, y: tile.y, w: region.w, h: tile.h } });
  }
  return { images, cut: wasCut };
}

/** Render `job.page` at `job.width` and inspect or paint it. */
export async function renderPage(job: RenderJob): Promise<RenderResult> {
  const opened = await settle(job);
  if ('error' in opened) return { ok: false, error: opened.error };
  const { settled, close } = opened;
  try {
    if (job.kind === 'inspect') {
      const report = await inspectReport(settled, job);
      return 'error' in report ? { ok: false, error: report.error } : { ok: true, kind: 'inspect', report };
    }

    const width = parseInt(settled.frame.style.width, 10);
    let region = { x: 0, y: 0, w: width, h: settled.devH };
    let matches: number | undefined;
    if (job.target) {
      const report = await inspectReport(settled, { ...job, depth: 0 });
      if ('error' in report) return { ok: false, error: report.error };
      matches = report.matches;
      if (!report.node) return { ok: false, error: `nothing on ${job.page} matches "${job.target}"` };
      const box = report.node.box;
      if (report.node.hidden || box.w === 0 || box.h === 0) return { ok: false, error: `"${job.target}" is not shown at ${width} px wide` };
      const x = Math.max(0, box.x - CROP_MARGIN);
      const y = Math.max(0, box.y - CROP_MARGIN);
      region = { x, y, w: Math.min(width, box.x + box.w + CROP_MARGIN) - x, h: Math.min(settled.height, box.y + box.h + CROP_MARGIN) - y };
    } else if (job.full) {
      region = { x: 0, y: 0, w: width, h: settled.height };
    }
    // Painted down to the region's end, at most as far as the tiles reach.
    const reach = Math.min(region.y + region.h, region.y + Math.ceil((MAX_TILES + SLIVER) * tileHeightFor(region.w)));
    settled.frame.style.height = `${settled.height}px`;
    const bitmap = await requestFrameCapture(settled.frame, {
      captureWidth: width, captureHeight: reach, fullPage: false, waitForContent: false, minWaitDelay: 0, scale: 1,
    }, CAPTURE_TIMEOUT_MS);
    try {
      const { images, cut: wasCut } = await cut(bitmap, region);
      return { ok: true, kind: 'screenshot', images, width, height: settled.devH, pageHeight: settled.height, ...(matches !== undefined ? { matches } : {}), ...(wasCut ? { cut: true } : {}) };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    close();
  }
}
