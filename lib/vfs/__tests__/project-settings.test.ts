import { describe, it, expect } from 'vitest';
import {
  FALLBACK_RUNTIME,
  normalizeProjectSettings,
  resolveRuntime,
  settingsNeedNormalizing,
} from '../project-settings';

/**
 * Reading settings that are not the record the type promises.
 *
 * Every shape asserted here was read out of a real workspace database rather than invented: a
 * `settings` held as a JSON string, one stringified repeatedly until it was mostly escapes, and one
 * spread into character keys. None of it throws -- `settings.runtime` on a string is just
 * `undefined` -- which is why it went unnoticed while a handlebars project lost its selection
 * toolbar and runtimes appeared to reset themselves.
 *
 * The fallback is asserted through `resolveRuntime` rather than by reading the constant, because
 * the bug was two call sites disagreeing about the absent case, not the value either chose.
 */

describe('settings stored as something other than a record', () => {
  it('reads a record as itself', () => {
    expect(normalizeProjectSettings({ runtime: 'react', previewEntryPoint: '/main.html' }))
      .toEqual({ runtime: 'react', previewEntryPoint: '/main.html' });
  });

  it('parses settings stored as a JSON string', () => {
    expect(normalizeProjectSettings('{"runtime":"handlebars"}')).toEqual({ runtime: 'handlebars' });
  });

  it('unwraps a value stringified more than once', () => {
    // What a push through SQLite did on every round trip: JSON.stringify over an already-encoded
    // string, one layer at a time.
    let encoded: string = JSON.stringify({ runtime: 'vue' });
    for (let i = 0; i < 4; i++) encoded = JSON.stringify(encoded);

    expect(normalizeProjectSettings(encoded)).toEqual({ runtime: 'vue' });
  });

  it('gives up on a value it cannot parse rather than throwing', () => {
    expect(normalizeProjectSettings('not json at all')).toEqual({});
  });

  it('stops peeling at the bound rather than unwrapping forever', () => {
    // Twelve layers, against a bound of eight. Not forty: each layer roughly doubles the escaping,
    // so the fixture itself exceeds the maximum string length long before the function would.
    let encoded: string = JSON.stringify({ runtime: 'react' });
    for (let i = 0; i < 12; i++) encoded = JSON.stringify(encoded);

    // Still a string when the bound is reached, so the answer is the empty record -- the same
    // answer as any other value it cannot make a record of.
    expect(normalizeProjectSettings(encoded)).toEqual({});
  });

  it('drops the character keys a spread string left behind', () => {
    // The shape a stored project was found in: `{ ...'"{}"', promptSuggestions }` from one of the
    // `{ ...project.settings, x }` writers.
    const spread = {
      '0': '"', '1': '{', '2': '}', '3': '"',
      promptSuggestions: [{ id: 'a', label: 'Add something', prompt: 'Add something' }],
    };

    expect(normalizeProjectSettings(spread)).toEqual({
      promptSuggestions: [{ id: 'a', label: 'Add something', prompt: 'Add something' }],
    });
  });

  it('reads an empty record out of nothing at all', () => {
    expect(normalizeProjectSettings(undefined)).toEqual({});
    expect(normalizeProjectSettings(null)).toEqual({});
  });

  it('refuses an array, which is not a settings record', () => {
    expect(normalizeProjectSettings(['runtime', 'react'])).toEqual({});
  });

  it('drops a runtime no consumer would match', () => {
    // Kept, it reads as a runtime that exists and does nothing: every switch falls through it.
    // Dropped, the absent case applies, which has an answer.
    expect(normalizeProjectSettings({ runtime: 'webassembly' }).runtime).toBeUndefined();
  });

  it('returns a record the caller can write to without touching the stored one', () => {
    const stored = { runtime: 'react' as const };
    const normalized = normalizeProjectSettings(stored);
    normalized.previewEntryPoint = '/other.html';

    expect(stored).toEqual({ runtime: 'react' });
  });
});

describe('deciding whether a stored record needs repair', () => {
  it('leaves a clean record alone, so the migration writes nothing', () => {
    expect(settingsNeedNormalizing({ runtime: 'react' })).toBe(false);
    expect(settingsNeedNormalizing({})).toBe(false);
  });

  it('reports a string, a spread and an unknown runtime', () => {
    expect(settingsNeedNormalizing('{}')).toBe(true);
    expect(settingsNeedNormalizing({ '0': '{', '1': '}' })).toBe(true);
    expect(settingsNeedNormalizing({ runtime: 'webassembly' })).toBe(true);
  });

  it('reports nothing at all, which the migration replaces with a record', () => {
    expect(settingsNeedNormalizing(undefined)).toBe(true);
    expect(settingsNeedNormalizing(null)).toBe(true);
  });
});

describe('the runtime a project is treated as', () => {
  it('is the one the project names', () => {
    expect(resolveRuntime({ runtime: 'python' })).toBe('python');
  });

  it('is the fallback when the project names none', () => {
    expect(resolveRuntime({})).toBe(FALLBACK_RUNTIME);
    expect(resolveRuntime(undefined)).toBe(FALLBACK_RUNTIME);
  });

  it('is the same answer for settings stored as a string as for the record it encodes', () => {
    // The disagreement this replaces: the compiler read the string case as handlebars and the
    // toolbar gate read it as no runtime, for one project at one moment.
    //
    // Asserted with a runtime that is *not* the fallback. Spelling it 'handlebars' passes whether
    // or not the string is parsed at all, since an unparsed value resolves to the fallback and the
    // fallback is handlebars -- the test would hold for the bug it exists to catch.
    expect(resolveRuntime('{"runtime":"vue"}' as never)).toBe('vue');
    expect(resolveRuntime('"{}"' as never)).toBe(FALLBACK_RUNTIME);
  });
});

describe('the surface a project opens on', () => {
  it('keeps canvas and preview, and drops anything else as no preference', () => {
    expect(normalizeProjectSettings({ runtime: 'static', opensIn: 'canvas' }).opensIn).toBe('canvas');
    expect(normalizeProjectSettings({ opensIn: 'preview' }).opensIn).toBe('preview');
    expect(normalizeProjectSettings({ runtime: 'static', opensIn: 'editor' })).toEqual({ runtime: 'static' });
    expect(normalizeProjectSettings({ opensIn: null })).toEqual({});
  });
});
