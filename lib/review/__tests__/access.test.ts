import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Who gets into a review copy, and under which identity. The client never gets a vote: the
 * participant id comes out of a signed cookie the server minted, and a team member is recognised
 * only through the same workspace check the rest of the deployment routes use.
 */

const mocks = vi.hoisted(() => ({
  resolveDeployment: vi.fn(),
  requireDeploymentAccess: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/vfs/adapters/deployment-adapter', () => ({ resolveDeployment: mocks.resolveDeployment }));
vi.mock('@/lib/api/deployment-access', () => ({ requireDeploymentAccess: mocks.requireDeploymentAccess }));
vi.mock('@/lib/auth/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/utils', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const DEPLOYMENT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const DEPLOYMENT_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const OPEN = { enabled: true };

async function load() {
  vi.resetModules();
  const [access, session] = await Promise.all([import('../access'), import('../session')]);
  return { ...access, ...session };
}

function deploymentWithReview(review: unknown) {
  return { deployment: { id: DEPLOYMENT_A, name: 'Site', review }, workspaceId: 'ws-1', adapter: {} };
}

/** Stands in for a NextRequest: only the cookie jar is read. */
function requestWithCookies(jar: Record<string, string>) {
  return {
    cookies: {
      get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
    },
  };
}

/** A raw Request, which is how duplicate cookies of the same name can be presented at all. */
function requestWithCookieHeader(header: string) {
  return new Request(`https://example.test/review/${DEPLOYMENT_A}`, { headers: { cookie: header } });
}

const NO_TEAM_ACCESS = { ok: false as const, response: new Response(null, { status: 401 }) };
const TEAM_SESSION = { userId: 'user-7', email: 'a@b.c', isAdmin: false, exp: 0 };
const TEAM_ACCESS = {
  ok: true,
  context: { deployment: { id: DEPLOYMENT_A }, workspaceId: 'ws-1' },
};

function signedInAsTeam() {
  mocks.getSession.mockResolvedValue(TEAM_SESSION);
  mocks.requireDeploymentAccess.mockResolvedValue(TEAM_ACCESS);
}

/** Signed in with workspace access that clears `granted` but nothing above it. */
function signedInWithRole(granted: 'viewer' | 'editor') {
  mocks.getSession.mockResolvedValue(TEAM_SESSION);
  mocks.requireDeploymentAccess.mockImplementation(async (_id: string, role: string) =>
    role === 'viewer' || role === granted ? TEAM_ACCESS : NO_TEAM_ACCESS
  );
}

describe('resolveReviewAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SESSION_SECRET', 'test-review-secret-value');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getSession.mockResolvedValue(null);
    mocks.requireDeploymentAccess.mockResolvedValue(NO_TEAM_ACCESS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('admits a cookie holder as a participant', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const result = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookies({ [cookie.name]: cookie.value })
    );

    expect(result).toEqual({ kind: 'participant', participantId: cookie.participantId });
    // An anonymous client should not be costing a workspace lookup on every asset.
    expect(mocks.requireDeploymentAccess).not.toHaveBeenCalled();
  });

  it('denies when review is not enabled on the deployment', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview({ enabled: false }));

    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const result = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookies({ [cookie.name]: cookie.value })
    );

    expect(result).toEqual({ kind: 'denied' });
  });

  it('denies when the deployment does not exist', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(null);

    expect(await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}))).toEqual({ kind: 'denied' });
  });

  it('denies a cookie holder once the review has expired', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    const review = { enabled: true, expiresAt: new Date(NOW + 3_600_000).toISOString() };
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(review));

    const cookie = await mintReviewCookie(DEPLOYMENT_A, review);
    const request = requestWithCookies({ [cookie.name]: cookie.value });

    expect(await resolveReviewAccess(DEPLOYMENT_A, request)).toMatchObject({ kind: 'participant' });

    // The same still-held cookie, one second past the deadline: expiry is re-checked per call so
    // an already-open tab stops working rather than riding out its cookie.
    vi.setSystemTime(NOW + 3_600_001);
    expect(await resolveReviewAccess(DEPLOYMENT_A, request)).toEqual({ kind: 'denied' });
  });

  it('stops honouring a cookie once the review password is changed', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    const before = { enabled: true, passwordHash: '$2b$12$abcdefghijklmnopqrstuvFirstHash000000000000' };
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(before));

    const cookie = await mintReviewCookie(DEPLOYMENT_A, before);
    const request = requestWithCookies({ [cookie.name]: cookie.value });
    expect(await resolveReviewAccess(DEPLOYMENT_A, request)).toMatchObject({ kind: 'participant' });

    // Changing the password is how an agency cuts a client off mid-round; it has to bite.
    mocks.resolveDeployment.mockResolvedValue(
      deploymentWithReview({ enabled: true, passwordHash: '$2b$12$abcdefghijklmnopqrstuvSecondHash11111111111' })
    );
    expect(await resolveReviewAccess(DEPLOYMENT_A, request)).toEqual({ kind: 'denied' });
  });

  it('admits a signed-in team member with no cookie at all', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));
    signedInAsTeam();

    const result = await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}));

    expect(result).toEqual({
      kind: 'team', participantId: 'user:user-7', userId: 'user-7', canModerate: true,
    });
    expect(mocks.requireDeploymentAccess).toHaveBeenCalledWith(DEPLOYMENT_A, 'viewer');
  });

  it('prefers the account over a participant cookie when both are present', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));
    signedInAsTeam();

    // A team member who once went through the password gate is still holding a participant cookie;
    // their comments belong to their account, not to the anonymous id it carries.
    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const result = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookies({ [cookie.name]: cookie.value })
    );

    expect(result).toEqual({
      kind: 'team', participantId: 'user:user-7', userId: 'user-7', canModerate: true,
    });
  });

  it('falls back to the cookie when the account has no claim on the deployment', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));
    // Signed in to this instance, but into somebody else's workspace.
    mocks.getSession.mockResolvedValue({ ...TEAM_SESSION, userId: 'outsider' });
    mocks.requireDeploymentAccess.mockResolvedValue(NO_TEAM_ACCESS);

    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const result = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookies({ [cookie.name]: cookie.value })
    );

    expect(result).toEqual({ kind: 'participant', participantId: cookie.participantId });
  });

  it('still admits a team member after the review has expired', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(
      deploymentWithReview({ enabled: true, expiresAt: new Date(NOW - 1000).toISOString() })
    );
    signedInAsTeam();

    // Expiry closes the round to the client; it is not the owner locking themselves out.
    expect(await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}))).toEqual({
      kind: 'team',
      participantId: 'user:user-7',
      userId: 'user-7',
      canModerate: true,
    });
  });

  it('admits a read-only workspace member but does not let them act as the team', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));
    signedInWithRole('viewer');

    const result = await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}));

    // Viewer is the right bar for reading a review copy and the wrong one for resolving comments
    // or replying in the agency's name, so the two questions are asked separately.
    expect(result).toEqual({
      kind: 'team', participantId: 'user:user-7', userId: 'user-7', canModerate: false,
    });
    expect(mocks.requireDeploymentAccess).toHaveBeenCalledWith(DEPLOYMENT_A, 'viewer');
    // Probed, so a read-only member browsing a review copy does not file a denial warning per asset.
    expect(mocks.requireDeploymentAccess).toHaveBeenCalledWith(DEPLOYMENT_A, 'editor', { probe: true });
  });

  it('reports moderation for a member who clears editor', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));
    signedInWithRole('editor');

    expect(await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}))).toEqual({
      kind: 'team', participantId: 'user:user-7', userId: 'user-7', canModerate: true,
    });
  });

  it('denies a team member when review was never enabled', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(undefined));
    signedInAsTeam();

    expect(await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}))).toEqual({ kind: 'denied' });
  });

  it('denies a cookie minted for another deployment', async () => {
    const { resolveReviewAccess, mintReviewCookie, reviewCookieName } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    const other = await mintReviewCookie(DEPLOYMENT_B, OPEN);

    // Presented both under this deployment's cookie name and under its own.
    expect(
      await resolveReviewAccess(
        DEPLOYMENT_A,
        requestWithCookies({ [reviewCookieName(DEPLOYMENT_A)]: other.value })
      )
    ).toEqual({ kind: 'denied' });
    expect(
      await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({ [other.name]: other.value }))
    ).toEqual({ kind: 'denied' });
  });

  it('denies a caller with no credential of any kind', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    expect(await resolveReviewAccess(DEPLOYMENT_A, requestWithCookies({}))).toEqual({ kind: 'denied' });
  });

  it('ignores a participant id swapped into an otherwise valid cookie', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    // A real header and a real signature, with somebody else's identity in the body — the shape a
    // client would actually reach for, and the one a missing signature check would let through.
    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const [header, , signature] = cookie.value.split('.');
    const body = Buffer.from(
      JSON.stringify({
        deploymentId: DEPLOYMENT_A,
        participantId: 'someone-elses-id',
        purpose: 'review',
        exp: 9_999_999_999,
      })
    ).toString('base64url');

    expect(
      await resolveReviewAccess(
        DEPLOYMENT_A,
        requestWithCookies({ [cookie.name]: `${header}.${body}.${signature}` })
      )
    ).toEqual({ kind: 'denied' });
  });

  it('reads the cookie from a raw request header when there is no cookie jar', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);

    expect(
      await resolveReviewAccess(
        DEPLOYMENT_A,
        requestWithCookieHeader(`other=1; ${cookie.name}=${cookie.value}`)
      )
    ).toEqual({ kind: 'participant', participantId: cookie.participantId });
  });

  it('is not pinned by a shadowing duplicate cookie of the same name', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    const mine = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const foreign = await mintReviewCookie(DEPLOYMENT_B, OPEN);

    // Published sites are attacker-authorable HTML on this same origin, so a script there can add a
    // second cookie of this name at this path. Duplicates have no defined precedence, so every
    // candidate is tried rather than only whichever the browser happened to send first.
    const shadowed = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookieHeader(`${mine.name}=not-a-token; ${mine.name}=${mine.value}`)
    );
    expect(shadowed).toEqual({ kind: 'participant', participantId: mine.participantId });

    const withForeign = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookieHeader(`${mine.name}=${foreign.value}; ${mine.name}=${mine.value}`)
    );
    expect(withForeign).toEqual({ kind: 'participant', participantId: mine.participantId });
  });
});

describe('isReviewExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a missing expiry as open and an unparseable one as closed', async () => {
    const { isReviewExpired } = await load();

    expect(isReviewExpired({ enabled: true })).toBe(false);
    expect(isReviewExpired({ enabled: true, expiresAt: new Date(NOW + 1000).toISOString() })).toBe(false);
    expect(isReviewExpired({ enabled: true, expiresAt: new Date(NOW - 1000).toISOString() })).toBe(true);
    expect(isReviewExpired({ enabled: true, expiresAt: 'nonsense' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A cookie value is attacker-controlled text, not necessarily valid encoding
// ---------------------------------------------------------------------------

describe('a malformed review cookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SESSION_SECRET', 'test-review-secret-value');
    mocks.getSession.mockResolvedValue(null);
    mocks.requireDeploymentAccess.mockResolvedValue(NO_TEAM_ACCESS);
  });

  /**
   * Any page on this origin — including a published deployment, which is attacker-authorable HTML —
   * can set `osw_review_{id}=%`. That is not valid percent-encoding, so decoding it throws, and an
   * uncaught throw here reaches the route catch as a 500 on every request for the victim's review
   * copy: a one-line denial of service against someone else's review round.
   */
  it('is ignored rather than throwing', async () => {
    const { resolveReviewAccess } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    const result = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookieHeader(`osw_review_${DEPLOYMENT_A}=%`)
    );

    expect(result).toEqual({ kind: 'denied' });
  });

  it('does not stop a valid cookie presented alongside it', async () => {
    const { resolveReviewAccess, mintReviewCookie } = await load();
    mocks.resolveDeployment.mockResolvedValue(deploymentWithReview(OPEN));

    const cookie = await mintReviewCookie(DEPLOYMENT_A, OPEN);
    const result = await resolveReviewAccess(
      DEPLOYMENT_A,
      requestWithCookieHeader(`${cookie.name}=%; ${cookie.name}=${cookie.value}`)
    );

    expect(result).toEqual({ kind: 'participant', participantId: cookie.participantId });
  });
});

describe('teamAccessRefusal', () => {
  const asTeam = { headers: new Headers({ 'X-OSW-Review-As': 'team' }) };
  const participant = { kind: 'participant' as const, participantId: 'p-1' };
  const team = { kind: 'team' as const, participantId: 'user:user-7', userId: 'user-7', canModerate: true };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
  });

  it('refuses an expired account session that fell back to a participant cookie with 401', async () => {
    const { teamAccessRefusal } = await load();
    expect(await teamAccessRefusal(asTeam, participant)).toBe(401);
  });

  it('refuses a signed-in account with no team access that would act as a participant with 403', async () => {
    const { teamAccessRefusal } = await load();
    mocks.getSession.mockResolvedValue(TEAM_SESSION);
    expect(await teamAccessRefusal(asTeam, participant)).toBe(403);
  });

  it('leaves a signed-in member facing a closed review copy to the 404', async () => {
    const { teamAccessRefusal } = await load();
    mocks.getSession.mockResolvedValue(TEAM_SESSION);
    expect(await teamAccessRefusal(asTeam, { kind: 'denied' })).toBeNull();
  });

  it('passes team access, and requests that did not ask to act as the team', async () => {
    const { teamAccessRefusal } = await load();
    expect(await teamAccessRefusal(asTeam, team)).toBeNull();
    expect(await teamAccessRefusal({ headers: new Headers() }, participant)).toBeNull();
  });
});
