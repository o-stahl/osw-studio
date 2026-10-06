// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';

const mocks = vi.hoisted(() => ({ setLocale: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: mocks.setLocale }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { useLocaleSwitch } from '@/lib/i18n/use-locale-switch';

let container: HTMLElement;
let root: Root;
let state: ReturnType<typeof useLocaleSwitch>;

function Probe() {
  state = useLocaleSwitch();
  return null;
}

function mount(locale: 'en' | 'fi') {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'fi' ? fi : en}>
        <Probe />
      </NextIntlClientProvider>
    );
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.setLocale.mockReset();
  mocks.refresh.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useLocaleSwitch', () => {
  it('shows the picked language as current and pending while it is saved, and settles once it arrives', async () => {
    let finish: () => void = () => {};
    mocks.setLocale.mockReturnValue(new Promise<void>((r) => { finish = r; }));
    mount('en');
    expect(state).toMatchObject({ current: 'en', pending: false });

    let change: Promise<void> = Promise.resolve();
    act(() => { change = state.change('fi'); });
    expect(state).toMatchObject({ current: 'fi', pending: true });

    await act(async () => { finish(); await change; });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    // Still pending until the refreshed render brings the new locale.
    expect(state.pending).toBe(true);

    mount('fi');
    expect(state).toMatchObject({ current: 'fi', pending: false });
  });
});
