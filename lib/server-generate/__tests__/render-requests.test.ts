import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
import { eventBus } from '../singleton';
import {
  requestRender, claimRenderRequest, settleRenderRequest,
  requestSelection, answerSelectionRequest, sanitizeRenderResult, sanitizeSelectionAnswer,
  type SelectionAnswer,
} from '../render-requests';

/**
 * Rendering and selections asked of the account's open tabs: one tab renders (the first to claim),
 * every tab answers a selection question, and the newest selection wins. Each request belongs to
 * the account that made it.
 */

const JOB = { kind: 'inspect' as const, projectId: 'p1', page: '/', width: 1440 };
type Listener = (e: { id: number; event: string; data: Record<string, unknown> }) => void;
const listeners: { user: string; fn: Listener }[] = [];

/** A tab for `user` that hands each event it gets to `on`. */
function tab(user: string, on: (e: { event: string; data: Record<string, unknown> }) => void) {
  const fn: Listener = (e) => on(e);
  eventBus.addListener(user, fn);
  listeners.push({ user, fn });
}

afterEach(() => {
  for (const { user, fn } of listeners.splice(0)) eventBus.removeListener(user, fn);
  vi.useRealTimers();
});

describe('requestRender', () => {
  it('says so at once when no tab is open', async () => {
    expect(await requestRender('nobody', JOB)).toEqual({ ok: false, error: expect.stringContaining('no OSW Studio tab is open') });
  });

  it('takes the answer of the one tab that claimed it', async () => {
    const claims: boolean[] = [];
    tab('u1', (e) => {
      if (e.event !== 'render_requested') return;
      const id = e.data.requestId as string;
      claims.push(claimRenderRequest(id, 'u1'), claimRenderRequest(id, 'u1'));
      expect(settleRenderRequest(id, 'u2', { ok: false, error: 'not yours' })).toBe(false);
      settleRenderRequest(id, 'u1', { ok: false, error: 'rendered' });
    });
    expect(await requestRender('u1', JOB)).toEqual({ ok: false, error: 'rendered' });
    expect(claims).toEqual([true, false]);
  });

  it('gives up when no tab claims it', async () => {
    vi.useFakeTimers();
    tab('u3', () => {});
    const pending = requestRender('u3', JOB);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await pending).toEqual({ ok: false, error: expect.stringContaining('no open OSW Studio tab has this project') });
  });

  it('refuses a claim from another account', async () => {
    let refused: boolean | null = null;
    tab('u4', (e) => {
      if (e.event !== 'render_requested') return;
      refused = !claimRenderRequest(e.data.requestId as string, 'someone-else');
      claimRenderRequest(e.data.requestId as string, 'u4');
      settleRenderRequest(e.data.requestId as string, 'u4', { ok: false, error: 'x' });
    });
    await requestRender('u4', JOB);
    expect(refused).toBe(true);
  });
});

describe('requestSelection', () => {
  const answer = (projectId: string, selectedAt: number): SelectionAnswer => ({
    projectId, projectName: 'P', surface: 'canvas', tag: 'h1', domPath: 'body > h1', snippet: '<h1>', selectedAt,
  });
  const anyProject = async () => true;

  it('asks every tab and takes the newest selection', async () => {
    for (const [n, at] of [[1, 100], [2, 300], [3, 0]] as const) {
      tab('u5', (e) => {
        if (e.event !== 'selection_requested') return;
        answerSelectionRequest(e.data.requestId as string, 'u5', at ? answer(`p${n}`, at) : null);
      });
    }
    expect(await requestSelection('u5', null, anyProject)).toMatchObject({ projectId: 'p2', selectedAt: 300 });
  });

  it('keeps to one project when asked, and answers null for none', async () => {
    tab('u6', (e) => {
      if (e.event === 'selection_requested') answerSelectionRequest(e.data.requestId as string, 'u6', answer('p1', 5));
    });
    expect(await requestSelection('u6', 'p2', anyProject)).toBeNull();
  });

  it('takes the newest selection in scope, passing over a newer one outside it', async () => {
    for (const [n, at] of [[1, 100], [2, 300]] as const) {
      tab('u7', (e) => {
        if (e.event === 'selection_requested') answerSelectionRequest(e.data.requestId as string, 'u7', answer(`p${n}`, at));
      });
    }
    expect(await requestSelection('u7', null, async (id) => id === 'p1')).toMatchObject({ projectId: 'p1', selectedAt: 100 });
    expect(await requestSelection('u7', null, async () => false)).toBeNull();
  });

  it('says so when no tab is open', async () => {
    expect(await requestSelection('nobody', null, anyProject)).toEqual({ error: expect.stringContaining('no OSW Studio tab is open') });
  });
});

describe('what the server takes from a tab', () => {
  it("keeps a screenshot's images and drops anything else on them", () => {
    const result = sanitizeRenderResult({ ok: true, kind: 'screenshot', width: 375, height: 667, pageHeight: 900, images: [{ data: 'QUJD', width: 375, height: 667, region: { x: 0, y: 0, w: 375, h: 667 }, extra: 'no' }] });
    expect(result).toEqual({ ok: true, kind: 'screenshot', width: 375, height: 667, pageHeight: 900, images: [{ mediaType: 'image/jpeg', data: 'QUJD', width: 375, height: 667, region: { x: 0, y: 0, w: 375, h: 667 } }] });
  });

  it('keeps a PNG a saved screenshot asked for, and reads any other type as JPEG', () => {
    const image = (mediaType: unknown) => ({ mediaType, data: 'QUJD', width: 1, height: 1, region: { x: 0, y: 0, w: 1, h: 1 } });
    const types = (answer: unknown) => {
      const result = sanitizeRenderResult(answer);
      return result.ok && result.kind === 'screenshot' ? result.images.map((i) => i.mediaType) : null;
    };
    expect(types({ ok: true, kind: 'screenshot', images: [image('image/png'), image('image/svg+xml'), image(undefined)] }))
      .toEqual(['image/png', 'image/jpeg', 'image/jpeg']);
  });

  it('refuses an image that is not base64, and an answer that is not a render', () => {
    expect(sanitizeRenderResult({ ok: true, kind: 'screenshot', images: [{ data: '<svg onload=x>' }] })).toEqual({ ok: false, error: 'the tab answered with an unreadable image' });
    expect(sanitizeRenderResult({ ok: true, kind: 'shell' })).toMatchObject({ ok: false });
    expect(sanitizeRenderResult({ ok: false, error: 'x'.repeat(5000) })).toMatchObject({ ok: false, error: 'x'.repeat(2000) });
  });

  it('takes a selection only with its project, tag and path', () => {
    expect(sanitizeSelectionAnswer({ projectId: 'p', tag: 'h1' })).toBeNull();
    expect(sanitizeSelectionAnswer({ projectId: 'p', tag: 'h1', domPath: 'body > h1', snippet: 'x'.repeat(9000), surface: 'elsewhere', selectedAt: 7 }))
      .toMatchObject({ surface: 'preview', snippet: 'x'.repeat(4000), selectedAt: 7 });
  });

  it('keeps a marker only when it is a marker id, and a source only when it is a position', () => {
    const base = { projectId: 'p', tag: 'h1', domPath: 'body > h1', snippet: '<h1>' };
    expect(sanitizeSelectionAnswer({ ...base, marker: 'h7x2m4qp', source: '/index.html:16:5' }))
      .toMatchObject({ marker: 'h7x2m4qp', source: '/index.html:16:5' });
    expect(sanitizeSelectionAnswer({ ...base, source: '/pages/about.html:3' })).toMatchObject({ source: '/pages/about.html:3' });

    const hostile = sanitizeSelectionAnswer({ ...base, marker: 'x; rm -r /assets; echo', source: '/index.html; rm -r /:1:1' });
    expect(hostile).not.toHaveProperty('marker');
    expect(hostile).not.toHaveProperty('source');
    for (const source of ['index.html:1', '/index.html', '/index.html:x', '/a.html:1\nrm /b', "/a'b.html:1", '/a"b.html:1', '/a\\b.html:1', '/a\tb.html:1', '/a$(x).html:1']) {
      expect(sanitizeSelectionAnswer({ ...base, source }), source).not.toHaveProperty('source');
    }
  });

  it('keeps a source whose file name has a space, as the project may name a file', () => {
    const base = { projectId: 'p', tag: 'h1', domPath: 'body > h1', snippet: '<h1>' };
    expect(sanitizeSelectionAnswer({ ...base, source: '/blog posts/first post.html:3:5' }))
      .toMatchObject({ source: '/blog posts/first post.html:3:5' });
  });

  it('caps the project id as it caps the other strings', () => {
    expect(sanitizeSelectionAnswer({ projectId: 'p'.repeat(5000), tag: 'h1', domPath: 'body > h1' })?.projectId.length).toBeLessThanOrEqual(200);
  });
});
