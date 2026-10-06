import path from 'path';
import { resolveWithin } from '@/lib/vfs/path-safety';

/**
 * Where a deployment's compiled static output lives.
 *
 * The default is `public/deployments/` under the process's working directory, which is what the
 * Caddy config serves (`lib/caddy/regenerate.ts` roots at `cwd/public` and maps the URL path
 * straight onto the filesystem) and what the built-in serving routes read.
 *
 * That default is unusable on a desktop install: `main.ts` chdirs into the app bundle, so `cwd` is
 * the install directory — read-only on Linux (AppImage squashfs) and Windows (Program Files), and
 * on macOS writable only until the next drag-install replaces the bundle. Publishing there fails
 * with EACCES or is silently discarded on upgrade. `DEPLOYMENTS_STATIC_DIR` redirects it, the same
 * way `DATA_DIR` and `DEPLOYMENTS_DIR` already redirect the databases.
 *
 * The override keeps the `<root>/<deploymentId>/...` shape so a request path still maps onto the
 * filesystem. It is for installs served by the built-in routes; a `STATIC_PROXY` install has Caddy
 * pointed at the default location, so the two must not be mixed without updating that config.
 */
export function deploymentsStaticRoot(): string {
  return process.env.DEPLOYMENTS_STATIC_DIR || path.join(process.cwd(), 'public', 'deployments');
}

/** The output directory for one deployment. */
export function deploymentStaticDir(deploymentId: string): string {
  return path.join(deploymentsStaticRoot(), deploymentId);
}

/** A deployment id is one plain path segment; anything else could name a folder outside the root. */
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The file a request for `requestPath` inside a deployment maps to, or null when the id is malformed
 * or the path would leave the deployment's folder. A production server decodes `%2e%2e%2f` into a
 * single segment of `../`, so the request path cannot be trusted to be normalised.
 */
export function deploymentStaticFile(deploymentId: string, requestPath: string): string | null {
  if (!DEPLOYMENT_ID.test(deploymentId)) return null;
  return resolveWithin(deploymentStaticDir(deploymentId), '/' + requestPath);
}
