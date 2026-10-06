import { describe, it, expect } from 'vitest';
import { toBrowsableTemplates, runtimeForTemplate, groupByIntent, templateSupportNote } from '../index';
import { BUILT_IN_TEMPLATES } from '@/lib/vfs/templates/registry';
import { TEMPLATE_INTENTS, UNCATEGORIZED_LABEL } from '@/lib/vfs/templates/intents';
import { getProjectRuntimes } from '@/lib/runtimes/registry';
import type { CustomTemplate } from '@/lib/vfs/types';

/**
 * Project creation no longer asks for a runtime: the chosen template supplies it. That only holds
 * if every runtime is reachable through some template, and if each template reports the runtime it
 * will actually give the project.
 */

/** No cast: if CustomTemplate gains a required field, this stops compiling rather than drifting. */
function customTemplate(overrides: Partial<CustomTemplate> = {}): CustomTemplate {
  const base: CustomTemplate = {
    id: 'c1',
    name: 'My template',
    description: 'a custom one',
    version: '1.0.0',
    files: [],
    directories: [],
    metadata: { license: 'personal' },
    importedAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  return { ...base, ...overrides };
}

describe('runtime coverage', () => {
  // Dropping the runtime picker strands a runtime the moment its last template goes away.
  it('every runtime is reachable through at least one built-in template', () => {
    const covered = new Set(BUILT_IN_TEMPLATES.map((t) => t.runtime));
    const missing = getProjectRuntimes()
      .map((r) => r.value)
      .filter((runtime) => !covered.has(runtime));

    expect(missing).toEqual([]);
  });
});

describe('runtimeForTemplate', () => {
  it('reports the runtime a built-in template will apply', () => {
    for (const template of BUILT_IN_TEMPLATES) {
      expect(runtimeForTemplate(template.id, [])).toBe(template.runtime);
    }
  });

  it('reads the runtime off a custom template', () => {
    const templates = [customTemplate({ id: 'c1', runtime: 'svelte' })];

    expect(runtimeForTemplate('custom:c1', templates)).toBe('svelte');
  });

  // Custom templates predate the runtime field; those saved before it are Handlebars, which is the
  // same fallback the old runtime-filtered picker used.
  it('treats a custom template without a runtime as handlebars', () => {
    const templates = [customTemplate({ id: 'c1', runtime: undefined })];

    expect(runtimeForTemplate('custom:c1', templates)).toBe('handlebars');
  });

  // A selection can outlive the template it names — a custom one deleted from the manager, or a
  // built-in id from an older build. Each side keeps its own fallback.
  it('falls back to handlebars for a custom template that no longer exists', () => {
    expect(runtimeForTemplate('custom:deleted', [])).toBe('handlebars');
  });

  it('falls back to static for an unknown built-in id', () => {
    expect(runtimeForTemplate('no-such-template', [])).toBe('static');
  });
});

describe('toBrowsableTemplates', () => {
  it('shows a built-in under the translated copy it is given, and English without one', () => {
    const rows = toBrowsableTemplates([], { blank: { name: 'Static-pohja', description: 'Kuvaus' } });
    expect(rows.find((r) => r.value === 'blank')).toMatchObject({ name: 'Static-pohja', description: 'Kuvaus' });
    const other = BUILT_IN_TEMPLATES.find((t) => t.id !== 'blank')!;
    expect(rows.find((r) => r.value === other.id)?.name).toBe(other.name);
  });

  it('lists built-in and custom templates together', () => {
    const rows = toBrowsableTemplates([customTemplate({ id: 'c1', name: 'Mine' })]);

    expect(rows).toHaveLength(BUILT_IN_TEMPLATES.length + 1);
    expect(rows.filter((r) => !r.isBuiltIn).map((r) => r.name)).toEqual(['Mine']);
  });

  it('namespaces custom template values so ids cannot collide with built-ins', () => {
    const rows = toBrowsableTemplates([customTemplate({ id: 'blank', name: 'Not the built-in' })]);
    const values = rows.map((r) => r.value);

    expect(values).toContain('blank');
    expect(values).toContain('custom:blank');
    expect(new Set(values).size).toBe(values.length);
  });

  it('carries the thumbnail through for templates that have one', () => {
    const rows = toBrowsableTemplates([
      customTemplate({ id: 'c1', metadata: { license: 'mit', thumbnail: 'data:image/png;base64,AA' } }),
    ]);

    expect(rows.find((r) => r.value === 'custom:c1')!.thumbnail).toBe('data:image/png;base64,AA');
  });

  it('flags templates that bring backend features', () => {
    const withBackend = customTemplate({
      id: 'c1',
      backendFeatures: { edgeFunctions: [{ name: 'f', method: 'GET', code: '' }] },
    });
    const withEmpty = customTemplate({ id: 'c2', backendFeatures: { edgeFunctions: [] } });

    const rows = toBrowsableTemplates([withBackend, withEmpty]);

    expect(rows.find((r) => r.value === 'custom:c1')!.hasBackendFeatures).toBe(true);
    expect(rows.find((r) => r.value === 'custom:c2')!.hasBackendFeatures).toBe(false);
  });
});

describe('grouping by intent', () => {
  // The intent decides which heading a template appears under, and there is no "everything else"
  // heading for built-ins to fall into. One without an intent would simply be filed with imported
  // templates, under a heading that reads as though it were not ours.
  it('gives every built-in template an intent', () => {
    const missing = BUILT_IN_TEMPLATES.filter((t) => !t.metadata?.intent).map((t) => t.id);

    expect(missing).toEqual([]);
  });

  it('uses only intents the list knows how to draw', () => {
    const known = new Set(TEMPLATE_INTENTS.map((intent) => intent.id));
    const unknown = BUILT_IN_TEMPLATES
      .map((t) => t.metadata?.intent)
      .filter((intent) => intent && !known.has(intent));

    expect(unknown).toEqual([]);
  });

  it('orders groups the way the intent list declares them', () => {
    const groups = groupByIntent(toBrowsableTemplates([]));
    const declared = TEMPLATE_INTENTS.map((intent) => intent.id);
    const shown = groups.map((g) => g.key);

    expect(shown).toEqual(declared.filter((id) => shown.includes(id)));
  });

  it('draws no heading for an intent nothing uses', () => {
    const groups = groupByIntent(toBrowsableTemplates([]));

    for (const group of groups) {
      expect(group.templates.length, `${group.key} is empty`).toBeGreaterThan(0);
    }
  });

  it('files an imported template with no intent under its own heading, last', () => {
    const groups = groupByIntent(toBrowsableTemplates([customTemplate({ id: 'c1', name: 'Mine' })]));
    const last = groups[groups.length - 1];

    expect(last.label).toBe(UNCATEGORIZED_LABEL);
    expect(last.templates.map((t) => t.name)).toEqual(['Mine']);
  });

  it('files an imported template that does declare an intent under that heading', () => {
    const rows = toBrowsableTemplates([
      customTemplate({ id: 'c1', name: 'Mine', metadata: { license: 'mit', intent: 'workspace' } }),
    ]);
    const groups = groupByIntent(rows);

    expect(groups.find((g) => g.key === 'workspace')!.templates.map((t) => t.name)).toContain('Mine');
    expect(groups.some((g) => g.label === UNCATEGORIZED_LABEL)).toBe(false);
  });

  it('loses no template to grouping', () => {
    const rows = toBrowsableTemplates([customTemplate({ id: 'c1' })]);
    const grouped = groupByIntent(rows).flatMap((g) => g.templates);

    expect(grouped.map((t) => t.value).sort()).toEqual(rows.map((t) => t.value).sort());
  });

  it('gives every group a key that can be stored as a collapsed section', () => {
    // Collapsed sections are remembered by key, so two groups sharing one would close together
    // and an empty key would be stored as a section nothing can reopen.
    const keys = groupByIntent(toBrowsableTemplates([customTemplate({ id: 'c1' })])).map((g) => g.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.length > 0)).toBe(true);
  });
});

describe('environment support notes', () => {
  const note = (over: Partial<Parameters<typeof templateSupportNote>[0]>, serverMode = false) =>
    templateSupportNote(
      { runtime: 'static', intent: 'website', hasBackendFeatures: false, ...over },
      serverMode
    );

  it('says nothing about a template this environment runs fully', () => {
    expect(note({})).toBeNull();
  });

  it('warns that a project kit is not built or run here', () => {
    expect(note({ intent: 'project-kit' })?.kind).toBe('project-kit');
  });

  it('warns that a terminal runtime has no preview and cannot be published', () => {
    // Publishing genuinely refuses these: compile-static-site rejects a terminal runtime.
    expect(note({ runtime: 'python' })?.kind).toBe('terminal-runtime');
    expect(note({ runtime: 'lua' })?.kind).toBe('terminal-runtime');
  });

  it('warns that backend features need Server Mode, and only in Browser mode', () => {
    expect(note({ hasBackendFeatures: true }, false)?.kind).toBe('server-mode');
    expect(note({ hasBackendFeatures: true }, true)).toBeNull();
  });

  it('offers the Server Mode docs alongside that warning', () => {
    // The note names a mode the reader may not have; sending them to the page that explains it is
    // the difference between a caveat and a dead end.
    expect(note({ hasBackendFeatures: true }, false)?.doc?.id).toBe('server-mode');
  });

  // Deliberately no assertions on the wording of `detail`. Substring-matching a paragraph looks
  // like it guards the claim and does not: if provisioning were ever gated on server mode the copy
  // would become a lie and every such test would still pass. The claim is held by the provisioning
  // code having no mode check, not by this file.
  it('covers every built-in that this environment cannot run fully', () => {
    // Derived from runtime and intent rather than declared per template, so this checks the
    // derivation still catches the templates we know are limited, and stays quiet on the rest.
    const rows = toBrowsableTemplates([]);
    const warned = rows
      .filter((t) => templateSupportNote(t, false))
      .map((t) => t.value)
      .sort();

    expect(warned).toEqual(
      ['ai-assistant', 'blog', 'contact-landing', 'lua-starter', 'python-starter', 'spring-rest-postgres'].sort()
    );
  });

  it('drops the backend warnings in Server Mode but keeps the rest', () => {
    const rows = toBrowsableTemplates([]);
    const warned = rows
      .filter((t) => templateSupportNote(t, true))
      .map((t) => t.value)
      .sort();

    expect(warned).toEqual(['lua-starter', 'python-starter', 'spring-rest-postgres'].sort());
  });
});
