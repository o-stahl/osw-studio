import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { secureCookies } from '@/lib/auth/secure-cookies';
import { nextUtcMidnight } from '@/lib/llm/provider-status';
import { addressKeys } from './caps';

/**
 * A trial session lives in the visitor's browser as one cookie the page cannot read (HttpOnly), sent to
 * this site only (SameSite=Strict) and sealed with AES-256-GCM, so it can be neither read nor changed:
 * the subject the inference server counts the session's allowance under, when it ends, and a keyed hash
 * of the network block (IPv4 /24, IPv6 /48) it started from. A request from another block needs a new
 * session. Nothing about a session is kept on the server.
 */

export const TRIAL_SESSION_TTL_MS = 2 * 60 * 60_000;

export interface TrialSession {
  sub: string;
  /** Epoch ms. */
  exp: number;
  block: string;
}

export function trialCookieName(): string {
  return secureCookies() ? '__Host-osws_trial' : 'osws_trial';
}

/**
 * The visitor's address: the last `X-Forwarded-For` entry. The demo's Caddy sets the header to the
 * address it sees and drops the client's own, and the app listens on localhost behind it. Next.js
 * fills the header from the socket only when a request has none, so without such a proxy a client
 * can name any address here.
 */
export function trialClientAddress(headers: Headers): string | null {
  return headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || null;
}

/**
 * The hostname the visitor asked for, from the Host header without its port: the demo's Caddy routes
 * only its own site to the app and passes the header on. (Next.js builds `nextUrl` from the address
 * the server listens on, not the one the visitor asked for.)
 */
export function trialRequestHostname(headers: Headers): string {
  return (headers.get('host') ?? '').replace(/:\d+$/, '').toLowerCase();
}

/** The network block an address belongs to, hashed under the block key. */
export function blockOf(ip: string | null, blockKey: Buffer): string {
  const block = (ip && addressKeys(ip)?.block) || 'unknown';
  return createHmac('sha256', blockKey).update(`block:${block}`).digest('base64url').slice(0, 22);
}

/**
 * A session ends at the next UTC midnight at the latest: the inference server starts a visitor's
 * allowance over then, and the demo's caps count the sessions of one day.
 */
export function newTrialSession(ip: string | null, blockKey: Buffer, now = Date.now()): TrialSession {
  const exp = Math.min(now + TRIAL_SESSION_TTL_MS, nextUtcMidnight(now));
  return { sub: 'trial_' + randomBytes(16).toString('base64url'), exp, block: blockOf(ip, blockKey) };
}

export function sealSession(session: TrialSession, sealKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/** The session a cookie holds, or null when it is missing, altered, sealed under another key or expired. */
export function openSession(value: string | undefined, sealKey: Buffer, now = Date.now()): TrialSession | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length <= 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', sealKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const session = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (typeof session?.sub !== 'string' || typeof session?.exp !== 'number' || typeof session?.block !== 'string') return null;
    return session.exp > now ? { sub: session.sub, exp: session.exp, block: session.block } : null;
  } catch {
    return null;
  }
}

/** The `Set-Cookie` value that stores a sealed session until it ends (`exp`, epoch ms). */
export function trialCookie(sealed: string, exp: number, now = Date.now()): string {
  const parts = [
    `${trialCookieName()}=${sealed}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor((exp - now) / 1000))}`,
  ];
  if (secureCookies()) parts.push('Secure');
  return parts.join('; ');
}
