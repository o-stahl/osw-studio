/**
 * Review comments — resolve and reopen.
 *
 * Team-only, which makes this the one review endpoint that answers 403 rather than 404. A caller
 * who reaches it has already proven access to the review copy through the same
 * `resolveReviewAccess` every other route uses, so refusing them by pretending the deployment does
 * not exist would conceal nothing they do not already know, and would read to a client as a broken
 * page rather than as a boundary.
 */

import { NextRequest, NextResponse } from 'next/server';

import { resolveReviewAccess, teamAccessRefusal } from '@/lib/review/access';
import { authorizeStatusChange } from '@/lib/review/comment-status';
import { toWireComment } from '@/lib/review/comment-view';
import { isReviewOriginAllowed } from '@/lib/review/origin-gate';
import { resolveDeployment } from '@/lib/vfs/adapters/deployment-adapter';
import { ReviewDatabase } from '@/lib/vfs/adapters/review-database';
import { logger } from '@/lib/utils';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow',
};

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: PRIVATE_HEADERS });
}

function teamRefused(status: 401 | 403): NextResponse {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
    { status, headers: PRIVATE_HEADERS }
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string; id: string }> }
) {
  const { deploymentId, id } = await params;

  try {
    const access = await resolveReviewAccess(deploymentId, request);
    const refusal = await teamAccessRefusal(request, access);
    if (refusal) return teamRefused(refusal);
    if (access.kind === 'denied') return notFound();

    // A write, and therefore the same origin gate the other two review writes carry. A team
    // member's account session is SameSite=Lax like the participant cookie, so a page on a tenant's
    // published subdomain — same-site with the app — would otherwise be able to close a client's
    // comments in their name. See lib/review/origin-gate.ts.
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

    // Authorisation before the lookup as well as before the body: a participant must not be able to
    // use the 404-vs-403 difference to test whether a comment id exists.
    const change = authorizeStatusChange(access, parsed);
    if (!change.ok) {
      return NextResponse.json(
        { error: change.error },
        { status: change.httpStatus, headers: PRIVATE_HEADERS }
      );
    }

    const db = new ReviewDatabase(deploymentId);
    db.init();

    // Review databases are per-deployment, so a comment from another one is absent here and the
    // route cannot be used to resolve someone else's threads.
    if (!db.getComment(id)) return notFound();

    db.setCommentStatus(id, change.status, change.resolvedBy);

    const updated = db.getComment(id);
    if (!updated) return notFound();

    return NextResponse.json({ comment: toWireComment(updated) }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    logger.error('[Review Comments] Status change failed:', error);
    return NextResponse.json(
      { error: 'Failed to update comment' },
      { status: 500, headers: PRIVATE_HEADERS }
    );
  }
}
