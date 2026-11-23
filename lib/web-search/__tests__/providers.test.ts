import { describe, it, expect, vi } from 'vitest';
import { duckduckgo } from '../providers/duckduckgo';
import { tavily } from '../providers/tavily';
import { brave } from '../providers/brave';
import { searxng } from '../providers/searxng';
import { firecrawl } from '../providers/firecrawl';
import { keenable } from '../providers/keenable';

vi.mock('ts-duckduckgo-search', () => ({
  searchDuckDuckGo: vi.fn(async () => [
    { title: 'T', url: 'https://x', description: 'd' },
  ]),
}));

describe('duckduckgo', () => {
  it('searches without credentials and normalizes results', async () => {
    expect(duckduckgo.auth).toBe('none');
    await expect(duckduckgo.search('q', { count: 1 }, AbortSignal.timeout(1000)))
      .resolves.toEqual([{ title: 'T', url: 'https://x', snippet: 'd' }]);
  });

  it('maps a library failure to an actionable error', async () => {
    const { searchDuckDuckGo } = await import('ts-duckduckgo-search');
    vi.mocked(searchDuckDuckGo).mockRejectedValueOnce(new Error('challenge-form'));
    await expect(duckduckgo.search('q', { count: 1 }, AbortSignal.timeout(1000)))
      .rejects.toThrow(/switch to another search provider/);
  });
});

describe('tavily', () => {
  it('normalizes results and raw_content', () => {
    const raw = { results: [{ title: 'T', url: 'https://x', content: 'snip', raw_content: '# md' }] };
    expect(tavily.normalize(raw)).toEqual([{ title: 'T', url: 'https://x', snippet: 'snip', content: '# md' }]);
  });
  it('returns [] when results missing', () => {
    expect(tavily.normalize({})).toEqual([]);
  });
  it('builds a POST request with bearer auth and max_results', () => {
    const { url, init } = tavily.buildRequest('q', { count: 3, markdown: true }, { key: 'k' });
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ query: 'q', max_results: 3, include_raw_content: 'markdown' });
  });
});

describe('brave', () => {
  it('normalizes web.results[].description to snippet, no content', () => {
    const raw = { web: { results: [{ title: 'T', url: 'https://x', description: 'd' }] } };
    expect(brave.normalize(raw)).toEqual([{ title: 'T', url: 'https://x', snippet: 'd' }]);
  });
  it('returns [] when web missing', () => {
    expect(brave.normalize({})).toEqual([]);
  });
  it('builds a GET request with subscription token', () => {
    const { url, init } = brave.buildRequest('hello world', { count: 8 }, { key: 'bk' });
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search?q=hello');
    expect(url).toContain('count=8');
    expect((init.headers as Record<string,string>)['X-Subscription-Token']).toBe('bk');
  });
});

describe('searxng', () => {
  it('normalizes results[].content to snippet', () => {
    const raw = { results: [{ title: 'T', url: 'https://x', content: 'c' }] };
    expect(searxng.normalize(raw)).toEqual([{ title: 'T', url: 'https://x', snippet: 'c' }]);
  });
  it('builds a GET request against the instance url with format=json', () => {
    const { url } = searxng.buildRequest('q', {}, { searxngUrl: 'https://searx.example/' });
    expect(url).toBe('https://searx.example/search?q=q&format=json');
  });
});

describe('firecrawl', () => {
  it('normalizes data.web[] with markdown content', () => {
    const raw = { success: true, data: { web: [{ title: 'T', url: 'https://x', description: 'd', markdown: '# md' }] } };
    expect(firecrawl.normalize(raw)).toEqual([{ title: 'T', url: 'https://x', snippet: 'd', content: '# md' }]);
  });
  it('handles a flat data array', () => {
    const raw = { data: [{ title: 'T', url: 'https://x', description: 'd' }] };
    expect(firecrawl.normalize(raw)).toEqual([{ title: 'T', url: 'https://x', snippet: 'd' }]);
  });
  it('returns [] when data missing', () => {
    expect(firecrawl.normalize({})).toEqual([]);
  });
});

describe('keenable', () => {
  it('builds a keyless POST to the public endpoint with the app title header', () => {
    const { url, init } = keenable.buildRequest('q', { count: 4 }, {});
    expect(keenable.auth).toBe('none');
    expect(url).toBe('https://api.keenable.ai/v1/search/public');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Keenable-Title']).toBe('OSW Studio');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('X-API-Key');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'q', max_results: 4, snippet_max_length: 1000 });
  });
  it('sends a saved key to the keyed endpoint without the public title header', () => {
    const { url, init } = keenable.buildRequest('q', {}, { key: 'kn-x' });
    expect(url).toBe('https://api.keenable.ai/v1/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('kn-x');
    expect(headers).not.toHaveProperty('X-Keenable-Title');
    expect(JSON.parse(init.body as string).max_results).toBe(5);
  });
  it('keeps max_results within the 1 to 50 the API accepts', () => {
    const max = (count: number) => JSON.parse(keenable.buildRequest('q', { count }, {}).init.body as string).max_results;
    expect(max(100)).toBe(50);
    expect(max(-3)).toBe(1);
  });
  it('normalizes snippet, clips it, and drops url-less rows', () => {
    const raw = {
      results: [
        { title: 'T', url: 'https://x', snippet: 's'.repeat(1500) },
        { title: '', url: 'https://y', description: '' },
        { title: 'no url' },
      ],
    };
    expect(keenable.normalize(raw)).toEqual([
      { title: 'T', url: 'https://x', snippet: 's'.repeat(1000) },
      { title: 'https://y', url: 'https://y', snippet: '' },
    ]);
  });
  it('returns [] when results missing', () => {
    expect(keenable.normalize({})).toEqual([]);
  });
});
