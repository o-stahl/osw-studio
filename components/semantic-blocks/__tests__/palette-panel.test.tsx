// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import fi from '@/messages/fi.json';
import { PalettePanel } from '../palette-panel';
import { getBlockById } from '@/lib/semantic-blocks/registry';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PalettePanel', () => {
  it('drags the English registry entry while the card shows translated copy', () => {
    const onDragStart = vi.fn();
    // Finnish, so the card's name differs from the registry's and a translated drag would show.
    act(() => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={fi}>
          <PalettePanel onDragStart={onDragStart} onClose={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });

    const hero = getBlockById('hero')!;
    const shownName = fi.semanticBlocks.blocks.hero.name;
    expect(shownName).not.toBe(hero.name);

    const card = Array.from(container.querySelectorAll<HTMLElement>('[draggable="true"]'))
      .find(el => el.textContent?.includes(shownName));
    expect(card, 'no hero card').toBeTruthy();

    const event = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown };
    event.dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    act(() => { card!.dispatchEvent(event); });

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0][0]).toBe(hero);
  });

  function mountFinnish() {
    act(() => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={fi}>
          <PalettePanel onDragStart={vi.fn()} onClose={vi.fn()} />
        </NextIntlClientProvider>,
      );
    });
  }
  const cards = () => Array.from(container.querySelectorAll<HTMLElement>('[draggable="true"]')).map(el => el.textContent ?? '');

  it('searches the names the person sees', () => {
    mountFinnish();
    const input = container.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'hinnoit');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(cards().length).toBeGreaterThan(0);
    expect(cards().every(text => text.includes(fi.semanticBlocks.blocks.pricing.name) || text.toLowerCase().includes('hinnoit'))).toBe(true);
    expect(cards().some(text => text.includes(fi.semanticBlocks.blocks.hero.name))).toBe(false);
  });

  it('heads each group with its translated category', () => {
    mountFinnish();
    for (const label of Object.values(fi.semanticBlocks.categories)) {
      expect(container.textContent).toContain(label);
    }
  });
});
