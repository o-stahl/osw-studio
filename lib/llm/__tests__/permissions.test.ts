import { describe, it, expect } from 'vitest';
import {
  classifyGateKey, needsApproval, sqliteChangesData, ASK_DEFAULT_KEYS, GATE_COMMANDS,
  type PermissionMode, type GateDecision,
} from '../permissions';

describe('sqliteChangesData', () => {
  it('reads a query as a query, whatever words its strings, comments and functions use', () => {
    for (const sql of [
      "SELECT replace(title, '-', ' ') FROM posts",
      "SELECT * FROM events WHERE action = 'delete'",
      'SELECT "update" FROM t',
      '-- drop the old rows later\nSELECT 1',
    ]) {
      expect(sqliteChangesData(['sqlite3', sql])).toBe(false);
    }
  });

  it('reads a statement that changes data as a change', () => {
    for (const sql of [
      "INSERT INTO posts (title) VALUES ('x')",
      "REPLACE INTO posts VALUES (1, 'x')",
      "UPDATE posts SET title = 'replace(me)'",
      'WITH old AS (SELECT id FROM posts) DELETE FROM posts WHERE id IN old',
    ]) {
      expect(sqliteChangesData(['sqlite3', sql])).toBe(true);
    }
  });

  it('is not talked out of a change by comments and quotes around it, or by a flag-shaped argument', () => {
    // The statement runs as its own argument, so each is read on its own; a quote inside a comment,
    // or a comment marker in a flag, used to swallow the statement after it.
    for (const args of [
      ['sqlite3', '--', 'DELETE FROM users'],
      ['sqlite3', '-/*', 'DELETE FROM users'],
      ['sqlite3', "/* it's */ DELETE FROM users WHERE name = 'bob'"],
      ['sqlite3', " -- don't\nDELETE FROM users WHERE name = 'bob'"],
      ['sqlite3', ' -- [\nDELETE FROM users\n-- ]'],
      ['sqlite3', '/* [ */ DELETE FROM users /* ] */'],
    ]) {
      expect(sqliteChangesData(args), args.join(' ')).toBe(true);
    }
  });
});

describe('classifyGateKey', () => {
  it('classifies always-gated commands to their key', () => {
    expect(classifyGateKey(['generate-image', 'a cat'])).toBe('generate-image');
    expect(classifyGateKey(['search', 'foo'])).toBe('search');
    expect(classifyGateKey(['rm', '-r', '/x'])).toBe('rm');
    expect(classifyGateKey(['rmdir', '/x'])).toBe('rm'); // rmdir maps to rm gate
  });

  it('splits curl into local vs external by URL', () => {
    expect(classifyGateKey(['curl', 'localhost/'])).toBe('curl:local');
    expect(classifyGateKey(['curl', 'http://127.0.0.1/x'])).toBe('curl:local');
    expect(classifyGateKey(['curl', 'https://example.com'])).toBe('curl:external');
    expect(classifyGateKey(['curl', 'example.com'])).toBe('curl:external'); // no protocol -> http:// -> external
  });

  it('classifies multi-URL curl as external if any URL is external', () => {
    expect(classifyGateKey(['curl', 'localhost/', 'https://example.com'])).toBe('curl:external');
    expect(classifyGateKey(['curl', 'localhost/a', 'localhost/b'])).toBe('curl:local');
  });

  it('ignores tokens after a pipe or redirect (they belong to another command)', () => {
    // The gated segment isn't split on pipes, so it includes the piped command's tokens;
    // those must not be read as (external) URLs — otherwise "|" becomes "http://|".
    expect(classifyGateKey(['curl', '-s', 'localhost', '|', 'head', '-n', '30'])).toBe('curl:local');
    expect(classifyGateKey(['curl', 'localhost', '>', 'out.html'])).toBe('curl:local');
    // A genuinely external curl piped into something local is still external.
    expect(classifyGateKey(['curl', '-s', 'https://example.com', '|', 'grep', 'x'])).toBe('curl:external');
  });

  it('splits sqlite3 and sed by read vs write facet', () => {
    expect(classifyGateKey(['sqlite3', 'db', 'SELECT * FROM t'])).toBe('sqlite3:read');
    expect(classifyGateKey(['sqlite3', 'db', 'INSERT INTO t VALUES(1)'])).toBe('sqlite3:write');
    expect(classifyGateKey(['sed', '-n', '1p', '/f'])).toBe('sed:read');
    expect(classifyGateKey(['sed', '-i', 's/a/b/', '/f'])).toBe('sed:write');
    // The shell edits in place with a backup suffix too, so the gate has to ask for it.
    expect(classifyGateKey(['sed', '-i.bak', 's/a/b/', '/f'])).toBe('sed:write');
  });

  it('maps ordinary read commands to their own key', () => {
    expect(classifyGateKey(['cat', '/f'])).toBe('cat');
    expect(classifyGateKey(['ls', '/'])).toBe('ls');
  });

  it('gates ask, sleep, and python3 (python3 shares the python toggle)', () => {
    expect(classifyGateKey(['ask', 'A', 'B'])).toBe('ask');
    expect(classifyGateKey(['sleep', '2'])).toBe('sleep');
    expect(classifyGateKey(['python3', 'x.py'])).toBe('python');
    expect(classifyGateKey(['python', 'x.py'])).toBe('python');
  });

  it('does not gate status or agent (always allowed)', () => {
    expect(classifyGateKey(['status', '--complete'])).toBeNull();
    expect(classifyGateKey(['agent', 'explore', 'x'])).toBeNull();
  });

  it('returns null for unknown/no command', () => {
    expect(classifyGateKey([])).toBeNull();
    expect(classifyGateKey(['definitely-not-a-command'])).toBeNull();
  });
});

describe('needsApproval', () => {
  const overrides: Record<string, GateDecision> = {};

  it('auto mode never asks', () => {
    expect(needsApproval('generate-image', 'auto', overrides)).toBe(false);
    expect(needsApproval('curl:external', 'auto', overrides)).toBe(false);
  });

  it('ask mode asks only for the default set', () => {
    expect(needsApproval('curl:external', 'ask', overrides)).toBe(true);
    expect(needsApproval('search', 'ask', overrides)).toBe(true);
    expect(needsApproval('generate-image', 'ask', overrides)).toBe(true);
    expect(needsApproval('rm', 'ask', overrides)).toBe(true);
    expect(needsApproval('curl:local', 'ask', overrides)).toBe(false);
    expect(needsApproval('cat', 'ask', overrides)).toBe(false);
  });

  it('ask mode: an always-allow override suppresses the prompt without changing mode', () => {
    expect(needsApproval('search', 'ask', { search: 'allow' })).toBe(false);
  });

  it('custom mode consults the matrix, defaulting unset keys to the ask-set state', () => {
    expect(needsApproval('cat', 'custom', { cat: 'ask' })).toBe(true);
    expect(needsApproval('search', 'custom', {})).toBe(true); // unset -> ask-set default
    expect(needsApproval('search', 'custom', { search: 'allow' })).toBe(false);
    expect(needsApproval('cat', 'custom', {})).toBe(false); // unset -> not in ask set -> allow
  });

  it('ASK_DEFAULT_KEYS is the recommended consequential set', () => {
    expect([...ASK_DEFAULT_KEYS].sort()).toEqual(
      ['curl:external', 'generate-image', 'rm', 'search'].sort()
    );
  });

  it('GATE_COMMANDS enumerates every command for the matrix UI', () => {
    const keys = GATE_COMMANDS.flatMap(c => c.keys);
    expect(keys).toContain('curl:local');
    expect(keys).toContain('curl:external');
    expect(keys).toContain('sqlite3:read');
    expect(keys).toContain('sqlite3:write');
  });
});
