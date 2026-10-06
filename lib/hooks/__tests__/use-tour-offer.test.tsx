// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

const custom = vi.fn();
const dismiss = vi.fn();
vi.mock('sonner', () => ({ toast: { custom: (...args: unknown[]) => custom(...args), dismiss: (id: unknown) => dismiss(id) } }));

import { useTourOffer } from '../use-tour-offer';
import { configManager } from '@/lib/config/storage';
import { DISCLOSED_KEY, markDisclosureSettled } from '@/lib/telemetry/disclosure-state';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  // The analytics disclosure has been answered unless a test says otherwise.
  localStorage.setItem(DISCLOSED_KEY, 'true');
  custom.mockClear();
  dismiss.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(startTour: () => void, enabled: boolean, createProject?: () => void) {
  function Probe() {
    useTourOffer(startTour, enabled, createProject);
    return null;
  }
  act(() => { root.render(withMessages(<Probe />)); });
  act(() => { vi.advanceTimersByTime(2000); });
}

describe('useTourOffer', () => {
  it('offers the tour once, and starts it when taken', () => {
    const startTour = vi.fn();
    mount(startTour, true);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(configManager.hasOfferedTour()).toBe(true);

    // Render the card the offer handed to the toaster, and take it.
    const card = (custom.mock.calls[0][0] as (id: string) => React.ReactElement)('offer-1');
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const cardRoot = createRoot(holder);
    act(() => { cardRoot.render(withMessages(card)); });
    expect(holder.textContent).toContain(en.nav.tourOffer.title);
    const take = [...holder.querySelectorAll('button')].find((b) => b.textContent === en.nav.tourOffer.start)!;
    act(() => { take.click(); });
    expect(startTour).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('offer-1');
    act(() => cardRoot.unmount());
    holder.remove();

    act(() => root.unmount());
    root = createRoot(container);
    mount(startTour, true);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('does not offer it to someone who took the tour before the offer existed', () => {
    localStorage.setItem('osw-studio-settings', JSON.stringify({ hasSeenGuidedTour: true }));
    mount(vi.fn(), true);
    expect(custom).not.toHaveBeenCalled();
  });

  it('does not offer it where it is disabled, such as the simple view', () => {
    mount(vi.fn(), false);
    expect(custom).not.toHaveBeenCalled();
    expect(configManager.hasOfferedTour()).toBe(false);
  });

  it('offers it once when both roots mount it in the same page', () => {
    function Probe() {
      useTourOffer(vi.fn(), true);
      return null;
    }
    const second = document.createElement('div');
    document.body.appendChild(second);
    const secondRoot = createRoot(second);
    act(() => { root.render(withMessages(<Probe />)); });
    act(() => { secondRoot.render(withMessages(<Probe />)); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(custom).toHaveBeenCalledTimes(1);
    act(() => secondRoot.unmount());
    second.remove();
  });

  it('offers nothing when the page is left before the offer is due', () => {
    function Probe() {
      useTourOffer(vi.fn(), true);
      return null;
    }
    act(() => { root.render(withMessages(<Probe />)); });
    act(() => root.unmount());
    root = createRoot(container);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(custom).not.toHaveBeenCalled();
    expect(configManager.hasOfferedTour()).toBe(false);
  });

  it('waits for the analytics disclosure to be answered before offering', () => {
    localStorage.removeItem(DISCLOSED_KEY);
    mount(vi.fn(), true);
    expect(custom).not.toHaveBeenCalled();
    expect(configManager.hasOfferedTour()).toBe(false);

    act(() => { markDisclosureSettled(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(custom).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('offers a way straight into a new project when one can be made', () => {
    const createProject = vi.fn();
    const startTour = vi.fn();
    mount(startTour, true, createProject);
    const card = (custom.mock.calls[0][0] as (id: string) => React.ReactElement)('offer-2');
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const cardRoot = createRoot(holder);
    act(() => { cardRoot.render(withMessages(card)); });
    expect(holder.textContent).toContain(en.nav.tourOffer.descriptionWithCreate);
    const create = [...holder.querySelectorAll('button')].find((b) => b.textContent === en.nav.tourOffer.create)!;
    act(() => { create.click(); });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(startTour).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledWith('offer-2');
    act(() => cardRoot.unmount());
    holder.remove();
  });

  it('offers no project button where none can be made', () => {
    mount(vi.fn(), true);
    const card = (custom.mock.calls[0][0] as (id: string) => React.ReactElement)('offer-3');
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const cardRoot = createRoot(holder);
    act(() => { cardRoot.render(withMessages(card)); });
    expect([...holder.querySelectorAll('button')].some((b) => b.textContent === en.nav.tourOffer.create)).toBe(false);
    expect(holder.textContent).toContain(en.nav.tourOffer.description);
    act(() => cardRoot.unmount());
    holder.remove();
  });
});
