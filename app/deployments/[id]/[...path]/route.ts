/**
 * Public Deployments Route - Assets
 *
 * Serves compiled static files from public/deployments/[id]/. With STATIC_PROXY=true Caddy serves a
 * site's own host directly; a subdomain without a block of its own reaches Node, which serves the
 * site by path here (lib/caddy/regenerate.ts, the wildcard block).
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { deploymentStaticFile } from '@/lib/compiler/deployment-static-dir';
import { resolveReviewFilePath, reviewMimeType } from '@/lib/review/serve-path';

/** A request for a page: a path with no extension, or .html. */
const PAGE = /^(.*\/)?[^/.]*(\.html?)?$/;

/**
 * A missing page gets the site's own 404.html, still with status 404, as Caddy does
 * (lib/caddy/regenerate.ts). A missing asset, or a site without one, gets the bare 404.
 */
async function notFound(id: string, requestedPath: string): Promise<NextResponse> {
  const page = PAGE.test(requestedPath) ? deploymentStaticFile(id, '404.html') : null;
  if (page) {
    try {
      const content = await fs.readFile(page);
      return new NextResponse(new Uint8Array(content), {
        status: 404,
        headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' },
      });
    } catch {
      // No 404.html: the bare 404 below.
    }
  }
  return new NextResponse('File not found', { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path: pathSegments = [] } = await params;
  const requestedPath = pathSegments.length > 0 ? pathSegments.join('/') : 'index.html';

  try {
    // The deployment's folder (null for a malformed id), then the file the way Caddy finds it:
    // the path, then .html, then /index.html, so `/blog/post` reaches blog/post.html here too.
    const siteDir = deploymentStaticFile(id, '');
    if (!siteDir) {
      return new NextResponse('File not found', { status: 404 });
    }

    const staticFilePath = await resolveReviewFilePath(siteDir, pathSegments);
    if (!staticFilePath) {
      return await notFound(id, requestedPath);
    }

    const content = await fs.readFile(staticFilePath);
    const mimeType = reviewMimeType(staticFilePath);

    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600',
        // Public files; see the /deployments headers in next.config.ts.
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('[Deployments Route] Error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}
