import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { EdgeFunction, VirtualFile } from '../../types';
import { FILE_SIZE_LIMITS } from '../../types';
import type { ArchiveEntry, ImportResolutions } from '../types';

const { vfs } = await import('../../index');
const { analyzeImport } = await import('../analyze');
const { applyImport, backendResolutionKey } = await import('../apply');
const { checkpointManager } = await import('../../checkpoint');
const { saveManager } = await import('../../save-manager');

function entriesFrom(map: Record<string, string>): ArchiveEntry[] {
  return Object.entries(map).map(([path, content]) => {
    const bytes = new TextEncoder().encode(content);
    return {
      path,
      read: async () => bytes.buffer.slice(0) as ArrayBuffer,
      declaredSize: bytes.byteLength,
    };
  });
}

/** No decision recorded for anything — the state a caller starts from. */
function resolutions(overrides: Partial<ImportResolutions> = {}): ImportResolutions {
  return { files: {}, backend: {}, settings: {}, skipBlocked: true, ...overrides };
}

async function fileMap(projectId: string): Promise<Map<string, string>> {
  const items = await vfs.getAllFilesAndDirectories(projectId);
  const map = new Map<string, string>();
  for (const item of items) {
    if (item.type === 'directory') continue;
    const file = item as VirtualFile;
    map.set(file.path, typeof file.content === 'string' ? file.content : '<bin>');
  }
  return map;
}

async function dirPaths(projectId: string): Promise<string[]> {
  const items = await vfs.getAllFilesAndDirectories(projectId);
  return items.filter((item) => item.type === 'directory').map((item) => item.path);
}

function edgeFunction(projectId: string, overrides: Partial<EdgeFunction> = {}): EdgeFunction {
  return {
    id: `edge-${overrides.name ?? 'fn'}-${projectId}`,
    projectId,
    name: 'send-email',
    code: 'Response.json({ ok: true });',
    method: 'POST',
    enabled: true,
    timeoutMs: 5000,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** analyze then apply against the same target, which is the only order a caller can use. */
async function run(
  projectId: string,
  files: Record<string, string>,
  overrides: Partial<ImportResolutions> = {}
) {
  const entries = entriesFrom(files);
  const target = { kind: 'existing-project' as const, projectId };
  const plan = await analyzeImport(vfs, entries, target);
  const result = await applyImport(vfs, plan, resolutions(overrides), entries, target);
  return { plan, result };
}

const serverModeBefore = process.env.NEXT_PUBLIC_SERVER_MODE;

describe('applyImport', () => {
  beforeAll(async () => {
    await vfs.init();
  });

  afterEach(() => {
    // Every test here runs in Browser mode, which is where a mount-based write would throw.
    if (serverModeBefore === undefined) delete process.env.NEXT_PUBLIC_SERVER_MODE;
    else process.env.NEXT_PUBLIC_SERVER_MODE = serverModeBefore;
  });

  // The file half of the undo. Backend records and settings restore too — covered in
  // checkpoint-backend.test.ts, which exercises them directly rather than through an import.
  it('checkpoints before the first write, and restoring undoes the files it wrote', async () => {
    const project = await vfs.createProject('Checkpoint', 'test');
    await vfs.createFile(project.id, '/index.html', 'ORIGINAL');

    const { result } = await run(
      project.id,
      { '/index.html': 'REPLACEMENT', '/new.css': 'body{}' },
      { files: { '/index.html': 'replace' } }
    );

    expect(result.checkpointId).toBeTruthy();
    // The panel words the checkpoint from its label, in the viewer's language.
    const listed = await checkpointManager.getCheckpoints(project.id);
    expect(listed.find((cp) => cp.id === result.checkpointId)?.label).toEqual({
      key: 'beforeImport', values: { name: 'Checkpoint' },
    });
    const afterImport = await fileMap(project.id);
    expect(afterImport.get('/index.html')).toBe('REPLACEMENT');
    expect(afterImport.get('/new.css')).toBe('body{}');

    // The checkpoint holding ORIGINAL is only possible if it was taken before the write.
    const restored = await checkpointManager.restoreCheckpoint(result.checkpointId!);
    expect(restored).toBe(true);
    const afterRestore = await fileMap(project.id);
    expect(afterRestore.get('/index.html')).toBe('ORIGINAL');
    expect(afterRestore.has('/new.css')).toBe(false);
  });

  it('writes new files and creates every ancestor directory', async () => {
    const project = await vfs.createProject('Nested', 'test');

    const { result } = await run(project.id, { '/a/b/c/deep.css': '.deep{}' });

    expect(result.failed).toEqual([]);
    expect(result.applied.files).toBe(1);
    expect((await fileMap(project.id)).get('/a/b/c/deep.css')).toBe('.deep{}');
    expect(await dirPaths(project.id)).toEqual(expect.arrayContaining(['/a', '/a/b', '/a/b/c']));
  });

  it('leaves a conflicting file untouched when no resolution was recorded', async () => {
    const project = await vfs.createProject('KeepMine', 'test');
    await vfs.createFile(project.id, '/index.html', 'MINE');

    const { plan, result } = await run(project.id, { '/index.html': 'THEIRS' });

    expect(plan.files.conflicts).toHaveLength(1);
    expect(result.applied.files).toBe(0);
    expect(result.failed).toEqual([]);
    expect((await fileMap(project.id)).get('/index.html')).toBe('MINE');
  });

  it('leaves a conflicting file untouched under an explicit keep-mine', async () => {
    const project = await vfs.createProject('KeepMineExplicit', 'test');
    await vfs.createFile(project.id, '/index.html', 'MINE');

    await run(project.id, { '/index.html': 'THEIRS' }, { files: { '/index.html': 'keep-mine' } });

    expect((await fileMap(project.id)).get('/index.html')).toBe('MINE');
  });

  it('keeps both: writes the renamed path and leaves the original alone', async () => {
    const project = await vfs.createProject('KeepBoth', 'test');
    await vfs.createFile(project.id, '/index.html', 'MINE');

    const { plan, result } = await run(
      project.id,
      { '/index.html': 'THEIRS' },
      { files: { '/index.html': 'keep-both' } }
    );

    expect(plan.files.conflicts[0].keepBothPath).toBe('/index (2).html');
    expect(result.failed).toEqual([]);
    const files = await fileMap(project.id);
    expect(files.get('/index.html')).toBe('MINE');
    expect(files.get('/index (2).html')).toBe('THEIRS');
  });

  it('refuses keep-both rather than replacing when no renamed path fits', async () => {
    // The analyzer omits keepBothPath when nothing under the 200-character limit works, and the
    // dialog does not offer the option for such a row. A resolution can still arrive saying
    // 'keep-both' — from apply-to-all, or a stale plan — and falling back to replace there would
    // destroy the user's file under a decision they made specifically to keep it.
    const dir = '/' + 'd'.repeat(190);
    const path = `${dir}/a.html`;
    const project = await vfs.createProject('NoKeepBothApply', 'test');
    await vfs.createDirectory(project.id, dir);
    await vfs.createFile(project.id, path, 'MINE');

    const { plan, result } = await run(
      project.id,
      { [path]: 'THEIRS' },
      { files: { [path]: 'keep-both' } }
    );

    expect(plan.files.conflicts[0].keepBothPath).toBeUndefined();
    expect(result.applied.files).toBe(0);
    expect((await fileMap(project.id)).get(path)).toBe('MINE');
    expect(result.failed).toEqual([
      {
        path,
        message: 'Keeping both copies would make the path too long, so nothing was written.',
        text: { key: 'keepBothTooLong' },
      },
    ]);
  });

  it('matches a plan path to its entry under NFC rather than string equality', async () => {
    const project = await vfs.createProject('Normalization', 'test');
    // The project spells it NFD (how macOS writes it); the archive spells it NFC.
    const nfd = '/caf\u0065\u0301.txt'; // 'e' + combining acute
    const nfc = '/caf\u00e9.txt'; // precomposed
    expect(nfd).not.toBe(nfc);
    await vfs.createFile(project.id, nfd, 'MINE');

    const { plan, result } = await run(project.id, { [nfc]: 'THEIRS' }, { files: { [nfd]: 'replace' } });

    // The analyzer reports the project's spelling, so a plain lookup in `entries` finds nothing.
    expect(plan.files.conflicts.map((c) => c.path)).toEqual([nfd]);
    expect(result.failed).toEqual([]);
    expect(result.applied.files).toBe(1);
    const files = await fileMap(project.id);
    expect(files.get(nfd)).toBe('THEIRS');
    // No duplicate beside the file it meant to replace.
    expect(files.has(nfc)).toBe(false);
  });

  it('writes binary content as bytes when the manifest says the extension lies', async () => {
    const project = await vfs.createProject('Encoding', 'test');
    const entries = entriesFrom({
      '/project.json': JSON.stringify({
        formatVersion: 1,
        name: 'Encoding',
        encoding: { '/notes.txt': 'binary' },
      }),
      '/notes.txt': 'raw',
    });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    await applyImport(vfs, plan, resolutions(), entries, target);

    const stored = await vfs.readFile(project.id, '/notes.txt');
    expect(typeof stored.content).not.toBe('string');
    // Bytes, not merely a non-string: an empty or truncated buffer passes the shape check.
    expect(new Uint8Array(stored.content as ArrayBuffer)).toEqual(new TextEncoder().encode('raw'));
  });

  it('applies only the settings marked use-archive', async () => {
    const project = await vfs.createProject('Settings', 'old description');
    project.settings = { runtime: 'handlebars', previewEntryPoint: '/index.html' };
    await vfs.updateProject(project);

    const entries = entriesFrom({
      '/project.json': JSON.stringify({
        formatVersion: 1,
        name: 'Renamed',
        description: 'new description',
        runtime: 'static',
        entryPoint: '/home.html',
      }),
    });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    const result = await applyImport(
      vfs,
      plan,
      resolutions({ settings: { runtime: 'use-archive', name: 'keep-current' } }),
      entries,
      target
    );

    expect(result.applied.settings).toBe(1);
    const after = await vfs.getProject(project.id);
    expect(after.settings.runtime).toBe('static');
    expect(after.name).toBe('Settings');
    expect(after.settings.previewEntryPoint).toBe('/index.html');
  });

  it('refuses a runtime the app does not have', async () => {
    const project = await vfs.createProject('BadRuntime', 'test');
    project.settings = { runtime: 'static' };
    await vfs.updateProject(project);

    const entries = entriesFrom({
      '/project.json': JSON.stringify({ formatVersion: 1, name: 'BadRuntime', runtime: 'wordpress' }),
    });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    const result = await applyImport(
      vfs,
      plan,
      resolutions({ settings: { runtime: 'use-archive' } }),
      entries,
      target
    );

    expect(result.applied.settings).toBe(0);
    expect(result.failed.some((f) => f.message.includes('wordpress'))).toBe(true);
    expect((await vfs.getProject(project.id)).settings.runtime).toBe('static');
  });

  it('refuses an unknown runtime on a project it creates, and says which', async () => {
    const entries = entriesFrom({
      '/project.json': JSON.stringify({ formatVersion: 1, name: 'NewBadRuntime', runtime: 'wordpress' }),
    });
    const target = { kind: 'new-project' as const };
    const plan = await analyzeImport(vfs, entries, target);
    const result = await applyImport(vfs, plan, resolutions(), entries, target);

    expect(result.failed).toContainEqual({
      path: 'project.json',
      message: '"wordpress" is not a runtime this version of OSW Studio has, so the runtime was left unchanged.',
      text: { key: 'unknownRuntime', values: { value: 'wordpress' } },
    });
    expect((await vfs.getProject(result.projectId)).settings.runtime).not.toBe('wordpress');
  });

  // An adapter that cannot hold a kind of record has to say so, not drop the record silently.
  it('reports the kind of record a storage backend cannot hold', async () => {
    const project = await vfs.createProject('NoServerFunctions', 'test');
    const adapter = vfs.getStorageAdapter();
    const limitedAdapter = new Proxy(adapter, {
      get(target, prop) {
        if (prop === 'createServerFunction') return undefined;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const limitedVfs = new Proxy(vfs, {
      get(target, prop) {
        if (prop === 'getStorageAdapter') return () => limitedAdapter;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const entries = entriesFrom({ '/.server/server-functions/helper.js': 'return 1;' });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    const result = await applyImport(limitedVfs, plan, resolutions(), entries, target);

    expect(result.applied.backend).toBe(0);
    expect(result.failed).toEqual([{
      path: '/.server/server-functions/helper.js',
      message: 'This storage backend cannot store server functions.',
      text: { key: 'cannotStore', values: { what: 'server' } },
    }]);
  });

  it('creates a project from the manifest and takes no checkpoint', async () => {
    const entries = entriesFrom({
      '/project.json': JSON.stringify({
        formatVersion: 1,
        name: 'From Archive',
        description: 'made elsewhere',
        runtime: 'static',
        entryPoint: '/home.html',
      }),
      '/home.html': '<h1>hi</h1>',
    });
    const target = { kind: 'new-project' as const };
    const plan = await analyzeImport(vfs, entries, target);
    const result = await applyImport(vfs, plan, resolutions(), entries, target);

    expect(result.checkpointId).toBeUndefined();
    expect(result.failed).toEqual([]);
    const created = await vfs.getProject(result.projectId);
    expect(created.name).toBe('From Archive');
    expect(created.description).toBe('made elsewhere');
    expect(created.settings.runtime).toBe('static');
    expect(created.settings.previewEntryPoint).toBe('/home.html');
    expect((await fileMap(result.projectId)).get('/home.html')).toBe('<h1>hi</h1>');
  });

  it('resolves a scheduled function against an edge function created in the same import', async () => {
    const project = await vfs.createProject('Order', 'test');

    const { result } = await run(project.id, {
      '/.server/edge-functions/send-email.js': 'Response.json({ ok: true });',
      '/.server/scheduled.json': JSON.stringify([
        {
          name: 'nightly',
          functionName: 'send-email',
          cronExpression: '0 3 * * *',
          timezone: 'UTC',
          enabled: true,
          config: {},
        },
      ]),
    });

    expect(result.failed).toEqual([]);
    const adapter = vfs.getStorageAdapter();
    const edge = (await adapter.listEdgeFunctions!(project.id))[0];
    const sched = (await adapter.listScheduledFunctions!(project.id))[0];
    expect(edge.name).toBe('send-email');
    expect(sched.functionId).toBe(edge.id);
    expect(result.applied.backend).toBe(2);
  });

  it('writes backend records through the adapter, not the /.server/ mount', async () => {
    delete process.env.NEXT_PUBLIC_SERVER_MODE;
    const project = await vfs.createProject('NoMount', 'test');

    const { result } = await run(project.id, {
      '/.server/edge-functions/send-email.js': 'Response.json({ ok: true });',
      '/.server/edge-functions/send-email.json': JSON.stringify({
        name: 'send-email',
        method: 'POST',
        enabled: true,
        timeoutMs: 5000,
      }),
    });

    // A mount-based write throws "No project server context mounted." outside Server Mode.
    expect(result.failed).toEqual([]);
    const adapter = vfs.getStorageAdapter();
    const edge = await adapter.listEdgeFunctions!(project.id);
    expect(edge.map((fn) => [fn.name, fn.method])).toEqual([['send-email', 'POST']]);
    // Nothing was stored as a file under /.server/ either.
    const paths = [...(await fileMap(project.id)).keys()];
    expect(paths.some((p) => p.startsWith('/.server/'))).toBe(false);
  });

  it('leaves an existing secret untouched, value and description alike', async () => {
    const project = await vfs.createProject('Secrets', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createSecret!({
      id: `secret-${project.id}`,
      projectId: project.id,
      name: 'STRIPE_KEY',
      description: 'old',
      hasValue: true,
      value: 'sk_live_keepme',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { plan, result } = await run(
      project.id,
      {
        '/.server/secrets.json': JSON.stringify([
          { name: 'STRIPE_KEY', description: 'new description' },
          { name: 'SENDGRID_KEY' },
        ]),
      },
      {}
    );

    expect(plan.backend.secretsMetadataChanged).toEqual(['STRIPE_KEY']);
    expect(plan.backend.secretsAdded).toEqual(['SENDGRID_KEY']);
    expect(result.failed).toEqual([]);
    const after = await adapter.listSecrets!(project.id);
    const stripe = after.find((s) => s.name === 'STRIPE_KEY')!;
    expect(stripe.value).toBe('sk_live_keepme');
    expect(stripe.hasValue).toBe(true);
    // The archive's description is reported in the preview and never applied: a secret is only
    // ever created, never updated, so nothing an archive carries can overwrite one.
    expect(stripe.description).toBe('old');
    const sendgrid = after.find((s) => s.name === 'SENDGRID_KEY')!;
    expect(sendgrid.hasValue).toBe(false);
    expect(sendgrid.value).toBeUndefined();
  });

  it('does not report a secret as failed when only its hand-added value was dropped', async () => {
    const project = await vfs.createProject('SecretValueDropped', 'test');

    const { result } = await run(project.id, {
      '/.server/secrets.json': JSON.stringify([{ name: 'API_KEY', value: 'hunter2' }]),
    });

    // The secret imported, so it must not be counted as a failure.
    expect(result.failed).toEqual([]);
    expect(result.applied.backend).toBe(1);
    const stored = (await vfs.getStorageAdapter().listSecrets!(project.id))
      .find((s) => s.name === 'API_KEY')!;
    expect(stored.hasValue).toBe(false);
    expect(stored.value).toBeUndefined();
  });

  it('leaves a secret alone when its metadata change is kept', async () => {
    const project = await vfs.createProject('SecretKeepMine', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createSecret!({
      id: `secret-keep-${project.id}`,
      projectId: project.id,
      name: 'STRIPE_KEY',
      description: 'old',
      hasValue: true,
      value: 'sk_live_keepme',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await run(
      project.id,
      { '/.server/secrets.json': JSON.stringify([{ name: 'STRIPE_KEY', description: 'new' }]) },
      {}
    );

    const stripe = (await adapter.listSecrets!(project.id)).find((s) => s.name === 'STRIPE_KEY')!;
    expect(stripe.description).toBe('old');
    expect(stripe.value).toBe('sk_live_keepme');
  });

  it('continues past a function whose code fails validation', async () => {
    const project = await vfs.createProject('BadCode', 'test');

    const { result } = await run(project.id, {
      // validateEdgeFunctionData syntax-checks with new Function(code), which rejects
      // `export default` — a function created through the UI can export and fail to import.
      '/.server/edge-functions/modern.js': 'export default async () => {}',
      '/good.html': '<h1>fine</h1>',
    });

    expect(result.failed.some((f) => f.path.includes('modern'))).toBe(true);
    expect(result.applied.files).toBe(1);
    expect((await fileMap(project.id)).get('/good.html')).toBe('<h1>fine</h1>');
    const adapter = vfs.getStorageAdapter();
    expect(await adapter.listEdgeFunctions!(project.id)).toEqual([]);
  });

  it('reports an unresolvable scheduled function instead of throwing', async () => {
    const project = await vfs.createProject('Dangling', 'test');

    const { result } = await run(project.id, {
      '/good.html': '<h1>fine</h1>',
      '/.server/scheduled.json': JSON.stringify([
        {
          name: 'nightly',
          functionName: 'not-here',
          cronExpression: '0 3 * * *',
          timezone: 'UTC',
          enabled: true,
          config: {},
        },
      ]),
    });

    expect(result.failed.some((f) => f.message.includes('not-here'))).toBe(true);
    expect(result.applied.files).toBe(1);
    const adapter = vfs.getStorageAdapter();
    expect(await adapter.listScheduledFunctions!(project.id)).toEqual([]);
  });

  it('leaves backend records the archive does not carry', async () => {
    const project = await vfs.createProject('NoReconcile', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(edgeFunction(project.id, { name: 'orphan' }));

    const { result } = await run(project.id, {
      '/.server/edge-functions/newcomer.js': 'Response.json({ ok: true });',
    });

    expect(result.failed).toEqual([]);
    const names = (await adapter.listEdgeFunctions!(project.id)).map((fn) => fn.name).sort();
    expect(names).toEqual(['newcomer', 'orphan']);
  });

  it('replaces a conflicting edge function in place', async () => {
    const project = await vfs.createProject('BackendReplace', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(edgeFunction(project.id, { name: 'send-email', code: 'OLD;' }));

    const { plan, result } = await run(
      project.id,
      { '/.server/edge-functions/send-email.js': 'NEW;' },
      { backend: { [backendResolutionKey('edge', 'send-email')]: 'replace' } }
    );

    expect(plan.backend.conflicts.map((c) => c.name)).toEqual(['send-email']);
    expect(result.failed).toEqual([]);
    const stored = await adapter.listEdgeFunctions!(project.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].code).toBe('NEW;');
    expect(stored[0].id).toBe(`edge-send-email-${project.id}`);
  });

  it('keeps both backend records without touching the original', async () => {
    const project = await vfs.createProject('BackendKeepBoth', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(edgeFunction(project.id, { name: 'send-email', code: 'OLD;' }));

    const { plan, result } = await run(
      project.id,
      { '/.server/edge-functions/send-email.js': 'NEW;' },
      { backend: { [backendResolutionKey('edge', 'send-email')]: 'keep-both' } }
    );

    expect(plan.backend.conflicts[0].keepBothName).toBe('send-email-2');
    expect(result.failed).toEqual([]);
    const stored = (await adapter.listEdgeFunctions!(project.id)).sort((a, b) =>
      a.name < b.name ? -1 : 1
    );
    expect(stored.map((fn) => [fn.name, fn.code])).toEqual([
      ['send-email', 'OLD;'],
      ['send-email-2', 'NEW;'],
    ]);
  });

  it('skips a backend record the project already matches', async () => {
    const project = await vfs.createProject('BackendUnchanged', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(
      edgeFunction(project.id, { name: 'send-email', code: 'SAME;', method: 'ANY' })
    );

    const { plan, result } = await run(project.id, {
      '/.server/edge-functions/send-email.js': 'SAME;',
    });

    expect(plan.backend.unchanged).toEqual([{ kind: 'edge', name: 'send-email' }]);
    expect(result.applied.backend).toBe(0);
    // Not merely "no write landed" — no write was even attempted.
    expect(result.failed).toEqual([]);
    const stored = await adapter.listEdgeFunctions!(project.id);
    expect(stored.map((fn) => fn.id)).toEqual([`edge-send-email-${project.id}`]);
  });

  it('validates the record it is about to write, including a keep-both rename', async () => {
    // The plan reaches apply from the dialog, so its keepBothName is input, not fact. Without
    // apply's own validation an illegal name would land in storage, where nothing can run it.
    const project = await vfs.createProject('BadRename', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(edgeFunction(project.id, { name: 'send-email', code: 'OLD;' }));

    const entries = entriesFrom({ '/.server/edge-functions/send-email.js': 'NEW;' });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    plan.backend.conflicts[0].keepBothName = 'Send Email (2)';

    const result = await applyImport(
      vfs,
      plan,
      resolutions({ backend: { [backendResolutionKey('edge', 'send-email')]: 'keep-both' } }),
      entries,
      target
    );

    expect(result.applied.backend).toBe(0);
    expect(result.failed.some((f) => f.message.includes('Send Email (2)'))).toBe(true);
    // The dialog words the failure from `text`, so the reason has to travel there too.
    const rejected = result.failed.find((f) => f.text?.key === 'invalidRecord');
    expect(rejected?.text?.values).toMatchObject({ kind: 'edge', name: 'Send Email (2)' });
    expect(String(rejected?.text?.values?.detail ?? '')).not.toBe('');
    const stored = await adapter.listEdgeFunctions!(project.id);
    expect(stored.map((fn) => [fn.name, fn.code])).toEqual([['send-email', 'OLD;']]);
  });

  it('reports a replace whose record vanished rather than creating a second one', async () => {
    const project = await vfs.createProject('VanishedRecord', 'test');
    const adapter = vfs.getStorageAdapter();
    const existing = edgeFunction(project.id, { name: 'send-email', code: 'OLD;' });
    await adapter.createEdgeFunction!(existing);

    const entries = entriesFrom({ '/.server/edge-functions/send-email.js': 'NEW;' });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    // Deleted between preview and confirm.
    await adapter.deleteEdgeFunction!(existing.id);

    const result = await applyImport(
      vfs,
      plan,
      resolutions({ backend: { [backendResolutionKey('edge', 'send-email')]: 'replace' } }),
      entries,
      target
    );

    expect(result.applied.backend).toBe(0);
    // Apply's own check, not whatever the adapter happens to do with a record it cannot find.
    expect(result.failed).toEqual([
      {
        path: '/.server/edge-functions/send-email.js',
        message: '"send-email" is no longer in this project, so there was nothing to replace.',
        text: { key: 'nothingToReplace', values: { name: 'send-email' } },
      },
    ]);
    expect(await adapter.listEdgeFunctions!(project.id)).toEqual([]);
  });

  it('leaves a conflicting backend record alone when no resolution was recorded', async () => {
    const project = await vfs.createProject('BackendKeepMine', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(edgeFunction(project.id, { name: 'send-email', code: 'OLD;' }));

    const { result } = await run(project.id, { '/.server/edge-functions/send-email.js': 'NEW;' });

    expect(result.applied.backend).toBe(0);
    const stored = await adapter.listEdgeFunctions!(project.id);
    expect(stored.map((fn) => fn.code)).toEqual(['OLD;']);
  });

  it('writes nothing the plan does not list', async () => {
    const project = await vfs.createProject('Blocked', 'test');
    const entries: ArchiveEntry[] = [
      ...entriesFrom({ '/fine.html': 'ok' }),
      {
        path: '/huge.txt',
        read: async () => new ArrayBuffer(8),
        declaredSize: FILE_SIZE_LIMITS.text + 1,
      },
    ];
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    expect(plan.errors.some((e) => e.code === 'too-large')).toBe(true);

    const result = await applyImport(vfs, plan, resolutions(), entries, target);

    expect(result.applied.files).toBe(1);
    const files = await fileMap(project.id);
    expect(files.has('/huge.txt')).toBe(false);
    expect(files.get('/fine.html')).toBe('ok');
  });

  it('re-importing a plan the project already satisfies writes nothing', async () => {
    const project = await vfs.createProject('Idempotent', 'test');
    await vfs.createFile(project.id, '/index.html', 'SAME');

    const { plan, result } = await run(project.id, { '/index.html': 'SAME' });

    expect(plan.files.unchanged).toEqual(['/index.html']);
    expect(result.applied.files).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('marks an existing project dirty so the import can be discarded', async () => {
    const project = await vfs.createProject('Dirty', 'test');
    saveManager.markClean(project.id);

    await run(project.id, { '/added.html': 'x' });

    expect(saveManager.isDirty(project.id)).toBe(true);
  });

  it('reports progress up to the number of items it was going to do', async () => {
    const project = await vfs.createProject('Progress', 'test');
    const entries = entriesFrom({
      '/a.html': 'a',
      '/b.html': 'b',
      '/.server/edge-functions/send-email.js': 'Response.json({ ok: true });',
    });
    const target = { kind: 'existing-project' as const, projectId: project.id };
    const plan = await analyzeImport(vfs, entries, target);
    const seen: Array<[number, number]> = [];
    await applyImport(vfs, plan, resolutions(), entries, target, (done, total) =>
      seen.push([done, total])
    );

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  // --- Cross-boundary fixes ---

  it('never writes an entry from a transient namespace into storage', async () => {
    // createFile intercepts /.server/ but not /.skills/, so such an entry lands in the adapter as
    // an ordinary file — and readFile then short-circuits on the prefix and throws
    // "Transient file not found" for a file the explorer displays. Permanently, and it survives
    // into every later export.
    const project = await vfs.createProject('SkillsPoison', 'test');

    const { plan, result } = await run(project.id, {
      '/.skills/thing.md': '# poison',
      '/index.html': 'ok',
    });

    expect(plan.files.added).toEqual(['/index.html']);
    expect(result.applied.files).toBe(1);
    expect(result.failed).toEqual([]);
    const paths = [...(await fileMap(project.id)).keys()];
    expect(paths.some((path) => path.startsWith('/.skills/'))).toBe(false);
    // The concrete symptom: had it been written, this would throw rather than report absence.
    await expect(vfs.readFile(project.id, '/.skills/thing.md')).rejects.toThrow(
      /Transient file not found/
    );
    expect(await vfs.fileExists(project.id, '/.skills/thing.md')).toBe(false);
  });

  it('links a kept-both schedule to the renamed function, not the project original', async () => {
    // Keep-both stores the archive's send-email as send-email-2 and leaves the project's own
    // alone. Resolving the schedule by the ARCHIVE's name against a map rebuilt from the adapter
    // returns the project's pre-existing function, so the imported cron silently drives the
    // user's old code.
    const project = await vfs.createProject('KeepBothSchedule', 'test');
    const adapter = vfs.getStorageAdapter();
    await adapter.createEdgeFunction!(edgeFunction(project.id, { name: 'send-email', code: 'OLD;' }));

    const { plan, result } = await run(
      project.id,
      {
        '/.server/edge-functions/send-email.js': 'NEW;',
        '/.server/scheduled.json': JSON.stringify([
          {
            name: 'nightly',
            functionName: 'send-email',
            cronExpression: '0 3 * * *',
            timezone: 'UTC',
            enabled: true,
            config: {},
          },
        ]),
      },
      { backend: { [backendResolutionKey('edge', 'send-email')]: 'keep-both' } }
    );

    expect(plan.backend.conflicts[0].keepBothName).toBe('send-email-2');
    expect(result.failed).toEqual([]);

    const stored = await adapter.listEdgeFunctions!(project.id);
    const original = stored.find((fn) => fn.name === 'send-email')!;
    const renamed = stored.find((fn) => fn.name === 'send-email-2')!;
    expect(original.code).toBe('OLD;');
    expect(renamed.code).toBe('NEW;');

    const schedule = (await adapter.listScheduledFunctions!(project.id))[0];
    expect(schedule.functionId).toBe(renamed.id);
    expect(schedule.functionId).not.toBe(original.id);
  });

  it('links a kept-mine schedule to the project function of that name', async () => {
    // The other half of the same resolution: nothing was renamed, so the archive's name is the
    // project's name and the schedule must attach to the function that is already there.
    const project = await vfs.createProject('KeepMineSchedule', 'test');
    const adapter = vfs.getStorageAdapter();
    const existing = edgeFunction(project.id, { name: 'send-email', code: 'OLD;' });
    await adapter.createEdgeFunction!(existing);

    const { result } = await run(project.id, {
      '/.server/edge-functions/send-email.js': 'NEW;',
      '/.server/scheduled.json': JSON.stringify([
        {
          name: 'nightly',
          functionName: 'send-email',
          cronExpression: '0 3 * * *',
          timezone: 'UTC',
          enabled: true,
          config: {},
        },
      ]),
    });

    expect(result.failed).toEqual([]);
    const stored = await adapter.listEdgeFunctions!(project.id);
    expect(stored.map((fn) => [fn.name, fn.code])).toEqual([['send-email', 'OLD;']]);
    const schedule = (await adapter.listScheduledFunctions!(project.id))[0];
    expect(schedule.functionId).toBe(existing.id);
  });

  it('imports one record when the archive names two the same, and reports the loser', async () => {
    // Both records used to reach apply: the duplicate landed in added AND conflicts, backendAction
    // checks added first, and the second create failed on the adapter's uniqueness constraint —
    // whose raw message went to the UI verbatim.
    const project = await vfs.createProject('DuplicateApply', 'test');

    const { plan, result } = await run(project.id, {
      '/.server/edge-functions/a.js': 'FIRST;',
      '/.server/edge-functions/a.json': JSON.stringify({ name: 'send-email', method: 'POST' }),
      '/.server/edge-functions/b.js': 'SECOND;',
      '/.server/edge-functions/b.json': JSON.stringify({ name: 'send-email', method: 'GET' }),
    });

    expect(plan.backend.conflicts).toEqual([]);
    expect(result.applied.backend).toBe(1);
    // The refusal is the analyzer's, reported before the import; apply attempts no second write.
    expect(result.failed.every((f) => !/constraint|uniqueness|ConstraintError/i.test(f.message))).toBe(true);
    const stored = await vfs.getStorageAdapter().listEdgeFunctions!(project.id);
    expect(stored.map((fn) => [fn.name, fn.code])).toEqual([['send-email', 'FIRST;']]);
  });
});
