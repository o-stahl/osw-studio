// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

let container: HTMLElement;
let root: Root;
const NOW = Date.UTC(2026, 9, 3, 12, 0);

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

function render(fn: (f: ReturnType<typeof useLocalFormat>) => string): string {
  let out = '';
  function Probe() {
    out = fn(useLocalFormat());
    return null;
  }
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
        <Probe />
      </NextIntlClientProvider>
    );
  });
  return out;
}

describe('useLocalFormat, the edges', () => {
  it('gives the date from exactly a week ago, not "7 days ago"', () => {
    const weekAgo = NOW - 7 * 86400_000;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(render((f) => f.recent(weekAgo)))
      .toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: zone }).format(weekAgo));
  });

  it('renders nothing for an unreadable time in relativeTime and age', () => {
    expect(render((f) => f.relativeTime('not a date'))).toBe('');
    expect(render((f) => f.age('not a date'))).toBe('');
  });

  it('never gives a negative age for a time slightly in the future', () => {
    expect(render((f) => f.age(NOW + 5 * 60_000))).not.toMatch(/-/);
  });

  it('calls 1024 bytes a kilobyte', () => {
    expect(render((f) => f.bytes(1024))).toBe('1 kB');
  });
});
