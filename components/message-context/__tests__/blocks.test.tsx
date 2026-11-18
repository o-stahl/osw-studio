// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import fi from '@/messages/fi.json';
import { getBlockById } from '@/lib/semantic-blocks/registry';
import type { PlacedBlock, SentBlock } from '@/lib/semantic-blocks/types';
import { MessageContext } from '../index';

/**
 * The blocks section of the composer's context and of a sent message's: each block by its palette
 * name in the app's language, with where it went: the file its placeholder is in, or for a block
 * placed without source positions, its position in the preview's page.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(<NextIntlClientProvider locale="fi" messages={fi}>{node}</NextIntlClientProvider>);
  });
}

const hero = getBlockById('hero')!;

describe('the composer\'s blocks', () => {
  const placed: PlacedBlock[] = [
    { blockId: 'hero', placementId: 'hero-k3j9x2m1', page: '/index.html', file: '/templates/header.hbs' },
    { blockId: 'faq', placementId: 'sb-1-abc', page: '/', domPath: 'body > main', position: 'after', htmlContext: '<main></main>' },
  ];

  /** The section starts folded. */
  const unfold = () => act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());

  it('names each block in the app\'s language, with its placeholder\'s file or its position', () => {
    render(<MessageContext semanticBlocks={placed} onRemoveBlock={vi.fn()} />);
    unfold();
    const text = container.textContent ?? '';
    expect(fi.semanticBlocks.blocks.hero.name).not.toBe(hero.name);
    expect(text).toContain(fi.semanticBlocks.blocks.hero.name);
    expect(text).toContain('/templates/header.hbs');
    expect(text).toContain(fi.semanticBlocks.blocks.faq.name);
    expect(text).toContain('after body > main');
  });

  it('removes a block by its placement id', () => {
    const onRemoveBlock = vi.fn();
    render(<MessageContext semanticBlocks={placed} onRemoveBlock={onRemoveBlock} />);
    unfold();
    const remove = container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${fi.tooltips.removeBlock}"]`);
    expect(remove).toHaveLength(2);
    act(() => remove[0].click());
    expect(onRemoveBlock).toHaveBeenCalledWith('hero-k3j9x2m1');
  });
});

describe('a sent message\'s blocks', () => {
  const open = () => act(() => container.querySelector<HTMLButtonElement>('button')!.click());

  it('shows the block\'s name and description by its id in the app\'s language, with the file', () => {
    const sent: SentBlock[] = [{ blockId: 'hero', name: hero.name, description: hero.description, file: '/index.html' }];
    render(<MessageContext semanticBlocks={sent} readOnly />);
    open();
    expect(container.textContent).toContain(fi.semanticBlocks.blocks.hero.name);
    expect(container.textContent).toContain(fi.semanticBlocks.blocks.hero.description);
    expect(container.textContent).toContain('/index.html');
    expect(container.textContent).not.toContain(hero.name);
    expect(container.textContent).not.toContain(hero.description);
  });

  it('shows a placed block the palette no longer has by the name and description it was sent with', () => {
    // Recorded with the placeholder's placementId, as every block placed in source is.
    const sent: SentBlock[] = [{ blockId: 'retired-grid', placementId: 'retired-grid-k3j9x2m1', name: 'Retired Grid', description: 'A grid of three', file: '/index.html' }];
    render(<MessageContext semanticBlocks={sent} readOnly />);
    open();
    expect(container.textContent).toContain('Retired Grid');
    expect(container.textContent).toContain('A grid of three');
    expect(container.textContent).not.toContain('retired-grid');
  });

  it('shows a message from before block ids as it was recorded', () => {
    const sent: SentBlock[] = [{ name: 'Hero Section', description: 'A hero', domPath: 'body > main > section', position: 'after' }];
    render(<MessageContext semanticBlocks={sent} readOnly />);
    open();
    expect(container.textContent).toContain('Hero Section');
    expect(container.textContent).toContain('after main > section');
  });
});
