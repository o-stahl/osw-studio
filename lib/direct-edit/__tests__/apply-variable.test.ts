// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { applyVariable } from '../apply-variable';

/** A variable edit, checked as the file it leaves: the project's own stylesheet, changed in place. */

globalThis.indexedDB = new IDBFactory();
let seq = 0;

async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Vars', 'fixture', `p-vars-${++seq}`);
  for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
  return project.id;
}
const read = async (projectId: string, path: string) => String((await vfs.readFile(projectId, path)).content);

const CSS = ':root {\n  --accent: #ff0000;\n  --space: 1rem;\n}\n.card { color: var(--accent); }\n';
const accent = { file: '/styles/main.css', name: '--accent', selector: ':root', context: [], value: '#ff0000' };

describe('applyVariable', () => {
  it('writes the new value where the stylesheet declares it, and records the write for undo', async () => {
    const projectId = await seed({ '/styles/main.css': CSS });
    const record = vi.fn();
    const out = await applyVariable(projectId, accent, '#00ff00', { record });
    expect(out).toEqual({ ok: true, file: '/styles/main.css', filesWritten: ['/styles/main.css'] });
    expect(await read(projectId, '/styles/main.css')).toBe(CSS.replace('#ff0000', '#00ff00'));
    // Not silent: the pages that use the file have to recompile.
    expect(record).toHaveBeenCalledWith({ path: '/styles/main.css', before: CSS, after: CSS.replace('#ff0000', '#00ff00'), silent: false });
  });

  it('writes nothing, and records nothing, for the value it already has', async () => {
    const projectId = await seed({ '/styles/main.css': CSS });
    const record = vi.fn();
    expect(await applyVariable(projectId, accent, ' #ff0000 ', { record })).toEqual({ ok: true, file: '/styles/main.css', filesWritten: [] });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses while the agent is writing, a value that would end the declaration, a missing file and a rule that no longer declares it', async () => {
    const projectId = await seed({ '/styles/main.css': CSS });
    expect((await applyVariable(projectId, accent, '#000', { isGenerating: () => true })).reason).toBe('generating');
    expect((await applyVariable(projectId, accent, 'red; } body { color: blue')).reason).toBe('unsafe');
    expect((await applyVariable(projectId, { ...accent, file: '/nope.css' }, '#000')).reason).toBe('missing-file');
    expect((await applyVariable(projectId, { ...accent, selector: '.theme' }, '#000')).reason).toBe('gone');
    expect(await read(projectId, '/styles/main.css')).toBe(CSS);
  });
});
