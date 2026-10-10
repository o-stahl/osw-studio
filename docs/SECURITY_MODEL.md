# Security Model

What OSW Studio trusts, what each kind of code or person can reach, and where the boundaries are. Read this before hosting sites for other people. To report a vulnerability, see [SECURITY.md](https://github.com/o-stahl/osw-studio/blob/main/SECURITY.md).

## Who and what is trusted

| Who or what | Trusted with | Not trusted with |
|-------------|--------------|------------------|
| Instance admin | Everything on the instance: users, workspaces, settings, data | — |
| Workspace owner | Their workspace: members, projects, deployments, secrets | Other workspaces |
| Workspace editor | Projects, deployments and backend features in the workspace | Members and workspace settings |
| Workspace viewer | Reading the workspace | Changing it |
| Quick-edit account (studio view off) | The quick-edit page for the projects it can reach | The full studio |
| Code in a project: AI output, imported templates and archives, third-party scripts | Running in the preview and on the published site | The studio, its API, its stored keys, other projects |
| Edge, server and scheduled functions | Their deployment's database and secrets, outbound requests to public addresses | The server's files and processes, private network addresses, visitors' studio cookies |
| Visitors to a published site | The site, its functions and analytics | Anything in the studio |
| Review participants | Commenting on the review copy they were given | Other deployments' review copies, team actions |
| Other tenants on a shared instance | Their own workspaces | Yours |

An AI agent is treated like any other author of project code. It can read the web through its tools, so a page it reads can try to steer it (prompt injection). What it writes is untrusted for that reason.

## Boundaries

### The editor preview

Project code in the preview runs in a sandboxed frame on an opaque origin. It cannot read the studio's page, its stored provider keys, or the browser's projects, and it cannot call the studio's API with your session. The project gets its own in-memory `localStorage`, `sessionStorage` and cookies, kept per project until you close the tab. IndexedDB is not available to it. Calls to the project's own edge functions are made by the studio on its behalf, and only to that deployment's functions. Project thumbnails are rendered the same way.

### Published sites

A published site is served from a different address than the studio wherever the install has one: its own subdomain or custom domain (`STATIC_PROXY`), a sites address (`SITES_ORIGIN`), or a second local port in the desktop app. On that address the server answers only what a site needs, and on the studio's address links to a site redirect to it. See [Where Published Sites Are Served](?doc=server-mode).

The studio's thumbnails and heatmaps render a published page from its build in a sandboxed frame, never from the live site in a frame the studio can read.

### Edge, server and scheduled functions

Functions run in a QuickJS WebAssembly sandbox with a memory limit (64 MB) and a time limit, without Node.js APIs. Their outbound `fetch` refuses private and loopback addresses unless the operator sets `FUNCTIONS_ALLOW_PRIVATE_FETCH=true`. The studio's own cookies (`osw_*`) are removed from the requests they receive, and a function cannot set them. Function responses cannot set security or CORS headers, and are sandboxed if opened as a page. Each deployment has its own SQLite database.

### The studio's API

The API authenticates with an HttpOnly session cookie. On HTTPS installs it is named `__Host-osw_session`, and the ChatGPT sign-in, selected-workspace and held MCP authorization cookies are prefixed the same way. The browser accepts these only from the studio's own host, so a site on a sibling subdomain cannot plant them for the studio. A write (POST, PUT, PATCH, DELETE) from another site's page is refused, except on the endpoints other sites call by design: deployment functions, analytics collection and the MCP endpoints. The desktop app has no login; it answers only requests addressed to a loopback address (`localhost`, `127.0.0.1`), and serves published sites from a second port.

### Review copies

A review copy can require a password. A participant's identity is a signed cookie for that one deployment. Comments can be posted only from the studio or from the review copy's own address. Resolving comments and replying as the team need an account with access to the workspace.

### Provider keys

Provider API keys are kept in the browser that entered them. Connections synced to the server carry no keys. A run you start on the server receives the key for that run only and does not store it.

## Known limits

- **Sites on the studio's address.** An install with neither `STATIC_PROXY` nor `SITES_ORIGIN` serves sites from the studio's own address, where a site's scripts can act as whoever views them in the studio. The Deployments view warns about it.
- **Sites sharing a sites address.** With `SITES_ORIGIN`, all sites and their review copies share one address, so in a visitor's browser one site's scripts can read another site's storage. Subdomains (`STATIC_PROXY`) keep sites apart.
- **Subdomains are one site to the browser.** The browser sends the studio's cookies with requests a site on a subdomain of the studio's domain makes, and that site can set cookies for the parent domain. The studio's origin checks and the browser's cross-origin rules stop those requests from reading data or making changes, and the studio's own cookies cannot be planted that way (see above), apart from the language choice and a review participant's cookie, which is scoped to its review copy's path and so cannot take the prefix. A separate domain for sites removes the issue.
- **The admin is trusted.** Someone with admin access, or with access to the server, can read everything on the instance.

## Out of scope

- The security of model providers and other third-party services
- A compromised admin account, server or browser (including browser extensions)
- What a user chooses to publish on their own site
- Denial of service beyond the built-in rate limits
