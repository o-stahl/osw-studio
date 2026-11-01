import { describe, it, expect } from 'vitest';
import { generateSitemap } from '../seo-generator';

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

describe('generateSitemap', () => {
  it('lists pages by the clean address they are served at', () => {
    const xml = generateSitemap({
      baseUrl: 'https://example.com',
      htmlFiles: ['/index.html', '/mahjong.html', 'blog/post.html', '/docs/index.html'],
      publishSettings: {} as never,
    });
    expect(locs(xml)).toEqual([
      'https://example.com',
      'https://example.com/mahjong',
      'https://example.com/blog/post',
      'https://example.com/docs/',
    ]);
  });

  it('leaves out the 404 page', () => {
    const xml = generateSitemap({ baseUrl: 'https://example.com', htmlFiles: ['/index.html', '/404.html'], publishSettings: {} as never });
    expect(locs(xml)).toEqual(['https://example.com']);
  });
});
