/**
 * What a project's own code stores while it runs in the preview.
 *
 * The preview frame runs on an opaque origin, where `localStorage`, `sessionStorage` and
 * `document.cookie` throw. The bridge (`lib/preview/preview-bridge.ts`) puts in-memory stand-ins in
 * their place, seeded from here when the page is written and reported back here when they change.
 * Kept in memory, per project: it survives the preview reloading after every edit, and goes with the
 * tab.
 */

export type PreviewStorageArea = 'local' | 'session' | 'cookie';

export type PreviewStorageSnapshot = Record<PreviewStorageArea, Record<string, string>>;

/** Per area, as a browser roughly allows; a write past it is refused in the frame. */
export const PREVIEW_STORAGE_LIMIT = 5 * 1024 * 1024;

const store = new Map<string, PreviewStorageSnapshot>();

function empty(): PreviewStorageSnapshot {
  return { local: {}, session: {}, cookie: {} };
}

export function getPreviewStorage(projectId: string): PreviewStorageSnapshot {
  const held = store.get(projectId);
  return held
    ? { local: { ...held.local }, session: { ...held.session }, cookie: { ...held.cookie } }
    : empty();
}

function areaSize(data: Record<string, string>): number {
  let size = 0;
  for (const [key, value] of Object.entries(data)) size += key.length + value.length;
  return size;
}

/** Replace one area with what the frame reported. Malformed or oversized reports are dropped. */
export function setPreviewStorageArea(projectId: string, area: unknown, data: unknown): boolean {
  if (area !== 'local' && area !== 'session' && area !== 'cookie') return false;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== 'string') return false;
    clean[key] = value;
  }
  if (areaSize(clean) > PREVIEW_STORAGE_LIMIT) return false;
  const held = store.get(projectId) ?? empty();
  held[area] = clean;
  store.set(projectId, held);
  return true;
}

export function clearPreviewStorage(projectId?: string): void {
  if (projectId) store.delete(projectId);
  else store.clear();
}
