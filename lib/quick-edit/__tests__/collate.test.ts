import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import ko from '@/messages/ko.json';
import { collate as collateLine, phraseCollated } from '@/lib/quick-edit/collate';
import { buildTally } from '@/lib/quick-edit/tally';
import type { DebugEvent } from '@/lib/stores/types';

let seq = 0;
const ev = (event: string, data: unknown = {}): DebugEvent => ({
  id: `e${++seq}`, timestamp: seq, event, data, count: 1, version: 1,
});
const running = (command: string) =>
  ev('tool_status', { toolCallId: `c${seq + 1}`, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });
const of = (...commands: string[]) => buildTally(commands.map(running));

// Worded through the English catalogue, so each case reads as the sentence a user sees.
const t = createTranslator({ locale: 'en', messages: en, namespace: 'quickEdit.collate' });
const collate = (tally: ReturnType<typeof buildTally>) => {
  const line = collateLine(tally);
  return line && phraseCollated(line, t);
};

describe('collate', () => {
  it('has nothing to say before any step', () => {
    expect(collate(buildTally([]))).toBeNull();
  });

  it('names the one file a single step touched', () => {
    expect(collate(of('cat /index.html'))).toBe('Read index.html');
  });

  it('folds consecutive steps of one kind into a count of files', () => {
    expect(collate(of('cat /a.html', 'cat /b.html', 'cat /c.html'))).toBe('Read 3 files');
  });

  it('counts a repeat of one file once', () => {
    expect(collate(of('ss /a.css', 'ss /a.css', 'ss /a.css'))).toBe('Edited a.css');
  });

  it('joins clauses in order, with "then" on the second', () => {
    expect(collate(of('search best pizza', 'cat /a.html', 'ss /a.html', 'ss /b.html', 'build')))
      .toBe('Searched the web, then read a.html, edited 2 files, rebuilt the site');
  });

  it('treats a write and an edit as the same activity', () => {
    expect(collate(of('cat > /a.html', 'sed -i s/x/y/ /b.html'))).toBe('Edited 2 files');
  });

  it('collates by kind once there are too many clauses to read in order', () => {
    // Read, edit, read, edit, read: five clauses in order, three kinds.
    expect(collate(of('cat /a.html', 'ss /a.html', 'cat /b.html', 'ss /b.html', 'cat /c.html', 'build')))
      .toBe('Read 3 files, then edited 2 files, rebuilt the site');
  });

  it('falls back to a count when even the kinds are too many', () => {
    const tally = of('cat /a.html', 'ss /a.html', 'grep x /a.html', 'build', 'ls /', 'search x', 'status done', 'rm /old.html');
    expect(collate(tally)).toBe('Ran 8 commands, changed 2 files');
  });

  it('never carries a command into the sentence', () => {
    const tally = of('frobnicate --token sk-live-1234', 'cat ../../etc/passwd');
    expect(collate(tally)).toBe('Ran 1 command, then read a file');
    expect(collate(tally)).not.toContain('sk-live');
  });

  // The clause after "then" is worded by the translation, not lowercased by code: a Korean clause
  // opens with the file's name, and lowercasing it would rename README.md to rEADME.md.
  it('leaves a later clause to the language, so a file name keeps its case', () => {
    const line = collateLine(of('search x', 'cat /README.md'))!;
    const inKorean = phraseCollated(line, createTranslator({ locale: 'ko', messages: ko, namespace: 'quickEdit.collate' }));
    const inFinnish = phraseCollated(line, createTranslator({ locale: 'fi', messages: fi, namespace: 'quickEdit.collate' }));
    expect(inKorean).toContain('README.md');
    expect(inFinnish).toContain('README.md');
  });

  // The edges of each level, one row each: where a clause names a file or counts, and where the
  // sentence moves from reading order to kinds to a bare count.
  it.each([
    ['counts files when a named file and an unnamed one share a clause', ['cat /a.html', 'cat ../../etc/passwd'], 'Read 2 files'],
    ['words a script run as its own clause', ['python /a.py'], 'Ran a script'],
    ['keeps four clauses in reading order', ['cat /a.html', 'ss /a.html', 'cat /b.html', 'ss /b.html'], 'Read a.html, then edited a.html, read b.html, edited b.html'],
    ['collates by kind when there are exactly four kinds', ['cat /a.html', 'ss /a.html', 'cat /b.html', 'ss /b.html', 'build', 'search x'], 'Read 2 files, then edited 2 files, rebuilt the site, searched the web'],
    ['counts a file read twice once when collating by kind', ['cat /a.html', 'ss /a.html', 'cat /a.html', 'ss /b.html', 'cat /c.html', 'build'], 'Read 2 files, then edited 2 files, rebuilt the site'],
    ['leaves out the changed count when nothing changed', ['cat /a.html', 'grep x /a.html', 'build', 'ls /', 'search x', 'status done'], 'Ran 6 commands'],
  ])('%s', (_name, commands, expected) => {
    expect(collate(of(...commands))).toBe(expected);
  });
});
