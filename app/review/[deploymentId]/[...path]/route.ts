/**
 * Review copy — assets.
 *
 * The sibling of app/deployments/[id]/[...path]/route.ts: same MIME map, same
 * `{path}` → `{path}.html` → `{path}/index.html` fallback, so a review copy answers the same URLs
 * as the published one. Two things differ, and both are the point of the route existing.
 *
 * The root is deploymentReviewDir(), which sits outside `public/` — nothing serves it but this
 * handler, so the path has to be contained here rather than by a file server.
 *
 * And access is resolved on every single request, not once at the entry page. An already-open tab
 * is the case that matters: without this, closing a review round would leave every asset still
 * answering until the client happened to reload.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';

import { RATE_LIMIT_CONFIG } from '@/lib/analytics/rate-limiter';
import { deploymentReviewDir } from '@/lib/compiler/deployment-review-dir';
import { resolveReviewAccess } from '@/lib/review/access';
import { consumeReviewAssetAttempt } from '@/lib/review/read-gate';
import { resolveReviewFilePath, reviewMimeType } from '@/lib/review/serve-path';
import { logger } from '@/lib/utils';
import { PRIVATE_HEADERS } from '@/lib/review/responses';

function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404, headers: PRIVATE_HEADERS });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string; path?: string[] }> }
) {
  const { deploymentId, path: pathSegments = [] } = await params;

  try {
    // Before the access check, so a flood costs a map lookup rather than a deployment resolve and a
    // file read. The limit is set for a browser loading a page — see RATE_LIMIT_CONFIG.reviewAsset.
    const gate = consumeReviewAssetAttempt(request, deploymentId);
    if (!gate.allowed) {
      return new NextResponse('Too many requests', {
        status: 429,
        headers: {
          ...PRIVATE_HEADERS,
          'Retry-After': gate.retryAfterSeconds.toString(),
          'X-RateLimit-Limit': RATE_LIMIT_CONFIG.reviewAsset.limit.toString(),
          'X-RateLimit-Remaining': '0',
        },
      });
    }

    const access = await resolveReviewAccess(deploymentId, request);
    if (access.kind === 'denied') return notFound();

    // Segments arrive percent-decoded, so a `%2e%2e%2f` in the URL is a literal `../` by the time
    // it gets here; containment is inside resolveReviewFilePath.
    const filePath = await resolveReviewFilePath(deploymentReviewDir(deploymentId), pathSegments);
    if (!filePath) return notFound();

    const content = await fs.readFile(filePath);

    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: { ...PRIVATE_HEADERS, 'Content-Type': reviewMimeType(filePath) },
    });
  } catch (error) {
    logger.error('[Review] Asset serving failed:', error);
    return new NextResponse('Internal server error', { status: 500, headers: PRIVATE_HEADERS });
  }
}
