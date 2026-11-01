/**
 * Cloudflare Turnstile for the demo's trial (`./trial-check.ts`). The script loads on first use, and
 * the widget renders in a small panel at the foot of the page only while the check runs. With
 * `interaction-only`, most visitors see the caption for a moment; the few Cloudflare wants to
 * challenge get its checkbox in the same panel.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')));
      script.onerror = () => reject(new Error('Turnstile did not load'));
      document.head.appendChild(script);
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/**
 * Run the check and return Cloudflare's token for it, which this app's server verifies once. `signal`
 * calls it off: the panel goes, and the promise rejects with an `AbortError`.
 */
export async function solveTurnstile(
  siteKey: string,
  action: string,
  caption: string,
  { timeoutMs = 120_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const api = await loadTurnstile();
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const panel = document.createElement('div');
    panel.setAttribute('role', 'status');
    // Above the toasts (sonner stacks at 999999999), which share the foot of the page: a challenge
    // under one could not be answered.
    panel.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-[1000000000] flex max-w-[calc(100vw-2rem)] flex-col items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground shadow-lg';
    const label = document.createElement('p');
    label.textContent = caption;
    const slot = document.createElement('div');
    panel.append(label, slot);
    document.body.appendChild(panel);

    let widgetId: string | undefined;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (widgetId) api.remove(widgetId);
      } catch {
        // Already gone.
      }
      panel.remove();
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Turnstile timed out'))), timeoutMs);
    signal?.addEventListener('abort', () => finish(() => reject(signal.reason)), { once: true });
    try {
      widgetId = api.render(slot, {
        sitekey: siteKey,
        action,
        appearance: 'interaction-only',
        callback: (token: string) => finish(() => resolve(token)),
        'error-callback': () => finish(() => reject(new Error('Turnstile failed'))),
        'expired-callback': () => finish(() => reject(new Error('Turnstile expired'))),
        'timeout-callback': () => finish(() => reject(new Error('Turnstile timed out'))),
      });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
