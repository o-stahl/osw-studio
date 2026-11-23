export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string; // page content, present only when the provider returns it
}
export interface WebSearchOpts { count?: number; markdown?: boolean; }
export interface WebSearchAuth { key?: string; searxngUrl?: string; }
export type WebSearchProviderId = 'duckduckgo' | 'tavily' | 'firecrawl' | 'brave' | 'searxng' | 'keenable';
/** Providers that take an API key: required for Tavily, Firecrawl and Brave, optional for Keenable. */
export type WebSearchKeyProviderId = 'tavily' | 'firecrawl' | 'brave' | 'keenable';
interface WebSearchProviderBase {
  id: WebSearchProviderId;
  name: string;
  auth: 'none' | 'key' | 'url';
  nativeContent: boolean; // true if search results already include page content
}
export interface WebSearchProvider extends WebSearchProviderBase {
  buildRequest(query: string, opts: WebSearchOpts, auth: WebSearchAuth): { url: string; init: RequestInit };
  normalize(raw: any): WebSearchResult[];
}
export interface WebSearchDirectProvider extends WebSearchProviderBase {
  search(query: string, opts: WebSearchOpts, signal: AbortSignal): Promise<WebSearchResult[]>;
}
export type RegisteredWebSearchProvider = WebSearchProvider | WebSearchDirectProvider;
