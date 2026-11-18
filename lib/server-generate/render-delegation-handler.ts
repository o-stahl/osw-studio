import { vfs } from '@/lib/vfs';
import { sourceRefOf } from '@/lib/direct-edit/source-line';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';
import type { FocusTarget } from '@/lib/stores/slices/project';
import type { RenderJob, RenderResult } from '@/lib/canvas/render-types';
import type { SelectionAnswer } from './render-requests';

/**
 * Pages rendered for a server run or an MCP client, in this tab, and this tab's selection for MCP
 * `canvas_selection` (the server side is `render-requests.ts`).
 *
 * A request reaches every tab of the account. Only a tab that has the project claims a render, and
 * the first to claim renders it; it waits for pulls of the project already under way, so it renders
 * what the server has.
 */
export async function handleRenderRequested(
  data: { requestId: string; job: RenderJob },
  synced: (projectId: string) => Promise<void>,
): Promise<void> {
  const { requestId, job } = data;
  if (!job || typeof job.projectId !== 'string') return;
  try {
    await vfs.init();
    await vfs.getProject(job.projectId);
  } catch {
    return;
  }
  const claim = await fetch('/api/server-generate/render-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!claim?.granted) return;

  let result: RenderResult;
  try {
    await synced(job.projectId);
    const { renderPage } = await import('@/lib/canvas/render-job');
    result = await renderPage(job);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    await fetch('/api/server-generate/render-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, result }),
    });
  } catch {
    // The server's own timeout tells the caller.
  }
}

/** What this tab has selected, as `canvas_selection` reports it, or null. */
export async function selectionAnswer(
  projectId: string | null,
  focus: FocusTarget | null,
): Promise<SelectionAnswer | null> {
  if (!projectId || !focus) return null;
  let projectName = '';
  try { projectName = (await vfs.getProject(projectId))?.name ?? ''; } catch { /* named by id alone */ }
  const source = focus.srcAttr ? await sourceRefOf(projectId, focus.srcAttr) : null;
  const marker = focus.attributes?.[MARKER_ATTR];
  return {
    projectId,
    projectName,
    surface: focus.surface ?? 'preview',
    ...(focus.page ? { page: focus.page } : {}),
    ...(focus.viewportWidth ? { width: focus.viewportWidth } : {}),
    tag: focus.tagName,
    domPath: focus.domPath,
    ...(source ? { source } : {}),
    ...(marker ? { marker } : {}),
    ...(focus.instanceCount ? { instances: focus.instanceCount } : {}),
    snippet: focus.outerHTML.slice(0, 4000),
    selectedAt: focus.timestamp,
  };
}

/** Answer `selection_requested`: every tab answers, with its selection or with nothing. */
export async function handleSelectionRequested(
  data: { requestId: string; projectId: string | null },
  current: () => { projectId: string | null; focus: Parameters<typeof selectionAnswer>[1] },
): Promise<void> {
  const { projectId, focus } = current();
  const answer = !data.projectId || data.projectId === projectId ? await selectionAnswer(projectId, focus) : null;
  try {
    await fetch('/api/server-generate/selection-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: data.requestId, selection: answer }),
    });
  } catch {
    // The server stops waiting on its own.
  }
}
