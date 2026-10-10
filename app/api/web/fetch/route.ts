/**
 * Outbound fetch proxy. The browser-side agent cannot fetch cross-origin, so
 * external curl routes through here. Server-side fetch with SSRF protection,
 * size/timeout caps, same-origin validation, a kill-switch, and rate limiting.
 * Nothing is persisted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertPublicUrl } from '@/lib/web/ssrf-guard';
import { webRequestPreflight } from '@/lib/web/request-guards';

export const runtime = 'nodejs';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const TEXT_TYPES = [
  'text/', 'application/json', 'application/xml', '+xml',
  'application/javascript', 'application/x-javascript', 'image/svg+xml',
];
function isTextType(ct: string): boolean {
  const c = ct.toLowerCase();
  return TEXT_TYPES.some(t => c.includes(t));
}

async function readCapped(resp: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = resp.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_BYTES) { reader.cancel(); return { bytes: new Uint8Array(0), truncated: true }; }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return { bytes: out, truncated: false };
}

export async function POST(request: NextRequest) {
  const pre = await webRequestPreflight(request);
  if (!pre.ok) return pre.response;

  let payload: { url?: string; method?: string; headers?: string[]; body?: string };
  try { payload = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid request body' }, { status: 400 }); }

  const { url, method = 'GET', headers = [], body } = payload;
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'missing url' }, { status: 400 });
  }

  // Parse the curl-style header list ("Name: value") into a Headers object.
  const outHeaders = new Headers();
  for (const h of headers) {
    const idx = h.indexOf(':');
    if (idx > 0) outHeaders.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
  }

  try {
    let current = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(current); // throws on private/blocked/invalid
      // Note: a small residual TOCTOU window remains between the DNS resolve in
      // assertPublicUrl and the actual connect below. Full IP-pinning is out of
      // scope for this threat model since the response only enters the model
      // context, not secrets.
      response = await fetch(current, {
        method,
        headers: outHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Manual redirect handling: re-validate each Location before following.
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const loc = response.headers.get('location')!;
        current = new URL(loc, current).toString();
        if (hop === MAX_REDIRECTS) {
          return NextResponse.json({ error: 'too many redirects' }, { status: 200 });
        }
        continue;
      }
      break;
    }
    if (!response) return NextResponse.json({ error: 'no response' }, { status: 200 });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // HEAD: return status + headers only
    if (method === 'HEAD') {
      return NextResponse.json({ status: response.status, contentType, encoding: 'utf8', body: '' });
    }

    const { bytes, truncated } = await readCapped(response);
    if (truncated) return NextResponse.json({ error: 'response too large (>5MB)' }, { status: 200 });

    if (isTextType(contentType)) {
      const text = new TextDecoder().decode(bytes);
      return NextResponse.json({ status: response.status, contentType, encoding: 'utf8', body: text });
    }
    const base64 = Buffer.from(bytes).toString('base64');
    return NextResponse.json({ status: response.status, contentType, encoding: 'base64', body: base64 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'request failed';
    // assertPublicUrl throws 'blocked: ...'; timeouts throw a DOMException named TimeoutError.
    if (e instanceof Error && e.name === 'TimeoutError') {
      return NextResponse.json({ error: 'timeout after 20s' }, { status: 200 });
    }
    return NextResponse.json({ error: msg }, { status: 200 });
  }
}
