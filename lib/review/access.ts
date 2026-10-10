/**
 * Who may see a review copy, and under which identity.
 *
 * A client has no account and carries only the review cookie this instance minted. A team member
 * carries the normal account session and goes through the same workspace check as every other
 * deployment-addressed route, so review adds no weaker path into a tenant's data.
 *
 * The deployment record decides whether review is open; the cookie's signature decides who the
 * caller is. Nothing the caller supplies is taken at face value.
 */

import 'server-only';

import { requireDeploymentAccess } from '@/lib/api/deployment-access';
import { getSession } from '@/lib/auth/session';
import { resolveDeployment } from '@/lib/vfs/adapters/deployment-adapter';
import type { ReviewConfig } from '@/lib/vfs/types';
import { reviewCookieName, verifyReviewSession } from './session';
import { REVIEW_AS_TEAM_HEADER } from './api-base';
import { isSiteHost, requestHost } from '@/lib/web/site-origin';

export type ReviewAccess =
  | { kind: 'participant'; participantId: string }
  /**
   * `canModerate` is a second, higher answer, not a detail of the first. Being admitted to a review
   * copy and being allowed to act as the agency inside it are different questions with different
   * bars, and one flag answering both is what let a read-only member resolve a client's comments.
   */
  | { kind: 'team'; participantId: string; userId: string; canModerate: boolean }
  | { kind: 'denied' };

/**
 * Whether this caller may act as the team: resolve and reopen comments, and be badged as the agency
 * on what they write. One expression for a question asked in four places (comment status, comment
 * authorship, the participant row's flag, and the widget's `is_team`), so they cannot drift.
 */
export function actsAsTeam(access: ReviewAccess): boolean {
  return access.kind === 'team' && access.canModerate;
}

/**
 * Anything that can produce a cookie: a NextRequest (cookie jar) or a plain Request (raw header).
 */
type CookieSource = {
  cookies?: { get(name: string): { value: string } | undefined };
  headers?: { get(name: string): string | null };
};

/**
 * More candidates than this is not a browser sending cookies, it is someone making the server work;
 * every extra one costs a signature check.
 */
const MAX_COOKIE_CANDIDATES = 8;

/**
 * Every cookie of this name, not just the first.
 *
 * Published sites are attacker-authorable HTML that can share an origin with the review copy (the
 * studio's, or a shared sites address), so a script on one can set a second `osw_review_{id}`
 * cookie of its own. Duplicate names at equal path have no defined
 * precedence, so taking the first would let that script pin a visitor to its participant id. The
 * jar is read as well, since NextRequest collapses duplicates and may hold a value the header lacks.
 */
function readCookies(request: CookieSource, name: string): string[] {
  const values: string[] = [];

  const header = request.headers?.get('cookie');
  if (header) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      if (pair.slice(0, separator).trim() !== name) continue;
      const raw = pair.slice(separator + 1).trim();
      // A cookie value is attacker-controlled and need not be valid percent-encoding. Any page on
      // this origin can set `osw_review_{id}=%`, and letting decodeURIComponent throw would turn
      // that into a 500 on every request for the victim's review copy. An undecodable value is
      // simply not a token this module minted.
      try {
        values.push(decodeURIComponent(raw));
      } catch {
        continue;
      }
    }
  }

  const fromJar = request.cookies?.get(name)?.value;
  if (fromJar && !values.includes(fromJar)) values.push(fromJar);

  return values.slice(0, MAX_COOKIE_CANDIDATES);
}

/**
 * Evaluated per request rather than once at entry, so a tab that was open when the deadline passed
 * stops working on its next call instead of running until its cookie happens to lapse.
 *
 * A deadline that will not parse is treated as closed: the alternative is serving a review copy on
 * the strength of a value nobody can interpret.
 */
export function isReviewExpired(review: ReviewConfig): boolean {
  if (!review.expiresAt) return false;
  const deadline = Date.parse(review.expiresAt);
  if (Number.isNaN(deadline)) return true;
  return deadline <= Date.now();
}

/** The first presented cookie that actually verifies for this deployment, if any. */
async function resolveParticipant(
  deploymentId: string,
  review: ReviewConfig,
  request: CookieSource
): Promise<ReviewAccess | null> {
  for (const token of readCookies(request, reviewCookieName(deploymentId))) {
    // The participant id comes out of the verified payload, never off the wire: a caller can
    // present a cookie, but only one this server signed for this deployment carries an identity.
    const session = await verifyReviewSession(token, deploymentId, review);
    if (session) return { kind: 'participant', participantId: session.participantId };
  }
  return null;
}

/**
 * Resolve who is asking for a deployment's review copy.
 *
 * Review switched off is absolute: that copy is published to nobody, team included. Expiry is not,
 * since it closes the round to the client; a workspace member still gets in afterwards to read the
 * comments and reopen it.
 *
 * The account is checked before the cookie, because a team member who went through the password gate
 * still holds a participant cookie. Reading that first would attribute their replies to an anonymous
 * id and hide what the UI shows only to the team.
 */
export async function resolveReviewAccess(
  deploymentId: string,
  request: CookieSource
): Promise<ReviewAccess> {
  const resolved = await resolveDeployment(deploymentId);
  const review = resolved?.deployment.review;
  if (!review?.enabled) return { kind: 'denied' };

  // Only worth the workspace lookup when an account session is actually present, an anonymous
  // client is the common case here, and this runs on every asset of every page they open. Never on
  // a site's host: the team acts from the studio, and the desktop app, which has no login, would
  // otherwise hand the team role to every site on its shared sites port.
  const host = request.headers ? requestHost(request.headers) : '';
  const account = host && isSiteHost(host) ? null : await getSession();
  if (account) {
    const access = await requireDeploymentAccess(deploymentId, 'viewer');
    if (access.ok) {
      // Asked again at the higher bar rather than by reading the caller's role here, because
      // requireDeploymentAccess is where the cases that break hand-rolled role logic already live:
      // instance admins bypass unconditionally, so do the legacy admin/desktop/instance-api ids,
      // and a deployment with no routing row has no workspace to hold a role at all.
      //
      // Cheap enough to run on every request: the deployment's routing row is cached, and what is
      // left is a primary-key read on an already-open SQLite handle plus one workspace_access row.
      // Marked a probe because a refusal here is the answer, not an incident, see deployment-access.
      const moderator = await requireDeploymentAccess(deploymentId, 'editor', { probe: true });

      // Prefixed so a team member's attributions can never collide with a minted participant id.
      return {
        kind: 'team',
        participantId: `user:${account.userId}`,
        userId: account.userId,
        canModerate: moderator.ok,
      };
    }
  }

  if (isReviewExpired(review)) return { kind: 'denied' };

  return (await resolveParticipant(deploymentId, review, request)) ?? { kind: 'denied' };
}

/**
 * For a request that asked to act as the team (`REVIEW_AS_TEAM_HEADER`): 401 when there is no
 * account session, 403 when it would otherwise act as a client participant. Null otherwise, so a
 * review copy that is not open still answers 404 to a signed-in member.
 */
export async function teamAccessRefusal(
  request: CookieSource,
  access: ReviewAccess
): Promise<401 | 403 | null> {
  if (request.headers?.get(REVIEW_AS_TEAM_HEADER) !== 'team') return null;
  if (access.kind === 'team') return null;
  if (!(await getSession())) return 401;
  return access.kind === 'participant' ? 403 : null;
}
