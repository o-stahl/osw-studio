import { randomUUID } from 'crypto';
import { eventBus } from './singleton';
import type { RenderJob, RenderResult } from '@/lib/canvas/render-types';
import { parseElementTarget } from '@/lib/direct-edit/targets';

/**
 * Pages rendered for the server, by an open workspace tab: the server has no browser, so rendering
 * stays in the browser. A server run's `inspect` and `screenshot`, and
 * the MCP `preview_screenshot` tool, emit `render_requested` on the account's channel; a tab that
 * has the project claims it, renders (`lib/canvas/render-job.ts`) and posts the result back.
 *
 * Also the MCP `canvas_selection` question, which every tab answers (`selection_requested`): the
 * newest selection in a project the caller may see wins.
 *
 * Pinned to globalThis, as `agent-delegation.ts` pins its requests: the tool that opens a request
 * and the route that answers it can each get their own copy of this module.
 */

/** A tab has this long to claim a request; none that has the project means none will. */
const CLAIM_TIMEOUT_MS = 6_000;
/** After a claim: compile, settle (up to 15 s) and paint (up to 20 s). */
const RENDER_TIMEOUT_MS = 45_000;
/** Every tab answers a selection question at once; slow ones are not waited for long. */
const SELECTION_TIMEOUT_MS = 2_000;

interface PendingRender {
  userId: string;
  claimed: boolean;
  resolve: (result: RenderResult) => void;
  onClaim: () => void;
}

/** What a tab has selected, as `canvas_selection` reports it. */
export interface SelectionAnswer {
  projectId: string;
  projectName: string;
  /** Where it was picked: an artboard on Canvas, or Live Preview. */
  surface: 'canvas' | 'preview';
  page?: string;
  width?: number;
  tag: string;
  domPath: string;
  /** Its position in source, `/index.html:16:5`: what `style` and `inspect` take as the element. */
  source?: string;
  marker?: string;
  instances?: number;
  snippet: string;
  /** When it was selected, epoch ms. */
  selectedAt: number;
}

interface PendingSelection {
  userId: string;
  answers: (SelectionAnswer | null)[];
  expected: number;
  finish: () => void;
}

const g = globalThis as unknown as { __oswRenders?: Map<string, PendingRender>; __oswSelections?: Map<string, PendingSelection> };
g.__oswRenders ??= new Map();
g.__oswSelections ??= new Map();
const renders = g.__oswRenders;
const selections = g.__oswSelections;

const NO_TAB = 'pages are rendered in the browser, and no OSW Studio tab is open for this account. Open the workspace in a browser and try again';

export async function requestRender(userId: string, job: RenderJob): Promise<RenderResult> {
  if (!eventBus.hasListener(userId)) return { ok: false, error: NO_TAB };
  const requestId = randomUUID();
  const result = await new Promise<RenderResult>((resolve) => {
    let timer = setTimeout(() => finish({ ok: false, error: 'no open OSW Studio tab has this project. Open it in the workspace and try again' }), CLAIM_TIMEOUT_MS);
    const finish = (r: RenderResult) => {
      clearTimeout(timer);
      renders.delete(requestId);
      resolve(r);
    };
    renders.set(requestId, {
      userId,
      claimed: false,
      resolve: finish,
      onClaim: () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ ok: false, error: `the open tab did not finish rendering within ${RENDER_TIMEOUT_MS / 1000} seconds` }), RENDER_TIMEOUT_MS);
      },
    });
    eventBus.emit(`render:${requestId}`, job.projectId, 'render_requested', { requestId, job }, userId);
  });
  eventBus.clearTask(`render:${requestId}`);
  return result;
}

/** A tab taking a request, if no tab has; scoped to the account that asked. */
export function claimRenderRequest(requestId: string, userId: string): boolean {
  const entry = renders.get(requestId);
  if (!entry || entry.userId !== userId || entry.claimed) return false;
  entry.claimed = true;
  entry.onClaim();
  return true;
}

/** The claiming tab's answer. */
export function settleRenderRequest(requestId: string, userId: string, result: RenderResult): boolean {
  const entry = renders.get(requestId);
  if (!entry || entry.userId !== userId || !entry.claimed) return false;
  entry.resolve(result);
  return true;
}

/**
 * The newest selection any open tab has, in `projectId` when given; `null` when none has one.
 *
 * The account's tabs may be in other workspaces, or on a project only the browser has, so only an
 * answer whose project `inScope` accepts counts, and that is checked before the newest is chosen.
 */
export async function requestSelection(
  userId: string,
  projectId: string | null,
  inScope: (projectId: string) => Promise<boolean>,
): Promise<SelectionAnswer | null | { error: string }> {
  const expected = eventBus.listenerCount(userId);
  if (expected === 0) return { error: 'no OSW Studio tab is open for this account, so nothing is selected' };
  const requestId = randomUUID();
  const answers = await new Promise<(SelectionAnswer | null)[]>((resolve) => {
    const entry: PendingSelection = {
      userId,
      answers: [],
      expected,
      finish: () => {
        clearTimeout(timer);
        selections.delete(requestId);
        resolve(entry.answers);
      },
    };
    const timer = setTimeout(entry.finish, SELECTION_TIMEOUT_MS);
    selections.set(requestId, entry);
    eventBus.emit(`selection:${requestId}`, projectId ?? '', 'selection_requested', { requestId, projectId }, userId);
  });
  eventBus.clearTask(`selection:${requestId}`);
  const found = answers.filter((a): a is SelectionAnswer => !!a && (!projectId || a.projectId === projectId));
  for (const answer of found.sort((a, b) => b.selectedAt - a.selectedAt)) {
    if (await inScope(answer.projectId)) return answer;
  }
  return null;
}

/** One tab's answer to a selection question. */
export function answerSelectionRequest(requestId: string, userId: string, answer: SelectionAnswer | null): boolean {
  const entry = selections.get(requestId);
  if (!entry || entry.userId !== userId) return false;
  entry.answers.push(answer);
  if (entry.answers.length >= entry.expected) entry.finish();
  return true;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_IMAGES = 8;
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
const MAX_REPORT_CHARS = 2 * 1024 * 1024;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * A tab's answer as the server takes it, within size limits. A screenshot is rebuilt field by field,
 * its images base64 only. An inspect report is taken as the tab sent it, checked only for being an
 * object under {@link MAX_REPORT_CHARS}: it comes from a tab of the account that asked.
 */
export function sanitizeRenderResult(body: unknown): RenderResult {
  const r = (body ?? {}) as Record<string, unknown>;
  if (r.ok !== true) return { ok: false, error: str(r.error, 2000) || 'the tab could not render the page' };
  if (r.kind === 'inspect') {
    const report = r.report as Record<string, unknown> | undefined;
    if (!report || typeof report !== 'object' || JSON.stringify(report).length > MAX_REPORT_CHARS) return { ok: false, error: 'the tab answered with an unreadable report' };
    return { ok: true, kind: 'inspect', report: report as unknown as Extract<RenderResult, { kind: 'inspect' }>['report'] };
  }
  if (r.kind === 'screenshot' && Array.isArray(r.images) && r.images.length > 0 && r.images.length <= MAX_IMAGES) {
    const images = [];
    for (const raw of r.images as Record<string, unknown>[]) {
      const data = typeof raw?.data === 'string' ? raw.data : '';
      if (!data || data.length > MAX_IMAGE_CHARS || !BASE64.test(data)) return { ok: false, error: 'the tab answered with an unreadable image' };
      const region = (raw.region ?? {}) as Record<string, unknown>;
      images.push({
        mediaType: raw.mediaType === 'image/png' ? 'image/png' as const : 'image/jpeg' as const,
        data,
        width: num(raw.width),
        height: num(raw.height),
        region: { x: num(region.x), y: num(region.y), w: num(region.w), h: num(region.h) },
      });
    }
    return {
      ok: true,
      kind: 'screenshot',
      images,
      width: num(r.width),
      height: num(r.height),
      pageHeight: num(r.pageHeight),
      ...(typeof r.matches === 'number' ? { matches: r.matches } : {}),
      ...(r.cut === true ? { cut: true } : {}),
    };
  }
  return { ok: false, error: 'the tab answered with something other than a render' };
}

/**
 * A marker and a position go into the `restyle` command `canvas_selection` hands an agent, and both
 * come from the page, so each is kept only in the shape `style` takes: a marker id, and a position
 * in characters a file name has. A space is one of them, and the hint quotes a position that has
 * one; no quote, backslash or line break is, so nothing in it can end the quoted word.
 */
const isMarkerId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && parseElementTarget(`@${v}`).kind === 'marker';
const POSITION = /^\/[\p{L}\p{N}\p{M}._~@+/ -]+:\d+(?::\d+)?$/u;
const isPosition = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && POSITION.test(v);

/** A tab's selection as the server takes it, or `null` for none or a malformed one. */
export function sanitizeSelectionAnswer(body: unknown): SelectionAnswer | null {
  const a = (body ?? null) as Record<string, unknown> | null;
  if (!a || typeof a.projectId !== 'string' || typeof a.tag !== 'string' || typeof a.domPath !== 'string') return null;
  return {
    projectId: a.projectId.slice(0, 200),
    projectName: str(a.projectName, 200) ?? '',
    surface: a.surface === 'canvas' ? 'canvas' : 'preview',
    ...(typeof a.page === 'string' ? { page: a.page.slice(0, 500) } : {}),
    ...(typeof a.width === 'number' ? { width: Math.round(a.width) } : {}),
    tag: a.tag.slice(0, 40),
    domPath: a.domPath.slice(0, 1000),
    ...(isPosition(a.source) ? { source: a.source } : {}),
    ...(isMarkerId(a.marker) ? { marker: a.marker } : {}),
    ...(typeof a.instances === 'number' ? { instances: a.instances } : {}),
    snippet: str(a.snippet, 4000) ?? '',
    selectedAt: num(a.selectedAt),
  };
}
