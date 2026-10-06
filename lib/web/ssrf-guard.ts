import net from 'node:net';

// Expand an IPv6 literal into its 8 numeric hextets, handling the "::" gap and
// an optional embedded dotted-IPv4 tail. Returns null if it cannot be parsed.
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // Handle an embedded dotted IPv4 tail by converting it to two hextets first.
  const dotted = s.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    if ([a, b, c, d].some(n => n > 255 || Number.isNaN(n))) return null;
    const h6 = ((a << 8) | b).toString(16);
    const h7 = ((c << 8) | d).toString(16);
    s = dotted[1] + h6 + ':' + h7;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  const missing = 8 - (head.length + tail.length);
  if (parts.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = parts.length === 2
    ? [...head, ...Array(missing).fill('0'), ...tail]
    : head;
  const nums = groups.map(g => parseInt(g || '0', 16));
  if (nums.length !== 8 || nums.some(n => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127) return true;             // this-host, loopback
    if (a === 10) return true;                          // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
    if (a === 192 && b === 168) return true;            // 192.168/16
    if (a === 169 && b === 254) return true;            // link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64/10
    if (a === 192 && b === 0 && ip.split('.')[2] === '0') return true; // IETF protocol 192.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
    if (a >= 224) return true;                          // multicast 224/4, reserved 240/4, broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const h = expandIpv6(ip);
    // Fail closed: something net.isIPv6 accepted but we cannot normalize.
    if (!h) return true;
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h;

    // Loopback (::1 in any spelling) and unspecified (::).
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0) {
      return h7 === 0 || h7 === 1;
    }

    // Link-local fe80::/10 and the deprecated site-local fec0::/10.
    if (h0 >= 0xfe80 && h0 <= 0xfeff) return true;

    // Multicast ff00::/8.
    if (h0 >> 8 === 0xff) return true;

    // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) only ever translates inside a private network.
    if (h0 === 0x64 && h1 === 0xff9b && h2 === 1) return true;

    // NAT64 64:ff9b::/96 and 6to4 2002::/16 carry an IPv4 address that the packet reaches.
    if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      return isPrivateIp(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
    }
    if (h0 === 0x2002) {
      return isPrivateIp(`${h1 >> 8}.${h1 & 0xff}.${h2 >> 8}.${h2 & 0xff}`);
    }

    // ULA fc00::/7 (high byte 0xfc or 0xfd).
    const highByte = h0 >> 8;
    if (highByte === 0xfc || highByte === 0xfd) return true;

    // Embedded IPv4: IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d).
    // First 5 hextets zero and the 6th is 0x0000 or 0xffff.
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0 || h5 === 0xffff)) {
      const a = h6 >> 8, b = h6 & 0xff, c = h7 >> 8, d = h7 & 0xff;
      return isPrivateIp(`${a}.${b}.${c}.${d}`);
    }

    // Fallback prefix checks (belt and suspenders).
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true;
    const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // not a valid IP literal -> treat as unsafe
}

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

export type Resolver = (hostname: string) => Promise<string[]>;

/**
 * Thrown when a host is refused by this guard, as opposed to being unreachable or unresolvable.
 *
 * A caller needs to tell those apart. A refusal is a decision this process made and can be reported
 * as one; anything else is the network answering, and reporting it as a refusal would hide a typo in
 * a hostname behind a security message. The type is the distinction — callers must not have to match
 * on the wording.
 */
export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedHostError';
  }
}

/**
 * Refuse a host that is, or resolves to, an address on the machine's own networks.
 *
 * Split out from `assertPublicUrl` because not every destination is a URL — an SMTP server is a bare
 * host and a port, and it needs the same check for the same reason. A name is not evidence on its
 * own: `smtp.example.com` with an A record of 169.254.169.254 is the case worth catching, so every
 * answer the resolver returns is checked and one private answer is enough to refuse.
 *
 * Returns the addresses that passed, so a caller can connect to one of those rather than resolving
 * the name a second time. Between the two lookups the owner of the name is free to change what it
 * answers, and a record with a short TTL can answer publicly for this check and privately for the
 * connection — the check is only worth what the caller connects to.
 */
export async function assertPublicHost(
  host: string,
  opts: { resolve?: Resolver } = {},
): Promise<string[]> {
  if (isBlockedHostname(host)) throw new BlockedHostError('blocked: private hostname');

  // If the host is an IP literal, check directly; otherwise resolve and check every A/AAAA.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new BlockedHostError('blocked: private address');
    return [host];
  }
  const resolve = opts.resolve ?? (async (h: string) => {
    const dns = await import('node:dns');
    const records = await dns.promises.lookup(h, { all: true });
    return records.map(r => r.address);
  });
  const ips = await resolve(host);
  if (ips.length === 0) throw new BlockedHostError('blocked: no address');
  for (const ip of ips) {
    // Never include the address in the message: it would report the shape of the internal network
    // back to whoever supplied the hostname.
    if (isPrivateIp(ip)) throw new BlockedHostError('blocked: private address');
  }
  return ips;
}

export async function assertPublicUrl(
  raw: string,
  opts: { resolve?: Resolver } = {},
): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedHostError(`blocked: unsupported scheme ${url.protocol}`);
  }
  // url.hostname wraps IPv6 literals in brackets (e.g. "[::1]"); strip them so
  // net.isIP and isPrivateIp receive a bare literal.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  await assertPublicHost(host, opts);
  return url;
}
