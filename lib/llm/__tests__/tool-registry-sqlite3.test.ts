// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `sqlite3` runs against a deployment's database on the server, through a workspace-scoped route.
 * Without a selected workspace there is no route to send it to, so the agent gets an error back
 * instead of a request to a path that cannot answer; with one, the request names that workspace.
 */

const h = vi.hoisted(() => ({
  workspace: undefined as string | undefined,
  apiFetch: vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ exitCode: 0, stdout: 'rows\n' }), { status: 200 })),
}));

vi.mock('@/lib/vfs', () => ({
  getActiveVFS: () => ({
    init: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn().mockResolvedValue([]),
    listDirectories: vi.fn().mockResolvedValue([]),
    hasServerContext: () => true,
    getRuntimeDeploymentId: () => 'dep-1',
    refreshServerContext: vi.fn(),
  }),
}));

vi.mock('@/lib/vfs/cli-shell', () => ({
  vfsShell: { execute: vi.fn().mockResolvedValue({ success: true, stdout: '' }) },
}));

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api/backend-status', () => ({ apiFetch: h.apiFetch }));
vi.mock('@/lib/web/workspace-cookie', () => ({ readWorkspaceCookie: () => h.workspace }));

function bashToolCall(command: string) {
  return { id: 'tc-1', type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command }) } };
}

describe('sqlite3 in Server Mode', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registry: any;

  beforeEach(async () => {
    h.apiFetch.mockClear();
    h.workspace = undefined;
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    const mod = await import('../tool-registry');
    registry = new mod.ToolRegistry();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tells the agent a workspace is needed, and sends nothing, when none is selected', async () => {
    const result = await registry.execute(bashToolCall('sqlite3 "SELECT 1"'), 'test-project', {});
    expect(result).toContain('needs a workspace selected');
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it('sends the command to the selected workspace\'s route, with the deployment it runs against', async () => {
    h.workspace = 'team a/1';
    const result = await registry.execute(bashToolCall('sqlite3 "SELECT 1"'), 'test-project', {});
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/w/team%20a%2F1/bash/execute');
    expect(JSON.parse(String(init.body))).toMatchObject({ deploymentId: 'dep-1', cmd: ['sqlite3', 'SELECT 1'] });
    expect(result).toContain('rows');
  });
});
