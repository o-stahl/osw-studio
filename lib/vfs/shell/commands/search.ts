import type { ShellEnv, ShellResult } from '../types';
import { truncate } from '../runtime';

/** `search` — web search via the configured provider. */
export async function searchCommand(env: ShellEnv): Promise<ShellResult> {
  const { args } = env;

  if (typeof window === 'undefined') {
    // Server-side generation: delegate to the connected browser, which runs this same command
    // with the user's configured provider/key. Falls through to the browser path there.
    if (env.ctx?.onSearchRequested) {
      return env.ctx.onSearchRequested(args);
    }
    return { stdout: '', stderr: 'search: requires the browser runtime.', exitCode: 1 };
  }
  const { configManager } = await import('@/lib/config/storage');
  const provider = configManager.getWebSearchProvider();
  if (!provider) {
    return { stdout: '', stderr: 'search: no web search provider configured. Add one under Connections (Settings).', exitCode: 1 };
  }

  let count = 5;
  let markdown = false;
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-n' || a === '--count') && args[i + 1]) { count = parseInt(args[++i], 10) || 5; continue; }
    if (a === '--markdown') { markdown = true; continue; }
    if (a) queryParts.push(a);
  }
  const query = queryParts.join(' ').trim();
  if (!query) {
    return { stdout: '', stderr: 'Usage: search [-n N] [--markdown] "query"', exitCode: 1 };
  }

  const auth = provider === 'searxng'
    ? { searxngUrl: configManager.getSearxngUrl() || undefined }
    : provider === 'duckduckgo'
      ? {}
      : { key: configManager.getWebSearchKey(provider) || undefined };

  try {
    const resp = await fetch('/api/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, query, count, markdown, auth }),
    });
    const data = await resp.json();
    if (data.error) return { stdout: '', stderr: `search: ${data.error}`, exitCode: 1 };
    const results: Array<{ title: string; url: string; snippet: string; content?: string }> = data.results || [];
    if (results.length === 0) return { stdout: 'No results.', stderr: '', exitCode: 0 };

    // Non-native providers with --markdown: fetch + extract the top results client-side.
    // Covered by the original search approval; no re-prompt (the gate keys on `search`).
    const { WEB_SEARCH_PROVIDERS } = await import('@/lib/web-search');
    const nativeContent = WEB_SEARCH_PROVIDERS[provider].nativeContent;
    if (markdown && !nativeContent) {
      const top = results.slice(0, Math.min(3, results.length));
      await Promise.all(top.map(async (r) => {
        try {
          const fr = await fetch('/api/web/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: r.url }),
          });
          const fd = await fr.json();
          if (!fd.error && fd.encoding !== 'base64' && fd.body) {
            const { htmlToMarkdown } = await import('@/lib/web/extract');
            r.content = htmlToMarkdown(fd.body, r.url);
          }
        } catch { /* leave snippet only */ }
      }));
    }

    const lines: string[] = [];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      if (markdown && r.content) {
        lines.push('');
        lines.push(r.content.slice(0, 2000));
      }
      lines.push('');
    });
    return { stdout: truncate(lines.join('\n').trim()), stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: '', stderr: `search: request failed: ${e?.message || 'network error'}`, exitCode: 1 };
  }
}
