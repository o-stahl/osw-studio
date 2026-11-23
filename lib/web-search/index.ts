import type { RegisteredWebSearchProvider, WebSearchProviderId } from './types';
import { duckduckgo } from './providers/duckduckgo';
import { tavily } from './providers/tavily';
import { firecrawl } from './providers/firecrawl';
import { brave } from './providers/brave';
import { searxng } from './providers/searxng';
import { keenable } from './providers/keenable';

export const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, RegisteredWebSearchProvider> = {
  duckduckgo, tavily, firecrawl, brave, searxng, keenable,
};
export function getWebSearchProvider(id: WebSearchProviderId): RegisteredWebSearchProvider {
  return WEB_SEARCH_PROVIDERS[id];
}
export * from './types';
