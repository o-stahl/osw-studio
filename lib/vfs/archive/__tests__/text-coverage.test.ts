import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import type { EdgeFunction } from '../../types';
import type { ArchiveEntry, ImportResolutions } from '../types';
import { ArchiveError, said, type ArchiveText } from '../text';

/**
 * Everything the archive layer reports reaches the import dialog as `text`, which it words in the
 * viewer's language; `message` is the same thing in English for logs. An issue that lost its
 * `text` on the way out shows English to everyone, and one whose `text` says something other than
 * its `message` shows a different reason than the log records. So: every issue and failure these
 * fixtures provoke carries `text`, and `text` renders to exactly its `message`.
 */

const { vfs } = await import('../../index');
const { analyzeImport } = await import('../analyze');
const { applyImport, backendResolutionKey } = await import('../apply');
const { readZipArchive } = await import('../read-zip');
const { folderToArchiveEntries } = await import('../read-folder');
const { MAX_PATH_LENGTH } = await import('../paths');

type Reported = { message: string; text?: ArchiveText };

function entriesFrom(pairs: Array<[string, string]>): ArchiveEntry[] {
  return pairs.map(([path, content]) => {
    const bytes = new TextEncoder().encode(content);
    return { path, read: async () => bytes.buffer.slice(0) as ArrayBuffer, declaredSize: bytes.byteLength };
  });
}

function expectWorded(reported: Reported[]): string[] {
  expect(reported.length).toBeGreaterThan(0);
  for (const item of reported) {
    expect(item.text, item.message).toBeDefined();
    expect(said(item.text!.key, item.text!.values).message).toBe(item.message);
  }
  return reported.map((item) => item.text!.key);
}

async function expectThrownWorded(run: () => Promise<unknown> | unknown, text: ArchiveText) {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ArchiveError);
  const error = thrown as ArchiveError;
  expect(error.name).toBe('ArchiveError');
  expect(error.text).toEqual(text);
  expect(error.message).toBe(said(text.key, text.values).message);
}

function resolutions(overrides: Partial<ImportResolutions> = {}): ImportResolutions {
  return { files: {}, backend: {}, settings: {}, skipBlocked: true, ...overrides };
}

const serverModeBefore = process.env.NEXT_PUBLIC_SERVER_MODE;

describe('archive text', () => {
  beforeAll(async () => {
    await vfs.init();
  });

  afterEach(() => {
    if (serverModeBefore === undefined) delete process.env.NEXT_PUBLIC_SERVER_MODE;
    else process.env.NEXT_PUBLIC_SERVER_MODE = serverModeBefore;
  });

  it('words every issue the analyzer raises', async () => {
    delete process.env.NEXT_PUBLIC_SERVER_MODE;
    const project = await vfs.createProject('Worded', 'test');
    const plan = await analyzeImport(
      vfs,
      entriesFrom([
        ['/osw-project.json', '{"formatVersion": 99, "name": "From the future"}'],
        ['/.PROMPT.md', 'be terse'],
        ['/dup.txt', 'one'],
        ['/dup.txt', 'two'],
        ['/.server/notes.txt', 'stray'],
        ['/.server/scheduled.json', 'not json'],
        ['/.server/secrets.json', JSON.stringify([{ name: 'API_KEY', value: 'sk_live' }, 5])],
        ['/.server/edge-functions/nested/x.js', 'Response.json({});'],
        ['/.server/edge-functions/a.js', 'Response.json({});'],
        ['/.server/edge-functions/a.json', '{oops'],
        ['/.server/edge-functions/b.json', '{"method":"GET"}'],
        ['/.server/edge-functions/modern.js', 'export default async () => {}'],
        ['/.server/edge-functions/ok.js', 'Response.json({});'],
      ]),
      { kind: 'existing-project', projectId: project.id }
    );

    const keys = expectWorded([...plan.errors, ...plan.warnings]);
    expect(keys).toEqual(expect.arrayContaining([
      'manifestNewer', 'aiInstructions', 'duplicateInArchive', 'notBackendLayout', 'listNotJson',
      'secretValue', 'entryNotObject', 'nestedBackendFile', 'sidecarNotJson', 'missingCode',
      'invalidRecord', 'browserModeBackend',
    ]));
  });

  it('words every path the zip reader refuses', async () => {
    const zip = new JSZip();
    zip.file('ok.txt', 'x');
    zip.file('bad@@name.txt', 'x');
    zip.file('../../evil.txt', 'x');
    zip.file('a\u202Eb.txt', 'x');
    zip.file(`${'x'.repeat(600)}.txt`, 'x');
    const blob = await zip.generateAsync({ type: 'blob' });
    const { issues } = await readZipArchive(new File([blob], 'test.zip'));

    expect(expectWorded(issues)).toEqual(expect.arrayContaining(['doubleAt', 'outsideProject', 'controlChar', 'pathTooLong']));
    expect(issues.find((i) => i.text?.key === 'pathTooLong')?.text?.values).toEqual({ max: MAX_PATH_LENGTH });
  });

  it('words every path the folder reader refuses', () => {
    const files = [
      ['/assets\\logo.png', 'x'],
      ['/a@@b.txt', 'x'],
      ['/a\0b.txt', 'x'],
      ['/dup.txt', '1'],
      ['/dup.txt', '2'],
    ].map(([path, content]) => ({ file: new File([content], 'f'), path }));
    const { issues } = folderToArchiveEntries(files);

    expect(expectWorded(issues)).toEqual(expect.arrayContaining(['windowsSeparators', 'doubleAt', 'nullByte', 'duplicateInFolder']));
  });

  it('words every failure an import reports', async () => {
    const project = await vfs.createProject('WordedApply', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!({
      id: `edge-send-email-${project.id}`, projectId: project.id, name: 'send-email',
      code: 'OLD;', method: 'POST', enabled: true, timeoutMs: 5000,
      createdAt: new Date(), updatedAt: new Date(),
    } as EdgeFunction);

    const entries = entriesFrom([
      ['/osw-project.json', JSON.stringify({ formatVersion: 1, name: 'WordedApply', runtime: 'wordpress' })],
      ['/.server/edge-functions/send-email.js', 'NEW;'],
      ['/.server/edge-functions/a.js', 'FIRST;'],
      ['/.server/edge-functions/a.json', JSON.stringify({ name: 'notify', method: 'POST' })],
      ['/.server/edge-functions/b.js', 'SECOND;'],
      ['/.server/edge-functions/b.json', JSON.stringify({ name: 'notify', method: 'GET' })],
      ['/.server/scheduled.json', JSON.stringify([{
        name: 'nightly', functionName: 'not-here', cronExpression: '0 3 * * *', timezone: 'UTC', enabled: true, config: {},
      }])],
    ]);
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    plan.backend.conflicts[0].keepBothName = 'Send Email (2)';
    const result = await applyImport(
      vfs,
      plan,
      resolutions({
        settings: { runtime: 'use-archive' },
        backend: { [backendResolutionKey('edge', 'send-email')]: 'keep-both' },
      }),
      entries,
      target
    );

    expect(expectWorded(result.failed)).toEqual(expect.arrayContaining(['unknownRuntime', 'invalidRecord', 'missingEdgeFunction', 'duplicateName']));
  });

  it('words the budgets the readers refuse an archive over', async () => {
    const zip = new JSZip();
    zip.file('a.txt', 'aaaa');
    zip.file('b.txt', 'bbbb');
    const file = new File([await zip.generateAsync({ type: 'blob' })], 'test.zip');

    await expectThrownWorded(() => readZipArchive(file, { maxEntries: 1 }), { key: 'zipTooManyEntries', values: { count: 2, max: 1 } });
    await expectThrownWorded(() => readZipArchive(file, { maxFileSize: 10 }), { key: 'zipTooLarge', values: { limit: '10 bytes' } });
    await expectThrownWorded(() => readZipArchive(file, { maxTotalBytes: 6 }), { key: 'unpackedTooLarge', values: { limit: '6 bytes' } });

    const folder = [['/a.txt', 'aaaa'], ['/b.txt', 'bbbb']].map(([path, content]) => ({ file: new File([content], 'f'), path }));
    await expectThrownWorded(() => folderToArchiveEntries(folder, { maxEntries: 1 }), { key: 'folderTooManyFiles', values: { count: 2, max: 1 } });
    await expectThrownWorded(() => folderToArchiveEntries(folder, { maxTotalBytes: 6 }), { key: 'folderTooLarge', values: { limit: '6 bytes' } });
  });

  it('says why a file is not a zip', async () => {
    let thrown: unknown;
    try {
      await readZipArchive(new File(['not a zip at all'], 'test.zip'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArchiveError);
    const error = thrown as ArchiveError;
    expect(error.text.key).toBe('notZip');
    expect(String(error.text.values?.detail ?? '')).not.toBe('');
    expect(error.message).toBe(said('notZip', error.text.values).message);
  });
});
