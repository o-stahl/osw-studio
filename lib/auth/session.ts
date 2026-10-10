/**
 * Session Management for Server Mode
 *
 * Simple JWT-based session management using jose library
 */

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { secureCookies } from './secure-cookies';

/** The session cookie's name before it took the `__Host-` prefix, and wherever cookies are not Secure. */
const LEGACY_SESSION_COOKIE_NAME = 'osw_session';
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable not set');
  }
  return new TextEncoder().encode(secret);
}

export interface SessionData {
  userId: string;
  email: string;
  isAdmin: boolean;
  exp: number;
}

/**
 * Create a new session token
 */
export async function createSession(userId: string, email: string, isAdmin = false): Promise<string> {
  const secret = getSecretKey();
  const exp = Math.floor((Date.now() + SESSION_DURATION) / 1000);

  const token = await new SignJWT({
    userId,
    email,
    isAdmin,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(exp)
    .setIssuedAt()
    .sign(secret);

  return token;
}

/**
 * Verify and decode a session token
 */
export async function verifySession(token: string): Promise<SessionData | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(token, secret);

    // SESSION_SECRET also signs handoff tokens and review-session cookies, and a review cookie is
    // handed to any anonymous visitor of a review copy — so a valid signature on its own no longer
    // means "account session". Every other family stamps a `purpose`; account sessions never do, so
    // refusing any stamped token tells them apart here rather than leaving it to a downstream user
    // lookup that happens to find nothing.
    if (payload.purpose !== undefined) return null;

    return {
      userId: payload.userId as string,
      email: payload.email as string,
      isAdmin: payload.isAdmin as boolean,
      exp: payload.exp as number,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Returns a refreshed token if the session is past the halfway point of its
 * lifetime, otherwise null (keep the existing cookie).
 *
 * Used by middleware to extend active sessions without re-issuing a cookie on
 * every single request.
 */
export async function maybeRefreshSession(session: SessionData): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const remainingMs = (session.exp - nowSec) * 1000;
  if (remainingMs > SESSION_DURATION / 2) return null;
  return createSession(session.userId, session.email, session.isAdmin);
}


/**
 * The session cookie's name. `__Host-` wherever cookies are Secure: the browser then accepts it only
 * from this exact host, with `Path=/` and no `Domain`, so a published site on a subdomain of the same
 * domain cannot plant one for the studio (cookie tossing). Plain HTTP cannot carry the prefix.
 */
export function sessionCookieName(): string {
  return secureCookies() ? `__Host-${LEGACY_SESSION_COOKIE_NAME}` : LEGACY_SESSION_COOKIE_NAME;
}

/**
 * Put a new session on a response. Also clears a session cookie still held under the old name,
 * which the browser would otherwise keep sending until it expired.
 */
export function setSessionOnResponse(
  response: { cookies: { set(name: string, value: string, options: object): unknown; delete(name: string): unknown } },
  token: string
): void {
  const name = sessionCookieName();
  response.cookies.set(name, token, sessionCookieOptions());
  if (name !== LEGACY_SESSION_COOKIE_NAME) response.cookies.delete(LEGACY_SESSION_COOKIE_NAME);
}

/**
 * Clear the session on a response. A `__Host-` cookie is cleared only by a Set-Cookie that carries
 * the same attributes (Secure, Path=/): a bare delete is refused by the browser and leaves it set.
 */
export function clearSessionOnResponse(
  response: { cookies: { set(name: string, value: string, options: object): unknown; delete(name: string): unknown } }
): void {
  response.cookies.set(sessionCookieName(), '', { ...sessionCookieOptions(), maxAge: 0 });
  if (sessionCookieName() !== LEGACY_SESSION_COOKIE_NAME) response.cookies.delete(LEGACY_SESSION_COOKIE_NAME);
}

/** The attributes every place that sets the session cookie uses. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax' as const,
    maxAge: SESSION_DURATION / 1000,
    path: '/',
  };
}

/**
 * Get current session from cookies
 */
export async function getSession(): Promise<SessionData | null> {
  // Desktop app: always authenticated as local admin
  if (process.env.OSW_DESKTOP === 'true') {
    return { userId: 'desktop', email: 'desktop@localhost', isAdmin: true, exp: 253402300799 };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;

  if (!token) {
    return null;
  }

  const session = await verifySession(token);
  if (!session) return null;

  // Check user is still active (prevents deactivated users from continuing)
  if (session.userId !== 'admin' && session.userId !== 'desktop' && session.userId !== 'instance-api') {
    try {
      const { getUserById } = await import('@/lib/auth/system-database');
      const user = getUserById(session.userId);
      if (!user) return null;
    } catch {
      // System database not available (browser mode) — skip check
    }
  }

  return session;
}


/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return session !== null;
}

/**
 * Require authentication (throws if not authenticated)
 */
export async function requireAuth(): Promise<SessionData> {
  const session = await getSession();
  if (!session) {
    throw new Error('Unauthorized');
  }
  return session;
}

/**
 * Verify instance API key for machine-to-machine auth.
 * Returns a synthetic admin session if the key is valid.
 * When GATEWAY_IPS is set, restricts to those source IPs only.
 */
export function verifyInstanceApiKey(request: NextRequest): SessionData | null {
  const apiKey = request.headers.get('x-instance-api-key');
  const expectedKey = process.env.INSTANCE_API_KEY;

  if (!apiKey || !expectedKey) return null;
  try {
    const a = Buffer.from(apiKey);
    const b = Buffer.from(expectedKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const allowedIps = process.env.GATEWAY_IPS;
  if (allowedIps) {
    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-real-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const allowed = new Set(allowedIps.split(',').map(ip => ip.trim()));
    if (!clientIp || !allowed.has(clientIp)) return null;
  }

  return {
    userId: 'instance-api',
    email: 'api@instance',
    isAdmin: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Create a short-lived handoff token for external auth → instance session exchange.
 * Token is a JWT valid for 30 seconds, signed with the same SESSION_SECRET.
 */
export async function createHandoffToken(userId: string): Promise<string> {
  const secret = getSecretKey();
  const token = await new SignJWT({
    userId,
    purpose: 'handoff',
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30s')
    .setIssuedAt()
    .sign(secret);
  return token;
}

// In-memory set of consumed JTIs for replay protection (auto-clears after 60s)
const consumedJTIs = new Map<string, number>();

/**
 * Verify a handoff token. Returns the userId if valid, null otherwise.
 * Single-use: consumed tokens are rejected.
 */
export async function verifyHandoffToken(token: string): Promise<{ userId: string } | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(token, secret);

    if (payload.purpose !== 'handoff') return null;

    const jti = payload.jti;
    if (!jti || consumedJTIs.has(jti)) return null;

    // Mark as consumed
    consumedJTIs.set(jti, Date.now());

    // Cleanup old JTIs
    const cutoff = Date.now() - 60000;
    for (const [id, time] of consumedJTIs) {
      if (time < cutoff) consumedJTIs.delete(id);
    }

    return { userId: payload.userId as string };
  } catch {
    return null;
  }
}
