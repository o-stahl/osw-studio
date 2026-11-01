/**
 * Public Deployments Route - Root
 *
 * Serves index.html from public/deployments/[id]/. With STATIC_PROXY=true Caddy serves a site's own
 * host directly; a subdomain without a block of its own reaches Node, which serves it here, as in
 * `[...path]`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { deploymentStaticFile } from '@/lib/compiler/deployment-static-dir';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const indexPath = deploymentStaticFile(id, 'index.html');
    if (!indexPath) {
      return new NextResponse('Deployment not found', { status: 404 });
    }

    try {
      await fs.access(indexPath);
    } catch {
      return new NextResponse('Deployment not found', { status: 404 });
    }

    const content = await fs.readFile(indexPath, 'utf-8');

    return new NextResponse(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('[Deployments Route] Error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}
