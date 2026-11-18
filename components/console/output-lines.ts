/** A shell command's result as the Console prints it. */
export interface ConsoleResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * The terminal lines for a command's result: its output a line at a time, then, for a command that
 * failed, its error in red. A command can print output and still fail, as `grep` does over a found
 * and a missing path, and both belong on screen.
 */
export function outputLines(result: ConsoleResult): string[] {
  const lines = result.stdout ? result.stdout.split('\n') : [];
  if (!result.success && result.stderr) lines.push(`\x1b[31m${result.stderr}\x1b[0m`);
  return lines;
}
