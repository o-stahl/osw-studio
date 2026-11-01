import { createHmac, randomBytes } from 'crypto';
import { isIPv4, isIPv6 } from 'net';

/**
 * How many trial sessions the demo starts per UTC day: per address (IPv4 /32, IPv6 /64), per wider block
 * (IPv4 /24, IPv6 /48, which catches one network cycling its addresses) and in all. Counted in this
 * process's memory by a keyed hash under the day's random key; the key and the counts go when the day
 * does, and nothing is written anywhere. A restart starts the day's counts over.
 *
 * `TRIAL_DAILY_CAPS` ("address,block,total") overrides the defaults.
 */

export interface TrialCaps {
  perAddress: number;
  perBlock: number;
  total: number;
}

export const DEFAULT_TRIAL_CAPS: TrialCaps = { perAddress: 3, perBlock: 20, total: 150 };

export function trialCaps(): TrialCaps {
  const raw = process.env.TRIAL_DAILY_CAPS;
  if (!raw) return DEFAULT_TRIAL_CAPS;
  const [perAddress, perBlock, total] = raw.split(',').map((n) => Number(n.trim()));
  const valid = [perAddress, perBlock, total].every((n) => Number.isInteger(n) && n >= 0);
  return valid ? { perAddress, perBlock, total } : DEFAULT_TRIAL_CAPS;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.split('%')[0].toLowerCase();
  if (!isIPv6(addr)) return null;
  let tail: number[] = [];
  const embedded = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const p = embedded[2].split('.').map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    addr = embedded[1].endsWith('::') ? embedded[1] : embedded[1].slice(0, -1);
  }
  const parse = (part: string) => (part ? part.split(':').map((h) => parseInt(h, 16)) : []);
  const compressed = addr.includes('::');
  const [left, right] = compressed ? addr.split('::') : [addr, ''];
  const head = parse(left);
  const rest = compressed ? parse(right) : [];
  const zeros = 8 - tail.length - head.length - rest.length;
  if (zeros < 0 || (!compressed && zeros !== 0)) return null;
  return [...head, ...new Array(zeros).fill(0), ...rest, ...tail];
}

/** What is counted for an address: itself and its wider block, as text to hash. Null when unparseable. */
export function addressKeys(ip: string): { address: string; block: string } | null {
  const trimmed = ip.trim();
  let v4 = isIPv4(trimmed) ? trimmed.split('.') : null;
  if (!v4) {
    const groups = ipv6Groups(trimmed);
    if (!groups) return null;
    // An IPv4 client seen through an IPv6 socket (::ffff:a.b.c.d) is still that IPv4 client.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      v4 = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].map(String);
    } else {
      const hex = groups.map((g) => g.toString(16));
      return { address: `6:${hex.slice(0, 4).join(':')}`, block: `6:${hex.slice(0, 3).join(':')}` };
    }
  }
  return { address: `4:${v4.join('.')}`, block: `4:${v4.slice(0, 3).join('.')}` };
}

export type CapDecision = { ok: true } | { ok: false; resetAt: number };

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Failed checks a day, per address and per block, after which the demo stops asking Cloudflare. */
const FAILED_CHECKS = { perAddress: 10, perBlock: 50 };

let day = '';
let dayKey = randomBytes(32);
const counts = new Map<string, number>();

/** Starts a new day's counts when the UTC day has turned, and returns when the next day starts. */
function today(now: number): number {
  const date = isoDay(now);
  if (date !== day) {
    day = date;
    dayKey = randomBytes(32);
    counts.clear();
  }
  return Date.parse(`${date}T00:00:00.000Z`) + DAY_MS;
}

/** The day's counter keys for an address: hashed under the day's key, never the address itself. */
function keysFor(ip: string | null): { address: string; block: string } {
  const hash = (text: string) => createHmac('sha256', dayKey).update(text).digest('base64url');
  // Addresses that cannot be read share one bucket: stricter, never more lenient.
  const keys = (ip && addressKeys(ip)) || { address: 'unknown', block: 'unknown' };
  return { address: hash(keys.address), block: hash(keys.block) };
}

function sessionCounters(ip: string | null, caps: TrialCaps): Array<[key: string, cap: number]> {
  const { address, block } = keysFor(ip);
  return [
    [`address:${address}`, caps.perAddress],
    [`block:${block}`, caps.perBlock],
    ['total', caps.total],
  ];
}

const full = (counters: Array<[key: string, cap: number]>) => counters.some(([key, cap]) => (counts.get(key) ?? 0) >= cap);

/**
 * Whether the address could have a session now, without counting one: asked before the bot check, so a
 * network with nothing left costs no call to Cloudflare. Also refused after too many failed checks.
 */
export function trialSessionRoom(ip: string | null, now = Date.now(), caps: TrialCaps = trialCaps()): CapDecision {
  const resetAt = today(now);
  const { address, block } = keysFor(ip);
  const failed: Array<[key: string, cap: number]> = [
    [`failed:${address}`, FAILED_CHECKS.perAddress],
    [`failedBlock:${block}`, FAILED_CHECKS.perBlock],
  ];
  return full(sessionCounters(ip, caps)) || full(failed) ? { ok: false, resetAt } : { ok: true };
}

/** Count a bot check that did not pass against the address and its block. */
export function noteFailedTrialCheck(ip: string | null, now = Date.now()): void {
  today(now);
  const { address, block } = keysFor(ip);
  for (const key of [`failed:${address}`, `failedBlock:${block}`]) counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Count one session against the address, its block and the day's total, or refuse when any of the three
 * is full. A refusal says when the next UTC day starts.
 */
export function reserveTrialSession(ip: string | null, now = Date.now(), caps: TrialCaps = trialCaps()): CapDecision {
  const resetAt = today(now);
  const counters = sessionCounters(ip, caps);
  if (full(counters)) return { ok: false, resetAt };
  for (const [key] of counters) counts.set(key, (counts.get(key) ?? 0) + 1);
  return { ok: true };
}

/** Sessions left in the day's total, for the demo's status check. */
export function trialSessionsLeftToday(now = Date.now(), caps: TrialCaps = trialCaps()): number {
  today(now);
  return Math.max(0, caps.total - (counts.get('total') ?? 0));
}

/** Forget the day's counts. For tests. */
export function resetTrialCaps(): void {
  day = '';
  counts.clear();
}
