import { PublishSettings } from '../vfs/types';

export interface SitemapOptions {
  baseUrl: string;
  htmlFiles: string[]; // Array of paths like ['index.html', 'about.html', 'blog/post.html']
  publishSettings: PublishSettings;
}

export interface RobotsOptions {
  baseUrl: string;
  publishSettings: PublishSettings;
}

/**
 * The address a page is served at, relative to the site's root and without a leading slash:
 * `index.html` → '', `docs/index.html` → 'docs/', `about.html` → 'about'. Caddy's try_files and the
 * built-in routes both answer `/about` with about.html.
 */
export function pageAddress(filePath: string): string {
  const p = filePath.replace(/^\//, '');
  if (p === 'index.html') return '';
  if (p.endsWith('/index.html')) return p.slice(0, -'index.html'.length);
  return p.endsWith('.html') ? p.slice(0, -'.html'.length) : p;
}

/**
 * Generates sitemap.xml from HTML files
 */
export function generateSitemap(options: SitemapOptions): string {
  const { baseUrl, htmlFiles, publishSettings } = options;
  const { seo } = publishSettings;

  // If noIndex is set, don't generate sitemap or make it empty
  if (seo?.noIndex) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Deployment is set to noindex -->
</urlset>`;
  }

  // Pages are listed by the address they're served at (pageAddress). The 404 page is not one to list.
  const urls = htmlFiles
    .filter(filePath => filePath.replace(/^\//, '') !== '404.html')
    .map(filePath => {
      const urlPath = pageAddress(filePath);
      const fullUrl = `${baseUrl}${urlPath ? '/' + urlPath : ''}`;
      const lastmod = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

      return `  <url>
    <loc>${escapeXml(fullUrl)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${urlPath === '' || urlPath === 'index.html' ? '1.0' : '0.8'}</priority>
  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

/**
 * Generates robots.txt
 */
export function generateRobotsTxt(options: RobotsOptions): string {
  const { baseUrl, publishSettings } = options;
  const { seo } = publishSettings;

  const lines: string[] = [];

  // User-agent directive
  lines.push('User-agent: *');

  // Allow/Disallow based on noIndex/noFollow
  if (seo?.noIndex || seo?.noFollow) {
    lines.push('Disallow: /');
  } else {
    lines.push('Allow: /');
  }

  // Add sitemap reference (if not noIndex)
  if (!seo?.noIndex) {
    lines.push('');
    lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  }

  // Additional common rules
  if (!seo?.noIndex && !seo?.noFollow) {
    lines.push('');
    lines.push('# Disallow common non-content paths');
    lines.push('Disallow: /api/');
    lines.push('Disallow: /_next/');
    lines.push('Disallow: /admin/');
  }

  return lines.join('\n') + '\n';
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}
