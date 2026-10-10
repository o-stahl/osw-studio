/**
 * Review comments — list and create.
 *
 * A public endpoint in the same sense as the analytics collectors: reachable without an account,
 * addressed by a deployment id that is not secret, and therefore hardened in the same order they
 * are — rate limit, then who is asking, then where the request came from, then what it says.
 *
 * The one structural difference is that access is not a feature flag here but an identity.
 * `resolveReviewAccess` returns the participant id the request will be attributed to, and nothing
 * in the body is allowed to contribute to it.
 *
 * It sits under the review copy's own prefix rather than under `/api` because that identity
 * travels in a cookie scoped to `/review/{deploymentId}`; see lib/review/api-base.ts for why the
 * segment is spelled the way it is, and why an endpoint outside the prefix would never be reached
 * by a caller a browser could identify.
 */

import { NextRequest, NextResponse } from 'next/server';

import { RATE_LIMIT_CONFIG } from '@/lib/analytics/rate-limiter';
import { actsAsTeam, resolveReviewAccess, teamAccessRefusal } from '@/lib/review/access';
import { isReviewOriginAllowed } from '@/lib/review/origin-gate';
import { resolveDeployment } from '@/lib/vfs/adapters/deployment-adapter';
import {
  resolveCommentAuthorship,
  resolveParentComment,
  validateCommentInput,
} from '@/lib/review/comment-input';
import {
  MAX_LISTED_COMMENTS,
  toWireComment,
  toWireComments,
  toWireParticipants,
} from '@/lib/review/comment-view';
import { consumeReviewCommentListAttempt } from '@/lib/review/read-gate';
import { consumeReviewWriteAttempt } from '@/lib/review/write-gate';
import { ReviewDatabase, type ReviewParticipant } from '@/lib/vfs/adapters/review-database';
import { logger } from '@/lib/utils';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow',
};

/**
 * The answer for a caller with no claim to this deployment, matching lib/api/deployment-access.ts:
 * a review copy that is switched off, expired, or was never theirs must not be distinguishable
 * from one that does not exist.
 */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: PRIVATE_HEADERS });
}

function teamRefused(status: 401 | 403): NextResponse {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
    { status, headers: PRIVATE_HEADERS }
  );
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400, headers: PRIVATE_HEADERS });
}

function openReviewDatabase(deploymentId: string): ReviewDatabase {
  const db = new ReviewDatabase(deploymentId);
  db.init();
  // Not closed: the underlying handle is cached per deployment by sqlite-connection and shared
  // across requests, so closing it here would pull it out from under a concurrent one.
  return db;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;

  try {
    // Before the access check, as on the writes: a flood should cost a map lookup, not a deployment
    // resolve and a read of somebody's comment table.
    const gate = consumeReviewCommentListAttempt(request, deploymentId);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        {
          status: 429,
          headers: {
            ...PRIVATE_HEADERS,
            'Retry-After': gate.retryAfterSeconds.toString(),
            'X-RateLimit-Limit': RATE_LIMIT_CONFIG.reviewCommentList.limit.toString(),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    const access = await resolveReviewAccess(deploymentId, request);
    const refusal = await teamAccessRefusal(request, access);
    if (refusal) return teamRefused(refusal);
    if (access.kind === 'denied') return notFound();

    const db = openReviewDatabase(deploymentId);
    const total = db.countComments();
    const comments = db.listComments({ limit: MAX_LISTED_COMMENTS });

    // Only the people actually referenced by a comment, plus the caller so the UI can render its
    // own name before it has posted anything.
    const referenced = new Set(comments.map(comment => comment.participantId));
    referenced.add(access.participantId);

    const participants = [...referenced]
      .map(id => db.getParticipant(id))
      .filter((participant): participant is ReviewParticipant => participant !== null);

    return NextResponse.json(
      {
        comments: toWireComments(comments),
        // Emails are stripped for every caller, team included — see lib/review/comment-view.ts.
        participants: toWireParticipants(participants),
        // The participant id lives in an HttpOnly cookie, so the page cannot otherwise tell which
        // comments are its own or whether to offer the resolve control. `is_team` is authority
        // rather than membership, so a read-only member sees the copy without the resolve control.
        viewer: { participant_id: access.participantId, is_team: actsAsTeam(access) },
        // Reported rather than left to be inferred from the length: a capped list looks exactly
        // like a complete one, and a reader who is not told will act on a partial thread.
        total,
        truncated: total > comments.length,
      },
      { headers: PRIVATE_HEADERS }
    );
  } catch (error) {
    logger.error('[Review Comments] List failed:', error);
    return NextResponse.json(
      { error: 'Failed to load comments' },
      { status: 500, headers: PRIVATE_HEADERS }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;

  try {
    // First, before any database work: a flood must cost the server as little as possible.
    const gate = consumeReviewWriteAttempt(request, deploymentId);
    if (!gate.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        {
          status: 429,
          headers: {
            ...PRIVATE_HEADERS,
            'Retry-After': gate.retryAfterSeconds.toString(),
            'X-RateLimit-Limit': RATE_LIMIT_CONFIG.reviewComment.limit.toString(),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    const access = await resolveReviewAccess(deploymentId, request);
    const refusal = await teamAccessRefusal(request, access);
    if (refusal) return teamRefused(refusal);
    if (access.kind === 'denied') return notFound();

    // The review copy is reachable only at the app origin, so that is the whole allowlist — not the
    // analytics one, which names every tenant's published subdomain. See lib/review/origin-gate.ts.
    if (!isReviewOriginAllowed(request, (await resolveDeployment(deploymentId))?.deployment)) {
      logger.warn('[Review Comments] Invalid origin (rejected):', {
        origin: request.headers.get('origin'),
        deploymentId,
      });
      return NextResponse.json(
        { error: 'Origin not allowed' },
        { status: 403, headers: PRIVATE_HEADERS }
      );
    }

    const parsed = await request.json().catch(() => null);
    const input = validateCommentInput(parsed);
    if (!input.ok) return badRequest(input.error);

    const db = openReviewDatabase(deploymentId);

    // Checked against this deployment's own database, so a reply cannot be hung off a thread in
    // somebody else's review copy.
    const parent = resolveParentComment(input.value.parentId, db);
    if (!parent.ok) return badRequest(parent.error);

    // Identity from the verified access result and the stored row; the body contributes only the
    // three content fields below.
    const authorship = resolveCommentAuthorship(access, db.getParticipant(access.participantId));

    const comment = db.createComment({
      participantId: authorship.participantId,
      authorName: authorship.authorName,
      isTeam: authorship.isTeam,
      parentId: parent.parentId,
      pagePath: input.value.pagePath,
      selector: input.value.selector,
      anchorText: input.value.anchorText,
      body: input.value.body,
    });

    return NextResponse.json(
      { comment: toWireComment(comment) },
      { status: 201, headers: PRIVATE_HEADERS }
    );
  } catch (error) {
    logger.error('[Review Comments] Create failed:', error);
    return NextResponse.json(
      { error: 'Failed to create comment' },
      { status: 500, headers: PRIVATE_HEADERS }
    );
  }
}
