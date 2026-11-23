import type { WebSearchProvider } from '../types';

const SNIPPET_MAX = 1000;

/**
 * Keenable search. Without a key it calls the public endpoint, which needs no account,
 * shares a per-IP limit (1,000/hour, 10/second, see docs.keenable.ai/authentication)
 * and must name the calling app in X-Keenable-Title. With a key it calls /v1/search,
 * where the key's organization has its own limit. Keenable logs queries on its default
 * data policy either way (docs.keenable.ai/data-privacy).
 */
export const keenable: WebSearchProvider = {
  id: 'keenable',
  name: 'Keenable',
  // The key is optional, so nothing is required up front.
  auth: 'none',
  nativeContent: false,
  buildRequest(query, opts, auth) {
    const body = JSON.stringify({
      query,
      max_results: Math.min(50, Math.max(1, opts.count ?? 5)),
      snippet_max_length: SNIPPET_MAX,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth.key) headers['X-API-Key'] = auth.key;
    else headers['X-Keenable-Title'] = 'OSW Studio';
    return {
      url: auth.key ? 'https://api.keenable.ai/v1/search' : 'https://api.keenable.ai/v1/search/public',
      init: { method: 'POST', headers, body },
    };
  },
  normalize(raw) {
    const results = raw?.results;
    if (!Array.isArray(results)) return [];
    return results
      .filter((r: any) => typeof r?.url === 'string' && r.url)
      .map((r: any) => ({
        title: r.title || r.url,
        url: r.url,
        snippet: String(r.snippet || '').slice(0, SNIPPET_MAX),
      }));
  },
};
