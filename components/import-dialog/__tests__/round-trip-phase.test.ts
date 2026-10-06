/**
 * The round trip, all the way to the screen it puts on show.
 *
 * `analyze.test.ts` already proves the *plan* is right for a project imported back into itself —
 * everything unchanged, no errors. That assertion passed the whole time the dialog was showing a
 * red "every entry was refused" for it, because nothing connected the plan to the phase. This test
 * closes that gap: it drives a real export → read → analyze, then asks the dialog's own decision
 * function what the user would see.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';

const { vfs } = await import('@/lib/vfs');
const { analyzeImport } = await import('@/lib/vfs/archive/analyze');
const { exportProjectArchive } = await import('@/lib/vfs/archive/export');
const { readZipArchive } = await import('@/lib/vfs/archive/read-zip');
const { selectPhase, nothingToDoCounts } = await import('../logic');

describe('importing a project back into itself', () => {
  beforeAll(async () => {
    await vfs.init();
  });

  it('reads as nothing to do, not as a refusal', async () => {
    const project = await vfs.createProject('Sweet Candies', 'test');
    await vfs.createFile(project.id, '/index.html', '<h1>hi</h1>');
    await vfs.createFile(project.id, '/styles.css', 'body{}');
    await vfs.createFile(project.id, '/.PROMPT.md', 'prompt');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction?.({
      id: `edge-${project.id}`,
      projectId: project.id,
      name: 'send-email',
      code: 'Response.json({ ok: true });',
      method: 'POST',
      enabled: true,
      timeoutMs: 5000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { blob } = await exportProjectArchive(vfs, project.id);
    const { entries } = await readZipArchive(new File([blob], 'sweet-candies.zip'));
    const plan = await analyzeImport(vfs, entries, {
      kind: 'existing-project',
      projectId: project.id,
    });

    expect(plan.errors).toEqual([]);
    expect(plan.files.unchanged.length).toBeGreaterThan(0);
    expect(plan.backend.unchanged).toEqual([{ kind: 'edge', name: 'send-email' }]);

    expect(selectPhase(plan)).toBe('nothing-to-do');
    // Counts, not zero: the summary says the files already match, not that the archive is empty.
    // The three files written above (.PROMPT.md travels in this format) and the one edge function.
    expect(nothingToDoCounts(plan)).toEqual({ files: 3, backend: 1 });
  });
});
