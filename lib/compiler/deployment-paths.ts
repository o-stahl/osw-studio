/**
 * Pure helpers for deployment URL/asset-path resolution.
 *
 * Kept separate from static-builder.ts so they carry no server-only / filesystem
 * dependencies and can be unit-tested directly.
 */


export interface DeploymentServing {
  /** True when the deployment is served at a root (needs root-relative asset paths). */
  servedAtRoot: boolean;
  /** Base URL used for SEO (sitemap, canonical, Open Graph). */
  baseUrl: string;
}

/**
 * Decide how a deployment is served, which controls its asset path style and
 * SEO URLs:
 * - custom domain → served at that domain's root (root-relative paths)
 * - static proxy (Caddy subdomains) active AND a slug → served at the slug
 *   subdomain root (root-relative paths)
 * - otherwise → served under /deployments/{id}/ by the Next route (prefixed
 *   paths), on `sitesOrigin` when one is configured without the static proxy
 *   and on the app's own origin otherwise, as `sitesMode()` in
 *   lib/web/site-origin.ts decides. A slug alone doesn't imply root
 *   serving, since publish always assigns one.
 */
export function resolveDeploymentServing(
  deployment: { slug?: string; customDomain?: string },
  deploymentId: string,
  opts: { staticProxyEnabled: boolean; appUrl: string; sitesOrigin?: string | null }
): DeploymentServing {
  const servedViaSubdomain = opts.staticProxyEnabled && !!deployment.slug;
  const servedAtRoot = !!deployment.customDomain || servedViaSubdomain;
  const instanceDomain = opts.appUrl.replace(/^https?:\/\//, '');
  const baseUrl = deployment.customDomain
    ? `https://${deployment.customDomain}`
    : servedViaSubdomain
    ? `https://${deployment.slug}.${instanceDomain}`
    : `${(!opts.staticProxyEnabled && opts.sitesOrigin) || opts.appUrl}/deployments/${deploymentId}`;
  return { servedAtRoot, baseUrl };
}

/**
 * Replace both blob URLs and file path references with deployment-prefixed absolute paths
 */
export function replaceAssetPathsWithDeploymentPrefix(
  content: string,
  blobUrlToPath: Map<string, string>,
  deploymentId: string,
  servedAtRoot?: boolean
): string {
  // If served at domain root (custom domain or subdomain slug), use root-relative paths.
  // Otherwise use deployment-prefixed paths for direct /deployments/{id}/ access.
  return replaceAssetPathsWithPrefix(
    content,
    blobUrlToPath,
    servedAtRoot ? '' : `/deployments/${deploymentId}`
  );
}

/**
 * Replace both blob URLs and file path references with absolute paths under `pathPrefix`.
 *
 * The prefix is a parameter rather than derived from the deployment because one compiled site is
 * published to more than one place: the public copy under `/deployments/{id}` (or a domain root,
 * where the prefix is empty) and the review copy under `/review/{id}`.
 */
export function replaceAssetPathsWithPrefix(
  content: string,
  blobUrlToPath: Map<string, string>,
  pathPrefix: string
): string {
  let result = content;

  // First, replace all blob URLs with appropriate paths
  for (const [blobUrl, filePath] of blobUrlToPath) {
    const absolutePath = `${pathPrefix}${filePath}`;
    result = result.replace(new RegExp(escapeRegex(blobUrl), 'g'), absolutePath);
  }

  // Helper to check if path is already prefixed with deployment path
  const isAlreadyPrefixed = (path: string) =>
    pathPrefix && path.startsWith(pathPrefix);

  // Rewrite all internal absolute paths for HTML files
  // Pattern matches: href="/anything.html" or href="/anything.htm"
  result = result.replace(
    /href=(["'])(\/[^"']*\.html?)\1/g,
    (match, quote, filePath) => {
      if (isAlreadyPrefixed(filePath)) {
        return match;
      }
      return `href=${quote}${pathPrefix}${filePath}${quote}`;
    }
  );

  // Rewrite asset directory paths (styles, scripts, assets, images, fonts, js, css)
  const assetDirPattern = /(?:href|src)=(["'])(\/(?:styles|scripts|assets|images|fonts|js|css)\/[^"']+)\1/g;
  result = result.replace(assetDirPattern, (match, quote, filePath) => {
    if (isAlreadyPrefixed(filePath)) {
      return match;
    }
    return match.replace(filePath, `${pathPrefix}${filePath}`);
  });

  // Rewrite root-level asset references (e.g., /bundle.js, /bundle.css, /favicon.ico)
  const rootAssetPattern = /(?:href|src)=(["'])(\/[^"'\/]+\.(?:js|css|json|xml|ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|eot))\1/g;
  result = result.replace(rootAssetPattern, (match, quote, filePath) => {
    if (isAlreadyPrefixed(filePath)) {
      return match;
    }
    return match.replace(filePath, `${pathPrefix}${filePath}`);
  });

  // Rewrite CSS url() references for asset directories
  result = result.replace(
    /url\(['"]?(\/(?:styles|scripts|assets|images|fonts|js|css)\/[^'")]+)['"]?\)/g,
    (match, filePath) => {
      if (isAlreadyPrefixed(filePath)) {
        return match;
      }
      return match.replace(filePath, `${pathPrefix}${filePath}`);
    }
  );

  // Handle relative HTML paths (e.g., href="about.html") - convert to absolute with prefix
  result = result.replace(
    /href=(["'])([^"':/][^"']*\.html?)\1/g,
    (match, quote, filePath) => {
      // Skip if it looks like an already-processed path or external
      if (filePath.startsWith('/') || filePath.includes('://')) {
        return match;
      }
      return `href=${quote}${pathPrefix}/${filePath}${quote}`;
    }
  );

  // Handle root path href="/" - rewrite to deployment prefix
  if (pathPrefix) {
    result = result.replace(
      /href=(["'])\/\1/g,
      (match, quote) => `href=${quote}${pathPrefix}/${quote}`
    );
  }

  return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
