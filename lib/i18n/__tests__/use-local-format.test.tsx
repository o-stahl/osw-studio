// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import ko from '@/messages/ko.json';
import { useLocalFormat } from '@/lib/i18n/use-local-format';

let container: HTMLElement;
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

const MESSAGES = { en, fi, ko };

/** Renders with no global time zone, as the app does, and returns what the hook produced. */
function render(
  fn: (f: ReturnType<typeof useLocalFormat>) => string,
  onError: (e: Error) => void,
  locale: keyof typeof MESSAGES = 'fi',
) {
  let out = '';
  function Probe() {
    out = fn(useLocalFormat());
    return null;
  }
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} onError={onError}>
        <Probe />
      </NextIntlClientProvider>
    );
  });
  return out;
}

describe('useLocalFormat', () => {
  it('formats a date without reporting a missing time zone', () => {
    const onError = vi.fn();
    const when = Date.UTC(2026, 9, 3, 14, 5);
    const out = render((f) => f.dateTime(when, { dateStyle: 'short', timeStyle: 'short' }), onError);

    // The useFormatter path reports ENVIRONMENT_FALLBACK here when no zone is passed.
    expect(onError).not.toHaveBeenCalled();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(out).toBe(new Intl.DateTimeFormat('fi', { dateStyle: 'short', timeStyle: 'short', timeZone: zone }).format(when));
  });

  it('formats numbers in the app locale, not the environment default', () => {
    const out = render((f) => f.number(1234567.5), vi.fn());
    expect(out).toBe(new Intl.NumberFormat('fi').format(1234567.5));
  });

  it('gives sizes in binary steps, spelling out plain bytes', () => {
    const onError = vi.fn();
    expect(render((f) => f.bytes(512), onError, 'en')).toBe('512 bytes');
    expect(render((f) => f.bytes(2048), onError, 'en')).toBe('2 kB');
    expect(render((f) => f.bytes(1.5 * 1024 ** 3, 1), onError, 'en')).toBe('1.5 GB');
    expect(render((f) => f.bytes(5 * 1024 ** 2), onError, 'fi')).toBe('5 Mt');
  });

  describe('relative time and age', () => {
    const NOW = Date.UTC(2026, 9, 3, 12, 0);
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    it.each([
      ['en', '3 days ago', 'yesterday', '17 days'],
      ['fi', '3 päivää sitten', 'eilen', '17 päivää'],
      ['ko', '3일 전', '어제', '17일'],
    ] as const)('speaks %s', (locale, threeDays, oneDay, age) => {
      const onError = vi.fn();
      expect(render((f) => f.relativeTime(NOW - 3 * 86400000), onError, locale)).toBe(threeDays);
      expect(render((f) => f.relativeTime(NOW - 86400000), onError, locale)).toBe(oneDay);
      expect(render((f) => f.age(NOW - 17 * 86400000), onError, locale)).toBe(age);
      expect(onError).not.toHaveBeenCalled();
    });

    it('stays relative within a week, then gives the date', () => {
      const onError = vi.fn();
      expect(render((f) => f.recent(NOW - 3 * 60000), onError, 'fi')).toBe('3 min sitten');
      expect(render((f) => f.recent(NOW - 86400000), onError, 'ko')).toBe('어제');
      const old = NOW - 23 * 86400000;
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(render((f) => f.recent(old), onError, 'fi'))
        .toBe(new Intl.DateTimeFormat('fi', { dateStyle: 'medium', timeZone: zone }).format(old));
      expect(onError).not.toHaveBeenCalled();
    });

    it('renders nothing for a timestamp it cannot read', () => {
      expect(render((f) => f.recent('not a date'), vi.fn())).toBe('');
    });
  });
});
