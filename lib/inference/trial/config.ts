import { readFileSync } from 'fs';
import { hkdfSync } from 'crypto';
import { importPKCS8, type CryptoKey } from 'jose';

/**
 * The demo's trial of the free allowance (lib/inference/allowance.ts) runs on the demo's own server: it
 * shows the bot check, starts sessions and mints the tokens the inference server takes for its `trial`
 * pool. Read at run time from
 *
 * - `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`: the Cloudflare Turnstile widget;
 * - `TRIAL_SIGNING_KEY_FILE` (or `TRIAL_SIGNING_KEY`, the PKCS8 PEM itself with `\n` for line breaks)
 *   and `TRIAL_SIGNING_KID`: an Ed25519 key whose public half the inference server accepts for the
 *   trial pool only.
 *
 * Without all of them there is no trial, and the allowance's status check says it is unavailable.
 */

export interface TrialConfig {
  siteKey: string;
  secretKey: string;
  signingKey: CryptoKey;
  kid: string;
  /** Seals the session cookie. Derived from the signing key, so a new key ends every session. */
  sealKey: Buffer;
  /** Keys the hash of a session's network block (`blockOf`); derived the same way, for that use alone. */
  blockKey: Buffer;
}

/** A signing key that could not be read is read again after this long: its file may not be in place yet. */
const RETRY_MS = 60_000;

let config: Promise<TrialConfig | null> | null = null;
let retryAt = Infinity;

function signingPem(): string | null {
  const inline = process.env.TRIAL_SIGNING_KEY;
  if (inline) return inline.replace(/\\n/g, '\n');
  const file = process.env.TRIAL_SIGNING_KEY_FILE;
  return file ? readFileSync(file, 'utf8') : null;
}

async function load(): Promise<TrialConfig | null> {
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  const kid = process.env.TRIAL_SIGNING_KID;
  if (!siteKey || !secretKey || !kid) return null;
  try {
    const pem = signingPem();
    if (!pem) return null;
    return {
      siteKey,
      secretKey,
      kid,
      signingKey: await importPKCS8(pem, 'EdDSA'),
      sealKey: Buffer.from(hkdfSync('sha256', pem, '', 'osws-trial-session', 32)),
      blockKey: Buffer.from(hkdfSync('sha256', pem, '', 'osws-trial-block', 32)),
    };
  } catch (err) {
    console.error('[trial] signing key unusable:', (err as Error).message);
    retryAt = Date.now() + RETRY_MS;
    return null;
  }
}

export function trialConfig(): Promise<TrialConfig | null> {
  if (!config || Date.now() >= retryAt) {
    retryAt = Infinity;
    config = load();
  }
  return config;
}
