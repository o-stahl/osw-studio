import { describe, it, expect } from 'vitest';
import { outputLines } from '../output-lines';

/**
 * What the Console prints for a command. A command can print output and still fail, as `grep` does
 * over a found and a missing path: both reach the terminal, the error in red after the output.
 */

const RED = (text: string) => `\x1b[31m${text}\x1b[0m`;

describe('outputLines', () => {
  it('prints the output of a command that succeeds, a line at a time, and not what it wrote to stderr', () => {
    expect(outputLines({ success: true, stdout: 'a\nb', stderr: '' })).toEqual(['a', 'b']);
    expect(outputLines({ success: true, stdout: 'a', stderr: 'warning: x' })).toEqual(['a']);
    expect(outputLines({ success: true, stdout: '', stderr: '' })).toEqual([]);
  });

  it('prints what a failing command printed, then its error in red', () => {
    expect(outputLines({
      success: false,
      stdout: '/a.txt:2:MATCH here',
      stderr: 'grep: /nope: No such file or directory',
    })).toEqual(['/a.txt:2:MATCH here', RED('grep: /nope: No such file or directory')]);
  });

  it('prints only the error of a failing command with no output, and nothing for one with neither', () => {
    expect(outputLines({ success: false, stdout: '', stderr: 'cat: /x: not found' })).toEqual([RED('cat: /x: not found')]);
    expect(outputLines({ success: false, stdout: '', stderr: '' })).toEqual([]);
  });
});
