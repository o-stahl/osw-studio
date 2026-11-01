import { NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { isDemo } from '@/lib/demo';
import { noteFailedTrialCheck, reserveTrialSession, trialSessionRoom } from './caps';
import { TRIAL_ACTION, verifyTrialCheck } from './check';
import { trialConfig } from './config';
import { blockOf, newTrialSession, openSession, sealSession, trialCookie } from './session';

/**
 * The demo's trial of the free allowance, on the demo's own server (see `./config.ts`). A visitor's
 * browser solves the bot check and gets a session cookie (`./session.ts`), within the day's caps
 * (`./caps.ts`). Each request to the inference server then carries a five-minute token minted here for
 * the session's subject, so no token ever reaches the browser, and the inference server counts the
 * session's allowance under that subject. A session ends when it expires, when its allowance is spent,
 * or for a request from another network; the page then runs the check again.
 */

export { trialClientAddress, trialCookieName, trialRequestHostname } from './session';

const TRIAL_TOKEN_ISSUER = 'https://oswstudio.com';
const TRIAL_TOKEN_AUDIENCE = 'inference.oswstudio.com';
const REQUEST_TOKEN_TTL_S = 5 * 60;

export interface TrialAnswer {
  status: number;
  body: Record<string, unknown>;
  /** A `Set-Cookie` value to send with the answer. */
  cookie?: string;
}

const unavailable = (): TrialAnswer => ({
  status: 503,
  body: { error: 'OSW Studio inference is not available right now.', code: 'model_unavailable' },
});

/** An answer as a response that is never cached, with its cookie. */
export function trialResponse(answer: TrialAnswer): NextResponse {
  const res = NextResponse.json(answer.body, { status: answer.status, headers: { 'Cache-Control': 'no-store' } });
  if (answer.cookie) res.headers.append('Set-Cookie', answer.cookie);
  return res;
}

/**
 * The answer that sends the page to the check for a new session. It leaves the cookie alone: it can
 * arrive after a parallel request has started a new session, and a cookie that has expired or is from
 * another network is refused anyway until the next session replaces it.
 */
export function trialSessionNeeded(): TrialAnswer {
  return { status: 401, body: { error: 'OSW Studio inference needs a new check.', code: 'trial_session' } };
}

function limitReached(resetAt: number): TrialAnswer {
  return { status: 429, body: { error: 'No more trial sessions for this network today.', code: 'trial_limit', resetAt } };
}

/** Whether the trial can run here at all: on the demo, configured. */
export async function trialAvailable(): Promise<boolean> {
  return isDemo() && (await trialConfig()) !== null;
}

/** What the page needs to render the check. */
export async function trialSetup(): Promise<TrialAnswer> {
  const cfg = isDemo() ? await trialConfig() : null;
  return { status: 200, body: { available: cfg !== null, siteKey: cfg?.siteKey ?? null, action: TRIAL_ACTION } };
}

/** Exchange a solved check for a session cookie, within the day's caps. */
export async function issueTrialSession(
  input: { ip: string | null; hostname: string; body: unknown },
  now = Date.now(),
): Promise<TrialAnswer> {
  const cfg = isDemo() ? await trialConfig() : null;
  if (!cfg) return unavailable();

  const solve = (input.body as { turnstileToken?: unknown } | null)?.turnstileToken;
  if (typeof solve !== 'string' || !solve || solve.length > 2048) {
    return { status: 400, body: { error: 'turnstileToken is required.', code: 'bad_request' } };
  }
  // A network with no sessions left, or too many failed checks today, costs no call to Cloudflare.
  const room = trialSessionRoom(input.ip, now);
  if (!room.ok) return limitReached(room.resetAt);

  const verdict = await verifyTrialCheck(cfg.secretKey, solve, { remoteIp: input.ip, hostname: input.hostname }, now);
  if (!verdict.ok) {
    if (verdict.reason === 'unreachable') return unavailable();
    noteFailedTrialCheck(input.ip, now);
    return { status: 403, body: { error: 'The bot check did not pass.', code: 'bot_check_failed' } };
  }

  const reserved = reserveTrialSession(input.ip, now);
  if (!reserved.ok) return limitReached(reserved.resetAt);
  const session = newTrialSession(input.ip, cfg.blockKey, now);
  return { status: 200, body: { expiresAt: session.exp }, cookie: trialCookie(sealSession(session, cfg.sealKey), session.exp, now) };
}

/**
 * A token for one request to the inference server, for the session in the request's cookie. None when
 * there is no session, it is over, or the request comes from another network than it started on.
 */
export async function trialRequestToken(
  input: { ip: string | null; cookie: string | undefined },
  now = Date.now(),
): Promise<{ ok: true; token: string } | { ok: false; answer: TrialAnswer }> {
  const cfg = isDemo() ? await trialConfig() : null;
  if (!cfg) return { ok: false, answer: unavailable() };
  const session = openSession(input.cookie, cfg.sealKey, now);
  if (!session || session.block !== blockOf(input.ip, cfg.blockKey)) return { ok: false, answer: trialSessionNeeded() };

  const iat = Math.floor(now / 1000);
  const token = await new SignJWT({ pool: 'trial' })
    .setProtectedHeader({ alg: 'EdDSA', kid: cfg.kid })
    .setIssuer(TRIAL_TOKEN_ISSUER)
    .setAudience(TRIAL_TOKEN_AUDIENCE)
    .setSubject(session.sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + REQUEST_TOKEN_TTL_S)
    .sign(cfg.signingKey);
  return { ok: true, token };
}
