/**
 * Review sessions for anonymous visitors of a review copy.
 *
 * A deployment id is a UUID but not a secret, and display names are typed by hand, so neither can
 * identify a commenter. Comments are attributed to a participant id the server generates and returns
 * in a signed cookie; nothing a client sends is trusted as a participant id.
 *
 * SESSION_SECRET is shared with the account session in lib/auth/session.ts, so the two token families
 * are told apart in both directions: a `purpose: 'review'` claim is required here, and verifySession
 * refuses any token carrying a `purpose` at all.
 *
 * A session also carries the deployment it was minted for and an epoch derived from the review
 * password, both checked on verify, so a cookie is worthless against another deployment and stops
 * working the moment the owner changes the gate.
 */

import { SignJWT, jwtVerify } from 'jose';

import type { ReviewConfig } from '@/lib/vfs/types';
import { secureCookies } from '@/lib/auth/secure-cookies';

/**
 * Long enough that a client working through a site over a few evenings is not asked to re-enter a
 * password, short enough that an abandoned review round eventually stops answering on its own.
 */
const REVIEW_SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

const COOKIE_PREFIX = 'osw_review_';
const REVIEW_PURPOSE = 'review';
/** Stands in for "this review has no password", so setting one is itself a change of epoch. */
const NO_PASSWORD_EPOCH = 'open';

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable not set');
  }
  return new TextEncoder().encode(secret);
}

export interface ReviewSessionData {
  deploymentId: string;
  participantId: string;
  exp: number;
}

export interface ReviewCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  maxAge: number;
  path: string;
}

export interface ReviewCookie {
  name: string;
  value: string;
  participantId: string;
  options: ReviewCookieOptions;
}

/**
 * Milliseconds the session may live: the default, or whatever is left of the review window when
 * that runs out first. A cookie outliving `review.expiresAt` would keep answering for a review the
 * owner has closed, so the deadline wins.
 */
function sessionLifetimeMs(expiresAt?: string): number {
  if (!expiresAt) return REVIEW_SESSION_DURATION;

  const deadline = Date.parse(expiresAt);
  // An unparseable deadline is a stored-data problem, not a licence to mint a dead cookie; the
  // access layer is what refuses to serve an expired or malformed review window.
  if (Number.isNaN(deadline)) return REVIEW_SESSION_DURATION;

  const remaining = deadline - Date.now();
  return Math.min(REVIEW_SESSION_DURATION, remaining);
}

/**
 * A short digest standing for "the password as it was when this session started".
 *
 * Changing the password is how an agency cuts a client off mid-round, and a signature alone would
 * keep honouring the old cookie for days. Digested rather than sliced off the hash directly: the
 * payload is readable by whoever holds the cookie, and there is no reason to hand them any part of
 * the stored bcrypt string, salt included.
 */
async function passwordEpoch(review: ReviewConfig): Promise<string> {
  if (!review.passwordHash) return NO_PASSWORD_EPOCH;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(review.passwordHash));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Mint a session for one deployment: the token, the participant id generated server-side, and the
 * cookie to carry them.
 *
 * Deliberately the only way to mint. When the token's expiry and the cookie's max-age were two
 * calls, a caller could pass the review deadline to one and forget it on the other, leaving a dead
 * token inside a cookie that lives for a week. Here one lifetime feeds both.
 */
export async function mintReviewCookie(
  deploymentId: string,
  review: ReviewConfig
): Promise<ReviewCookie> {
  const lifetimeMs = sessionLifetimeMs(review.expiresAt);
  const participantId = crypto.randomUUID();
  const exp = Math.floor((Date.now() + lifetimeMs) / 1000);

  const value = await new SignJWT({
    deploymentId,
    participantId,
    purpose: REVIEW_PURPOSE,
    pwe: await passwordEpoch(review),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(exp)
    .setIssuedAt()
    .sign(getSecretKey());

  return {
    name: reviewCookieName(deploymentId),
    value,
    participantId,
    options: {
      httpOnly: true,
      // Same knob as the account session: on by default, and only ever off for local http testing
      // and the documented pre-SSL VPS path.
      secure: secureCookies(),
      sameSite: 'lax',
      maxAge: Math.max(0, Math.floor(lifetimeMs / 1000)),
      // The browser will not send this cookie to any other deployment's review copy.
      path: `/review/${deploymentId}`,
    },
  };
}

/**
 * Verify a token against one specific deployment and its current review settings.
 *
 * A signature alone is not enough. The token must say it is a review session, it must name the
 * deployment being asked about, and it must have been minted under the password that is in force
 * now, so a cookie that leaked between review copies, an account token replayed here, and a
 * session from before the password changed all come back null.
 */
export async function verifyReviewSession(
  token: string,
  deploymentId: string,
  review: ReviewConfig
): Promise<ReviewSessionData | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (payload.purpose !== REVIEW_PURPOSE) return null;
    if (payload.deploymentId !== deploymentId) return null;
    if (payload.pwe !== (await passwordEpoch(review))) return null;
    if (typeof payload.participantId !== 'string' || !payload.participantId) return null;
    if (typeof payload.exp !== 'number') return null;

    return {
      deploymentId,
      participantId: payload.participantId,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** Per-deployment name, so cookie isolation does not rest on path scoping alone. */
export function reviewCookieName(deploymentId: string): string {
  return `${COOKIE_PREFIX}${deploymentId}`;
}

export { REVIEW_SESSION_DURATION };
