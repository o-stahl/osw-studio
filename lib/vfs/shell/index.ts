/**
 * Command dispatch.
 *
 * Each command is its own module under ./commands. This map is the only place that knows the
 * whole set, so adding a command is: write the file, add the line here, register its metadata in
 * ../shell-commands. A test asserts this map and that registry agree.
 *
 * The metadata registry is deliberately kept free of handlers: write-scope, tool-analytics and
 * the generate route import it for names and write-classification alone, and pulling 33 handler
 * modules (and the VFS graph behind them) into those callers would be a poor trade.
 */

import type { ShellEnv, ShellHandler, ShellResult } from './types';
import { askCommand } from './commands/ask';
import { briefCommand } from './commands/brief';
import { buildCommand } from './commands/build';
import { catCommand } from './commands/cat';
import { cpCommand } from './commands/cp';
import { curlCommand } from './commands/curl';
import { echoCommand } from './commands/echo';
import { findCommand } from './commands/find';
import { generateimageCommand } from './commands/generate-image';
import { grepCommand } from './commands/grep';
import { headCommand } from './commands/head';
import { inspectCommand } from './commands/inspect';
import { lsCommand } from './commands/ls';
import { mkdirCommand } from './commands/mkdir';
import { mvCommand } from './commands/mv';
import { printfCommand } from './commands/printf';
import { proposecreateCommand } from './commands/propose-create';
import { rgCommand } from './commands/rg';
import { rmCommand } from './commands/rm';
import { rmdirCommand } from './commands/rmdir';
import { runtimeCommand } from './commands/runtime';
import { screenshotCommand } from './commands/screenshot';
import { searchCommand } from './commands/search';
import { sedCommand } from './commands/sed';
import { sleepCommand } from './commands/sleep';
import { sortCommand } from './commands/sort';
import { specCommand } from './commands/spec';
import { sqlite3Command } from './commands/sqlite3';
import { ssCommand } from './commands/ss';
import { statusCommand } from './commands/status';
import { styleCommand } from './commands/style';
import { tailCommand } from './commands/tail';
import { touchCommand } from './commands/touch';
import { trCommand } from './commands/tr';
import { treeCommand } from './commands/tree';
import { uniqCommand } from './commands/uniq';
import { wcCommand } from './commands/wc';

export const SHELL_HANDLERS: Record<string, ShellHandler> = {
  'ask': askCommand,
  'brief': briefCommand,
  'build': buildCommand,
  'cat': catCommand,
  'cp': cpCommand,
  'curl': curlCommand,
  'echo': echoCommand,
  'find': findCommand,
  'generate-image': generateimageCommand,
  'grep': grepCommand,
  'head': headCommand,
  'inspect': inspectCommand,
  'ls': lsCommand,
  'mkdir': mkdirCommand,
  'mv': mvCommand,
  'printf': printfCommand,
  'propose-create': proposecreateCommand,
  'rg': rgCommand,
  'rm': rmCommand,
  'rmdir': rmdirCommand,
  'runtime': runtimeCommand,
  'screenshot': screenshotCommand,
  'search': searchCommand,
  'sed': sedCommand,
  'sleep': sleepCommand,
  'sort': sortCommand,
  'spec': specCommand,
  'sqlite3': sqlite3Command,
  'ss': ssCommand,
  'status': statusCommand,
  'style': styleCommand,
  'tail': tailCommand,
  'touch': touchCommand,
  'tr': trCommand,
  'tree': treeCommand,
  'uniq': uniqCommand,
  'wc': wcCommand,
};

export function getShellHandler(name: string): ShellHandler | undefined {
  return SHELL_HANDLERS[name];
}

export type { ShellEnv, ShellHandler, ShellResult };
