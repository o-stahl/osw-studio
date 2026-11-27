import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';

/**
 * The MCP endpoint end to end: a real system database with one account and one workspace, a
 * real workspace database with one project, and JSON-RPC over the route. The bearer gate and
 * the role check are the parts the tools rely on, so the refusals are asserted as carefully as
 * the happy path.
 */

vi.mock('server-only', () => ({}));

let dir: string;
let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
const TOKEN = 'dev-token-for-tests';

async function seed() {
  const { createUser, createWorkspace } = await import('@/lib/auth/system-database');
  userId = createUser('agent@a.test', 'hash');
  workspaceId = createWorkspace('Agents', userId);
  // A real workspace, well formed and existing, that this account was never granted.
  otherWorkspaceId = createWorkspace('Somebody else', createUser('other@a.test', 'hash'));
  const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
  const adapter = getWorkspaceAdapter(workspaceId);
  await adapter.init();
  const now = new Date();
  await adapter.createProject({ id: 'p1', name: 'Site', createdAt: now, updatedAt: now, settings: { runtime: 'static' } });
  await adapter.createFile({
    id: 'f1', projectId: 'p1', path: '/index.html', name: 'index.html', type: 'html', content: '<h1>Hi</h1>',
    mimeType: 'text/html', size: 11, createdAt: now, updatedAt: now, metadata: {},
  });
}

type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: unknown };

async function rpc(body: Rpc, token: string | null = TOKEN): Promise<{ status: number; result?: any; error?: any }> {
  const { POST } = await import('@/app/api/mcp/route');
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  });
  if (token) headers.set('authorization', `Bearer ${token}`);
  const request = new Request('http://localhost/api/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  const res = await POST(request as unknown as NextRequest);
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text };
  // Streamable HTTP answers as SSE or JSON; take the first JSON-RPC message either way.
  const line = text.split('\n').find(l => l.startsWith('data: '));
  const message = JSON.parse(line ? line.slice(6) : text);
  return { status: res.status, result: message.result, error: message.error };
}

async function callTool(name: string, args: Record<string, unknown>, token: string | null = TOKEN) {
  const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token);
  const content = out.result?.content?.[0]?.text as string | undefined;
  return { ...out, text: content, isError: out.result?.isError === true };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-mcp-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('MCP_ENABLED', 'true');
  // The endpoint requires server mode as well as the flag.
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('MCP_DEV_TOKEN', TOKEN);
  await seed();
  vi.stubEnv('MCP_DEV_USER_ID', userId);
  vi.stubEnv('MCP_DEV_WORKSPACE_ID', workspaceId);
});

afterEach(async () => {
  const { closeWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
  const { closeSystemDatabase } = await import('@/lib/auth/system-database');
  closeWorkspaceAdapter(workspaceId);
  closeWorkspaceAdapter(otherWorkspaceId);
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/mcp', () => {
  it('does not exist unless MCP_ENABLED is set', async () => {
    vi.stubEnv('MCP_ENABLED', 'false');
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(out.status).toBe(404);
  });

  it('challenges a request with no bearer token', async () => {
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(new Request('http://localhost/api/mcp', { method: 'POST', body: '{}' }) as unknown as NextRequest);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('points the challenge at this instance\'s discovery document', async () => {
    // Without `resource_metadata` a client has to guess a well-known path to find the
    // authorization server. The host comes from the request, so an instance reached on any
    // hostname names itself rather than a build-time default.
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(new Request('http://studio.example.test/api/mcp', { method: 'POST', body: '{}' }) as unknown as NextRequest);

    expect(res.headers.get('www-authenticate')).toMatch(
      /resource_metadata="http:\/\/studio\.example\.test\/\.well-known\/oauth-protected-resource\/api\/mcp"/,
    );
  });

  it('rejects a wrong token', async () => {
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope');
    expect(out.status).toBe(401);
  });

  it('says which instance and workspace it is, so two connectors can be told apart', async () => {
    // Every OSW Studio answers as `osw-studio`: hosted, server mode and desktop alike. Without
    // the title a client's connector list shows identical entries.
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' },
    } });

    expect(out.result.serverInfo.name).toBe('osw-studio');
    expect(out.result.serverInfo.title).toMatch(/Development workspace/);
    expect(out.result.serverInfo.title).toMatch(/localhost/);
  });

  it('lists every tool, each naming the scope it needs', async () => {
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = out.result.tools as { name: string; description: string }[];

    expect(tools.map(t => t.name).sort()).toEqual([
      'agent_cancel', 'agent_list', 'agent_run', 'agent_status', 'analytics_overview',
      'backend_delete', 'backend_list', 'backend_upsert', 'bash', 'canvas_selection',
      'deployments_create', 'deployments_duplicate', 'deployments_list', 'deployments_publish',
      'deployments_sql', 'deployments_unpublish', 'deployments_update',
      'deployments_url',
      'files_download_url',
      'files_read',
      'files_upload_url',
      'files_write',
      'preview_screenshot',
      'projects_create', 'projects_duplicate', 'projects_get', 'projects_list',
      'skills_duplicate', 'skills_list',
      'templates_duplicate', 'templates_list',
    ]);
    // A client that is refused needs to know which scope was missing, so each description says.
    const scopeless = tools.filter(t => !/[Nn]eeds [a-z:]+/.test(t.description));
    expect(scopeless.map(t => t.name)).toEqual([]);
  });

  it('lists the projects of a workspace the account can reach', async () => {
    const out = await callTool('projects_list', { workspaceId });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text!)).toEqual([expect.objectContaining({ id: 'p1', name: 'Site', runtime: 'static' })]);
  });

  it('refuses a workspace outside the grant even for an instance admin', async () => {
    // verifyWorkspaceAccess waves instance admins into every workspace, so the grant's own
    // workspace binding is the only thing keeping an admin's token inside the workspace the
    // consent screen named. A live run reached another workspace before this existed.
    const { updateUser } = await import('@/lib/auth/system-database');
    updateUser(userId, { is_admin: 1 });

    const out = await callTool('projects_list', { workspaceId: otherWorkspaceId });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(new RegExp(`granted workspace ${workspaceId}`));
  });

  it('refuses a workspace the account was never granted', async () => {
    // A well-formed id of a workspace that really exists, so the refusal can only come from the
    // access check. An id of the wrong shape is refused by the adapter instead, which is how an
    // earlier version of this test passed with the access check removed.
    // The grant names this workspace, so the refusal can only come from the access check.
    vi.stubEnv('MCP_DEV_WORKSPACE_ID', otherWorkspaceId);

    const out = await callTool('projects_list', { workspaceId: otherWorkspaceId });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/access denied/i);
  });



  it('lets a granted member in at their own role', async () => {
    const { createUser, grantWorkspaceAccess } = await import('@/lib/auth/system-database');
    const viewer = createUser('viewer@a.test', 'hash');
    grantWorkspaceAccess(viewer, workspaceId, 'viewer');
    vi.stubEnv('MCP_DEV_USER_ID', viewer);
    vi.stubEnv('MCP_DEV_WORKSPACE_ID', workspaceId);

    // A viewer may read.
    expect((await callTool('projects_list', { workspaceId })).isError).toBe(false);
    // And may not write: projects:write needs editor.
    const write = await callTool('bash', { workspaceId, projectId: 'p1', command: "cat > /x.html << 'EOF'\nx\nEOF" });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/permission/i);
  });

  it('reads a file through bash, as the in-app agent does', async () => {
    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'cat /index.html' });

    expect(out.isError).toBe(false);
    expect(out.text).toContain('<h1>Hi</h1>');
  });

  it('writes a file through bash, and the next read returns it', async () => {
    const write = await callTool('bash', {
      workspaceId, projectId: 'p1', command: "cat > /about.html << 'EOF'\n<p>About</p>\nEOF",
    });
    expect(write.isError).toBe(false);

    const read = await callTool('bash', { workspaceId, projectId: 'p1', command: 'cat /about.html' });
    expect(read.text).toContain('<p>About</p>');
  });

  it('edits an existing file with ss', async () => {
    const edit = await callTool('bash', {
      workspaceId, projectId: 'p1', command: "ss /index.html << 'EOF'\n<h1>Hi</h1>\n=======\n<h1>Edited</h1>\nEOF",
    });
    expect(edit.isError).toBe(false);

    const read = await callTool('bash', { workspaceId, projectId: 'p1', command: 'cat /index.html' });
    expect(read.text).toContain('<h1>Edited</h1>');
  });

  it('lists files through bash', async () => {
    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'ls /' });

    expect(out.isError).toBe(false);
    expect(out.text).toContain('index.html');
  });

  it('refuses a writing command when the grant is read-only, and the file is untouched', async () => {
    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');

    const write = await callTool('bash', {
      workspaceId, projectId: 'p1', command: "cat > /sneaky.html << 'EOF'\nx\nEOF",
    });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/projects:write/);

    const read = await callTool('bash', { workspaceId, projectId: 'p1', command: 'ls /' });
    expect(read.text).not.toContain('sneaky.html');
  });

  it('refuses a relative-path redirect on a read-only grant', async () => {
    // A redirect is a write whether or not its target is absolute. This is refused by the scope
    // check, before the shell sees it; the shell's read-only mode is the second line behind that.
    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');

    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'echo sneaky > about.html' });

    const listing = await callTool('bash', { workspaceId, projectId: 'p1', command: 'ls /' });
    expect(listing.text).not.toContain('about.html');
    expect(out.text).toMatch(/read-only|not granted|not permitted|denied/i);
  });

  it('creates a project from a template, with the template\'s runtime and files', async () => {
    const out = await callTool('projects_create', { workspaceId, name: 'From MCP', template: 'handlebars-starter' });

    expect(out.isError).toBe(false);
    const created = JSON.parse(out.text!);
    expect(created).toMatchObject({ name: 'From MCP', runtime: 'handlebars', template: 'handlebars-starter' });
    // The template's files are really there, not just a project row.
    expect(created.files).toContain('/index.html');
    expect(created.files.length).toBeGreaterThan(1);

  });

  it('stores the template\'s runtime on the project', async () => {
    // A non-Handlebars template on purpose: `projects_list` falls back to 'handlebars' when a
    // project has no runtime, so a Handlebars template cannot show whether it was stored at all.
    const out = await callTool('projects_create', { workspaceId, name: 'Blank one', template: 'blank' });
    const created = JSON.parse(out.text!);
    expect(created.runtime).toBe('static');

    const listed = JSON.parse((await callTool('projects_list', { workspaceId })).text!);
    expect(listed.find((p: { id: string }) => p.id === created.id)).toMatchObject({ runtime: 'static' });
  });

  it('stores the surface the template opens on, and none for a template that declares none', async () => {
    const site = JSON.parse((await callTool('projects_create', { workspaceId, name: 'Site', template: 'business-website' })).text!);
    const plain = JSON.parse((await callTool('projects_create', { workspaceId, name: 'Plain', template: 'blank' })).text!);
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const adapter = getWorkspaceAdapter(workspaceId);
    expect((await adapter.getProject(site.id))!.settings.opensIn).toBe('canvas');
    expect((await adapter.getProject(plain.id))!.settings).not.toHaveProperty('opensIn');
  });

  it('refuses an unknown template and says which exist', async () => {
    const out = await callTool('projects_create', { workspaceId, name: 'X', template: 'not-a-template' });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/handlebars-starter/);
  });

  it('refuses a project past the workspace\'s project limit, and creates one below it', async () => {
    const { updateWorkspace } = await import('@/lib/auth/system-database');
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const count = async () => (await getWorkspaceAdapter(workspaceId).listProjects()).length;
    const before = await count();
    updateWorkspace(workspaceId, { max_projects: before });
    try {
      const over = await callTool('projects_create', { workspaceId, name: 'One too many', template: 'blank' });
      expect(over.isError).toBe(true);
      expect(over.text).toContain(`Project limit reached (${before})`);
      expect(await count()).toBe(before);

      updateWorkspace(workspaceId, { max_projects: before + 1 });
      const under = await callTool('projects_create', { workspaceId, name: 'The last one', template: 'blank' });
      expect(under.isError).toBe(false);
      expect(await count()).toBe(before + 1);
    } finally {
      updateWorkspace(workspaceId, { max_projects: 9999 });
    }
  });

  it('refuses to create a project on a read-only grant', async () => {
    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');

    const out = await callTool('projects_create', { workspaceId, name: 'Nope', template: 'blank' });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/projects:write/);
  });

  it('tells an open tab that a created project needs pulling, so it is not left server-only', async () => {
    // Without this the project sits in Server Sync as "server only" and every later change waits
    // for a manual pull. The tab hears it on the account's own channel.
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const seen: { event: string; data: Record<string, unknown> }[] = [];
    const listener = (e: { event: string; data: Record<string, unknown> }) => seen.push(e);
    eventBus.addListener(userId, listener);

    const out = await callTool('projects_create', { workspaceId, name: 'Fresh', template: 'blank' });
    const created = JSON.parse(out.text!);

    eventBus.removeListener(userId, listener);
    const change = seen.find(e => e.event === 'mcp_project_changed');
    expect(change?.data).toMatchObject({ projectId: created.id, projectName: 'Fresh', created: true });
  });

  it('tells an open tab about a file written through bash, but says nothing for a read', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const seen: string[] = [];
    const listener = (e: { event: string }) => seen.push(e.event);
    eventBus.addListener(userId, listener);

    await callTool('bash', { workspaceId, projectId: 'p1', command: 'cat /index.html' });
    expect(seen).not.toContain('mcp_project_changed');

    await callTool('bash', { workspaceId, projectId: 'p1', command: "cat > /new.html << 'EOF'\nx\nEOF" });
    eventBus.removeListener(userId, listener);

    expect(seen).toContain('mcp_project_changed');
  });

  it('refuses bash against a project that is not there', async () => {
    const out = await callTool('bash', { workspaceId, projectId: 'nope', command: 'ls /' });

    expect(out.isError).toBe(true);
  });

  it('refuses to start a task when no workspace tab is attached to take it', async () => {
    // The provider key lives in the browser. With nothing listening the request has nowhere to
    // land, so the tool says so rather than starting something that would stall.
    const out = await callTool('agent_run', { workspaceId, projectId: 'p1', prompt: 'change the heading' });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/tab is open/i);
  });

  it('does not read a task belonging to another account', async () => {
    const { taskManager } = await import('@/lib/server-generate/singleton');
    await taskManager.initialize();
    const theirs = taskManager.createTask('p1', 'someone-else', '', workspaceId);

    const out = await callTool('agent_status', { workspaceId, taskId: theirs });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/No task/);
  });

  it("lists this account's tasks in the workspace, newest first, and can narrow to one project or to running ones", async () => {
    const { taskManager } = await import('@/lib/server-generate/singleton');
    await taskManager.initialize();
    const done = taskManager.createTask('p-list-a', userId, '', workspaceId);
    taskManager.getTask(done)!.prompt = 'make the header blue';
    await taskManager.completeTask(done, 'completed');
    const running = taskManager.createTask('p-list-b', userId, '', workspaceId);
    const theirs = taskManager.createTask('p-list-a', 'someone-else', '', workspaceId);
    const elsewhere = taskManager.createTask('p-list-c', userId, '', 'another-workspace');

    const all = JSON.parse((await callTool('agent_list', { workspaceId })).text!).tasks as { taskId: string; status: string; prompt?: string }[];
    const ids = all.map(t => t.taskId);
    expect(ids).toEqual(expect.arrayContaining([done, running]));
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(elsewhere);
    expect(all.find(t => t.taskId === done)).toMatchObject({ status: 'completed', prompt: 'make the header blue' });

    const one = JSON.parse((await callTool('agent_list', { workspaceId, projectId: 'p-list-a' })).text!).tasks;
    expect(one.map((t: { taskId: string }) => t.taskId)).toEqual([done]);
    const active = JSON.parse((await callTool('agent_list', { workspaceId, active: true })).text!).tasks;
    expect(active.map((t: { taskId: string }) => t.taskId)).toContain(running);
    expect(active.map((t: { taskId: string }) => t.taskId)).not.toContain(done);
    await taskManager.completeTask(running, 'cancelled');
  });

  it("reports the task's real last event id, whatever id the caller asked from", async () => {
    // Asking from a high id is the cheap "status only" call; its answer has to say where to resume.
    const { taskManager, eventBus } = await import('@/lib/server-generate/singleton');
    await taskManager.initialize();
    const mine = taskManager.createTask('p1', userId, '', workspaceId);
    eventBus.emit(mine, 'p1', 'iteration', { n: 1 });
    const last = eventBus.emit(mine, 'p1', 'usage', { tokens: 3 }).id;

    const ahead = JSON.parse((await callTool('agent_status', { workspaceId, taskId: mine, sinceEventId: 999999 })).text!);
    expect(ahead.events).toEqual([]);
    expect(ahead.lastEventId).toBe(last);

    const caughtUp = JSON.parse((await callTool('agent_status', { workspaceId, taskId: mine, sinceEventId: last })).text!);
    expect(caughtUp.lastEventId).toBe(last);
  });

  it('creates an unpublished deployment and turns analytics on without publishing it', async () => {
    const created = JSON.parse((await callTool('deployments_create', {
      workspaceId, projectId: 'p1', name: 'Live',
    })).text!);
    expect(created).toMatchObject({ name: 'Live', projectId: 'p1', published: false });

    const updated = JSON.parse((await callTool('deployments_update', {
      workspaceId, deploymentId: created.id, analyticsEnabled: true,
    })).text!);
    expect(updated).toMatchObject({ id: created.id, published: false, analyticsEnabled: true });

    const listed = JSON.parse((await callTool('deployments_list', { workspaceId })).text!);
    expect(listed).toEqual([expect.objectContaining({
      id: created.id, published: false, analyticsEnabled: true, databaseEnabled: false,
    })]);
  });

  it('lists projects without reading their thumbnails, and keeps its shape', async () => {
    // The projects table is mostly base64 `preview_image`: measured at 2.0MB of thumbnails against
    // 8.4KB of metadata on a real workspace, and this tool keeps four fields per project and
    // discards the rest. Reading the rows whole cost 2.77MB per call.
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const adapter = getWorkspaceAdapter(workspaceId);
    const newest = new Date(Date.now() + 60_000);
    await adapter.createProject({
      id: 'p2', name: 'Thumbnailed', createdAt: newest, updatedAt: newest,
      settings: { runtime: 'react' }, previewImage: 'data:image/png;base64,' + 'A'.repeat(50_000),
    } as never);

    const out = await callTool('projects_list', { workspaceId });
    const listed = JSON.parse(out.text!);

    expect(out.isError).toBe(false);
    // Still a bare array: wrapping it would break every client that reads this as a list.
    expect(Array.isArray(listed)).toBe(true);
    // Newest first, four fields, and the runtime read through the same normalisation as before.
    expect(listed[0]).toEqual({
      id: 'p2', name: 'Thumbnailed', runtime: 'react', updatedAt: newest.toISOString(),
    });
    expect(Object.keys(listed[0]).sort()).toEqual(['id', 'name', 'runtime', 'updatedAt']);
    // The thumbnail never reaches the response.
    expect(out.text).not.toContain('AAAA');
    // A project whose settings name a runtime still reports it; the fallback covers the rest.
    expect(listed.find((p: { id: string }) => p.id === 'p1')).toMatchObject({ runtime: 'static' });
  });

  it('accepts a number a client marshalled as a string', async () => {
    // Claude Code sent `limit: "3"` for an argument typed as a number, and the call was refused
    // before it reached the tool. Booleans stay strict: "false" must not read as true.
    const out = await callTool('projects_list', { workspaceId, limit: '1' as unknown as number });

    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text!)).toHaveLength(1);
  });

  it('caps a very long project list rather than returning it whole', async () => {
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const adapter = getWorkspaceAdapter(workspaceId);
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      await adapter.createProject({ id: `bulk${i}`, name: `Bulk ${i}`, createdAt: now, updatedAt: now, settings: {} } as never);
    }

    const out = await callTool('projects_list', { workspaceId, limit: 5 });
    const listed = JSON.parse(out.text!);

    expect(listed).toHaveLength(5);
  });

  it('does not let a read-only grant write through a pipe', async () => {
    // The gate reads the command the shell is about to run. A pipeline is several commands to the
    // shell, so a write in a later stage reached the VFS under a grant that carries only
    // `projects:read`, and nothing announced the change because it did not look like a write.
    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');

    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'ls / | rm /index.html' });

    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const survivors = (await getWorkspaceAdapter(workspaceId).listFiles('p1')).map(f => f.path);
    expect(survivors).toContain('/index.html');
    expect(out.text).toMatch(/read-only|not granted/i);
  });

  it('refuses to unpublish a deployment that is not in the workspace', async () => {
    const out = await callTool('deployments_unpublish', { workspaceId, deploymentId: 'nope' });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not found/i);
  });

  it('runs SQL on a deployment only after the database is enabled', async () => {
    const created = JSON.parse((await callTool('deployments_create', {
      workspaceId, projectId: 'p1', name: 'Data',
    })).text!);

    const refusedSql = await callTool('deployments_sql', {
      workspaceId, deploymentId: created.id, sql: 'CREATE TABLE items (id TEXT)',
    });
    expect(refusedSql.isError).toBe(true);
    expect(refusedSql.text).toMatch(/databaseEnabled:true/);

    await callTool('deployments_update', { workspaceId, deploymentId: created.id, databaseEnabled: true });
    const create = await callTool('deployments_sql', {
      workspaceId, deploymentId: created.id, sql: 'CREATE TABLE items (id TEXT)',
    });
    expect(create.isError).toBe(false);

    await callTool('deployments_sql', {
      workspaceId, deploymentId: created.id, sql: "INSERT INTO items (id) VALUES ('a')",
    });
    const select = await callTool('deployments_sql', {
      workspaceId, deploymentId: created.id, sql: 'SELECT id FROM items',
    });
    expect(JSON.parse(select.text!)).toMatchObject({ rows: [{ id: 'a' }] });
  });

  it('creates, lists and deletes an edge function, and never returns a secret value', async () => {
    const upsert = await callTool('backend_upsert', {
      workspaceId, projectId: 'p1', kind: 'edge', name: 'hello', code: 'return new Response("ok")', method: 'GET',
    });
    expect(upsert.isError).toBe(false);
    expect(JSON.parse(upsert.text!)).toMatchObject({ kind: 'edge', name: 'hello', method: 'GET', enabled: true });

    const secret = await callTool('backend_upsert', {
      workspaceId, projectId: 'p1', kind: 'secret', name: 'STRIPE', value: 'sk-live-secret',
    });
    expect(secret.isError).toBe(false);
    expect(secret.text).not.toContain('sk-live-secret');

    const listed = JSON.parse((await callTool('backend_list', { workspaceId, projectId: 'p1' })).text!);
    expect(listed.edge).toEqual([expect.objectContaining({ name: 'hello', code: 'return new Response("ok")' })]);
    expect(listed.secrets).toEqual([expect.objectContaining({ name: 'STRIPE', hasValue: true })]);
    expect(JSON.stringify(listed)).not.toContain('sk-live-secret');

    const deleted = await callTool('backend_delete', { workspaceId, projectId: 'p1', kind: 'edge', name: 'hello' });
    expect(JSON.parse(deleted.text!)).toEqual({ deleted: 'edge', name: 'hello' });
    const after = JSON.parse((await callTool('backend_list', { workspaceId, projectId: 'p1' })).text!);
    expect(after.edge).toEqual([]);
  });

  it('refuses backend writes on a read-only grant', async () => {
    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');

    const out = await callTool('backend_upsert', {
      workspaceId, projectId: 'p1', kind: 'edge', name: 'nope', code: 'return new Response("x")',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/projects:write/);
  });

  it('tells an open tab about a backend function written through MCP', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const seen: string[] = [];
    const listener = (e: { event: string }) => seen.push(e.event);
    eventBus.addListener(userId, listener);

    await callTool('backend_upsert', {
      workspaceId, projectId: 'p1', kind: 'server', name: 'fmt', code: 'return args',
    });
    eventBus.removeListener(userId, listener);

    expect(seen).toContain('mcp_project_changed');
  });

  it('tells an open tab about a bash write whose redirect is written against its path', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const seen: string[] = [];
    const listener = (e: { event: string }) => seen.push(e.event);
    eventBus.addListener(userId, listener);

    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'echo hi>/index.html' });
    eventBus.removeListener(userId, listener);

    expect(out.isError, out.text).toBe(false);
    expect(seen).toContain('mcp_project_changed');
  });

  it('styles an element through bash on the server, matching its selector without a browser', async () => {
    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'style /index.html h1 color=red' });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toMatch(/^Styled <h1> \/index\.html:\d+:\d+ \(marker @[a-z0-9]{8}\)\./);
    const css = await callTool('files_read', { workspaceId, projectId: 'p1', path: '/overrides.css' });
    expect(JSON.parse(css.text!).content).toMatch(/\[data-osw-id="[a-z0-9]{8}"\]\[data-osw-id\] \{\n {2}color: red;\n\}/);
  });
});

describe('the page tools, answered by an open tab', () => {
  it('shows a page as the tab rendered it: a summary, then the images', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const { claimRenderRequest, settleRenderRequest } = await import('@/lib/server-generate/render-requests');
    const jobs: Record<string, unknown>[] = [];
    const tab = (e: { event: string; data: Record<string, unknown> }) => {
      if (e.event !== 'render_requested') return;
      jobs.push(e.data.job as Record<string, unknown>);
      const id = e.data.requestId as string;
      claimRenderRequest(id, userId);
      settleRenderRequest(id, userId, {
        ok: true, kind: 'screenshot', width: 375, height: 667, pageHeight: 900,
        images: [{ mediaType: 'image/jpeg', data: 'QUJD', width: 375, height: 667, region: { x: 0, y: 0, w: 375, h: 667 } }],
      });
    };
    eventBus.addListener(userId, tab);
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'preview_screenshot', arguments: { workspaceId, projectId: 'p1', page: 'about', width: 375 } } });
    eventBus.removeListener(userId, tab);
    expect(jobs).toEqual([{ kind: 'screenshot', projectId: 'p1', page: '/about', width: 375, full: false }]);
    const content = out.result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(JSON.parse(content[0].text!)).toMatchObject({ page: 'about', width: 375, pageHeight: 900, images: [{ x: 0, y: 0, w: 375, h: 667 }] });
    expect(content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  });

  it('tells the tab about a bash write once, before the render that reads it, and not for a render with nothing new', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const { claimRenderRequest, settleRenderRequest } = await import('@/lib/server-generate/render-requests');
    const seen: string[] = [];
    const tab = (e: { event: string; data: Record<string, unknown> }) => {
      seen.push(e.event);
      if (e.event !== 'render_requested') return;
      const job = e.data.job as { page: string; width: number; target?: string; props?: string[] };
      const id = e.data.requestId as string;
      claimRenderRequest(id, userId);
      // Every property asked about is in force, held by the element's own rule.
      settleRenderRequest(id, userId, {
        ok: true, kind: 'inspect',
        report: {
          page: job.page, width: job.width, height: 900, pageHeight: 900, matches: 1,
          node: { tag: 'h1', classes: [], src: '/index.html:0', marker: job.target?.startsWith('@') ? job.target.slice(1) : null, box: { x: 0, y: 0, w: 10, h: 10 } },
          styles: (job.props ?? []).map((property) => ({ property, computed: 'red', declared: { value: 'red', selector: `[data-osw-id="${job.target?.slice(1)}"][data-osw-id]`, origin: '/overrides.css', ours: true } })),
        },
      });
    };
    eventBus.addListener(userId, tab);
    const out = await callTool('bash', { workspaceId, projectId: 'p1', command: 'inspect /index.html h1 && style /index.html h1 color=red' });
    eventBus.removeListener(userId, tab);

    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain('Checked on /index.html at 1440 px: in force.');
    expect(seen).toEqual(['render_requested', 'mcp_project_changed', 'render_requested']);
  });

  it('says so when no tab is open to render', async () => {
    const out = await callTool('preview_screenshot', { workspaceId, projectId: 'p1' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no OSW Studio tab is open/);
  });

  it('reports the newest selection the open tabs have', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const { answerSelectionRequest } = await import('@/lib/server-generate/render-requests');
    const tab = (e: { event: string; data: Record<string, unknown> }) => {
      if (e.event !== 'selection_requested') return;
      answerSelectionRequest(e.data.requestId as string, userId, {
        projectId: 'p1', projectName: 'Site', surface: 'canvas', page: '/index.html', width: 375, tag: 'h1',
        domPath: 'body > h1', source: '/index.html:1:1', snippet: '<h1>Hi</h1>', selectedAt: 5,
      });
    };
    const older = (e: { event: string; data: Record<string, unknown> }) => {
      if (e.event !== 'selection_requested') return;
      answerSelectionRequest(e.data.requestId as string, userId, {
        projectId: 'p1', projectName: 'Site', surface: 'preview', page: '/about.html', width: 1440, tag: 'p',
        domPath: 'body > p', source: '/about.html:2:1', snippet: '<p>Older</p>', selectedAt: 1,
      });
    };
    eventBus.addListener(userId, older);
    eventBus.addListener(userId, tab);
    const out = await callTool('canvas_selection', { workspaceId, projectId: 'p1' });
    eventBus.removeListener(userId, tab);
    eventBus.removeListener(userId, older);
    const selection = JSON.parse(out.text!).selection;
    expect(selection).toMatchObject({ projectId: 'p1', surface: 'canvas', width: 375, source: '/index.html:1:1', selectedAt: 5 });
    // Where an outside agent meets `style`: with this element filled in, as the in-app agent's message has it.
    const { styleHint } = await import('@/lib/direct-edit/style-hint');
    expect(selection.restyle).toBe(styleHint('/index.html:1:1', 375));
    expect(selection.restyle).toMatch(/style \/index\.html:1:1 .*--width 375/);
  });

  it('reports only a selection in a project of the granted workspace, however new another tab\'s is', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const { answerSelectionRequest } = await import('@/lib/server-generate/render-requests');
    const answering = (projectId: string, selectedAt: number) => (e: { event: string; data: Record<string, unknown> }) => {
      if (e.event !== 'selection_requested') return;
      answerSelectionRequest(e.data.requestId as string, userId, {
        projectId, projectName: 'Private', surface: 'preview', tag: 'h1', domPath: 'body > h1',
        snippet: '<h1>Private</h1>', selectedAt,
      });
    };
    const elsewhere = answering('p-in-another-workspace', 9);
    const here = answering('p1', 5);
    eventBus.addListener(userId, elsewhere);
    eventBus.addListener(userId, here);
    const both = await callTool('canvas_selection', { workspaceId });
    eventBus.removeListener(userId, here);
    const foreignOnly = await callTool('canvas_selection', { workspaceId });
    eventBus.removeListener(userId, elsewhere);

    expect(JSON.parse(both.text!).selection).toMatchObject({ projectId: 'p1', selectedAt: 5 });
    expect(JSON.parse(foreignOnly.text!).selection).toBeNull();
    expect(foreignOnly.text).not.toContain('Private');
  });

  // The description goes into every client's context for every project, so it teaches the commands
  // and leaves what a user's hand edits put in a project to where it is met: the selection above,
  // the header of /overrides.css, and the note the write guard puts under a command's reply.
  it('describes bash without a glossary of the app\'s attributes or a lesson on style', async () => {
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const bash = (out.result.tools as { name: string; description: string }[]).find(t => t.name === 'bash')!.description;
    expect(bash).toContain('inspect /index.html [element] [--width N]');
    expect(bash).toMatch(/Commands: .*\bstyle\b/);
    for (const word of ['data-osw-block', 'data-osw-lock', 'data-osw-frame', 'overrides.css', 'style <element>']) expect(bash, word).not.toContain(word);
  });
});


describe('the duplicate tools', () => {
  const store = async () => (await import('@/lib/vfs/adapters/server')).getWorkspaceAdapter(workspaceId);
  const answer = (out: { text?: string }) => JSON.parse(out.text!);

  it('copies a project whole, on its own ids, and leaves the original alone', async () => {
    const adapter = await store();
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const now = new Date();
    await adapter.createFile({
      id: 'f2', projectId: 'p1', path: '/logo.png', name: 'logo.png', type: 'image', content: bytes.buffer,
      mimeType: 'image/png', size: bytes.length, createdAt: now, updatedAt: now, metadata: {},
    });
    await callTool('backend_upsert', { workspaceId, projectId: 'p1', kind: 'edge', name: 'hello', code: 'return 1', method: 'GET' });
    await callTool('backend_upsert', { workspaceId, projectId: 'p1', kind: 'server', name: 'helper', code: 'return 2' });
    await callTool('backend_upsert', { workspaceId, projectId: 'p1', kind: 'secret', name: 'KEY', value: 'v1' });
    await callTool('backend_upsert', { workspaceId, projectId: 'p1', kind: 'schedule', name: 'daily', cronExpression: '0 8 * * *', functionName: 'hello' });

    const out = await callTool('projects_duplicate', { workspaceId, projectId: 'p1' });
    expect(out.isError).toBe(false);
    const copy = answer(out);
    expect(copy).toMatchObject({ name: 'Site (Copy)', copiedFrom: 'p1', runtime: 'static', files: ['/index.html', '/logo.png'] });
    expect(copy.id).not.toBe('p1');

    const logo = (await adapter.listFiles(copy.id)).find(f => f.path === '/logo.png')!;
    expect([...new Uint8Array(logo.content as ArrayBuffer)]).toEqual([...bytes]);
    const [edge] = await adapter.listEdgeFunctions(copy.id);
    const [original] = await adapter.listEdgeFunctions('p1');
    expect(edge).toMatchObject({ name: 'hello', code: 'return 1' });
    expect(edge.id).not.toBe(original.id);
    expect((await adapter.listServerFunctions(copy.id)).map(f => f.name)).toEqual(['helper']);
    expect(await adapter.listSecrets(copy.id)).toEqual([expect.objectContaining({ name: 'KEY', value: 'v1' })]);
    expect((await adapter.listScheduledFunctions(copy.id))[0].functionId).toBe(edge.id);
    expect((await adapter.listScheduledFunctions('p1'))[0].functionId).toBe(original.id);

    expect(answer(await callTool('projects_duplicate', { workspaceId, projectId: 'p1' })).name).toBe('Site (Copy 2)');
    expect(answer(await callTool('projects_duplicate', { workspaceId, projectId: 'p1', name: 'Mine' })).name).toBe('Mine');
  });

  it('refuses a project copy past the workspace limit, or without the write scope', async () => {
    const { updateWorkspace } = await import('@/lib/auth/system-database');
    updateWorkspace(workspaceId, { max_projects: 1 });
    const limited = await callTool('projects_duplicate', { workspaceId, projectId: 'p1' });
    expect(limited.isError).toBe(true);
    expect(limited.text).toMatch(/Project limit reached \(1\)/);
    expect((await store()).listProjectSummaries()).toHaveLength(1);

    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');
    for (const [name, args] of [
      ['projects_duplicate', { projectId: 'p1' }], ['templates_duplicate', { templateId: 't' }], ['skills_duplicate', { skillId: 's' }],
    ] as const) {
      const out = await callTool(name, { workspaceId, ...args });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/projects:write/);
    }
    expect((await callTool('skills_list', { workspaceId })).isError).toBe(false);
    expect((await callTool('templates_list', { workspaceId })).isError).toBe(false);
  });

  it('copies a custom template and refuses a built-in one', async () => {
    const adapter = await store();
    await adapter.saveCustomTemplate({
      id: 't1', name: 'Shop', description: 'd', version: '2.0.0', directories: ['/css'],
      files: [{ path: '/index.html', content: '<p>x</p>' }], assets: [], metadata: { license: 'mit', tags: ['a'] }, importedAt: new Date(0),
      runtime: 'react', backendFeatures: { secrets: [{ name: 'KEY' }] },
    });
    expect(answer(await callTool('templates_list', { workspaceId }))).toEqual([expect.objectContaining({ id: 't1', name: 'Shop' })]);

    const copy = answer(await callTool('templates_duplicate', { workspaceId, templateId: 't1' }));
    expect(copy).toMatchObject({ name: 'Shop (Copy)', copiedFrom: 't1', files: 1 });
    expect(await adapter.getCustomTemplate(copy.id)).toMatchObject({
      version: '2.0.0', directories: ['/css'], files: [{ path: '/index.html', content: '<p>x</p>' }], metadata: { license: 'mit', tags: ['a'] },
      runtime: 'react', backendFeatures: { secrets: [{ name: 'KEY' }] },
    });
    expect((await adapter.getCustomTemplate('t1'))!.name).toBe('Shop');

    const builtIn = await callTool('templates_duplicate', { workspaceId, templateId: 'blank' });
    expect(builtIn.isError).toBe(true);
    expect(builtIn.text).toMatch(/projects_create/);
  });

  it('copies a skill under a new name in its frontmatter, built-in ones included', async () => {
    const adapter = await store();
    const now = new Date();
    const content = '---\nname: audit\ndescription: "Check: pages"\nlicense: MIT\n---\n\nname: stays in the body\n';
    await adapter.createSkill({ id: 'audit', name: 'audit', description: 'Check: pages', content, markdown: 'name: stays in the body', createdAt: now, updatedAt: now });

    expect(answer(await callTool('skills_duplicate', { workspaceId, skillId: 'audit' })).id).toBe('audit-copy');
    const copy = (await adapter.getSkill('audit-copy'))!;
    expect(copy).toMatchObject({ name: 'audit-copy', description: 'Check: pages', isBuiltIn: false });
    expect(copy.content).toBe(content.replace('name: audit', 'name: audit-copy'));
    expect(answer(await callTool('skills_duplicate', { workspaceId, skillId: 'audit' })).id).toBe('audit-copy-2');

    const taken = await callTool('skills_duplicate', { workspaceId, skillId: 'audit', name: 'audit' });
    expect(taken.isError).toBe(true);
    // Refused for the name, before the database's unique id would turn it into a storage error.
    expect(taken.text).toMatch(/named audit already exists/);

    const listed = answer(await callTool('skills_list', { workspaceId })) as { id: string; builtIn: boolean }[];
    const builtIn = listed.find(s => s.builtIn)!;
    expect(listed.filter(s => !s.builtIn).map(s => s.id).sort()).toEqual(['audit', 'audit-copy', 'audit-copy-2']);
    const fromBuiltIn = answer(await callTool('skills_duplicate', { workspaceId, skillId: builtIn.id, name: 'my-copy' }));
    expect(fromBuiltIn.id).toBe('my-copy');
    expect(await adapter.getSkill('my-copy')).toMatchObject({ name: 'my-copy', isBuiltIn: false });
  });

  it('copies a deployment\'s settings and none of its address, review or publish state', async () => {
    const adapter = await store();
    const { id } = answer(await callTool('deployments_create', { workspaceId, projectId: 'p1', name: 'Live' }));
    const source = (await adapter.getDeployment(id))!;
    await adapter.updateDeployment({
      ...source,
      slug: 'live', customDomain: 'example.test', underConstruction: true, databaseEnabled: true,
      headScripts: [{ id: 's', name: 'tag', content: 'x', type: 'inline', enabled: true }],
      seo: { title: 'Home' }, review: { enabled: true, passwordHash: 'hash' },
      publishedAt: new Date(), lastPublishedVersion: 4, settingsVersion: 4,
    });

    const out = answer(await callTool('deployments_duplicate', { workspaceId, deploymentId: id }));
    expect(out).toMatchObject({ name: 'Live (Copy)', copiedFrom: id, projectId: 'p1', published: false });
    const copy = (await adapter.getDeployment(out.id))!;
    expect(copy).toMatchObject({
      underConstruction: true, databaseEnabled: true, seo: { title: 'Home' }, settingsVersion: 1,
      headScripts: [expect.objectContaining({ name: 'tag' })],
    });
    expect(copy.slug ?? null).toBeNull();
    expect(copy.customDomain ?? null).toBeNull();
    expect(copy.publishedAt ?? null).toBeNull();
    expect(copy.lastPublishedVersion ?? null).toBeNull();
    expect(copy.review?.enabled).not.toBe(true);
    expect(copy.review?.passwordHash).toBeUndefined();

    const sql = (query: string) => callTool('deployments_sql', { workspaceId, deploymentId: out.id, sql: query });
    expect((await sql('CREATE TABLE notes (body TEXT)')).isError).toBe(false);
    expect((await sql("INSERT INTO notes VALUES ('hi')")).isError).toBe(false);
    expect(answer(await sql('SELECT body FROM notes')).rows).toEqual([{ body: 'hi' }]);
  });
});
