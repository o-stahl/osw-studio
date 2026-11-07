import type { ShellEnv, ShellResult } from '../types';
import { SedCommand, addressMatches, parseSedCommand } from '../internals';
import { applyRedirectGuarded, checkWrite, normalizePath, recordFileVersion, truncate } from '../runtime';
import { parseSedArgs } from '@/lib/vfs/shell-commands';

/** `sed` — text substitution; -i edits in place. */
export async function sedCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

          // sed [-i] [-n] [-e expr]... 'expr' [file]
          // Supports: substitution, range delete, range change, range print
          const { inPlace, suppressOutput, expressions, filePath } = parseSedArgs(args);

          if (expressions.length === 0) {
            return {
              stdout: '',
              stderr: `sed: missing expression

  Usage: sed [-i] [-n] [-e expr] 'expr' [file]

  Commands:
    s/pattern/replacement/[g]       Substitute (BRE: parens are literal)
    /pattern1/,/pattern2/d          Delete lines in range
    /pattern1/,/pattern2/c\\text     Replace range with text
    /pattern/i\\text                 Insert text before matching line
    /pattern/a\\text                 Append text after matching line
    -n '/pattern/p'                 Print matching lines only

  Examples:
    sed -i 's/old/new/g' /file.txt
    sed -i '/<nav>/,/<\\/nav>/d' /file.txt
    sed -i '/<nav>/,/<\\/nav>/c\\<nav>new</nav>' /file.txt
    sed -i '/<\\/body>/i\\<footer>My footer</footer>' /file.txt
    sed -n '/<script>/,/<\\/script>/p' /file.txt`,
              exitCode: 2
            };
          }

          // Parse all expressions using the unified parser
          const parsedCmds: SedCommand[] = [];
          for (const expr of expressions) {
            const parsed = parseSedCommand(expr);
            if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 };
            parsedCmds.push(parsed);
          }

          // Get input content
          let inputContent: string;
          const sedPath = normalizePath(filePath);

          if (sedPath) {
            try {
              const file = await vfs.readFile(projectId, sedPath);
              if (typeof file.content !== 'string') {
                return { stdout: '', stderr: `sed: ${sedPath}: binary file`, exitCode: 1 };
              }
              inputContent = file.content;
            } catch (e: any) {
              return { stdout: '', stderr: `sed: ${sedPath}: ${e?.message || 'file not found'}`, exitCode: 1 };
            }
          } else if (stdin !== undefined) {
            inputContent = stdin;
          } else {
            return { stdout: '', stderr: 'sed: no input file or stdin', exitCode: 2 };
          }

          // Apply all commands
          const lines = inputContent.split(/\r?\n/);
          const totalLines = lines.length;
          const outputLines: string[] = [];
          let substitutionCount = 0;

          // Track range state per command (for multi-line ranges)
          const inRange = new Array(parsedCmds.length).fill(false);

          for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
            let line = lines[lineIdx];
            const lineNum = lineIdx + 1; // 1-based
            let deleted = false;
            let printed = false;
            const appendAfter: string[] = [];

            for (let ci = 0; ci < parsedCmds.length; ci++) {
              const cmd = parsedCmds[ci];

              if (cmd.kind === 'substitute') {
                let before: string;
                // If address-constrained (e.g., 6s/old/new/), only apply on matching lines
                if (cmd.start) {
                  if (cmd.end) {
                    // Range-addressed substitution: /start/,/end/s/old/new/
                    if (!inRange[ci] && addressMatches(cmd.start, lineNum, line, totalLines)) {
                      inRange[ci] = true;
                    }
                    if (inRange[ci]) {
                      // Check end-address against original line before substitution
                      const endMatch = addressMatches(cmd.end, lineNum, line, totalLines);
                      before = line;
                      line = line.replace(cmd.pattern, cmd.replacement);
                      if (line !== before) substitutionCount++;
                      if (endMatch) {
                        inRange[ci] = false;
                      }
                    }
                  } else {
                    // Single-addressed substitution: 6s/old/new/
                    if (addressMatches(cmd.start, lineNum, line, totalLines)) {
                      before = line;
                      line = line.replace(cmd.pattern, cmd.replacement);
                      if (line !== before) substitutionCount++;
                    }
                  }
                } else {
                  before = line;
                  line = line.replace(cmd.pattern, cmd.replacement);
                  if (line !== before) substitutionCount++;
                }
                continue;
              }

              // Address-based commands: delete, change, insert, append, print, group
              const startMatch = addressMatches(cmd.start, lineNum, line, totalLines);

              // Insert/append are single-address only, handled before range logic
              if (cmd.kind === 'insert') {
                const apply = cmd.negate ? !startMatch : startMatch;
                if (apply) outputLines.push(cmd.text);
                continue;
              }
              if (cmd.kind === 'append') {
                const apply = cmd.negate ? !startMatch : startMatch;
                if (apply) appendAfter.push(cmd.text);
                continue;
              }

              // Group command: apply sub-commands within address range
              if (cmd.kind === 'group') {
                if ('end' in cmd && cmd.end) {
                  if (!inRange[ci] && startMatch) inRange[ci] = true;
                  if (inRange[ci]) {
                    const endMatch = addressMatches(cmd.end, lineNum, line, totalLines);
                    for (const sub of cmd.commands) {
                      const subAddr = sub.kind === 'substitute' ? sub.start : ('start' in sub ? sub.start : undefined);
                      let subMatch = subAddr ? addressMatches(subAddr, lineNum, line, totalLines) : true;
                      if ('negate' in sub && sub.negate) subMatch = !subMatch;
                      if (subMatch) {
                        if (sub.kind === 'delete') deleted = true;
                        else if (sub.kind === 'print') printed = true;
                        else if (sub.kind === 'substitute') {
                          const before = line;
                          line = line.replace(sub.pattern, sub.replacement);
                          if (line !== before) substitutionCount++;
                        }
                      }
                    }
                    if (endMatch) inRange[ci] = false;
                  }
                } else {
                  if (startMatch) {
                    for (const sub of cmd.commands) {
                      const subAddr = sub.kind === 'substitute' ? sub.start : ('start' in sub ? sub.start : undefined);
                      let subMatch = subAddr ? addressMatches(subAddr, lineNum, line, totalLines) : true;
                      if ('negate' in sub && sub.negate) subMatch = !subMatch;
                      if (subMatch) {
                        if (sub.kind === 'delete') deleted = true;
                        else if (sub.kind === 'print') printed = true;
                        else if (sub.kind === 'substitute') {
                          const before = line;
                          line = line.replace(sub.pattern, sub.replacement);
                          if (line !== before) substitutionCount++;
                        }
                      }
                    }
                  }
                }
                continue;
              }

              if ('end' in cmd && cmd.end) {
                // Range: /start/,/end/cmd
                if (!inRange[ci]) {
                  if (startMatch) inRange[ci] = true;
                }

                if (inRange[ci]) {
                  const endMatch = addressMatches(cmd.end, lineNum, line, totalLines);

                  if (!cmd.negate) {
                    if (cmd.kind === 'delete') {
                      deleted = true;
                    } else if (cmd.kind === 'print') {
                      printed = true;
                    } else if (cmd.kind === 'change') {
                      deleted = true;
                    }
                  }

                  if (endMatch) {
                    if (!cmd.negate && cmd.kind === 'change') {
                      outputLines.push(cmd.text);
                    }
                    inRange[ci] = false;
                  }
                } else if (cmd.negate) {
                  if (cmd.kind === 'delete') {
                    deleted = true;
                  } else if (cmd.kind === 'print') {
                    printed = true;
                  }
                }
              } else {
                // Single address: /pattern/cmd or 5cmd
                const apply = cmd.negate ? !startMatch : startMatch;
                if (apply) {
                  if (cmd.kind === 'delete') {
                    deleted = true;
                  } else if (cmd.kind === 'print') {
                    printed = true;
                  } else if (cmd.kind === 'change') {
                    deleted = true;
                    outputLines.push(cmd.text);
                  }
                }
              }
            }

            if (!deleted) {
              if (suppressOutput) {
                // -n mode: only output explicitly printed lines
                if (printed) outputLines.push(line);
              } else {
                outputLines.push(line);
              }
            }
            // Flush append-after-line text (from 'a' command)
            for (const text of appendAfter) {
              outputLines.push(text);
            }
          }

          const outputContent = outputLines.join('\n');

          if (inPlace) {
            if (!sedPath) {
              return { stdout: '', stderr: 'sed: -i requires a file argument (cannot edit stdin in-place)', exitCode: 2 };
            }
            try {
              const hasSubstitutions = parsedCmds.some(c => c.kind === 'substitute');
              if (hasSubstitutions && substitutionCount === 0) {
                return { stdout: `(0 substitutions — pattern did not match any line in ${sedPath})`, stderr: '', exitCode: 0 };
              }
              // sed is surgical (self-protecting): not gated, only tracked so the baseline
              // stays accurate after the agent's own edit (but not when its view was stale).
              const sedChk = await checkWrite(vfs, projectId, ctx, sedPath, false);
              await vfs.updateFile(projectId, sedPath, outputContent);
              if (sedChk.wasCurrent) { try { recordFileVersion(ctx, sedPath, await vfs.readFile(projectId, sedPath)); } catch { /* best-effort version record */ } }
              const note = hasSubstitutions ? ` (${substitutionCount} substitution${substitutionCount !== 1 ? 's' : ''})` : '';
              return { stdout: note, stderr: '', exitCode: 0 };
            } catch (e: any) {
              return { stdout: '', stderr: `sed: ${sedPath}: ${e?.message || 'cannot write file'}`, exitCode: 1 };
            }
          }

          // Output to stdout (redirect handled generically)
          if (redirect) return applyRedirectGuarded(vfs, projectId, outputContent, redirect, ctx);
          return { stdout: truncate(outputContent), stderr: '', exitCode: 0 };
}
