import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isKnownShellCommand } from '@/lib/vfs/shell-commands';

/**
 * The system prompt is the model's manual for the shell.
 *
 * It is deliberately a *subset* of the command registry — curated, grouped by purpose, and gated
 * on read-only and server-context flags — so it is not generated from the registry and should not
 * be. What must hold is the other direction: every command it teaches has to exist, or the model
 * spends turns calling something that was renamed or removed.
 *
 * The source is parsed rather than the built string so every conditional branch is covered.
 */

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'lib/llm/system-prompt.ts'),
  'utf-8'
);

/** Placeholders in usage examples, not commands. */
const PLACEHOLDERS = new Set(['cmd1', 'cmd2', 'cmd']);

/** Leading command token of each `- Label: <cmd> …` bullet in the shell sections. */
function taughtCommands(): string[] {
  const found = new Set<string>();
  for (const m of SOURCE.matchAll(/^- [A-Za-z/ ]+: ([a-z0-9-]+)/gm)) {
    const name = m[1];
    if (!PLACEHOLDERS.has(name)) found.add(name);
  }
  return [...found].sort();
}

describe('system prompt shell documentation', () => {
  it('teaches only commands that exist', () => {
    const unknown = taughtCommands().filter((c) => !isKnownShellCommand(c));

    expect(unknown).toEqual([]);
  });

  it('actually finds the command bullets', () => {
    // Guards the parser itself: a regex that silently matched nothing would make the
    // check above pass for the wrong reason.
    const taught = taughtCommands();

    expect(taught.length).toBeGreaterThan(8);
    expect(taught).toContain('rg');
    expect(taught).toContain('ss');
  });

  it('documents the character-count flag alongside the line-count one', () => {
    expect(SOURCE).toContain('head [-n N|-c N] file');
  });
});

/**
 * Chat mode talks about the project rather than working on it. It shared the code agent's opening,
 * which told it to act on assumptions instead of asking and to finish with build and status, and the
 * loop then nudged it toward a status command it could not use.
 */
describe('the Chat-mode prompt', () => {
  it('has none of the code agent\'s task rules or editing commands, and keeps the reading ones', async () => {
    const { buildSystemPrompt } = await import('../system-prompt');
    const chat = await buildSystemPrompt(true, null, undefined, 'orchestrator');
    const code = await buildSystemPrompt(false, null, undefined, 'orchestrator');

    for (const codeOnly of ['Bias toward action', 'run build and status', '- Edit: ss', '- Create: mkdir']) {
      expect(code, codeOnly).toContain(codeOnly);
      expect(chat, codeOnly).not.toContain(codeOnly);
    }
    expect(chat).toContain('- Search: rg');
    expect(chat).toContain('- Read: head');
  });
});
