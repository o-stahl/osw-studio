import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getWorkspaceAdapter } from '@/lib/vfs/adapters/server';
import { recordMcpActivity } from './store';
import { ensureDeploymentRoute, verifyWorkspaceAccess } from '@/lib/auth/system-database';
import { isSafeVirtualPath } from '@/lib/vfs/path-safety';
import { isTextExtension } from '@/lib/vfs/types';
import { deploymentPublicUrl } from '@/lib/api/deployment-url';
import type { McpPrincipal } from './auth';
import { ROLE_FOR_SCOPE, type McpScope } from './scopes';
import { commandLineWrites } from '@/lib/llm/write-scope';
import { createTransfer, MAX_UPLOAD_BYTES, TRANSFER_TTL_MS } from './transfers';
import type { Deployment, EdgeFunction, ScheduledFunction, Secret, ServerFunction } from '@/lib/vfs/types';

/**
 * Files are worked on through the same single `bash` tool the in-app agent has. The project
 * deliberately runs on one tool (the `shell`→`bash` rename finished that move), so a parallel set
 * of read_file/write_file tools here would be a second interface onto the same file system, with
 * its own quirks to learn and its own drift to chase.
 */
const BASH_DESCRIPTION = `Run a command against a project's files, exactly as the OSW Studio agent does.

Commands: cat, head, tail, ls, tree, grep, rg, find, wc, sort, uniq, tr, echo, mkdir, rmdir, touch, mv, cp, rm, sed, ss, curl, runtime.
Pipes, redirects (> file, >> file), heredocs (<< 'EOF'), chaining (&&, ||, ;) and brace expansion are supported.

curl localhost/ renders a page through the project's compiler, which is how to check output without publishing.

Not available here: build, python, python3 and lua need the browser runtime, and sqlite3 needs a deployment selected in the app. Use deployments_sql for a deployment's database. status is the in-app agent's task-completion command and does nothing for an outside client.

Read a file: cat /index.html
Create a file: cat > /about.html << 'EOF'\ncontent\nEOF
Edit a file: ss /index.html << 'EOF'\nsearch\n=======\nreplacement\nEOF

Reading needs projects:read; anything that writes needs projects:write.`;

/**
 * The MCP server an outside agent talks to. One instance per request (the transport is
 * stateless), built for the principal the bearer token resolved to. Every tool is a thin call
 * to the same workspace adapter the app's own routes use, behind the same role check.
 *
 * Tools that need no provider API key run server-side here. The agent tools are the exception:
 * a provider key lives in the browser's localStorage and is never stored server-side, so a task
 * on a cloud provider cannot be started from here. See `agent_run` for what it does instead.
 */

class ToolRefused extends Error {}
/**
 * What a client is told on connect, before it has called anything.
 *
 * Nothing else orients one: the server exposes tools and no resources or prompts, so a client that
 * is not told these things works them out by trial, or misses them. Kept to the four facts that
 * change what a client does, because this goes into every session's context.
 */
const SERVER_INSTRUCTIONS = [
  'This workspace holds web projects: their files, their backend functions, and the deployments that serve them.',
  '',
  'Use `bash` for a project\'s files, with the commands you would expect: `ls`, `tree`, `cat`, `rg`, `sed`, `ss`, pipes, redirects and heredocs. For images, fonts, audio and video, which `bash` cannot carry, `files_upload_url` and `files_download_url` give a one-time URL to move the file with your own `curl`, so its bytes never pass through you; `files_write` and `files_read` carry small files inline as base64 when there is no shell to run `curl`.',
  '',
  'A project may carry `/.PROMPT.md`, instructions from whoever set it up about how it is meant to be worked on. Read it before changing anything, and leave the file itself alone.',
  '',
  '`curl localhost/` renders a page through the project\'s own compiler, so you can check your work without publishing. Publishing is `deployments_publish`, a separate and deliberate step.',
].join('\n');


/** A base64 body decodes to at most this per call, whatever the type's own limit allows. */
const MAX_WRITE_BYTES = 10 * 1024 * 1024;

/**
 * A read answers with at most this much content, and defaults to far less.
 *
 * Writing sends bytes the caller already has; reading puts them in the caller's context, where
 * base64 costs a third more again. So the default is small enough to be safe to call blind, and
 * `maxBytes` is there for a caller that knows what it is asking for.
 */
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_READ_BYTES = 256 * 1024;

const FILES_READ_DESCRIPTION = [
  'Read one file from a project.',
  "Text comes back as encoding 'utf8'; anything binary (images, fonts, audio, video) needs 'base64',",
  'which `bash cat` refuses outright.',
  `Answers with the path, type, mimeType and size, and up to ${DEFAULT_READ_BYTES / 1024}KB of content unless maxBytes asks for more,`,
  'saying so when there is more. For text, `bash` (cat, head, tail, rg) is usually the better tool.',
  'To save a binary file to disk, use files_download_url: base64 here lands in your context, a third larger than the file.',
  'Needs projects:read.',
].join(' ');

const FILES_WRITE_DESCRIPTION = [
  'Write one file to a project, replacing it if it already exists.',
  "Text goes as encoding 'utf8'; anything binary (images, fonts, audio, video) as 'base64',",
  'which `bash` cannot do because every way it writes stores text.',
  'For a file on your disk, use files_upload_url instead: base64 here has to be written out by you, which is slow and costly beyond a few KB.',
  `Up to ${MAX_WRITE_BYTES / 1024 / 1024}MB per call, and the project's own per-type limit still applies.`,
  'Needs projects:write.',
].join(' ');

const FILES_UPLOAD_URL_DESCRIPTION = [
  'Get a one-time URL that stores a file from your disk in a project, for images, fonts, audio, video or any file too large to write out.',
  'This call moves no bytes: run the `command` it returns (curl -T, a PUT) with your local file, and that request stores it.',
  "The PUT answers with the stored file's path, type, size and sha256: compare the sha256 with your local file's, and no read-back is needed.",
  `The URL works once, for ${TRANSFER_TTL_MS / 60000} minutes, for this path only; up to ${MAX_UPLOAD_BYTES / 1024 / 1024}MB, and the project's per-type limit still applies.`,
  'A file already at the path is refused unless overwrite is true.',
  'Refer to it by its root path (/assets/font.woff2), in CSS url() as well as HTML: publishing rewrites root paths for whatever address the site is served at, while an older preview resolves a relative url() in CSS from the project root and misses the file.',
  'Needs projects:write.',
].join(' ');

const FILES_DOWNLOAD_URL_DESCRIPTION = [
  "Get a one-time URL that answers with a project file's bytes, to save it to your disk with the `command` it returns (curl -o).",
  "The response carries the file's sha256 in an x-content-sha256 header.",
  `The URL works once, for ${TRANSFER_TTL_MS / 60000} minutes. Needs projects:read.`,
].join(' ');

/**
 * Points a `bash` caller at the file tools when the shell refuses a binary file.
 *
 * The shell is shared with the in-app agent, which has no such tools, so its own messages cannot
 * name them. A model that tries `cat` or `>` on an image first learns from this answer, not from
 * the descriptions it skimmed.
 */
const BINARY_HINTS: Array<[RegExp, string]> = [
  [/binary or non-text file/, 'To save a binary file to your disk, use files_download_url (or files_read with base64 if you cannot run curl).'],
  [/files hold bytes and the shell writes text/, 'To store a file from your disk, use files_upload_url (or files_write with base64 if you cannot run curl).'],
];

function withBinaryHints(output: string): string {
  const hints = BINARY_HINTS.filter(([pattern]) => pattern.test(output)).map(([, hint]) => hint);
  return hints.length ? `${output}\n\n${hints.join('\n')}` : output;
}

/** A shell-quoted string, for the ready-to-run commands the URL tools return. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decodes base64 to bytes, or returns null rather than guessing.
 *
 * `Buffer.from(s, 'base64')` and `atob` both discard characters outside the alphabet, so a mangled
 * upload decodes to a shorter file that looks like a success and publishes as a corrupt image.
 * Re-encoding the result and comparing catches that. Base64 cut short on a four-character boundary
 * is still valid and is not caught here; the size in the answer is how a caller sees it. Line
 * wrapping is allowed, since a client piping `base64` output sends it wrapped.
 */
function decodeBase64Strict(value: string): ArrayBuffer | null {
  const clean = value.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;

  const buf = Buffer.from(clean, 'base64');
  const unpadded = (v: string) => v.replace(/=+$/, '');
  if (unpadded(buf.toString('base64')) !== unpadded(clean)) return null;

  // Sliced, because a Buffer can be a view into a larger pooled allocation and handing the whole
  // pool to the VFS would store unrelated memory alongside the file.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}


/**
 * The events worth handing to an outside agent. The token-by-token deltas are left out: they are
 * the same content the completed messages carry, at a hundred times the volume.
 */
const REPORTED_EVENTS = new Set([
  'iteration', 'toolCalls', 'tool_status', 'tool_result', 'conversation_message',
  'task_complete', 'api_stopped', 'exit_reason', 'stopped', 'usage', 'waiting',
]);

/** Trim an event's payload to what reads usefully in a transcript. */
function summarise(event: string, data: Record<string, unknown>): unknown {
  if (event === 'conversation_message') {
    const message = data.message as { role?: string; content?: unknown } | undefined;
    const content = typeof message?.content === 'string' ? message.content : '';
    return { role: message?.role, content: content.length > 2000 ? `${content.slice(0, 2000)}…` : content };
  }
  if (event === 'usage') return { totalCost: data.totalCost, promptTokens: data.promptTokens, completionTokens: data.completionTokens };
  const { sourceProjectId: _drop, ...rest } = data;
  return rest;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function refused(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

async function bumpProject(
  adapter: Awaited<ReturnType<typeof getWorkspaceAdapter>>,
  projectId: string,
) {
  const project = await adapter.getProject(projectId);
  if (project) adapter.bumpRevision(projectId, project.revision ?? 0);
}

/** Tell the open tab a deployment changed, so the Deployments page re-reads instead of going stale. */
function notifyDeployment(
  principal: McpPrincipal,
  deploymentId: string,
  deploymentName: string,
  action: 'created' | 'published' | 'unpublished' | 'updated',
) {
  void import('./notify').then(({ notifyDeploymentChanged }) => {
    notifyDeploymentChanged({
      userId: principal.userId,
      deploymentId,
      deploymentName,
      action,
      clientLabel: principal.clientLabel,
    });
  }).catch(() => { /* a notice is not worth failing the call it describes */ });
}

async function notifyProject(principal: McpPrincipal, projectId: string) {
  const adapter = getWorkspaceAdapter(principal.workspaceId);
  const project = await adapter.getProject(projectId);
  const { notifyProjectChanged } = await import('./notify');
  notifyProjectChanged({
    userId: principal.userId,
    projectId,
    projectName: project?.name ?? projectId,
    created: false,
    clientLabel: principal.clientLabel,
  });
}

export function createOswMcpServer(principal: McpPrincipal, instance?: { origin?: string; baseUrl?: string }): McpServer {
  // A person may have several OSW Studio instances: the hosted one, server mode on their machine,
  // and the desktop app. All of them answer as `osw-studio`, so the title carries the workspace
  // and host the grant is bound to; without it a client's list shows identical entries and there
  // is no way to tell which connector reaches which instance.
  const where = [principal.workspaceName, instance?.origin].filter(Boolean).join(' · ');
  const server = new McpServer({
    name: 'osw-studio',
    version: '0.1.0',
    title: where ? `OSW Studio (${where})` : 'OSW Studio',
  }, { instructions: SERVER_INSTRUCTIONS });

  /** The grant's workspace, its scopes, and the account's role, checked on every call. */
  async function workspace(workspaceId: string, scope: McpScope) {
    // The grant covers one workspace. Checked before the role, because an instance admin passes
    // verifyWorkspaceAccess for every workspace and would otherwise reach all of them.
    if (workspaceId !== principal.workspaceId) {
      throw new ToolRefused(`This connection was granted workspace ${principal.workspaceId}, not ${workspaceId}.`);
    }
    if (!principal.scopes.includes(scope)) throw new ToolRefused(`This connection was not granted the ${scope} scope.`);
    try {
      verifyWorkspaceAccess(principal.userId, workspaceId, ROLE_FOR_SCOPE[scope]);
    } catch (error) {
      throw new ToolRefused(error instanceof Error ? error.message : 'Workspace access denied');
    }
    const adapter = getWorkspaceAdapter(workspaceId);
    await adapter.init();
    return adapter;
  }

  function tool<T extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: T,
    run: (args: z.output<z.ZodObject<T>>) => Promise<ReturnType<typeof text>>,
  ) {
    const schema = z.object(shape);
    server.registerTool(name, { description, inputSchema: schema }, async (args) => {
      // One place every call passes through, so the record cannot miss a tool. Arguments are not
      // stored: a prompt or a SQL statement is the caller's content, and the point here is a
      // record of access, not a second copy of the work.
      const shaped = args as Record<string, unknown>;
      const target = [shaped.projectId, shaped.deploymentId].find(v => typeof v === 'string') as string | undefined;
      const audit = (refusedCall: boolean) => recordMcpActivity({
        grantId: principal.grantId,
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        tool: name,
        target,
        refused: refusedCall,
      });
      try {
        const result = await run(args as z.output<z.ZodObject<T>>);
        audit(Boolean((result as { isError?: boolean }).isError));
        return result;
      } catch (error) {
        audit(true);
        if (error instanceof ToolRefused) return refused(error.message);
        throw error;
      }
    });
  }

  /**
   * A number a client may have marshalled as a string.
   *
   * Real clients do: Claude Code sent `limit: "3"` for an argument typed `z.number()`, and the
   * call was refused before reaching the tool. Booleans are deliberately not coerced, since the
   * string "false" would read as true.
   */
  const num = z.coerce.number();

  const ws = z.string().describe('Workspace id');
  const project = z.string().describe('Project id');

  tool('projects_list', 'The projects in a workspace, newest first, at most `limit` of them (500 unless you ask for more). Needs projects:read.', {
    workspaceId: ws,
    limit: num.int().min(1).max(2000).default(500).describe('Most projects to return, newest first'),
  }, async ({ workspaceId, limit }) => {
    const adapter = await workspace(workspaceId, 'projects:read');
    // The summary path, not `listProjects`: the rows are mostly base64 thumbnails this tool throws
    // away, which cost 2.77MB read per call on a workspace of 237 projects. The array shape is
    // unchanged; how many it holds is stated in the description rather than wrapped in an object,
    // which would break every client reading this as a list.
    return text(adapter.listProjectSummaries().slice(0, limit).map(p => ({
      id: p.id,
      name: p.name,
      runtime: p.runtime ?? 'handlebars',
      updatedAt: p.updatedAt,
    })));
  });

  tool('projects_get', 'A project\'s settings and metadata. Needs projects:read.', { workspaceId: ws, projectId: project }, async ({ workspaceId, projectId }) => {
    const adapter = await workspace(workspaceId, 'projects:read');
    const p = await adapter.getProject(projectId);
    if (!p) return refused(`No project ${projectId} in this workspace.`);
    return text({ id: p.id, name: p.name, description: p.description, settings: p.settings, createdAt: p.createdAt, updatedAt: p.updatedAt });
  });

  tool('projects_create', 'Start a new project from a built-in template. Needs projects:write.', {
    workspaceId: ws,
    name: z.string().min(1).describe('Project name'),
    template: z.string().default('handlebars-starter').describe("Template id, e.g. 'blank', 'handlebars-starter', 'demo', 'react-starter'"),
    description: z.string().optional(),
  }, async ({ workspaceId, name, template, description }) => {
    const adapter = await workspace(workspaceId, 'projects:write');

    const { getBuiltInTemplateDefinition, BUILT_IN_TEMPLATE_DEFINITIONS } = await import('@/lib/vfs/templates/registry');
    const definition = getBuiltInTemplateDefinition(template);
    if (!definition) {
      const available = BUILT_IN_TEMPLATE_DEFINITIONS.map(d => `${d.id} (${d.runtime})`).join(', ');
      return refused(`No template "${template}". Available: ${available}`);
    }

    const { VirtualFileSystem } = await import('@/lib/vfs');
    const { runWithVFS } = await import('@/lib/server-generate/vfs-context');
    const { createProjectFromTemplate } = await import('@/lib/vfs/templates/utils');

    const projectVfs = new VirtualFileSystem(adapter);
    await projectVfs.init();

    // Inside runWithVFS because the template helper writes through the shared save manager and
    // checkpoint path, which resolve the active VFS the same way the shell does.
    const project = await runWithVFS(projectVfs, async () => {
      const created = await projectVfs.createProject(name, description);
      // The runtime comes from the template, not from the caller: a Handlebars template in a
      // project marked `static` renders its braces as text.
      created.settings = { ...created.settings, runtime: definition.runtime };
      await projectVfs.updateProject(created);
      await createProjectFromTemplate(projectVfs, created.id, await definition.loadProjectTemplate());
      return created;
    });

    const { notifyProjectChanged } = await import('./notify');
    notifyProjectChanged({
      userId: principal.userId, projectId: project.id, projectName: project.name,
      created: true, clientLabel: principal.clientLabel,
    });

    const files = await adapter.listFiles(project.id);
    return text({
      id: project.id,
      name: project.name,
      runtime: definition.runtime,
      template: definition.id,
      files: files.map(f => f.path).sort(),
    });
  });

  tool('bash', BASH_DESCRIPTION, {
    workspaceId: ws, projectId: project,
    command: z.string().describe('One command, as a single string'),
  }, async ({ workspaceId, projectId, command }) => {
    // Anything that writes needs the write scope; the read-only command set needs only read.
    // Every stage counts: a write reached through a pipe or a chain is still a write.
    const writes = commandLineWrites(command);
    const adapter = await workspace(workspaceId, writes ? 'projects:write' : 'projects:read');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);

    const { VirtualFileSystem } = await import('@/lib/vfs');
    const { runWithVFS } = await import('@/lib/server-generate/vfs-context');
    const { toolRegistry } = await import('@/lib/llm/tool-registry');

    const projectVfs = new VirtualFileSystem(adapter);
    await projectVfs.init();

    // runWithVFS is how server-mode generation points the shell at a workspace database. The
    // shell resolves its file system through getActiveVFS, so the same command set runs here.
    const output = await runWithVFS(projectVfs, () => toolRegistry.execute(
      { id: 'mcp', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } },
      projectId,
      {
        agentType: 'orchestrator',
        isReadOnly: !principal.scopes.includes('projects:write'),
        // No interactive UI to prompt with, so gated commands run rather than block.
        permissionMode: 'auto',
      },
    ));

    if (writes) {
      const project = await adapter.getProject(projectId);
      const { notifyProjectChanged } = await import('./notify');
      notifyProjectChanged({
        userId: principal.userId, projectId, projectName: project?.name ?? projectId,
        created: false, clientLabel: principal.clientLabel,
      });
    }
    return text(withBinaryHints(output));
  });

  tool('files_write', FILES_WRITE_DESCRIPTION, {
    workspaceId: ws, projectId: project,
    path: z.string().describe('Absolute path in the project, e.g. /assets/icon-512.png'),
    content: z.string().describe('The file body: text, or base64 when encoding is base64'),
    encoding: z.enum(['utf8', 'base64']).default('utf8').describe("'base64' for any binary file"),
  }, async ({ workspaceId, projectId, path, content, encoding }) => {
    const adapter = await workspace(workspaceId, 'projects:write');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    if (!isSafeVirtualPath(path)) {
      return refused(`${path} is not a path inside the project. Give an absolute path with no '.' or '..' segment.`);
    }

    let body: string | ArrayBuffer;
    if (encoding === 'base64') {
      const decoded = decodeBase64Strict(content);
      if (!decoded) return refused('content is not valid base64. Send the bytes base64-encoded and nothing else.');
      if (decoded.byteLength > MAX_WRITE_BYTES) {
        return refused(`That decodes to ${Math.round(decoded.byteLength / 1024 / 1024)}MB. This tool takes up to ${MAX_WRITE_BYTES / 1024 / 1024}MB per call.`);
      }
      body = decoded;
    } else {
      // A binary format written as text is stored verbatim and comes out corrupt when published, so
      // it is refused here rather than at read time.
      if (!isTextExtension(path)) {
        return refused(`${path} is a binary format. Send its bytes with encoding: 'base64'.`);
      }
      body = content;
    }

    const { writeProjectFile } = await import('./files');
    return text(await writeProjectFile(adapter, principal, projectId, path, body));
  });

  /** Where a transfer URL points: the instance the client reached, so it resolves from there. */
  function transferUrl(token: string): string {
    return `${(instance?.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/mcp/files/${token}`;
  }

  tool('files_upload_url', FILES_UPLOAD_URL_DESCRIPTION, {
    workspaceId: ws, projectId: project,
    path: z.string().describe('Absolute path in the project to store the file at, e.g. /assets/icon-512.png'),
    overwrite: z.boolean().default(false).describe('Replace a file already at path'),
  }, async ({ workspaceId, projectId, path, overwrite }) => {
    const adapter = await workspace(workspaceId, 'projects:write');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    if (!isSafeVirtualPath(path)) {
      return refused(`${path} is not a path inside the project. Give an absolute path with no '.' or '..' segment.`);
    }
    // Said now rather than after the upload has been sent.
    if (!overwrite && await adapter.getFile(projectId, path)) {
      return refused(`${path} already exists. Call again with overwrite: true to replace it.`);
    }

    const { token, expiresAt } = createTransfer({
      kind: 'upload', grantId: principal.grantId, userId: principal.userId, workspaceId, projectId,
      path, overwrite, clientLabel: principal.clientLabel,
    });
    const url = transferUrl(token);
    return text({
      url,
      method: 'PUT',
      path,
      expiresAt: new Date(expiresAt).toISOString(),
      command: `curl -sS --fail-with-body -T <local-file> ${shellQuote(url)}`,
      note: 'Replace <local-file> with the file on your disk. The URL works once.',
    });
  });

  tool('files_download_url', FILES_DOWNLOAD_URL_DESCRIPTION, {
    workspaceId: ws, projectId: project,
    path: z.string().describe('Absolute path of the file in the project, e.g. /assets/og.png'),
  }, async ({ workspaceId, projectId, path }) => {
    const adapter = await workspace(workspaceId, 'projects:read');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    if (!isSafeVirtualPath(path)) {
      return refused(`${path} is not a path inside the project. Give an absolute path with no '.' or '..' segment.`);
    }
    const file = await adapter.getFile(projectId, path);
    if (!file) return refused(`No file at ${path} in this project.`);

    const { token, expiresAt } = createTransfer({
      kind: 'download', grantId: principal.grantId, userId: principal.userId, workspaceId, projectId,
      path, overwrite: false, clientLabel: principal.clientLabel,
    });
    const url = transferUrl(token);
    return text({
      url,
      method: 'GET',
      path: file.path,
      mimeType: file.mimeType,
      size: file.size,
      expiresAt: new Date(expiresAt).toISOString(),
      command: `curl -sS --fail-with-body -o <local-file> ${shellQuote(url)}`,
      note: 'Replace <local-file> with where to save it. The URL works once.',
    });
  });

  tool('files_read', FILES_READ_DESCRIPTION, {
    workspaceId: ws, projectId: project,
    path: z.string().describe('Absolute path in the project, e.g. /assets/icon-512.png'),
    encoding: z.enum(['utf8', 'base64']).default('utf8').describe("'base64' for any binary file"),
    maxBytes: num.int().min(1).max(MAX_READ_BYTES).default(DEFAULT_READ_BYTES)
      .describe('Stop after this many bytes of content and say so'),
  }, async ({ workspaceId, projectId, path, encoding, maxBytes }) => {
    const adapter = await workspace(workspaceId, 'projects:read');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    if (!isSafeVirtualPath(path)) {
      return refused(`${path} is not a path inside the project. Give an absolute path with no '.' or '..' segment.`);
    }

    const file = await adapter.getFile(projectId, path);
    if (!file) return refused(`No file at ${path} in this project.`);

    const stored = file.content;
    const bytes = stored instanceof ArrayBuffer
      ? new Uint8Array(stored)
      : new TextEncoder().encode(typeof stored === 'string' ? stored : '');

    if (encoding === 'utf8' && (stored instanceof ArrayBuffer || !isTextExtension(path))) {
      return refused(`${path} holds bytes, not text. Read it with encoding: 'base64'.`);
    }

    // The metadata is worth answering on its own: size and type are usually what a caller wants,
    // and a read lands in its context, where base64 costs a third more than the file.
    const truncated = bytes.byteLength > maxBytes;
    const window = truncated ? bytes.subarray(0, maxBytes) : bytes;
    const content = encoding === 'base64'
      ? Buffer.from(window).toString('base64')
      : new TextDecoder().decode(window);

    return text({
      path: file.path,
      type: file.type,
      mimeType: file.mimeType,
      size: bytes.byteLength,
      encoding,
      content,
      ...(truncated ? {
        truncated: true,
        note: `Only the first ${window.byteLength} of ${bytes.byteLength} bytes are here. Raise maxBytes, or read it in the app.`,
      } : {}),
    });
  });

  // --- agent ---------------------------------------------------------------

  tool('agent_run', 'Ask the OSW Studio agent to work on a project. Needs agent, and an OSW Studio tab open for this account: the provider key that runs the task lives in the browser, not on the server.', {
    workspaceId: ws, projectId: project,
    prompt: z.string().min(1).max(8000).describe('What the agent should do'),
    chatMode: z.boolean().default(false).describe('Answer without editing files'),
  }, async ({ workspaceId, projectId, prompt, chatMode }) => {
    const adapter = await workspace(workspaceId, 'agent');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);

    const { requestRunFromClient } = await import('./agent-delegation');
    const result = await requestRunFromClient({
      userId: principal.userId, projectId, prompt, chatMode, clientLabel: principal.clientLabel,
    });
    if (!result.ok) return refused(result.error ?? 'The task could not be started.');
    return text({ taskId: result.taskId, status: 'running', note: 'Follow it with agent_status.' });
  });

  tool('agent_status', 'How a task is going, and what it has done so far. Needs agent.', {
    workspaceId: ws, taskId: z.string().describe('Task id from agent_run'),
    sinceEventId: num.int().min(0).default(0).describe('Return only events after this id'),
  }, async ({ workspaceId, taskId, sinceEventId }) => {
    await workspace(workspaceId, 'agent');
    const { taskManager, eventBus } = await import('@/lib/server-generate/singleton');
    await taskManager.initialize();
    const task = taskManager.getTask(taskId);
    // Scoped to the grant's account: a task id from another account is not found rather than read.
    if (!task || task.sessionId !== principal.userId) return refused(`No task ${taskId} for this account.`);

    const events = (eventBus.replayFrom(taskId, sinceEventId) ?? []).filter(e => REPORTED_EVENTS.has(e.event));
    return text({
      status: task.status,
      projectId: task.projectId,
      startedAt: new Date(task.startedAt).toISOString(),
      pendingApproval: task.pendingApproval ?? null,
      lastEventId: events.length > 0 ? events[events.length - 1].id : sinceEventId,
      events: events.map(e => ({ id: e.id, event: e.event, data: summarise(e.event, e.data) })),
    });
  });

  tool('agent_cancel', 'Stop a running task. Needs agent.', {
    workspaceId: ws, taskId: z.string().describe('Task id from agent_run'),
  }, async ({ workspaceId, taskId }) => {
    await workspace(workspaceId, 'agent');
    const { taskManager } = await import('@/lib/server-generate/singleton');
    await taskManager.initialize();
    const task = taskManager.getTask(taskId);
    if (!task || task.sessionId !== principal.userId) return refused(`No task ${taskId} for this account.`);
    task.orchestrator?.stop();
    await taskManager.completeTask(taskId, 'cancelled');
    return text({ taskId, status: 'cancelled' });
  });

  // --- deployments ---------------------------------------------------------

  tool('deployments_list', 'The deployments in the workspace, with their published state. Needs deploy.', { workspaceId: ws }, async ({ workspaceId }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    const deployments = await adapter.listDeployments();
    return text(deployments.map(d => ({
      id: d.id, name: d.name, projectId: d.projectId, slug: d.slug,
      published: Boolean(d.publishedAt),
      underConstruction: d.underConstruction, customDomain: d.customDomain,
      analyticsEnabled: Boolean(d.analytics?.enabled),
      databaseEnabled: Boolean(d.databaseEnabled),
      publishedAt: d.publishedAt, url: deploymentPublicUrl(d),
    })));
  });

  tool('deployments_url', 'Where a deployment is served, and whether a review password gates it. Needs deploy.', {
    workspaceId: ws, deploymentId: z.string().describe('Deployment id'),
  }, async ({ workspaceId, deploymentId }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    const deployment = await adapter.getDeployment(deploymentId);
    if (!deployment) return refused(`No deployment ${deploymentId} in this workspace.`);
    return text({
      // Server-computed: a slug alone does not mean a subdomain is routed to it.
      url: deploymentPublicUrl(deployment),
      published: Boolean(deployment.publishedAt),
      underConstruction: deployment.underConstruction,
      reviewGated: Boolean(deployment.review?.enabled),
    });
  });

  // --- analytics -----------------------------------------------------------

  tool('deployments_publish', 'Build a deployment and serve it. Needs deploy.', {
    workspaceId: ws, deploymentId: z.string().describe('Deployment id'),
  }, async ({ workspaceId, deploymentId }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    const deployment = await adapter.getDeployment(deploymentId);
    if (!deployment) return refused(`No deployment ${deploymentId} in this workspace.`);

    // The same steps the Deployments panel runs, from one place.
    const { publishDeployment } = await import('@/lib/publishing/publish-deployment');
    const outcome = await publishDeployment(adapter, workspaceId, deploymentId);
    if (!outcome.ok) return refused(outcome.error);

    const published = await adapter.getDeployment(deploymentId);
    notifyDeployment(principal, deploymentId, published?.name ?? deploymentId, 'published');
    return text({
      published: true,
      filesWritten: outcome.filesWritten,
      slug: outcome.slug,
      url: published ? deploymentPublicUrl(published) : undefined,
    });
  });

  tool('deployments_unpublish', 'Take a deployment off traffic: removes the published files so the site stops answering. Needs deploy. The deployment, its settings, its runtime database and its analytics are kept, and the slug stays reserved, so deployments_publish puts the same site back at the same URL. Use this rather than deleting a deployment to take a site down.', {
    workspaceId: ws, deploymentId: z.string().describe('Deployment id'),
  }, async ({ workspaceId, deploymentId }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    const { unpublishDeployment } = await import('@/lib/publishing/publish-deployment');
    const outcome = await unpublishDeployment(adapter, deploymentId, workspaceId);
    if (!outcome.ok) return refused(outcome.error);
    notifyDeployment(principal, deploymentId, deploymentId, 'unpublished');
    return text({ published: false, deploymentId: outcome.deploymentId });
  });

  tool('deployments_create', 'Create an unpublished deployment for a project. Needs deploy. Publish it with deployments_publish.', {
    workspaceId: ws, projectId: project,
    name: z.string().min(1).describe('Deployment name'),
  }, async ({ workspaceId, projectId, name }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    const now = new Date();
    const deployment: Deployment = {
      id: randomUUID(),
      projectId,
      name,
      underConstruction: false,
      headScripts: [],
      bodyScripts: [],
      cdnLinks: [],
      analytics: { enabled: false, provider: 'builtin', privacyMode: true },
      seo: {},
      compliance: {
        enabled: false, bannerPosition: 'bottom', bannerStyle: 'bar',
        message: '', acceptButtonText: 'Accept', declineButtonText: 'Decline',
        mode: 'opt-in', blockAnalytics: true,
      },
      settingsVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await adapter.createDeployment?.(deployment);
    try { ensureDeploymentRoute(deployment.id, workspaceId); } catch { /* non-fatal */ }
    notifyDeployment(principal, deployment.id, deployment.name, 'created');
    return text({
      id: deployment.id, name: deployment.name, projectId, published: false,
      url: deploymentPublicUrl(deployment),
    });
  });

  tool('deployments_update', 'Change a deployment\'s under-construction page, analytics, or database. Needs deploy. To take a site off traffic use deployments_unpublish. Analytics and database changes apply on the next publish; under-construction applies on the next publish too.', {
    workspaceId: ws, deploymentId: z.string().describe('Deployment id'),
    underConstruction: z.boolean().optional(),
    analyticsEnabled: z.boolean().optional(),
    databaseEnabled: z.boolean().optional().describe('On for edge/server functions and SQL against this deployment'),
  }, async ({ workspaceId, deploymentId, underConstruction, analyticsEnabled, databaseEnabled }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    const deployment = await adapter.getDeployment?.(deploymentId);
    if (!deployment) return refused(`No deployment ${deploymentId} in this workspace.`);
    if (underConstruction !== undefined) deployment.underConstruction = underConstruction;
    if (analyticsEnabled !== undefined) {
      deployment.analytics = { ...deployment.analytics, enabled: analyticsEnabled, provider: deployment.analytics?.provider ?? 'builtin', privacyMode: deployment.analytics?.privacyMode ?? true };
    }
    if (databaseEnabled === true && !deployment.databaseEnabled) {
      deployment.databaseEnabled = true;
      await adapter.enableDeploymentDatabase?.(deploymentId);
      try { ensureDeploymentRoute(deploymentId, workspaceId); } catch { /* non-fatal */ }
    } else if (databaseEnabled === false) {
      deployment.databaseEnabled = false;
    }
    deployment.settingsVersion = (deployment.settingsVersion ?? 1) + 1;
    deployment.updatedAt = new Date();
    await adapter.updateDeployment?.(deployment);
    notifyDeployment(principal, deployment.id, deployment.name, 'updated');
    return text({
      id: deployment.id,
      published: Boolean(deployment.publishedAt),
      underConstruction: deployment.underConstruction,
      analyticsEnabled: Boolean(deployment.analytics?.enabled),
      databaseEnabled: Boolean(deployment.databaseEnabled),
      settingsVersion: deployment.settingsVersion,
      url: deploymentPublicUrl(deployment),
    });
  });

  tool('deployments_sql', 'Run SQL against a deployment\'s runtime database (tables used by edge functions). Needs deploy. One statement. SELECT is allowed on any table; writes to the system tables (site_info, files, edge_functions, server_functions, secrets, scheduled_functions, function_logs, file_tree_nodes) are refused, as are PRAGMA, ATTACH, DETACH and VACUUM.', {
    workspaceId: ws, deploymentId: z.string().describe('Deployment id'),
    sql: z.string().min(1).describe('One SQL statement'),
  }, async ({ workspaceId, deploymentId, sql }) => {
    const adapter = await workspace(workspaceId, 'deploy');
    const deployment = await adapter.getDeployment?.(deploymentId);
    if (!deployment) return refused(`No deployment ${deploymentId} in this workspace.`);
    if (!deployment.databaseEnabled) {
      return refused('Database is not enabled for this deployment. Call deployments_update with databaseEnabled:true first.');
    }
    const db = adapter.getDeploymentDatabaseForAnalytics?.(deploymentId);
    if (!db) return refused('Deployment database is not available.');
    const result = db.executeUserQuery(sql);
    if (result.error) return refused(result.error);
    const rows = result.rows.map(row => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
    return text({
      columns: result.columns,
      rows,
      rowsAffected: result.rowsAffected,
      // Said plainly: a caller that reads a capped answer as the whole table draws the wrong
      // conclusion from it.
      ...(result.truncated ? { truncated: true, note: `Only the first ${rows.length} rows are returned. Narrow the query with WHERE or LIMIT.` } : {}),
    });
  });

  tool('backend_list', 'Edge functions, server functions, schedules and secret names on a project (secret values are never returned). Needs projects:read.', {
    workspaceId: ws, projectId: project,
  }, async ({ workspaceId, projectId }) => {
    const adapter = await workspace(workspaceId, 'projects:read');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    const [edge, serverFns, schedules, secrets] = await Promise.all([
      adapter.listEdgeFunctions?.(projectId) ?? [],
      adapter.listServerFunctions?.(projectId) ?? [],
      adapter.listScheduledFunctions?.(projectId) ?? [],
      adapter.listSecrets?.(projectId) ?? [],
    ]);
    return text({
      edge: edge.map(f => ({ id: f.id, name: f.name, method: f.method, enabled: f.enabled, timeoutMs: f.timeoutMs, description: f.description, code: f.code })),
      server: serverFns.map(f => ({ id: f.id, name: f.name, enabled: f.enabled, description: f.description, code: f.code })),
      schedules: schedules.map(f => ({ id: f.id, name: f.name, functionId: f.functionId, cronExpression: f.cronExpression, enabled: f.enabled })),
      secrets: secrets.map(s => ({ id: s.id, name: s.name, hasValue: s.hasValue, description: s.description })),
    });
  });

  tool('backend_upsert', 'Create or replace an edge function, server function, schedule or secret on a project. Needs projects:write. Secret values are stored and never returned. Live traffic sees function changes after deployments_publish.', {
    workspaceId: ws, projectId: project,
    kind: z.enum(['edge', 'server', 'schedule', 'secret']),
    // The same shape the editor enforces. A function is addressed by name in its URL, so a name
    // with a slash or a space creates a row that can never be called.
    name: z.string().min(1).max(64).regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
      'Use letters, digits, hyphens and underscores, starting with a letter or digit'
    ),
    code: z.string().optional().describe('For edge and server functions: the function BODY, not a module. No `export default` and no wrapper; the body runs in an async function, so top-level `await` works and a value is returned with `return`. An edge function has `request`, `db`, `secrets`, `Response` and `console` in scope, e.g. `const r = await db.query("SELECT 1 AS n"); return Response.json(r[0]);`'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'ANY']).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: num.int().min(1000).max(30000).optional(),
    description: z.string().optional(),
    cronExpression: z.string().optional().describe('For schedule, e.g. 0 8 * * *'),
    functionName: z.string().optional().describe('For schedule: existing edge function name to trigger'),
    value: z.string().optional().describe('For secret: the value to store'),
  }, async (args) => {
    const adapter = await workspace(args.workspaceId, 'projects:write');
    if (!(await adapter.getProject(args.projectId))) return refused(`No project ${args.projectId} in this workspace.`);
    const now = new Date();

    if (args.kind === 'edge') {
      const existing = (await adapter.listEdgeFunctions?.(args.projectId) ?? []).find(f => f.name === args.name);
      if (!existing && !args.code) return refused('edge functions need code.');
      const fn: EdgeFunction = existing
        ? { ...existing, code: args.code ?? existing.code, method: args.method ?? existing.method, enabled: args.enabled ?? existing.enabled, timeoutMs: args.timeoutMs ?? existing.timeoutMs, description: args.description ?? existing.description, updatedAt: now }
        : { id: randomUUID(), projectId: args.projectId, name: args.name, code: args.code!, method: args.method ?? 'ANY', enabled: args.enabled ?? true, timeoutMs: args.timeoutMs ?? 5000, description: args.description, createdAt: now, updatedAt: now };
      if (existing) await adapter.updateEdgeFunction?.(fn);
      else await adapter.createEdgeFunction?.(fn);
      await bumpProject(adapter, args.projectId);
      await notifyProject(principal, args.projectId);
      return text({ kind: 'edge', id: fn.id, name: fn.name, method: fn.method, enabled: fn.enabled });
    }

    if (args.kind === 'server') {
      const existing = (await adapter.listServerFunctions?.(args.projectId) ?? []).find(f => f.name === args.name);
      if (!existing && !args.code) return refused('server functions need code.');
      const fn: ServerFunction = existing
        ? { ...existing, code: args.code ?? existing.code, enabled: args.enabled ?? existing.enabled, description: args.description ?? existing.description, updatedAt: now }
        : { id: randomUUID(), projectId: args.projectId, name: args.name, code: args.code!, enabled: args.enabled ?? true, description: args.description, createdAt: now, updatedAt: now };
      if (existing) await adapter.updateServerFunction?.(fn);
      else await adapter.createServerFunction?.(fn);
      await bumpProject(adapter, args.projectId);
      await notifyProject(principal, args.projectId);
      return text({ kind: 'server', id: fn.id, name: fn.name, enabled: fn.enabled });
    }

    if (args.kind === 'schedule') {
      const existing = (await adapter.listScheduledFunctions?.(args.projectId) ?? []).find(f => f.name === args.name);
      if (!existing && !args.cronExpression) return refused('schedules need cronExpression.');
      const edges = await adapter.listEdgeFunctions?.(args.projectId) ?? [];
      const targetName = args.functionName ?? args.name;
      const edge = edges.find(f => f.name === targetName) ?? (existing ? edges.find(f => f.id === existing.functionId) : undefined);
      if (!edge) return refused(`No edge function named "${targetName}" to schedule.`);
      const fn: ScheduledFunction = existing
        ? { ...existing, functionId: edge.id, cronExpression: args.cronExpression ?? existing.cronExpression, enabled: args.enabled ?? existing.enabled, description: args.description ?? existing.description, updatedAt: now }
        : { id: randomUUID(), projectId: args.projectId, name: args.name, functionId: edge.id, cronExpression: args.cronExpression!, timezone: 'UTC', config: {}, enabled: args.enabled ?? true, description: args.description, createdAt: now, updatedAt: now };
      if (existing) await adapter.updateScheduledFunction?.(fn);
      else await adapter.createScheduledFunction?.(fn);
      await bumpProject(adapter, args.projectId);
      await notifyProject(principal, args.projectId);
      return text({ kind: 'schedule', id: fn.id, name: fn.name, functionId: edge.id, cronExpression: fn.cronExpression, enabled: fn.enabled });
    }

    const existing = (await adapter.listSecrets?.(args.projectId) ?? []).find(s => s.name === args.name);
    if (args.value === undefined && !existing) return refused('new secrets need a value.');
    const secret: Secret = existing
      ? { ...existing, description: args.description ?? existing.description, hasValue: args.value !== undefined ? true : existing.hasValue, value: args.value !== undefined ? args.value : existing.value, updatedAt: now }
      : { id: randomUUID(), projectId: args.projectId, name: args.name, description: args.description, hasValue: true, value: args.value, createdAt: now, updatedAt: now };
    if (existing) await adapter.updateSecret?.(secret);
    else await adapter.createSecret?.(secret);
    await bumpProject(adapter, args.projectId);
    await notifyProject(principal, args.projectId);
    return text({ kind: 'secret', id: secret.id, name: secret.name, hasValue: secret.hasValue });
  });

  tool('backend_delete', 'Remove an edge function, server function, schedule or secret by name. Needs projects:write.', {
    workspaceId: ws, projectId: project,
    kind: z.enum(['edge', 'server', 'schedule', 'secret']),
    // The same shape the editor enforces. A function is addressed by name in its URL, so a name
    // with a slash or a space creates a row that can never be called.
    name: z.string().min(1).max(64).regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
      'Use letters, digits, hyphens and underscores, starting with a letter or digit'
    ),
  }, async ({ workspaceId, projectId, kind, name }) => {
    const adapter = await workspace(workspaceId, 'projects:write');
    if (!(await adapter.getProject(projectId))) return refused(`No project ${projectId} in this workspace.`);
    const lists = {
      edge: await adapter.listEdgeFunctions?.(projectId) ?? [],
      server: await adapter.listServerFunctions?.(projectId) ?? [],
      schedule: await adapter.listScheduledFunctions?.(projectId) ?? [],
      secret: await adapter.listSecrets?.(projectId) ?? [],
    };
    const row = lists[kind].find(f => f.name === name);
    if (!row) return refused(`No ${kind} named "${name}".`);
    if (kind === 'edge') await adapter.deleteEdgeFunction?.(row.id);
    if (kind === 'server') await adapter.deleteServerFunction?.(row.id);
    if (kind === 'schedule') await adapter.deleteScheduledFunction?.(row.id);
    if (kind === 'secret') await adapter.deleteSecret?.(row.id);
    await bumpProject(adapter, projectId);
    await notifyProject(principal, projectId);
    return text({ deleted: kind, name });
  });

  tool('analytics_overview', 'Pageviews, visitors and top pages for a deployment. Needs analytics.', {
    workspaceId: ws, deploymentId: z.string().describe('Deployment id'),
    days: num.int().min(1).max(3650).default(30),
  }, async ({ workspaceId, deploymentId, days }) => {
    const adapter = await workspace(workspaceId, 'analytics');
    if (!(await adapter.getDeployment(deploymentId))) return refused(`No deployment ${deploymentId} in this workspace.`);
    const db = adapter.getAnalyticsDatabaseInstance(deploymentId);
    // The gate is the deployment database, not the analytics flag: with the database off there is
    // nowhere for stats to live. Naming the flag sent callers to change the wrong setting.
    if (!db) return refused('This deployment has no database yet, so it has no analytics. Publish it, or call deployments_update with databaseEnabled:true.');
    const overview = db.getOverviewStats(days);
    const stats = db.getStats(days);
    return text({
      days,
      pageviews: overview.totalPageviews,
      visitors: overview.uniqueSessions,
      averageSeconds: Math.round(overview.avgSessionDuration),
      bounceRatePercent: Math.round(overview.bounceRate),
      topPages: stats.topPages.slice(0, 10).map(p => ({ path: p.path, views: p.views })),
    });
  });

  return server;
}
