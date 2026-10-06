import type { useTranslations } from 'next-intl';

/**
 * Translation for code that is not a component: store actions, services, anything that fires a
 * toast and has no React context to call `useTranslations` from.
 *
 * `TranslatorBridge` (mounted once inside the provider) registers the provider's own translator here
 * and re-registers it whenever it changes, which matters because switching language refreshes the
 * page's data rather than reloading it. Keys are typed against `en.json` exactly as in components.
 *
 * Only for text read *now*, like a toast. Text that is stored (in state, IndexedDB, a project) must
 * be stored as a code or `null` and translated by whatever renders it, or it freezes in the language
 * that was active when it was written.
 *
 * Before the bridge mounts, and in tests that do not register one, `translator()` returns the key
 * path, the same fallback the provider uses for a missing message. English is deliberately not
 * bundled as a fallback: it would add the whole catalogue to the client to cover a moment in which
 * nothing fires a toast.
 *
 * Importable from modules shared with the server (lib/vfs reaches API routes through lib/vfs/index),
 * which is why this is not marked client-only. What must never happen on the server is a
 * *registration*: a module-level translator there would be shared by every request's user. The only
 * caller of `setRuntimeTranslator` is `TranslatorBridge`, a client component, so on the server this
 * only ever returns key paths. Keep it that way: never register a translator from server code.
 */
export type RuntimeTranslator = ReturnType<typeof useTranslations<never>>;

const keyPath = ((key: string) => key) as unknown as RuntimeTranslator;

let current: RuntimeTranslator = keyPath;

export function setRuntimeTranslator(t: RuntimeTranslator | null): void {
  current = t ?? keyPath;
}

/** The active translator. Call it at the moment of use, not once at module load. */
export function translator(): RuntimeTranslator {
  return current;
}
