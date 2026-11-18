import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';

/**
 * `files_write` over the real route, because what matters is the bytes that reach the database.
 *
 * `bash` is the only other way a connector writes, and every one of its writes stores text, so a
 * PNG had to be smuggled through as a string and came out corrupt when published. A round trip is
 * the assertion that catches that: the same bytes back, not merely a file of the right length.
 */

vi.mock('server-only', () => ({}));

let dir: string;
let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
const TOKEN = 'dev-token-for-tests';

// A one-pixel PNG: a real header, and bytes that are not valid UTF-8.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function seed() {
  const { createUser, createWorkspace } = await import('@/lib/auth/system-database');
  userId = createUser('agent@a.test', 'hash');
  workspaceId = createWorkspace('Agents', userId);
  otherWorkspaceId = createWorkspace('Somebody else', createUser('other@a.test', 'hash'));
  const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
  const adapter = getWorkspaceAdapter(workspaceId);
  await adapter.init();
  const now = new Date();
  await adapter.createProject({ id: 'p1', name: 'Site', createdAt: now, updatedAt: now, settings: { runtime: 'static' } });
}

async function callTool(name: string, args: Record<string, unknown>) {
  const { POST } = await import('@/app/api/mcp/route');
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    authorization: `Bearer ${TOKEN}`,
  });
  const request = new Request('http://localhost/api/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await POST(request as unknown as NextRequest);
  const body = await res.text();
  const line = body.split('\n').find(l => l.startsWith('data: '));
  const message = JSON.parse(line ? line.slice(6) : body);
  return { text: message.result?.content?.[0]?.text as string | undefined, isError: message.result?.isError === true };
}

async function storedBytes(filePath: string): Promise<Uint8Array> {
  const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
  const file = await getWorkspaceAdapter(workspaceId).getFile('p1', filePath);
  const content = file?.content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === 'string') return new TextEncoder().encode(content);
  throw new Error('no content stored');
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-files-write-'));
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

describe('files_write', () => {
  it('stores a PNG byte for byte', async () => {
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/assets/icon.png', content: PNG_BASE64, encoding: 'base64',
    });

    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text!)).toMatchObject({ path: '/assets/icon.png', type: 'image', created: true });

    const expected = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));
    const actual = await storedBytes('/assets/icon.png');
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it('writes text as text', async () => {
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/notes.txt', content: 'plain words',
    });
    expect(out.isError).toBe(false);
    expect(new TextDecoder().decode(await storedBytes('/notes.txt'))).toBe('plain words');
  });

  it('replaces a file that already exists', async () => {
    await callTool('files_write', { workspaceId, projectId: 'p1', path: '/notes.txt', content: 'first' });
    const second = await callTool('files_write', { workspaceId, projectId: 'p1', path: '/notes.txt', content: 'second' });

    expect(second.isError).toBe(false);
    expect(JSON.parse(second.text!).created).toBe(false);
    expect(new TextDecoder().decode(await storedBytes('/notes.txt'))).toBe('second');
  });

  it('puts back a marker a page rewrite left off, and says so in its answer', async () => {
    const page = '<body>\n<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>\n</body>';
    await callTool('files_write', { workspaceId, projectId: 'p1', path: '/index.html', content: page });
    await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/overrides.css', content: '[data-osw-id="h7x2m4qp"][data-osw-id] {\n  color: red;\n}\n',
    });

    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/index.html', content: '<body>\n<h1 class="title">Welcome</h1>\n</body>',
    });

    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text!).note).toContain('It was put back');
    expect(new TextDecoder().decode(await storedBytes('/index.html'))).toContain('<h1 data-osw-id="h7x2m4qp" class="title">');
  });

  it('guards a page sent as base64 as it guards one sent as text, and stores it as text', async () => {
    const page = '<body>\n<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>\n</body>';
    await callTool('files_write', { workspaceId, projectId: 'p1', path: '/index.html', content: page });
    await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/overrides.css', content: '[data-osw-id="h7x2m4qp"][data-osw-id] {\n  color: red;\n}\n',
    });

    const rewrite = Buffer.from('<body>\n<h1 class="title">Welcome</h1>\n</body>').toString('base64');
    const out = await callTool('files_write', { workspaceId, projectId: 'p1', path: '/index.html', content: rewrite, encoding: 'base64' });

    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text!).note).toContain('It was put back');
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const stored = (await getWorkspaceAdapter(workspaceId).getFile('p1', '/index.html'))?.content;
    expect(typeof stored).toBe('string');
    expect(stored).toContain('<h1 data-osw-id="h7x2m4qp" class="title">');
  });

  it('refuses base64 for a text file when the bytes are not UTF-8 text', async () => {
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/index.html', content: PNG_BASE64, encoding: 'base64',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('UTF-8');
  });

  it('answers a write that harms nothing without a note', async () => {
    const out = await callTool('files_write', { workspaceId, projectId: 'p1', path: '/index.html', content: '<h1>Plain</h1>' });
    expect(JSON.parse(out.text!)).not.toHaveProperty('note');
  });

  it('refuses base64 that has been mangled rather than storing a short file', async () => {
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/assets/icon.png', content: 'not*valid*base64!!', encoding: 'base64',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('valid base64');
  });

  it('refuses a path that climbs out of the project', async () => {
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/a/../../etc/passwd', content: 'x',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('not a path inside the project');
  });

  it('refuses text content for a binary path', async () => {
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/assets/logo.png', content: '<svg/>', encoding: 'utf8',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("encoding: 'base64'");
  });

  it('refuses a project in another workspace', async () => {
    const out = await callTool('files_write', {
      workspaceId: otherWorkspaceId, projectId: 'p1', path: '/notes.txt', content: 'x',
    });
    expect(out.isError).toBe(true);
  });

  it('refuses a connection without projects:write', async () => {
    vi.stubEnv('MCP_DEV_SCOPES', 'projects:read');
    const out = await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/notes.txt', content: 'x',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('projects:write');
  });
});

describe('files_read', () => {
  it('returns a PNG byte for byte through base64', async () => {
    await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/assets/icon.png', content: PNG_BASE64, encoding: 'base64',
    });

    const out = await callTool('files_read', {
      workspaceId, projectId: 'p1', path: '/assets/icon.png', encoding: 'base64',
    });

    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text!);
    expect(body).toMatchObject({ path: '/assets/icon.png', type: 'image', encoding: 'base64' });
    expect(body.truncated).toBeUndefined();
    // The bytes the client gets back are the bytes it sent, not merely the same length.
    expect(Array.from(Buffer.from(body.content, 'base64'))).toEqual(Array.from(Buffer.from(PNG_BASE64, 'base64')));
  });

  it('reads text as text', async () => {
    await callTool('files_write', { workspaceId, projectId: 'p1', path: '/notes.txt', content: 'plain words' });
    const out = await callTool('files_read', { workspaceId, projectId: 'p1', path: '/notes.txt' });

    expect(JSON.parse(out.text!)).toMatchObject({ content: 'plain words', size: 11, encoding: 'utf8' });
  });

  it('refuses to hand back bytes as text', async () => {
    await callTool('files_write', {
      workspaceId, projectId: 'p1', path: '/assets/icon.png', content: PNG_BASE64, encoding: 'base64',
    });
    const out = await callTool('files_read', { workspaceId, projectId: 'p1', path: '/assets/icon.png' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain("encoding: 'base64'");
  });

  it('caps a long file and reports the real size', async () => {
    const long = 'a'.repeat(5000);
    await callTool('files_write', { workspaceId, projectId: 'p1', path: '/long.txt', content: long });

    const out = await callTool('files_read', {
      workspaceId, projectId: 'p1', path: '/long.txt', maxBytes: 100,
    });

    const body = JSON.parse(out.text!);
    expect(body.content).toHaveLength(100);
    expect(body.size).toBe(5000);
    expect(body.truncated).toBe(true);
    expect(body.note).toContain('5000');
  });

  it('says which file is missing', async () => {
    const out = await callTool('files_read', { workspaceId, projectId: 'p1', path: '/nope.txt' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('No file at /nope.txt');
  });

  it('refuses a path that climbs out of the project', async () => {
    const out = await callTool('files_read', { workspaceId, projectId: 'p1', path: '/a/../../etc/passwd' });
    expect(out.isError).toBe(true);
  });
});
