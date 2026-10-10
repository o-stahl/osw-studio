/**
 * Review copy — entry point.
 *
 * The door a client comes through. They have no OSW Studio account and never will: they were sent a
 * link, and possibly a password, by the agency whose workspace owns the deployment. Getting past
 * here mints the review session that the sibling serving route then checks on every asset.
 *
 * Every refusal is a 404, including a wrong password on a review that has closed and a deployment
 * whose review was switched off. That matches the posture in lib/api/deployment-access.ts: a caller
 * with no claim on a deployment should not be able to tell it apart from one that does not exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';

import { deploymentReviewDir } from '@/lib/compiler/deployment-review-dir';
import { isReviewExpired, resolveReviewAccess } from '@/lib/review/access';
import { renderReviewPasswordPage } from '@/lib/review/gate-page';
import { checkReviewPassword, consumeReviewPasswordAttempt } from '@/lib/review/password-gate';
import { resolveReviewFilePath } from '@/lib/review/serve-path';
import { mintReviewCookie, type ReviewCookie } from '@/lib/review/session';
import { resolveDeployment } from '@/lib/vfs/adapters/deployment-adapter';
import type { ReviewConfig } from '@/lib/vfs/types';
import { logger } from '@/lib/utils';
import { PRIVATE_HEADERS } from '@/lib/review/responses';

function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404, headers: PRIVATE_HEADERS });
}

interface ReviewTarget {
  review: ReviewConfig;
  name: string;
  indexPath: string;
}

/**
 * The deployment, its review settings and its built index — or null when any of the three is
 * missing, which the caller turns into the same 404 as a deployment that was never created.
 */
async function loadReviewTarget(deploymentId: string): Promise<ReviewTarget | null> {
  const resolved = await resolveDeployment(deploymentId);
  const review = resolved?.deployment.review;
  if (!resolved || !review?.enabled) return null;

  const indexPath = await resolveReviewFilePath(deploymentReviewDir(deploymentId), []);
  if (!indexPath) return null;

  return { review, name: resolved.deployment.name, indexPath };
}

async function serveIndex(indexPath: string, cookie?: ReviewCookie) {
  const content = await fs.readFile(indexPath, 'utf-8');
  const response = new NextResponse(content, {
    status: 200,
    headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });

  if (cookie) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  return response;
}

/** Mint a session for a caller who has just satisfied the gate, and hand back the built index. */
async function admit(deploymentId: string, review: ReviewConfig, indexPath: string) {
  // One call for the token and the cookie carrying it, so the two cannot be given different
  // lifetimes here.
  return serveIndex(indexPath, await mintReviewCookie(deploymentId, review));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;

  try {
    const target = await loadReviewTarget(deploymentId);
    if (!target) return notFound();

    // Re-checked here as well as on every asset, so a session that was minted before the owner
    // closed the round cannot be used to open the entry page again.
    const access = await resolveReviewAccess(deploymentId, request);
    if (access.kind !== 'denied') return serveIndex(target.indexPath);

    // Nothing a visitor can present will help once the round is closed, and a password box that
    // could never succeed would be a worse answer than the 404 everything else gets.
    if (isReviewExpired(target.review)) return notFound();

    if (target.review.passwordHash) {
      return new NextResponse(
        renderReviewPasswordPage({ deploymentId, name: target.name }),
        { status: 200, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    // Review is open with no password: the link is the credential, and the session exists only so
    // that comments have a stable author.
    return await admit(deploymentId, target.review, target.indexPath);
  } catch (error) {
    logger.error('[Review] Entry failed:', error);
    return new NextResponse('Internal server error', { status: 500, headers: PRIVATE_HEADERS });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;

  try {
    const target = await loadReviewTarget(deploymentId);
    if (!target) return notFound();
    if (isReviewExpired(target.review)) return notFound();

    const { passwordHash } = target.review;
    // Nothing to submit against: fall back to the entry page, which decides what this caller gets.
    if (!passwordHash) {
      return NextResponse.redirect(new URL(`/review/${deploymentId}`, request.url), 303);
    }

    // Counted before the hash is checked, so a correct guess costs an attacker an attempt too.
    const attempt = consumeReviewPasswordAttempt(request, deploymentId);
    if (!attempt.allowed) {
      return new NextResponse(
        renderReviewPasswordPage({
          deploymentId,
          name: target.name,
          error: `Too many attempts. Try again in ${attempt.retryAfterSeconds} seconds.`,
        }),
        {
          status: 429,
          headers: {
            ...PRIVATE_HEADERS,
            'Content-Type': 'text/html; charset=utf-8',
            'Retry-After': String(attempt.retryAfterSeconds),
          },
        }
      );
    }

    const form = await request.formData();
    const submitted = form.get('password');
    const password = typeof submitted === 'string' ? submitted : '';

    if (!(await checkReviewPassword(password, passwordHash))) {
      return new NextResponse(
        renderReviewPasswordPage({
          deploymentId,
          name: target.name,
          error: 'That password did not match. Check the link and password you were sent.',
        }),
        { status: 401, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    // Redirect rather than render, so a refresh after signing in does not re-submit the password.
    const cookie = await mintReviewCookie(deploymentId, target.review);
    const response = NextResponse.redirect(new URL(`/review/${deploymentId}`, request.url), 303);
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    for (const [header, value] of Object.entries(PRIVATE_HEADERS)) {
      response.headers.set(header, value);
    }
    return response;
  } catch (error) {
    logger.error('[Review] Password submission failed:', error);
    return new NextResponse('Internal server error', { status: 500, headers: PRIVATE_HEADERS });
  }
}
