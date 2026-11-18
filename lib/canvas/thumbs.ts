/**
 * Canvas's thumbnails, kept between sessions so a zoomed-out site opens complete.
 *
 * A database of its own (`osw-canvas`), apart from the project storage and its versioning. Keyed by
 * project, page and device; an entry answers only for the page signature it was taken at, so an
 * edited page is settled again. Past `MAX_ENTRIES` the oldest go.
 */

const DB_NAME = 'osw-canvas';
const STORE = 'thumbs';
export const MAX_ENTRIES = 600;

interface Entry {
  key: string;
  project: string;
  blob: Blob;
  signature: string;
  at: number;
}

export interface ThumbCache {
  get(page: string, device: string, signature: string): Promise<Blob | null>;
  put(page: string, device: string, signature: string, blob: Blob): Promise<void>;
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** Strictly increasing, so entries written in the same millisecond still go oldest first. */
let lastStamp = 0;
const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('at', 'at');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { dbPromise = null; reject(request.error); };
    });
  }
  return dbPromise;
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

/** The thumbnail cache for one project. Every failure (no IndexedDB, quota, private mode) is a miss. */
export function canvasThumbs(project: string): ThumbCache {
  const keyOf = (page: string, device: string) => `${project}|${page}|${device}`;
  return {
    async get(page, device, signature) {
      try {
        const db = await open();
        const entry = await new Promise<Entry | undefined>((resolve, reject) => {
          const request = db.transaction(STORE).objectStore(STORE).get(keyOf(page, device));
          request.onsuccess = () => resolve(request.result as Entry | undefined);
          request.onerror = () => reject(request.error);
        });
        return entry && entry.signature === signature ? entry.blob : null;
      } catch {
        return null;
      }
    },
    async put(page, device, signature, blob) {
      try {
        const db = await open();
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put({ key: keyOf(page, device), project, blob, signature, at: stamp() } satisfies Entry);
        const count = store.count();
        count.onsuccess = () => {
          let extra = count.result - MAX_ENTRIES;
          if (extra <= 0) return;
          const cursor = store.index('at').openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c || extra <= 0) return;
            c.delete();
            extra--;
            c.continue();
          };
        };
        await done(tx);
      } catch {
        // A thumbnail that could not be kept is made again next time.
      }
    },
  };
}
