/**
 * The selected-workspace cookie, read and written by both the browser and the server.
 *
 * `__Host-osw_workspace` on HTTPS, so a published site on a sibling subdomain cannot override a
 * workspace selected here (cookie tossing). Readers still fall back to the unprefixed name, which
 * such a site can set, when no prefixed one exists; only an id-shaped value is taken from it. The browser
 * cannot see the server's `SECURE_COOKIES`, so it decides by protocol; plain HTTP (local dev, the
 * desktop app) keeps `osw_workspace`.
 *
 * Every reader takes the prefixed name first and the old one second. The cookie picks which local
 * project database the browser opens (`osw-studio-{workspaceId}`), so a reader that missed it would
 * show an empty project list; with the fallback, an existing selection carries over and the prefix
 * takes over the next time the cookie is written (login, workspace switch).
 */

import { secureCookies } from '@/lib/auth/secure-cookies';

const WORKSPACE_COOKIE = 'osw_workspace';
const SECURE_WORKSPACE_COOKIE = `__Host-${WORKSPACE_COOKIE}`;
const MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Only an id-shaped value is taken. The unprefixed cookie can be planted by a sibling subdomain, and
 * the value ends up in a database name, an API path and a redirect.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const valid = (value: string | undefined) => (value && WORKSPACE_ID.test(value) ? value : undefined);

/** Whether a value is shaped like a workspace id, and so safe to store in the cookie. */
export function isWorkspaceId(value: string | undefined): value is string {
  return !!valid(value);
}

/** The workspace id in a `Cookie` header or `document.cookie`, or undefined. */
export function workspaceFromCookieString(cookies: string): string | undefined {
  const read = (name: string) => valid(cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1]);
  return read(SECURE_WORKSPACE_COOKIE) || read(WORKSPACE_COOKIE);
}

/** The workspace id from a request's cookie jar (middleware and route handlers). */
export function workspaceFromRequest(request: { cookies: { get(name: string): { value: string } | undefined } }): string | undefined {
  return valid(request.cookies.get(SECURE_WORKSPACE_COOKIE)?.value) || valid(request.cookies.get(WORKSPACE_COOKIE)?.value);
}

/** Browser: the selected workspace. */
export function readWorkspaceCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return workspaceFromCookieString(document.cookie);
}

/**
 * Browser: the workspace this page works in. The `/w/{id}` in its address, since the cookie is shared
 * by every tab and another tab may have selected another workspace since this page loaded; the
 * selected workspace on a page outside any.
 */
export function pageWorkspace(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const [, first, id] = window.location.pathname.split('/');
  return (first === 'w' && valid(id)) || readWorkspaceCookie();
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

/**
 * Browser: select a workspace and open `url` as a fresh page load.
 *
 * The local project database is picked from this cookie when the VFS first opens it, and the stores
 * holding a workspace's projects, chats and checkpoints live for the life of the page. A client-side
 * navigation after changing the cookie keeps all of that, so a project created next is written to
 * whichever database the page opened before (on the login page, the unscoped one) and never syncs.
 */
export function enterWorkspace(workspaceId: string, url: string, { replace = false } = {}): void {
  writeWorkspaceCookie(workspaceId);
  if (replace) window.location.replace(url);
  else window.location.assign(url);
}

type CookieResponse = { cookies: { set(name: string, value: string, options: object): unknown; delete(name: string): unknown } };

/** Server: select a workspace on a response (the gateway handoff). Same rule as the session cookie. */
export function setWorkspaceOnResponse(response: CookieResponse, workspaceId: string): void {
  const secure = secureCookies();
  // Not HttpOnly: read in the browser by the VFS factory, the workspace switcher and the tool registry.
  const options = { httpOnly: false, secure, sameSite: 'lax' as const, maxAge: MAX_AGE, path: '/' };
  if (secure) {
    response.cookies.set(SECURE_WORKSPACE_COOKIE, workspaceId, options);
    response.cookies.delete(WORKSPACE_COOKIE);
  } else {
    response.cookies.set(WORKSPACE_COOKIE, workspaceId, options);
    // The browser chooses by protocol, so HTTPS with SECURE_COOKIES=false may hold the prefixed
    // one, which every reader takes first.
    clearSecureWorkspace(response);
  }
}

/** The prefixed name is cleared only with its own attributes; over plain HTTP the browser ignores this. */
function clearSecureWorkspace(response: CookieResponse): void {
  response.cookies.set(SECURE_WORKSPACE_COOKIE, '', { secure: true, path: '/', maxAge: 0, sameSite: 'lax' });
}

/**
 * Server: clear the selection under both names, whatever `SECURE_COOKIES` says, since the browser
 * picked the name by protocol.
 */
export function clearWorkspaceOnResponse(response: CookieResponse): void {
  clearSecureWorkspace(response);
  response.cookies.delete(WORKSPACE_COOKIE);
}
