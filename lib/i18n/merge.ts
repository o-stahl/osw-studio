type Messages = Record<string, unknown>;

function isPlainObject(value: unknown): value is Messages {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * English filled in under the active locale, so a key missing from ko.json or fi.json renders the
 * English string rather than throwing or printing the key path. Arrays and scalars are replaced
 * whole; only objects recurse.
 */
export function deepMerge<T extends Messages>(base: T, override: Messages): T {
  const out: Messages = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return out as T;
}
