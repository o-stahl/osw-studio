import { PREVIEW_SANDBOX, PROJECT_SANDBOX, createSandboxedFrame } from '@/lib/sandbox';
import { previewShellHtml, sendShellContent } from '@/lib/preview/preview-shell';
import { requestFrameCapture } from '@/lib/preview/frame-capture';
import { answerFunctionCall, type FunctionCall } from '@/lib/preview/function-proxy';
import type { PreviewStorageSnapshot } from '@/lib/preview/preview-storage';
import type { OverrideMark } from '@/lib/preview/types';
import { logger } from '@/lib/utils';
import { canvasDocument, newNonce, toAssetTokens } from './compile';
import { hashText } from './hash';
import { planTiers } from './tiers';
import { mostlyDrawn, readTraced, type Traced } from './tracing';
import type { ThumbCache } from './thumbs';
import { DEFAULT_BUDGET, type ArtboardBox, type LiveBudget, type Tier, type ViewRect } from './types';

/**
 * Canvas's engine: which artboards hold what, and the frames behind them.
 *
 * It decides tiers with `planTiers`, keeps each artboard's frame, still and thumbnail, and runs the
 * background jobs (settles and thumbnails) one at a time while nobody is doing anything. Frames are
 * written through the preview shell and only ever talked to by message (`lib/canvas/bridge.ts`).
 * The panel owns the DOM around it: it gives each artboard a slot to put frames in.
 */

/** A compiled project, as Canvas uses it. */
export interface CanvasCompile {
  /** VFS path to the host's blob URL. */
  blobUrls: ReadonlyMap<string, string>;
  /** Each page's compiled HTML and a signature that changes when the page or a file it may use does. */
  pages: ReadonlyMap<string, { html: string; signature: string }>;
  /** The project files each page uses (`pageDependencies`). */
  deps?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** What was typed into a page's fields (the bridge's shape; opaque here). */
type Kept = { count: number; list: unknown[] } | null;

export interface BoardState extends ArtboardBox {
  tier: Tier;
  seen: number;
  /** The page as last settled or unloaded, with asset tokens; null before either. */
  snapshot: string | null;
  /** The page signature the snapshot was taken at. */
  snapVer: string;
  /** An object URL of the thumbnail, and the signature it was taken at. */
  thumb: string | null;
  thumbVer: string;
  fields: Kept;
  /** The height was measured, not estimated. */
  measured: boolean;
  /** Loading live over whatever is shown, until its `canvas:ready`. */
  booting: boolean;
  /** Where the page's elements came from when it last settled (`lib/canvas/tracing.ts`); null before. */
  traced: Traced | null;
}

interface Slot {
  el: HTMLElement;
  /** The frame on show: live or still. */
  frame: HTMLIFrameElement | null;
  frameMode: 'live' | 'still' | null;
  /** The snapshot of the still last mounted, loading or on show, so the same one is not mounted twice. */
  stillOf: string | null;
  /** A live frame loading over the shown one. */
  boot: HTMLIFrameElement | null;
  img: HTMLImageElement | null;
}

interface FrameRecord {
  board: string | null;
  role: 'live' | 'still' | 'job';
  loadId: number;
  doc: string;
  /** The compile the document was built from: the blob URLs it names, and the shell cache for them. */
  compile: CanvasCompile;
  /** The overrides the document was built with (`overridesTag`), so a newer copy reaches it on ready. */
  ov: string;
  /** A still's snapshot. */
  snapshot?: string;
}

/** What a selection's handles need from its frame (the bridge's `__cvMetrics`), in CSS pixels. */
export interface SelectionMetrics {
  pt: number;
  pr: number;
  pb: number;
  pl: number;
  rowGap: number;
  columnGap: number;
  /** Its parent is a flex row, where a fixed width needs the flex basis cleared. */
  parentRow: boolean;
  /** The gap between its first two children, in page coordinates; `across` when they sit side by side. */
  gap: { x: number; y: number; w: number; h: number; across: boolean } | null;
  tag: string;
}

export interface EngineCallbacks {
  /** Tiers, heights or thumbnails changed: the panel draws again. */
  onChange?: () => void;
  /** A board's live or still frame loaded a document: every node id it had is gone. */
  onFrameReady?: (board: string) => void;
  /** Watched boxes reported by a board's frame, in the order they were asked for. */
  onRects?: (board: string, rects: ({ x: number; y: number; w: number; h: number } | null)[], metrics: SelectionMetrics | null) => void;
  /** Anything else a board's frame posts: the Inspector's replies, `navigate`, `preview:external`. */
  onFrameMessage?: (board: string, data: { type: string; [key: string]: unknown }) => void;
  /** The wheel turned over a page that has the pointer (Use the pages). */
  onWheel?: (board: string, data: { dx: number; dy: number; deltaMode: number; zoom: boolean; x: number; y: number }) => void;
  /** A Canvas shortcut pressed while a page had the keyboard. */
  onKey?: (board: string, key: string) => void;
}

export interface EngineOptions {
  budget?: LiveBudget;
  callbacks?: EngineCallbacks;
  /** The project's preview storage, given to live pages as their start; their writes are not kept. */
  storage?: () => PreviewStorageSnapshot | undefined;
  /** Where the job frame lives (off screen, but in the document so it renders). */
  jobHost?: HTMLElement;
  /** Thumbnails kept between sessions (`canvasThumbs`). */
  thumbs?: ThumbCache;
  /** The deployment whose edge functions a page's calls go to, as in Live Preview. */
  deploymentId?: () => string | null | undefined;
}

/** A page that just loaded runs freely this long, so animations that reveal content can finish. */
const WARM_MS = 2000;
/** Background jobs wait for this long without input. */
const IDLE_MS = 800;
const SETTLE_TIMEOUT_MS = 8000;
const FREEZE_TIMEOUT_MS = 400;
const THUMB_SCALE = 0.25;

export class CanvasEngine {
  readonly boards = new Map<string, BoardState>();
  budget: LiveBudget;

  private slots = new Map<string, Slot>();
  private frames = new Map<Window, FrameRecord>();
  private compile: CanvasCompile | null = null;
  /** The blobs frames' shells were sent, per compile, as Live Preview keeps them: they go with their compile. */
  private shellCaches = new WeakMap<CanvasCompile, Map<string, Blob>>();
  private view: ViewRect = { x: 0, y: 0, w: 1, h: 1 };
  private z = 1;
  private focus: string | null = null;
  private awake: string | null = null;
  private active = true;
  private interactive = false;
  private nextLoad = 1;
  private nextReq = 1;
  /** Answers waited for: questions by their `reqId`, settles by their negative `loadId`; each from the window asked. */
  private replies = new Map<number, { win: Window | null; take: (data: Record<string, unknown>) => void }>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private warmTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastInput = 0;
  private jobRunning = false;
  private jobTimer: ReturnType<typeof setTimeout> | null = null;
  private jobFrame: HTMLIFrameElement | null = null;
  private near: string[] = [];
  private warm = new Map<string, number>();
  /** `/overrides.css` as the Inspector last wrote it, held until a compile has it. */
  private overrides: string | null = null;
  /** The artboard text is being typed into, whose reload waits (`hold`). */
  private held: string | null = null;
  private heldStale = false;
  private releasePending = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Elements to mark with the marker their first edit stamps, until the compile has the stamp. */
  private marks: OverrideMark[] = [];
  /** Its hash, or '' with none held: part of a thumbnail's version, since a thumbnail is a picture of it. */
  private overridesTag = '';
  /** Thumbnails being looked up in the cache, by board and signature. */
  private lookingUp = new Set<string>();
  private destroyed = false;

  constructor(private opts: EngineOptions = {}) {
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    window.addEventListener('message', this.onMessage);
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('message', this.onMessage);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.jobTimer) clearTimeout(this.jobTimer);
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    for (const t of this.warmTimers) clearTimeout(t);
    for (const id of this.slots.keys()) this.clearSlot(id);
    for (const b of this.boards.values()) if (b.thumb) URL.revokeObjectURL(b.thumb);
    this.jobFrame?.remove();
    this.jobFrame = null;
  }

  // ---------- inputs ----------

  /** A new compile. Pages whose signature changed reload when live, and are settled again. */
  setCompile(compile: CanvasCompile): void {
    const before = this.compile;
    this.compile = compile;
    this.overrides = null;
    this.overridesTag = '';
    this.marks = [];
    this.cachedThumbs();
    if (!before) { this.update(); return; }
    for (const b of this.boards.values()) {
      const page = compile.pages.get(b.page);
      const was = before.pages.get(b.page);
      if (!page || !was || page.signature === was.signature) continue;
      if (b.id === this.held) { this.heldStale = true; continue; }
      if (b.tier === 'live') void this.reloadLive(b);
    }
    if (this.releasePending) this.release();
    this.update();
  }

  /**
   * Keep an artboard's document while text is typed into it: a recompile meanwhile reloads it when
   * the hold is let go (`release`), not in the middle of the typing.
   */
  hold(id: string): void {
    if (this.held && this.held !== id) this.release();
    this.held = id;
  }

  /**
   * Let go of the hold: now, or (`afterCompile`) with the next compile, which the write the typing
   * made has just started; reloading before it would show the text as it was. A compile that does
   * not come lets go after a few seconds.
   */
  release(afterCompile = false): void {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (!this.held) return;
    if (afterCompile) {
      this.releasePending = true;
      this.releaseTimer = setTimeout(() => { this.releaseTimer = null; this.release(); }, 5000);
      return;
    }
    const id = this.held;
    const stale = this.heldStale;
    this.held = null;
    this.heldStale = false;
    this.releasePending = false;
    const b = stale ? this.boards.get(id) : undefined;
    if (b && b.tier === 'live') void this.reloadLive(b);
  }

  /** The artboards, as laid out. State is kept for ids that stay. */
  setBoards(boxes: readonly ArtboardBox[]): void {
    const keep = new Set(boxes.map((b) => b.id));
    for (const [id, b] of this.boards) {
      if (keep.has(id)) continue;
      this.clearSlot(id);
      if (b.thumb) URL.revokeObjectURL(b.thumb);
      this.boards.delete(id);
    }
    for (const box of boxes) {
      const b = this.boards.get(box.id);
      if (b) Object.assign(b, { x: box.x, y: box.y, w: box.w, devH: box.devH, ...(b.measured ? {} : { h: box.h }) });
      else this.boards.set(box.id, { ...box, tier: 'none', seen: 0, snapshot: null, snapVer: '', thumb: null, thumbVer: '', fields: null, measured: false, booting: false, traced: null });
    }
    this.cachedThumbs();
    this.update();
  }

  /** Thumbnails from earlier sessions, for artboards whose page has not changed since. */
  private cachedThumbs(): void {
    const cache = this.opts.thumbs;
    const compile = this.compile;
    if (!cache || !compile) return;
    for (const b of this.boards.values()) {
      const signature = this.thumbSig(b) || undefined;
      const key = `${b.id}|${signature}`;
      if (!signature || b.thumbVer === signature || this.lookingUp.has(key)) continue;
      this.lookingUp.add(key);
      void cache.get(b.page, b.device, signature).then((blob) => {
        this.lookingUp.delete(key);
        // An artboard removed meanwhile would never revoke the URL.
        if (!blob || this.destroyed || this.boards.get(b.id) !== b || this.thumbSig(b) !== signature || b.thumbVer === signature) return;
        if (b.thumb) URL.revokeObjectURL(b.thumb);
        b.thumb = URL.createObjectURL(blob);
        b.thumbVer = signature;
        this.update();
        this.opts.callbacks?.onChange?.();
      });
    }
  }

  /** The element an artboard's frames and thumbnail go in; null when it unmounts. */
  attachSlot(id: string, el: HTMLElement | null): void {
    if (!el) { this.clearSlot(id); this.slots.delete(id); return; }
    const slot = this.slots.get(id);
    if (slot && slot.el === el) return;
    if (slot) this.clearSlot(id);
    this.slots.set(id, { el, frame: null, frameMode: null, stillOf: null, boot: null, img: null });
    const b = this.boards.get(id);
    if (b) { const t = b.tier; b.tier = 'none'; this.setTier(b, t); }
  }

  setView(view: ViewRect, z: number): void {
    this.view = view;
    this.z = z;
    this.update();
  }

  /** The artboard holding the selection: live wherever it is, and never paused. */
  setFocus(id: string | null): void {
    if (this.focus === id) return;
    this.focus = id;
    this.update();
    this.pace();
  }

  /** The artboard under the pointer: its page runs at full rate. */
  setAwake(id: string | null): void {
    if (this.awake === id) return;
    this.awake = id;
    this.pace();
  }

  /** The panel is on screen and the browser tab visible. Inactive, nothing is live and no job runs. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.update();
  }

  /** Use the pages: live frames forward the wheel while they have the pointer. */
  setInteractive(on: boolean): void {
    this.interactive = on;
    for (const [, slot] of this.slots) if (slot.frameMode === 'live' && slot.frame) this.postTo(slot.frame, { type: 'canvas:interact', on });
  }

  /** Someone is using the canvas: background jobs wait. */
  touch(): void {
    this.lastInput = performance.now();
  }

  // ---------- talking to frames ----------

  /** Post to an artboard's frame on show. False when it has none. */
  post(id: string, message: Record<string, unknown>): boolean {
    const frame = this.slots.get(id)?.frame;
    if (!frame) return false;
    this.postTo(frame, message);
    return true;
  }

  /** Ask an artboard's frame something it answers with the same `reqId`. Null when it has no frame or no answer comes. */
  ask<T extends Record<string, unknown>>(id: string, message: Record<string, unknown>, timeoutMs = 1500): Promise<T | null> {
    const frame = this.slots.get(id)?.frame;
    if (!frame) return Promise.resolve(null);
    return this.askFrame<T>(frame, message, timeoutMs);
  }

  /**
   * `/overrides.css` as the Styles tab shows it: swapped into every frame on show, and built into
   * every document until the next compile has it. `unmarks` takes back marks a write did not stamp.
   * Thumbnails of it go out of date and are taken again when next needed, once the changes stop:
   * a change counts as use, so background jobs wait.
   */
  overridesPreview(css: string, marks: OverrideMark[] = [], unmarks: string[] = []): void {
    this.overrides = css;
    this.overridesTag = `.o${hashText(css)}`;
    this.marks = marks;
    this.touch();
    for (const slot of this.slots.values()) {
      for (const f of [slot.frame, slot.boot]) if (f) this.postTo(f, { type: 'overrides-preview', css, marks, unmarks });
    }
    this.update();
  }

  /** Post to every artboard's frame, booting ones included: a structural edit, a placeholder going. */
  broadcast(message: Record<string, unknown>): void {
    for (const slot of this.slots.values()) {
      for (const f of [slot.frame, slot.boot]) if (f) this.postTo(f, message);
    }
  }

  /** Give an artboard's frame the keyboard, so the page can take typing (text in place). */
  focusFrame(id: string): void {
    this.slots.get(id)?.frame?.focus();
  }

  /** The version a thumbnail of this artboard has to be: its page's, and the overrides held. */
  private thumbSig(b: BoardState): string {
    const signature = this.compile?.pages.get(b.page)?.signature;
    return signature ? signature + this.overridesTag : '';
  }

  /** A frame built with older overrides than the ones held gets the new copy. */
  private catchUp(frame: HTMLIFrameElement): void {
    const record = frame.contentWindow ? this.frames.get(frame.contentWindow) : undefined;
    // Marks are not built into a document, so a frame that loads while some are held needs them sent.
    if (this.overrides !== null && record && (record.ov !== this.overridesTag || this.marks.length > 0)) {
      this.postTo(frame, { type: 'overrides-preview', css: this.overrides, marks: this.marks });
    }
  }

  board(id: string): BoardState | undefined {
    return this.boards.get(id);
  }

  /** The tier each artboard holds: what the panel draws. */
  tierOf(id: string): Tier {
    return this.boards.get(id)?.tier ?? 'none';
  }

  isBooting(id: string): boolean {
    return !!this.boards.get(id)?.booting;
  }

  // ---------- tiers ----------

  update(): void {
    if (this.destroyed) return;
    const now = performance.now();
    const boards = [...this.boards.values()];
    const plan = planTiers({
      boards: boards.map((b) => ({ ...b, hasSnapshot: !!b.snapshot, hasThumb: !!b.thumb })),
      view: this.view,
      z: this.z,
      budget: this.budget,
      focus: this.focus,
      active: this.active && !!this.compile,
      now,
    });
    for (const id of plan.onScreen) { const b = this.boards.get(id); if (b) b.seen = now; }
    this.near = plan.near;
    let changed = false;
    for (const b of boards) {
      const t = plan.tiers.get(b.id) ?? 'none';
      if (t !== b.tier) { this.setTier(b, t); changed = true; }
      else if (t === 'still') this.mountStill(b);
      else if (t === 'image') this.mountImage(b);
    }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = plan.nextExpiry !== null ? setTimeout(() => this.update(), plan.nextExpiry + 20) : null;
    this.scheduleJobs();
    if (changed) this.opts.callbacks?.onChange?.();
  }

  private setTier(b: BoardState, t: Tier): void {
    const was = b.tier;
    b.tier = t;
    const slot = this.slots.get(b.id);
    if (was === 'live' && t !== 'live') void this.unload(b);
    if (!slot) return;
    if (t === 'live') { if (was !== 'live' || !slot.frame) this.bootLive(b); return; }
    if (was === 'live') return; // unload() mounts what comes next once the page is copied
    this.show(b);
  }

  /** What a non-live artboard shows for its tier. */
  private show(b: BoardState): void {
    const slot = this.slots.get(b.id);
    if (!slot) return;
    if (b.tier === 'still') { this.mountStill(b); return; }
    this.dropFrames(slot);
    if (b.tier === 'image') this.mountImage(b);
    else this.dropImage(slot);
  }

  // ---------- live ----------

  private bootLive(b: BoardState): void {
    const slot = this.slots.get(b.id);
    const page = this.compile?.pages.get(b.page);
    if (!slot || !page || !this.compile) return;
    if (slot.boot) this.forget(slot.boot);
    slot.boot?.remove();
    const frame = this.newFrame(b, PREVIEW_SANDBOX);
    frame.style.opacity = '0';
    slot.el.appendChild(frame);
    slot.boot = frame;
    b.booting = true;
    const loadId = this.nextLoad++;
    const doc = canvasDocument({ page: b.page, html: page.html, blobUrls: this.compile.blobUrls, mode: 'live', deviceHeight: b.devH, loadId, overrides: this.overrides });
    this.register(frame, { board: b.id, role: 'live', loadId, doc, compile: this.compile, ov: this.overridesTag });
    frame.srcdoc = previewShellHtml(loadId);
    this.opts.callbacks?.onChange?.();
  }

  /** The live frame said it is ready: it takes over from whatever was shown. */
  private liveReady(b: BoardState, frame: HTMLIFrameElement, height: number): void {
    const slot = this.slots.get(b.id);
    if (!slot || slot.boot !== frame) return;
    this.dropFrames(slot, frame);
    this.dropImage(slot);
    slot.boot = null;
    slot.frame = frame;
    slot.frameMode = 'live';
    slot.stillOf = null;
    frame.style.opacity = '';
    b.booting = false;
    this.setHeight(b, height);
    if (b.fields) this.postTo(frame, { type: 'canvas:fields', kept: b.fields });
    this.catchUp(frame);
    if (this.interactive) this.postTo(frame, { type: 'canvas:interact', on: true });
    this.warm.set(b.id, performance.now() + WARM_MS);
    const timer = setTimeout(() => { this.warmTimers.delete(timer); this.pace(); }, WARM_MS + 20);
    this.warmTimers.add(timer);
    this.pace();
    this.opts.callbacks?.onFrameReady?.(b.id);
    this.opts.callbacks?.onChange?.();
  }

  /** A live page whose source changed loads again, its typed values and current look carried over. */
  private async reloadLive(b: BoardState): Promise<void> {
    const slot = this.slots.get(b.id);
    if (slot?.frame && slot.frameMode === 'live') {
      const frozen = await this.askFrame<{ html: string; fields: Kept }>(slot.frame, { type: 'canvas:freeze' }, FREEZE_TIMEOUT_MS);
      if (frozen) b.fields = frozen.fields;
    }
    if (b.tier === 'live') this.bootLive(b);
  }

  /**
   * A live page leaving: its DOM as it is becomes the still (typed values written in), its fields are
   * kept for when it loads again, and the frame goes.
   */
  private async unload(b: BoardState): Promise<void> {
    const slot = this.slots.get(b.id);
    if (slot?.boot) { this.forget(slot.boot); slot.boot.remove(); slot.boot = null; b.booting = false; }
    if (slot?.frame && slot.frameMode === 'live' && this.compile) {
      // The copy is of the page the frame was built with, which may be an older compile's than the one
      // held: its files and its signature, so a page changed since is settled again.
      const built = (slot.frame.contentWindow && this.frames.get(slot.frame.contentWindow)?.compile) || this.compile;
      const frozen = await this.askFrame<{ html: string; fields: Kept; height: number }>(slot.frame, { type: 'canvas:freeze' }, FREEZE_TIMEOUT_MS);
      if (frozen && typeof frozen.html === 'string') {
        b.snapshot = toAssetTokens(frozen.html, built.blobUrls);
        b.snapVer = built.pages.get(b.page)?.signature ?? '';
        b.fields = frozen.fields;
        b.thumbVer = '';
        if (typeof frozen.height === 'number') this.setHeight(b, frozen.height);
      }
    }
    if (b.tier === 'live') return; // came back while it was being copied
    // Becoming a still, the live frame stays on show until the still is ready (`stillReady` drops it);
    // anything else replaces it at once.
    if (slot) this.show(b);
    this.opts.callbacks?.onChange?.();
  }

  private pace(): void {
    const now = performance.now();
    for (const [id, slot] of this.slots) {
      if (slot.frameMode !== 'live' || !slot.frame) continue;
      const paused = id !== this.awake && id !== this.focus && now >= (this.warm.get(id) ?? 0);
      this.postTo(slot.frame, { type: 'canvas:pace', paused });
    }
  }

  // ---------- stills and thumbnails ----------

  private mountStill(b: BoardState): void {
    const slot = this.slots.get(b.id);
    if (!slot || !b.snapshot || !this.compile) return;
    if (slot.stillOf === b.snapshot) return;
    const frame = this.newFrame(b, PREVIEW_SANDBOX);
    const loadId = this.nextLoad++;
    const doc = canvasDocument({ page: b.page, html: b.snapshot, blobUrls: this.compile.blobUrls, mode: 'still', deviceHeight: b.devH, loadId, nonce: newNonce(), overrides: this.overrides });
    // Whatever is shown stays until this is ready, so nothing flashes.
    frame.style.opacity = '0';
    slot.el.appendChild(frame);
    this.register(frame, { board: b.id, role: 'still', loadId, doc, compile: this.compile, ov: this.overridesTag, snapshot: b.snapshot });
    frame.srcdoc = previewShellHtml(loadId);
    slot.stillOf = b.snapshot;
  }

  private stillReady(b: BoardState, frame: HTMLIFrameElement, record: FrameRecord, height: number): void {
    const slot = this.slots.get(b.id);
    // Gone live again while it loaded: the live page has it, and a later still mounts afresh.
    if (!slot || b.tier !== 'still') {
      this.forget(frame);
      frame.remove();
      if (slot && slot.stillOf === record.snapshot) slot.stillOf = null;
      return;
    }
    // A still of a newer snapshot is loading, and takes over when it is ready.
    if (record.snapshot !== slot.stillOf) { this.forget(frame); frame.remove(); return; }
    this.dropFrames(slot, frame);
    this.dropImage(slot);
    slot.frame = frame;
    slot.frameMode = 'still';
    frame.style.opacity = '';
    this.setHeight(b, height);
    this.catchUp(frame);
    this.opts.callbacks?.onFrameReady?.(b.id);
    this.opts.callbacks?.onChange?.();
  }

  private mountImage(b: BoardState): void {
    const slot = this.slots.get(b.id);
    if (!slot || !b.thumb) return;
    if (slot.img && slot.img.src === b.thumb) return;
    const img = slot.img ?? document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;object-position:top;pointer-events:none';
    img.src = b.thumb;
    if (!slot.img) { slot.el.appendChild(img); slot.img = img; }
  }

  // ---------- background jobs ----------

  private scheduleJobs(): void {
    if (this.jobRunning || this.jobTimer || !this.active || !this.compile) return;
    const wait = Math.max(50, IDLE_MS - (performance.now() - this.lastInput));
    this.jobTimer = setTimeout(() => { this.jobTimer = null; void this.runJob(); }, wait);
  }

  private nextJob(): BoardState | null {
    const compile = this.compile;
    if (!compile) return null;
    const sig = (b: BoardState) => compile.pages.get(b.page)?.signature ?? '';
    const needsSettle = (b: BoardState) => b.tier !== 'live' && compile.pages.has(b.page) && b.snapVer !== sig(b);
    const needsThumb = (b: BoardState) => b.thumbVer !== this.thumbSig(b) && compile.pages.has(b.page);
    const order = [...this.near.flatMap((id) => this.boards.get(id) ?? []),
      ...[...this.boards.values()].sort((a, b) => Math.abs(a.x - this.view.x) - Math.abs(b.x - this.view.x))];
    // Nearest first, whichever it needs. A thumbnail comes from a settle, so one that is out of date
    // is a reason to settle again, but only where it would be shown: zoomed out, or nothing else to show.
    const wantsThumb = (b: BoardState) => b.tier === 'image' || b.tier === 'placeholder' || this.z < this.budget.zLive * 1.6;
    return order.find((b) => needsSettle(b) || (needsThumb(b) && wantsThumb(b))) ?? null;
  }

  private async runJob(): Promise<void> {
    if (this.destroyed || !this.active) return;
    if (performance.now() - this.lastInput < IDLE_MS) { this.scheduleJobs(); return; }
    const b = this.nextJob();
    if (!b) return;
    // The version being settled: one that changes meanwhile is settled again, even when this one fails.
    const signature = this.compile?.pages.get(b.page)?.signature ?? '';
    const thumbSig = this.thumbSig(b);
    this.jobRunning = true;
    try {
      await this.settle(b);
    } catch (err) {
      if (this.destroyed) return;
      // A page that will not settle is shown live or as a placeholder; the next compile tries again.
      b.snapVer = signature;
      b.thumbVer = thumbSig;
      logger.warn(`[Canvas] Could not settle ${b.page} at ${b.w} px:`, err);
    } finally {
      this.jobRunning = false;
    }
    this.update();
  }

  /**
   * Whether the project's pages, as far as they have settled, are mostly drawn by their scripts
   * (`mostlyDrawn`): one measure a page, whichever of its widths settled first.
   */
  drawnByScript(): boolean {
    const pages = new Map<string, Traced>();
    for (const b of this.boards.values()) if (b.traced && !pages.has(b.page)) pages.set(b.page, b.traced);
    return mostlyDrawn([...pages.values()]);
  }

  /** Settle a page in the job frame at its device size: its DOM after its scripts ran, and a thumbnail of it. */
  private async settle(b: BoardState): Promise<void> {
    const compile = this.compile;
    const page = compile?.pages.get(b.page);
    if (!compile || !page) return;
    const signature = page.signature;
    const thumbSig = this.thumbSig(b);
    const frame = this.jobFrameFor(b.w, b.devH);
    const loadId = this.nextLoad++;
    const doc = canvasDocument({ page: b.page, html: page.html, blobUrls: compile.blobUrls, mode: 'settle', deviceHeight: b.devH, loadId, overrides: this.overrides });
    try {
      const settled = await new Promise<{ html: string; height: number; traced?: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => { this.replies.delete(-loadId); reject(new Error('settle timed out')); }, SETTLE_TIMEOUT_MS);
        this.replies.set(-loadId, { win: frame.contentWindow, take: (data) => { clearTimeout(timer); resolve(data as unknown as { html: string; height: number; traced?: unknown }); } });
        this.register(frame, { board: null, role: 'job', loadId, doc, compile, ov: this.overridesTag });
        frame.srcdoc = previewShellHtml(loadId);
      });
      if (this.compile !== compile) return;
      b.traced = readTraced(settled.traced);
      if (b.tier !== 'live' || !b.snapshot) {
        b.snapshot = toAssetTokens(settled.html, compile.blobUrls);
        b.snapVer = signature;
        this.setHeight(b, settled.height);
      }
      if (b.thumbVer !== thumbSig) {
        try {
          frame.style.height = `${settled.height}px`;
          // The settle already waited for the page to go quiet; waiting again for fonts and images from
          // the network could take longer than the whole capture is given.
          const bitmap = await requestFrameCapture(frame, { captureWidth: b.w, captureHeight: settled.height, fullPage: true, waitForContent: false, minWaitDelay: 0, scale: THUMB_SCALE }, 10000);
          const blob = await bitmapToJpeg(bitmap);
          // An artboard removed meanwhile, or an engine gone, would never revoke the URL.
          if (!this.destroyed && this.boards.get(b.id) === b) {
            if (b.thumb) URL.revokeObjectURL(b.thumb);
            b.thumb = URL.createObjectURL(blob);
          }
          b.thumbVer = thumbSig;
          void this.opts.thumbs?.put(b.page, b.device, thumbSig, blob);
        } catch (err) {
          // Marked as taken, so this version of the page is not tried again.
          b.thumbVer = thumbSig;
          logger.warn(`[Canvas] Could not take a thumbnail of ${b.page} at ${b.w} px:`, err);
        }
      }
    } finally {
      // Blank the frame so the page's scripts stop, whether it settled, timed out or went out of date.
      this.forget(frame);
      frame.srcdoc = '';
    }
  }

  private jobFrameFor(w: number, h: number): HTMLIFrameElement {
    if (!this.jobFrame) {
      this.jobFrame = createSandboxedFrame(PROJECT_SANDBOX);
      this.jobFrame.setAttribute('aria-hidden', 'true');
      this.jobFrame.tabIndex = -1;
      this.jobFrame.style.cssText = 'position:fixed;left:-20000px;top:0;border:0;pointer-events:none;visibility:hidden';
      (this.opts.jobHost ?? document.body).appendChild(this.jobFrame);
    }
    this.jobFrame.style.width = `${w}px`;
    this.jobFrame.style.height = `${h}px`;
    return this.jobFrame;
  }

  // ---------- frames ----------

  private newFrame(b: BoardState, sandbox: typeof PREVIEW_SANDBOX): HTMLIFrameElement {
    const frame = createSandboxedFrame(sandbox);
    frame.setAttribute('scrolling', 'no');
    frame.tabIndex = -1;
    frame.style.cssText = `position:absolute;left:0;top:0;border:0;display:block;background:#fff;width:${b.w}px;height:${b.h}px`;
    return frame;
  }

  private register(frame: HTMLIFrameElement, record: FrameRecord): void {
    // The window outlives a srcdoc change, so a frame reused for another load is found by its loadId.
    const win = frame.contentWindow;
    if (win) this.frames.set(win, record);
    else queueMicrotask(() => { if (frame.contentWindow) this.frames.set(frame.contentWindow, record); });
  }

  private forget(frame: HTMLIFrameElement): void {
    if (frame.contentWindow) this.frames.delete(frame.contentWindow);
  }

  private frameOf(win: Window): HTMLIFrameElement | null {
    if (this.jobFrame?.contentWindow === win) return this.jobFrame;
    for (const slot of this.slots.values()) {
      for (const f of [slot.frame, slot.boot]) if (f && f.contentWindow === win) return f;
      for (const f of slot.el.querySelectorAll('iframe')) if (f.contentWindow === win) return f;
    }
    return null;
  }

  private dropFrames(slot: Slot, keep?: HTMLIFrameElement): void {
    for (const f of slot.el.querySelectorAll('iframe')) {
      if (f === keep || f === slot.boot) continue;
      this.forget(f);
      f.remove();
    }
    if (slot.frame !== keep) { slot.frame = null; slot.frameMode = null; slot.stillOf = keep ? slot.stillOf : null; }
  }

  private dropImage(slot: Slot): void {
    slot.img?.remove();
    slot.img = null;
  }

  private clearSlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    for (const f of slot.el.querySelectorAll('iframe')) { this.forget(f); f.remove(); }
    slot.frame = slot.boot = null;
    slot.frameMode = null;
    slot.stillOf = null;
    this.dropImage(slot);
    const b = this.boards.get(id);
    if (b) b.booting = false;
  }

  private setHeight(b: BoardState, height: number): void {
    if (!Number.isFinite(height) || height <= 0) return;
    const h = Math.max(b.devH, Math.round(height));
    b.measured = true;
    if (Math.abs(h - b.h) < 1) return;
    b.h = h;
    const slot = this.slots.get(b.id);
    if (slot) for (const f of slot.el.querySelectorAll('iframe')) f.style.height = `${h}px`;
    this.opts.callbacks?.onChange?.();
  }

  private postTo(frame: HTMLIFrameElement, message: Record<string, unknown>): void {
    frame.contentWindow?.postMessage(message, '*');
  }

  private askFrame<T>(frame: HTMLIFrameElement, message: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
    const reqId = this.nextReq++;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => { this.replies.delete(reqId); resolve(null); }, timeoutMs);
      this.replies.set(reqId, { win: frame.contentWindow, take: (data) => { clearTimeout(timer); resolve(data as T); } });
      this.postTo(frame, { ...message, reqId });
    });
  }

  private onMessage = (event: MessageEvent): void => {
    const win = event.source as Window | null;
    if (!win) return;
    const record = this.frames.get(win);
    if (!record) return;
    const data = event.data as { type?: string; loadId?: number; reqId?: number; [key: string]: unknown } | null;
    if (!data || typeof data.type !== 'string') return;
    const frame = this.frameOf(win);
    if (!frame) return;

    if (data.type === 'preview:shell-ready') {
      if (data.loadId !== record.loadId) return;
      const storage = record.role === 'still' ? undefined : this.opts.storage?.();
      let cache = this.shellCaches.get(record.compile);
      if (!cache) { cache = new Map(); this.shellCaches.set(record.compile, cache); }
      void sendShellContent(win, record.loadId, record.doc, record.compile.blobUrls.values(), cache, storage).catch((err) => {
        logger.error('[Canvas] Could not send a page to its frame:', err);
      });
      return;
    }
    if (data.type === 'preview:function-call') {
      // Answered as Live Preview answers them, unless the frame has loaded another document since.
      void answerFunctionCall(data as unknown as FunctionCall, this.opts.deploymentId?.(), win, () => this.frames.get(win)?.loadId ?? -1).catch((err) => {
        logger.error('[Canvas] Could not answer a function call from a page:', err);
      });
      return;
    }
    if (data.type === 'preview:shell-error') {
      // The failure is this frame's alone, settles included: its artboard stays as it was, or loading.
      logger.error('[Canvas] A frame could not build its page:', data.error);
      return;
    }
    if (data.type === 'canvas:settled') {
      // Only the load the job frame is on now: a page whose settle timed out can still answer while
      // the next page loads in the same frame.
      if (record.role !== 'job' || data.loadId !== record.loadId) return;
      const reply = this.replies.get(-record.loadId);
      this.replies.delete(-record.loadId);
      reply?.take(data);
      return;
    }
    if ((data.type === 'canvas:picked' || data.type === 'canvas:described' || data.type === 'canvas:frozen' || data.type === 'canvas:dropped') && typeof data.reqId === 'number') {
      // Only from the frame asked, and never for a settle: every frame runs a page's scripts, which can post these.
      const reply = data.reqId > 0 ? this.replies.get(data.reqId) : undefined;
      if (!reply || reply.win !== win) return;
      this.replies.delete(data.reqId);
      reply.take(data);
      return;
    }
    const b = record.board ? this.boards.get(record.board) : undefined;
    if (!b) return;
    switch (data.type) {
      case 'canvas:traced':
        if (record.role === 'live') {
          b.traced = readTraced(data.traced);
          this.opts.callbacks?.onChange?.();
        }
        break;
      case 'canvas:ready':
        if (record.role === 'live') this.liveReady(b, frame, Number(data.height));
        else if (record.role === 'still') this.stillReady(b, frame, record, Number(data.height));
        return;
      case 'canvas:height':
        if (this.slots.get(b.id)?.frame === frame) this.setHeight(b, Number(data.height));
        return;
      case 'canvas:rects': {
        const reported = readRects(data);
        if (reported && this.slots.get(b.id)?.frame === frame) this.opts.callbacks?.onRects?.(b.id, reported.rects, reported.metrics);
        return;
      }
      case 'canvas:awake':
        this.setAwake(b.id);
        return;
      case 'canvas:wheel': {
        const wheel = readWheel(data);
        if (wheel) this.opts.callbacks?.onWheel?.(b.id, wheel);
        return;
      }
      case 'canvas:key':
        this.opts.callbacks?.onKey?.(b.id, String(data.key));
        return;
      case 'preview:ready':
      case 'preview:scroll':
      case 'preview:storage':
      case 'console':
      case 'error':
        // Live Preview reports these for the same page in its own frame: reported from here too, they would show twice.
        return;
      default:
        if (this.slots.get(b.id)?.frame === frame) this.opts.callbacks?.onFrameMessage?.(b.id, data as { type: string });
    }
  };
}

// A frame's reports are read before they reach the panel: the frame runs the page's scripts, which
// can post the same message types with anything in them.

type Box = { x: number; y: number; w: number; h: number };

/** `value` is an object whose `keys` are all finite numbers. */
function hasNumbers<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, number> {
  return typeof value === 'object' && value !== null && keys.every((k) => Number.isFinite((value as Record<string, unknown>)[k]));
}

const isBox = (value: unknown): value is Box => hasNumbers(value, ['x', 'y', 'w', 'h']);

function isMetrics(value: unknown): value is SelectionMetrics {
  if (!hasNumbers(value, ['pt', 'pr', 'pb', 'pl', 'rowGap', 'columnGap'])) return false;
  const { parentRow, tag, gap } = value as Record<string, unknown>;
  return typeof parentRow === 'boolean' && typeof tag === 'string'
    && (gap === null || (isBox(gap) && typeof (gap as Record<string, unknown>).across === 'boolean'));
}

/** A `canvas:rects`: a box or null for each element watched, and the first one's metrics or null. Null when it is not one. */
function readRects(data: Record<string, unknown>): { rects: (Box | null)[]; metrics: SelectionMetrics | null } | null {
  const { rects } = data;
  const metrics = data.metrics ?? null;
  if (!Array.isArray(rects) || !rects.every((r): r is Box | null => r === null || isBox(r))) return null;
  if (metrics !== null && !isMetrics(metrics)) return null;
  return { rects, metrics };
}

/** A `canvas:wheel`, or null when it is not one. */
function readWheel(data: Record<string, unknown>) {
  const zoom = data.zoom === true;
  if (!hasNumbers(data, ['dx', 'dy', 'deltaMode', 'x', 'y'])) return null;
  return { dx: data.dx, dy: data.dy, deltaMode: data.deltaMode, zoom, x: data.x, y: data.y };
}

async function bitmapToJpeg(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('no thumbnail');
  return blob;
}
