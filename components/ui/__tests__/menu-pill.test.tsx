// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sparkles } from 'lucide-react';
import { MenuPill } from '../menu-pill';

/** The split-pill menu trigger: its label, the chevron pointing where the menu opens, and its ref. */

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

const chevron = () => container.querySelector('svg[class*="chevron"]')?.getAttribute('class') ?? '';

describe('MenuPill', () => {
  it('shows its label and points up by default', () => {
    act(() => root.render(<MenuPill icon={Sparkles} label="Models" />));
    expect(container.querySelector('button')?.textContent).toBe('Models');
    expect(chevron()).toMatch(/chevron-up/);
  });

  it('points down for a menu that opens below', () => {
    act(() => root.render(<MenuPill icon={Sparkles} aria-label="More" opens="down" />));
    expect(chevron()).toMatch(/chevron-down/);
  });

  it('hands its ref to the button, as a Radix asChild trigger needs', () => {
    const ref = React.createRef<HTMLButtonElement>();
    act(() => root.render(<MenuPill ref={ref} icon={Sparkles} aria-label="More" />));
    expect(ref.current).toBe(container.querySelector('button'));
  });
});
