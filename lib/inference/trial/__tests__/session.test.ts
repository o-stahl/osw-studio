import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import { blockOf, newTrialSession, openSession, sealSession, trialClientAddress, trialCookie, trialCookieName, trialRequestHostname, TRIAL_SESSION_TTL_MS } from '../session';

/** The trial session cookie: sealed, bound to its network block, readable by nobody but this server. */
const KEY = randomBytes(32);
const NOW = Date.parse('2026-10-22T12:00:00Z');

afterEach(() => {
  delete process.env.SECURE_COOKIES;
  (process.env as Record<string, string>).NODE_ENV = 'test';
});

describe('the sealed session', () => {
  it('opens to what was sealed, until it is over', () => {
    const s = newTrialSession('203.0.113.7', KEY, NOW);
    expect(s.sub).toMatch(/^trial_[A-Za-z0-9_-]{22}$/);
    expect(s.exp).toBe(NOW + TRIAL_SESSION_TTL_MS);
    const sealed = sealSession(s, KEY);
    expect(sealed).not.toContain(s.sub);
    expect(openSession(sealed, KEY, NOW + 1000)).toEqual(s);
    expect(openSession(sealed, KEY, s.exp)).toBeNull();
  });

  it('does not open when altered, sealed under another key, or not a session at all', () => {
    const session = newTrialSession('203.0.113.7', KEY, NOW);
    const sealed = sealSession(session, KEY);
    // A cookie is iv (12 bytes), tag (16), ciphertext. GCM encrypts as a stream, so XOR-ing a ciphertext
    // byte flips the same plaintext byte: this makes the first digit of `exp` a 9, a well-formed session
    // lasting centuries that only the tag check refuses.
    const plain = JSON.stringify(session);
    const digit = plain.indexOf('"exp":') + 6;
    const extended = Buffer.from(sealed, 'base64url');
    extended[28 + digit] ^= plain.charCodeAt(digit) ^ '9'.charCodeAt(0);
    expect(openSession(extended.toString('base64url'), KEY, NOW)).toBeNull();
    const retagged = Buffer.from(sealed, 'base64url');
    retagged[12] ^= 1;
    expect(openSession(retagged.toString('base64url'), KEY, NOW)).toBeNull();
    expect(openSession(sealed, randomBytes(32), NOW)).toBeNull();
    expect(openSession('not-a-session', KEY, NOW)).toBeNull();
    expect(openSession(undefined, KEY, NOW)).toBeNull();
  });

  it('ends at the next UTC midnight at the latest, where the inference server starts the visitor\'s day over', () => {
    const late = Date.parse('2026-10-22T23:00:00Z');
    expect(newTrialSession('203.0.113.7', KEY, late).exp).toBe(Date.parse('2026-10-23T00:00:00Z'));
  });

  it('gives every session its own subject', () => {
    expect(newTrialSession('203.0.113.7', KEY, NOW).sub).not.toBe(newTrialSession('203.0.113.7', KEY, NOW).sub);
  });
});

describe('the network a session is bound to', () => {
  it('is the /24 or /48, hashed, and unreadable addresses share one', () => {
    expect(blockOf('203.0.113.7', KEY)).toBe(blockOf('203.0.113.250', KEY));
    expect(blockOf('203.0.113.7', KEY)).not.toBe(blockOf('203.0.114.7', KEY));
    expect(blockOf('2001:db8:1:2::1', KEY)).toBe(blockOf('2001:db8:1:ffff::1', KEY));
    expect(blockOf('2001:db8:1:2::1', KEY)).not.toBe(blockOf('2001:db8:2::1', KEY));
    expect(blockOf(null, KEY)).toBe(blockOf('garbage', KEY));
    expect(blockOf('203.0.113.7', KEY)).not.toContain('203');
    expect(blockOf('203.0.113.7', randomBytes(32))).not.toBe(blockOf('203.0.113.7', KEY));
  });

  it("reads the visitor's address from the last X-Forwarded-For entry, the one the proxy sets", () => {
    expect(trialClientAddress(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(trialClientAddress(new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(trialClientAddress(new Headers())).toBeNull();
  });

  it('reads the hostname the visitor asked for from the Host header, without its port', () => {
    expect(trialRequestHostname(new Headers({ host: 'try.oswstudio.com' }))).toBe('try.oswstudio.com');
    expect(trialRequestHostname(new Headers({ host: 'Try.OSWS.localhost:3005' }))).toBe('try.osws.localhost');
    expect(trialRequestHostname(new Headers())).toBe('');
  });
});

describe('the cookie', () => {
  it('cannot be read by the page, goes to this site only, and lasts as long as the session', () => {
    expect(trialCookie('sealed', NOW + TRIAL_SESSION_TTL_MS, NOW)).toBe(`osws_trial=sealed; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TRIAL_SESSION_TTL_MS / 1000}`);
    expect(trialCookie('sealed', NOW + 3_600_500, NOW)).toMatch(/; Max-Age=3600$/);
  });

  it('is Secure, with the __Host- prefix, in production', () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(trialCookieName()).toBe('__Host-osws_trial');
    expect(trialCookie('sealed', NOW + TRIAL_SESSION_TTL_MS, NOW)).toMatch(/^__Host-osws_trial=sealed; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7200; Secure$/);
  });
});
