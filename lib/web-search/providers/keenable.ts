import type { WebSearchProvider } from '../types';

const SNIPPET_MAX = 1000;

/**
 * Keenable's keyless public search endpoint. No account or key; requests share a
 * per-IP limit (1,000/hour, 10/second, see docs.keenable.ai/authentication) and must
 * name the calling app in X-Keenable-Title. Keenable logs queries on its default
 * data policy (docs.keenable.ai/data-privacy).
 */
export const keenable: WebSearchProvider = {
  id: 'keenable',
  name: 'Keenable',
  auth: 'none',
  nativeContent: false,
  buildRequest(query, opts) {
    return {
      url: 'https://api.keenable.ai/v1/search/public',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Keenable-Title': 'OSW Studio',
        },
        body: JSON.stringify({ query, max_results: opts.count ?? 5 }),
      },
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
        snippet: String(r.snippet || r.description || '').slice(0, SNIPPET_MAX),
      }));
  },
};
