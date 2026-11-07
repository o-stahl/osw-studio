import { describe, it, expect } from 'vitest';
import {
  SHELL_COMMANDS,
  alwaysWriteCommands,
  isSedInPlaceFlag,
  generalCommandNames,
  isKnownShellCommand,
  setupOnlyCommandNames,
  supportedCommandList,
} from '../shell-commands';
import { SHELL_HANDLERS } from '../shell/index';

/**
 * The registry is only worth having if it cannot drift from the code it describes.
 *
 * Each command is a module under lib/vfs/shell/commands, wired into SHELL_HANDLERS. That map is
 * compared against the metadata registry directly — no parsing of source text — so a command
 * implemented without being registered, or registered without an implementation, fails here.
 *
 * The two are kept separate on purpose: write-scope, tool-analytics and the generate route import
 * the metadata for names and write-classification, and should not pull in 33 handler modules.
 */

describe('shell command registry', () => {
  it('has a handler for every command it says the shell runs', () => {
    const missing = SHELL_COMMANDS
      .filter((c) => c.handledBy === 'shell' && !(c.name in SHELL_HANDLERS))
      .map((c) => c.name);

    expect(missing).toEqual([]);
  });

  it('registers every command that has a handler', () => {
    const unregistered = Object.keys(SHELL_HANDLERS).filter((n) => !isKnownShellCommand(n));

    expect(unregistered).toEqual([]);
  });

  // Commands the tool layer intercepts (cd, preview, python, lua, agent) never reach the shell,
  // so they must NOT have a handler here.
  it('has no handler for commands the tool layer intercepts', () => {
    const stray = SHELL_COMMANDS
      .filter((c) => c.handledBy === 'tool' && c.name in SHELL_HANDLERS)
      .map((c) => c.name);

    expect(stray).toEqual([]);
  });

  it('has no duplicate names or aliases', () => {
    const all = SHELL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

    expect(all.length).toBe(new Set(all).size);
  });

  it('lists every registered command in the text shown to the agent', () => {
    const listed = new Set(supportedCommandList().split(',').map((s) => s.trim()));
    const unlisted = SHELL_COMMANDS.map((c) => c.name).filter((n) => !listed.has(n));

    expect(unlisted).toEqual([]);
  });

  // The gap this registry exists to prevent: a command that writes but isn't scoped.
  it('classifies the commands that mutate the VFS as writers', () => {
    const writers = alwaysWriteCommands();

    for (const c of ['ss', 'touch', 'mkdir', 'rm', 'rmdir', 'mv', 'cp', 'generate-image', 'runtime']) {
      expect(writers.has(c), `${c} should be a write command`).toBe(true);
    }
    for (const c of ['cat', 'ls', 'rg', 'build', 'status', 'ask']) {
      expect(writers.has(c), `${c} should not be a write command`).toBe(false);
    }
  });

  // tool-executor splits on this to decide whether "you called a bash command as a tool" applies:
  // setup-only commands are valid for the setup agent alone, everything else for any agent.
  it('separates setup-only commands from the general set', () => {
    expect([...setupOnlyCommandNames()].sort()).toEqual(['brief', 'propose-create', 'spec']);
  });

  it('keeps ordinary commands out of the setup-only set', () => {
    const general = generalCommandNames();

    for (const c of ['ss', 'cat', 'build', 'status', 'runtime', 'generate-image']) {
      expect(general.has(c), `${c} should be available to any agent`).toBe(true);
    }
    for (const c of ['brief', 'spec', 'propose-create']) {
      expect(general.has(c), `${c} is setup-only`).toBe(false);
    }
  });

  it('includes aliases in the general set', () => {
    const general = generalCommandNames();

    expect(general.has('python3')).toBe(true);
    expect(general.has('delegate')).toBe(true);
  });
});

/**
 * The permission matrix is a seventh consumer of the command surface, deliberately curated:
 * some commands are never gated, and permissions.ts documents why. What must not happen is a
 * command that WRITES slipping in without a gate — that runs without asking the user.
 */
describe('permission gate coverage', () => {
  /**
   * classifyGateKey is the authority on whether a command is gated: some commands resolve to
   * another command's gate (rmdir -> rm, python3 -> python) or split into facets (sed:read /
   * sed:write), so membership in GATE_COMMANDS by name is not the test.
   */
  async function ungatedCommands(): Promise<string[]> {
    const { classifyGateKey, ALWAYS_ALLOWED_NOTES } = await import('@/lib/llm/permissions');
    const documented = new Set(ALWAYS_ALLOWED_NOTES.map((n: { command: string }) => n.command));
    return SHELL_COMMANDS
      .filter((c) => !documented.has(c.name) && classifyGateKey([c.name]) === null)
      .map((c) => c.name);
  }

  // Every command is either gated or has a written reason why not, so adding one forces a choice
  // rather than silently landing outside the approval matrix.
  it('gates every command, or documents why not', async () => {
    expect(await ungatedCommands()).toEqual([]);
  });

  it('resolves alias commands to the gate they share', async () => {
    const { classifyGateKey } = await import('@/lib/llm/permissions');

    expect(classifyGateKey(['rmdir', '/d'])).toBe('rm');
    expect(classifyGateKey(['python3', 'x.py'])).toBe('python');
  });

  it('does not offer a gate for a command that does not exist', async () => {
    const { GATE_COMMANDS } = await import('@/lib/llm/permissions');
    const phantom = GATE_COMMANDS
      .map((g: { command: string }) => g.command)
      .filter((c: string) => !isKnownShellCommand(c));

    expect(phantom).toEqual([]);
  });
});

describe('isSedInPlaceFlag', () => {
  it('matches the spellings the shell edits in place with, and not combined flags', () => {
    for (const flag of ['-i', '-i.bak', '-i~']) expect(isSedInPlaceFlag(flag), flag).toBe(true);
    for (const flag of ['-n', '-e', '-in', '-ie']) expect(isSedInPlaceFlag(flag), flag).toBe(false);
  });
});
