/**
 * Review participant — the caller naming themselves.
 *
 * The only row this can ever write is the one the access layer verified, whose id comes out of a
 * signed cookie or an account session. A participant id in the body is not rejected so much as
 * unreachable: `validateParticipantProfile` returns a name and an address and has no field for it,
 * so there is no branch here that could be made to write somebody else's row.
 */

import { NextRequest, NextResponse } from 'next/server';

import { RATE_LIMIT_CONFIG } from '@/lib/analytics/rate-limiter';
import { actsAsTeam, resolveReviewAccess } from '@/lib/review/access';
import { toWireParticipant } from '@/lib/review/comment-view';
import { isReviewOriginAllowed } from '@/lib/review/origin-gate';
import { resolveDeployment } from '@/lib/vfs/adapters/deployment-adapter';
import { validateParticipantProfile } from '@/lib/review/participant-input';
import { consumeReviewWriteAttempt } from '@/lib/review/write-gate';
import { ReviewDatabase } from '@/lib/vfs/adapters/review-database';
import { logger } from '@/lib/utils';
import { PRIVATE_HEADERS } from '@/lib/review/responses';

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: PRIVATE_HEADERS });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;

  try {
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
    if (access.kind === 'denied') return notFound();

    // The studio and the review copy's own site origin only: see lib/review/origin-gate.ts for why
    // the analytics allowlist is the wrong one on a write.
    if (!isReviewOriginAllowed(request, (await resolveDeployment(deploymentId))?.deployment)) {
      logger.warn('[Review Participant] Invalid origin (rejected):', {
        origin: request.headers.get('origin'),
        deploymentId,
      });
      return NextResponse.json(
        { error: 'Origin not allowed' },
        { status: 403, headers: PRIVATE_HEADERS }
      );
    }

    const parsed = await request.json().catch(() => null);

    // The address is settled here rather than at send time: once stored it is interpolated into
    // outgoing mail, and a malformed one caught then has already reached the envelope.
    const profile = validateParticipantProfile(parsed);
    if (!profile.ok) {
      return NextResponse.json(
        { error: profile.error },
        { status: 400, headers: PRIVATE_HEADERS }
      );
    }

    const db = new ReviewDatabase(deploymentId);
    db.init();

    const participant = db.upsertParticipant({
      // The verified id, not anything the body carried.
      id: access.participantId,
      displayName: profile.value.displayName,
      email: profile.value.email,
      // Re-derived from the session on every write, so the flag on the row cannot drift into a
      // claim the caller does not currently hold — and the claim is authority, not membership, so a
      // read-only workspace member's row is an ordinary participant's.
      isTeam: actsAsTeam(access),
    });

    return NextResponse.json(
      { participant: toWireParticipant(participant) },
      { headers: PRIVATE_HEADERS }
    );
  } catch (error) {
    logger.error('[Review Participant] Update failed:', error);
    return NextResponse.json(
      { error: 'Failed to update participant' },
      { status: 500, headers: PRIVATE_HEADERS }
    );
  }
}
