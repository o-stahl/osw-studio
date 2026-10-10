/**
 * Web search proxy. Runs the selected provider's search server-side with any
 * required credentials, normalizes results, and returns them. Does NOT fetch page content
 * for non-native providers; the client does that via the curl --markdown path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { webRequestPreflight } from '@/lib/web/request-guards';
import { assertPublicUrl } from '@/lib/web/ssrf-guard';
import { getWebSearchProvider, WEB_SEARCH_PROVIDERS } from '@/lib/web-search';
import type { WebSearchProviderId } from '@/lib/web-search';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const pre = await webRequestPreflight(request);
  if (!pre.ok) return pre.response;

  let payload: { provider?: string; query?: string; count?: number; markdown?: boolean; auth?: { key?: string; searxngUrl?: string } };
  try { payload = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid request body' }, { status: 400 }); }

  const { provider: providerId, query, count, markdown, auth = {} } = payload;
  if (!query || typeof query !== 'string') {
    return NextResponse.json({ error: 'missing query' }, { status: 400 });
  }
  if (!providerId || !(providerId in WEB_SEARCH_PROVIDERS)) {
    return NextResponse.json({ error: 'unknown or unconfigured search provider' }, { status: 400 });
  }
  const provider = getWebSearchProvider(providerId as WebSearchProviderId);

  // Validate credentials are present so we never send 'Bearer undefined'.
  if (provider.auth === 'key' && !auth.key) {
    return NextResponse.json({ error: `search provider ${provider.name} requires an API key` }, { status: 400 });
  }
  if (provider.auth === 'url' && !auth.searxngUrl) {
    return NextResponse.json({ error: `search provider ${provider.name} requires an instance URL` }, { status: 400 });
  }

  try {
    const signal = AbortSignal.timeout(20_000);
    if ('search' in provider) {
      return NextResponse.json({ results: await provider.search(query, { count, markdown }, signal) });
    }

    const { url, init } = provider.buildRequest(query, { count, markdown }, auth);
    // The SearXNG endpoint is user-supplied, so guard it against SSRF. Other
    // providers use hardcoded public endpoints and need no check.
    if (provider.auth === 'url') {
      await assertPublicUrl(url);
    }
    const resp = await fetch(url, { ...init, signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return NextResponse.json({ error: `provider error (${provider.name}): ${resp.status} ${text.slice(0, 200)}` }, { status: 200 });
    }
    const results = provider.normalize(await resp.json());
    return NextResponse.json({ results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout after 20s' : e.message) : 'search failed';
    return NextResponse.json({ error: `provider error (${provider.name}): ${msg}` }, { status: 200 });
  }
}
