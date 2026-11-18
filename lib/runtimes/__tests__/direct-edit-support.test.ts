import { describe, it, expect } from 'vitest';
import { canvasSupport, supportsDirectEditing, RUNTIME_CONFIGS } from '../registry';

/**
 * Which runtimes the preview's direct-edit surface is offered in.
 *
 * Derived from `previewMode` and `bundled` rather than listed, so these tests pin the *consequence*:
 * a bundled runtime draws its elements after the bundle runs, so they carry no `data-osw-src` and
 * every toolbar action would refuse. A new runtime therefore gets the right answer without anyone
 * remembering to add it here, and the last test is what catches the derivation drifting.
 */
describe('supportsDirectEditing', () => {
  it('is on for the two runtimes whose elements come from source files', () => {
    expect(supportsDirectEditing('static')).toBe(true);
    expect(supportsDirectEditing('handlebars')).toBe(true);
  });

  it('is off for every bundled runtime', () => {
    for (const runtime of ['react', 'preact', 'svelte', 'vue'] as const) {
      expect(supportsDirectEditing(runtime), `${runtime} offers a toolbar that cannot work`).toBe(false);
    }
  });

  it('is off where there is no DOM to point at', () => {
    expect(supportsDirectEditing('python')).toBe(false);
    expect(supportsDirectEditing('lua')).toBe(false);
  });

  it('is off for a missing or unknown runtime, rather than the permissive answer', () => {
    expect(supportsDirectEditing(undefined)).toBe(false);
    expect(supportsDirectEditing(null)).toBe(false);
    // A runtime id the registry does not carry: a project saved by a newer build, or a value the
    // shell's `runtime` command wrote. Answering true would offer a toolbar over a preview nobody
    // here knows the shape of, which is the one direction that cannot be recovered from.
    expect(supportsDirectEditing('webassembly' as never)).toBe(false);
  });

  it('agrees with the registry it is derived from, for every runtime', () => {
    for (const config of RUNTIME_CONFIGS) {
      expect(supportsDirectEditing(config.id), config.id)
        .toBe(config.previewMode === 'visual' && !config.bundled);
    }
  });
});

describe('canvasSupport', () => {
  it('edits where elements come from source files, shows bundled pages, and has nothing for terminals', () => {
    expect(canvasSupport('static')).toBe('edit');
    expect(canvasSupport('handlebars')).toBe('edit');
    for (const runtime of ['react', 'preact', 'svelte', 'vue'] as const) expect(canvasSupport(runtime), runtime).toBe('view');
    expect(canvasSupport('python')).toBeNull();
    expect(canvasSupport('lua')).toBeNull();
  });

  it('is null for a missing or unknown runtime', () => {
    expect(canvasSupport(undefined)).toBeNull();
    expect(canvasSupport(null)).toBeNull();
    expect(canvasSupport('webassembly' as never)).toBeNull();
  });

  it('edits exactly where direct editing works', () => {
    for (const config of RUNTIME_CONFIGS) {
      expect(canvasSupport(config.id) === 'edit', config.id).toBe(supportsDirectEditing(config.id));
    }
  });
});
