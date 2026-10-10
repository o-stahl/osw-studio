/**
 * Analytics Security Utilities
 *
 * Token generation and validation for secure analytics tracking.
 * Prevents unauthorized data injection and replay attacks.
 */

import crypto from 'crypto';
import { appUrl, sitesOrigin } from '@/lib/web/site-origin';

const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (for static sites)

/**
 * Generate a signed analytics tracking token
 * Token format (base64-encoded): deploymentId:timestamp:nonce:signature
 *
 * @param deploymentId - Deployment identifier
 * @returns Base64-encoded signed token
 */
export function generateAnalyticsToken(deploymentId: string): string {
  const secret = getAnalyticsSecret();
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${deploymentId}:${timestamp}:${nonce}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const token = `${payload}:${signature}`;
  return Buffer.from(token).toString('base64');
}

/**
 * Verify an analytics tracking token
 *
 * @param token - Base64-encoded token from client
 * @param expectedDeploymentId - Expected deployment ID
 * @returns true if valid, false otherwise
 */
export function verifyAnalyticsToken(
  token: string,
  expectedDeploymentId: string
): boolean {
  try {
    const secret = getAnalyticsSecret();

    // Decode token
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parts = decoded.split(':');

    if (parts.length !== 4) {
      return false; // Invalid format
    }

    const [deploymentId, timestamp, nonce, signature] = parts;

    // Verify deployment ID matches
    if (deploymentId !== expectedDeploymentId) {
      return false;
    }

    // Verify timestamp is recent (prevent replay attacks)
    const tokenAge = Date.now() - parseInt(timestamp, 10);
    if (tokenAge > TOKEN_EXPIRY_MS || tokenAge < 0) {
      return false; // Token expired or from future
    }

    // Verify signature
    const payload = `${deploymentId}:${timestamp}:${nonce}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    // Invalid token format or other error
    return false;
  }
}

/**
 * Get analytics secret from environment
 * Generates a random secret if not configured (dev only)
 */
function getAnalyticsSecret(): string {
  const secret = process.env.ANALYTICS_SECRET;

  if (!secret) {
    // In development, use a stable secret to persist across restarts
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        '[Analytics Security] ANALYTICS_SECRET not set, using development secret (not for production)'
      );
      return 'dev-analytics-secret-do-not-use-in-production-change-this-value';
    }

    throw new Error(
      'ANALYTICS_SECRET environment variable must be set in production'
    );
  }

  return secret;
}

/**
 * Parse a header value into a URL, or null when it is not an http(s) one.
 *
 * Everything below works on the parsed pieces rather than on the string, because textual matching
 * is what let `https://oswstudio.com.evil.net` satisfy a rule written for `https://oswstudio.com`:
 * a host boundary is a structural property of a URL, not a prefix of its text.
 */
function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The `.host` suffix of a `https://*.host` allowlist entry. */
function wildcardSuffix(allowed: string): string {
  return allowed.replace(/^https?:\/\/\*/, '');
}

/**
 * Whether a host is a strict subdomain of a wildcard entry's suffix.
 *
 * The length test is what keeps `evil-oswstudio.com` out of `*.oswstudio.com`: it ends in the same
 * characters, but not at a label boundary.
 */
function matchesWildcardHost(host: string, allowed: string): boolean {
  const suffix = wildcardSuffix(allowed);
  return host.length > suffix.length && host.endsWith(suffix);
}

/**
 * Match the `Origin` header, which a browser sets itself and which is only ever scheme + host +
 * port. Exact origin equality, so nothing that merely begins with an allowed origin passes, and an
 * allowlist entry carrying a path — `${appUrl}/deployments/${id}` — never matches here at all,
 * because no browser puts a path in this header.
 */
function originIsAllowed(origin: string, allowedOrigins: string[]): boolean {
  const url = parseHttpUrl(origin);
  if (!url) return false;

  return allowedOrigins.some((allowed) => {
    if (allowed.includes('*')) return matchesWildcardHost(url.host, allowed);

    const allowedUrl = parseHttpUrl(allowed);
    if (!allowedUrl) return false;
    // A path entry describes where a page lives, not who is calling; only the origin-shaped
    // entries can answer for this header.
    if (allowedUrl.pathname !== '/' || allowedUrl.search || allowedUrl.hash) return false;
    return url.origin === allowedUrl.origin;
  });
}

/**
 * Match the `Referer` header, which carries a full URL, and is therefore the only header a path
 * entry can ever be checked against.
 *
 * The origin has to match exactly, as above; the path is a prefix match, but only at a segment
 * boundary — `/deployments/abc` does not cover `/deployments/abcdef`.
 */
function refererIsAllowed(referer: string, allowedOrigins: string[]): boolean {
  const url = parseHttpUrl(referer);
  if (!url) return false;

  return allowedOrigins.some((allowed) => {
    if (allowed.includes('*')) return matchesWildcardHost(url.host, allowed);

    const allowedUrl = parseHttpUrl(allowed);
    if (!allowedUrl || url.origin !== allowedUrl.origin) return false;

    const prefix = allowedUrl.pathname.replace(/\/+$/, '');
    if (prefix === '') return true;
    return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  });
}

/**
 * Validate request origin against allowed domains.
 *
 * `Origin` decides whenever it is present: the browser sets it, a page cannot forge it, and letting
 * a friendly `Referer` overturn a refused `Origin` would put the weaker of the two headers in
 * charge. `Referer` is the fallback for the requests that carry no `Origin` at all.
 *
 * @param request - Incoming request
 * @param allowedOrigins - Array of allowed origin URLs, and paths beneath them
 * @returns true if origin is allowed, false otherwise
 */
export function validateOrigin(
  request: Request,
  allowedOrigins: string[]
): boolean {
  const origin = request.headers.get('origin');
  if (origin) return originIsAllowed(origin, allowedOrigins);

  const referer = request.headers.get('referer');
  return referer ? refererIsAllowed(referer, allowedOrigins) : false;
}

/**
 * Get allowed origins for a deployment
 *
 * @param deploymentId - Deployment identifier
 * @param customDomain - Optional custom domain
 * @returns Array of allowed origin URLs
 */
export function getAllowedOrigins(
  deploymentId: string,
  customDomain?: string | null
): string[] {
  const app = appUrl();

  const origins: string[] = [
    `${app}/deployments/${deploymentId}`, // Published deployment path
    app // Base app URL (for development/testing)
  ];

  // Add localhost variations for development
  if (app.includes('localhost')) {
    origins.push('http://localhost:3000');
    origins.push('http://127.0.0.1:3000');
  }

  // Sites served on their own origin (lib/web/site-origin.ts)
  const sites = sitesOrigin();
  if (sites) origins.push(sites);

  // Add custom domain if configured
  if (customDomain) {
    origins.push(`https://${customDomain}`);
    origins.push(`http://${customDomain}`);
  }

  // Allow subdomain-routed deployments (e.g., my-site.oswstudio.com)
  const appHost = app.replace(/^https?:\/\//, '').split(':')[0];
  if (appHost && !appHost.includes('localhost')) {
    origins.push(`https://*.${appHost}`);
    origins.push(`http://*.${appHost}`);
  }

  return origins;
}

/**
 * Generate token hash for storage (to verify tokens without storing plaintext)
 *
 * @param token - Token to hash
 * @returns SHA-256 hash of token
 */
export function hashToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

/**
 * Check if user agent appears to be a bot
 *
 * @param userAgent - User agent string
 * @returns true if likely a bot, false otherwise
 */
export function isLikelyBot(userAgent: string): boolean {
  if (!userAgent) return true; // No user agent = suspicious

  const lowerUA = userAgent.toLowerCase();

  // Common bot indicators
  const botPatterns = [
    'bot',
    'crawl',
    'spider',
    'scrape',
    'curl',
    'wget',
    'python',
    'java',
    'http',
    'go-http-client',
    'axios',
    'fetch',
    'node-fetch',
    'requests', // Python
    'urllib',
    'headless',
    'phantom',
    'selenium',
    'puppeteer',
    'playwright'
  ];

  return botPatterns.some((pattern) => lowerUA.includes(pattern));
}

/**
 * Detect suspicious request patterns
 *
 * @param data - Analytics data to validate
 * @returns true if suspicious, false otherwise
 */
export function isSuspiciousRequest(data: {
  pagePath?: string;
  referrer?: string;
  userAgent?: string;
}): boolean {
  // Check for obviously fake/malicious data
  if (data.pagePath && data.pagePath.length > 500) {
    return true; // Unreasonably long path
  }

  if (data.referrer && data.referrer.length > 500) {
    return true; // Unreasonably long referrer
  }

  if (data.userAgent && data.userAgent.length > 500) {
    return true; // Unreasonably long user agent
  }

  // Check for SQL injection attempts
  const sqlPatterns = /(union|select|insert|update|delete|drop|create|alter)/i;
  if (
    (data.pagePath && sqlPatterns.test(data.pagePath)) ||
    (data.referrer && sqlPatterns.test(data.referrer))
  ) {
    return true;
  }

  return false;
}
