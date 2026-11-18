import { describe, it, expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import type { VirtualFileSystem } from '@/lib/vfs';
import type { ShellContext, ShellResult } from '@/lib/vfs/shell/types';

vi.mock('@/lib/vfs', () => ({ getActiveVFS: () => ({}), vfs: {} }));
vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { rgCommand } from '@/lib/vfs/shell/commands/rg';
import { grepCommand } from '@/lib/vfs/shell/commands/grep';
import { workerLineMatcher } from '../search-worker';

/**
 * `rg` and `grep` on the server, where the shell runs in the process that serves every workspace:
 * the matching goes to a worker with a time limit, so a pattern that backtracks without end costs
 * one search an error instead of stalling the instance. The worker must print what the same search
 * prints in this thread, byte for byte.
 */

/** A CSS banner: `(=+)+$` tries every split of its run of `=` before failing, doubling per `=`. */
const BANNER = `/* ${'='.repeat(27)} */`;

const FILES: Record<string, string> = {
  '/styles.css': [BANNER, ':root { --accent: #f00; }', '.btn { color: var(--accent); }', '.card { padding: 1rem; }', ''].join('\n'),
  '/index.html': ['<h1 class="title">Hello</h1>', '<p class="lead">Lead text</p>', '<a class="btn" href="#">Buy</a>', '<p>Second paragraph</p>'].join('\n'),
  '/scripts/app.js': ['const a = 1; // TODO tidy', 'function go() { return a; }', 'const b = "btn btn-primary";', '// TODO more', 'go();', ''].join('\n'),
  '/notes.md': ['# Notes', '', 'TODO: write', 'done', 'todo lower', 'Done again'].join('\n'),
};

const vfs = {
  getAllFilesAndDirectories: async () => [
    ...Object.entries(FILES).map(([path, content]) => ({ type: 'file' as const, path, content })),
    { type: 'directory' as const, path: '/scripts', content: undefined },
  ],
} as unknown as VirtualFileSystem;

const run = (command: 'rg' | 'grep', args: string[], ctx?: ShellContext, stdin?: string): Promise<ShellResult> =>
  (command === 'rg' ? rgCommand : grepCommand)({ vfs, projectId: 'p1', args, ctx, stdin });

describe('a search on the server', () => {
  it('answers a pattern that runs past the time limit with an error, and stops it', async () => {
    const ctx = { matchLines: workerLineMatcher(250) };
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      for (const command of ['rg', 'grep'] as const) {
        terminate.mockClear();
        const started = performance.now();
        const result = await run(command, command === 'rg' ? ['(=+)+$', '/'] : ['-E', '(=+)+$', '/'], ctx);
        expect(performance.now() - started, command).toBeLessThan(2_000);
        expect(result.exitCode, command).toBe(2);
        expect(result.stdout, command).toBe('');
        expect(result.stderr, command).toMatch(new RegExp(`^${command}: the pattern took too long`));
        expect(result.stderr, command).toContain('-F');
        // The worker still backtracking is stopped, not left running.
        expect(terminate, command).toHaveBeenCalledTimes(1);
      }
    } finally {
      terminate.mockRestore();
    }
  });

  it('prints what the same search prints in this thread', async () => {
    const ctx = { matchLines: workerLineMatcher() };
    const searches: { command: 'rg' | 'grep'; args: string[]; stdin?: string }[] = [
      { command: 'rg', args: ['btn', '/'] },
      { command: 'rg', args: ['-i', 'todo'] },
      { command: 'rg', args: ['-o', 'btn[-a-z]*', '/'] },
      { command: 'rg', args: ['-v', 'TODO', '/scripts/app.js'] },
      { command: 'rg', args: ['-c', 'p', '/'] },
      { command: 'rg', args: ['-l', 'TODO', '/'] },
      { command: 'rg', args: ['-C', '1', 'TODO', '/scripts', '/notes.md'] },
      { command: 'rg', args: ['-m', '1', '-A', '2', 'p', '/index.html', '/styles.css'] },
      { command: 'rg', args: ['-m', '1', 'TODO', '/scripts/app.js'] },
      { command: 'rg', args: ['-w', '-e', 'a', '-e', 'go', '/scripts/app.js'] },
      { command: 'rg', args: ['-w', '-e', '--accent', '/styles.css'] },
      { command: 'grep', args: ['-o', '\\<btn\\>', '/index.html', '/scripts/app.js'] },
      { command: 'rg', args: ['-o', 'x*', '/notes.md'] },
      { command: 'rg', args: ['-v', 'MATCH'], stdin: 'a\nMATCH\nb\n' },
      { command: 'grep', args: ['-n', 'class="[a-z]*"', '/index.html'] },
      { command: 'grep', args: ['-o', '-i', 'todo', '/'] },
      { command: 'grep', args: ['-vc', 'TODO', '/'] },
      { command: 'grep', args: ['-l', '-F', 'var(--accent)', '/'] },
      { command: 'grep', args: ['-B', '1', 'Done', '/notes.md'] },
      { command: 'grep', args: ['-c', '^', '/styles.css'] },
      { command: 'grep', args: ['TODO\\|done', '/notes.md', '/scripts/app.js'] },
      { command: 'grep', args: ['-o', 'l[a-z]'], stdin: 'hello\nworld\nlily' },
      { command: 'grep', args: ['-c', 'nothing', '/notes.md'] },
    ];
    for (const { command, args, stdin } of searches) {
      const here = await run(command, args, undefined, stdin);
      const there = await run(command, args, ctx, stdin);
      expect(there, `${command} ${args.join(' ')}`).toEqual(here);
    }
    // The sample is only worth comparing if it prints something, and if its flags change what is printed.
    expect((await run('rg', ['-C', '1', 'TODO', '/scripts', '/notes.md'])).stdout).toContain('/notes.md:3:TODO: write');
    expect((await run('rg', ['-m', '1', 'TODO', '/scripts/app.js'])).stdout).toBe('/scripts/app.js:1:const a = 1; // TODO tidy');
    expect((await run('rg', ['-w', '-e', '--accent', '/styles.css'], ctx)).stdout).toBe('/styles.css:2::root { --accent: #f00; }\n/styles.css:3:.btn { color: var(--accent); }');
    expect((await run('grep', ['-o', '\\<btn\\>', '/index.html', '/scripts/app.js'], ctx)).stdout).toBe('/index.html:btn\n/scripts/app.js:btn\n/scripts/app.js:btn');
  });
});
