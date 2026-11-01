import { describe, it, expect, beforeEach } from 'vitest';
import { addressKeys, DEFAULT_TRIAL_CAPS, noteFailedTrialCheck, reserveTrialSession, resetTrialCaps, trialCaps, trialSessionRoom } from '../caps';

/** The demo's daily caps on trial sessions: per address, per network block and in all. */
const CAPS = { perAddress: 2, perBlock: 3, total: 5 };
const NOON = Date.parse('2026-10-22T12:00:00Z');

beforeEach(() => {
  resetTrialCaps();
  delete process.env.TRIAL_DAILY_CAPS;
});

describe('addressKeys', () => {
  it('counts an IPv4 address and its /24, and an IPv6 address by its /64 and /48', () => {
    expect(addressKeys('203.0.113.7')).toEqual({ address: '4:203.0.113.7', block: '4:203.0.113' });
    expect(addressKeys('2001:db8:1:2:aaaa::1')).toEqual({ address: '6:2001:db8:1:2', block: '6:2001:db8:1' });
    expect(addressKeys('2001:db8:1:2:ffff:ffff:ffff:ffff')).toEqual(addressKeys('2001:db8:1:2::'));
    expect(addressKeys('::ffff:203.0.113.7')).toEqual(addressKeys('203.0.113.7'));
    expect(addressKeys('not an address')).toBeNull();
  });
});

describe('reserveTrialSession', () => {
  it('stops an address at its cap for the rest of the UTC day, and says when the day ends', () => {
    expect(reserveTrialSession('203.0.113.7', NOON, CAPS)).toEqual({ ok: true });
    expect(reserveTrialSession('203.0.113.7', NOON, CAPS)).toEqual({ ok: true });
    expect(reserveTrialSession('203.0.113.7', NOON, CAPS)).toEqual({ ok: false, resetAt: Date.parse('2026-10-23T00:00:00Z') });
    expect(reserveTrialSession('203.0.113.7', Date.parse('2026-10-23T00:00:01Z'), CAPS)).toEqual({ ok: true });
  });

  it('stops a block that cycles addresses, and the day once the total is reached', () => {
    expect(reserveTrialSession('203.0.113.1', NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession('203.0.113.2', NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession('203.0.113.3', NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession('203.0.113.4', NOON, CAPS).ok).toBe(false);
    expect(reserveTrialSession('198.51.100.1', NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession('192.0.2.1', NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession('192.0.2.200', NOON, CAPS).ok).toBe(false);
  });

  it('puts addresses it cannot read in one shared bucket', () => {
    expect(reserveTrialSession(null, NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession('garbage', NOON, CAPS).ok).toBe(true);
    expect(reserveTrialSession(null, NOON, CAPS).ok).toBe(false);
  });

  it('reads its caps from TRIAL_DAILY_CAPS, and keeps the defaults when that is malformed', () => {
    expect(trialCaps()).toEqual(DEFAULT_TRIAL_CAPS);
    process.env.TRIAL_DAILY_CAPS = '1, 2, 3';
    expect(trialCaps()).toEqual({ perAddress: 1, perBlock: 2, total: 3 });
    process.env.TRIAL_DAILY_CAPS = '1,x,3';
    expect(trialCaps()).toEqual(DEFAULT_TRIAL_CAPS);
  });
});

describe('trialSessionRoom', () => {
  it('closes a block after fifty failed checks from its addresses, and leaves other blocks open', () => {
    // One failure per address, so no address reaches its own limit of ten.
    for (let i = 1; i < 50; i++) noteFailedTrialCheck(`203.0.113.${i}`, NOON);
    expect(trialSessionRoom('203.0.113.200', NOON, CAPS)).toEqual({ ok: true });
    noteFailedTrialCheck('203.0.113.50', NOON);
    expect(trialSessionRoom('203.0.113.200', NOON, CAPS)).toEqual({ ok: false, resetAt: Date.parse('2026-10-23T00:00:00Z') });
    expect(trialSessionRoom('198.51.100.1', NOON, CAPS)).toEqual({ ok: true });
  });
});
