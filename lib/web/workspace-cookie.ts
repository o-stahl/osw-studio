/**
 * The selected-workspace cookie, read and written by both the browser and the server.
 *
 * `__Host-osw_workspace` on HTTPS, so a published site on a sibling subdomain cannot plant a
 * workspace for the studio (cookie tossing), matching the session and ChatGPT cookies. The browser
 * cannot see the server's `SECURE_COOKIES`, so it decides by protocol; plain HTTP (local dev, the
 * desktop app) keeps `osw_workspace`.
 *
 * Every reader takes the prefixed name first and the old one second. The cookie picks which local
 * project database the browser opens (`osw-studio-{workspaceId}`), so a reader that missed it would
 * show an empty project list; with the fallback, an existing selection carries over and the prefix
 * takes over the next time the cookie is written (login, workspace switch).
 */

export const WORKSPACE_COOKIE = 'osw_workspace';
export const SECURE_WORKSPACE_COOKIE = `__Host-${WORKSPACE_COOKIE}`;
const MAX_AGE = 60 * 60 * 24 * 365;

/** The workspace id in a `Cookie` header or `document.cookie`, or undefined. */
export function workspaceFromCookieString(cookies: string): string | undefined {
  const read = (name: string) => cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
  return read(SECURE_WORKSPACE_COOKIE) || read(WORKSPACE_COOKIE) || undefined;
}

/** The workspace id from a request's cookie jar (middleware and route handlers). */
export function workspaceFromRequest(request: { cookies: { get(name: string): { value: string } | undefined } }): string | undefined {
  return request.cookies.get(SECURE_WORKSPACE_COOKIE)?.value || request.cookies.get(WORKSPACE_COOKIE)?.value || undefined;
}

/** Browser: the selected workspace. */
export function readWorkspaceCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return workspaceFromCookieString(document.cookie);
}

/** Browser: select a workspace. On HTTPS the old name is cleared, so it stops being read. */
export function writeWorkspaceCookie(workspaceId: string): void {
  if (typeof document === 'undefined') return;
  if (window.location.protocol === 'https:') {
    document.cookie = `${SECURE_WORKSPACE_COOKIE}=${workspaceId}; Path=/; Max-Age=${MAX_AGE}; Secure; SameSite=Lax`;
    document.cookie = `${WORKSPACE_COOKIE}=; Path=/; Max-Age=0`;
  } else {
    document.cookie = `${WORKSPACE_COOKIE}=${workspaceId}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
  }
}

type CookieResponse = { cookies: { set(name: string, value: string, options: object): unknown; delete(name: string): unknown } };

/** Server: select a workspace on a response (the gateway handoff). Same rule as the session cookie. */
export function setWorkspaceOnResponse(response: CookieResponse, workspaceId: string): void {
  const secure = process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production';
  // Not HttpOnly: read in the browser by the VFS factory, the workspace switcher and the tool registry.
  const options = { httpOnly: false, secure, sameSite: 'lax' as const, maxAge: MAX_AGE, path: '/' };
  if (secure) {
    response.cookies.set(SECURE_WORKSPACE_COOKIE, workspaceId, options);
    response.cookies.delete(WORKSPACE_COOKIE);
  } else {
    response.cookies.set(WORKSPACE_COOKIE, workspaceId, options);
  }
}

/** Server: clear the selection under both names; the prefixed one needs its attributes to be cleared. */
export function clearWorkspaceOnResponse(response: CookieResponse): void {
  response.cookies.set(SECURE_WORKSPACE_COOKIE, '', { secure: true, path: '/', maxAge: 0, sameSite: 'lax' });
  response.cookies.delete(WORKSPACE_COOKIE);
}
