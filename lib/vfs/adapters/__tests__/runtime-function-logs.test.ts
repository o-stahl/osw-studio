import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A deployment's function logs: one row per call, written by the invocation route and the
 * scheduler. The table keeps only the newest calls, and the deployment's log level decides which
 * calls are written at all.
 */

let dir: string;
let mod: typeof import('../runtime-database');
let db: InstanceType<typeof mod.RuntimeDatabase>;
let fnId: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-fnlogs-'));
  vi.stubEnv('DEPLOYMENTS_DIR', dir);
  vi.resetModules();
  mod = await import('../runtime-database');
  db = new mod.RuntimeDatabase('d1');
  db.init();
  fnId = db.createFunction({ name: 'hello', code: 'return 1', method: 'GET', enabled: true, timeoutMs: 5000 } as never);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (statusCode: number, error?: string, pathname = '/hello') =>
  db.logFunctionExecution(fnId, { method: 'GET', path: pathname, statusCode, durationMs: 1, error });
const paths = () => db.getRecentLogs(100_000).map((log) => log.path);

describe('function logs', () => {
  it('keeps only the newest calls', () => {
    const cap = mod.FUNCTION_LOG_CAP;
    for (let i = 0; i < cap + 5; i++) call(200, undefined, `/hello/${i}`);

    const kept = paths();
    expect(kept).toHaveLength(cap);
    expect(kept).toContain(`/hello/${cap + 4}`);
    expect(kept).toContain('/hello/5');
    expect(kept).not.toContain('/hello/4');
  });

  it('writes every call by default, only failed ones at errors, and none when off', () => {
    expect(db.getFunctionLogLevel()).toBe('all');
    call(200);
    expect(paths()).toHaveLength(1);

    db.setFunctionLogLevel('errors');
    call(200);
    call(404);
    call(200, 'TypeError: x is not a function');
    expect(paths()).toHaveLength(3);

    db.setFunctionLogLevel('off');
    call(500, 'boom');
    expect(paths()).toHaveLength(3);
  });

  it('keeps the level when the database is opened again', () => {
    db.setFunctionLogLevel('errors');
    db.close();
    db = new mod.RuntimeDatabase('d1');
    db.init();

    expect(db.getFunctionLogLevel()).toBe('errors');
  });

  it('keeps the level out of reach of user SQL and out of the user\'s tables', () => {
    db.setFunctionLogLevel('errors');
    expect(db.executeUserQuery("UPDATE osws_runtime_settings SET value = 'off'").error).toMatch(/system table/i);
    expect(db.getFunctionLogLevel()).toBe('errors');
    expect(db.isSystemTable('osws_runtime_settings')).toBe(true);
  });
});
