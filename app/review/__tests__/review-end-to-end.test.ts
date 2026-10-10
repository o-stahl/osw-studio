import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import { REVIEW_WIDGET_MARKER } from '@/lib/publishing/review-widget';
import { REVIEW_AS_TEAM_HEADER, reviewApiBase } from '@/lib/review/api-base';
import {
  reviewAssetRateLimitKey,
  reviewAssetRateLimiter,
  reviewCommentListRateLimitKey,
  reviewCommentListRateLimiter,
} from '@/lib/review/read-gate';
import { MAX_LISTED_COMMENTS } from '@/lib/review/comment-view';
import { RATE_LIMIT_CONFIG, getIdentifier } from '@/lib/analytics/rate-limiter';
import { reviewCookieName } from '@/lib/review/session';
import { hashPassword } from '@/lib/auth/passwords';
import { getWorkspaceAdapter, closeWorkspaceAdapter } from '@/lib/vfs/adapters/server';
import {
  closeSystemDatabase,
  createUser,
  createWorkspace,
  grantWorkspaceAccess,
  updateUser,
} from '@/lib/auth/system-database';
import { closeReviewDatabase } from '@/lib/vfs/adapters/sqlite-connection';
import type { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';
import type { Deployment, ReviewConfig, VirtualFile } from '@/lib/vfs/types';

/**
 * Publish → serve → comment, end to end.
 *
 * Every piece of review mode has unit tests, but the wiring between them had never run: the routes
 * were exercised only on their refusal paths, so no test had ever taken a cookie the entry route
 * minted and used it to fetch an asset, or written a comment through the API and read it back.
 * That seam — a real build on disk, a real signed cookie, a real per-deployment database — is what
 * this file drives.
 *
 * Three things are stubbed, and only three:
 *  - `server-only`, which is a bundler guard rather than behaviour;
 *  - `resolveDeployment`, so lookups land on a temp workspace instead of the system database;
 *  - `getSession`, so the caller is an anonymous visitor rather than a signed-in team member.
 *
 * Everything between them is the shipping code. `requireDeploymentAccess` runs for real (the
 * deployment resolves with no routing row, the legacy single-workspace shape it already allows),
 * as do the builder, the cookie minting and verification, the filesystem reads, the origin check,
 * the rate limiters and the SQLite writes.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveDeployment: vi.fn(),
}));

// Marked 'server-only' for the bundler; the guard has to be neutralised to load it under vitest.
vi.mock('server-only', () => ({}));

// The caller is anonymous unless a test says otherwise. The real getSession reads next/headers,
// which has no request scope here.
vi.mock('@/lib/auth/session', () => ({ getSession: mocks.getSession }));

// Points deployment lookups at the temp workspace adapter instead of the system database's
// deployment_routing table.
vi.mock('@/lib/vfs/adapters/deployment-adapter', () => ({
  resolveDeployment: mocks.resolveDeployment,
}));

import { GET as reviewEntry, POST as reviewSubmitPassword } from '../[deploymentId]/route';
import { GET as reviewAsset } from '../[deploymentId]/[...path]/route';
import {
  GET as listComments,
  POST as createComment,
} from '../[deploymentId]/osw-api/comments/route';
import { PATCH as patchComment } from '../[deploymentId]/osw-api/comments/[id]/route';
import { PATCH as patchParticipant } from '../[deploymentId]/osw-api/participant/route';

const ORIGIN = 'http://localhost:3000';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6, 5, 4]);
const HTML =
  '<html><head><title>Home</title><link rel="stylesheet" href="/styles/main.css"></head>' +
  '<body><h1>Reviewed site</h1><img src="/logo.png"></body></html>';
const PASSWORD = 'correct horse battery staple';

let dir: string;
let workspaceId: string;
let deploymentId: string;
let adapter: SQLiteAdapter;
/**
 * What the deployment's routing row says, as `requireDeploymentAccess` will read it. Null is the
 * legacy single-workspace shape, in which any authenticated caller is already the owner; a test
 * that cares about roles points this at a workspace in the temp system database instead.
 */
let routedWorkspaceId: string | null = null;

async function addFile(filePath: string, content: string | ArrayBuffer, type: string) {
  await adapter.createFile({
    id: `f-${filePath}`, projectId: 'p1', path: filePath, name: filePath.slice(1),
    type, content, size: 16, createdAt: new Date(), updatedAt: new Date(),
  } as VirtualFile);
}

/** Create the deployment with the given review settings and run a real publish. */
async function publish(review: ReviewConfig) {
  await adapter.createDeployment({
    id: deploymentId, projectId: 'p1', name: 'Reviewed', review,
    createdAt: new Date(), updatedAt: new Date(),
  } as Deployment);

  const { buildStaticDeployment } = await import('@/lib/compiler/static-builder');
  const result = await buildStaticDeployment(deploymentId, workspaceId);
  expect(result.success).toBe(true);
}

/** Change review settings after publish, the way the owner closing a round would. */
async function setReview(review: ReviewConfig) {
  const deployment = await adapter.getDeployment(deploymentId);
  await adapter.updateDeployment({ ...deployment!, review });
}

const publicDir = () => path.join(dir, 'static', deploymentId);
const reviewDir = () => path.join(dir, 'deployments', deploymentId, 'review-build');
const readBuilt = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf-8');

interface TestRequestInit {
  method?: string;
  body?: BodyInit;
  headers?: HeadersInit;
  /** Sent as the Cookie header, the way a browser would. */
  cookie?: string;
}

function request(url: string, init: TestRequestInit = {}): NextRequest {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(url, { ...rest, headers });
}

/** The `name=value` pair a browser would send back, taken from the response's real Set-Cookie. */
function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('response carried no Set-Cookie');

  const name = reviewCookieName(deploymentId);
  const pair = header
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`));
  if (!pair) throw new Error(`no ${name} cookie in: ${header}`);

  return pair.split(';')[0];
}

/**
 * RFC 6265 §5.1.4 path-match, so a test can ask what a browser would actually send rather than
 * handing every request a cookie the browser may have scoped away.
 */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** The Cookie header a browser would send to `requestPath`, given a response's Set-Cookie. */
function browserCookieHeader(response: Response, requestPath: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const sent: string[] = [];

  for (const raw of header.split(/,(?=\s*[^;=\s]+=)/)) {
    const [pair, ...attributes] = raw.trim().split(';');
    const pathAttribute = attributes
      .map(attribute => attribute.trim())
      .find(attribute => attribute.toLowerCase().startsWith('path='));
    const cookiePath = pathAttribute ? pathAttribute.slice('path='.length) : '/';
    if (pathMatches(cookiePath, requestPath)) sent.push(pair);
  }

  return sent.join('; ');
}

const entry = (cookie?: string) =>
  reviewEntry(request(`${ORIGIN}/review/${deploymentId}`, { cookie }), {
    params: Promise.resolve({ deploymentId }),
  });

const asset = (segments: string[], cookie?: string) =>
  reviewAsset(request(`${ORIGIN}/review/${deploymentId}/${segments.join('/')}`, { cookie }), {
    params: Promise.resolve({ deploymentId, path: segments }),
  });

function post(body: unknown, cookie: string, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return createComment(
    request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, {
      method: 'POST', body: JSON.stringify(body), headers, cookie,
    }),
    { params: Promise.resolve({ deploymentId }) }
  );
}

beforeEach(async () => {
  vi.clearAllMocks();

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-review-e2e-'));
  // Fresh ids per test, because the adapter and the review-database connection are both cached in
  // module scope by id — reusing one would hand the next test a handle onto a deleted temp file.
  workspaceId = randomUUID();
  deploymentId = randomUUID();

  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  vi.stubEnv('DEPLOYMENTS_DIR', path.join(dir, 'deployments'));
  vi.stubEnv('DEPLOYMENTS_STATIC_DIR', path.join(dir, 'static'));
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-for-review-end-to-end');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);

  adapter = getWorkspaceAdapter(workspaceId);
  await adapter.init();

  await adapter.createProject({
    id: 'p1', name: 'Reviewed', createdAt: new Date(), updatedAt: new Date(),
    settings: { runtime: 'static' },
  } as never);
  await addFile('/index.html', HTML, 'html');
  await addFile('/styles/main.css', 'body { color: red }', 'css');
  await addFile('/logo.png', PNG.buffer.slice(0) as ArrayBuffer, 'image');

  routedWorkspaceId = null;
  mocks.getSession.mockResolvedValue(null);
  // Re-read on every call so a mid-test change to the review settings is what the routes see,
  // exactly as a fresh database read would be in production.
  mocks.resolveDeployment.mockImplementation(async (id: string) => {
    const deployment = await adapter.getDeployment(id);
    // See routedWorkspaceId.
    return deployment ? { adapter, deployment, workspaceId: routedWorkspaceId } : null;
  });
});

afterEach(async () => {
  closeReviewDatabase(deploymentId);
  closeWorkspaceAdapter(workspaceId);
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('review mode — build', () => {
  it('writes a widget-bearing review copy alongside a clean public one', async () => {
    await publish({ enabled: true });

    const review = readBuilt(reviewDir(), 'index.html');
    expect(review).toContain(REVIEW_WIDGET_MARKER);
    expect(readBuilt(publicDir(), 'index.html')).not.toContain(REVIEW_WIDGET_MARKER);

    // Assets in the review copy are addressed through the gated route, not the public web root.
    expect(review).toContain(`/review/${deploymentId}/styles/main.css`);
    expect(review).toContain(`/review/${deploymentId}/logo.png`);
  });
});

describe('review mode — serve', () => {
  it('admits an anonymous visitor of an open review and mints a session', async () => {
    await publish({ enabled: true });

    const response = await entry();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('Reviewed site');
    expect(response.headers.get('set-cookie')).toContain(reviewCookieName(deploymentId));
  });

  it('serves an asset to the cookie the entry route just handed out', async () => {
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());

    const response = await asset(['styles', 'main.css'], cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css');
    // Compared against the built file rather than the source, since publishing minifies.
    expect(await response.text()).toBe(readBuilt(reviewDir(), 'styles/main.css'));
  });

  it('refuses the same asset to a caller with no cookie', async () => {
    await publish({ enabled: true });

    const response = await asset(['styles', 'main.css']);

    expect(response.status).toBe(404);
  });

  it('rate limits asset serving per caller and per deployment', async () => {
    // Every request here resolves a deployment and reads a file, on a URL that is not a secret and
    // that is served no-store — so it is refetched on every navigation and cannot be left unbounded.
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());

    // Control: the asset serves before the budget is spent, so the 429 below is the limit.
    expect((await asset(['styles', 'main.css'], cookie)).status).toBe(200);

    const spend = (id: string) => {
      const key = reviewAssetRateLimitKey(getIdentifier(request(`${ORIGIN}/review/${id}/x`)), id);
      for (let n = 0; n < RATE_LIMIT_CONFIG.reviewAsset.limit; n++) {
        reviewAssetRateLimiter.check(key, RATE_LIMIT_CONFIG.reviewAsset);
      }
    };

    // A different deployment first: its budget must not be the one that runs out below.
    spend(randomUUID());
    expect((await asset(['styles', 'main.css'], cookie)).status).toBe(200);

    spend(deploymentId);

    const blocked = await asset(['styles', 'main.css'], cookie);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });
});

describe('review mode — comments', () => {
  async function admitted(): Promise<string> {
    await publish({ enabled: true });
    return cookieFrom(await entry());
  }

  it('creates a comment for the participant in the cookie', async () => {
    const cookie = await admitted();

    const response = await post({ body: 'The hero image is stretched', page_path: '/index.html' }, cookie);

    expect(response.status).toBe(201);
    const { comment } = await response.json();
    expect(comment.body).toBe('The hero image is stretched');
    expect(comment.page_path).toBe('/index.html');
    expect(comment.is_team).toBe(false);
  });

  it('refuses a team reply whose account session expired instead of posting it as the client', async () => {
    // The browser also holds a participant cookie, from opening the review copy as a client once.
    const cookie = await admitted();

    const response = await createComment(
      request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: 'Fixed in the next build', page_path: '/index.html' }),
        headers: { 'content-type': 'application/json', origin: ORIGIN, [REVIEW_AS_TEAM_HEADER]: 'team' },
        cookie,
      }),
      { params: Promise.resolve({ deploymentId }) }
    );

    expect(response.status).toBe(401);
    const listed = await listComments(request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { cookie }), {
      params: Promise.resolve({ deploymentId }),
    });
    expect((await listed.json()).comments).toEqual([]);
  });

  it('carries the session on the widget call a browser would actually make', async () => {
    // The tests around this one hand the cookie to the API by hand, which is not what happens in a
    // browser. The widget is served inside `/review/{id}/...` and calls the base in
    // lib/review/api-base.ts, while the session cookie is minted with `path: /review/{id}`
    // (lib/review/session.ts). Anything outside that prefix — `/api/review/{id}/comments`, where
    // these endpoints used to live — does not path-match, so the browser scopes the cookie away
    // from the one endpoint that needs it and every client comment arrives anonymous.
    await publish({ enabled: true });
    const admission = await entry();

    // Control on the helper: the same Set-Cookie does reach the review copy's own paths, so a
    // failure below is the scoping and not a mis-parsed header.
    expect(browserCookieHeader(admission, `/review/${deploymentId}/styles/main.css`)).toContain(
      reviewCookieName(deploymentId)
    );

    const apiPath = `${reviewApiBase(deploymentId)}/comments`;
    const cookie = browserCookieHeader(admission, apiPath);

    const response = await post({ body: 'Sent by the widget', page_path: '/index.html' }, cookie);

    expect(response.status).toBe(201);
  });

  it('refuses a comment posted from another origin', async () => {
    // Control for the test above: it proves the accepted POST was accepted on its origin and not
    // because the check is inert. A published site is attacker-authorable HTML on this same
    // instance, so the visitor's cookie is sent whether or not the page is the review copy.
    const cookie = await admitted();

    const response = await post(
      { body: 'posted by a page the visitor did not open', page_path: '/index.html' },
      cookie,
      'https://evil.example'
    );

    expect(response.status).toBe(403);
  });

  it('refuses a comment posted from another tenant on this instance', async () => {
    // The case a shared analytics allowlist misses. `*.{appHost}` is on it, because every published
    // deployment posts its own pageviews from its slug subdomain — and a slug subdomain is
    // same-site with the app, so SameSite=Lax still sends the review cookie. A tenant who can
    // publish could otherwise forge a comment for any visitor holding one, on any deployment id
    // they can read out of a published page.
    const cookie = await admitted();

    // The app is on a real host for this test; the wildcard is only added for a non-localhost one.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oswstudio.com');

    const forged = await post(
      { body: 'signed in the visitor name', page_path: '/index.html' },
      cookie,
      'https://tenant.oswstudio.com'
    );
    expect(forged.status).toBe(403);

    // Control: the same POST on the app's own origin still works, so the refusal above is the host
    // and not the environment change.
    const genuine = await post(
      { body: 'typed by the visitor', page_path: '/index.html' },
      cookie,
      'https://oswstudio.com'
    );
    expect(genuine.status).toBe(201);
  });

  it('refuses a participant rename posted from another tenant on this instance', async () => {
    const cookie = await admitted();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oswstudio.com');

    const rename = (origin: string) =>
      patchParticipant(
        request(`${ORIGIN}${reviewApiBase(deploymentId)}/participant`, {
          method: 'PATCH',
          body: JSON.stringify({ display_name: 'Renamed' }),
          headers: { 'content-type': 'application/json', origin },
          cookie,
        }),
        { params: Promise.resolve({ deploymentId }) }
      );

    expect((await rename('https://tenant.oswstudio.com')).status).toBe(403);
    expect((await rename('https://oswstudio.com')).status).toBe(200);
  });

  it('refuses a resolve posted from another tenant on this instance', async () => {
    const cookie = await admitted();
    const created = await post({ body: 'Typo in the footer', page_path: '/index.html' }, cookie);
    const { comment } = await created.json();

    mocks.getSession.mockResolvedValue({
      userId: 'u1', email: 'agency@example.com', isAdmin: false, exp: 253402300799,
    });
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oswstudio.com');

    const resolve = (origin: string) =>
      patchComment(
        request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments/${comment.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'resolved' }),
          headers: { 'content-type': 'application/json', origin },
          cookie,
        }),
        { params: Promise.resolve({ deploymentId, id: comment.id }) }
      );

    // A team member's account session is SameSite=Lax too, and this is the one review write that
    // can close a client's comment.
    expect((await resolve('https://tenant.oswstudio.com')).status).toBe(403);
    expect((await resolve('https://oswstudio.com')).status).toBe(200);
  });

  it('reads the comment back without any email on the wire', async () => {
    const cookie = await admitted();
    await post({ body: 'Needs a wider margin', page_path: '/index.html' }, cookie);

    // Stored so the digest mailer can reach them — and so the redaction below has something to hide.
    const named = await patchParticipant(
      request(`${ORIGIN}${reviewApiBase(deploymentId)}/participant`, {
        method: 'PATCH',
        body: JSON.stringify({ display_name: 'Dana', email: 'dana@client.example' }),
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        cookie,
      }),
      { params: Promise.resolve({ deploymentId }) }
    );
    expect(named.status).toBe(200);

    // Positive control: the address really is in the deployment's database, so the absence of it
    // below is redaction rather than the PATCH having quietly dropped it.
    const { participant } = await named.json();
    const { ReviewDatabase } = await import('@/lib/vfs/adapters/review-database');
    const stored = new ReviewDatabase(deploymentId);
    stored.init();
    expect(stored.getParticipant(participant.id)?.email).toBe('dana@client.example');

    const response = await listComments(
      request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { cookie }),
      { params: Promise.resolve({ deploymentId }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).toBe('Needs a wider margin');

    // Serialised whole, so a leak through a field nobody expected is caught too.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('dana@client.example');
    expect(serialised).not.toMatch(/"[a-z_]*email[a-z_]*"\s*:/i);
  });

  it('lets only a team member resolve a comment', async () => {
    const cookie = await admitted();
    const created = await post({ body: 'Typo in the footer', page_path: '/index.html' }, cookie);
    const { comment } = await created.json();

    const patch = () =>
      patchComment(
        request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments/${comment.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'resolved' }),
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          cookie,
        }),
        { params: Promise.resolve({ deploymentId, id: comment.id }) }
      );

    expect((await patch()).status).toBe(403);

    mocks.getSession.mockResolvedValue({
      userId: 'u1', email: 'agency@example.com', isAdmin: false, exp: 253402300799,
    });

    const allowed = await patch();
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).comment.status).toBe('resolved');
  });
});

describe('review mode — on a sites address', () => {
  // With SITES_ORIGIN set, the review copy is served from the sites address, not the studio. The
  // account session is never consulted there (on desktop it answers for anyone), so a client is
  // admitted on the cookie alone and comments as a participant.
  const SITES = 'http://localhost:3001';
  const onSites = (url: string, init: TestRequestInit = {}) =>
    request(`${SITES}${url}`, { ...init, headers: { ...init.headers as Record<string, string>, host: 'localhost:3001' } });

  beforeEach(() => {
    vi.stubEnv('SITES_ORIGIN', SITES);
    // Signed in, as the desktop app always is: none of it may turn the visitor into the team here.
    mocks.getSession.mockResolvedValue({ userId: 'user-1', email: 'a@b.c', isAdmin: false, exp: 0 });
  });

  it('admits a client, takes their comment and reads it back', async () => {
    await publish({ enabled: true });
    const params = { params: Promise.resolve({ deploymentId }) };

    const admission = await reviewEntry(onSites(`/review/${deploymentId}`), params);
    expect(admission.status).toBe(200);
    const cookie = cookieFrom(admission);

    const created = await createComment(
      onSites(`${reviewApiBase(deploymentId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: 'Logo is too small', page_path: '/index.html' }),
        headers: { 'content-type': 'application/json', origin: SITES },
        cookie,
      }),
      params
    );
    expect(created.status).toBe(201);
    expect((await created.json()).comment.is_team).toBe(false);

    const listed = await listComments(onSites(`${reviewApiBase(deploymentId)}/comments`, { cookie }), params);
    expect(listed.status).toBe(200);
    const { comments } = await listed.json();
    expect(comments.map((comment: { body: string }) => comment.body)).toEqual(['Logo is too small']);
  });

  it('refuses the same visitor without the cookie, signed in or not', async () => {
    await publish({ enabled: true });

    const response = await reviewAsset(
      onSites(`/review/${deploymentId}/styles/main.css`),
      { params: Promise.resolve({ deploymentId, path: ['styles', 'main.css'] }) }
    );

    expect(response.status).toBe(404);
  });
});

/**
 * Roles, against a real system database.
 *
 * `requireDeploymentAccess` is the only authorisation function in play here, and it is the real
 * one: the routing row points at a workspace in the temp system database, so `verifyWorkspaceAccess`
 * reads real `workspace_access` rows and the instance-admin bypass is the shipping bypass rather
 * than a mock's idea of one.
 */
describe('review mode — team authority', () => {
  type Role = 'viewer' | 'editor' | 'owner' | 'admin';

  /** Put a real user of the given role behind the session, on a real routed workspace. */
  function signInWithRole(role: Role): string {
    const ownerId = createUser(`owner-${randomUUID()}@example.com`, 'not-a-real-hash');
    routedWorkspaceId = createWorkspace('Agency', ownerId);

    let userId = ownerId;
    if (role !== 'owner') {
      userId = createUser(`${role}-${randomUUID()}@example.com`, 'not-a-real-hash');
      // An instance admin deliberately gets no workspace_access row: the bypass is the thing under
      // test, and granting one would hide it.
      if (role !== 'admin') grantWorkspaceAccess(userId, routedWorkspaceId, role);
      else updateUser(userId, { is_admin: 1 });
    }

    mocks.getSession.mockResolvedValue({
      userId, email: `${role}@example.com`, isAdmin: role === 'admin', exp: 253402300799,
    });
    return userId;
  }

  /** A client comment for the team to act on, posted before anyone signs in. */
  async function clientComment(): Promise<{ id: string; cookie: string }> {
    // Anonymous again: the entry route mints a participant cookie only for a caller with no
    // account, and a case that signed in earlier would otherwise get none.
    mocks.getSession.mockResolvedValue(null);
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());
    const created = await post({ body: 'The footer is cut off', page_path: '/index.html' }, cookie);
    expect(created.status).toBe(201);
    return { id: (await created.json()).comment.id, cookie };
  }

  const resolve = (id: string) =>
    patchComment(
      request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'resolved' }),
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      }),
      { params: Promise.resolve({ deploymentId, id }) }
    );

  const list = (cookie?: string) =>
    listComments(request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { cookie }), {
      params: Promise.resolve({ deploymentId }),
    });

  describe('a request that asks to act as the team but can only be a client', () => {
    // The studio's review panel sends REVIEW_AS_TEAM_HEADER. If its account session has lapsed, or
    // the account has no claim here, the browser's participant cookie would otherwise quietly turn
    // the panel into a client: listing as one, and failing a resolve as if the team may not.
    const asTeam = { [REVIEW_AS_TEAM_HEADER]: 'team' };

    const listAsTeam = (cookie: string) =>
      listComments(
        request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { headers: asTeam, cookie }),
        { params: Promise.resolve({ deploymentId }) }
      );

    const resolveAsTeam = (id: string, cookie: string) =>
      patchComment(
        request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'resolved' }),
          headers: { 'content-type': 'application/json', origin: ORIGIN, ...asTeam },
          cookie,
        }),
        { params: Promise.resolve({ deploymentId, id }) }
      );

    it('is told 401 when there is no account session', async () => {
      const { id, cookie } = await clientComment();

      expect((await listAsTeam(cookie)).status).toBe(401);
      expect((await resolveAsTeam(id, cookie)).status).toBe(401);
      // Control: without the header the same cookie lists as the client it is.
      expect((await list(cookie)).status).toBe(200);
    });

    it('is told 403 when the account has no claim on the deployment', async () => {
      const { id, cookie } = await clientComment();
      const ownerId = createUser(`owner-${randomUUID()}@example.com`, 'not-a-real-hash');
      routedWorkspaceId = createWorkspace('Agency', ownerId);
      const outsider = createUser(`outsider-${randomUUID()}@example.com`, 'not-a-real-hash');
      mocks.getSession.mockResolvedValue({
        userId: outsider, email: 'outsider@example.com', isAdmin: false, exp: 253402300799,
      });

      expect((await listAsTeam(cookie)).status).toBe(403);
      const refused = await resolveAsTeam(id, cookie);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'Forbidden' });
    });
  });

  it('refuses a resolve from a workspace member who may only view', async () => {
    const { id } = await clientComment();
    signInWithRole('viewer');

    const response = await resolve(id);

    expect(response.status).toBe(403);
    expect((await list()).status).toBe(200);
    const payload = await (await list()).json();
    expect(payload.comments[0].status).toBe('open');
  });

  it('lets an editor, an owner and an instance admin resolve', async () => {
    for (const role of ['editor', 'owner', 'admin'] as Role[]) {
      const { id } = await clientComment();
      signInWithRole(role);

      const response = await resolve(id);
      expect(response.status, `${role} should be able to resolve`).toBe(200);
      expect((await response.json()).comment.status).toBe('resolved');

      // Each role gets its own deployment and review database, since the ones above are cached by
      // id for the life of the test file.
      closeReviewDatabase(deploymentId);
      deploymentId = randomUUID();
    }
  });

  it('does not badge a viewer-level member comment as the team', async () => {
    await clientComment();
    signInWithRole('viewer');

    const response = await post({ body: 'Agreed, that needs fixing', page_path: '/index.html' }, '');

    // Commenting is legitimate for a viewer; speaking as the agency is not.
    expect(response.status).toBe(201);
    expect((await response.json()).comment.is_team).toBe(false);
  });

  it('still lets a viewer read the review copy and its comments', async () => {
    await clientComment();
    signInWithRole('viewer');

    // The obvious over-correction: locking viewers out of the thing a viewer role exists to allow.
    expect((await entry()).status).toBe(200);
    expect((await asset(['styles', 'main.css'])).status).toBe(200);

    const response = await list();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.comments).toHaveLength(1);
    // The flag the widget keys the resolve control off, so it must read as authority, not access.
    expect(payload.viewer.is_team).toBe(false);
  });

  it('badges an editor comment as the team', async () => {
    // Control for the two tests above: the badge is withheld by role, not by a broken team path.
    await clientComment();
    signInWithRole('editor');

    const response = await post({ body: 'On it', page_path: '/index.html' }, '');

    expect(response.status).toBe(201);
    expect((await response.json()).comment.is_team).toBe(true);
  });
});

describe('review mode — listing comments', () => {
  it('rate limits the comment list per caller and per deployment', async () => {
    // The list resolves the deployment, opens its database and reads every comment, for a caller
    // who has proven nothing yet, on a deployment id that is printed in every published page.
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());

    const list = () =>
      listComments(request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { cookie }), {
        params: Promise.resolve({ deploymentId }),
      });

    // Control: the list answers before the budget is spent, so the 429 below is the limit.
    expect((await list()).status).toBe(200);

    const spend = (id: string) => {
      const key = reviewCommentListRateLimitKey(
        getIdentifier(request(`${ORIGIN}/review/${id}/x`)),
        id
      );
      for (let n = 0; n < RATE_LIMIT_CONFIG.reviewCommentList.limit; n++) {
        reviewCommentListRateLimiter.check(key, RATE_LIMIT_CONFIG.reviewCommentList);
      }
    };

    // A different deployment first: hammering one agency's review copy must not close another's.
    spend(randomUUID());
    expect((await list()).status).toBe(200);

    spend(deploymentId);

    const blocked = await list();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('caps the list at the most recent comments and says that it did', async () => {
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());

    const { ReviewDatabase } = await import('@/lib/vfs/adapters/review-database');
    const db = new ReviewDatabase(deploymentId);
    db.init();
    const overCap = MAX_LISTED_COMMENTS + 5;
    for (let n = 0; n < overCap; n++) {
      db.createComment({
        participantId: 'p-flood', authorName: 'Flood', pagePath: '/index.html', body: `#${n}`,
      });
    }

    const response = await listComments(
      request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { cookie }),
      { params: Promise.resolve({ deploymentId }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.comments).toHaveLength(MAX_LISTED_COMMENTS);
    // A silent cap reads as "these are all the comments" when it is not.
    expect(payload.truncated).toBe(true);
    expect(payload.total).toBe(overCap);
    // The most recent ones, and still oldest-first within the page the caller got.
    expect(payload.comments[payload.comments.length - 1].body).toBe(`#${overCap - 1}`);
    expect(payload.comments[0].body).toBe(`#${overCap - MAX_LISTED_COMMENTS}`);
  });

  it('reports no truncation on a list that fits', async () => {
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());
    await post({ body: 'One comment', page_path: '/index.html' }, cookie);

    const response = await listComments(
      request(`${ORIGIN}${reviewApiBase(deploymentId)}/comments`, { cookie }),
      { params: Promise.resolve({ deploymentId }) }
    );

    const payload = await response.json();
    expect(payload.truncated).toBe(false);
    expect(payload.total).toBe(1);
  });
});

describe('review mode — refusals', () => {
  it('gates a password-protected review and opens it on the right password', async () => {
    await publish({ enabled: true, passwordHash: await hashPassword(PASSWORD) });

    const gate = await entry();
    expect(gate.status).toBe(200);
    const gateHtml = await gate.text();
    expect(gateHtml).toContain('name="password"');
    // The gate must not be the site, and must not be a 404 either — the client needs somewhere to
    // type the password they were sent.
    expect(gateHtml).not.toContain('Reviewed site');
    expect(gate.headers.get('set-cookie')).toBeNull();

    const submit = (password: string) => {
      const form = new FormData();
      form.set('password', password);
      return reviewSubmitPassword(
        new NextRequest(`${ORIGIN}/review/${deploymentId}`, { method: 'POST', body: form }),
        { params: Promise.resolve({ deploymentId }) }
      );
    };

    expect((await submit('not the password')).status).toBe(401);

    const accepted = await submit(PASSWORD);
    expect(accepted.status).toBe(303);

    const opened = await entry(cookieFrom(accepted));
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('Reviewed site');
  });

  it('stops answering a cookie minted before the review expired', async () => {
    await publish({ enabled: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const cookie = cookieFrom(await entry());

    // Proof the cookie was good while the round was open, so the refusals below are the expiry.
    expect((await asset(['styles', 'main.css'], cookie)).status).toBe(200);

    await setReview({ enabled: true, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    expect((await entry(cookie)).status).toBe(404);
    expect((await asset(['styles', 'main.css'], cookie)).status).toBe(404);
  });

  it('contains a traversal out of the review build', async () => {
    await publish({ enabled: true });
    const cookie = cookieFrom(await entry());

    // A sibling of the review build, inside the deployment directory: what a traversal one level
    // up would reach if the join were not contained.
    const secret = 'deployment-private-do-not-serve';
    const secretPath = path.join(dir, 'deployments', deploymentId, 'secret.txt');
    fs.writeFileSync(secretPath, secret);
    // Positive control: an uncontained join really would land on a readable file here.
    expect(fs.readFileSync(path.resolve(reviewDir(), '..', 'secret.txt'), 'utf-8')).toBe(secret);

    for (const segments of [
      ['..', 'secret.txt'],
      ['..', '..', '..', '..', 'etc', 'passwd'],
      // Next percent-decodes each segment after normalising the path, so `%2e%2e%2f` arrives here
      // as a single segment whose text is `../` — no `..` segment the router could have stripped.
      ['../secret.txt'],
      ['../../../../etc/passwd'],
    ]) {
      const response = await asset(segments, cookie);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(secret);
    }
  });
});
