/**
 * A path on this server, or `/`. Checked by resolving it, since a URL parser reads `/\host`, and a
 * `/` followed by a tab or newline and another `/`, as a different host.
 */
export function sanitizeRedirect(redirect: string): string {
  if (!redirect.startsWith('/')) return '/';
  const base = 'http://handoff.invalid';
  try {
    const url = new URL(redirect, base);
    return url.origin === base ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}
