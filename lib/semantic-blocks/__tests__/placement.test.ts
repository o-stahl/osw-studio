import { describe, it, expect, vi } from 'vitest';
import type { VirtualFileSystem } from '@/lib/vfs';
import { insertElement, scanElements } from '@/lib/direct-edit/structure';
import { SEMANTIC_BLOCKS, getBlockById } from '../registry';
import type { PlacedBlock } from '../types';
import {
  isPlace,
  placedBlocksPrompt,
  placeholderAt,
  resolvePlacedBlocks,
  sentBlocks,
  truncateAroundMarker,
} from '../placement';
import { BLOCK_ATTR, PLACEHOLDER_CSS, isPlacementId, newPlacementId, placeholderMarkup, withoutPlaceholders } from '../placeholder';

const PAGE = '<main>\n  <h1>Hi</h1>\n  <p>Lead</p>\n</main>\n';
const hero = getBlockById('hero')!;

/** `PAGE` with the hero's placeholder after the heading, as the drop writes it. */
function withPlaceholder(id: string, page = PAGE): string {
  const edit = insertElement(page, { after: page.indexOf('<h1') }, placeholderMarkup(hero, id));
  if (!edit.ok) throw new Error(edit.reason);
  return edit.edit.content;
}

/** A VFS that has `files` and counts its reads. */
function fsWith(files: Record<string, string>) {
  const readFile = vi.fn(async (_projectId: string, path: string) => {
    if (!(path in files)) throw new Error(`no ${path}`);
    return { content: files[path] };
  });
  return { fs: { readFile } as unknown as VirtualFileSystem, readFile };
}

describe('a published page', () => {
  // A placeholder's look is added by the preview only, so on a published page it would be a bare
  // box with the block's name: the page goes out without it and the project keeps it.
  it('goes out without a placeholder nobody has built, and without the line it stood on', () => {
    expect(withoutPlaceholders(withPlaceholder('hero-k3j9x2m1'))).toBe(PAGE);
  });

  it('loses a styled placeholder too, and every placeholder on the page', () => {
    const page = '<main>\n  <div data-osw-id="aaaa1111" data-osw-block="hero-k3j9x2m1">Hero Section</div>\n  <p>Lead</p>\n  <div data-osw-block="pricing-q1w2e3r4">Pricing</div>\n</main>\n';
    expect(withoutPlaceholders(page)).toBe('<main>\n  <p>Lead</p>\n</main>\n');
  });

  it('keeps what shares a line with the placeholder', () => {
    expect(withoutPlaceholders('<p>a</p><div data-osw-block="hero-k3j9x2m1">Hero Section</div><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  it('keeps a block built in place that still carries the attribute, taking only the attribute off', () => {
    const built = '<main><section class="hero" data-osw-block="hero-k3j9x2m1"><h1>Welcome</h1><p>Real content</p></section><p>After</p></main>';
    expect(withoutPlaceholders(built)).toBe('<main><section class="hero"><h1>Welcome</h1><p>Real content</p></section><p>After</p></main>');
    expect(withoutPlaceholders('<h2 data-osw-block="hero-k3j9x2m1" class="t">Welcome</h2>')).toBe('<h2 class="t">Welcome</h2>');
    expect(withoutPlaceholders('<div data-osw-block="Hero Section">Hero</div>')).toBe('<div>Hero</div>');
    // A placeholder is a <div>: a built element of another tag that still says the block's name stays.
    expect(withoutPlaceholders('<main>\n  <button data-osw-block="button-k3j9x2m1" class="btn">Button</button>\n</main>\n'))
      .toBe('<main>\n  <button class="btn">Button</button>\n</main>\n');
  });

  it('keeps a text block built in place that kept the attribute, taking only the attribute off', () => {
    const built = '<main>\n  <h1>Hi</h1>\n  <div data-osw-block="text-block-k3j9x2m1" class="prose">We bake bread every morning from 5 a.m.</div>\n  <p>end</p>\n</main>';
    expect(withoutPlaceholders(built))
      .toBe('<main>\n  <h1>Hi</h1>\n  <div class="prose">We bake bread every morning from 5 a.m.</div>\n  <p>end</p>\n</main>');
    // A block nobody can name any more: what it says cannot be told from a placeholder's name.
    expect(withoutPlaceholders('<div data-osw-block="retired-k3j9x2m1">Retired</div>')).toBe('<div>Retired</div>');
  });

  it('still takes out a placeholder whose name was only re-indented', () => {
    expect(withoutPlaceholders('<main>\n  <div data-osw-block="text-block-k3j9x2m1">\n    Text Block\n  </div>\n</main>\n'))
      .toBe('<main>\n</main>\n');
    expect(withoutPlaceholders('<main>\n  <div data-osw-block="header-nav-k3j9x2m1">Header /\n    Nav</div>\n</main>\n'))
      .toBe('<main>\n</main>\n');
  });

  it('takes nothing after a placeholder that is never closed', () => {
    expect(withoutPlaceholders('<main><div data-osw-block="hero-k3j9x2m1">Hero<p>After</p></main>'))
      .toBe('<main><div>Hero<p>After</p></main>');
    expect(withoutPlaceholders('<main>\n  <div data-osw-block="hero-k3j9x2m1">Hero\n  <p>After</p>\n</main>\n'))
      .toBe('<main>\n  <div>Hero\n  <p>After</p>\n</main>\n');
  });

  it('takes out many placeholders in one pass', () => {
    const many = `<main>\n${'  <div data-osw-block="hero-k3j9x2m1">Hero Section</div>\n'.repeat(32_000)}</main>\n`;
    const started = performance.now();
    expect(withoutPlaceholders(many)).toBe('<main>\n</main>\n');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('is left as it is when it has none, and when the attribute is only mentioned in text', () => {
    expect(withoutPlaceholders(PAGE)).toBe(PAGE);
    const mention = '<p>Uses data-osw-block for placeholders.</p>';
    expect(withoutPlaceholders(mention)).toBe(mention);
  });
});

describe('the placeholder', () => {
  it('is one element, the placement id in its attribute and the block\'s name as its text, with no look of its own', () => {
    const markup = placeholderMarkup(getBlockById('header-nav')!, 'header-nav-k3j9x2m1');
    expect(scanElements(markup)).toHaveLength(1);
    // An inline style would outrank the element's overrides, so styling the placeholder would not show.
    expect(markup).toBe('<div data-osw-block="header-nav-k3j9x2m1">Header / Nav</div>');
  });

  it('gets its look from the preview\'s stylesheet, one attribute selector deep, sized by its block', () => {
    expect(PLACEHOLDER_CSS).toContain('[data-osw-block]{display:flex;');
    expect(PLACEHOLDER_CSS).toContain('border:2px dashed');
    // Every block has a size rule, under a selector no other block's placement ids match.
    for (const { id } of SEMANTIC_BLOCKS) {
      expect(PLACEHOLDER_CSS).toContain(`[data-osw-block^="${id}-"]`);
    }
    expect(PLACEHOLDER_CSS).toMatch(/\[data-osw-block\^="button-"\][^{]*\{display:inline-flex;/);
    // Nothing deeper than one attribute: two (the override's) always win.
    expect(PLACEHOLDER_CSS).not.toMatch(/\]\[/);
  });

  it('escapes the name it carries', () => {
    expect(placeholderMarkup({ ...hero, name: 'Q&A <beta>' }, 'hero-a1')).toContain('>Q&amp;A &lt;beta&gt;</div>');
  });

  it('is found by its id, not by a longer id or the id written into another attribute', () => {
    const id = 'hero-k3j9x2m1';
    const content = withPlaceholder(id);
    expect(content.slice(placeholderAt(content, id)!, placeholderAt(content, id)! + 5)).toBe('<div ');
    expect(placeholderAt(content, 'hero-k3j9x2m')).toBeNull();
    const decoy = PAGE.replace('<p>', `<p title="${BLOCK_ATTR}=&quot;${id}&quot;" data-note="${id}">`);
    expect(placeholderAt(decoy, id)).toBeNull();
    expect(placeholderAt(PAGE, id)).toBeNull();
  });
});

describe('isPlace', () => {
  it('takes the three places a frame reports and nothing else', () => {
    for (const place of [{ before: '/index.html:4' }, { after: '/index.html:4' }, { parent: '/index.html:4', at: 'end' }]) {
      expect(isPlace(place), JSON.stringify(place)).toBe(true);
    }
    for (const hostile of [null, 'x', 4, {}, { before: 4 }, { parent: '/index.html:4' }, { parent: '/index.html:4', at: 'middle' }]) {
      expect(isPlace(hostile), JSON.stringify(hostile)).toBe(false);
    }
  });
});

describe('placement ids', () => {
  it('are the block\'s id and a random tail, and nothing that could end the attribute passes', () => {
    const id = newPlacementId('cta-banner');
    expect(id).toMatch(/^cta-banner-[a-z0-9]{8}$/);
    expect(isPlacementId(id)).toBe(true);
    for (const hostile of ['hero-1"', "hero-1'", 'hero 1', 'hero-1>', '', '-hero', 'hero-', 'Hero-1']) {
      expect(isPlacementId(hostile), hostile).toBe(false);
    }
  });
});

describe('resolvePlacedBlocks', () => {
  const source = (placementId: string, file = '/index.html'): PlacedBlock => ({ blockId: 'hero', placementId, page: '/index.html', file });

  it('gives each placeholder its position and markup, reads a file once, and leaves out the ones that are gone', async () => {
    const page = withPlaceholder('hero-bbbbbbbb', withPlaceholder('hero-aaaaaaaa'));
    const { fs, readFile } = fsWith({ '/index.html': page });
    const resolved = await resolvePlacedBlocks('p1', [source('hero-aaaaaaaa'), source('hero-gone0000'), source('hero-bbbbbbbb')], fs);
    expect(resolved.map(b => ('file' in b ? [b.placementId, b.ref, b.markup] : null))).toEqual([
      ['hero-aaaaaaaa', '/index.html:4:3', '<div data-osw-block="hero-aaaaaaaa">Hero Section</div>'],
      ['hero-bbbbbbbb', '/index.html:3:3', '<div data-osw-block="hero-bbbbbbbb">Hero Section</div>'],
    ]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('reads the marker a styled placeholder was given', async () => {
    const styled = withPlaceholder('hero-aaaaaaaa').replace('<div data-osw-block', '<div data-osw-id="m7x2" data-osw-block');
    const { fs } = fsWith({ '/index.html': styled });
    const [one] = await resolvePlacedBlocks('p1', [source('hero-aaaaaaaa')], fs);
    expect(one).toMatchObject({ placementId: 'hero-aaaaaaaa', marker: 'm7x2' });
    const { fs: plain } = fsWith({ '/index.html': withPlaceholder('hero-aaaaaaaa') });
    expect((await resolvePlacedBlocks('p1', [source('hero-aaaaaaaa')], plain))[0]).toMatchObject({ marker: null });
  });

  it('leaves out a placeholder whose file is gone, and a block the registry no longer has', async () => {
    const { fs } = fsWith({ '/index.html': withPlaceholder('hero-aaaaaaaa') });
    expect(await resolvePlacedBlocks('p1', [source('hero-aaaaaaaa', '/gone.html'), { ...source('hero-aaaaaaaa'), blockId: 'retired' }], fs)).toEqual([]);
  });

  it('passes a block shown only in the frame through as it was placed', async () => {
    const { fs, readFile } = fsWith({});
    const frame: PlacedBlock = { blockId: 'faq', placementId: 'sb-1-a', page: '/', domPath: 'body > main', position: 'after', htmlContext: '<main></main>' };
    const [only] = await resolvePlacedBlocks('p1', [frame], fs);
    expect(only).toEqual({ block: getBlockById('faq'), page: '/', domPath: 'body > main', position: 'after', htmlContext: '<main></main>' });
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('placedBlocksPrompt', () => {
  const markup = '<div data-osw-block="hero-k3j9x2m1">Hero Section</div>';
  const sourceBlock = { block: hero, page: '/index.html', placementId: 'hero-k3j9x2m1', file: '/templates/header.hbs', offset: 10, ref: '/templates/header.hbs:7:3', markup, marker: null };
  const frameBlock = { block: getBlockById('faq')!, page: '/', domPath: 'body > main', position: 'after' as const, htmlContext: '<main><!-- INSERT FAQ HERE --></main>' };

  it('says what the user did and gives the steps: replace the placeholder, CSS in the stylesheet', () => {
    const prompt = placedBlocksPrompt([sourceBlock]);
    expect(prompt.startsWith('Blocks to build:\nThe user dragged the blocks below onto the page')).toBe(true);
    expect(prompt).toMatch(/1\. .*Replace the whole placeholder element with the block's real HTML/);
    expect(prompt).toMatch(/2\. Put the block's CSS in the project's stylesheet/);
    expect(prompt).toContain('[1] Hero Section (page: /index.html)');
    expect(prompt).toContain(`What it is: ${hero.description}`);
    expect(prompt).not.toContain('INSERT');
  });

  it('gives each placeholder as the file spells it, with its position, so it can be replaced without a search', () => {
    const prompt = placedBlocksPrompt([sourceBlock]);
    expect(prompt).toContain(`    Placeholder, at /templates/header.hbs:7:3:\n    ${markup}\n`);
  });

  it('names the marker of a styled placeholder, which the block keeps', () => {
    const styled = '<div data-osw-id="m7x2" data-osw-block="hero-k3j9x2m1">Hero Section</div>';
    const prompt = placedBlocksPrompt([{ ...sourceBlock, markup: styled, marker: 'm7x2' }]);
    expect(prompt).toContain('at /templates/header.hbs:7:3 (styled by the user: keep data-osw-id="m7x2" on the block):');
    expect(prompt).toContain(styled);
    expect(prompt).toMatch(/3\. If a placeholder has a data-osw-id attribute, the user styled it/);
  });

  it('marks a frame block\'s spot in the page around it, and says the comment is not in the file', () => {
    const frameOnly = placedBlocksPrompt([frameBlock]);
    expect(frameOnly).toContain('<!-- INSERT FAQ HERE -->');
    expect(frameOnly).toContain('The comment is not in the file');
    expect(frameOnly).not.toContain(BLOCK_ATTR);
    const both = placedBlocksPrompt([sourceBlock, frameBlock]);
    expect(both).toContain('[2] FAQ (page: /)');
    expect(both).toMatch(/Replace the whole placeholder element/);
    expect(both).toContain('The comment is not in the file');
  });

  it('is empty with no blocks', () => {
    expect(placedBlocksPrompt([])).toBe('');
  });
});

describe('sentBlocks', () => {
  // The placement id is what the write guard reads, to know a placeholder's going was asked for.
  it('records the block\'s id and English copy, with the file and placeholder or the frame position', () => {
    const faq = getBlockById('faq')!;
    expect(sentBlocks([
      { block: hero, page: '/index.html', placementId: 'hero-k3j9x2m1', file: '/index.html', offset: 3, ref: '/index.html:2:3', markup: '<div></div>', marker: null },
      { block: faq, page: '/', domPath: 'body > main', position: 'before', htmlContext: '<main></main>' },
    ])).toEqual([
      { blockId: 'hero', name: hero.name, description: hero.description, file: '/index.html', placementId: 'hero-k3j9x2m1' },
      { blockId: 'faq', name: faq.name, description: faq.description, domPath: 'body > main', position: 'before' },
    ]);
  });
});

describe('truncateAroundMarker', () => {
  it('keeps the marker in view with context on both sides', () => {
    const marker = '<!-- INSERT Hero Section HERE -->';
    const html = `${'a'.repeat(3000)}${marker}${'b'.repeat(3000)}`;
    const cut = truncateAroundMarker(html, marker, 400);
    expect(cut).toContain(`${'a'.repeat(150)}${marker}${'b'.repeat(150)}`);
    expect(cut.startsWith('(...truncated...)\n')).toBe(true);
    expect(cut.endsWith('\n(...truncated...)')).toBe(true);
    expect(cut.length).toBeLessThan(500);
  });

  it('falls back to head and tail when the marker is not in it', () => {
    const cut = truncateAroundMarker(`${'a'.repeat(1000)}${'b'.repeat(1000)}`, '<!-- x -->', 100);
    expect(cut).toBe(`${'a'.repeat(60)}\n  (...truncated...)\n${'b'.repeat(30)}`);
  });
});
