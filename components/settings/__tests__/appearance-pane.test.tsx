// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The Interface setting: present from the first paint, and honest about a choice still saving.
 *
 * It used to hold the view in its own state, filled by a fetch, and render nothing until that
 * answered. Because the row sits above Theme, it did not merely appear late -- it pushed everything
 * below it down, a round trip after the pane was already on screen. The value was never worth
 * fetching: server mode looks it up during the page's own server render and hands it to
 * `ViewModeProvider`, and browser mode reads it off the device synchronously.
 *
 * So the first test is the fix, and it deliberately performs no awaits and stubs no fetch: a pane
 * that still asked the network could not pass it.
 */

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  refresh: vi.fn(),
  setLocale: vi.fn(),
  setTelemetryOptIn: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', setTheme: mocks.setTheme }) }));
vi.mock('@/lib/telemetry', () => ({ setTelemetryOptIn: mocks.setTelemetryOptIn, track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: mocks.setLocale }));
vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getSettings: () => ({ telemetryOptIn: true }),
    setSetting: vi.fn(),
  },
}));

import { AppearancePane } from '@/components/settings/appearance-pane';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { ViewModeProvider } from '@/components/view-mode-provider';
import { readLocalStudioView } from '@/lib/view-mode-event';

let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode) {
  act(() => { root.render(withMessages(node)); });
}

/** The Interface row's two buttons, by their labels. */
function interfaceButtons() {
  return Array.from(container.querySelectorAll('button'))
    .filter((b) => b.textContent === 'Studio' || b.textContent === 'Simple');
}

function press(label: 'Studio' | 'Simple') {
  const button = interfaceButtons().find((b) => b.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** Which choice the control shows as chosen. Radix marks it on the pressed item. */
function chosen(): string | null {
  const on = interfaceButtons().find((b) => b.getAttribute('data-state') === 'on');
  return on?.textContent ?? null;
}

/** The order of the setting titles, which is what a late-arriving row disturbs. */
function rowTitles(): string[] {
  return Array.from(container.querySelectorAll('*'))
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent ?? '')
    .filter((t) => ['Interface', 'Theme', 'Language', 'Anonymous usage analytics'].includes(t));
}

/** The Language row's buttons, each named in its own language. */
function languageButtons() {
  return Array.from(container.querySelectorAll('button'))
    .filter((b) => ['English', '한국어', 'Suomi'].includes(b.textContent ?? ''));
}

function pickLanguage(name: string) {
  const button = languageButtons().find((b) => b.textContent === name);
  if (!button) throw new Error(`no ${name} button`);
  return act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  vi.clearAllMocks();
  mocks.setLocale.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the pane as it first paints', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true'); });

  it('shows the Interface row straight away, with no request made', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    expect(interfaceButtons()).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts the rows in their final order from the start', () => {
    // The row's absence was not a missing control but a moving layout: it sits above Theme, so it
    // arrived and shoved Theme and Analytics down.
    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    expect(rowTitles()).toEqual(['Interface', 'Theme', 'Language', 'Anonymous usage analytics']);
  });

  it('shows the view the server looked up', () => {
    mount(<ViewModeProvider initialStudioView={false}><AppearancePane /></ViewModeProvider>);

    expect(chosen()).toBe('Simple');
  });
});

describe('browser mode, where the choice is the device', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false'); });

  it('shows what this device chose before', () => {
    localStorage.setItem('osw-studio-view', 'simple');

    mount(<ViewModeProvider initialStudioView={null}><AppearancePane /></ViewModeProvider>);

    expect(chosen()).toBe('Simple');
  });

  it('records the choice on the device and shows it, without a request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(<ViewModeProvider initialStudioView={null}><AppearancePane /></ViewModeProvider>);

    press('Simple');

    expect(readLocalStudioView()).toBe(false);
    expect(chosen()).toBe('Simple');
    // There is no account to write to here; a PATCH would 404 and toast on every press.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changes back', () => {
    localStorage.setItem('osw-studio-view', 'simple');
    mount(<ViewModeProvider initialStudioView={null}><AppearancePane /></ViewModeProvider>);

    press('Studio');

    expect(readLocalStudioView()).toBe(true);
    expect(chosen()).toBe('Studio');
  });
});

describe('server mode, where the choice is the account', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true'); });

  it('writes the account and shows the pressed choice while it saves', async () => {
    // The save is two round trips: the PATCH, then the re-read the announcement triggers. Held
    // here at the first, which is the window the pressed choice has to cover -- without it the
    // control sits on the old answer after a press that worked.
    let settle: (v: unknown) => void = () => {};
    const patch = new Promise((resolve) => { settle = resolve; });
    const fetchMock = vi.fn().mockReturnValue(patch);
    vi.stubGlobal('fetch', fetchMock);

    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);
    press('Simple');

    expect(chosen()).toBe('Simple');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ studioView: false }),
    }));

    await act(async () => {
      settle({ ok: true, json: async () => ({ user: { studioView: false } }) });
      await patch;
    });

    expect(chosen()).toBe('Simple');
  });

  it('goes back to the saved view when the account refuses the change', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    await act(async () => { press('Simple'); });

    // Leaving the control on the choice that failed would read as saved.
    expect(chosen()).toBe('Studio');
    expect(mocks.toastError).toHaveBeenCalled();
  });
});

describe('the Language row', () => {
  it('saves the picked language, then refreshes so the server render comes back in it', async () => {
    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    await pickLanguage('Suomi');

    expect(mocks.setLocale).toHaveBeenCalledTimes(1);
    expect(mocks.setLocale).toHaveBeenCalledWith('fi', { embedded: false });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    // The cookie has to be written before the refresh asks the server for the new render.
    expect(mocks.setLocale.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0]);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('says so and releases the control when the language cannot be saved', async () => {
    mocks.setLocale.mockRejectedValue(new Error('cookie refused'));
    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    await pickLanguage('Suomi');

    expect(mocks.toastError).toHaveBeenCalledWith('Could not change the language');
    expect(mocks.refresh).not.toHaveBeenCalled();
    // Back on the language actually in use, and pickable again rather than stuck pending.
    expect(languageButtons().find((b) => b.getAttribute('data-state') === 'on')?.textContent).toBe('English');
    expect(languageButtons().every((b) => !b.disabled)).toBe(true);
  });

  it('leaves the language alone when the one in use is pressed again', async () => {
    // A single toggle group reports a press on its pressed item as '' (deselect). Passed on, that
    // is a server call and a refresh for nothing.
    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    await pickLanguage('English');

    expect(mocks.setLocale).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('holds the row while a switch is saving', async () => {
    mocks.setLocale.mockReturnValue(new Promise(() => {}));
    mount(<ViewModeProvider initialStudioView={true}><AppearancePane /></ViewModeProvider>);

    await pickLanguage('Suomi');

    expect(languageButtons().every((b) => b.disabled)).toBe(true);
  });
});
