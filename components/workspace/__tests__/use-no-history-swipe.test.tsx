// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NO_HISTORY_SWIPE_CLASS, useNoHistorySwipe } from '../use-no-history-swipe';

/**
 * The workspace turns trackpad swipes between pages off through a class on `<html>`; the CSS that
 * gives the class its effect lives in `assets/globals.css`. jsdom loads no stylesheet, so the rule
 * is read as text: the class and the rule are two halves of one mechanism.
 */

let container: HTMLElement;
let root: Root;

function Probe() {
  useNoHistorySwipe();
  return null;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.classList.remove(NO_HISTORY_SWIPE_CLASS);
});

describe('useNoHistorySwipe', () => {
  it('marks the root element while mounted and clears it on unmount', () => {
    expect(document.documentElement.classList.contains(NO_HISTORY_SWIPE_CLASS)).toBe(false);
    act(() => root.render(<Probe />));
    expect(document.documentElement.classList.contains(NO_HISTORY_SWIPE_CLASS)).toBe(true);
    act(() => root.render(<div />));
    // Leaving the workspace gives the swipe back to the projects list and the rest of the app.
    expect(document.documentElement.classList.contains(NO_HISTORY_SWIPE_CLASS)).toBe(false);
  });

  it('has a rule in globals.css that stops horizontal overscroll on html and body', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = css.match(new RegExp(`([^{}]*\\.${NO_HISTORY_SWIPE_CLASS}[^{}]*)\\{([^}]*)\\}`));
    expect(rule?.[1].split(',').map((s) => s.trim()).sort()).toEqual([`html.${NO_HISTORY_SWIPE_CLASS}`, `html.${NO_HISTORY_SWIPE_CLASS} body`]);
    expect(rule?.[2].trim()).toBe('overscroll-behavior-x: none;');
  });
});
