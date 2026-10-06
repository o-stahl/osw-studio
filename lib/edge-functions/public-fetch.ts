/**
 * Outbound `fetch` for function code, refusing the machine's own networks: loopback, private ranges,
 * link-local (cloud metadata), CGNAT, and names that resolve to any of them.
 *
 * The refusal happens where the connection is made. A check that resolves a name and then hands the
 * URL to `fetch` lets `fetch` resolve it again, and a name with a short TTL can answer publicly for the
 * check and privately for the connection. `publicAgent` resolves through `publicLookup`, which refuses
 * a private answer, so the address checked is the address connected to. `assertPublicUrl` still runs
 * first: it refuses an IP literal (which never reaches a lookup) and gives the early, plain refusal.
 *
 * Redirects are followed here rather than by `fetch`, so every hop is checked and counted.
 * `FUNCTIONS_ALLOW_PRIVATE_FETCH=true` lifts the check for an install whose functions are meant to
 * reach local services.
 */
import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { assertPublicUrl, BlockedHostError, isPrivateIp } from '@/lib/web/ssrf-guard';

/** Redirects one `fetch` follows. */
export const MAX_FETCH_REDIRECTS = 5;
/** The statuses `fetch` itself follows; any other 3xx is returned to the caller as it is. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Request headers that stay with their origin when a redirect leaves it, as a browser's fetch does. */
const ORIGIN_BOUND_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
/** Headers that describe a body, dropped with it when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];

const REFUSED = 'Requests to private/internal addresses are not allowed';

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `dns.lookup` for the connection itself, failing when any answer is a private address. */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
      return callback(Object.assign(new BlockedHostError(REFUSED), { code: 'EBLOCKED' }), []);
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

const publicAgent = new Agent({ connect: { lookup: publicLookup } });

function isBlocked(error: unknown): boolean {
  for (let e = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof BlockedHostError || (e as { code?: string }).code === 'EBLOCKED') return true;
  }
  return false;
}

function checkScheme(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https protocols are allowed');
  }
}

/**
 * Fetch `url` for function code. `countRequest` is called before every request after the first, so
 * redirect hops count against the caller's request limit; it throws to stop.
 */
export async function publicFetch(
  url: string,
  init: RequestInit,
  countRequest: () => void = () => {},
): Promise<{ response: Response; url: string }> {
  const allowPrivate = process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH === 'true';
  let current = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let hop = 0; ; hop++) {
    checkScheme(new URL(current));
    if (hop > 0) countRequest();

    let response: Response;
    try {
      if (!allowPrivate) await assertPublicUrl(current);
      response = (await undiciFetch(current, {
        ...(init as object),
        method,
        body: body as never,
        headers,
        redirect: 'manual',
        ...(allowPrivate ? {} : { dispatcher: publicAgent }),
      })) as unknown as Response;
    } catch (error) {
      if (isBlocked(error)) throw new Error(REFUSED);
      throw error;
    }

    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (!location) return { response, url: current };

    await response.body?.cancel();
    if (hop >= MAX_FETCH_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_FETCH_REDIRECTS})`);
    }
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) {
      for (const name of ORIGIN_BOUND_HEADERS) headers.delete(name);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    current = next.toString();
  }
}
