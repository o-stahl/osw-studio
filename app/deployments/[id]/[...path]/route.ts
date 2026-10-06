/**
 * Public Deployments Route - Assets
 *
 * Serves compiled static files from public/deployments/[id]/
 * Disabled when STATIC_PROXY=true (Caddy serves static files directly).
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { deploymentStaticFile } from '@/lib/compiler/deployment-static-dir';

const MIME_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
  txt: 'text/plain',
  pdf: 'application/pdf',
  xml: 'application/xml',
};

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  if (process.env.STATIC_PROXY === 'true') {
    return new NextResponse('Not found', { status: 404 });
  }

  const { id, path: pathSegments = [] } = await params;
  const requestedPath = pathSegments.length > 0 ? pathSegments.join('/') : 'index.html';

  try {
    const staticFilePath = deploymentStaticFile(id, requestedPath);
    if (!staticFilePath) {
      return new NextResponse('File not found', { status: 404 });
    }

    try {
      await fs.access(staticFilePath);
    } catch {
      return new NextResponse('File not found', { status: 404 });
    }

    const content = await fs.readFile(staticFilePath);
    const mimeType = getMimeType(requestedPath);

    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('[Deployments Route] Error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}
