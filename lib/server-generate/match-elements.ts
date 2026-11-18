import { load } from 'cheerio';
import type { ElementMatcher } from '@/lib/direct-edit/targets';

/**
 * Selector matching for the agent's `style` command on the server, which has no DOM. Cheerio parses
 * with parse5, as the HTML spec does, so implied elements (`tbody`) match as they do in the browser,
 * where `domMatcher` does the same job. Imported only by server code, so the browser never loads it.
 */
export const cheerioMatcher: ElementMatcher = (html, selector) => {
  const $ = load(html);
  return $(selector).toArray().map((el) => ({
    src: $(el).attr('data-osw-src') ?? null,
    tag: 'tagName' in el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '',
  }));
};
