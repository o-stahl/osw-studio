import { describe, it, expect } from 'vitest';
import { applyBuiltInTemplate } from '@/lib/vfs/templates/instantiate';
import { getBuiltInTemplateDefinition } from '@/lib/vfs/templates/registry';
import type { BuiltInTemplateDefinition } from '@/lib/vfs/templates/types';

/**
 * What a project gets from the template it was made from, beyond the files.
 *
 * This settles two things the caller does not pass in and cannot see afterwards without opening the
 * project: the runtime, and the chat starters. Template Manager once wrote the files and left the
 * runtime at its default, so a project created there from a React built-in was React source the app
 * treated as a static site, which fails at bundle time rather than here.
 */

/** A VFS just real enough to record what the template writes onto the project. */
function fakeVfs() {
  const projects = new Map<string, { id: string; name: string; settings: Record<string, unknown> }>();
  const written = new Map<string, string[]>();
  return {
    projects,
    written,
    async getProject(id: string) {
      return projects.get(id);
    },
    async updateProject(project: { id: string; name: string; settings: Record<string, unknown> }) {
      projects.set(project.id, project);
    },
    async createFile(projectId: string, path: string) {
      written.get(projectId)!.push(path);
      return { path };
    },
    async writeFile(projectId: string, path: string) {
      written.get(projectId)!.push(path);
    },
    async createDirectory() {},
    async getFileTree() {
      return null;
    },
    async listFiles(projectId: string) {
      return (written.get(projectId) ?? []).map((path) => ({ path }));
    },
    seed(id: string) {
      projects.set(id, { id, name: 'Empty', settings: {} });
      written.set(id, []);
      return this;
    },
  };
}

const definition = (id: string): BuiltInTemplateDefinition => {
  const found = getBuiltInTemplateDefinition(id);
  if (!found) throw new Error(`no such built-in template: ${id}`);
  return found;
};

describe('applying a built-in template to an empty project', () => {
  it('sets the runtime the template declares, not whatever the project had', async () => {
    // The bug this exists for: files from a bundled-runtime template landing in a project still
    // marked static, so nothing compiles them and the preview serves the source.
    const vfs = fakeVfs().seed('p1');

    await applyBuiltInTemplate(vfs, 'p1', definition('react-demo'));

    expect(vfs.projects.get('p1')!.settings.runtime).toBe('react');
  });

  it('sets the surface the template opens on, and none for a template that declares none', async () => {
    // The surface comes from the definition handed in, whichever template that is.
    const canvas = fakeVfs().seed('p-canvas');
    await applyBuiltInTemplate(canvas, 'p-canvas', { ...definition('blank'), opensIn: 'canvas' });
    expect(canvas.projects.get('p-canvas')!.settings.opensIn).toBe('canvas');

    const preview = fakeVfs().seed('p-preview');
    await applyBuiltInTemplate(preview, 'p-preview', { ...definition('blank'), opensIn: 'preview' });
    expect(preview.projects.get('p-preview')!.settings.opensIn).toBe('preview');

    const none = fakeVfs().seed('p-none');
    await applyBuiltInTemplate(none, 'p-none', { ...definition('blank'), opensIn: undefined });
    expect(none.projects.get('p-none')!.settings).not.toHaveProperty('opensIn');
  });

  it('seeds the chat starters the template ships', async () => {
    const vfs = fakeVfs().seed('p2');
    const def = definition('llm-wiki');

    await applyBuiltInTemplate(vfs, 'p2', def);

    const seeded = vfs.projects.get('p2')!.settings.promptSuggestions as { id: string }[];
    expect(seeded.map((s) => s.id)).toEqual((def.promptSuggestions ?? []).map((s) => s.id));
  });

  it('gives the project its own copy of them, not the template’s objects', async () => {
    // The definitions are module-level singletons shared by every project made from them, so a
    // project editing a starter would otherwise edit it for everyone until the next reload.
    const vfs = fakeVfs().seed('p3');
    const def = definition('llm-wiki');

    await applyBuiltInTemplate(vfs, 'p3', def);

    const seeded = vfs.projects.get('p3')!.settings.promptSuggestions as { label: string }[];
    expect(seeded[0]).not.toBe(def.promptSuggestions![0]);
    seeded[0].label = 'edited';
    expect(def.promptSuggestions![0].label).not.toBe('edited');
  });

  it('leaves the field off for a template that ships no starters', async () => {
    // The chat row falls back to the generic starters on an empty list, so a template with none
    // must not hand the project an empty array that reads as "this project chose to have none".
    const vfs = fakeVfs().seed('p4');
    const def = definition('blank');
    expect(def.promptSuggestions, 'fixture assumes blank ships none').toBeUndefined();

    await applyBuiltInTemplate(vfs, 'p4', def);

    expect(vfs.projects.get('p4')!.settings.promptSuggestions).toBeUndefined();
  });

  it('keeps settings the project already had', async () => {
    // It writes onto the existing settings rather than replacing them, so an entry point or a
    // schema set before the template was applied survives.
    const vfs = fakeVfs().seed('p5');
    vfs.projects.get('p5')!.settings = { previewEntryPoint: '/start.html' };

    await applyBuiltInTemplate(vfs, 'p5', definition('blank'));

    expect(vfs.projects.get('p5')!.settings.previewEntryPoint).toBe('/start.html');
  });

  it('writes the template files and hands back what it loaded', async () => {
    // The return value is why the template list can provision backend features without loading the
    // chunk a second time.
    const vfs = fakeVfs().seed('p6');

    // A template with no bundled assets: fetching those needs `window`, which this environment
    // does not have, and the warning it logs would be noise rather than a finding.
    const template = await applyBuiltInTemplate(vfs, 'p6', definition('handlebars-starter'));

    expect(vfs.written.get('p6')).toContain('/index.html');
    expect(template.files.some((f) => f.path === '/index.html')).toBe(true);
  });
});
