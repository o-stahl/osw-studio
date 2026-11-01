// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { solveTurnstile } from '../turnstile';

/**
 * Cloudflare's check: its script loads on first use, the widget renders in a panel that is up only
 * while the check runs, and the token the widget gives is the answer. The panel goes however the
 * check ends: solved, failed, timed out or called off.
 */
afterEach(() => {
  vi.useRealTimers();
  delete window.turnstile;
  document.body.innerHTML = '';
  document.head.querySelectorAll('script').forEach((s) => s.remove());
});

/** Cloudflare's widget, loaded: what the check rendered it with, and a way to call it back. */
function stubWidget() {
  const api = { render: vi.fn((_slot: HTMLElement, _options: Record<string, unknown>) => 'widget-1'), remove: vi.fn() };
  window.turnstile = api;
  const options = () => api.render.mock.calls[0][1];
  const callBack = (name: string, ...args: unknown[]) => (options()[name] as (...a: unknown[]) => void)(...args);
  return { api, options, callBack };
}

const panel = () => document.querySelector('[role="status"]');

describe('solveTurnstile', () => {
  it('renders the widget in its panel for the site key and action, and answers with the token it gives', async () => {
    const { api, options, callBack } = stubWidget();
    const solving = solveTurnstile('site-key', 'trial-start', 'Checking…');
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());
    // Interaction-only keeps the widget out of sight unless Cloudflare wants to challenge.
    expect(options()).toMatchObject({ sitekey: 'site-key', action: 'trial-start', appearance: 'interaction-only' });
    expect(panel()?.contains(api.render.mock.calls[0][0])).toBe(true);

    callBack('callback', 'token-1');
    await expect(solving).resolves.toBe('token-1');
    expect(panel()).toBeNull();
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });

  it.each(['error-callback', 'expired-callback', 'timeout-callback'])('fails, and takes its panel down, when the widget calls its %s', async (name) => {
    const { api, callBack } = stubWidget();
    const solving = solveTurnstile('site-key', 'trial', 'Checking…');
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());

    callBack(name);
    await expect(solving).rejects.toBeInstanceOf(Error);
    expect(panel()).toBeNull();
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });

  it('gives up after two minutes without an answer, and takes its panel down', async () => {
    vi.useFakeTimers();
    const { api } = stubWidget();
    const solving = solveTurnstile('site-key', 'trial', 'Checking…');
    const failed = expect(solving).rejects.toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(panel()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(panel()).toBeNull();
    await failed;
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });

  it('loads Cloudflare\'s script on first use, and renders the widget once it has loaded', async () => {
    vi.resetModules();
    const { solveTurnstile: solveFirst } = await import('../turnstile');
    const solving = solveFirst('site-key', 'trial', 'Checking…');
    const script = document.head.querySelector<HTMLScriptElement>('script[src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]');
    expect(script).not.toBeNull();

    const { api, callBack } = stubWidget();
    script!.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());
    callBack('callback', 'token-1');
    await expect(solving).resolves.toBe('token-1');
  });

  it('takes its panel down when called off, and says it was stopped', async () => {
    const api = { render: vi.fn(() => 'widget-1'), remove: vi.fn() };
    window.turnstile = api;
    const stop = new AbortController();
    const solving = solveTurnstile('site-key', 'trial', 'Checking…', { signal: stop.signal });
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Checking…');

    stop.abort();
    await expect(solving).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });

  it('shows nothing for a check called off before it starts', async () => {
    window.turnstile = { render: vi.fn(() => 'widget-1'), remove: vi.fn() };
    const stop = new AbortController();
    stop.abort();
    await expect(solveTurnstile('site-key', 'trial', 'Checking…', { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
