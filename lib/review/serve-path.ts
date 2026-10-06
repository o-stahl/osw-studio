/**
 * Turning a review URL's path segments into a file inside the review build.
 *
 * A review build sits beside the per-deployment databases, outside `public/`, and is reached by a
 * caller who needed no account, so the join has to be contained. The public deployment route has
 * the same problem and the same answer (`deploymentStaticFile`).
 *
 * Containment cannot be delegated upstream. Next percent-decodes each dynamic segment after it has
 * normalized the request path, so `%2e%2e%2f` arrives as one segment whose text is `../`, the
 * router never saw a `..` segment to strip, and the traversal reaches this code intact.
 */

import { promises as fs } from 'fs';

import { resolveWithin } from '@/lib/vfs/path-safety';

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

export function reviewMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a request's segments to a readable file, or null when there is nothing to serve.
 *
 * The fallback order is the one Caddy applies to published deployments
 * (`try_files {path} {path}.html {path}/index.html`, lib/caddy/regenerate.ts), so a review copy and
 * the public copy of the same build answer the same URLs.
 *
 * Null covers both "outside the root" and "not there" deliberately: the caller turns either into a
 * 404, and a distinguishable refusal would report which paths exist above the root.
 */
export async function resolveReviewFilePath(
  reviewRoot: string,
  segments: string[]
): Promise<string | null> {
  // A NUL would make fs throw rather than miss; refuse it before it can reach a syscall.
  if (segments.some((segment) => segment.includes('\0'))) return null;

  const requested = segments.filter((segment) => segment.length > 0).join('/');
  const candidates = requested
    ? [requested, `${requested}.html`, `${requested}/index.html`]
    : ['index.html'];

  for (const candidate of candidates) {
    const resolved = resolveWithin(reviewRoot, `/${candidate}`);
    if (!resolved) continue;
    if (await isFile(resolved)) return resolved;
  }

  return null;
}
