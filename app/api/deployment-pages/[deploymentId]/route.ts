/**
 * A published page's HTML, read from the build, for the studio to render and capture.
 *
 * A published site may share the studio's origin or live elsewhere (lib/web/site-origin.ts); either
 * way the studio does not load one in a frame it can read, since the page runs code the studio does
 * not control. Thumbnails and the heatmap instead render the page in a
 * sandboxed shell (lib/utils/deployment-thumbnail.ts) from this HTML, with its assets loaded from
 * the site's own URL, returned here as `url`.
 *
 * `path` is the page as a visitor addresses it: `/about`, `/about.html`, or the same under
 * `/deployments/{id}/` where sites are served by path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { requireDeploymentAccess } from '@/lib/api/deployment-access';
import { deploymentPublicUrl } from '@/lib/api/deployment-url';
import { deploymentStaticFile } from '@/lib/compiler/deployment-static-dir';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ deploymentId: string }> }
) {
  const { deploymentId } = await params;
  const access = await requireDeploymentAccess(deploymentId, 'viewer');
  if (!access.ok) return access.response;
  const { deployment } = access.context;

  let page = (request.nextUrl.searchParams.get('path') || '/').split(/[?#]/)[0];
  const prefix = `/deployments/${deployment.id}`;
  if (page === prefix || page.startsWith(`${prefix}/`)) page = page.slice(prefix.length);
  const relative = page.replace(/^\/+/, '');

  const candidates = relative === '' || relative.endsWith('/')
    ? [`${relative}index.html`]
    : [relative, `${relative}.html`, `${relative}/index.html`];
  for (const candidate of candidates) {
    if (!candidate.endsWith('.html')) continue;
    const file = deploymentStaticFile(deployment.id, candidate);
    if (!file) continue;
    try {
      const html = await fs.readFile(file, 'utf-8');
      return NextResponse.json(
        { html, url: `${deploymentPublicUrl(deployment)}/${candidate}` },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    } catch {
      // try the next form
    }
  }
  return NextResponse.json({ error: 'Page not found' }, { status: 404 });
}
