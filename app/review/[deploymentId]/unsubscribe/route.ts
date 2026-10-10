/**
 * Opting out of review digests.
 *
 * Anything that sends mail owes the recipient a way to stop it, and a client on a review copy has
 * no account to sign into — so this route authorises on the token in the link and nothing else. The
 * token names one recipient on one deployment (lib/review/unsubscribe-token.ts); every refusal is
 * the same 404 the rest of review mode gives, so a probe cannot learn which participants exist.
 *
 * The same link shape carries the team's mute, which sets `muted` on notification_state rather than
 * clearing a participant's `notify` — the two opt-outs live in different places because a workspace
 * member has no participant row to switch off.
 *
 * Acting on GET is deliberate. A mail scanner that prefetches links will unsubscribe someone who
 * never clicked, which is a real cost; the alternative costs more, because a second click on a page
 * is exactly where a recipient who cannot log in gives up and marks the message as spam instead.
 * Both states are reversible from the review widget and the deployment's Review page.
 */

import { NextRequest, NextResponse } from 'next/server';

import { RATE_LIMIT_CONFIG } from '@/lib/analytics/rate-limiter';
import { consumeReviewUnsubscribeAttempt } from '@/lib/review/read-gate';
import { verifyUnsubscribeToken, type UnsubscribeKind } from '@/lib/review/unsubscribe-token';
import { resolveDeployment } from '@/lib/vfs/adapters/deployment-adapter';
import { ReviewDatabase } from '@/lib/vfs/adapters/review-database';
import { escapeHtml } from '@/lib/publishing/escape-html';
import { logger } from '@/lib/utils';
import { PRIVATE_HEADERS } from '@/lib/review/responses';

function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404, headers: PRIVATE_HEADERS });
}

/**
 * Deliberately a hand-written page with no stylesheet, script or image, for the same reason the
 * password gate is: it is shown to someone outside the agency, on their own network, and anything
 * it referenced off-page would be one more thing that can fail.
 */
function confirmationPage(deploymentName: string, kind: UnsubscribeKind): NextResponse {
  const name = escapeHtml(deploymentName);
  const message =
    kind === 'user'
      ? `You will no longer be notified about comments on ${name}. Unmute it from the deployment's Review page whenever you want them back.`
      : `You will no longer receive email about comments on ${name}. You can turn notifications back on from the review copy at any time.`;

  return new NextResponse(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Notifications off</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fafaf9; color: #1c1917;
  }
  main { width: 100%; max-width: 420px; }
  h1 { margin: 0 0 6px; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: #78716c; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0c0a09; color: #f5f5f4; }
    p { color: #a8a29e; }
  }
</style>
</head>
<body>
<main>
<h1>Notifications off</h1>
<p>${message}</p>
</main>
</body>
</html>`,
    { status: 200, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;

  try {
    // First, so repeating the request costs a map lookup rather than a deployment resolve and a
    // database open. Generous enough for a client team's digests arriving through one mail gateway
    // — see RATE_LIMIT_CONFIG.reviewUnsubscribe.
    const gate = consumeReviewUnsubscribeAttempt(request, deploymentId);
    if (!gate.allowed) {
      return new NextResponse('Too many requests', {
        status: 429,
        headers: {
          ...PRIVATE_HEADERS,
          'Retry-After': gate.retryAfterSeconds.toString(),
          'X-RateLimit-Limit': RATE_LIMIT_CONFIG.reviewUnsubscribe.limit.toString(),
          'X-RateLimit-Remaining': '0',
        },
      });
    }

    const query = request.nextUrl.searchParams;
    const recipientId = query.get('id') ?? '';
    const kind: UnsubscribeKind = query.get('kind') === 'user' ? 'user' : 'participant';
    const token = query.get('token') ?? '';

    // Before any review database work, because opening one creates the file: a link aimed at a
    // deployment that never had review enabled must not leave an empty database behind it.
    const resolved = await resolveDeployment(deploymentId);
    if (!resolved?.deployment.review?.enabled) return notFound();

    if (!recipientId || !verifyUnsubscribeToken(token, kind, recipientId, deploymentId)) {
      return notFound();
    }

    const db = new ReviewDatabase(deploymentId);
    db.init();

    if (kind === 'user') {
      // Never the watermark. Muting hides what comes next, not what was already owed.
      db.setMuted('user', recipientId, true);
      return confirmationPage(resolved.deployment.name, kind);
    }

    const participant = db.getParticipant(recipientId);
    // Confirmed either way. A token this instance signed is proof enough of intent, and answering
    // differently would report which participant ids are real.
    if (participant) {
      db.upsertParticipant({
        id: participant.id,
        // Resupplied because upsert writes every column: dropping the name and the address here
        // would lose the identity their existing comments are attributed to.
        displayName: participant.displayName,
        email: participant.email ?? undefined,
        notify: false,
        isTeam: participant.isTeam,
      });
    }

    return confirmationPage(resolved.deployment.name, kind);
  } catch (error) {
    // Never the token, the address or the recipient id.
    logger.error('[Review] Unsubscribe failed:', error instanceof Error ? error.message : error);
    return new NextResponse('Internal server error', { status: 500, headers: PRIVATE_HEADERS });
  }
}
