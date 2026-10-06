import { describe, it, expect } from 'vitest';
import { backendToArchiveFiles, archiveFilesToBackend, keepBothBackendName } from '../backend-files';
import { validateSecretData } from '../../server-context/generators';
import type { ArchiveIssue } from '../types';

const edge = {
  id: 'e1', projectId: 'p1', name: 'send-email', method: 'POST' as const,
  code: 'export default async () => new Response("ok")',
  description: 'Sends mail', enabled: true, timeoutMs: 8000,
  createdAt: new Date(), updatedAt: new Date(),
};

describe('backendToArchiveFiles', () => {
  it('writes code as a real .js file and metadata beside it', () => {
    const files = backendToArchiveFiles({ edgeFunctions: [edge] } as any);
    const js = files.find(f => f.path === '/.server/edge-functions/send-email.js');
    const meta = files.find(f => f.path === '/.server/edge-functions/send-email.json');
    expect(js!.content).toBe(edge.code);
    expect(JSON.parse(meta!.content)).toEqual({
      name: 'send-email', method: 'POST', description: 'Sends mail', enabled: true, timeoutMs: 8000,
    });
  });

  it('never writes a secret value', () => {
    const secrets = [{ name: 'STRIPE_KEY', description: 'live key', value: 'sk_live_x', hasValue: true }];
    const files = backendToArchiveFiles({ secrets } as any);
    const secretsFile = files.find(f => f.path === '/.server/secrets.json')!;
    expect(secretsFile.content).not.toContain('sk_live_x');
    expect(JSON.parse(secretsFile.content)).toEqual([{ name: 'STRIPE_KEY', description: 'live key' }]);
  });

  it('stores a scheduled function by edge function NAME, not id', () => {
    const scheduled = [{
      name: 'nightly', functionId: 'e1', cronExpression: '0 3 * * *',
      timezone: 'UTC', enabled: true, config: {},
    }];
    const files = backendToArchiveFiles({ edgeFunctions: [edge], scheduledFunctions: scheduled } as any);
    const parsed = JSON.parse(files.find(f => f.path === '/.server/scheduled.json')!.content);
    expect(parsed[0].functionName).toBe('send-email');
    expect(parsed[0].functionId).toBeUndefined();
  });

  it('emits nothing when the project has no backend features', () => {
    expect(backendToArchiveFiles({} as any)).toEqual([]);
  });

  it('sorts config keys, deeply, so identical schedule state is byte-identical', () => {
    const emit = (config: Record<string, unknown>) => backendToArchiveFiles({
      edgeFunctions: [edge],
      scheduledFunctions: [{
        name: 'nightly', functionId: 'e1', cronExpression: '0 3 * * *',
        timezone: 'UTC', enabled: true, config,
      }],
    } as any).find(f => f.path === '/.server/scheduled.json')!.content;
    expect(emit({ z: 1, a: { y: 2, b: 3 } })).toBe(emit({ a: { b: 3, y: 2 }, z: 1 }));
  });

  it('leaves arrays inside config in their original order', () => {
    const files = backendToArchiveFiles({
      edgeFunctions: [edge],
      scheduledFunctions: [{
        name: 'nightly', functionId: 'e1', cronExpression: '0 3 * * *',
        timezone: 'UTC', enabled: true, config: { steps: ['b', 'a'] },
      }],
    } as any);
    const parsed = JSON.parse(files.find(f => f.path === '/.server/scheduled.json')!.content);
    expect(parsed[0].config.steps).toEqual(['b', 'a']);
  });

  it('warns and omits the file when a schedule points at an edge function that is gone', () => {
    const warnings: ArchiveIssue[] = [];
    const files = backendToArchiveFiles({
      edgeFunctions: [edge],
      scheduledFunctions: [{
        name: 'nightly', functionId: 'gone', cronExpression: '0 3 * * *',
        timezone: 'UTC', enabled: true, config: {},
      }],
    } as any, warnings);
    expect(files.some(f => f.path === '/.server/scheduled.json')).toBe(false);
    expect(warnings).toEqual([expect.objectContaining({ code: 'unresolved-reference' })]);
  });

  it('refuses a name that would write outside its folder', () => {
    const warnings: ArchiveIssue[] = [];
    const files = backendToArchiveFiles({ edgeFunctions: [{ ...edge, name: 'a/b' }] } as any, warnings);
    expect(files).toEqual([]);
    expect(warnings[0]).toMatchObject({ code: 'path-rejected' });
  });

  it('sorts by name so output is deterministic', () => {
    const a = { ...edge, name: 'a-fn' };
    const b = { ...edge, name: 'b-fn' };
    const one = backendToArchiveFiles({ edgeFunctions: [b, a] } as any).map(f => f.path);
    const two = backendToArchiveFiles({ edgeFunctions: [a, b] } as any).map(f => f.path);
    expect(one).toEqual(two);
  });
});

describe('archiveFilesToBackend', () => {
  it('parses a pair into a feature record ready for the adapter', () => {
    const entries = new Map<string, string>([
      ['/.server/edge-functions/send-email.js', 'async () => {}'],
      ['/.server/edge-functions/send-email.json', JSON.stringify({ name: 'send-email', method: 'POST' })],
    ]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(issues).toEqual([]);
    expect(features.edgeFunctions).toEqual([
      { name: 'send-email', method: 'POST', code: 'async () => {}', enabled: true, timeoutMs: 5000 },
    ]);
  });

  it('defaults method, enabled and timeout when there is no sidecar', () => {
    // validateEdgeFunctionData REQUIRES method (generators.ts:189), so the importer
    // must supply it rather than relying on the validator to default it.
    const entries = new Map([['/.server/edge-functions/solo.js', 'async () => {}']]);
    const { features } = archiveFilesToBackend(entries);
    expect(features.edgeFunctions![0]).toMatchObject({
      name: 'solo', method: 'ANY', enabled: true, timeoutMs: 5000,
    });
  });

  it('reports a record that fails the real validator', () => {
    // Bypassing the /.server/ mount means bypassing its validation — so call the
    // exported validators ourselves. 'Bad Name' violates the edge-function grammar.
    const entries = new Map([['/.server/edge-functions/Bad Name.js', 'async () => {}']]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.edgeFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'validation-failed' });
  });

  it.each([
    ['a string where a boolean belongs', { name: 'x', method: 'POST', enabled: 'false' }],
    ['a number where a method belongs', { name: 'x', method: 123 }],
    ['a number where a name belongs', { name: 7, method: 'POST' }],
  ])('lets the validator see %s instead of coercing it to a default', (_label, sidecar) => {
    // Defaulting a present-but-malformed value hides it: "enabled": "false" would arrive as
    // enabled: true, publishing a route the archive says is off.
    const entries = new Map([
      ['/.server/edge-functions/x.js', 'async () => {}'],
      ['/.server/edge-functions/x.json', JSON.stringify(sidecar)],
    ]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.edgeFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'validation-failed' });
  });

  it.each([
    ['enabled', { name: 'nightly', functionName: 'send-email', cronExpression: '0 3 * * *', enabled: 0 }],
    ['timezone', { name: 'nightly', functionName: 'send-email', cronExpression: '0 3 * * *', timezone: 42 }],
  ])('rejects a scheduled function with a malformed %s rather than arming it', (_label, entry) => {
    const entries = new Map([['/.server/scheduled.json', JSON.stringify([entry])]]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.scheduledFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'validation-failed' });
  });

  it('rejects a server function whose name is not a JS identifier', () => {
    const entries = new Map([['/.server/server-functions/Bad Name.js', 'return 1;']]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.serverFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'validation-failed' });
  });

  it('rejects a secret whose name is not SCREAMING_SNAKE_CASE', () => {
    const entries = new Map([['/.server/secrets.json', JSON.stringify([{ name: 'stripe_key' }])]]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.secrets ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'validation-failed' });
  });

  it('rejects a schedule whose cron expression does not parse', () => {
    const entries = new Map([['/.server/scheduled.json', JSON.stringify([
      { name: 'nightly', functionName: 'send-email', cronExpression: 'NOT A CRON' },
    ])]]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.scheduledFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'validation-failed' });
  });

  it('reports a list entry that is not an object', () => {
    const entries = new Map([['/.server/secrets.json', JSON.stringify(['STRIPE_KEY'])]]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.secrets ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'invalid-json' });
  });

  it('warns about a secret value in the archive and imports the name without it', () => {
    const entries = new Map([['/.server/secrets.json', JSON.stringify([
      { name: 'STRIPE_KEY', value: 'sk_live_x' },
    ])]]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.secrets).toEqual([{ name: 'STRIPE_KEY' }]);
    expect(issues[0]).toMatchObject({ code: 'unsupported-field' });
    expect(JSON.stringify(features)).not.toContain('sk_live_x');
  });

  it('reports a nested path under a feature folder instead of dropping it in silence', () => {
    const entries = new Map([['/.server/edge-functions/a/b.js', 'async () => {}']]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.edgeFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'path-rejected' });
  });

  it('reports a sidecar with no code file instead of silently dropping it', () => {
    const entries = new Map([['/.server/edge-functions/ghost.json', '{"name":"ghost"}']]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features.edgeFunctions ?? []).toEqual([]);
    expect(issues[0]).toMatchObject({ code: 'missing-code' });
  });

  it('reports malformed sidecar JSON', () => {
    const entries = new Map([
      ['/.server/edge-functions/bad.js', 'code'],
      ['/.server/edge-functions/bad.json', '{oops'],
    ]);
    const { issues } = archiveFilesToBackend(entries);
    expect(issues[0]).toMatchObject({ code: 'invalid-json' });
  });

  it('ignores README.md and other prose in the folder', () => {
    const entries = new Map([['/.server/README.md', '# how this works']]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(features).toEqual({});
    expect(issues).toEqual([]);
  });

  it('parses secrets and scheduled list files', () => {
    const entries = new Map([
      ['/.server/secrets.json', JSON.stringify([{ name: 'STRIPE_KEY', description: 'live key' }])],
      ['/.server/scheduled.json', JSON.stringify([
        { name: 'nightly', functionName: 'send-email', cronExpression: '0 3 * * *', timezone: 'UTC' },
      ])],
    ]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(issues).toEqual([]);
    expect(features.secrets).toEqual([{ name: 'STRIPE_KEY', description: 'live key' }]);
    expect(features.scheduledFunctions![0]).toMatchObject({
      name: 'nightly', functionName: 'send-email', cronExpression: '0 3 * * *', enabled: true,
    });
  });

  it('parses a server function pair', () => {
    const entries = new Map([
      ['/.server/server-functions/formatPrice.js', 'return args.cents / 100;'],
      ['/.server/server-functions/formatPrice.json', JSON.stringify({ name: 'formatPrice', enabled: false })],
    ]);
    const { features, issues } = archiveFilesToBackend(entries);
    expect(issues).toEqual([]);
    expect(features.serverFunctions).toEqual([
      { name: 'formatPrice', code: 'return args.cents / 100;', enabled: false },
    ]);
  });

  it('round-trips what backendToArchiveFiles produced', () => {
    // Real edge function code is a statement body — the executor wraps it in an async IIFE
    // (edge-functions/executor.ts:806). `export default …` would fail validateEdgeFunctionData's
    // `new Function(code)` check, on import here exactly as it does through the /.server/ mount.
    const stored = { ...edge, code: 'Response.json({ ok: true }, 200);' };
    const files = backendToArchiveFiles({
      edgeFunctions: [stored],
      secrets: [{ name: 'STRIPE_KEY', description: 'live key', value: 'sk_live_x' }],
      scheduledFunctions: [{
        name: 'nightly', functionId: 'e1', cronExpression: '0 3 * * *',
        timezone: 'UTC', enabled: true, config: {},
      }],
    } as any);
    const { features, issues } = archiveFilesToBackend(new Map(files.map(f => [f.path, f.content])));
    expect(issues).toEqual([]);
    expect(features.edgeFunctions).toEqual([{
      name: 'send-email', method: 'POST', description: 'Sends mail',
      enabled: true, timeoutMs: 8000, code: stored.code,
    }]);
    expect(features.secrets).toEqual([{ name: 'STRIPE_KEY', description: 'live key' }]);
    expect(features.scheduledFunctions![0].functionName).toBe('send-email');
  });
});

describe('keepBothBackendName', () => {
  // Each kind has its own name grammar, so one suffix convention cannot serve all three.
  it.each([
    ['edge', 'send-email', 'send-email-2'],       // ^[a-z0-9][a-z0-9-]*[a-z0-9]$
    ['server', 'formatPrice', 'formatPrice2'],    // ^[a-zA-Z_][a-zA-Z0-9_]*$
    ['secret', 'STRIPE_KEY', 'STRIPE_KEY_2'],     // ^[A-Z][A-Z0-9_]*$
    ['scheduled', 'nightly-job', 'nightly-job-2'], // same grammar as edge
  ])('suffixes a %s name legally', (kind, input, expected) => {
    expect(keepBothBackendName(kind as any, input, new Set([input]))).toBe(expected);
  });

  it('produces a name its own validator accepts', () => {
    const name = keepBothBackendName('secret', 'STRIPE_KEY', new Set(['STRIPE_KEY']));
    expect(validateSecretData({ name }).valid).toBe(true);
  });

  it('trims a secret name that has no room left for the suffix', () => {
    // validateSecretData caps names at 64 characters; the suffix has to fit inside that.
    const long = 'A'.repeat(64);
    const out = keepBothBackendName('secret', long, new Set([long]));
    expect(out.length).toBe(64);
    expect(validateSecretData({ name: out }).valid).toBe(true);
  });

  it('skips numbers already in use and reserves what it hands out', () => {
    const taken = new Set(['send-email', 'send-email-2']);
    expect(keepBothBackendName('edge', 'send-email', taken)).toBe('send-email-3');
    expect(keepBothBackendName('edge', 'send-email', taken)).toBe('send-email-4');
  });
});

describe('archiveFilesToBackend duplicate names', () => {
  // A name is the only identity an archive carries, so a kind may hold each name once. Two records
  // of one name cannot both be classified or both be stored — the analyzer would sort one (kind,
  // name) into two buckets and the adapter would refuse the second write.
  it('keeps the first edge function of a name and reports the rest', () => {
    const { features, issues } = archiveFilesToBackend(new Map([
      ['/.server/edge-functions/a.js', 'FIRST;'],
      ['/.server/edge-functions/a.json', JSON.stringify({ name: 'send-email', method: 'POST' })],
      ['/.server/edge-functions/b.js', 'SECOND;'],
      ['/.server/edge-functions/b.json', JSON.stringify({ name: 'send-email', method: 'GET' })],
    ]));

    expect(features.edgeFunctions).toHaveLength(1);
    expect(features.edgeFunctions![0].code).toBe('FIRST;');
    const duplicate = issues.find(i => i.message.includes('more than one edge function named'))!;
    expect(duplicate).toBeDefined();
    expect(duplicate.path).toBe('/.server/edge-functions/b.js');
  });

  it('deduplicates secrets and scheduled functions listed twice', () => {
    const { features, issues } = archiveFilesToBackend(new Map([
      ['/.server/edge-functions/send-email.js', 'CODE;'],
      ['/.server/secrets.json', JSON.stringify([
        { name: 'API_KEY', description: 'first' },
        { name: 'API_KEY', description: 'second' },
      ])],
      ['/.server/scheduled.json', JSON.stringify([
        { name: 'nightly', functionName: 'send-email', cronExpression: '0 3 * * *' },
        { name: 'nightly', functionName: 'send-email', cronExpression: '0 9 * * *' },
      ])],
    ]));

    expect(features.secrets!.map(s => s.description)).toEqual(['first']);
    expect(features.scheduledFunctions!.map(j => j.cronExpression)).toEqual(['0 3 * * *']);
    expect(issues.filter(i => i.message.includes('more than one')).length).toBe(2);
  });

  it('lets an edge function and a scheduled function share a name', () => {
    // Separate sets per kind: the two share one name grammar, and 'nightly' as both is ordinary.
    const { features, issues } = archiveFilesToBackend(new Map([
      ['/.server/edge-functions/nightly.js', 'CODE;'],
      ['/.server/scheduled.json', JSON.stringify([
        { name: 'nightly', functionName: 'nightly', cronExpression: '0 3 * * *' },
      ])],
    ]));

    expect(features.edgeFunctions).toHaveLength(1);
    expect(features.scheduledFunctions).toHaveLength(1);
    expect(issues.filter(i => i.message.includes('more than one'))).toEqual([]);
  });
});


// The dialog words each issue from `text`; the kind decides whether it says "Edge function",
// "Server function", "Secret" or "Scheduled function", so the right one has to reach it.
describe('backend issue text', () => {
  const textOf = (issues: ArchiveIssue[], key: string) => issues.find(i => i.text?.key === key)?.text;

  it('names the kind and record an export leaves out or leaves empty', () => {
    const warnings: ArchiveIssue[] = [];
    backendToArchiveFiles({
      edgeFunctions: [{ ...edge, name: 'blank', code: '' }],
      serverFunctions: [{ id: 's1', projectId: 'p1', name: 'a/b', code: 'return 1;', enabled: true, createdAt: new Date(), updatedAt: new Date() }],
    } as any, warnings);
    expect(textOf(warnings, 'emptyCode')).toEqual({ key: 'emptyCode', values: { kind: 'edge', name: 'blank' } });
    expect(textOf(warnings, 'unusableName')).toEqual({ key: 'unusableName', values: { kind: 'server', name: 'a/b' } });
  });

  it('names the kind and place of what an import refuses', () => {
    const { issues } = archiveFilesToBackend(new Map([
      ['/.server/server-functions/deep/x.js', 'return 1;'],
      ['/.server/edge-functions/a.js', 'Response.json({});'],
      ['/.server/edge-functions/a.json', '{oops'],
      ['/.server/secrets.json', JSON.stringify([{ name: 'KEY' }, 5, { name: 'KEY' }])],
      ['/.server/scheduled.json', JSON.stringify([{ name: 'nightly', functionName: 'x', cronExpression: 'nope', timezone: 'UTC' }])],
    ]));

    expect(textOf(issues, 'nestedBackendFile')).toEqual({
      key: 'nestedBackendFile',
      values: { kind: 'server', dir: '/.server/server-functions/', path: '/.server/server-functions/deep/x.js' },
    });
    expect(textOf(issues, 'sidecarNotJson')).toEqual({ key: 'sidecarNotJson', values: { path: '/.server/edge-functions/a.json', name: 'a' } });
    expect(textOf(issues, 'entryNotObject')).toEqual({ key: 'entryNotObject', values: { index: 2, path: '/.server/secrets.json' } });
    expect(textOf(issues, 'duplicateName')).toEqual({ key: 'duplicateName', values: { kind: 'secret', name: 'KEY' } });
    expect(textOf(issues, 'invalidRecord')?.values).toMatchObject({ kind: 'scheduled', name: 'nightly' });
  });
});
