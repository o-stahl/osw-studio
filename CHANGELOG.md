# Changelog

## v1.67.0 - 2026-05-18

### Server-Side Generation (Server Mode)

- **Detach-to-server**: When a user closes their browser tab during an active generation in Server Mode, the task continues running on the server backend. On tab reopen, the client reconnects via SSE and receives buffered events — conversation, tool calls, and file changes resume seamlessly.
- **Incremental file sync**: File changes from server-side generation sync back to the client (IndexedDB) after each tool call via `files_changed` SSE events, rather than waiting for the entire task to complete.
- **Soft stop**: Clicking stop during server-side generation cancels only the current LLM inference. The task transitions through a `stopping` state and emits a `stopped` result, preserving all work completed up to that point.
- **Client reconnection**: On page load, the client checks for any running server tasks and reattaches to their SSE streams. Buffered events are replayed so no progress is lost.
- **Build delegation**: Bundled runtimes (React, Svelte, Vue, etc.) defer their build step to the client — the server emits a `build_requested` event and the client runs the compilation locally on reattach.
- **Middleware auth gate**: All `/api/server-generate/*` routes are now auth-protected via middleware, blocking unauthenticated access and Browser Mode requests.

### AI Orchestration

- **Server-safe tool execution**: Python and Lua shell commands return a descriptive error on the server instead of hanging indefinitely waiting for a browser-only runtime (Pyodide/Fengari).
- **Tool abort on stop**: All tool executions now race against the abort signal, so stopping a task interrupts stuck tools immediately instead of waiting for them to complete.

### UI

- **Task completion sound**: A two-note chime plays when a generation completes in the background (hidden tab or generation shelf). A subtle single-note ping plays for in-focus completions.

### Performance

- **Delta event batching**: Assistant text, tool parameter, and reasoning delta events are coalesced in a `requestAnimationFrame` buffer and flushed once per frame, eliminating O(n²) Zustand state updates during large streaming responses.
- **Smarter auto-sync**: The project gallery no longer pulls every project from the server on each navigation. A lightweight timestamp comparison runs once per browser tab; only projects where the server is actually newer get fetched.

### Fixes

- **Generation shelf on reattach**: The shelf now appears on any workspace page (including the projects page) when a server task is running, not only when viewing the project. Task metadata (name, prompt, model) is preserved across tab reloads.
- **Chat history on reconnect**: Reopening a tab during server-side generation now replays the full event buffer, restoring the complete conversation including project context.
- **Binary file content in file sync**: The `/api/server-generate/files` endpoint now correctly extracts file content from VirtualFile objects instead of returning the raw wrapper.
- **HMR singleton safety**: TaskManager and SSEEventBus use `globalThis` singletons to prevent webpack hot-reload from creating duplicate instances during development.
- **Login form loading state**: The admin login page now clears its loading spinner on authentication failure.
- **Cost tracking init**: Projects with partial cost tracking data (missing `providerBreakdown`) no longer throw on update — existing fields are preserved during re-initialization.
- **Skills service on server**: SkillsService guards against missing `localStorage` so it can initialize during server-side generation without throwing.
- **VFS context isolation**: Shell commands and skills use `getActiveVFS()` which returns the per-task server VFS (via `AsyncLocalStorage`) or the browser singleton, preventing cross-task file system access.
- **Project deletion in Server Mode**: Deleting a project now removes it from the server — previously, deleted projects reappeared on page refresh because the server copy was never cleaned up.
- **Deployment quota on delete**: Deleting a deployment now frees the deployment quota slot. Previously, the routing entry was retained and deleted deployments still counted against the workspace limit.
- **Project creation quota**: Project creation now checks the workspace project limit before proceeding. Previously, the limit was only enforced during sync push, so projects could be created locally with no feedback that the quota was exceeded.

## v1.66.0 - 2026-05-16

### Multi-Generation

- **Concurrent project generation**: Multiple projects can now generate simultaneously. Start a task on one project, navigate to another, and start a second task — each runs independently with its own orchestrator instance.
- **Generation shelf upgrade**: The shelf now shows all background tasks with per-card stop, dismiss, and navigation controls.
- **Paused task visibility**: When a background generation hits an API error (e.g. upstream timeout), the shelf turns yellow with "Paused — needs attention" and shows Continue/Cancel buttons directly — no need to navigate back to the project.

### Fixes

- **Chat history lost on navigation**: Leaving a generating project and returning now correctly preserves the full conversation and shelf activity.

## v1.65.0 - 2026-05-14

### AI Generation Survives Navigation

- **Background generation**: Starting a task and navigating to the project gallery no longer kills the generation. The orchestrator continues running and the full conversation — including checkpoints — is intact when you return.
- **Generation shelf**: A floating indicator appears in the bottom-right corner when you navigate away from an active task. Shows the project name, prompt, elapsed time, model, and live activity. Click to jump back to the project.

### Checkpoints

- **Pinned checkpoints**: Pin any checkpoint to prevent it from being pruned. Pinned checkpoints survive indefinitely as full project snapshots — useful for bookmarking a known-good state before experimenting.
- **Per-project pruning**: Each project keeps its 5 most recent unpinned checkpoints. Older ones are automatically deleted when new checkpoints are created.
- **Reliable loading on project entry**: Checkpoints now load correctly on first workspace mount regardless of which project was viewed previously.

### Internal

- **Zustand state management**: Workspace state migrated from 40+ React `useState` calls to a zustand store with three slices (orchestrator, project, layout). Enables generation survival and future SharedWorker execution.

## v1.64.0 - 2026-05-13

### Server Mode

- **Auto-pull fix**: Projects on the server were never pulled to new devices because the VFS lookup threw on missing projects instead of returning null, causing every pull attempt to silently fail.
- **Workspace ID race condition**: Auto-sync API calls could fire before the workspace ID was set, hitting unscoped endpoints that returned 404. The workspace ID is now set explicitly before any sync operation.
- **Sync dialog suppressed in workspace mode**: The manual "Sync Your Projects" dialog no longer appears when auto-pull handles the sync automatically. Non-workspace server mode setups still show it.
- **Pulled projects no longer marked dirty**: Pulling files from the server triggered the save-dirty tracker, making every synced project appear as needing a save immediately on open. File operations during pull are now suppressed from dirty tracking.

### UI

- **Deployment selector cleanup**: Removed the standalone database icon and "Disconnect deployment" button from the workspace header. The deployment dropdown now shows a plain select with "No deployment" as the default.

### Fixes

- **Runtime switch ignored**: Changing a project's runtime in Project Settings (e.g. React → Static) visually reverted immediately because the workspace didn't update its local runtime state after the settings modal saved.

### Mobile UX

- **Bottom bar overflow menu**: Mobile bottom bar now shows Chat, Files, Preview, and a three-dot overflow menu. Overflow contains Editor, Checkpoints, Console, Skills, and Debug panels with labeled entries.
- **Panel headers slimmed on mobile**: Panel headers hide the title, icon, close button, and drag handle on mobile. Only action buttons remain, rendered as pill-shaped buttons with labels (e.g. "Clear chat", "Upload", "Add skill").
- **Panels edge-to-edge on mobile**: Removed border, border-radius, padding, and shadow from mobile panel wrappers so panels fill the viewport.
- **Project name in header**: Mobile workspace header shows the project name left-aligned with the active panel name as a subtitle below it.

## v1.63.0 - 2026-05-08

### Server Mode

- **Auto-sync on project creation**: New projects are pushed to the server immediately after creation, so they appear on other devices without manual sync.
- **Cross-device sync on load**: Opening the project gallery pulls server-side changes before displaying projects. Only projects with newer server timestamps are fetched.
- **Per-project freshness check**: Opening a project in the editor checks the server for updates and pulls if newer.
- **Optimistic concurrency on push**: Server rejects pushes when another device has made changes since the last sync. Conflicts are surfaced instead of silently overwriting.
- **Checkpoint safety net**: A checkpoint is created before pulling server changes, so local work can be recovered if a pull overwrites in-progress edits.
- **Workspace switcher removed from editor**: Workspace switching is handled at the account level.

### Fixes

- **Publish failure in server mode**: Publishing a deployment could fail with a database error ("SQLiteAdapter not initialized") when the build process closed a shared database connection mid-request. Adapter lifecycle is now handled correctly.
- **Project ID mismatch on pull**: Pulling new projects from the server generated random local IDs instead of preserving the server's ID, breaking subsequent sync round-trips.

## v1.62.0 - 2026-05-05

### Built-in Skills

- **Frontend design skill expansion**: Sub-skill catalog grew from 4 to 12 aesthetic directions — added `brutalist`, `retro-futuristic`, `art-deco`, `maximalist`, `playful`, `industrial`, `luxury`, and `terminal`. Wider taxonomy reduces convergence between generations and covers design spaces the previous four couldn't reach.
- **Sub-skills rewritten for variety**: Sub-skills now describe typography character, color logic, spatial principles, and motion intent rather than prescribing specific page sections. Outputs from the same sub-skill no longer look like siblings.

### Skill Groups

- **Skill groups for bulk enable/disable**: Skills can now be bundled into named groups that toggle together. Three built-in groups ship: `Frontend Design` (all 13 aesthetic skills), `Server Mode` (server, functions, database, secrets — disable for browser-only projects), and `Web Standards` (responsive, accessibility). Enabling a group activates all its members; disabling falls through to individual toggles.
- **Multi-membership**: A skill can belong to any number of groups; enabling any one of them makes the skill available.
- **Custom groups**: Create your own groups via the "New Group" dialog — pick a name, optional description, and select member skills. Edit and delete available on custom groups.
- **Skills view redesign**: The Skills view is now tabbed (Skills / Groups) with member-count badges. Groups are collapsed by default; expanding shows member skills with individual toggles. "Enable all" / "Disable all" bulk actions added to the Skills tab.

### Server Mode

- **Account link in sidebar**: In managed mode, the sidebar now shows an "Account" link that navigates back to the managing provider's account page.
- **Fixed stale workspace switcher path**: The "Switch workspace" link in the workspace header pointed to an outdated path.

## v1.61.1 - 2026-05-03

### Server Mode

- **Session redirect fix**: Auth redirects now use `NEXT_PUBLIC_APP_URL` instead of `request.url`, which resolves to `0.0.0.0` in Next.js standalone mode.
- **Admin-only sidebar items**: Users nav item hidden for non-admin users in the sidebar.
- **Database encryption support**: All database connections accept an optional `DB_ENCRYPTION_KEY` pragma for encrypted SQLite. No-op when unset.
- **API key IP allowlist**: Instance API key authentication can be restricted to specific source IPs via `GATEWAY_IPS` env var. Supports IPv4 and IPv6.
- **Deployment type telemetry**: Telemetry now distinguishes deployment types (browser, server, desktop, multi-instance) for usage analytics.

### Desktop

- **Fixed 404 on launch**: Desktop app showed a Next.js 404 after the workspace routing changes in v1.57.0. The app now bootstraps a default workspace on first launch and routes directly to it.

## v1.61.0 - 2026-05-01

### Multitenancy & Server Mode

- **Workspace-scoped browser storage**: Each workspace gets its own IndexedDB database. Projects, files, skills, and templates are isolated per workspace. API keys remain in localStorage (per-browser, not synced). Browser mode unchanged.
- **Session handoff**: External auth providers can establish authenticated sessions on an instance without knowing the user's password.
- **Webhook event system**: Instances can emit lifecycle events to an external URL with signed payloads. Opt-in — zero overhead when unconfigured.
- **External auth redirect**: When an external auth provider is configured, all login and session-expired flows redirect there.
- **Managed mode**: Instances can be configured for external user management, disabling local user creation and routing auth to the managing provider.
- **Legacy data migration**: Standalone instances automatically migrate existing data into workspace databases on first login. Managed instances start workspaces clean.

### UI

- **Discard Changes is now a split button**: Primary click still discards all changes since last save. The chevron opens the Checkpoints panel for browsing and restoring earlier points.
- **Dashboard for non-admin users**: The workspace dashboard shows project counts, storage usage, and recent projects from the workspace sync API instead of requiring admin access.
- **Sync prompt for empty workspaces**: When a workspace-scoped IndexedDB is empty but the server has projects, a "Sync Your Projects" dialog offers to open the sync panel.

### Bug Fixes

- **Preview reload storm on checkpoint restore**: Restoring a checkpoint with hundreds of files triggered dozens of preview recompiles. Now writes silently and dispatches a single event at the end.
- **Conversation deadlock after stopping a streaming tool call**: Interrupted tool calls left orphaned messages that blocked all subsequent turns. The wire payload now drops empty tool calls and synthesizes placeholder results.
- **Mid-stream upstream errors silently swallowed**: OpenRouter upstream errors delivered over 200 SSE connections are now surfaced in the error dialog instead of dropped.
- **Stale workspace cookies**: Workspace-scoped routing (shell commands, deployment schema, IndexedDB selection) now requires server mode to be active — stale cookies from previous server mode sessions no longer affect browser mode. Logout clears the workspace cookie alongside the session cookie. Middleware clears both on invalid/expired sessions before redirecting.

### Security

- **Open redirect in session handoff**: The redirect parameter now only accepts relative paths, preventing redirects to external domains.
- **Handoff workspace ID validated**: Workspace IDs extracted from redirect URLs are validated as UUIDs before being set in cookies.

### Developer Tools

- **Stream debug toggle in the Debug Events panel**: New checkbox next to "Auto-scroll". Emits `llm_request` and `stream_raw_chunk` events for inspecting outgoing payloads and raw SSE traffic. Off by default.

## v1.60.0 - 2026-04-26

### Describe Mode

- **Conversational project setup**: New "Plan the project first" option in the create-project dialog opens a chat with a setup agent. Describe what you want to build; the agent figures out the runtime, template, pages, and any backend capabilities through a short conversation. The project is scaffolded with full context, so the in-project agent doesn't ask the same questions again. Replaces the "AI Project Setup" template shortcut (removed).
- **Live brief sidebar**: Project brief updates in real time as the conversation progresses — name, type, pages, capabilities, direction, plus runtime and template under the hood. Collapsible spec preview shows accumulated context. The "Create now" button enables once the brief has the minimum it needs (name + runtime + template).
- **Tappable chip prompts**: When the agent asks closed-ended questions ("What aesthetic — bold, soft, editorial, minimal?"), it presents tappable options instead of free text. Selecting one sends it as the next message.
- **Creation confirmation**: When the brief is ready the agent proposes creation; the user reviews the brief and clicks "Create project" to confirm or "Not yet" to keep adjusting. Declining attaches a context note to the next message so the agent knows without re-asking.
- **Output files**: Projects from describe mode start with `.PROMPT.md` (terse brief appended to the runtime's domain prompt), `.DESIGN.md` (substantive context from the conversation), and `.DESIGN-CONVERSATION.md` (raw transcript with agent prose, ask prompts, and spec sections).
- **Stack defaults**: Defaults to Handlebars + vanilla HTML/CSS/JS for most websites. Frameworks only when the user names one or a feature requires one.

### AI Orchestration

- **`ask` shell command**: The in-project agent can now present tappable chip options to the user instead of asking in prose — useful when it hits a real either/or choice and wants a single decision before proceeding. `ask [--prompt "Question"] "Option A" "Option B" "Option C"`. The user's selection becomes the next message in the conversation.
- **Live reasoning preview**: The reasoning badge now shows the latest streamed thinking content while the model is still generating, instead of a static `Thinking...` label. Falls back to `Thinking...` only before any content arrives.

### UI

- **Backend status banner improvements**: Refresh button checks server reachability instead of the models API. Dismiss button on both banners. Improved messaging about sync impact and local data safety.
- **Hidden files bar in file explorer**: Bottom bar shows the count of hidden files and folders. Clicking toggles visibility. Tooltip explains that dot-prefixed items are excluded from deployments and ZIP exports but included in backups and templates.
- **Dot-prefix export exclusion**: Any root-level file or directory starting with `.` (e.g. `.PROMPT.md`, `.DESIGN.md`, `.skills/`) is excluded from deployments and ZIP exports, while still being included in backups and templates.
- **Unsaved changes guard**: Back button, logo click, Escape, and browser tab close prompt for confirmation when the AI is generating or there are unsaved changes. Applies to both the workspace and the create-project dialog.
- **Fullscreen preview preserves state**: Entering and exiting fullscreen no longer wipes the chat draft or reloads the preview iframe. Workspace panels stay mounted across the transition.
- **Folder drag-and-drop upload**: Dropping a folder into the file explorer recurses into it, preserving the folder structure and uploading all files inside. A persistent loading toast shows live progress (e.g. `Uploading 17/42 files · 3/3 folders`). Intermediate directories are auto-created. Unsupported files inside folders are silently skipped.
- **Single preview reload when deleting a directory**: Deleting a folder with many files now triggers one preview compile and one file-tree refresh at the end, instead of one per contained file — eliminates flicker on large deletions.
- **Pagination on list views**: Projects, Templates, and Deployments paginate at 24 per page; Skills at 30. Skills also unifies its previously separate Built-in and Custom sections into a single list with toggle chips to hide either group.

### Telemetry

- **New anonymous events**: `project_create` (method: quick/describe, runtime, template), `deployment_publish` (runtime, success/fail, has_custom_domain), `compaction_fired` (tokens before/after, provider/model), `image_attached` (source: drop/paste, count). All categorical — no file contents, prompts, names, or domain values. Disclosure dialog updated with matching bullets.

### Bug Fixes

- **Chained heredocs written to the wrong file**: When a single `shell` call contained multiple back-to-back heredocs (e.g. several `cat > /file << 'EOF' … EOF` blocks), the greedy heredoc regex matched the *last* `EOF` in the input, so the first file received everything in between as its body — including the literal `EOF` lines and the intermediate commands. Subsequent files were silently skipped. The shell executor now splits compound commands into individual statements before parsing each heredoc, so each `EOF` correctly terminates its own block.
- **sed misclassified many real file paths as expressions**: `sed -i 's/old/new/g' /styles/style.css` failed with `sed: unsupported command "style.css"` because the argument parser flagged any path whose basename began with d/p/c/i/a/n/s as a sed address-expression rather than a file. The classifier now requires the command letter to be at a valid terminator, so common paths like `/src/index.ts` and `/public/nav.svg` are correctly treated as files.
- **Empty assistant text bubble**: Reasoning models (e.g. Kimi K2.6) sometimes emit a whitespace-only assistant message between reasoning and the tool call. That rendered as an empty bordered bubble. The chat panel now skips text items whose accumulated content is just whitespace.
- **Spurious `/api/sync/status` 404s in dev**: The sync status dialog hook auto-fetched on mount, hitting a pre-multitenancy URL when no workspace was scoped yet. The fetch now runs only when the dialog opens.
- **Transient rate-limits misreported as "credit limit reached"**: When OpenRouter returned a 429 with a transient upstream rate-limit message (e.g. "deepseek/deepseek-v4-pro is temporarily rate-limited upstream. Please retry shortly"), the error classifier matched the substring "limit" inside "rate-limited" and reported "OpenRouter credit limit reached. Add credits…" — sending users to the wrong fix. The classifier now checks for rate-limit phrasing (or a `Retry-After` header) first and returns a "temporarily rate-limited, try again in a moment" message; the credit-exhaustion path keeps the stricter keyword set.
- **Shell commands with newline-wrapped `cmd` fail as "command not found"**: When models sent `cmd` with leading/trailing newlines (e.g. `"\ncat index.html\n"`), `parseShellCommand` didn't treat `\n` as a word separator — newlines were appended to the command name, producing `"\ncat"` instead of `"cat"`, which missed the switch-case lookup. The parser now splits on `\n` and `\r` alongside spaces and tabs.
- **DeepSeek V4 Pro 400 on multi-turn conversations**: DeepSeek V4 Pro via OpenRouter returned `The reasoning_content in the thinking mode must be passed back to the API` on every follow-up turn. DeepSeek validates the *presence* of a `reasoning_details` field on prior assistant messages — even when no reasoning content was actually streamed back. Assistant messages now always include the field (defaulting to an empty array), so multi-turn replay satisfies the validation.

## v1.59.0 - 2026-04-21

### AI Orchestration

- **Resilient large file writes**: Multiple layers of recovery for when a provider truncates or hangs during a large tool call (e.g., writing a big CSS file via heredoc). The streaming parser times out after 45 seconds of no data instead of hanging indefinitely. Truncated heredoc content is written to the file so the model can continue from where it left off. A fallback heredoc extractor catches cases where the primary parser fails. Commands truncated before the heredoc operator completes are rejected with a clear retry message instead of being misinterpreted.
- **Tool error recovery**: When a tool call fails and the model responds with no content, the orchestrator prompts it to retry instead of nudging for `status --complete`. Previously this led to nudge exhaustion and task termination.

### UI

- **Semantic block drops land at the drop position**: Blocks dropped inside large parent elements now land where you put them instead of drifting elsewhere.
- **Accurate tool badge during streaming**: While a `shell` tool call is still streaming, the badge label and command preview reflect the command that's already arrived — "write", "read", "search", etc. labels and partial command text show up immediately instead of a generic "shell" badge.
- **Backend unreachable banner**: When an API call to OSW Studio's own server fails with a network error or 5xx, a persistent red banner appears. Clarifies why model discovery and AI generation aren't working. Clears automatically on the next successful request.
- **Preview command won't close an open panel**: When the AI runs `preview <path>` and the preview panel is already open, the panel stays open instead of toggling closed.
- **Media file preview in editor**: Image files (png, jpg, gif, webp, bmp, ico) and video files (mp4, webm, ogg) now display inline previews in the editor panel with playback controls for video. Previously video files showed "Unsupported File Type".
- **Upload progress for large files**: Files over 512KB show a loading toast with file name and size during upload.
- **Upload overlay fix**: The "Drop files here to upload" overlay no longer gets stuck when an upload errors.

### Auth & Sync (Server Mode)

- **Rolling session refresh**: Active sessions are extended automatically. When a request hits the middleware past the session's halfway point, a fresh cookie is issued. Active users stay logged in instead of being kicked out at a hard 24-hour wall.
- **Session-expired banner**: When an auth-gated API call returns 401, an amber banner appears with a "Log in" link. Previously auto-sync failures were silent.
- **Auto-sync stops retrying on 401**: Bails immediately on expired session instead of burning through 3 retry attempts.

### Skills

- **Frontend Design skill tree**: The monolithic `frontend-design` skill is now a base skill plus four aesthetic sub-skills. The base covers universal principles (Design Intent block, typography tiers, color construction, spacing, interaction, anti-patterns) and directs the AI to pick the aesthetic that fits the project. Sub-skills teach design thinking — what kinds of fonts to look for, how color relationships should feel, what motion communicates — without hardcoding specific values. Each generation produces different choices within the aesthetic's guardrails.
  - `frontend-design-bold-geometric` — massive type, high contrast, kinetic energy (product launches, brand sites)
  - `frontend-design-soft-organic` — warm, rounded, gentle (SaaS, wellness, consumer products)
  - `frontend-design-editorial` — serif-forward, magazine grids, content-dense (blogs, publications, portfolios)
  - `frontend-design-minimal` — extreme whitespace, monochrome, restrained (luxury, architecture, photography)

### Bug Fixes

- **File sync UNIQUE constraint error**: Publishing or syncing a project to the server could fail with `UNIQUE constraint failed: files.id` when a stale file record survived the delete-then-recreate cycle. Syncs are now idempotent.

## v1.58.0 - 2026-04-19

### ES Module Support

- **Import map injection**: Preview auto-injects `<script type="importmap">` for non-bundled runtimes (Static, Handlebars), mapping VFS JS/TS paths to blob URLs. Enables `<script type="module">` with `import`/`export` between project files — no bundler needed. Preview-only; published sites serve real files and don't need it.
- **Static runtime prompt**: AI guidance for Static projects now covers ES module imports with absolute paths and CDN URLs for third-party libraries.

### AI Orchestration

- **Conversation compaction improvements**: Compaction is now disabled by default — enable per provider in Settings. When enabled, the threshold uses cumulative prompt tokens instead of per-response usage, so it works consistently across all providers. Compaction fires at exactly the configured limit. Anthropic usage fields (`input_tokens`/`output_tokens`) now parse correctly.
- **Truncated tool call recovery**: When a `shell` tool call's JSON is truncated (large `cat` heredoc hitting `max_tokens`), the repaired command executes instead of returning a generic error. Truncated heredocs write truncated content, which the model can detect and continue from.
- **Script timeout no longer hangs**: Script execution timeout (now 60s, was 30s) emits a `complete` event before aborting the worker, so the tool call resolves with a timeout error instead of hanging forever on "executing".
- **Nudge cleanup on follow-up**: When a user sends a follow-up message after nudge exhaustion, stale nudge messages are stripped from the conversation. Previously, consecutive nudge messages remained and caused the model to return empty responses on the next turn.

### UI

- **Login and register theming**: Login and register pages now follow the app's light/dark theme instead of being hardcoded dark. The logo component auto-inverts colors with theme (light: black bg + white letters, dark: white bg + black letters).
- **Live runtime switching**: When the AI changes the project runtime (e.g., `runtime handlebars`), the preview picks it up immediately. Previously the preview kept using the old runtime until the project was saved and reopened, causing raw Handlebars tokens like `{{> nav}}` to appear unprocessed.
- **Monaco editor error boundary**: The editor panel no longer crashes the entire UI when Monaco's internal render fires after disposal (e.g., during panel resize/move). An error boundary catches the error and silently re-mounts the editor.
- **Chat input performance**: Prompt state now lives inside the chat panel. Typing in the textarea no longer re-renders the file explorer, editor, preview, and every other workspace child on every keystroke.
- **Tool call streaming performance**: Tool parameter deltas now emit small fragments instead of cumulative snapshots, fixing O(N²) memory blowup and UI lag during long tool call streaming. Also fixed garbled `_raw` parameters and missing command previews on tool badges.
- **Orphan waiting indicator fix**: Empty-response iterations no longer leave permanent "Waiting for response..." spinners in the chat.
- **SVG files open as text**: SVG files now open in Monaco as editable XML instead of showing the image preview placeholder.
- **SVG output from Python**: Script worker no longer base64-encodes SVG files written to `/output/` — they're treated as text (like HTML/JSON) instead of binary images.
- **Model search auto-focus**: When opening settings with a connected provider, the model search input auto-focuses instead of the provider dropdown — users can start searching models immediately.

## v1.57.0 - 2026-04-14

### Multitenancy & Workspaces (Server Mode)

- **Workspace-based data isolation**: Each workspace gets its own `data/workspaces/{workspaceId}/osws.sqlite` database. Projects, files, deployments, templates, and skills are scoped per-workspace. A separate `data/system.sqlite` manages user accounts, workspaces, and access grants
- **Shared workspace access**: Multiple users can be granted access to the same workspace. An agency can create a workspace for a client, build the site, then invite the client to make their own updates via the AI
- **Workspace-scoped URL routing**: All workspace pages live at `/w/{workspaceId}/projects`, `/w/{workspaceId}/deployments`, etc. API routes under `/api/w/{workspaceId}/sync/`, `/api/w/{workspaceId}/deployments/`, etc. Legacy `/admin/` paths redirect to the user's default workspace
- **Workspace switcher**: Dropdown in the sidebar shows all workspaces the user has access to with role badges. Switching navigates to the same view in the new workspace. Admins can access workspace management directly from the switcher. Workspace name cached in localStorage for instant display on page load
- **User registration and authentication**: New `/api/auth/register` endpoint and `/admin/register` page. Login supports email + password auth against the system database, with admin password fallback for single-user instances
- **Route protection**: All workspace-scoped routes verify the user has access to the workspace. Middleware enforces auth for `/w/` and `/api/w/` paths. Previously unprotected routes secured
- **Quota enforcement**: Each workspace has configurable limits for projects, deployments, and storage. Project count checked at creation, deployment count at publishing, storage checked on file sync. Storage warning banner appears at 80% usage. Sync status API returns full quota info (used/max for projects, deployments, storage)
- **Admin management**: New `/admin/users` and `/admin/workspaces` pages. User creation includes workspace assignment (new workspace, existing workspace, or none). User expansion shows workspace memberships. Workspace management shows members, stats, quotas with create/edit/delete and access grant/revoke. Workspace deletion cleans up filesystem
- **First-user-is-admin setup**: Fresh instances redirect to a registration page on first visit. The first user to register becomes admin with an unlimited workspace. No `ADMIN_PASSWORD` env var needed for new installs. Legacy admin password only works as a bootstrap mechanism when zero users exist
- **Instance configuration**: `REGISTRATION_MODE` (open/closed) controls self-registration. `INSTANCE_API_KEY` enables machine-to-machine admin API auth. `INSTANCE_ID` identifies the instance
- **Legacy data migration**: Upgrading from single-user mode automatically copies projects, deployments, templates, and skills from `data/osws.sqlite` to the default workspace on login. Workspace repair endpoint (`POST /api/admin/workspaces/{id}/repair`) detects and fixes orphaned data, missing deployment routes, and incomplete migrations
- **Workspace-scoped publish pipeline**: Static builder, backend feature extractor, and project swap analyzer all use the workspace adapter. All view components (deployments, database managers, server settings) fetch from workspace-scoped API URLs

### Security

- **Timing-safe comparisons**: API key and admin password comparisons use `crypto.timingSafeEqual`
- **SQL statement blocking**: ATTACH, DETACH, PRAGMA, VACUUM blocked in user-facing SQL execution paths
- **Session validation**: Deactivated users' sessions invalidated on next request via DB check
- **Analytics ownership**: Analytics read/clear endpoints verify deployment ownership
- **Email validation**: Registration validates email format
- **Path validation**: Workspace IDs validated as UUIDs before file path construction

## v1.56.0 - 2026-04-12

### Semantic Blocks

- **Drag-and-drop semantic block placement**: Semantic blocks are implementation descriptions, not pre-built components. A new palette panel in the preview toolbar (36 blocks across 4 categories) lets users drag blocks directly onto the live preview at any DOM depth. The AI receives each block's specification along with the surrounding HTML context and writes code that integrates with the existing implementation. Blocks appear as wireframe placeholders in the preview and as context entries above the chat input
- **36 blocks across 4 categories**: Page Structure (Hero, Header/Nav, Footer, Features Grid, Testimonials, Pricing, FAQ, CTA Banner, Sidebar Nav, Breadcrumbs, Tabs, Pagination), Media & Text (Text Block, Image, Video, Card, List, Accordion, Gallery, Timeline, Profile Card), Forms & Buttons (Button, Form, Contact Form, Search Bar, Modal, Login Form, File Upload, Notification, Dropdown Menu), Numbers & Charts (Table, Chart, Stats Counter, Progress Bar, Metric Cards, Data List)
- **Unified context component**: Focus context, semantic blocks, and attached images are now combined under a single "Included in next message" panel above the prompt input, replacing three separate displays. Each section is independently collapsible with its own clear button. In sent messages, context appears as a collapsed "Context (focus, 2 blocks, 1 image)" line, expandable to show details

### Workspace Panels

- **Panel replace preview uses overlay**: Sidebar hover highlight now uses an absolute-positioned overlay instead of border, avoiding layout shift and working consistently across all panel types (including those with `overflow-hidden`)
- **Insert position indicator**: Hovering a sidebar button for a closed panel now shows an animated indicator at the right edge showing where the panel will appear. New panels always open as the rightmost panel for predictable behavior
- **Per-panel size persistence**: Panel IDs are now identity-based (`panel-chat`, `panel-preview`) instead of position-based (`slot-0`, `slot-1`). Sizes persist per panel across reorders, close/reopen cycles, and sessions
- **Drag reorder preserves panel widths**: Reordering panels via drag now preserves each panel's width instead of resetting all to equal distribution

### UI

- **Rounded loading spinner**: Replaced 7 separate CSS border-based spinners with a unified SVG `Spinner` component (`components/ui/spinner.tsx`) using `stroke-linecap="round"` for smooth rounded line caps, consistent with the app's rounded design language

### Bug Fixes

- **Shell newlines inside quoted strings broke command parsing**: `splitNewlineCommands` split on newlines before checking if they were inside quoted strings, causing commands like `status --done "1. Did X\n2. Did Y"` to break — the `2.` was interpreted as a separate command. Fixed by buffering lines instead of pushing directly, so the next iteration's unbalanced quote check can accumulate them

## v1.55.1 - 2026-04-08

### Bug Fixes

- **Deployment serving routes used stale path**: The route handlers serving published deployment files still referenced the old `public/sites/` directory instead of `public/deployments/`, causing 404s in standalone/production mode (e.g. Hetzner). Dev mode was unaffected because Next.js dynamically serves `public/` files

## v1.55.0 - 2026-04-07

### Model Compatibility

- **Removed tools filter from OpenRouter model listing**: Models without native tool/function calling support (e.g., Gemma 3n, OLMo, Liquid) are no longer hidden from the model selector. All text-output models on OpenRouter now appear (~350 vs ~250 previously)
- **Non-tool-calling model support**: Models that don't support native function calling now work via text-based command extraction. The system prompt instructs these models to write commands in bash code blocks instead of invoking tools. The orchestrator parses ```bash blocks, Gemini-style `tool_code` blocks, and `shell{...}` JSON syntax from text responses and converts them to synthetic tool calls
- **Skip tools param for non-tool models**: `tools` and `tool_choice` are omitted from the API request when the model's `supportsFunctions` is false, preventing OpenRouter "No endpoints found that support tool use" errors
- **Malformed tool call detection scoped**: The "CRITICAL ERROR: You wrote a tool call as TEXT" correction now only fires when tools were actually sent in the request. Models without tool support are no longer scolded for writing commands as text
- **Model capability badges**: Selected model details now show badges for Tools, Vision, Reasoning, or "No native tools" so users can see what the model supports at a glance

### Providers

- **mesh-llm provider**: New provider for distributed p2p inference via the [mesh-llm](https://github.com/michaelneale/mesh-llm) network. Free open model inference from shared compute — no API key needed. Run `mesh-llm --auto` locally to join the public mesh, then select "mesh-llm" in OSW Studio settings. Models are auto-discovered from the mesh. Works on desktop and self-hosted deployments (requires mesh-llm running on the same machine)

### Bug Fixes

- **Stale model on provider switch**: The orchestrator cached the model name at construction time (`this.model`), so switching providers mid-session (e.g. mesh-llm → OpenRouter) would keep sending the old model ID, causing instant "not a valid model ID" errors on every Continue. `getProviderConfig()` now prefers the user's current config selection over the cached value
- **Blind retry on Continue after API error**: Clicking Continue after an `error_paused` API error retried with identical messages, causing the model to produce the same broken output in a loop. The retry now injects a synthetic error message into the conversation so the model sees different input. For JSON parse errors (e.g. heredoc syntax breaking tool call serialization), the guidance specifically steers the model away from the problematic pattern
- **Preview toolbar flicker during typing and generation**: The crosshair and camera icons in the preview panel flickered on every keystroke and generation progress event. Caused by inline arrow functions (`onFullscreen`, `onClose`) defeating `React.memo` on `MultipagePreview`. Extracted to stable `useCallback` handlers

## v1.54.0 - 2026-04-05

### Improved Server Mode Auto-Sync

- **Background sync for projects**: Project saves now automatically push to SQLite in the background (Server Mode only). The existing 2-second debounced `triggerAutoSync` on save is now silent — no toast notifications for routine syncs. Failed syncs retry up to 3 times with backoff (5s, 10s, 15s) before marking the project as error state
- **Background sync for skills**: Custom skill create, update, and delete operations now auto-push to the server in the background via fire-and-forget calls. Built-in skills are excluded
- **Background sync for templates**: Template save (from project), import (`.oswt` file), and delete operations now auto-push to the server in the background
- **Flush on workspace exit**: Leaving the workspace now flushes any pending debounced sync immediately instead of cancelling it. Previously, a save followed by a quick exit would silently drop the sync
- **Flush on tab/window close**: A `beforeunload` handler fires all pending sync timeouts as best-effort before the page unloads

### Skills

- **Skills panel moved up in sidebar**: Skills button now appears above Console in the workspace sidebar, and `DEFAULT_PANEL_ORDER` updated to match
- **Create skill from workspace**: New "+" button in the skills panel header opens a dialog with the skill editor. Created skills are immediately enabled and visible to the AI on the next message

## v1.53.1 - 2026-04-05

### Desktop

- **Desktop CI overhaul**: Rewrote the Electron packaging pipeline. Standalone `.next/` directory was missing due to `cp -r *` not copying dotfiles — switched to `cp -r ./.` syntax. Replaced direct `startServer` API call (which required webpack at runtime) with `require('server.js')` which has the standalone config baked in. Disabled asar packaging to avoid `chdir` failures inside the archive. Excluded sharp from the bundle to fix universal (x64+arm64) build conflicts
- **Desktop auth bypass**: Admin API routes (`/api/admin/*`) were still checking for session tokens despite `OSW_DESKTOP=true`. Added desktop bypass to `getSession()` in `lib/auth/session.ts` — returns a synthetic admin session when running as desktop app. Covers all routes that use `requireAuth()` or `getSession()`
- **Hide logout in desktop mode**: Logout button in the sidebar is now hidden when `NEXT_PUBLIC_DESKTOP=true` since the desktop app has no authentication

## v1.53.0 - 2026-04-04

### Preview

- **Full size preview mode**: New Maximize button in the preview panel's device-size toolbar (next to mobile/tablet/desktop). Hides the workspace header, sidebar, panel header, and all other panels — the preview fills the entire viewport edge-to-edge (no padding, rounded corners, or shadow). Minimize button in the same toolbar position exits back to the normal workspace layout. All panel state is preserved across transitions

### Templates

- **Create template from project saves to instance**: "Export as Template" renamed to "Create a Template" in the project card menu. Instead of downloading an `.oswt` file, the template is saved directly to the instance's template storage (IndexedDB). Users can then export/download templates from the Templates page

### Fixes

- **Dashboard timestamp removed**: Removed "Updated {time}" text below the Dashboard heading
- **Dashboard recent projects card width**: Recent Projects card in browser mode now takes 50% width on desktop instead of stretching to 100%
- **Preview device size persisted**: The selected device size (mobile/tablet/desktop) in the preview panel is now saved to `localStorage` and restored when the panel is reopened or the page is refreshed
- **New project modal persisting after navigation**: Fixed the "New Project" dialog staying open when navigating back from the workspace to the projects page. The `autoCreateProject` flag (set by dashboard's "New Project" button) was not cleared when entering the workspace, so returning would re-trigger the dialog. Now reset on project select
- **Desktop app crash on launch**: Fixed `Cannot find module 'electron-updater'` error in packaged Electron app. Moved `electron-updater` from `external` to `noExternal` in tsup config so it's bundled into `main.js` instead of relying on runtime module resolution inside the asar

## v1.52.0 - 2026-04-04

### Misc

- **Desktop app**: OSW Studio is now available as a desktop application (Electron) for macOS, Windows, and Linux. The desktop app runs the full Next.js server locally with SQLite support (Server Mode). GitHub Actions CI builds installers for all platforms on `desktop-v*` tags. Auth bypass for desktop via `OSW_DESKTOP` env var — local single-user app doesn't need login
- **Security**: Resolved all npm audit vulnerabilities (22 → 0). Updated handlebars, next, js-yaml, mdast-util-to-hast, minimatch, picomatch, and removed leftover development dependencies

## v1.51.0 - 2026-04-03

### Skills Panel

- **Workspace skills panel**: New resizable panel in the workspace for toggling skills on/off without leaving the editor. Toggled from the left sidebar (purple Sparkles icon). Shows global enable/disable toggle, built-in skills section, and custom skills section — each with individual switches. Toggling a skill immediately reloads transient VFS files so the AI sees the change on the next message

### Panel System Overhaul

- **Shared panel components**: Extracted `PanelContainer` and `PanelHeader` into `components/ui/panel.tsx`. All 8 panels (Chat, File Explorer, Editor, Console, Preview, Checkpoints, Debug, Skills) now use the shared header component with consistent icon, title, actions, and X close button. Eliminates ~20 lines of duplicated header markup per panel
- **Max 3 panels visible**: Opening a 4th panel automatically closes the rightmost visible panel. Keeps the workspace usable instead of cramming 4+ panels into a narrow viewport. The `togglePanel()` function handles the constraint for all panel sources (sidebar buttons, programmatic opens like file click → editor)
- **Slot-based layout**: Panels are assigned to slots (`slot-0`, `slot-1`, `slot-2`) instead of panel-specific IDs. When a panel swaps for another, the new panel inherits the slot's width instead of resetting to its default size. Slot widths persist across swaps via `autoSaveId`
- **Drag-to-reorder panels**: Each panel header has a grip handle for reordering. During drag, dashed drop zones appear between panels and at the edges — the closest zone highlights as the mouse moves (lazy matching, no precision required). The dragged panel gets an orange dashed border that fades when hovering a drop zone. If the mouse stays near the panel's original position, it stays put. Mouse can leave the container freely — only releasing outside cancels. Panel order persists to `localStorage`. Resize handles stay enabled (hidden with CSS, not `disabled` prop) during drag to avoid breaking the library's internal state
- **Replace preview on sidebar hover**: When 3 panels are open and a sidebar button is hovered, the rightmost panel that would be replaced gets an orange dashed border — making it clear which panel will close before clicking
- **Panel state persistence**: Which panels are open/closed and their order are saved to `localStorage` and restored on next visit. Runtime-aware defaults preserved as fallback (preview on for visual runtimes, console on for terminal runtimes)
- **Unified close button**: All panels have an X button on the right side of the header (same size as the panel icon). Replaced the previous hover-to-X icon transition pattern
- **Checkpoint panel restyled**: Updated from gradient backgrounds, smaller text, and plain X button to the standard `bg-card` container with `PanelHeader`
- **Debug panel icon colored**: Bug icon now uses `text-foreground` to match its sidebar button styling
- **Checkpoint tooltip removed**: Removed orange tooltip on checkpoint description hover
- **Tool call preview truncation**: Shell command previews in the chat panel now truncate with ellipsis on a single line instead of wrapping to multiple lines. Uses CSS `truncate` instead of `substring(0, 50)` so the preview fills available width
- **Fix heredoc stdin in chained commands**: `mkdir -p /dir && cat > /file << 'EOF'` failed with "cat: missing file path" because heredoc stdin was passed to the first segment (`mkdir`) instead of the last (`cat`). Fixed by routing stdin to the last segment in `&&`/`||`/`;` chains. This was a significant source of shell failures — every `mkdir && cat > file` pattern was broken

## v1.50.1 - 2026-04-02

### Telemetry Improvements

- **Task ID linking**: Each task now gets a random UUID (`task_id`) passed through `task_started`, `task_complete`, `task_fail`, and `api_error` events. Enables tracing the full lifecycle of a single task including how many API errors occur before completion or failure
- **Error category classification**: `api_error` events now include an `error_category` enum: `credit_exhausted`, `rate_limited`, `model_not_found`, `context_too_long`, `tool_not_supported`, `auth_expired`, `server_error`, `invalid_request`, `unknown`. Classified from status code and response keywords without leaking error body text
- **Task fail reasons**: `task_fail` reason changed from generic `'error'` to `'api_error'` for provider failures. `'stopped'` already existed for user cancellation
- **Task complexity metrics**: `task_complete` and `task_fail` events now include `tool_count`, `turn_count`, and `api_error_count` — tracked by the orchestrator throughout the task lifecycle
- **Provider selection context**: `provider_selected` now includes `has_api_key` (boolean). `model_selected` now includes `previous_model` when the selection changes

## v1.50.0 - 2026-04-01

Error recovery, provider error handling overhaul, and default model change.

### Error Recovery

- **Task pause on API errors**: When an API call fails mid-task, the orchestrator pauses instead of killing the task. The chat shows "Task paused" with the error message and **Continue** / **Cancel** links. The user can fix the issue (wait for rate limits, add credits, fix API key) and click Continue to retry from where the task left off. Multiple consecutive errors each pause independently — the user can keep retrying. When re-opening a project where the last event was an error pause, it renders as a regular "Error" since there's no active task to continue
- **Recursive retry on continue**: Clicking Continue retries the same LLM call with the existing conversation state. If the retry also fails, it pauses again. The Stop button works at any point during a pause — resolves the pending promise and exits the loop cleanly. A fresh AbortController is created on each continue to avoid stale abort signals

### Provider Error Handling

- **Retry on transient server errors**: `fetchWithRetry` now retries 502, 504 (transient server errors) and 529 (Anthropic overloaded) in addition to 429 rate limits. 503 is not retried — OpenRouter uses it for "no provider available" which is a routing issue, not transient. Same exponential backoff (1s, 2s, 4s) with Retry-After header support. Retry toast now shows the actual error type ("Server error (502)" vs "Rate limited")
- **Auth errors across all providers**: 401/403 responses now show actionable messages for all providers — OAuth providers prompt reconnecting, API key providers prompt checking the key in Settings. Previously only showed generic "API error: Unauthorized"
- **Credit/quota exhaustion across providers**: Detected via status 402 or 429 with usage-related keywords. HuggingFace shows pricing info, OpenRouter shows credits link, others get generic billing guidance. Previously only HuggingFace had custom handling
- **Model not found**: 400/404 with "not found"/"does not exist" keywords now shows "Model not available — try selecting a different model" across all providers
- **Tool support missing**: 400 with tool-related errors shows actionable message suggesting MiniMax M2.7. Local providers still fall back to JSON-based tool calling
- **Anthropic 529 overloaded**: Specific message ("temporarily overloaded, will be retried automatically") and added to retry loop
- **OpenRouter 503**: Specific message ("no provider currently available for this model") instead of generic server error

### Default Model Update

- **MiniMax M2.7 as default**: OpenRouter default model changed from `deepseek/deepseek-chat` to `minimax/minimax-m2.7`. MiniMax direct provider default updated from `MiniMax-M2.5` to `MiniMax-M2.7`

### Fixes

- **Fix "New Project" dialog re-opening**: The `?action=create` URL parameter is now consumed and cleared via `router.replace()` after opening the create dialog, preventing it from re-triggering on subsequent navigations to the projects page

## v1.49.0 - 2026-03-31

### `runtime` Shell Command

- **Runtime switching from AI**: New `runtime <name>` shell command lets the AI change the project's runtime programmatically. Validates against the 8 supported runtimes (`static`, `handlebars`, `react`, `preact`, `svelte`, `vue`, `python`, `lua`). Updates `project.settings.runtime` via VFS and replaces `.PROMPT.md` with the new runtime's domain prompt if the current one is a default (leaves custom prompts untouched). Registered in the system prompt, tool registry, tool analytics whitelist, and known shell commands list

### AI Project Setup

- **AI-bootstrapped projects**: New "AI Project Setup" template available in the create project dialog. Instead of manually choosing a runtime and template, the user describes what they want and the AI handles everything — picks the best runtime via the `runtime` command, writes a tailored `.PROMPT.md` with project-specific instructions, creates the folder structure, and proceeds to build. The setup-phase `.PROMPT.md` includes a concise runtime guide and a draft-then-finalize workflow for the project prompt
- **Template UI**: "AI Project Setup" appears as the first option in the template dropdown for all runtimes. An "AI Project Setup" link in the template label row provides a shortcut. Selected template description shown in a bordered box below the dropdown

### Fixes

- **Fix dashboard "New Project" button**: Clicking "New Project" on the dashboard navigated to the projects page but didn't open the create dialog — both "New Project" and "Projects" buttons triggered the same action. Now passes an `autoCreate` flag through the component chain so the create dialog opens automatically on arrival

## v1.48.1 - 2026-03-30

- **Vendor Codex utilities**: Replaced `@spmurrayzzz/opencode-openai-codex-auth` package dependency with vendored `codex-utils.ts` containing only the 5 functions we use (`decodeJWT`, `createCodexHeaders`, `handleErrorResponse`, `getReasoningConfig`, `getNormalizedModel`). The package's module graph pulled in `fs`, `path`, `fileURLToPath`, and prompt-caching logic that baked absolute local paths (`file:///Users/otto/Desktop/...`) into the Next.js standalone build — breaking HuggingFace deployments where those paths don't exist

## v1.48.0 - 2026-03-30

Automatic conversation compaction for long-running agentic sessions, Codex vision support, and provider test harness improvements.

### Conversation Compaction

Long-running agentic sessions accumulate unbounded conversation history — every message, tool call, and tool result is sent to the LLM on each turn. Sessions regularly exceed 200K tokens, which many models don't support. The orchestrator now automatically compacts the conversation when it approaches the model's context limit.

- **Auto-compaction**: After each orchestrator iteration, if the API-reported `promptTokens` exceeds 80% of the compaction limit, the older portion of the conversation is sent for summarization. The summary replaces the older messages while recent turns are kept verbatim. The model continues working with full awareness of what was accomplished
- **Turn-boundary splitting**: Messages are grouped into turns (assistant message + its tool results) before splitting. The most recent ~20% of turns by token budget are preserved verbatim; older turns are summarized. This ensures tool results are never orphaned from their parent assistant message
- **Message flattening for summarization**: Tool-role messages and tool call arguments are converted to plain text before the summarization request. This prevents models from hallucinating tool calls when they see tool patterns in the history without tool definitions. Large file contents in tool arguments are truncated to 500 chars
- **Proportional summary cap**: Summary output is capped at 10% of the compaction limit (max 16K tokens), preventing oversized summaries that leave no headroom for continued work
- **Compaction limit resolution**: Priority chain — user override (per-provider setting) → provider registry `contextLength` → models API `contextLength` (for dynamically discovered models like OpenRouter) → 128K fallback
- **Settings**: "Auto-compact" toggle (default: on) and "Compaction limit (tokens)" field in provider settings. When disabled, no compaction occurs regardless of conversation size
- **Chat divider**: A dashed line with pre/post token counts appears in the chat panel at each compaction point (e.g. "Context compacted — 15K → ~7K tokens"). All pre-compaction messages remain visible above the divider for inspection
- **Fresh context on compaction**: System prompt is re-gathered from current VFS state (file tree, `.PROMPT.md`, server context) on each compaction, ensuring the model sees the latest project structure
- **Sub-agent exemption**: Only the parent orchestrator compacts. Sub-agents (`explore`, `task`, `plan`) are exempt — their iteration caps keep conversations short
- **Reasoning detail stripping**: `reasoning_details` (potentially large encrypted blobs from thinking models) are stripped from the summarization request to avoid wasting tokens
- **Cost tracking continuity**: Compaction LLM call costs are accumulated into `totalUsage` and `totalCost`. Loop detection state is reset after compaction (stale after context change). Iteration counter is not reset (prevents runaway sessions)

### Models API Enrichment

- **Context length passthrough**: The `/api/models` endpoint now returns `{ id, contextLength }` objects for OpenRouter models (previously returned bare ID strings). The model selector caches this metadata, enabling automatic compaction limit resolution for dynamically discovered models without hardcoded registry entries

### Codex Vision Support

- **Image inputs passed through to Responses API**: The Codex adapter (`codex-adapter.ts`) converted all user message content to text-only via `getTextFromContent()`, silently discarding `image_url` blocks. Users sending screenshots or images through Codex (ChatGPT subscription) received responses as if no image was attached. Fix: added `contentToCodexContent()` that maps Chat Completions `image_url` blocks to the Responses API `input_image` format (`{ type: 'input_image', image_url: '<url>' }`), preserving multimodal content alongside text

### Benchmark

- **Compaction test scenarios**: Two benchmark scenarios (`compaction-multipage-site`, `compaction-iterative-expansion`) that generate enough context to trigger compaction at reasonable limits. Assertions verify files created after compaction maintain brand names and navigation links from before compaction — proving context continuity through summarization


## v1.47.0 - 2026-03-27

Sub-agent delegation via the `delegate` shell command, Vue SFC compilation fixes, build command reliability, stop propagation, and project manager performance.

### Sub-Agent Delegation

The orchestrator can now spawn focused sub-agents that run isolated LLM conversations with their own system prompts and iteration limits.

- **`delegate` command**: Three agent types — `explore` (read-only, 5 turns, capped exploration), `task` (full edit, 30 turns, focused coding), `plan` (read-only, 10 turns, structured analysis). Inline and heredoc syntax supported
- **Multi-prompt parallelism**: Multiple quoted prompts in a single command run as parallel agents — `delegate task "edit A" "edit B" "edit C"` spawns 3 concurrent sub-agents from one tool call. Quote parser handles nested quotes in HTML/code content and heredoc boundaries. Hard cap of 8 concurrent delegates per command
- **Cost aggregation**: Sub-agent token usage and costs accumulate into the parent orchestrator's totals
- **Agent isolation**: Each sub-agent gets its own orchestrator instance with fresh conversation, loop counters, and state. Sub-agents start with project context (file tree, `.PROMPT.md`) but no parent history. Nested delegation blocked. Skill evaluation skipped for sub-agents
- **Stop propagation**: Parent `.stop()` cascades to all running sub-agents and aborts in-flight `fetch()` calls via `AbortController`
- **Sub-agent visibility**: Real-time sub-agent activity shown in chat UI via `delegate_progress` events with tool call counts. Tool call healing rewrites bare `delegate` tool calls into proper shell calls for conversation history
- **Event filtering**: Only meaningful sub-agent events (`tool_status`, `tool_result`, `error`, `stopped`, etc.) are forwarded to the parent — streaming deltas are excluded
- **Agent-specific system prompts**: Each agent type gets a dedicated prompt — explore (search-first, no speculation), plan (structured what-exists/what-changes/approach output), task (full edit with ss/cat/sed/build/status). All include `.PROMPT.md` and server context
- **Explore/plan exit**: Read-only agents finish when they stop calling tools — no status command or nudging required
- **UI**: Delegate commands show purple bot icon in chat tool badges. `delegate` added to shell command whitelist in tool analytics

### Vue SFC Compilation Fixes

Two bugs in the Vue SFC compilation pipeline that caused Vue projects to silently fail to render.

- **Template-only SFC support**: `.vue` files without a `<script>` block (like the Vue starter template's `App.vue`) previously produced empty JavaScript — `scriptCode` stayed `''` because `compileScript()` was skipped, so `import App from './App.vue'` got `undefined` and `createApp(undefined).mount("#root")` silently failed. Fix: when no script block exists but a template does, `compileTemplate()` compiles the template into a render function with `compilerOptions: { mode: 'module' }` (for ES module imports), then appends `export default { render }` to produce a valid component module
- **TypeScript in `<script setup lang="ts">`**: The CDN-loaded `@vue/compiler-sfc` leaves TypeScript annotations in `compileScript()` output (e.g. `defineProps<{...}>()`, `defineEmits<{...}>()`) which esbuild rejects when the loader is `'js'`. Fix: after `compileScript()`, if `scriptBlock.lang === 'ts'`, the output is passed through `esbuild.transform()` with `loader: 'ts'` to strip type annotations — the same technique already used for Svelte's `preprocessSvelteTS()`

### Build Command Reliability

- **Own compilation**: The `build` shell command previously piggybacked on the preview's debounced compilation — `waitForCompilation(2000)` listened for the preview's `compilationComplete` event. This caused a race condition: when the AI writes 3+ files in sequence, the preview may compile after the first file (with incomplete project state), commit that partial result, and `build` immediately drains it — reporting "0 errors" while the bundle wasn't generated. Fix: `build` now creates its own `VirtualServer` instance with the project's `settings.runtime` and calls `compileProject()` directly. The compilation always sees the current VFS state regardless of preview timing. Blob URLs created during compilation are cleaned up immediately since `build` only needs the error output

### Event System

- **ID-based event tracking**: The chat panel's incremental event processor previously used an array index (`lastProcessedIndexRef`) to track which debug events had been processed. When `MAX_DEBUG_EVENTS` was exceeded and events were pruned from the front, the index became stale — pointing past the array boundary or at the wrong event — causing new events to be silently skipped. Fix: replaced with `lastProcessedEventIdRef` which stores the `id` of the last processed event and uses `findIndex()` to locate it after pruning. If the last processed event was pruned, the processor resets and reprocesses all current events
- **Debug event capacity**: `MAX_DEBUG_EVENTS` increased from 500 to 2000 to accommodate delegate sub-agent event volume without triggering frequent front-pruning

### Performance

- **Project manager typing lag**: Typing in the "Create New Project" dialog was extremely laggy because every keystroke on the project name input re-rendered the entire `ProjectManager` component, including all `ProjectCard` components behind the dialog. Fix: `ProjectCard` wrapped in `React.memo()` to skip re-renders when props haven't changed. Action callbacks (`deleteProject`, `duplicateProject`, `exportProject`, `exportProjectAsZip`) wrapped in `useCallback` with stable dependencies. Inline `onUpdate` handler extracted to a `useCallback`-wrapped `handleProjectUpdate` that uses functional state update (`setProjects(prev => ...)`) instead of closing over `projects`. `filteredBuiltInTemplates` memoized with `useMemo` keyed on `newProjectRuntime`

### Stop & Cancellation

- **Immediate stop**: Clicking "Stop" now immediately aborts in-flight LLM calls via `AbortController` instead of waiting for the current response to complete. The abort signal propagates through the response stream reader, so both the parent orchestrator and any running sub-agents halt mid-stream
- **Upstream cancellation**: The API route (`/api/generate`) now passes `request.signal` to all upstream provider `fetch()` calls. When the client disconnects, the server-side connection to the provider is also closed — stopping inference and billing for providers that support it (OpenAI, Anthropic, Ollama, LM Studio, HuggingFace TGI). Providers that don't support server-side cancellation (Google Gemini, Groq, MiniMax, SambaNova) will continue generating regardless — this is a provider-side limitation
- **Codex adapter**: `handleCodexGeneration` now accepts and forwards an `AbortSignal` to the upstream Codex fetch

### Chat UX

- **Per-task usage summary**: Token count, cost, and duration are now shown once per task (on the last turn) instead of after every LLM call. Multi-turn tasks that previously showed 5+ usage lines now show one collated summary with the total
- **Task duration**: Usage line now includes elapsed time (e.g. `Tokens: 12,400 • Cost: $0.0041 • 8s`)
- **Turn boundaries**: User follow-up messages now start a new turn, so the previous task's Restore/Retry buttons stay attached to the assistant's last output instead of appearing under the next user prompt

### Code Cleanup

- **Dead code removal**: Removed `Agent.systemPrompt`, `Agent.name`, `Agent.description` fields (stored but never read), `getOrchestratorPrompt()` method, `extractToolCallSummary()` method and unused `toolCallSummary` return value, `stableStringify()` method (unreachable in single-tool architecture), `waitForCompilation()` and its tracking variables from `compile-errors.ts`, dead `providerConfig` from `getProviderConfig()` return
- **Prompt deduplication**: `.PROMPT.md` loading logic (triplicated across `buildExplorePrompt`, `buildPlanPrompt`, `buildDynamicContent`) consolidated — explore/plan now call `buildDynamicContent()`. `ss` editing docs extracted to shared `SS_EDITING_DOCS` constant
- **Sub-agent server context**: Explore and plan sub-agents now receive `serverContext` and call `buildDynamicContent()`, gaining awareness of backend features (sqlite3, edge functions) and Browser Mode fallback text. Previously hardcoded `hasServerContext: false`
- **Sub-agent chatMode inheritance**: Task sub-agents now inherit parent's `chatMode`, preventing writes when parent is in read-only mode
- **ss entity detection**: `ssAutoDetectEntityType` (5 return values, only 1 distinguished) simplified to `ssIsHtmlEntity` returning boolean. HTML tag regex updated to handle `>` inside quoted attributes. Depth tracking no longer goes negative on malformed HTML
- **VirtualServer constructor**: Refactored from 6 positional params (3 commonly `undefined`) to options object. All 7 call sites updated
- **Quote parser fix**: `extractTopLevelQuotedStrings` now captures unterminated trailing prompts regardless of prior successful parses
- **ss regex `$$` escape**: `$$` in `ss --regex` replacement now produces a literal `$` (previously no escape mechanism)
- **Analytics whitelist**: Added `preview`, `python`, `python3`, `lua` to `SHELL_COMMAND_WHITELIST` in tool analytics
- **Project tree fix**: `buildProjectContext` now renders `scheduled-functions/` directory when present; skill connector logic accounts for `fileTree` presence
- **Miscellaneous**: `agentType` parameter typed as `AgentType` instead of `string`, pre-compiled `/\s/` regex in fuzzy match, removed redundant bounds checks and unreachable guards, `AgentRegistry.register()` made private


## v1.46.0 - 2026-03-23

`ss` (supersed) shell command for multiline editing. The shell-only approach from v1.44.0 improved tool call reliability but limited edits to full file rewrites (`cat >`) or single-line substitutions (`sed`). `ss` adds targeted multiline search-and-replace without re-introducing a separate tool.

- **`ss` command**: Four modes via heredoc (`ss /file << 'EOF'`): literal (exact match), `--entity` (give opening line, auto-finds closing boundary), `--fuzzy` (whitespace-normalized), `--regex` (multiline regex with `$1` backreferences). Entity detection supports JS/TS functions, HTML elements, and CSS rules with bracket/depth tracking
- **Editing strategy**: System prompt and workflow skill updated — `ss` for edits, `cat >` for creation/full rewrites, `sed` for single-line regex. `build` and `status` shown with explicit `shell()` wrapper for consistency
- **Harmony format filtering**: Tool calls containing `<|...|>` tokens (internal channel artifacts from GPT-OSS and other harmony-format models) silently discarded before execution. No impact on non-harmony models

## v1.45.0 - 2026-03-22

Single-tool architecture — the `evaluation` tool is removed and the AI's tool surface is reduced to 1 (`shell` only). Benchmarking across models showed that the `status` shell command produces better task completion and tool use than a separate evaluation tool. Shell reliability improvements across the board.

### Status-Only Evaluation

Benchmark analysis confirmed structural problems with the other evaluation modes: the separate `evaluation` tool acted as an escape hatch (models call `goal_achieved: true` after failed work), and the unified `evaluation done` command front-loaded the decision before reasoning. The `status` command forces reasoning-first — `--task`, `--done`, `--remaining` before `--complete` — producing better completion rates across models. Status is now the sole evaluation approach.

- **Removed `evaluation` tool**: Tool definition, executor, `ToolId` union member, shell command handler, and analytics extractor all deleted. Tool surface: 2 → 1
- **Removed `EvaluationMode` type**: The `'standard' | 'unified' | 'status'` type and all mode-branching logic removed from system prompt, orchestrator, and benchmark UI
- **Simplified orchestrator**: Removed evaluation tool state, capture, detection, and rejection intercept. Status detection and nudging run unconditionally
- **Simplified benchmark**: Mode selector buttons removed. Tests always run with status mode

### Explicit Build Command

Added `build` as a shell command for explicit compilation feedback. Returns `"Build successful — 0 errors"` or a formatted error list. Replaces the previous automatic compile error injection between orchestrator iterations — the AI now controls when it checks compilation. Uses event-based synchronization (`compilationComplete` event) instead of fixed delays, so compile errors are never missed on slower framework builds (React/Svelte/Vue)

### Error Handling Improvements

- **Runtime errors deferred to completion**: Runtime errors are no longer injected between iterations (where they cause false positives during multi-file rewrites). Now deferred to the completion gate at `status --complete` — the orchestrator waits for compilation to settle, then blocks completion if errors exist
- **Preview blindness guidance**: System prompt and workflow skill now explicitly state the AI cannot see the preview, directing it to use `build` instead of diagnostic loops

### VFS Shell Improvements

- **Glob expansion**: `*` and `?` patterns in file arguments are expanded against the VFS file listing for commands like `wc`, `ls`, `cat`, `rm`, `cp`, `mv`, `touch`
- **`wc` multi-file output**: Per-file counts with a `total` line, matching real `wc` behavior
- **`ls -l` / `-la` / `-lh`**: Long format with file size, modification date, human-readable sizes, and multi-file/directory support
- **`rg`/`grep` no-match**: Returns empty stdout instead of an error-framed stderr message
- **`sleep` no-op**: Silent pass-through instead of "command not found" error
- **File extension whitelist removed**: `createFile` no longer blocks files with uncommon extensions (`.bak`, `.env`, `.toml`, etc.)

### Shell Parsing Fixes

- **Heredoc greedy matching**: Fixed heredocs truncating when content contains the delimiter word
- **Trailing command after redirect**: Fixed successful `cat > /file` being treated as failure
- **Quote-aware line splitting**: Fixed multiline quoted strings being split into broken fragments

### Skills Restructure

- **`workflow`** (new): Merged from `osw-planning` + `osw-one-shot`. Covers the full project lifecycle, runtime-agnostic. References `build` for post-write verification
- **`responsive`** (new): Dedicated responsive design skill — mobile-first CSS, breakpoints, nav collapse patterns, common mobile failures, touch targets
- **`frontend-design`** (new): Visual design quality — typography, color systems, spatial composition, motion, avoiding generic AI aesthetics
- **Deleted**: `osw-planning`, `osw-one-shot` (content merged into the above)

### Other Changes

- **Runtime-aware domain prompts**: `.PROMPT.md` auto-updates when the project runtime changes. Confirmation dialog if user has customized it
- **Browser Mode awareness**: AI system prompt states backend features are unavailable and suggests client-side alternatives
- **Shell tool visual classification**: Tool call badges now show distinct icons — write (orange), status (orange), shell (blue) — parsed from the `cmd` string
- **Reasoning display fixes**: Fixed coalesced reasoning events dropped during React batching; replaced content-length streaming heuristic with explicit `complete` flag

### Bug Fixes

- **Skills not loading**: `reloadTransientSkills()` was never called from the SkillsManager component — added calls to all 5 mutation paths
- **Backend settings tabs inaccessible**: Server feature tabs had `disabled` prop preventing access to the Browser Mode notice. Now always clickable

## v1.44.0 - 2026-03-16

Unified shell-only file editing — the structured `write` tool is removed in favor of standard shell commands (`cat >`, `sed -i`). Major `sed` enhancements to support the expanded role of shell-based editing.

### Shell-Only File Editing

A/B benchmarking across multiple models (Grok Code Fast, Qwen 3.5 Flash, MiMo v2 Flash) showed that shell-only editing (`cat >`, `sed -i`) was 6-9% cheaper in tokens and eliminated the #1 source of tool call failures (malformed JSON in structured write operations). The structured `write` tool is now removed — the AI edits files exclusively via shell commands.

- **Removed `write` tool**: The JSON-based write tool (update, rewrite, replace_entity operations), its executor `string-patch.ts`, and `ContinuationHandler` are deleted. Tool surface simplified from 3 tools to 2 (`shell`, `evaluation`)
- **Removed `ToolMode` plumbing**: The `'standard' | 'unified'` mode type, mode-conditional system prompts, and write tool rejection logic are removed. There is now only one mode
- **Cleaned up `json-repair.ts`**: Removed write-specific functions (`analyzeOperationType`, `generateContinuationMessage`, `generateUnsafeOperationError`). General repair utilities retained for orchestrator use

### sed Enhancements

With file editing fully reliant on shell commands, the virtual `sed` implementation received a major upgrade to support real-world editing patterns that AI models produce.

- **BRE-to-ERE conversion**: New `breToEre()` function converts sed's Basic Regular Expression syntax to JavaScript ERE — fixes patterns like `darken(var(--primary), 10%)` being treated as regex groups
- **Address-based commands**: Line number addresses (`6s/old/new/`), pattern addresses (`/pattern/d`), and range addresses (`/start/,/end/d`)
- **New commands**: Delete (`d`), change (`c\`), insert (`i\`), append (`a\`), and print (`p`) with full address and range support
- **`-n` flag support**: Enables the suppress-and-print idiom (`-n '/pattern/p'`)
- **`-i` variant handling**: Supports GNU (`-i`), BSD/macOS (`-i ''`), and backup (`-i.bak`) syntax

### Codebase Cleanup

- **Deleted dead files**: `generation-api.ts` (superseded by pricing-cache), `database.ts` (legacy VFS class superseded by `indexeddb-adapter.ts`), `validation.ts` (every export unused)
- **Purged stale write tool references**: Replaced write tool JSON examples in domain prompts, skill content, system prompts, and guided tour with shell equivalents
- **Removed dead code**: Unused types, ConfigManager methods, component props, analytics handlers, and orchestrator plumbing left behind by the write tool removal and earlier refactors

### Benchmark Infrastructure

- **New file editing stress scenarios**: 6 scenarios validating shell-based file editing (special characters, multiline, sequential edits, JSON/CSS files)
- **Updated tracks**: "Write tool" track renamed to "File Editing"

## v1.43.0 - 2026-03-12

Python & Lua scripting runtimes, a unified interactive Console, and a runtime split separating pure static sites from Handlebars-powered templates.

- **Handlebars Runtime Split**: The existing `static` runtime has been renamed to `handlebars` to reflect its Handlebars templating capabilities (partials, data.json, helpers). A new `static` runtime provides pure HTML/CSS/JS with no template engine — `{{mustache}}` syntax in HTML is rendered literally, not compiled. Existing projects are automatically migrated. New projects default to `static`
- **Python Runtime**: Full Python 3 support via Pyodide (CPython compiled to WebAssembly). Supports the Python standard library, `import` between project files, and output file generation (e.g. matplotlib plots written to `/output/`). Pyodide loads from CDN on first execution and is cached by the browser
- **Lua Runtime**: Lua 5.4 support via wasmoon (Lua VM compiled to WebAssembly). Supports `require()` for multi-file projects and standard library modules (string, table, math, io)
- **Interactive Console**: A unified terminal panel replacing the previous output-only Terminal. Combines a VFS shell (commands with pipes, redirects, chaining) and script execution (`exec main.py`) in one xterm.js instance. Command history with Up/Down arrows, Ctrl+C to cancel, Ctrl+L to clear. For Python/Lua projects, auto-runs the entry point on file changes. Available for all project types via the sidebar toggle
- **File Explorer: Run in Console**: Right-click any `.py` or `.lua` file to execute it in the Console
- **Starter Templates**: Handlebars Starter (partials + data.json), Python Starter, and Lua Starter — each with entry points and framework-specific `.PROMPT.md` for the AI
- **Runtime Error Feedback**: JS runtime errors from the preview iframe (uncaught exceptions, unhandled rejections, `console.error()`) now feed back to the AI for auto-correction. Post-completion errors surface as a card above the chat input with "Send" (auto-sends to AI) and "Clear" actions
- **ZIP Export**: Python and Lua projects export raw source files with a README containing run instructions. No compilation step
- **Server Publish: Bundled Runtimes**: Publishing React, Preact, Svelte, and Vue projects in Server mode now compiles bundles client-side before syncing — the server detects pre-compiled `bundle.js`/`bundle.css` and skips the esbuild step
- **Server Publish: Terminal Runtimes Blocked**: Python and Lua projects cannot be published as static deployments. Attempting to publish shows a clear error directing users to ZIP export instead
- **Publish Cleanup**: `.PROMPT.md` excluded from both ZIP exports and published deployments. Preview-only scripts (VFS Asset Interceptor, Console Capture) stripped from published HTML
- **Bug Fix**: Fixed duplicate console messages in the preview caused by React StrictMode double-mounting

## v1.42.0 - 2026-03-08

Multi-framework support — Svelte, Vue, and Preact join React as first-class project runtimes with in-browser SFC compilation, starter templates, and AI domain prompts. Plus publish output cleanup.

- **Svelte 5 Support**: `.svelte` single-file components compiled in-browser via the Svelte 5 compiler loaded from CDN (`esm.sh/svelte@5/compiler`). TypeScript in `<script lang="ts">` blocks is preprocessed — esbuild strips type annotations before the Svelte compiler sees the code, and the `lang="ts"` attribute is removed from the opening tag. CSS uses `css: 'injected'` mode so component styles are bundled automatically. Runes API (`$state()`, `$derived()`, `$effect()`, `$props()`) documented in the domain prompt
- **Vue 3 Support**: `.vue` single-file components compiled in-browser via `@vue/compiler-sfc@3` loaded from CDN. The compiler parses the SFC descriptor, compiles `<script setup>` blocks with inline templates, and injects `<style>` blocks as runtime `<style>` elements via a self-executing function. Bare `import { ... } from 'vue'` statements are rewritten to CDN URLs. Composition API (`ref()`, `reactive()`, `computed()`, `watch()`) documented in the domain prompt
- **Preact Support**: Lightweight React alternative (~3KB) with the same JSX pipeline as React — `jsxImportSource` set to `preact` for automatic JSX transform. Supports Preact signals (`@preact/signals`) for reactive state. Hooks imported from `preact/hooks`. No SFC compilation needed — uses standard `.tsx`/`.jsx` files
- **Runtime Registry**: New centralized `lib/runtimes/registry.ts` replaces scattered if/else chains. Each runtime declares its label, description, bundling config, JSX/SFC settings, source extensions, badge styling, and starter template ID. Helper functions: `getRuntimeConfig()`, `getProjectRuntimes()`, `getRuntimeBadge()`, `isRuntimeBundled()`. Badge colors: React sky-blue, Preact purple, Svelte orange, Vue green, Static gray
- **New Templates**: Three starter templates — Preact (`preact-starter`), Svelte (`svelte-starter`), and Vue (`vue-starter`). Each includes an `index.html` shell with `bundle.js`/`bundle.css` references, a framework-specific entry point (`main.tsx` or `main.ts`), a root component with a counter example, and a `.PROMPT.md` with framework-specific AI instructions
- **Template Registry**: New `lib/vfs/templates/registry.ts` consolidates all built-in template metadata (10 templates across 5 runtimes) into a single registry with `BuiltInTemplateMetadata` interface. Helper functions `getBuiltInTemplate()`, `getBuiltInTemplateIds()`, and `getBuiltInTemplatesForRuntime()` replace the previous ad-hoc template lookups
- **Domain Prompts**: New `getDomainPrompt(runtime)` function in `lib/llm/prompts/index.ts` returns framework-specific AI instructions. Each prompt covers the framework's component model, state management, template syntax, file structure conventions, and CDN import patterns. Used to seed `.PROMPT.md` when creating blank projects
- **VFS Type Support**: `.svelte` and `.vue` added to `SUPPORTED_EXTENSIONS` and `getSpecificMimeType()` — without this, VFS rejects file creation for these extensions. `isBundleableSource()` updated to recognize both extensions for bundle filtering
- **CDN Compiler Loading**: Shared `loadCdnCompiler()` utility with in-memory cache ensures each framework compiler is fetched from esm.sh only once per session. Uses a `new Function('url', 'return import(url)')` wrapper to bypass Next.js bundler interception of dynamic imports
- **esbuild Build Error Piping Fix**: `esbuild.build()` throws an exception on build failures instead of returning errors in the result. Previously this exception propagated up through `bundleProject()` → `runBundleStep()` → `compileProject()`, where it was caught by the preview component — but `commitCompilation()` never ran, so the compile-errors buffer stayed empty and the AI never got feedback. Fix: `bundleProject()` now catches the thrown error, extracts structured errors from `buildError.errors`, and returns them in the `BundleOutput`. Additionally, `compileProject()` wraps its body in `try/finally` so `commitCompilation()` is guaranteed to run even on unexpected exceptions
- **TypeScript IntelliSense**: Updated to be runtime-aware — JSX language service configuration only activates when the runtime has a `jsxImportSource` (React, Preact), not unconditionally for all bundled runtimes
- **Cleaner Published Bundles**: esbuild module boundary comments (`// vfs:/src/App.tsx`, `// ../src/main.tsx`) are stripped from compiled `bundle.js` output. CSS source files under `src/` are excluded from published deployments since they're already compiled into `bundle.css`. `shouldExcludeFromExport()` extended to also exclude `.svelte` and `.vue` source files
- **Conditional Edge Function Interceptor**: The fetch/XHR interceptor script that routes requests to edge function endpoints is now only injected into published HTML when the project actually has enabled edge functions — previously it was injected unconditionally for all deployments
- **Vision Detection from Model Discovery**: Vision/image support detection now checks cached model data from provider APIs (OpenRouter, HuggingFace) before falling back to name-based heuristics. Models like Qwen3.5 that support vision natively without "VL" in the name are now correctly detected, enabling image drop/paste in the chat panel
- **Starter Template Rename**: Framework starter templates renamed to "Starter (React + TypeScript)", "Starter (Preact + TypeScript)", "Starter (Svelte)", "Starter (Vue)" for clarity. Counter examples removed from Svelte and Vue starters — all starters now provide just the minimal correct structure (Hello World)
- **Bug Fix: curl VFS Command Protocol**: `curl localhost:3000` now works without requiring `http://` — the protocol is auto-prepended when missing
- **Bug Fix: LLM "read" Tool Calls**: Models that assume a `read` tool exists (common with tool-use-trained models) no longer get "Unknown tool" errors. `read`, `read_file`, `file_read`, `view`, and `view_file` are automatically routed to `cat` via the shell, eliminating wasted round trips

## v1.41.0 - 2026-03-07

React/TypeScript support via in-browser esbuild-wasm bundling, Server Mode deployment for React projects, runtime badges, and sync dialog UX improvements.

- **React + TypeScript Support**: Projects with `.tsx`/`.ts`/`.jsx` source files are now automatically bundled via esbuild-wasm in the browser. The bundler lazy-loads only when a project contains a recognized entry point (`/src/main.tsx`, `/src/index.tsx`, etc.) — existing HTML/CSS/JS projects never load it. Bare npm imports (e.g. `import { useState } from "react"`) are rewritten to esm.sh CDN URLs and fetched by the browser at runtime — no npm or node_modules needed
- **New Template: React + TypeScript**: Minimal starter — `index.html` shell, `src/main.tsx` entry point, and a bare `App.tsx` with just a Hello World component. Designed as a blank canvas so the AI builds from scratch instead of reworking demo code. Includes `.PROMPT.md` that guides the AI to write TSX components, use CDN imports for npm packages, and follow the `/src/` directory structure
- **New Template: React Demo — Task Tracker**: Interactive task tracker showcasing React components, state, and props — `App.tsx` with `useState`, `TaskForm.tsx` (controlled input + form submit), `TaskItem.tsx` (checkbox toggle, delete), and `App.css`. Ships with 3 sample tasks so users see a working app immediately. Demonstrates component composition, typed props, event handling, and conditional rendering in a compact package
- **esbuild-wasm Integration**: New `lib/preview/esbuild-bundler.ts` module encapsulating all esbuild-wasm interaction — lazy WASM initialization (singleton, browser-cached), VFS resolver plugin with extension probing, and CSS/JSON import support. The bundler produces `/bundle.js` and optionally `/bundle.css` which the existing 3-pass preview pipeline processes unchanged. On Node.js (Server Mode publish), esbuild-wasm auto-initializes without `initialize()` — the browser-only `wasmURL`/`wasmModule` options are skipped
- **Server Mode: React Deployment**: React projects now deploy correctly in Server Mode. Three fixes: (1) `detectBundleEntryPoint()` no longer returns `null` server-side — the `typeof window === 'undefined'` guard that blocked server-side bundling was removed; (2) `esbuild-wasm` added to `serverExternalPackages` in `next.config.ts` so Next.js doesn't bundle it into server chunks (which broke esbuild's internal path resolution); (3) `replaceAssetPathsWithDeploymentPrefix()` now rewrites root-level asset references (`/bundle.js`, `/bundle.css`) — previously only files in known subdirectories (`/styles/`, `/scripts/`, etc.) were prefixed with the deployment path
- **VFS Type Support**: `.ts` and `.tsx` added to `SUPPORTED_EXTENSIONS` (under the `js` category) and `getSpecificMimeType()`. This is the gate-keeper change — without it, VFS rejects `.tsx` file creation entirely. Monaco editor already had ts/tsx syntax highlighting
- **Build Error Feedback**: esbuild errors flow through the existing `pushCompileError()` → `drainCompileErrors()` pipeline so the AI receives build error feedback and can self-correct. `formatCompileErrors()` detects `[esbuild]`-prefixed errors and uses a build-specific message instead of the Handlebars-oriented one
- **ZIP Export for React Projects**: Exported ZIPs include both compiled output (`bundle.js`, `bundle.css`, `index.html`) and raw source files (`.tsx`, `.css`). A `package.json` (with react, vite, typescript deps) and `vite.config.ts` are injected so users can continue development locally with `npm install && npm run dev`
- **Runtime Badges**: Project cards and template cards now show a runtime badge indicating "Static" or "React". On project cards: overlaid on the thumbnail in grid view, next to the title in list view. On template cards: in the tags row alongside the existing "Backend" badge. React badges use a sky/blue color scheme; Static badges use a neutral gray with visible border
- **Template Card: Backend Badge Relocated**: The "Backend" badge on template cards moved from the title row to the tags/footer area for visual consistency with the new runtime badge
- **Sync Dialog: Non-Disruptive Refresh**: After push/pull operations in the Server Sync dialog, the item list no longer flashes. Initial load still shows a full-screen spinner; subsequent refreshes keep the list visible with a semi-transparent overlay spinner. Prevents the jarring content replacement that occurred after every sync operation
- **Bug Fix: Publish Button State**: The publish API response was missing `lastPublishedVersion`, so the deployment card always showed "Publish Deployment" instead of "Republish" after a successful publish. The field is now included in the response
- **TypeScript IntelliSense for React Projects**: New `useTypescriptIntelliSense` hook configures Monaco's TypeScript language service when `runtime === 'react'`. Three concerns: (1) compiler options (`jsx: ReactJSX`, `target: ES2020`, `moduleResolution: NodeJs`, etc.), (2) React 19 type definitions fetched from jsdelivr CDN and cached per session via `Promise.allSettled`, (3) project file sync — all `.ts/.tsx/.js/.jsx` files registered as extra libs for cross-file import resolution, updated on `filesChanged` events (debounced 300ms). `MultiTabEditor` now receives a `runtime` prop and uses the `path` prop on `@monaco-editor/react` to create per-tab models with proper URIs for import resolution. All IntelliSense state cleans up automatically when switching to a static project
- **Bug Fix: Analytics CORS**: Replaced `navigator.sendBeacon()` with `fetch()` + `keepalive: true` in both the telemetry tracker and the deployment analytics script. `sendBeacon` implicitly sends with `credentials: 'include'`, which is incompatible with the server's `Access-Control-Allow-Origin: *` header — causing CORS preflight failures on HF Spaces
- **Project Settings Modal**: The "Backend" button in the workspace header is now "Project" and opens a "Project Settings" modal. A new "General" tab (always accessible, even in browser mode) lets users change the project runtime (Static / React) and preview entry point after creation. The 5 backend tabs (Functions, Helpers, Secrets, Schedules, Schema) remain but are individually gated — in browser mode each shows a "Server Mode Required" message instead of a single lock screen blocking the entire modal. The backend enabled/disabled toggle only appears in Server Mode

## v1.40.0 - 2026-03-07

Local inference improvements and code cleanup.

- **New Provider: llama.cpp**: Run GGUF models locally with `llama-server`. OpenAI-compatible at `localhost:8080`, supports streaming, tool use, and vision (via multimodal projector). No API key required — model discovery via `/v1/models`
- **Local Tool Fallback**: When a local model doesn't support native function calling, the tool-use fallback (JSON-based prompting) now applies to all local providers (Ollama, LM Studio, llama.cpp) — previously only triggered for Ollama
- **Default Model Consolidation**: The per-provider default model mapping was duplicated between the API route and config manager with stale values drifting apart (`claude-3-5-haiku` vs `claude-haiku-4-5`, `gemini-1.5-flash` vs `gemini-2.5-flash`). Extracted to a single `getDefaultModel()` in the provider registry
- **Telemetry Version Fix**: `getAppVersion()` was returning a hardcoded fallback string that went stale each release. Now reads directly from `package.json` — single source of truth, no manual bump needed

## v1.39.0 - 2026-03-05

Two new providers (MiniMax, Zhipu AI), Gemini rebuilt from scratch, and streaming parser improvements for thinking/reasoning display.

- **New Provider: MiniMax**: 5 models — M2.5, M2.5 Highspeed (~100 tps), M2.1, M2.1 Highspeed, and M2. All have 200K context, 128K max output, streaming, and tool calling. Built-in reasoning (always-on, no toggle). Pay-as-you-go from $0.30/$1.20 per 1M tokens, or coding plans from $10/mo
- **New Provider: Zhipu AI (GLM)**: 6 models — GLM-5, GLM-4.7, GLM-4.7 Flash (free), GLM-4.6, GLM-4.6V (vision), and GLM-4.6V Flash (vision, free). Up to 200K context. Supports streaming, tool calling, vision, and thinking mode. Pay-as-you-go from $0.60/$2.20 per 1M tokens, or coding plans from $3/mo
- **Streaming: Thinking/Reasoning Display**: The streaming parser now handles three provider-specific reasoning formats — `reasoning_content` field (Zhipu), inline `<think>` tags in content (MiniMax, Ollama thinking models), and `reasoning` field (DeepSeek via OpenRouter). All are routed to the collapsible thinking section instead of appearing as regular assistant text. A state machine handles `<think>` tags split across chunks, and auto-closes unclosed blocks when tool calls arrive
- **Gemini: Full Rebuild**: The Gemini provider was non-functional — the server was sending OpenAI-format requests to Gemini's native API. Rebuilt with a dedicated transformation layer: messages converted to Gemini's `contents`/`parts` structure, system messages extracted to `system_instruction`, vision content mapped to `inline_data`, and streaming routed to the correct `streamGenerateContent?alt=sse` endpoint. Generation, streaming, vision, tool use, and thinking all work correctly now
- **Gemini: Dynamic Model Discovery**: The model selector now queries Gemini's live API instead of returning a hardcoded list. Fallback models updated from retired 1.5-era to current: Gemini 2.5 Flash (1M context, 65K output), 2.5 Pro, and 2.0 Flash
- **Default Model Updates**: Retired model defaults replaced — Gemini 1.5 Flash → 2.5 Flash, Claude 3.5 Haiku → Claude Haiku 4.5
- **Bug Fix: Zhipu/MiniMax Default Model**: `getProviderDefaultModel()` in ConfigManager was missing cases for the new providers, falling through to the default which returned a DeepSeek model ID
- **Bug Fix: Stream End ThinkTag Flush**: If a stream ended while the `<think>` tag parser had buffered a partial tag prefix (e.g. `<th`), that text was silently lost. Now flushed as content or reasoning on stream end
- **Bug Fix: Error Recovery Tool Call**: The stream parser's error recovery guard required at least one finalized tool call before attempting to salvage an in-progress tool call. Removed the guard so the first tool call is also recovered
- **Bug Fix: Ollama Fallback Headers**: Variable shadowing caused the Ollama tool-calling fallback to send an empty headers object instead of the properly built auth headers
- **Dead Code Removal**: Deleted the `LLMClient` class (~590 lines) — the entire class was unused except for two static methods (`validateApiKey`, `getAvailableModels`), which are now standalone exports. Also removed unused `ProviderSettings` type, unused `icon` field on `ProviderConfig`, unused `DEBUG_TOOL_STREAM` variable, and unused `projectId` from stream parser options

## v1.38.0 - 2026-03-04

Shell `curl` command for inspecting compiled preview output, shell robustness improvements, new benchmark scenarios, and dead code cleanup.

- **Shell: `curl` Command**: New `curl localhost/[path]` command lets the AI (and users in the shell) fetch compiled HTML from the preview engine. Handlebars templates are compiled with partials and data.json resolved, so the output reflects what the browser preview shows. Supports `-s` (silent), `-I` (headers only), `-o FILE` (write to file). Path resolution follows preview conventions: `/` → `/index.html`, `/about` → `/about.html`, `/products/` → `/products/index.html`. The VFS Asset Interceptor script is stripped from output to keep it clean. Only localhost URLs are accepted. Plain `curl` is read-only (works in Chat mode); `curl -o` is a write operation (Code mode only). Listed in the system prompt under Shell commands for both modes
- **Shell: `||` Operator**: The shell now supports the `||` (OR/fallback) operator — `cmd1 || cmd2` runs the second command only if the first fails. Complements the existing `&&` (AND/chain) operator
- **Shell: Durable Redirect Stripping**: Replaced the inline regex filter (`/^2>/`) with a dedicated `stripBashRedirects()` function that walks the args array with an index. Handles both fused (`2>/dev/null`) and split (`2>` `/dev/null`) token forms — the split form previously left an orphaned `/dev/null` argument interpreted as a filename. Covers `2>`, `1>`, `&>`, their `>>` append variants, and `2>&1`. Won't false-positive on path arguments like `/2>file.txt`
- **Shell: Auto-Routing for Misrouted Tool Calls**: When the AI calls a shell command (like `cat`, `curl`, `grep`) as a standalone tool instead of routing through the shell tool, the tool registry now auto-detects this and executes the command through the shell. Previously this was a wasted round-trip with an "Unknown tool" error followed by a retry
- **Bug Fix: Token Estimate in Write Healing**: `estimateTokenCount(String(originalLength))` converted a char count like `5000` to the 4-character string `"5000"`, yielding `~1 token` regardless of content size. Replaced with direct `Math.ceil(originalLength / 4)`. The now-unused `estimateTokenCount` function was removed
- **Code Cleanup**: Removed dead `onCostUpdate` callback (25-line closure passed to streaming parser but never invoked), unused imports (`GenerationAPIService`, `GenerationUsage`, `VirtualFile`, `StreamResponse`), write-only `lastCheckpointId` field, vestigial `fileTree` parameter on `buildShellSystemPrompt`, 4 trivial pass-through wrappers in `string-patch.ts`, `generateSummary()` stub, no-op ternaries in `cp`, redundant `as string` casts, and dead `grep -r` flag. Fixed `||` operator re-executing the last command unnecessarily and variable shadowing in `stableStringify`
- **Benchmark: Preview Scenarios**: Three new test scenarios (`shell-curl`, `shell-curl-path`, `shell-curl-pipe`) under the `shell-preview` category validate that the AI can discover and use `curl` to inspect compiled Handlebars output. Setup includes templates with partials and data.json so assertions verify actual compilation, not raw source

## v1.37.0 - 2026-02-27

System prompt compression and reorganization of how project context reaches the AI model.

- **System Prompt Compression**: Base system prompt reduced from ~5,000 tokens to ~1,800 tokens (~48% reduction including tool definitions). Chat and code mode prompts no longer duplicate the preamble — shared sections extracted into `buildSharedPreamble(isReadOnly)`. File reading flowchart compressed to a 5-line preference list. Write tool section cut from 8 JSON examples to 3 examples + 7 rules; tool schema description reduced from 30 lines to compact one-liners. Evaluation section reduced from ~450 tokens to 3 lines; tool description updated from "Required before finishing work" to "Not needed for simple tasks". Shell tool description reduced from 40 lines to 3 lines. Server context sqlite3 examples reduced from 7 to 3, "COMMON MISTAKES" block removed, backend feature creation patterns compressed to 1-line-each with a `cat /.server/README.md` pointer. Emoji markers and prescriptive language (MUST/NEVER/CRITICAL) softened to direct instructions
- **Project Context in User Message**: Skills list and project file tree moved from the system prompt to the first user message. LLMs weight user messages more heavily than system prompts — these are project state, not behavioral instructions, so they belong closer to the user's request. The system prompt now contains only behavioral content: tool mechanics, `.PROMPT.md` domain instructions, and server context creation patterns. New `buildProjectContext()` export generates the context string; `buildDynamicContent()` consolidates the duplicated `.PROMPT.md` reading and server context loading that was previously copy-pasted between chat and code mode builders
- **Collapsible Project Context UI**: The injected project context no longer appears as raw text in the user's chat bubble. The orchestrator stores clean `displayContent` (user's actual prompt) and `projectContext` separately in `ui_metadata`. The chat panel renders a collapsed "Project context" indicator (click to expand) above the user message. Follows the same collapsible pattern used by tool calls, reasoning, and synthetic errors
- **File Creation Guidelines → Domain Prompt**: The 55-line "CREATE THESE / DON'T CREATE THESE" block moved from the base system prompt to `WEBSITE_DOMAIN_PROMPT` in `lib/llm/prompts/website.ts`. Base prompt retains only "Prefer editing existing files over creating new ones" — the domain-specific guidance now lives where it belongs
- **Bug Fix: Stream Usage Clobbering Header Cost**: When OpenRouter returned actual cost via the `x-openrouter-usage` header, a subsequent `json.usage` chunk in the SSE stream would overwrite `usageInfo` with a fresh object — silently dropping the `cost` and `isEstimated` fields. Now merges stream usage into the existing object with spread (`...usageInfo`) so header-derived cost data is preserved
- **Bug Fix: Noisy Cost Estimation Warnings**: The `[CostCalculator] Using estimated cost based on normalized tokens for OpenRouter` warning fired on every OpenRouter call where cost wasn't in headers — which is most calls. Downgraded to `debug`. The old message also referenced "Generation API for native token counts," a feature that was designed but never wired up
- **Log Level: VFS readFile**: `VFS: File not found for read` downgraded from `error` to `debug`. A missing file is an expected condition (e.g., write tool checks if a file exists before creating it) — callers decide whether it's a problem
- **Shell: Heredoc Support**: The shell tool now supports heredoc syntax (`cat > /file << 'EOF'\ncontent\nEOF`). The heredoc body is extracted before command parsing and piped as stdin to the command — works with `cat` + redirect for writing large files. Supports bare (`EOF`), single-quoted (`'EOF'`), and double-quoted (`"EOF"`) delimiters. This gives LLMs a reliable fallback when the write tool's JSON encoding struggles with large or quote-heavy content. Shell tool description and system prompt updated to document the syntax
- **Handlebars Error Feedback**: Handlebars template compilation errors from the preview now feed back to the LLM asynchronously. New `compile-errors.ts` accumulator module with begin/push/commit/drain lifecycle — VirtualServer pushes errors during `compileProject()` (both pattern-detected and runtime errors like `options.fn is not a function`), and the orchestrator drains them before the next LLM call with a 300ms wait for the debounced preview compilation to finish, injecting a synthetic user message so the LLM can self-correct. Errors are collated per-compilation: rapid recompiles replace rather than accumulate, so the LLM always sees the latest state. Replaces the earlier synchronous post-write `validateTemplate()` approach, which missed cross-file errors and added latency to every write
- **Write Tool: Double-Encoding Healing**: When the LLM sends `operations` as a stringified JSON string that fails to parse, the write tool now attempts 4 healing strategies before giving up: (1) direct parse, (2) fix literal newlines/tabs and retry, (3) JSON structure repair via `attemptJSONRepair()` for truncated brackets, (4) regex content extraction via `extractPartialContent()` for rewrite operations. Previously this was an immediate hard failure that left the LLM stuck in a retry loop. The final error message now also suggests the heredoc fallback

## v1.36.0 - 2026-02-26

Comprehensive benchmark overhaul with assertion-based validation, tool usage analytics, and self-evaluation tracking. Plus `wc` command for the shell.

- **Benchmark Rename**: "Model Tester" renamed to "OSWS Benchmark" across all UI — header, sidebar, project manager button, and info banners reworded to benchmark framing
- **Benchmark: Assertion System**: New programmatic assertion framework replaces the old validation approach. 11 assertion types: `file_exists`, `file_not_exists`, `file_contains`, `file_not_contains`, `file_matches`, `valid_json`, `tool_used`, `tool_args_match`, `output_matches`, `tool_output_matches`, and `judge` (LLM-evaluated). Test pass/fail is now determined by assertions, not just the model's self-evaluation
- **Benchmark: Tool Usage Analytics**: Top-level stats card shows total/successful/failed/invalid tool calls with a per-tool breakdown table (shell, write, evaluation). Invalid tool calls (model hallucinating tools like `read` or `cat` as standalone tools) counted separately
- **Benchmark: Cost & Token Tracking**: Stats cards show running totals for cost (USD), prompt tokens, completion tokens, and total tokens alongside pass rate, timing, and tool stats
- **Benchmark: Self-Evaluation Accuracy**: Tracks whether the model's `goal_achieved` self-assessment matches the assertion-determined result. Displayed as "Self-eval accuracy: X/Y" in track reports and exports — surfaces calibration issues where the model thinks it succeeded but assertions say otherwise
- **Benchmark: Tool Call Details**: Completed tests show an itemized list of every tool call — tool name, success/failure status, and argument preview. Failed tests show specific assertion failure details (e.g. "New title present — still contains Test App") instead of a generic message
- **Benchmark: Live Tool Output**: Generation output stream shows specific tool arguments in real-time (e.g. `[tool] shell — cat /index.html`) instead of the generic `[tool] shell ...`
- **Benchmark: Track Reports & Export**: Track reports include total cost, total tokens, per-tool breakdown, assertion pass rates, and self-eval accuracy. JSON and Markdown exports include the same
- **Shell: `wc` Command**: New `wc` command for counting lines, words, and characters. Supports `-l`, `-w`, `-c` flags and works with stdin via pipes — `find / -type f | wc -l` now works. Documented in system prompt for both Chat and Code modes

## v1.35.0 - 2026-02-25

Decoupled the AI system prompt from website-only output, added per-project `.PROMPT.md` for domain instructions, made the preview entry point configurable, and improved the AI shell tooling.

- **System Prompt Separation**: The monolithic system prompt is now split into a base prompt (tool mechanics, stays in code) and a domain prompt (website knowledge, lives in `.PROMPT.md` per-project). The base prompt no longer contains any website-specific instructions — platform constraints, Handlebars docs, and routing rules all moved out
- **`.PROMPT.md` Loading**: Both Code and Chat mode prompts now read `/.PROMPT.md` from the project's VFS at conversation start. If the file exists, its content is appended as domain instructions; if not, the AI operates with the base prompt only
- **Templates Include `.PROMPT.md`**: All 4 built-in templates (Barebones, Example Studios, Landing Page, Blog) now ship with `/.PROMPT.md` containing the website domain prompt — new projects get full website instructions out of the box
- **Missing `.PROMPT.md` Notification**: Existing projects without a `.PROMPT.md` file show a subtle amber banner at the bottom of the file explorer — click "Add" to create the default website prompt, or "Dismiss" to hide (persisted per-project in localStorage)
- **Configurable Entry Point**: New `previewEntryPoint` project setting — right-click any file in the explorer and choose "Set as Entry Point" to change which file the preview loads first. Defaults to `/index.html` when unset
- **File Explorer Indicators**: Entry point file shows a green Home icon with "(entry)" badge; `.PROMPT.md` shows an amber ScrollText icon with "(AI prompt)" badge
- **Template Rename: "Blank" → "Website Starter"**: The Blank template has been renamed to "Website Starter" to better describe its purpose. Internal ID (`blank`) is unchanged.
- **Tool Rename: `json_patch` → `write`**: The file editing tool presented to LLMs is now named `write` instead of `json_patch`. This is a pure identifier rename — all parameters, operation types (update, rewrite, replace_entity), and internal behavior are unchanged. The rename improves tool selection behavior by using a universally understood name that LLMs naturally gravitate toward, reducing wasted generation cost from incorrect tool choices.
- **Shell Pipes**: Commands can now be chained with `|` — stdout from the left command becomes stdin for the right. Supports multi-stage pipes: `cat /file.txt | grep pattern | head -n 5`. Commands that accept stdin: cat, head, tail, grep, rg, sed.
- **Generic Redirects**: All commands now support `>` (overwrite) and `>>` (append) to write stdout to a file. Previously only `echo` supported `>`. Now `grep -n div /index.html > /results.txt` and `sed 's/old/new/' /f.txt > /out.txt` work as expected.
- **sed Command**: New `sed` command for text substitution. Supports `s/pattern/replacement/[g]` syntax, `-i` for in-place editing, `-e` for multiple expressions, and stdin via pipes. Delimiters: `/`, `|`, `#`, `@`.
- **Repeat Helpers**: Added `{{#times N}}`, `{{#repeat N}}`, and `{{#for N}}` block helpers — all equivalent, repeat content N times with `index`, `first`, `last` context variables. Fixes persistent LLM-generated `{{#for}}` errors (e.g., star ratings). Documented in website prompt and handlebars-advanced skill.
- **Tool Call Analytics**: Expanded `tool_call` telemetry events with safe, whitelisted operation details — shell events now include the command name, pipe/redirect flags; write events include file extension and operation types; evaluation events include goal/continue status. All values are whitelisted to prevent accidental capture of file contents or user code.

## v1.34.0 - 2026-02-22

Major architectural restructure: backend features are now **project-scoped** and "Sites" have been renamed to **"Deployments"** throughout.

- **Sites → Deployments**: The "Site" concept is now "Deployment" everywhere — UI, API routes (`/api/sites/*` → `/api/deployments/*`), URL paths (`/sites/{id}/` → `/deployments/{id}/`), and admin views. Existing databases migrate automatically
- **Project-Scoped Backend**: Edge functions, server functions, secrets, and scheduled functions are now managed at the project level instead of per-deployment. On publish, features are extracted into the deployment's runtime — so one project can power multiple deployments
- **Per-Project Database**: Each project can have its own SQLite database for user-defined tables. Template schemas are applied on project creation; on publish, schema + data are extracted to the deployment runtime
- **Split Deployment Databases**: The old unified database is now split into `runtime.sqlite` (functions, secrets, user tables) and `analytics.sqlite` (pageviews, sessions) per deployment. Automatic migration on first access
- **"Server Features" → "Backend"**: The umbrella term renamed to "Backend" in all UI labels, toolbar buttons, template badges, and docs
- **Project Backend Panel**: New tabbed modal for managing backend features at the project level — edge functions, server functions, secrets, scheduled functions, and a rewritten schema editor with Tables, SQL, and DDL tabs
- **Deployment Selector**: New dropdown in the workspace header to choose which deployment's runtime context the AI should be aware of
- **Project Swap**: When repointing a deployment to a different project, a conflict analysis dialog shows added/removed/changed features so you can review before confirming
- **Template Unification**: Removed the separate "Site template" type — all templates now use a single format with an optional `backendFeatures` field. Older `.oswt` files with the legacy `serverFeatures` key still import correctly
- **Security**: Sync API no longer returns secret values in GET responses; deployment ID format validated before database path interpolation

**Upgrading (Server Mode):** Back up your `data/` and `sites/` directories before updating. This release runs automatic migrations that rename `sites/` to `deployments/` and split unified databases into `runtime.sqlite` + `analytics.sqlite`. Browser Mode users are unaffected.

## v1.33.0 - 2026-02-19
- **Checkpoint System Rework**: New checkpoint panel and redesigned checkpoint lifecycle
  - New "Checkpoints" panel in the workspace — view, jump to, and restore any checkpoint from the session
  - Opening a project creates an immutable "Starting point" checkpoint (`system` kind) that persists for the entire session
  - Multiple manual save checkpoints now supported — saves accumulate instead of replacing each other
  - "Discard Changes" always reverts to the session starting point, not the last save
  - Global limit (50) applies only to auto-checkpoints; manual and system checkpoints are never evicted
- **QoL**: Default provider configurable via `NEXT_PUBLIC_DEFAULT_PROVIDER` env var (used by HF deployment)
- **QoL**: Chat input disabled when no credentials configured; model selector button highlights to guide setup

## v1.32.0 - 2026-02-18
- **Anonymous Telemetry**: Client-side usage analytics via [osw-analytics](https://github.com/o-stahl/osw-analytics)
  - Events: session, pageview, heartbeat, provider/model selection, task lifecycle, tool calls, API errors
  - Random anonymous visitor ID (localStorage) for unique visitor counts — no cookies, no fingerprinting
  - Batched payloads via `fetch` with `sendBeacon` fallback on page unload
  - Opt-out toggle in Settings, first-run disclosure dialog, env kill switch (`NEXT_PUBLIC_TELEMETRY_ENABLED=false`)

## v1.31.2 - 2026-02-16
- **Fix**: HF OAuth switched to client-side PKCE via `@huggingface/hub` — no server routes, no cookies, token exchange happens entirely in browser
- **Cleanup**: Removed server-side OAuth routes (login, callback, status, disconnect) and cookie helper

## v1.31.1 - 2026-02-16
- **Bug Fix**: Fixed HF OAuth 401 — HttpOnly cookies silently dropped on HF Spaces; tokens now stored in localStorage via URL fragment
- **Bug Fix**: Fixed OAuth redirect using internal container hostname instead of public URL
- **Improvement**: Token exchange uses Basic auth header; callback validates inference scope before storing
- **Improvement**: HTML error responses from providers sanitized to clean messages
- **Security**: Codex provider hidden on HF Spaces (refresh token too sensitive for localStorage)

## v1.31.0 - 2026-02-15
- **HuggingFace Provider**: New AI provider with free inference tier ($0.10/month free credits)
  - Two auth methods: OAuth (HF Spaces only) and API key (everywhere)
  - Dynamic model discovery — 120+ models with metadata (context length, tool support, vision, pricing)
  - Full cost tracking integrated with session and project cost calculations
  - Credit exhaustion detection with friendly error message
- **UI Overhaul — Model Settings & Settings Popups**: Visual refresh of both settings popups
  - Model Settings: inline model list with search, separate chat model toggle, cleaner section layout
  - Settings: segmented theme selector, streamlined cost tracking, card-style data management
  - Unified connection badge for all providers — HuggingFace, Codex, and API key providers all show a consistent connected/disconnected state
  - API key providers (OpenRouter, OpenAI, Anthropic, Google, Groq, SambaNova) now validate keys on connect instead of saving on every keystroke
- **Bug Fix**: Fixed model selector dropdown extending beyond viewport

## v1.30.0 - 2026-02-14
- **Codex Generation**: The "Codex (ChatGPT Sub)" provider now supports full generation — streaming responses, tool calls (shell, json_patch), and usage-limit error handling
  - Server-side adapter (`lib/llm/codex-adapter.ts`) converts between Chat Completions and Codex Responses API formats
  - Uses `@spmurrayzzz/opencode-openai-codex-auth` for JWT decode, header construction, model normalization, and error parsing
  - No client-side changes — the streaming parser, orchestrator, and UI work unchanged
- **Model List**: Available models: `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1`, `gpt-5-codex`, `codex-mini-latest`; future model IDs are passed through without normalization
- **Codex Error Handling**: Usage limit errors show a clear message with estimated retry time
- **UI**: Codex auth panel layout tightened — "Disconnect" button inline with connection status; security/stability warning banner added
- **Codex Auth**: Refresh token stored in HttpOnly cookie (`osw_codex_rt`), not localStorage — JS never has access to it
  - Server routes handle connect, disconnect, status check, and token refresh (`/api/auth/codex/*`)
  - Client stores only `access_token`, `expires_at`, and `user_email` in localStorage
  - `CLIENT_ID` and refresh token kept server-side only
- **Bug Fix**: Fixed parallel tool call status indicators going to the wrong tool (spinners stuck on completed tools)
  - Root cause: batch-based tracking assumed one `toolCalls` event per batch, but the streaming parser emits one event per tool — so `tool_status` looked up the wrong tool
  - Replaced batch/index Map with a flat per-iteration array; `tool_status` and `tool_result` now use direct index lookup
- **Bug Fix**: Fixed `tool_param_delta` events not coalescing when parallel tools stream interleaved with `toolCalls` events
  - Coalescing now searches backward through the last 4 events for a matching type instead of only checking the last event

## v1.29.0 - 2026-02-13
- **User-Managed Thumbnails**: Replaced automatic screenshot capture with user-initiated controls
  - Camera button (capture) and upload button on project cards, site cards, and the workspace preview toolbar
  - Remove button (X) on hover for cards that already have a thumbnail
  - Removed fire-and-forget screenshot on project save
  - Removed automatic thumbnail capture after site publish
- **New Component**: `ThumbnailArea` — reusable thumbnail widget with capture, upload, and remove states (`sm`/`md` sizes)
- **New Utility**: `captureProjectScreenshot()` — compiles project in a hidden iframe and captures a screenshot on demand
- **Refactored**: `captureSiteScreenshot()` now returns a base64 data URL instead of uploading directly; callers handle persistence
- **New Utility**: `compressImage()` — resizes uploaded images to max 640×360 JPEG, retries at lower quality if over 100KB
- **API**: Site thumbnail endpoint now accepts `null` to clear thumbnails
- Thumbnail area stops event propagation so button clicks don't navigate to the workspace
- **Bug Fix**: Fixed edge function calls from the preview not being intercepted when a site is selected after initial render
- **Bug Fix**: Fixed `ls /.server/` returning empty — transient subdirectories were not synthesized as directory entries
- **Bug Fix**: Added missing scheduled function handlers to `createServerContextFile()` and `updateServerContextFile()`
- **Improvement**: Server context in the file explorer now auto-refreshes after AI operations
- **Improvement**: Edge function route now resolves sites by slug in addition to UUID
- **Improvement**: AI system prompt and skills now instruct the AI to use simple fetch paths in client code
- **Improvement**: File explorer race condition guard for concurrent `loadFiles` calls

## v1.28.0 - 2026-02-10
- **Scheduled Functions**: Run edge functions on cron schedules via the new Schedules tab in Server Settings
  - Create, edit, enable/disable, and delete scheduled functions from the admin UI
  - Standard 5-field cron expressions with timezone support
  - Custom JSON config passed as request body to the linked edge function
  - Execution tracking: next run time, last status (success/error), last run time
  - AI integration: scheduled functions visible in `/.server/scheduled-functions/` context and documented in the `server-functions` skill
- **Server Context**: AI system prompt now includes scheduled function count and creation instructions

## v1.27.0 - 2026-02-06
- **Site Templates**: New template type that bundles frontend files AND backend infrastructure
  - Edge functions, server functions, database schema, and secrets metadata in one `.oswt` file
  - Template format v2.0 with `siteFeatures` object for backend definitions
  - Type filter (All, Project, Site) and badges in template browser
- **Built-in Site Templates**: Two new site templates:
  - **Landing Page with Contact Form** - Professional landing page with Resend email integration, contact form edge functions, and message database
  - **Blog with Comments** - Blog platform with static HTML posts, Handlebars partials, comment system edge functions, and content moderation
- **Automatic Backend Provisioning** (Server Mode): Creating a project from a site template automatically syncs to server, creates a site, and provisions all backend features (database schema, edge functions, server functions, secret placeholders) in one bulk request
- **Export from Sites**: Export any published site as a site template from the Sites view; backend features are automatically captured
- **Graceful Degradation**: Site templates work in Browser Mode (frontend files only); toast notification about Server Mode for backend features
- **Improved Blog Template**: Blog posts are now static HTML pages with Handlebars partials instead of dynamically loaded from the database; post links work correctly under `/sites/{siteId}/`
- **Async Edge Functions**: Edge functions now support `await` (async IIFE wrapper in QuickJS executor) for calling external APIs
- **Improved Edge Function Errors**: Proper error message extraction from QuickJS error objects instead of generic failures
- **Bug Fix**: Static builder missing `fileExists()` in VFS wrapper — Handlebars `data.json` context not loaded during publish
- **Bug Fix**: IndexedDB `init()` race condition — async function was not returning its promise, causing "not initialized" errors

## v1.26.1 - 2026-02-06
- **Bug Fix**: Fixed server sync pull failing when project doesn't exist locally
  - `vfs.getProject()` threw instead of returning null, crashing the pull flow
  - New projects pulled from server were created with a new ID, orphaning synced files
  - `createProject` now accepts an optional ID parameter to preserve server project IDs

## v1.26.0 - 2026-02-04
- **Improved Screenshot Reliability**: Thumbnails now capture fully-loaded content
  - New resource-waiting layer: waits for fonts, images, and browser idle before capture
  - Site publish thumbnails wait ~2.5s minimum (up from 500ms) for resources to load
  - Project save no longer blocks on screenshot — save completes instantly, thumbnail updates in background
  - Spinner overlay shown on site card thumbnail during publish
- **Change Source Project** (Server Mode): Site settings now allow swapping the source project via a dropdown on the General tab, with a warning that it may break the published site
- **Sidebar Version Display**: Application version and mode now shown in sidebar below the app name

## v1.25.2 - 2026-02-03
- **Bug Fix**: Fixed binary file sync and serving in Server Mode
  - Sync now properly serializes ArrayBuffer content to base64 before JSON transport
  - Sites route correctly serves binary files without UTF-8 corruption
  - Handles data URL format (`data:image/...;base64,...`) in both SQLite adapters
- **Bug Fix**: Fixed Model Tester link not navigating correctly from sidebar
- **Docs**: Added comprehensive VPS Deployment Guide with security hardening

## v1.25.1 - 2026-02-03
- **Bug Fix**: Fixed binary files (JPG, PNG, GIF, etc.) not publishing correctly in Server Mode
  - SQLite adapter now properly decodes base64 content back to ArrayBuffer when reading image/video files

## v1.25.0 - 2026-02-02
- **(Optional) Skill Evaluation Pass**: Pre-flight relevance check on the user message before main LLM call
  - Non-streaming call using the selected model determines which skills match the user's prompt
  - Matched skills are injected as explicit directives in the user message for higher adoption
  - 5s timeout with silent fallback on any failure
  - New `skill_evaluation` debug event in the debug panel
  - Toggle in Skills tab (disabled by default)
- **Non-Streaming API Support**: `/api/generate` route now respects `stream: false` parameter
  - Returns JSON response directly instead of SSE stream when streaming is disabled
  - Enables lightweight API calls without stream parsing overhead

## v1.24.0 - 2026-01-26
- **Vision/Image Input Support**: Drop or paste images into the chat input on supported models
  - Supported formats: PNG, JPEG, WebP, GIF
  - Multi-provider support: OpenRouter, OpenAI, Anthropic, Gemini, Ollama (llava models)
  - Image thumbnails shown in chat input with remove button
  - Visual drop indicator when dragging images
  - Automatic model capability detection (GPT-5.x, Claude Opus 4.5, Gemini 3, GLM-4.7V, llava, etc.)
  - Images displayed in chat history at 60px height in a flex container
- **Dismissable Toasts**: All toast notifications now have a close button
- **Bug Fix**: Fixed orchestrator exiting prematurely without evaluation due to stale state
- Updated Next.js to 15.5.9
- Added defensive null checks in sync API routes

## v1.23.0 - 2026-01-18
- **Enhanced Server Sync Modal** (Server Mode): Redesigned sync dialog with granular control
  - Tabbed interface for Projects, Skills, and Templates (previously only projects synced)
  - Per-item sync status badges showing: Synced, Local Newer, Server Newer, Conflict, Local Only, Server Only
  - Hover tooltips explaining each status and recommended actions
  - Individual push/pull buttons per item for precise control
  - Bulk selection with "Select All" and batch push/pull operations
  - Summary bar showing status counts per category
- **Skills & Templates Sync** (Server Mode): Full sync support for custom skills and templates
  - New API endpoints: `/api/sync/skills`, `/api/sync/templates` with individual item routes
  - Skills (localStorage) and templates (IndexedDB) now sync with SQLite server storage
  - Sync metadata tracking: `lastSyncedAt`, `serverUpdatedAt` for three-way comparison
- **Security**: Updated Next.js to 15.3.8 (CVE-2025-55182)

## v1.22.1 - 2026-01-11
- Fixed Server Mode setup docs to match `.env.example`
- Removed unused bcryptjs dependency
- Fixed redirect on new version going to What's New instead of Dashboard

## v1.22.0 - 2026-01-10
- **QuickJS WASM Sandbox**: Upgraded function executor from Node.js VM to QuickJS WebAssembly
  - Edge and server functions now run in isolated WASM sandbox
  - Memory limits enforced by WASM (64MB default)
  - Execution time limits with interrupt handler
  - No access to Node.js APIs (process, require, fs, etc.)
  - Same API surface: `db`, `secrets`, `Response`, `console`, `server`, `fetch`, `atob`, `btoa`
- **Fetch API with Security Controls**: External HTTP requests from functions
  - Max 10 requests per execution
  - 10 second timeout per request
  - 5MB max response body
  - Protocol allowlist: only `http://` and `https://`
  - Private IP blocking in production (localhost, 10.x, 172.16-31.x, 192.168.x, 169.254.x)
  - Development mode allows local requests for testing
- **Base64 Encoding**: Added `atob()` and `btoa()` functions for base64 encode/decode

## v1.21.0 - 2026-01-10
- **Dashboard for Browser Mode**: Dashboard now available in browser mode (previously server mode only)
- **Dashboard as Landing Page**: Dashboard is now the default landing page for both modes
- **Quick Actions Bar**: Create projects, start guided tour, join Discord, and access docs from dashboard
- **What's New Component**: Shows latest version highlights with link to full changelog
- **Recent Projects**: Quick access to recently updated projects from dashboard

## v1.20.0 - 2026-01-08
- **Admin Dashboard** (Server Mode): New landing page after login with server stats and traffic metrics
  - System info: OSWS version, Node.js version, uptime, memory usage
  - Content stats: Projects, templates, skills, total files counts
  - Hosting stats: Published sites, sites with databases, storage used
  - Traffic monitoring: Requests per hour/day, error counts, top sites, recent errors
  - Manual refresh button (no polling overhead)
- **Request Logging**: Lightweight server-side logging for published site traffic
  - Logs site requests to `request_log` table in core database
  - Anonymized IP hashing for privacy
  - Fire-and-forget async inserts (no response latency impact)
  - Automatic 7-day log retention cleanup
- Fixed admin routes (`/admin/*`, `/api/admin/*`) being accessible in Browser mode

## v1.19.5 - 2026-01-07
- Fixed binary file sync causing "Too few parameter values" error (ArrayBuffer becomes {} in JSON)

## v1.19.4 - 2026-01-07
- Fixed VPS deployment docs missing standalone mode static file copy step
- Fixed "Too few parameter values" error in SiteDatabase (mimeType/size null coalescing)

## v1.19.3 - 2026-01-07
- Fixed static site path rewriting for navigation links and root "/" href

## v1.19.2 - 2026-01-07
- Fixed admin login not redirecting after successful authentication
- Fixed file sync failing with "Too few parameter values" error for legacy files

## v1.19.1 - 2026-01-06
- System prompt now recommends `json_patch` over `echo` for creating server functions/edge functions
- Added `SECURE_COOKIES` environment variable to allow insecure cookies for pre-SSL VPS setup

## v1.19.0 - 2026-01-03
- **Server Mode Backend Features**: Complete backend functionality for published sites
  - **Edge Functions**: REST API endpoints with JavaScript runtime
    - Create JavaScript API endpoints for published sites (GET, POST, PUT, DELETE, ANY)
    - Database access via `db.query()` and `db.run()` with parameterized queries
    - External API calls with `fetch()`
    - Isolated execution via Node.js VM contexts with configurable timeouts (1-30 seconds)
    - Access to secrets via `secrets.get()`, `secrets.has()`, `secrets.list()`
  - **Server Functions (Helpers)**: Reusable JavaScript code callable from edge functions
    - Define shared logic once, use across edge functions via `server.functionName()`
    - Same security model as edge functions with full `db` and `fetch` access
  - **Secrets Management**: Encrypted storage for API keys and tokens
    - AES-256-GCM encryption with unique IVs per secret
    - Admin-only access, values never logged or returned in API responses
    - AI can create secret entries, user sets values via admin UI
  - **SQL Editor**: Execute raw SQL queries with Monaco editor and query history
  - **Schema Viewer**: Browse database structure with expandable table/column tree
  - **Execution Logs**: Automatic logging of function invocations with status, duration, timestamps
- **Server Context Integration** (Experimental): AI awareness of site backend features
  - Site Selector dropdown in workspace header to choose site context
  - `/.server/` hidden folder with transient files containing server context
  - AI receives edge functions, database schema, server functions, and secret names
  - Hidden folder icons: purple book for `/.skills/`, orange server for `/.server/`
- **AI Read-Write Access to Backend Features**:
  - `sqlite3` shell command for executing SQL queries on site database
    - Supports `-json` and `-header` output flags
    - System tables protected from modification
  - Edge functions writable via `json_patch` on `/.server/edge-functions/*.json`
  - Server functions writable via `json_patch` on `/.server/server-functions/*.json`
  - Function files use JSON format with metadata (name, method, enabled, code, etc.)
- **Edge Function Routing for Published Sites**: Automatic client-side routing
  - Lightweight interceptor script (~1.5KB) injected into published HTML
  - Intercepts `fetch()` and `XMLHttpRequest` calls to paths without file extensions
  - Routes requests to `/api/sites/{siteId}/functions/{path}` automatically
  - Form submissions with edge function actions intercepted and sent as JSON
  - Custom events: `edge-function-response` and `edge-function-error`
  - Zero server overhead for static files - only edge function calls hit the server
- **Preview Edge Function Support**: Test edge functions in preview before publishing
  - VirtualServer accepts optional siteId parameter
  - VFS interceptor routes edge functions in preview iframe
- **System Prompt Enhancements**: Comprehensive server feature guidance
  - sqlite3 usage examples with proper quoting and common mistakes to avoid
  - Function creation, editing, and deletion patterns
  - JSON format documentation for edge and server functions
- **Bug Fix**: Fixed system prompt being appended on every follow-up message (~8k extra tokens per message)

## v1.18.0 - 2025-12-11
- **SQLite Migration**: Replaced PostgreSQL with SQLite (better-sqlite3) for Server Mode
  - No external database setup required - just `npm install && npm start`
  - Simpler self-hosting with zero configuration
- **Per-Site Database Architecture**: Each site now has its own SQLite database
  - `data/osws.sqlite` - Core database (projects, templates, skills)
  - `sites/{siteId}/site.sqlite` - Per-site database (files, settings, analytics)
- **Memory Leak Fix**: Reduced memory usage during long AI sessions
- **Removed**: PostgreSQL support - `DATABASE_URL` environment variable no longer used
- **Breaking Change**: Existing PostgreSQL Server Mode deployments must migrate data manually

## v1.17.0 - 2025-12-03
- **Reasoning Token Support**: Display reasoning/thinking from compatible models
  - Anthropic extended thinking, DeepSeek R1, Gemini thinking models
  - Separate reasoning tracking with `reasoning_delta` events and coalescing
  - Collapsible reasoning display in chat panel
- **Reasoning Toggle**: Enable/disable reasoning per model in settings
- **Malformed Tool Call Detection**: Auto-detect and correct when model writes tool syntax as text instead of using function calling
- **UI Improvements**:
  - Renamed "Thinking..." to "Waiting for response..." for clarity
  - Fixed "Thinking..." indicator persisting after response completes

## v1.16.0 - 2025-11-23
- **Server Mode (Optional)**: PostgreSQL-backed deployment mode for persistent storage and multi-device access
  - Browser Mode remains the default (IndexedDB, client-side only, no backend required)
  - Server Mode adds PostgreSQL persistence, admin authentication, and sites publishing
  - Automatic database setup (no manual migrations)
  - Bookmarkable URLs for all pages (`/admin/projects`, `/admin/sites`, etc.)
  - Admin login with password protection (24-hour sessions)
- **Published Sites Management**: Create and host static sites directly from your projects
  - New dedicated "Sites" view with search, sort, and filtering
  - Publish projects to live URLs with one click
  - 6 configuration tabs: General, Scripts, CDN, Analytics, SEO, Compliance
  - Custom domain support with automatic HTTPS URLs
  - "Under Construction" mode with placeholder page
  - Status badges: "Live", "Pending Changes", "Under Construction", "Compliance Enabled"
  - Copy site URL to clipboard from context menu
  - Automatic sitemap.xml and robots.txt generation
- **Compliance/Cookie Consent**: GDPR-ready cookie consent banners
  - Opt-in or opt-out consent modes
  - Customizable position (6 locations), button style (pill/rounded/square), and text
  - Privacy policy and cookie policy links
  - Dark mode support and responsive design
- **Sites Publishing Features**: Configure published sites with advanced options
  - Inject custom scripts (head/body) for analytics, tracking, or functionality
  - Add external CDN resources (stylesheets, scripts)
  - Privacy-focused analytics (no cookies, IP anonymization, LocalStorage consent)
  - SEO metadata (title, description, keywords, Open Graph, Twitter Cards)
- **UI/UX Improvements**:
  - Sites view matches modern Projects/Templates/Skills layout
  - Improved modal sizing for better readability
  - Sidebar no longer shifts content when unpinned
  - Site cards display thumbnails, status badges, and quick actions
  - Analytics dashboard shows page views, unique visitors, and referrers
- **Performance**: Sites view loads in <3 seconds for 50 projects
- **Documentation**: Comprehensive docs added for all features (12 guides including Server Mode, Sites Publishing, Deployment, Architecture, and more)
  - Fixed version display showing "-" instead of version number
  - Fixed compliance settings not persisting
  - Fixed site thumbnails not updating
  - Fixed analytics tracking issues
- **Gemini Thinking Model Support**: Full compatibility with Gemini thinking models via OpenRouter
  - Automatic `reasoning_details` preservation for multi-turn tool use conversations
  - Enables reliable function calling with thinking models (previously failed with 400 errors)
- **Skills System Enhancements**: Reorganized built-in skills for better AI guidance
  - Split `osw-workflow` into focused skills: `osw-planning` (multi-page site planning) and `osw-one-shot` (landing page generation)
  - Improved skill descriptions to be more action-oriented
  - Skills now appear in Project Structure shown to AI (previously only listed separately)
- **Debug Panel Improvements**: Enhanced debugging experience
  - The mini terminal can be used to test out or perform VFS operations 
  - Easier troubleshooting of AI file operations

## v1.15.0 - 2025-11-04
- Added Agent Skills System (Anthropic-inspired, compatible with prompt-only skills) with integrated Skills tab (Projects | Templates | Skills)
- Global enable/disable toggle for entire skills system with per-skill enable/disable controls
- Built-in skills: OSW Workflow (comprehensive website building guide), Handlebars Advanced, Accessibility (WCAG 2.1 AA)
- Create custom skills with markdown-based editor (YAML frontmatter + content, follows Anthropic SKILL.md convention)
- Import/export skills as .md files or .zip archives
- Skills automatically injected into AI system prompt when enabled (prompt-only approach)
- Expandable/collapsible skill cards with content preview
- Dual-mode skills editor (form view + raw markdown view)
- Moved hidden files toggle from file explorer header to right-click context menu
- Hidden files now only show enabled skills in `/.skills/` folder
- AI interacts with transient files (skills, temp files) via shell commands

## v1.14.1 - 2025-11-02
- Fixed Cmd/Ctrl+S triggering project save when Monaco editor has focus (now lets Monaco handle file saves internally)
- Enhanced directory-based routing: paths ending with `/` now correctly resolve to `index.html` (e.g., `/about/` → `/about/index.html`)
- Added fallback routing logic: `/about` tries `/about.html` first, then `/about/index.html` as fallback
- Updated system prompt documentation to clarify directory index resolution and clean URL support
- Smart JSON repair for truncated tool calls: auto-repairs and executes safe operations (rewrite), fails gracefully with guidance for unsafe operations (update/replace_entity)
- Removed duplicate naive JSON repair from streaming parser to prevent malformed JSON
- Fixed LLM message rendering: normalizes excessive whitespace in LLM output that caused ReactMarkdown to incorrectly render plain text as indented code blocks
- Fixed guided tour compatibility with v1.14.0 event-driven architecture: tour events now properly convert to debug events for ChatPanel display
- Enhanced guided tour reliability: always creates fresh "Example Studios (Tour)" demo project with correct file structure
- Improved tour UX: automatically navigates to project page after completion when demo project is deleted (if other projects exist)

## v1.14.0 - 2025-10-23
- Event-driven chat architecture replacing message-based system
- Real-time event streaming with chronological display and improved UI responsiveness
- Chat panel with event-driven UI, per-batch tool tracking, green color scheme, and hover-transition close button
- Debug panel with real-time event monitoring, automatic event coalescing, filtering, auto-scroll, and improved close interaction
- Debug event persistence: debounced IndexedDB writes prevent duplicates during rapid streaming
- IndexedDB schema v3: added `debugEvents` object store for persistent debug event storage
- Mobile workspace updated to use event-driven chat architecture
- Refactored architecture: modular tool and agent systems with declarative tool registry
- Enhanced error messages: comprehensive usage hints for shell commands to improve LLM self-correction
- Handlebars partial subdirectory support: organize templates in `/templates/components/`, `/templates/partials/`, etc. with automatic multi-name registration
- Fixed file explorer not refreshing after `json_patch` operations
- Enhanced system prompt with improved Handlebars templating guidance: workflow-first approach, 3-step tutorial, working examples, and common LLM anti-patterns
- Added platform constraints to system prompt: emphasizes static-only websites, Handlebars is build-time not runtime, automatic routing

## v1.13.4 - 2025-10-19
- Enhanced Handlebars with `limit` helper for displaying subset of array items
- Improved json_patch error messages to detect and guide LLMs when operations are incorrectly stringified
- Simplified loop detection logic for more accurate duplicate tool call prevention

## v1.13.3 - 2025-10-19
- Fixed "New Project" dialog to show custom imported templates in dropdown
- Refactored built-in template definitions into centralized registry

## v1.13.2 - 2025-10-19
- Fixed duplicate tool call detection producing false positives for different json_patch operations

## v1.13.1 - 2025-10-17
- Fixed streaming response parser breaking early on `finish_reason` before tool calls arrive
- Fixed "No actions were taken" error appearing despite successful tool call execution
- Fixed success determination to use accumulated tool calls instead of steps completed
- Fixed SSE comment filtering to skip lines starting with `:` (removes "OPENROUTER PROCESSING" messages)
- Enhanced json_patch error messages with detailed format guide, operation types, and examples
- Cleared accumulated tool calls at start of new execution

## v1.13.0 - 2025-10-15
- Added Templates system for creating, managing, and sharing reusable project templates
- Export any project as a template (.oswt file) with customizable metadata (name, description, author, version, tags, license)
- Import templates to quickly start new projects
- Template browser with grid/list views, search, and sorting by name, author, or file count
- Project cards now display preview screenshots automatically captured from live preview
- Redesigned project list view with improved 3-column desktop layout
- Added pill-toggle navigation between Projects and Templates pages

## v1.12.0 - 2025-10-04
- Switch between read-only exploration (Chat) and full coding mode (Code)
- Chat mode: Read-only commands for codebase exploration and planning
- Code mode: Full file modification capabilities with json_patch and evaluation tools
- Write commands (touch, echo >, mkdir, rm, mv, cp) blocked in chat mode with helpful error messages
- Optional separate model selection per mode for cost optimization (e.g., use cheaper models for chat/planning)
- Mode state persists across sessions
- Renamed from DeepStudio to Open Source Web Studio (OSW Studio)
- Updated all UI text, database names, storage keys, and API headers
- Maintained full backward compatibility with DeepStudio .osws backup files
- Integrated new OSW Studio logo with theme-aware SVG (automatic light/dark mode support)
- Added outlined favicon design for visibility on all backgrounds
- Established brand naming convention: "Open Source Web Studio" (full), "OSW Studio" (short)
- Consolidated IndexedDB architecture from 3 separate databases to 1 unified database
- Atomic transactions now possible across all data types (projects, files, conversations, checkpoints)
- Improved import/export performance with single database connection
- Fixed backup import hanging issues with proper timeout handling and blocked connection detection
- Added DeepStudio → OSW Studio migration support via backup import
- Enhanced error handling and logging for all database operations
- Enhanced error handling: API errors now show toast notifications and remove thinking indicator
- Error messages persist in chat history with visual styling for easy troubleshooting
- Mobile save button indicator in workspace header appears when unsaved changes exist
- Added "Thinking..." indicator for LLM response wait times
- Early tool call visibility with streaming parameter updates
- Fixed chat auto-scroll during streaming (instant scroll instead of competing animations)
- Fixed preview button flashing during streaming (memoized component and callbacks)
- Subtle retry notifications
- Fixed double JSON encoding in API error responses for cleaner error messages
- Fixed 'echo' and 'touch' commands missing from structural commands for file explorer refresh
- Fixed evaluation tool showing premature status
- Fixed project name input validation
- Fixed metadata URLs (oswstudio → osw-studio) in layout and CLAUDE.md
- Added finish_reason handling for OpenRouter streaming
- Request evaluation when tool calls stop instead of blind retries
- Added runtime validation for tool definitions to prevent malformed tools
- Added loop detection: prevents LLM from repeating the same failing command consecutively
- Added progressive Handlebars rendering: missing partials show inline error stubs instead of failing entire page
- Codebase cleanup: removed 8 unused files and 9 unused dependencies
- Removed tw-animate-css dependency (Tailwind v4 includes built-in animations)
- Removed DeepStudio logo files (deepstudio-logo-dark.svg, app/favicon.ico)
- Updated demo template and GitHub repository links
- Updated theme storage and cost settings event naming

## v1.11.0 - 2025-02-03
- Enhanced evaluation tool with goal-oriented progress tracking (progress_summary, remaining_work, blockers)
- Improved orchestrator loop to properly enforce evaluation after meaningful work (3+ steps)
- Fixed evaluation state handling: now correctly respects should_continue flag
- Added comprehensive error messages with examples for all tool call failures
- Unified error message format across shell, json_patch, and evaluation tools
- Added file creation guidelines to system prompt for cleaner project structure

## v1.10.0 - 2025-02-02
- Added token-efficient shell commands: `rg` (ripgrep), `head`, `tail`, `tree`, `touch`, and `echo >` redirection
- Removed redundant commands: `sed`, `nl`, `rmdir`
- Enhanced system prompt to discourage `cat` usage with decision flowchart and token cost warnings

## v1.9.1 - 2025-01-30
- Fixed Handlebars navigation links being converted to blob URLs instead of remaining as routes

## v1.9.0 - 2025-01-29
- Added complete data backup and restore functionality
- Export all projects, conversations, and checkpoints to .dstudio file
- Import data with merge or replace options
- Fixed changelog versioning to follow semantic versioning (major.minor.patch)

## v1.8.0 - 2025-01-28
- Enhanced system prompt with directory tree structure and file sizes
- Major VFS improvements: Added comprehensive image loading interceptor for dynamic content
- VFS now transparently handles JavaScript-generated images and assets via blob URLs
- Fixed image resolution issues in templates with automatic innerHTML processing
- Refactored template system with self-contained asset definitions
- Unified createProjectFromTemplate function with optional assets parameter

## v1.7.0 - 2025-01-27
- Modularized the monolithic template file
- Removed Handlebars template
- Added step counter to guided tour overlay

## v1.6.0 - 2025-01-27
- Fixed binary file persistence in checkpoint system
- Images and other binary files now properly persist across page reloads
- Added base64 encoding/decoding for binary content in checkpoints
- Updated VFS updateFile to support ArrayBuffer content

## v1.5.0 - 2025-01-26
- Fixed TypeScript compilation error with shell tool oneOf parameter support  
- Enhanced Handlebars error handling with detection of invalid LLM-generated syntax
- Added helpful error messages for common Handlebars pattern mistakes

## v1.4.0 - 2025-01-26
- Improved LLM shell tool compatibility with natural command format support
- Shell tool now accepts both string ("ls -la /") and array (["ls", "-la", "/"]) formats
- Fixed system prompt confusion about model tool-calling capabilities
- Added automatic string-to-array conversion for better first-call success rates

## v1.3.0 - 2025-01-26
- Enhanced demo project with Handlebars templating for navigation and footer
- Added minimal Handlebars component to barebones template
- Improved template organization and maintainability

## v1.2.0 - 2025-01-26
- Fixed mobile streaming disconnection issue in workspace chat panel
- Mobile now properly displays real-time AI responses with tool calls
- Added missing scroll management for mobile chat during streaming
- Aligned mobile and desktop chat rendering behavior

## v1.1.0 - 2025-01-24
- Added Handlebars templating support (.hbs/.handlebars files)
- Templates automatically compile to static HTML on export
- LLM can now create reusable components with partials
- Improved code generation capabilities

## v1.0.0 - 2025-01-23
- Initial public release
- Multi-provider AI support (8 providers)
- Browser-based development environment
- Project management with checkpoints
- Session recovery and persistence