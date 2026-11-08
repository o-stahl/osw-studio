// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import { MessageContext } from '../index';

/**
 * A section's Clear is a button of its own beside the section's toggle, so the keyboard reaches it
 * and pressing it clears without opening or closing the section.
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

describe('MessageContext section', () => {
  it('clears from a button beside the toggle, leaving the section as it was', () => {
    const onClearFocus = vi.fn();
    act(() => {
      root.render(withMessages(
        <MessageContext focusContext={{ domPath: 'body > main > h1', snippet: '<h1>Hi</h1>' }} onClearFocus={onClearFocus} />,
      ));
    });
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const clear = [...container.querySelectorAll('button')].find((b) => b.textContent === en.common.actions.clear)!;
    expect(clear).toBeDefined();
    expect(toggle.contains(clear)).toBe(false);

    act(() => { clear.click(); });
    expect(onClearFocus).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('body > main > h1');
  });
});
