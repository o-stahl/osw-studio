import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Boot-time deployment route backfill.
 *
 * Registering the missing routes is only half the job: Caddy's config is generated from the same
 * routing table, so a row created after that generation would not get its subdomain block until
 * the next restart. The order of the two steps is the behaviour under test here, along with the
 * refusal to let either one take the instance down with it.
 */

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  listWorkspaces: vi.fn(),
  systemDatabaseExists: vi.fn(),
  backfillDeploymentRoutes: vi.fn(),
  regenerateInstanceCaddy: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/vfs/adapters/sqlite-connection', () => ({ listDeploymentIds: () => [] }));
vi.mock('@/lib/scheduler', () => ({
  Scheduler: class { registerTask() {} start() { mocks.order.push('scheduler'); } },
}));
vi.mock('@/lib/scheduler/deployment-scheduler', () => ({
  createDeploymentSchedulerTask: () => ({}),
}));
vi.mock('@/lib/auth/system-database', () => ({
  listWorkspaces: mocks.listWorkspaces,
  systemDatabaseExists: mocks.systemDatabaseExists,
}));
vi.mock('@/lib/auth/default-workspace', () => ({
  backfillDeploymentRoutes: mocks.backfillDeploymentRoutes,
}));
vi.mock('@/lib/caddy/regenerate', () => ({ regenerateInstanceCaddy: mocks.regenerateInstanceCaddy }));

async function boot() {
  const { register } = await import('@/instrumentation');
  await register();
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.order.length = 0;
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');

  mocks.systemDatabaseExists.mockReturnValue(true);
  mocks.listWorkspaces.mockReturnValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
  mocks.backfillDeploymentRoutes.mockImplementation((id: string) => {
    mocks.order.push(`backfill:${id}`);
    return 0;
  });
  mocks.regenerateInstanceCaddy.mockImplementation(async () => {
    mocks.order.push('caddy');
  });

  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
  vi.unstubAllEnvs();
});

describe('boot', () => {
  it('backfills every workspace before regenerating the Caddy config', async () => {
    await boot();

    expect(mocks.order).toEqual(['scheduler', 'backfill:ws-1', 'backfill:ws-2', 'caddy']);
  });

  it('keeps going when one workspace fails', async () => {
    mocks.backfillDeploymentRoutes.mockImplementation((id: string) => {
      if (id === 'ws-1') throw new Error('unreadable database');
      mocks.order.push(`backfill:${id}`);
      return 0;
    });

    await expect(boot()).resolves.toBeUndefined();

    expect(mocks.order).toEqual(['scheduler', 'backfill:ws-2', 'caddy']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ws-1'),
      'unreadable database'
    );
  });

  it('still boots when the routing table cannot be read at all', async () => {
    mocks.listWorkspaces.mockImplementation(() => { throw new Error('no system database'); });

    await expect(boot()).resolves.toBeUndefined();

    expect(mocks.regenerateInstanceCaddy).toHaveBeenCalled();
  });

  it('does not touch the system database when there is none', async () => {
    mocks.systemDatabaseExists.mockReturnValue(false);

    await boot();

    expect(mocks.listWorkspaces).not.toHaveBeenCalled();
    expect(mocks.backfillDeploymentRoutes).not.toHaveBeenCalled();
  });

  it('says nothing when every deployment is already routed', async () => {
    await boot();

    expect(log).not.toHaveBeenCalled();
  });

  it('reports the count when it actually created routes', async () => {
    mocks.backfillDeploymentRoutes.mockReturnValue(2);

    await boot();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('4'));
  });

  it('starts none of it in a Browser Mode build, which has better-sqlite3 installed as well', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false');

    await boot();

    expect(mocks.order).toEqual([]);
    expect(mocks.systemDatabaseExists).not.toHaveBeenCalled();
    expect(mocks.regenerateInstanceCaddy).not.toHaveBeenCalled();
  });
});
