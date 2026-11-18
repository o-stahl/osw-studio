# MCP Server

**Let an outside AI agent work on your projects.**

OSW Studio can expose its own MCP (Model Context Protocol) server, so a client like Claude Code, Claude Desktop or any other MCP-capable agent can work on a workspace the way you do in the app: projects and files, backend functions and tables, publishing, and analytics.

---

## Requirements

- **Server Mode.** The connector works against the workspaces and projects stored on the server. See [Server Mode](?doc=server-mode).
- **`MCP_ENABLED=true`** in the instance's environment. Without it the endpoint returns 404, as though the route does not exist. The flag does nothing on its own: an instance not in Server Mode returns 404 whether or not it is set.
- **An account with access to the workspace** you want to connect. What you can grant depends on your role in that workspace.

---

## Connecting a client

**Settings → MCP** shows the HTTP endpoint for this instance (`/api/mcp`) and a copy control. Add that URL to your MCP client as an **HTTP** server (not stdio, and not SSE). Most clients take it either through their own UI or as a line in a config file.

On a typical host it looks like:

```
https://your-osw-instance.com/api/mcp
```

```json
{
  "mcpServers": {
    "osw-studio": {
      "type": "http",
      "url": "https://your-osw-instance.com/api/mcp"
    }
  }
}
```

Running the studio locally, the URL is whatever you serve on:

```json
{
  "mcpServers": {
    "osw-studio": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp"
    }
  }
}
```

The desktop app serves on port `30011` by default, so use `http://localhost:30011/api/mcp` for that.

The URL has to be reachable **from wherever the client runs**. A `localhost` URL only works for a client on the same machine; to connect from elsewhere, publish the instance on a hostname the client can reach. See [VPS Deployment](?doc=vps-deployment).

You do not create an API key by hand:

1. The client makes its first call and gets a `401` with a pointer to this instance's authorization server.
2. It registers itself automatically and sends you to a consent screen.
3. On the consent screen you **pick one workspace** and **choose which scopes to allow**. You can allow fewer scopes than the client asked for.
4. Approving issues an access token to that client.

The consent screen shows the client's own name, so you can tell one connector from another when you have several.

You have to be signed in to approve. If you are not, you are sent to sign in and returned to the consent screen afterwards, with the client's request intact — including on a hosted instance, where signing in happens on the account site rather than on the instance itself. The request is held for ten minutes; leave it longer than that and the client has to ask again.

### What a grant covers

A grant is tied to **one workspace**. A client holding it cannot reach your other workspaces, even if your account is an instance admin. Every tool call checks the grant's workspace and your role in it.

A grant lasts only as long as the access it was approved under. Losing access to that workspace, or having the account deactivated, revokes it: the client's token stops working and it has to run through consent again if the access comes back. Deactivating an account revokes every grant it holds, across all its workspaces.

---

## Scopes

You can only grant scopes your own role allows.

| Scope | Minimum role | What it allows |
|---|---|---|
| `projects:read` | Viewer | See your projects and read their files |
| `projects:write` | Editor | Create projects, change their files, and edit backend functions, schedules and secret values |
| `agent` | Editor | Run the OSW Studio agent on a project and follow what it does |
| `deploy` | Editor | Create, publish and unpublish deployments, change their settings (analytics, database), and run SQL against their database. Does not delete a deployment. |
| `analytics` | Editor | Read the pageviews, visitors and top pages already collected for a deployment |

These five are the whole list. A scope outside it is ignored rather than granted, and a scope that once existed but no longer is (`workspace:admin`, which no tool reads) is refused outright with `invalid_scope`, so a client cannot end up holding a permission that means nothing.

---

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `projects_list` | `projects:read` | The projects in a workspace, newest first (`limit`, 500 by default) |
| `projects_get` | `projects:read` | A project's settings and metadata |
| `projects_create` | `projects:write` | Start a project from a built-in template |
| `bash` | `projects:read` / `projects:write` | Run a command against a project's files |
| `files_upload_url` | `projects:write` | A one-time URL to store a file from your disk (`curl -T`) |
| `files_download_url` | `projects:read` | A one-time URL to save a project file to your disk (`curl -o`) |
| `files_write` | `projects:write` | Write one file inline, text or base64, replacing it if it exists |
| `files_read` | `projects:read` | Read one file inline, text or base64, with its type and size |
| `backend_list` | `projects:read` | Edge functions, server functions, schedules and secret names (values are never returned) |
| `backend_upsert` | `projects:write` | Create or replace an edge function, server function, schedule or secret |
| `backend_delete` | `projects:write` | Remove an edge function, server function, schedule or secret by name |
| `preview_screenshot` | `projects:read` | See a page as a visitor would, at a width: the first screen, the whole page, or one element |
| `canvas_selection` | `projects:read` | The element you have selected on Canvas or in Live Preview: its page, width, position in source (`/index.html:16:5`) and marker, and the `style` command that changes only that element (`restyle`) |
| `agent_run` | `agent` | Ask the OSW Studio agent to work on a project |
| `agent_status` | `agent` | How a task is going, and what it has done |
| `agent_cancel` | `agent` | Stop a running task |
| `deployments_list` | `deploy` | The deployments in the workspace and their published state |
| `deployments_url` | `deploy` | Where a deployment is served, and whether a review password gates it |
| `deployments_create` | `deploy` | Create an unpublished deployment for a project |
| `deployments_update` | `deploy` | Set under-construction, analytics, or database |
| `deployments_publish` | `deploy` | Build a deployment and serve it |
| `deployments_unpublish` | `deploy` | Take the site off traffic, keeping the deployment and its data |
| `deployments_sql` | `deploy` | Run SQL against a deployment's runtime database (writes to system tables are refused) |
| `analytics_overview` | `analytics` | Pageviews, visitors and top pages for a deployment |

There is no tool to delete a project or a deployment (unpublish the deployment instead), to manage workspace members, or to change Connections / API keys. Secret values can be set through `backend_upsert` and are never returned.

### The `bash` tool

`bash` runs the commands the OSW Studio agent uses, against a project's virtual file system:

```
cat, head, tail, ls, tree, grep, rg, find, wc, sort, uniq, tr,
echo, mkdir, rmdir, touch, mv, cp, rm, sed, ss, style, curl, inspect, runtime
```

Pipes, redirects (`> file`, `>> file`), heredocs (`<< 'EOF'`), chaining (`&&`, `||`, `;`) and brace expansion all work.

```
# Read a file
cat /index.html

# Create a file
cat > /about.html << 'EOF'
<h1>About</h1>
EOF

# Edit a file
ss /index.html << 'EOF'
<h1>Old</h1>
=======
<h1>New</h1>
EOF

# Render a page through the project's compiler
curl localhost/
```

`curl localhost/<path>` is how to see compiled output without publishing anything. `inspect /index.html [element] --width 375` reads the page as a browser lays it out: its elements with their positions in source and sizes, and for one element the rule that sets each value. An element is a page and a selector (`inspect /index.html ".hero h1"`), a position (`/index.html:16`, the element whose tag starts on line 16, or `/index.html:16:5` with a column), or a marker (`@h7x2m4qp`).

`style <element> prop=value --width 375` changes one element the way the Inspector does, in `/overrides.css` (static and Handlebars projects). Its reply says whether the change is in force when a tab is open to check it, and a change that a stronger rule would beat is marked `!important` so it applies. `canvas_selection` gives this command for the element you have selected, as `restyle`; `style --help` has the rest.

A write that drops something you set by hand on a page is answered with a note: a `data-osw-id` attribute that carried your styles is put back where the element can still be recognised, and a removed block placeholder or a changed locked element is named. `bash` puts the note under the command's output, and `files_write` in its answer's `note`.

Reading needs `projects:read`. Anything that writes needs `projects:write`.

`rm` deletes files in the project, not the project itself.

In the app, deleting files and reaching the web ask you to confirm the first time. A connector has
no screen to ask on, so the scope you approved is the confirmation: `projects:write` carries file
deletion, and `curl` may fetch a public address without a further prompt. Outbound requests are
still limited to public hosts, so a connector cannot reach a private address on your network.

**What does not work over MCP.** The agent's shell has a few commands that need something only the app provides, and they refuse with an explanation rather than with a bare error:

| Command | Why |
|---|---|
| `build`, `python`, `python3`, `lua` | Need the browser runtime (esbuild-wasm, Pyodide, Fengari) |
| `sqlite3` | Needs a deployment selected in the app; use `deployments_sql` instead |
| `status` | The in-app agent's task-completion report, which does nothing for an outside client |
| `screenshot` | Its images have no way through `bash`; use `preview_screenshot` |

### Binary files

`bash` writes text: every way it puts content in a file, from `cat >` to `ss`, stores a string. A
redirect into an image, font, audio or video file is refused rather than stored broken, and `cat`
refuses to print one; both answers name the tool to use instead. `curl -o` is the exception: it saves
a download from the web byte for byte.

**From your disk.** `files_upload_url` returns a URL and a command; running the command sends the
file:

```json
{ "path": "/assets/icon-512.png" }
```

```
curl -sS --fail-with-body -T icon-512.png 'https://your-instance/api/mcp/files/…'
```

The upload answers with the stored file's `path`, `type`, `mimeType`, `size`, `created` and
`sha256`, so there is nothing to read back. `files_download_url` works the same way in the other
direction (`curl -o`), with the file's sha256 in an `x-content-sha256` header.

The file goes from your disk to the server by `curl` and never passes through the model, which is
why this is the way to move anything larger than a few KB. Each URL works once, for ten minutes,
for the one path it was issued for. Uploads take up to 10MB, and text formats and fonts stop at 5MB.
A file already at the path is refused unless `overwrite: true` was asked for. Revoking the
connection also stops any URL it was given.

Behind Nginx, uploads over 1MB are refused with `413` before they reach OSW Studio, since that is
Nginx's default body limit. Raise it in the server block to match: `client_max_body_size 10m;`.

**Without a shell.** A client that cannot run `curl` can send the file's content inline with
`files_write`:

```json
{ "path": "/assets/icon-512.png", "content": "iVBORw0KGgo...", "encoding": "base64" }
```

The model has to write every base64 character out itself, so this is slow and costly beyond a few KB.
`files_read` is the way back: the same two encodings, plus the file's type, mimeType and size. It
answers with up to 256KB of content unless `maxBytes` asks for more, and says `truncated: true` with
the real size when there is more, so a window is not mistaken for the whole file. For text, `bash`
(`cat`, `head`, `tail`, `rg`) is usually the better tool.

`files_write` takes up to 10MB per call, like an upload, and text formats and fonts stop at 5MB.
Base64 with characters outside the alphabet or a broken length is refused rather than decoded around.
Base64 that was cut short on a four-character boundary is still valid, though, and is stored as a
shorter file, so compare the `size` in the answer with the file's. Sending text for a path that is a
binary format is refused as well, so an image cannot be corrupted by accident.

### Backend functions, schedules and secrets

`backend_list`, `backend_upsert` and `backend_delete` work on the **project**, the same records Project Settings edits. Live traffic sees function changes after `deployments_publish`.

`backend_list` returns function code so an agent can edit it, plus secret **names**. Secret **values** are write-only: they can be set, never read back.

`code` is the function **body**, not a module: no `export default` and no wrapper. It runs inside an async function, so `await` works at the top level and the result goes back through `return`. An edge function has `request`, `db`, `secrets`, `Response` and `console` in scope.

```
const rows = await db.query('SELECT COUNT(*) AS n FROM hits');
return Response.json({ hits: rows[0].n });
```

A module-style function is accepted by `backend_upsert` and then fails at request time with `unsupported keyword: export`, so it is worth getting right first time.

A new edge or server function needs `code`. An update can change `enabled`, `method` or `description` without sending the code again. A new secret needs `value`. A schedule needs `cronExpression` and an existing edge function to trigger (`functionName`, or the schedule's own `name` if they match).

Secret values only reach a deployment if the instance has `SECRETS_ENCRYPTION_KEY` set. Without it the publish still succeeds and the secret arrives as a name with no value, so an edge function reading it gets nothing. See [Server Mode](?doc=server-mode) for the variable.

### Deployments

A typical publish path:

1. `deployments_create` — unpublished, database and analytics off
2. `deployments_update` — `analyticsEnabled: true` if you want built-in analytics. `databaseEnabled: true` only matters if you want the database before the first publish, since publishing turns it on anyway
3. `deployments_publish` — build and serve
4. `deployments_unpublish` — take the site off traffic again

A deployment is live when the files the build wrote are on disk, so `deployments_unpublish` removes them and the site stops answering. Its edge functions stop answering with it, and its scheduled functions stop running. Everything else is kept: the deployment, its settings, its runtime database, its analytics, and its address. `deployments_publish` puts the same site back at the same URL, so this is what to use to take a site down rather than deleting the deployment.

Published files are served with `Cache-Control: public, max-age=3600`, so the server stops answering straight away but a visitor who loaded the site in the last hour may still see it from their own browser cache.

`deployments_sql` runs one statement against that deployment's **live** runtime database (the same database the SQL editor uses). The database has to exist first: publishing creates it, or `deployments_update` with `databaseEnabled: true` creates it without publishing. SELECT is allowed on any table, including the system tables the backend features live in; writes to those system tables are refused, as are `PRAGMA`, `ATTACH`, `DETACH` and `VACUUM`, creating a trigger, and creating a temporary table that takes a system table's name. Function code is not live until you publish; SQL is immediate.

A query returns at most 5000 rows. Past that the answer comes back with `truncated: true`, so narrow it with `WHERE` or `LIMIT` rather than reading a capped result as the whole table.

### Analytics

`analytics_overview` reads pageviews, visitors and top pages. It reports whatever has been collected, so it answers with zeros for a deployment that has never had analytics on rather than refusing. It refuses only when the deployment has no database at all, since that is where the figures live.

Turning collection on is `deployments_update` with `analyticsEnabled: true` (the `deploy` scope), not the `analytics` scope, and it applies from the next publish.

---

## Some tools need a browser tab open

`agent_run`, `preview_screenshot`, `canvas_selection` and `bash`'s `inspect` cannot run on the server alone.

Your provider API key lives in your browser's local storage and is never stored server-side, so the server has no way to start a task with a cloud model. Pages are rendered in the browser too, and what you have selected is in your tab. So the server asks an open OSW Studio tab for your account, and reports back what that tab does. A page is rendered by a tab that has the project.

So before calling these, **have OSW Studio open in a browser** and signed in to the same account. With no tab attached the call returns a message saying so rather than waiting.

Every other tool needs no browser tab, `agent_status` and `agent_cancel` included: once a task exists, its progress and its cancellation are handled on the server, so a client can start a task with a tab open and follow it after the tab is gone.

---

## Two writers on one project

Once a connector is attached, a project can be changed from two places: your browser and the agent. OSW Studio does not merge them silently.

- If the agent changes a project while your browser copy is **clean**, your browser picks up the change, including backend functions, schedules and secret names.
- If the agent changes it while you have **unsaved local edits**, new files from the server appear but your own edits are left alone, the project is marked as needing attention, and you are told to open Server Sync. Backend rows are left alone in that case too, so a later publish from the browser does not overwrite the agent's functions until you resolve the conflict.
- In Server Sync a conflicted project offers **Keep both**: the project takes the server's version, and your unsaved work is kept as a separate `{name} (local draft)` project.

Saving a project the agent has moved on from is refused rather than allowed to overwrite the agent's work. Your local work is kept either way. See [Server Mode](?doc=server-mode) for how syncing works generally.

---

## Clients

**Settings → MCP** lists every client you have authorised (workspace, scopes, added, last used). **Disconnect** revokes that client's token straight away; it has to run through consent again to get back in.

Worth a look now and then. A client you set up on a machine you no longer use keeps working until someone disconnects it, and the "last used" column is what tells you which ones are still live.

The same list is available over HTTP if you would rather script it, authenticated with your normal app session:

```
GET    /api/mcp/grants          # your grants, with client name, workspace, scopes and last use
DELETE /api/mcp/grants?id=<id>  # revoke one
```

---

## Troubleshooting

**The client gets a 404, or registration fails with a 404.**
The endpoint is off. Set `MCP_ENABLED=true` and restart the instance. A 404 is also what you get when the build does not include the connector at all.

**The client gets a 401 and never recovers.**
The grant was revoked or the token expired. Revoking happens on Disconnect, and also when the account loses access to the grant's workspace or is deactivated. Remove the server from your client and add it again so it runs through consent afresh.

**`agent_run` says no tab is open.**
Open OSW Studio in a browser, signed in to the same account, then retry. See the section above for why.

**A tool refuses with a permissions error.**
The grant does not carry the scope, or your role in that workspace is too low for it. Reconnect the client and allow the scope you need, or ask a workspace owner for a higher role.

**The connector reaches the wrong projects.**
A grant covers one workspace. Check which workspace you picked on the consent screen, and reconnect if you need a different one.

**`deployments_sql` says the database is not enabled.**
Publish the deployment, or call `deployments_update` with `databaseEnabled: true`. SQL runs against the live deployment database and does not create it.

---

## Related

- [Server Mode](?doc=server-mode) - the storage and syncing the connector works against
- [Projects](?doc=projects) - what a project is
- [Deployment Publishing](?doc=site-publishing) - what `deployments_publish` does
- [Backend](?doc=backend-features) - edge functions, tables, secrets and schedules
- [Working with AI](?doc=working-with-ai) - the in-app agent the `agent_*` tools drive
