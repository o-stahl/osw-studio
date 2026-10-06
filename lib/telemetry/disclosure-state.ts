import { configManager } from '@/lib/config/storage';

/**
 * Whether the first-run analytics disclosure has been answered, so other first-visit notices can
 * wait for it instead of arriving on top of it. The key's version re-shows an updated disclosure
 * once to someone who answered an older one; someone who opted out is never asked again.
 */
export const DISCLOSED_KEY = 'osw-telemetry-disclosed-v4';
export const DISCLOSURE_SETTLED_EVENT = 'osw:telemetry-disclosure-settled';

export function isDisclosurePending(): boolean {
  try {
    if (configManager.getSettings().telemetryOptIn === false) return false;
    return !localStorage.getItem(DISCLOSED_KEY);
  } catch {
    return false;
  }
}

export function markDisclosureSettled(): void {
  try {
    localStorage.setItem(DISCLOSED_KEY, 'true');
  } catch { /* the event still lets the page move on */ }
  window.dispatchEvent(new Event(DISCLOSURE_SETTLED_EVENT));
}
