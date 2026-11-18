import type { Project, ProjectRuntime } from './types';
import { RUNTIME_CONFIGS } from '@/lib/runtimes/registry';

/**
 * Reading a project's settings, and deciding its runtime.
 *
 * `Project['settings']` is typed as an object, and stored data does not always agree. A project
 * written back straight from a JSON API response keeps whatever that response held -- the same
 * reason `hydrateProject` re-makes the dates -- and for settings that has meant a JSON *string*
 * where an object belongs. Once one is stored, `updateProject` re-encodes it on the way to SQLite
 * (`JSON.stringify(project.settings ?? {})`), so each round trip wraps it in another layer, and
 * anything doing `{ ...project.settings, x }` spreads the characters of the string into keys
 * `"0"`, `"1"`, `"2"`.
 *
 * None of that throws. `settings.runtime` on a string is `undefined`, so the project reads as
 * having no runtime and every consumer falls back -- which is why a handlebars project lost its
 * selection toolbar while still compiling as handlebars, and why a runtime looked like it reset
 * itself.
 *
 * So the shape is repaired where a project is read, next to the dates, rather than at the writers:
 * the writers are already correct, the data is not, and a normalizer in the read path covers the
 * ones that have been and gone.
 */

type ProjectSettings = Project['settings'];

/**
 * The runtime a project without one is treated as.
 *
 * Handlebars rather than `static` because that is what the projects predating the setting were
 * rendered with; reading them as static would stop running their templates.
 *
 * Exported so this is decided once. It used to be spelled `|| 'handlebars'` at the compiler and
 * `return false` at `supportsDirectEditing`, which meant a project with no runtime compiled as
 * handlebars and was then offered the toolbar of a runtime that cannot have one.
 */
export const FALLBACK_RUNTIME: ProjectRuntime = 'handlebars';

const KNOWN_RUNTIMES = new Set<string>(RUNTIME_CONFIGS.map((c) => c.id));

/** How many `JSON.parse` layers to peel. Bounded so a pathological value cannot spin. */
const MAX_ENCODING_LAYERS = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The keys a string leaves behind when it is spread into an object literal.
 *
 * `{ ...'{}' }` is `{ '0': '{', '1': '}' }`, so a settings record that went through one of the
 * `{ ...project.settings, x }` writers carries the characters alongside the real fields. Dropped by
 * shape -- a decimal index -- because a genuine setting is never named one.
 */
function isIndexKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/**
 * A settings record, whatever was actually stored.
 *
 * Returns a new object every time and never throws: unreadable settings become `{}`, which is the
 * same answer as a project that never had any, and lets the caller's own fallbacks apply.
 */
export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  let value = raw;

  // Peel the encoding layers. Each push through SQLite added one, so a value can be a string
  // holding a string holding the object.
  for (let i = 0; i < MAX_ENCODING_LAYERS && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (!isPlainObject(value)) return {};

  const settings: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isIndexKey(key)) continue;
    settings[key] = entry;
  }

  // An unknown runtime is dropped rather than kept: every consumer switches on it, and a value none
  // of them match reads as a runtime that exists and does nothing. Absent, the fallback applies.
  if (settings.runtime !== undefined && !KNOWN_RUNTIMES.has(settings.runtime as string)) {
    delete settings.runtime;
  }
  // The same for the surface a project opens on: a value that names neither is no preference.
  if (settings.opensIn !== undefined && settings.opensIn !== 'canvas' && settings.opensIn !== 'preview') {
    delete settings.opensIn;
  }

  return settings as ProjectSettings;
}

/** True when the stored value is not already the record it claims to be. */
export function settingsNeedNormalizing(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (!isPlainObject(raw)) return true;
  return Object.keys(raw).some(
    (key) => isIndexKey(key) || (key === 'runtime' && !KNOWN_RUNTIMES.has((raw as Record<string, unknown>).runtime as string)),
  );
}

/**
 * The runtime to render and reason about a project with.
 *
 * For a caller holding a whole settings record: it normalizes first, so settings that are a JSON
 * string answer the same as the record they encode. A caller that already has the runtime field on
 * its own applies `FALLBACK_RUNTIME` directly -- the constant is what keeps the answers the same,
 * and it is why the renderer and the features gated on the runtime cannot disagree about a project.
 */
export function resolveRuntime(settings: ProjectSettings | undefined | null): ProjectRuntime {
  const runtime = normalizeProjectSettings(settings).runtime;
  return runtime ?? FALLBACK_RUNTIME;
}
