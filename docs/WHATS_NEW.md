# What's New

Welcome to OSW Studio! This page highlights the latest features and updates.

**First time here?** Start with the **[Overview](?doc=overview)** or jump straight to **[Getting Started](?doc=getting-started)** to build your first website in 5 minutes.

---

## v1.67.0 - Server-Side Generation (2026-05-18)

In Server Mode, AI generation tasks now continue on the server if you close your browser tab. Reopen the tab and the completed work is already there. File changes sync back incrementally after each tool call.

### Server-Side Generation
- **Detach-to-server** — Tasks continue running on the server when you close your browser tab. On reconnect, buffered events replay automatically
- **Incremental file sync** — File changes sync back to your browser after each tool call, not just at the end
- **Build delegation** — Bundled runtimes (React, Svelte, Vue) defer their build step to the client on reattach

### Performance
- **Delta event batching** — Streaming responses no longer cause slowdowns during large generations
- **Smarter auto-sync** — Project gallery only fetches projects that are actually newer on the server

### UI
- **Task completion sound** — A chime plays when a background generation finishes

### Fixes (Server Mode)
- **Project deletion syncs to server** — Deleted projects no longer reappear after refreshing the page

---

## v1.66.0 - Multi-Generation (2026-05-16)

You can now run multiple generations at the same time. Start a task on one project, switch to another, and kick off a second task — both run independently. The generation shelf tracks all background tasks with live activity, elapsed time, and controls to stop or jump back in.

### Agent Orchestration
- **Concurrent generation** — Run tasks on multiple projects simultaneously. Each project gets its own orchestrator instance that runs independently
- **Paused task alerts** — Background tasks that hit API errors (like upstream timeouts) show a yellow "Paused" indicator on the shelf with Continue/Cancel — no need to navigate back to handle them

### Fixes
- **Chat history preserved on navigation** — Leaving and returning to a generating project now correctly restores the full conversation and activity log

---

## v1.65.0 - Background Generation & Pinned Checkpoints (2026-05-14)

You can now start a task and browse other projects within OSW Studio without losing it. The orchestrator keeps running while you review other work — come back and your conversation, checkpoints, and generated files are all there. Checkpoints also got an upgrade: pin any checkpoint to keep it permanently, and per-project pruning keeps storage tidy automatically.

### AI Orchestration
- **Tasks survive in-app navigation** — Start a generation, switch to another project to review it, and return to find the completed work waiting for you. The task runs as long as the browser tab stays open
- **Generation shelf** — A floating indicator in the bottom-right shows your running task's project name, prompt, elapsed time, and model while you're elsewhere in the app. Click it to jump back

### Checkpoints
- **Pinned checkpoints** — Pin any checkpoint to keep it forever. Great for bookmarking a known-good state before experimenting with something risky
- **Per-project pruning** — Each project automatically keeps its 5 most recent unpinned checkpoints. Pinned checkpoints are never pruned

---

## v1.64.0 - Mobile Editor UX (2026-05-13)

The mobile workspace gets a major usability pass. A new overflow menu in the bottom bar gives you access to all panels without cluttering the primary navigation. Panel headers slim down on mobile — titles and chrome disappear, leaving only action buttons styled as labeled pills so you can see what each one does at a glance. Panels now fill the full viewport width, and the header shows your project name with the active panel name below it.

### Mobile UX
- **Bottom bar overflow menu** — Chat, Files, and Preview stay in the primary bar; Editor, Checkpoints, Console, Skills, and Debug are in a three-dot overflow menu
- **Compact panel headers** — On mobile, panel headers show only action buttons as labeled pills (e.g. "Clear chat", "Upload", "Add skill") — no title bar, close button, or drag handle
- **Edge-to-edge panels** — Panels fill the full viewport width on mobile with no borders or rounded corners
- **Project name in header** — The workspace header shows your project name with the active panel below it

### Server Mode
- **Auto-pull fix** — Projects on the server are now correctly pulled to new devices; previously the pull silently failed
- **Workspace ID race condition** — Sync API calls no longer fire before the workspace ID is set

### Fixes
- **Runtime switch** — Changing a project's runtime in settings (e.g. React → Static) no longer reverts immediately

---

## v1.63.0 - Cross-Device Sync (2026-05-08)

Server Mode projects now sync seamlessly across devices. New projects push to the server right after creation, opening the gallery pulls in changes from other devices, and entering a project checks for the latest version. Conflicts are surfaced instead of silently overwriting, and a checkpoint is created before any pull so nothing local gets lost.

### Server Mode
- **Auto-sync on creation** — New projects are pushed to the server immediately after they're created, so they appear on other devices without manual sync
- **Background pull on load** — Opening the project gallery pulls in changes from other devices before showing your projects
- **Per-project freshness** — Opening a project checks the server and pulls if newer
- **Conflict detection** — Pushes are rejected when another device has made newer changes; you'll see the conflict instead of overwriting
- **Pre-pull checkpoint** — A checkpoint is created automatically before pulling, so anything you had locally can be restored

### Fixes
- **Publish failure in Server Mode** — Publishing a deployment could fail with a database error; fixed
- **Project ID mismatch on pull** — Pulled projects no longer get random local IDs that broke subsequent sync round-trips

---

## v1.62.0 - Skill Groups & Design Expansion (2026-05-05)

The frontend design skill system expands from 4 to 12 aesthetic directions — brutalist, retro-futuristic, art deco, maximalist, playful, industrial, luxury, and terminal join the original four. Skills can now be organized into groups for bulk enable/disable, making it easy to activate an entire design family or disable server-mode skills for browser-only projects.

### Skills
- **12 frontend design aesthetics** — Eight new sub-skills cover design spaces the original four couldn't reach, with less convergence between generations
- **Skill groups** — Bundle skills under named toggles. Three built-in groups ship: Frontend Design, Server Mode, and Web Standards. Create your own custom groups for project-specific workflows
- **Skills view redesign** — New tabbed interface with bulk actions, group badges, and member-count indicators

---

## v1.61.1 - Server Mode Security (2026-05-03)

Server Mode gains several security and operational improvements for production deployments. Database connections support transparent encryption, API key auth can be locked to specific IPs, and telemetry now distinguishes deployment types for better usage analytics.

### Server Mode
- **Database encryption support** — All SQLite connections accept an optional encryption key via `DB_ENCRYPTION_KEY`. When set, databases are encrypted at rest using SQLCipher. Unset means no encryption — existing instances are unaffected
- **API key IP allowlist** — Instance API key authentication can be restricted to specific source IPs via `GATEWAY_IPS`, so a leaked key alone isn't enough to call the admin API. Supports both IPv4 and IPv6
- **Deployment type telemetry** — Telemetry events now distinguish deployment types (browser, server, desktop, multi-instance) for more accurate usage analytics
- **Session redirect fix** — Auth redirects now use the configured app URL instead of the raw request URL, which resolves to `0.0.0.0` in Next.js standalone mode
- **Admin-only sidebar items** — The Users nav item is hidden for non-admin users

---

## v1.61.0 - Workspace Isolation (2026-05-01)

Workspaces in multitenancy mode are now fully isolated in the browser. Each workspace gets its own local database, so switching workspaces means switching projects, skills, and templates — nothing bleeds through. API keys stay in your browser per device and are never sent to the server for storage. Plus a new split button for checkpoint access, a working dashboard for non-admin users, and several stability fixes.

### Multitenancy
- **Per-workspace browser storage** — Projects, files, skills, and templates are scoped to the active workspace. Browser mode is unchanged
- **Server mode improvements** — Session handoff, webhook events, external auth redirect, and managed mode for multi-instance deployments

### UI
- **Discard Changes split button** — The chevron now opens the full Checkpoints panel for browsing and restoring earlier points
- **Dashboard for all users** — Non-admin users on server mode see their project counts and recent projects instead of a blank page
- **Sync prompt** — When your local browser is empty but the server has projects, a dialog offers to sync them down

### Fixes
- **Checkpoint restore no longer floods the preview** — Restoring a checkpoint with many files triggers one preview rebuild instead of hundreds
- **Stopped tool calls no longer deadlock the conversation** — Interrupted streaming tool calls are cleaned up so the next message goes through
- **Upstream errors surfaced** — Provider errors sent over 200 SSE connections now show in the error dialog

---

## v1.60.0 - Describe Mode (2026-04-26)

New way to start a project: click "Plan the project first" in the create dialog and describe what you want to build. A setup agent figures out the runtime, template, pages, and capabilities through a short conversation. The project starts with full context so the in-project agent doesn't ask the same questions again. Plus folder drag-and-drop upload, paginated list views, a live reasoning preview, and the in-project agent can now ask quick questions with tappable buttons.

### Describe Mode
- **Conversational setup** — Describe what you're building and the agent fills out a project brief and design spec. Review everything in the sidebar before creating
- **Tappable chip prompts** — The agent presents options as tappable buttons when there's a small set of choices, instead of asking in free text
- **Context handoff** — Projects start with `.PROMPT.md`, `.DESIGN.md`, and `.DESIGN-CONVERSATION.md` so nothing from the setup conversation is lost

### Building with the AI
- **In-project agent can ask with chips** — When the AI hits a real either/or choice (a library to use, a layout direction, etc.), it can now surface tappable options instead of asking in prose. Picking one resumes the task with that decision baked in
- **Live reasoning preview** — The reasoning badge now streams the latest thinking inline instead of showing a static `Thinking...` label, so you can see what the model is working through in real time

### File Explorer
- **Folder drag-and-drop upload** — Drop a folder onto the file explorer and the whole tree gets uploaded with the structure preserved. A single progress toast shows live counts ("Uploading 17/42 files · 3/3 folders")
- **Hidden files indicator** — A bar at the bottom shows how many dot-prefixed files and folders are hidden, with a tooltip explaining what it means for exports
- **Faster directory delete** — Deleting a folder with many files now triggers a single preview rebuild at the end instead of one per file

### Quality of Life
- **Unsaved changes guard** — Leaving a project or closing the browser tab now warns when the AI is generating or there are unsaved changes
- **Fullscreen preview keeps your chat draft** — Toggling the preview in and out of fullscreen no longer wipes what you were typing or reloads the preview
- **Paginated list views** — Projects, Templates, Deployments, and Skills now paginate instead of rendering every item at once. Large libraries scroll and search faster. Skills also unifies its Built-in and Custom sections into a single list with toggle chips to hide either group

### Fixes
- **Chained file writes** — When the AI wrote multiple files in one go via back-to-back heredocs, the first file used to swallow everything that followed and the rest were skipped. All files now land where they should
- **`sed` on common file paths** — `sed -i 's/old/new/g' /styles/style.css` and similar commands no longer fail with "unsupported command 'style.css'". The shell parser correctly distinguishes paths from sed expressions

### Privacy & Telemetry
- **Expanded anonymous analytics disclosure** — A few new categorical events (which creation flow and runtime were used, publish success/failure, compaction token counts, whether an image was attached) help surface which features actually matter. The disclosure dialog lists them explicitly, and no file contents, prompts, or names are ever collected. Opt-out remains available

---

## v1.59.0 - Design Skills & Streaming Resilience (2026-04-21)

The frontend design skill is now a skill tree — a base skill with universal design principles plus four aesthetic sub-skills (bold-geometric, soft-organic, editorial, minimal) that teach the AI how to think within each aesthetic rather than applying a one-size-fits-all template. Large file writes are more resilient to provider issues, and the editor now previews images and video files inline.

### Skills
- **Frontend Design skill tree** - The AI now picks an aesthetic direction (bold-geometric, soft-organic, editorial, or minimal) and follows a complete design philosophy — what kinds of fonts to look for, how color relationships should feel, what motion communicates. Each generation produces genuinely different results within the chosen aesthetic

### AI
- **Resilient large file writes** - When a provider truncates or hangs mid-stream (common with some models on large heredoc writes), OSW Studio now recovers gracefully — writing what was received, prompting the model to continue, and timing out after 45 seconds instead of hanging forever

### Editor
- **Media file preview** - Image and video files now show inline previews in the editor with playback controls, instead of "Unsupported File Type"
- **Upload progress** - Large file uploads show a progress toast with file name and size

### Server Mode
- **Rolling session refresh** - Active sessions are extended automatically so you don't get logged out mid-work
- **Session-expired banner** - A visible banner appears when your session expires, with a direct "Log in" link

---

## v1.58.0 - ES Modules & Stability (2026-04-19)

You can now use ES module imports between project files in Static and Handlebars projects — no bundler needed. Login and register pages follow your light/dark theme. Plus a collection of stability fixes for the editor, chat input, and AI orchestration.

- **ES Module Imports** - Use `<script type="module">` with `import` and `export` between project files. Absolute paths like `import { foo } from '/scripts/utils.js'` just work in the preview. For third-party libraries, use CDN URLs (`https://esm.sh/...`). Published sites serve the real files, so imports work in production too
- **Themed Login & Register** - Login and register pages now follow your light/dark theme instead of being locked to dark mode. The logo auto-inverts to match
- **Live Runtime Switching** - When the AI changes the project runtime mid-conversation, the preview picks it up immediately. Previously you had to save and reopen the project to see raw `{{> nav}}` tokens get processed
- **Editor No Longer Crashes** - An error boundary around Monaco catches the disposal errors that used to take down the whole workspace during panel resize or move
- **Snappier Chat Input** - Typing in the prompt textarea no longer re-renders the file explorer, editor, and preview on every keystroke
- **Compaction Improvements** - Conversation compaction is now off by default — enable it per provider in Settings if you want long sessions to compact automatically. When enabled, the threshold works correctly across all providers (including Anthropic) and fires at exactly the configured limit

---

## v1.57.0 - Workspaces & Multitenancy (2026-04-14)

Server Mode now supports multiple users and workspaces. Workspaces are isolated environments with their own projects, deployments, and quotas. Multiple users can share a workspace. Browser Mode is unaffected.

- **Workspaces** - The core unit of organization. Each workspace has its own database, projects, deployments, templates, and skills. Create workspaces for different clients, teams, or projects. Manage them from the workspace switcher in the sidebar or the admin panel at `/admin/workspaces`
- **Shared Access** - Grant users access to workspaces. An agency can build a site in a workspace and invite the client so they can make updates via the AI
- **User Accounts** - First visitor to a fresh instance creates the admin account. Email and password authentication. Admins manage users at `/admin/users`. Additional registration can be open (self-service) or closed (admin-only) via `REGISTRATION_MODE`
- **Quotas** - Each workspace has configurable limits for projects, deployments, and storage. Enforced at creation and publishing time
- **Upgrading** - Existing single-user instances automatically migrate data to a default workspace on first login after upgrading

---

## v1.56.0 - Semantic Blocks (2026-04-12)

Build pages visually by dragging blocks onto the live preview. Semantic blocks are implementation descriptions, not pre-built components. Place one where you want it, and the AI writes custom code that integrates with your existing project.

- **Drag-and-Drop Blocks** - Open the Blocks palette from the preview toolbar and drag any block onto your live preview. The AI receives the block's specification along with the surrounding HTML context and generates an implementation that matches your project's style and structure
- **36 Blocks Across 4 Categories** - Page Structure (Hero, Nav, Footer, Features Grid, Pricing, FAQ, Sidebar Nav, Tabs, and more), Media & Text (Text Block, Image, Video, Gallery, Timeline, Profile Card), Forms & Buttons (Contact Form, Login Form, File Upload, Search Bar, Dropdown Menu), Numbers & Charts (Table, Chart, Stats Counter, Metric Cards, Progress Bar)
- **Unified Context Panel** - Focus context, placed blocks, and attached images are now combined under a single "Included in next message" panel above the chat input. Each section is independently collapsible
- **Improved Workspace Panels** - Panel sizes now persist per panel across reorders and sessions. Drag-reordering preserves each panel's width. Sidebar hover previews use overlays instead of borders

---

## v1.55.0 - More Models & mesh-llm (2026-04-07)

All OpenRouter models are now available, even those without native tool support. Plus a new local inference provider.

- **Use Any Model** - Models without native tool/function calling (Gemma 3n, OLMo, Liquid, etc.) now work. The AI writes commands in bash code blocks instead, and OSW Studio extracts and executes them automatically. The model list shows a "No tools" badge so you know what to expect
- **Model Capability Badges** - The model selector now shows Tools, Vision, Reasoning, and "No native tools" badges so you can see what each model supports at a glance
- **mesh-llm Provider** - New provider for free open model inference via the [mesh-llm](https://github.com/michaelneale/mesh-llm) peer-to-peer network. Run `mesh-llm --auto` locally, then select "mesh-llm" in Settings. Models are auto-discovered from the mesh
- **Better Error Recovery** - Clicking Continue after an API error no longer loops on the same failure. The AI now gets feedback about what went wrong and adjusts its approach

---

## v1.54.0 - Improved Background Sync & Skills (2026-04-05)

Changes you make are now automatically saved to the server in the background — no more manual sync dialog for day-to-day use.

- **Automatic Background Sync** - In Server Mode, project saves now silently push to SQLite in the background. Custom skills and templates sync automatically on create, update, or delete. Failed syncs retry up to 3 times with backoff. Leaving the workspace or closing the tab flushes any pending sync so nothing is lost
- **Create Skills from Workspace** - New "+" button in the Skills panel header lets you create custom skills without leaving the workspace. The skill is immediately available to the AI on the next message
- **Skills Panel Moved Up** - The Skills button in the workspace sidebar now appears above Console for easier access
- **Desktop Auth Fix** - Admin API routes now properly bypass authentication in the desktop app. Previously, deployment pages and the dashboard would fail with unauthorized errors

---

## v1.53.0 - Full Size Preview & Template Improvements (2026-04-04)

Preview the site you're building without any workspace chrome getting in the way, and save project templates directly to your instance.

- **Full Size Preview** - New Maximize button next to the device size icons (mobile/tablet/desktop) in the preview toolbar. Hides the header, sidebar, and all other panels — the preview fills the entire screen edge-to-edge. Click the Minimize button in the same spot to return to the normal workspace
- **Create Templates from Projects** - "Export as Template" is now "Create a Template". Instead of downloading an `.oswt` file, templates are saved directly to your instance's template library. Export or download them later from the Templates page
- **Preview Device Size Remembered** - Your mobile/tablet/desktop selection is now saved and restored when you reopen the preview panel or refresh the page
- **Desktop App Fix** - Fixed a crash on launch caused by a missing module in the packaged Electron app

---

## v1.52.0 - Desktop App (2026-04-04)

OSW Studio is now available as a desktop application for macOS, Windows, and Linux.

- **Desktop App** - Download and run OSW Studio locally as a native desktop application. The desktop version runs the full server with SQLite support, so you get publishing, sync, and all Server Mode features without needing to set up a server. Available from [GitHub Releases](https://github.com/o-stahl/osw-studio/releases)

---

## v1.51.0 - Panel Overhaul (2026-04-03)

The workspace panel system has been rebuilt. Panels are now capped at 3 visible, can be rearranged by dragging, and remember their layout between sessions.

- **Skills Panel** - New panel for toggling AI skills on/off without leaving the workspace. Open it from the sidebar (Sparkles icon) to enable or disable built-in and custom skills — changes take effect on the next AI message
- **Max 3 Panels** - Opening a 4th panel replaces the rightmost one. When hovering a sidebar button that would trigger a replacement, the panel about to close gets a highlighted border so you know what's changing before you click
- **Drag to Reorder** - Grab the grip handle in any panel header to rearrange. Drop zones appear between panels as you drag. Your panel order is saved and restored between sessions
- **Layout Persistence** - Which panels are open, their order, and their widths are all saved. Re-opening a project shows the same workspace layout you left
- **Consistent Headers** - All 8 panels now share the same header component with a unified look: colored icon, title, action buttons, close button
- **Heredoc Fix** - Commands like `mkdir -p /dir && cat > /file << 'EOF'` no longer fail. Previously the file content was routed to `mkdir` instead of `cat`, breaking every chained file creation

---

## v1.50.0 - Error Recovery (2026-04-01)

API errors no longer kill your task. Rate limits, expired keys, and server errors now pause the task instead of ending it.

- **Continue After Errors** - When an API call fails mid-task, the chat shows the error with a Continue link. Fix the issue (wait for rate limits, add credits, update your key in Settings) and click Continue to pick up where you left off. No progress is lost. If it fails again, it pauses again — you can keep retrying
- **Better Error Messages** - Every provider now gets clear, actionable error messages instead of raw API errors. Auth failures tell you to check your key or reconnect. Credit exhaustion links to your provider's billing page. Model not found suggests switching in Settings. Tool support errors recommend MiniMax M2.7
- **Smarter Retries** - Server errors (502, 504) and Anthropic overloaded (529) are now automatically retried with backoff, in addition to rate limits (429)
- **MiniMax M2.7 Default** - OpenRouter default model changed to MiniMax M2.7

---

## v1.49.0 - AI Project Setup (2026-03-31)

New way to start a project: describe what you want and the AI handles the setup.

- **AI Project Setup** - New template option in the create project dialog. Instead of picking a runtime and template manually, describe your project and the AI chooses the best runtime, creates the file structure, and writes tailored project instructions. Available via the "AI Project Setup" link next to the Template selector, or as the first option in the template dropdown
- **`runtime` Command** - The AI can now switch the project's runtime (Static, React, Svelte, Vue, Python, Lua, etc.) on the fly. This powers the AI Project Setup flow but is also available in any project

---

## v1.48.0 - Auto-Compaction (2026-03-30)

Long AI coding sessions no longer silently fail when the conversation gets too large. The AI now automatically summarizes older context when approaching the model's limit, keeping recent work intact while freeing up space to continue.

- **Automatic Context Compaction** - When the conversation approaches your model's context limit, older turns are summarized into a compact recap while recent tool calls and results are kept verbatim. The AI continues working with full awareness of what was accomplished. A dashed divider line appears in the chat showing the compression (e.g. "Context compacted — 15K → ~7K tokens") — you can still scroll up to see everything from before
- **Works With Any Model** - The compaction limit is automatically detected from the model's context window (via provider registry or the models API). You can also set a custom limit per provider in Settings, or disable auto-compaction entirely
- **Codex Vision Fix** - Screenshots and images sent through Codex (ChatGPT subscription) were silently discarded. The AI now sees your images when using Codex, matching the behavior of other providers

---

## v1.47.0 - Sub-Agent Delegation (2026-03-27)

The AI can now delegate sub-tasks to specialized agents that work independently and return a summary — keeping the main conversation focused while exploring or editing in parallel.

- **`delegate` Command** - Three sub-agent types: `explore` for read-only codebase research, `task` for focused coding work, and `plan` for structured analysis. Multiple quoted prompts in a single command run as parallel agents — e.g. the AI can edit three files simultaneously with one delegate call
- **Context Isolation** - Sub-agents explore or edit with their own conversation, so file contents and intermediate steps don't clutter your main chat. You get a clean summary of what was done and what was found
- **Stop Actually Stops** - Clicking "Stop" now immediately halts the AI mid-stream, including any running sub-agents. The cancellation also propagates to the LLM provider so you're not billed for tokens you never see (supported by OpenAI, Anthropic, Ollama, LM Studio, and most OpenRouter providers)
- **Vue Fix** - Vue projects with template-only components (no `<script>` block) or TypeScript in `<script setup lang="ts">` now render correctly. Previously these silently failed
- **More Reliable Builds** - The `build` command now runs its own compilation instead of racing against the live preview's debounced compile. AI coding sessions with multiple rapid file writes no longer get false "0 errors" results
- **Cleaner Chat Log** - Token count, cost, and task duration are now shown once at the end of each task instead of after every AI response. Restore/Retry buttons stay attached to the AI's last output instead of appearing under your follow-up message
- **Faster Project Gallery** - Typing in the "Create New Project" dialog no longer causes lag from re-rendering every project card behind the modal

---

## v1.46.0 - Targeted File Editing (2026-03-23)

The shell-only editing from v1.44.0 improved tool call reliability but limited the AI to full file rewrites (`cat >`) or single-line substitutions (`sed`). A new `ss` (supersed) shell command adds multiline search-and-replace, so the AI can edit specific blocks without rewriting the whole file.

- **`ss` Command** - Multiline find-and-replace via heredoc. Four modes: literal (exact match), `--entity` (give the opening line of a function, element, or CSS rule — boundary detection finds the end), `--fuzzy` (whitespace-normalized matching), `--regex` (multiline regex with backreferences)
- **Harmony Format Support** - GPT-OSS and other harmony-format models now work cleanly across all providers. Internal channel artifacts (`<|channel|>`, etc.) that previously surfaced as spurious tool calls are filtered before execution

---

## v1.45.0 - AI Reliability Improvements (2026-03-22)

Significant improvements to how the AI writes code, understands your project runtime, and evaluates its own work. Shell command parsing is more robust, domain prompts automatically match your project's framework, and the evaluation system has been streamlined.

- **One Tool, No Escape Hatches** - The separate `evaluation` tool has been removed. Previously, models could call `goal_achieved: true` on the evaluation tool to end a task even when work was incomplete. Now the AI must reason through completion via `status --task "..." --done "..." --remaining "..." --complete` — forcing it to articulate what it did and what's left before marking a task done
- **Smarter Shell Parsing** - Fixed three bugs that caused the AI's file write commands to fail silently: heredoc blocks containing their delimiter word no longer truncate early, successful file redirects no longer report as errors, and multiline quoted strings are no longer split into broken fragments. These were the #1 source of cascading failures in longer AI sessions
- **Domain Prompts Follow Runtime** - When you change a project's runtime (e.g. Static to React, or Handlebars to Vue), the `.PROMPT.md` file now automatically updates with the correct framework-specific instructions. If you've customized `.PROMPT.md`, you'll be asked before it's overwritten. This ensures the AI always knows how to write code for your chosen framework
- **Better Skills for All Frameworks** - The built-in Planning and One-Shot skills no longer assume Handlebars. They now provide general best practices (plan first, build main page first, quality checklist) and direct the AI to read `.PROMPT.md` for runtime-specific patterns. Previously, enabling these skills while using React or Vue would actively confuse the AI with Handlebars-specific instructions
- **Browser Mode Awareness** - When using Browser Mode, the AI now knows that backend features (edge functions, database, server functions) aren't available and will suggest client-side alternatives instead of trying to create them
- **Backend Settings Always Accessible** - The server feature tabs (Database, Edge Functions, etc.) are no longer grayed out and unclickable. You can now open each tab to see what's available and why certain features require Server Mode

---

## v1.44.0 - Unified Shell Editing (2026-03-16)

The AI now edits files using standard shell commands instead of a separate structured tool — resulting in more reliable and efficient code generation. The virtual `sed` command has been significantly expanded to support the full range of editing patterns.

- **Shell-Only Editing** - File creation and modification now use `cat > /file << 'EOF'` and `sed -i` instead of the previous JSON-based write tool. This matches how developers naturally work in a terminal and eliminates the most common source of tool call failures
- **Faster & Cheaper** - Benchmarking across multiple models showed 6-9% lower token usage with shell-only editing compared to the previous structured approach
- **Simpler Tool Surface** - The AI's tool surface was reduced from 3 tools to 2 (`shell` and `evaluation`). Fewer tools means fewer opportunities for the AI to pick the wrong one
- **Smarter sed** - The virtual `sed` now supports address-based commands (`/pattern/d` to delete lines, `/start/,/end/c\text` to replace ranges, `i\` and `a\` to insert/append), the `-n` flag with print, and proper regex handling for patterns containing parentheses and special characters

---

## v1.43.0 - Python, Lua, Console & Runtime Split (2026-03-12)

Write and run Python and Lua scripts directly in the browser. A new interactive Console works across all project types. Plus: the Static runtime is now pure HTML/CSS/JS, with Handlebars templating moved to its own dedicated runtime.

- **Static vs Handlebars** - The "Static" runtime now means pure HTML, CSS, and JavaScript — no template engine, no partials, no `data.json`. Projects that use Handlebars templating (partials, `{{> partial}}`, data.json) are now the "Handlebars" runtime with an amber badge. Existing projects are automatically migrated. New projects default to Static (simplest starting point)
- **Python Projects** - Create Python projects and run them in the browser. Full Python 3 via Pyodide (CPython compiled to WebAssembly) — standard library included, multi-file `import` support, and output file generation. The runtime loads from CDN on first run and is cached by the browser
- **Lua Projects** - Create Lua 5.4 projects with `require()` for multi-file support. Runs via wasmoon (Lua VM compiled to WebAssembly). Standard library modules (string, table, math, io) available out of the box
- **Interactive Console** - A unified terminal panel that combines a VFS shell and script execution in one place. Type `ls`, `cat`, `grep`, `tree`, and more — with pipes, redirects, and chaining. Run scripts with `exec main.py`. Command history with Up/Down arrows. Available for every project type via the sidebar toggle
- **Auto-Run for Scripts** - Python and Lua projects auto-run the entry point when you save a file, just like the live preview updates for HTML/CSS/JS projects. Edit your code, see the output instantly
- **Run from File Explorer** - Right-click any `.py` or `.lua` file and select "Run in Console" to execute it immediately
- **Starter Templates** - Handlebars Starter (partials + data.json), Python Starter, and Lua Starter templates with entry points and AI-tuned `.PROMPT.md` files
- **AI Error Feedback** - Script errors (syntax errors, runtime exceptions, timeouts) are fed back to the AI so it can self-correct — same as build errors for React/Svelte/Vue projects
- **Console for All Projects** - The Console isn't just for Python and Lua — toggle it on for any project type to explore files, run shell commands, or test utility scripts. It defaults to visible for script projects and hidden for visual projects
- **Runtime Error Card** - When the preview throws a JS error after the AI finishes (e.g. you click a button that breaks), a red card now appears above the chat input showing the errors. Hit "Send" to auto-send them to the AI for correction, or "Clear" to dismiss
- **ZIP Export for Scripts** - Python and Lua projects export as raw source files with a README containing run instructions — no compilation step needed
- **Server Publish: Bundled Runtimes** - Publishing React, Preact, Svelte, and Vue projects in Server Mode now works correctly. Bundles are compiled client-side before syncing to the server
- **Server Publish: Terminal Runtimes Blocked** - Python and Lua projects cannot be published as static deployments. A clear error directs you to use ZIP export instead
- **Cleaner Published Output** - Internal files (`.PROMPT.md`) and preview-only scripts (Console Capture, VFS Asset Interceptor) are now stripped from published deployments
- **Console Doubling Fix** - Fixed duplicate console messages appearing in dev mode caused by React StrictMode double-mounting the preview

---

## v1.42.0 - Multi-Framework Support (2026-03-08)

Svelte, Vue, and Preact join React as first-class project runtimes. Build with whichever framework you prefer — all compiled in the browser, no setup needed.

- **Svelte 5** - Write `.svelte` single-file components with Svelte 5 runes (`$state()`, `$derived()`, `$effect()`). The Svelte compiler loads from CDN on first use and compiles components in the browser. TypeScript in `<script lang="ts">` blocks is fully supported. Styles in `<style>` blocks are scoped automatically
- **Vue 3** - Write `.vue` single-file components with `<script setup>` and the Composition API (`ref()`, `reactive()`, `computed()`). The Vue compiler loads from CDN and compiles SFCs in the browser. `<style scoped>` works out of the box
- **Preact** - A 3KB React alternative with the same API. Uses `.tsx`/`.jsx` files just like React, plus Preact signals (`@preact/signals`) for lightweight reactive state. If you know React, you know Preact
- **Starter Templates** - Each new framework comes with a starter template that includes an entry point, root component with counter example, and a `.PROMPT.md` with framework-specific AI instructions
- **Framework Selection** - Choose your runtime when creating a project. Each framework shows a colored badge on project and template cards (React blue, Preact purple, Svelte orange, Vue green, Static gray)
- **npm Packages Everywhere** - Import npm packages by name in any framework — `import confetti from "canvas-confetti"` works the same in React, Svelte, Vue, and Preact. All resolved from CDN at runtime
- **Smarter Build Error Recovery** - When esbuild encounters build errors, they're now piped back to the AI as feedback so it can self-correct. Previously, build failures were shown in the preview but the AI never saw them
- **Cleaner Exports** - Published bundles no longer include esbuild module boundary comments. Source files (`.svelte`, `.vue`, `.ts`, `.tsx`, `.jsx`, and `/src/*.css`) are excluded from exports since they're compiled into the bundle
- **Conditional Edge Function Interceptor** - The fetch interceptor script is only injected into published HTML when the project actually uses edge functions, reducing output size for projects without backend features

---

## v1.41.0 - React & TypeScript Support (2026-03-07)

Build React apps with TypeScript — right in the browser. No npm, no build tools, no setup.

- **React + TypeScript Projects** - Create component-based React apps with `.tsx` files. Source files are automatically bundled in the browser — no build tools or setup needed. npm packages like `framer-motion`, `zustand`, or `date-fns` just work — import by name and they're fetched from a CDN at runtime
- **Two React Templates** - A minimal blank starter (Hello World — clean slate for AI) and a demo task tracker (components, state, props, typed interfaces). Pick the starter when you want the AI to build from scratch, or the demo to explore what React in OSW Studio looks like
- **Seamless Preview** - The live preview rebuilds automatically when you edit any file. React projects get the same instant feedback as HTML/CSS/JS projects
- **Smart Export** - ZIP exports include both a ready-to-deploy build and your source files with a `package.json` + `vite.config.ts` for local development
- **Server Mode Publishing** - React projects can now be published in Server Mode, just like static projects
- **Editor IntelliSense** - Full TypeScript IntelliSense in the code editor for React projects — autocomplete for React hooks (`useState`, `useEffect`), JSX support without false errors, and cross-file import resolution. Type definitions load from CDN and are cached for the session
- **Build Error Feedback** - TypeScript and JSX errors are fed back to the AI so it can self-correct
- **Runtime Badges** - Project and template cards now show whether they use "Static" or "React" — visible on thumbnails in grid view and next to titles in list view
- **Smoother Server Sync** - The sync dialog no longer flashes after each push/pull — the list stays visible with a subtle loading overlay
- **Zero Impact on Existing Projects** - The React bundler only loads when a project has `.tsx`/`.ts` entry points. HTML/CSS/JS projects work exactly as before

- **Project Settings** - The workspace header now has a "Project" button that opens a settings modal. Change your project's runtime (Static or React) or preview entry point at any time — no need to recreate the project. Backend features (Server Mode) are organized into their own tabs within the same modal

---

## v1.40.0 - Local Inference Improvements (2026-03-07)

Local model support expanded and infrastructure fixes.

- **New: llama.cpp** - Run GGUF models locally with `llama-server` (default port 8080). Supports streaming, tool use, and vision via multimodal projector. No API key needed — just start the server and select the provider
- **Better Local Model Tool Use** - When a locally-loaded model doesn't support native function calling, OSW Studio now falls back to JSON-based tool prompting for all local providers — previously this only worked with Ollama
- **Version Tracking Fix** - The analytics version indicator was stuck on an old version. Now reads directly from package.json

---

## v1.39.0 - New Providers + Gemini Rebuild (2026-03-05)

Two new AI providers, a Gemini rebuild, and better thinking/reasoning display across providers.

- **New: MiniMax** - 5 models with 200K context, built-in reasoning, and tool calling. Highspeed variants at ~100 tokens/sec. Pay-as-you-go from $0.30/M input tokens, or coding plans from $10/mo. Get an API key at [platform.minimax.io](https://platform.minimax.io/user-center/basic-information/interface-key)
- **New: Zhipu AI (GLM)** - 6 models including GLM-5 (most capable), vision models (GLM-4.6V), and free flash variants. Supports streaming, tool calling, vision, and thinking mode. Get an API key at [z.ai/model-api](https://z.ai/model-api)
- **Better Thinking/Reasoning Display** - Providers that use thinking tokens (MiniMax, Zhipu AI, DeepSeek) now display reasoning in the collapsible thinking section instead of mixing it into the response
- **Gemini Rebuilt** - The Gemini provider was silently broken — rebuilt from scratch with proper API format. Generation, streaming, vision, tool use, and thinking all work now
- **Gemini Model Discovery** - The model selector now queries Gemini's live API instead of showing a hardcoded list
- **Updated Model Defaults** - Retired models replaced: Gemini 1.5 Flash → 2.5 Flash, Claude 3.5 Haiku → Haiku 4.5

---

## v1.38.0 - Preview Inspection & Shell Hardening (2026-03-04)

The AI can now inspect its own compiled output, and the shell handles more real-world command patterns.

- **Shell: `curl` for Preview Inspection** - The AI can now run `curl localhost/` to see the compiled HTML output of any page — Handlebars partials resolved, data.json injected, just like the live preview. This lets the AI debug template issues, verify partials are rendering, and check the final output without guessing. Supports `-I` for headers, `-o` to save to a file, and piping (`curl localhost/ | grep nav`)
- **Shell: `||` Fallback Operator** - Commands can now use `||` to run a fallback if the first command fails, e.g. `cat /config.json || echo "not found"`
- **Shell: Better Bash Compatibility** - Common bash redirect patterns like `2>/dev/null`, `2> /dev/null` (with space), `&>/dev/null`, `1>/dev/null`, and `2>&1` are all handled correctly. The shell quietly strips these since they don't apply in the virtual environment
- **Smarter Tool Routing** - When the AI accidentally calls a shell command (like `cat` or `curl`) as its own tool instead of going through the shell, it now works anyway — the command is automatically routed to the shell instead of failing
- **New Benchmark Scenarios** - Three new preview-focused test scenarios validate the AI's ability to discover and use `curl` to inspect compiled Handlebars output

---

## v1.37.0 - Smarter Prompt Architecture (2026-02-27)

The AI system prompt has been significantly compressed and reorganized so the model pays better attention to what matters.

- **Leaner System Prompt** - The base prompt is ~48% smaller. Duplicate sections between Chat and Code modes eliminated, verbose examples trimmed, and decorative markers removed. The model gets the same instructions in fewer tokens, leaving more room for your project
- **Project Context in Your Message** - The project file tree and skills list now appear in your first message to the AI instead of buried in the system prompt. Models pay more attention to user messages, so the AI is more aware of your project structure and available skills from the start
- **Collapsible Context** - The injected project context shows as a small collapsed "Project context" indicator in the chat — click to expand if you want to see it, otherwise it stays out of the way
- **File Creation Guidelines Moved** - Domain-specific advice about which files to create (and which to skip) now lives in the `.PROMPT.md` domain prompt instead of the base system prompt, where it belongs
- **Handlebars Error Feedback** - When the preview detects a Handlebars template error (syntax issues, misused helpers, missing partials), the AI now sees the error automatically and can fix it — no more silent red error boxes that only you can see
- **Shell: Heredoc Support** - The shell tool now supports `cat > /file << 'EOF'` heredoc syntax for writing large files. This gives the AI a reliable fallback when writing big JSON or HTML files that are tricky to encode
- **Smarter Write Tool Recovery** - When the AI accidentally double-encodes a file write, the tool now attempts to heal the content instead of immediately failing. Fewer wasted retries on large file operations

---

## v1.36.0 - Benchmark Overhaul & Shell `wc` (2026-02-26)

The OSWS Benchmark (formerly "Model Tester") has been rebuilt with programmatic assertions, detailed tool analytics, and self-evaluation tracking — giving you much more insight into how models actually perform.

- **Assertion-Based Validation** - Tests are now validated by 11 assertion types (`file_exists`, `file_contains`, `file_matches`, `tool_used`, `tool_output_matches`, `judge`, and more) instead of relying solely on the model's self-evaluation
- **Tool Usage Analytics** - A new stats card shows total/successful/failed/invalid tool calls with a per-tool breakdown table. Invalid calls (model hallucinating tools like `read`) are tracked separately
- **Cost & Token Tracking** - Running totals for cost, prompt tokens, completion tokens, and total tokens displayed in the stats cards
- **Self-Evaluation Accuracy** - Compares the model's `goal_achieved` self-assessment against what the assertions actually determined. Surfaces cases where the model thinks it succeeded but didn't (or vice versa)
- **Tool Call Details** - Each completed test shows an itemized list of every tool call with name, status, and argument preview. Failed tests show which specific assertions failed instead of a generic message
- **Track Reports & Export** - Track reports and JSON/Markdown exports include tool breakdowns, assertion pass rates, and self-eval accuracy
- **Shell: `wc` Command** - New `wc` command for counting lines (`-l`), words (`-w`), and characters (`-c`). Works with stdin via pipes — `find / -type f | wc -l`

---

## v1.35.0 - Prompt Architecture & Shell Improvements (2026-02-25)

The AI system prompt no longer hard-codes website instructions. Domain knowledge now lives in a per-project `.PROMPT.md` file that the AI reads at conversation start, making OSW Studio adaptable to non-website projects.

- **Per-Project `.PROMPT.md`** - Each project can have a `/.PROMPT.md` file containing domain-specific instructions for the AI. All built-in templates ship with one pre-filled. Existing projects without it see a subtle banner offering to add the default
- **Configurable Entry Point** - Right-click any file in the explorer and choose "Set as Entry Point" to change which file the preview loads first. The entry point shows a green Home icon
- **Template Rename: "Blank" → "Website Starter"** - The Blank template is now called "Website Starter" to better describe its purpose
- **Tool Rename: `json_patch` → `write`** - The file editing tool was renamed for better LLM compatibility. Same behavior, better tool selection
- **Shell Pipes & Redirects** - Commands can now be chained with `|` and output redirected with `>` / `>>`
- **`sed` Command** - New text substitution command with `s/pattern/replacement/[g]` syntax
- **Repeat Helpers** - Added `{{#times N}}`, `{{#repeat N}}`, and `{{#for N}}` Handlebars block helpers

---

## v1.34.0 - Project-Scoped Backend & Deployments (2026-02-22)

Backend features are now managed at the **project level** instead of per-deployment, and "Sites" have been renamed to **"Deployments"** throughout the app.

- **Project-Scoped Backend** - Edge functions, server functions, secrets, scheduled functions, and database schema now live on the project. When you publish, they're automatically extracted into the deployment's runtime. This means one project can power multiple deployments, and your backend travels with the project
- **Per-Project Database** - Each project can have its own SQLite database for user-defined tables. Create tables via the schema editor, query them from edge functions, and they'll be included when you publish
- **"Sites" → "Deployments"** - What was called a "Site" is now a "Deployment" — the UI, API routes, URL paths, and admin views all reflect this. Existing databases migrate automatically
- **"Server Features" → "Backend"** - The toolbar button, template badges, and docs now use "Backend" instead of "Server Features"
- **Project Backend Panel** - New tabbed modal (accessible from the toolbar or project card menu) for managing all backend features in one place. The schema editor has been rewritten with three tabs: Tables (live schema viewer), SQL (query editor), and DDL (apply schema changes)
- **Deployment Selector** - New dropdown in the workspace header to pick which deployment's runtime context the AI should know about
- **Project Swap** - When repointing a deployment to a different project, a conflict dialog shows what will be added, removed, or changed so you can review before confirming
- **Unified Templates** - The separate "Site template" type is gone. All templates now use a single format with an optional `backendFeatures` field. Older `.oswt` files still import correctly
- **Split Databases** - Each deployment now has separate `runtime.sqlite` and `analytics.sqlite` files instead of one unified database. Existing deployments migrate automatically on first access

### Upgrading (Server Mode)

**Back up your `data/` and `sites/` directories before updating.** This release includes significant database and directory migrations that run automatically on first access:

- The `sites/` directory is renamed to `deployments/`
- Each unified `site.sqlite` is split into `runtime.sqlite` + `analytics.sqlite`
- API routes move from `/api/sites/*` to `/api/deployments/*`

The migrations are designed to be seamless, but given the scope of changes, a backup ensures you can roll back if anything goes wrong. Browser Mode users are unaffected.

---

## v1.33.0 - Checkpoint Rework (2026-02-19)

The checkpoint system has been redesigned with a new panel and a clearer lifecycle.

- **Checkpoints Panel** - New panel in the workspace to view, jump to, and restore any checkpoint from your session
- **Starting Point** - Opening a project now creates a permanent "Starting point" checkpoint. "Discard Changes" always takes you back here, no matter how many saves you've made
- **Stacking Saves** - Manual saves now accumulate instead of replacing each other, so you can jump between any saved state
- **Smart Eviction** - Only auto-checkpoints count toward the 50-checkpoint limit. Your manual saves and the starting point are never removed
- **Default Provider** - Self-hosted instances can set a default AI provider via `NEXT_PUBLIC_DEFAULT_PROVIDER`
- **Setup Guidance** - Chat input is now disabled when no API key is configured, and the model selector button highlights to guide you to settings

---

## v1.32.0 - Anonymous Usage Analytics (2026-02-18)

OSW Studio now includes lightweight, anonymous telemetry to help understand which features get used, which providers and models are popular, and where things are breaking. No prompts, code, file names, API keys, or error messages are ever collected.

- **What's tracked** - Page views, provider/model selection, task success/failure rates, tool call outcomes, API error types, and session heartbeats
- **Anonymous visitor ID** - A random UUID stored in localStorage counts unique visitors. It's not tied to any account or personal data and resets if you clear browser storage
- **Opt-out** - Toggle "Anonymous Usage Analytics" off in Settings > Application Settings. A first-run disclosure dialog explains everything on your first visit
- **Transparent** - Built with [osw-analytics](https://github.com/o-stahl/osw-analytics), an open-source analytics system (currently in testing, be sure to star it to get notified when it's done)
- **Low impact** - Events are batched and sent every 30 seconds. If the analytics server is unreachable, events are silently dropped. The app never blocks on telemetry

Self-hosted instances can disable telemetry entirely with `NEXT_PUBLIC_TELEMETRY_ENABLED=false` in `.env` or keep them on to help out with the development.

---

## v1.31.0 - HuggingFace Provider & Settings Refresh (2026-02-15)

HuggingFace is now available as an AI provider. Every HuggingFace account includes $0.10/month in free inference credits.

- **HuggingFace Provider** - New provider in Settings with access to 120+ models across multiple inference backends (Cerebras, Fireworks, Groq, Together, SambaNova, and more) through HuggingFace's unified API
- **Two Auth Methods** - Sign in with OAuth (on HuggingFace Spaces) or paste an API access token (everywhere)
- **Dynamic Model Discovery** - Models are fetched live from HuggingFace with full metadata: context length, tool support, vision capability, and per-model pricing
- **Cost Tracking** - Pricing from the HuggingFace API is automatically registered for accurate session and project cost calculations
- **Credit Limit Handling** - Friendly error message when your free monthly credits are exhausted, with a link to upgrade
- **Refreshed Settings UI** - Both the Model Settings and Settings popups have been redesigned with a cleaner, more compact layout. All providers now use a unified connect/disconnect flow — paste your API key, click Connect (validates first), and see a clean connection badge with a Disconnect option.
- **Bug Fix** - Fixed model selector dropdown overflowing past the bottom of the viewport

### Setup

1. In OSW Studio settings, select **HuggingFace** as your AI provider
2. Go to [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) and create a token with "Make calls to Inference Providers" permission
3. Paste the token and click **Connect**
4. Pick a model and start building — no API costs until you exceed your free credits

---

## v1.30.0 - Codex Generation (2026-02-14)

Use your ChatGPT Plus/Pro subscription to generate code directly in OSW Studio. The new Codex adapter translates between our standard format and the Codex Responses API entirely server-side — the editor, preview, and chat all work exactly as before.

- **Codex Generation** - The "Codex (ChatGPT Sub)" provider now supports full generation with streaming responses and tool calls (shell, json_patch).
- **GPT-5.3 Codex** - New default model. Also available: GPT-5.2 Codex, GPT-5.1 Codex, GPT-5.1 Codex Mini, Codex Mini, and the general-purpose GPT-5.2 and GPT-5.1.
- **Usage Limit Handling** - Clear error messages with estimated retry time when you hit your ChatGPT subscription limits.
- **Compact Auth Panel** - Tighter layout with the "Disconnect" button inline. A warning banner notes the experimental nature of this provider.
- **Secure Auth** - Your ChatGPT refresh token is stored in an HttpOnly cookie, so page scripts can't read it. Only the short-lived access token (~1 hour) is kept in localStorage.
- **Bug Fix** - Fixed parallel tool calls showing stuck spinners. Status updates (executing/completed) now correctly map to the right tool when the AI runs multiple tools at once.
- **Bug Fix** - Fixed streaming parameter deltas not grouping properly during parallel tool execution.

### Setup

1. Install the [Codex CLI](https://github.com/openai/codex): `npm i -g @openai/codex`
2. Run `codex login` and follow the browser prompts
3. Copy your token: `cat ~/.codex/auth.json | pbcopy`
4. In OSW Studio settings, select **Codex (ChatGPT Sub)** and paste the token JSON
5. Pick a model and start building

---

## v1.29.0 (2026-02-13)

- **User-Managed Thumbnails** - Capture, upload, or remove thumbnails on project and site cards via icon buttons in the thumbnail area. The workspace preview toolbar also has a capture button. Uploaded images are automatically compressed. Auto-capture on save/publish has been removed.
- **Server Mode Fixes** - Edge function calls in the preview now work when a site is selected after initial load; `/.server/` folder refreshes automatically after AI operations; AI can create and modify scheduled functions; edge functions resolve by slug

---

## v1.28.0 - Scheduled Functions (2026-02-10)

Run edge functions automatically on a cron schedule. Set up daily cleanups, hourly stats aggregation, weekly report emails, or any recurring task — all managed from the admin UI.

- **Scheduled Functions** - New **Schedules** tab in Server Settings to create, edit, enable/disable, and delete cron-triggered functions
- **Cron Scheduling** - Standard 5-field cron expressions with timezone support (e.g., `0 8 * * *` for daily at 8am)
- **Custom Config** - Pass a JSON object as the request body to the linked edge function on each run
- **Execution Tracking** - Each schedule shows next run time, last status (success/error), and last run time
- **AI Awareness** - The AI can see and create scheduled functions via `/.server/scheduled-functions/` context files

**See**: [Backend → Scheduled Functions](?doc=backend-features#scheduled-functions-cron-jobs) for the full guide with examples.

---

## v1.27.0 - Site Templates (2026-02-06)

A new template type that bundles both frontend files AND backend infrastructure definitions. Site templates include edge functions, server functions, database schema, and secrets metadata — everything needed to deploy a full-stack site in Server Mode.

- **Site Templates** - New template type with backend infrastructure definitions
- **Built-in Site Templates** - Two new built-in templates:
  - **Landing Page with Contact Form** - Professional landing page with working contact form, Resend email integration, and message database (2 edge functions, database schema)
  - **Blog with Comments** - Blog platform with posts, comments, and content moderation (3 edge functions, server function, database schema)
- **Automatic Backend Provisioning** - In Server Mode, creating a project from a site template automatically syncs to the server, creates a site, and provisions all backend features (database schema, edge functions, server functions, secret placeholders) in one step
- **Export from Sites** - Export any published site as a site template directly from the Sites view; backend features are automatically captured
- **Type Filter** - Filter templates by type (All, Project, Site) in the template browser
- **Template Format v2.0** - Extended `.oswt` format with `siteFeatures` object for backend definitions
- **Graceful Degradation** - Site templates work in Browser Mode (frontend files only); toast notification about Server Mode for backend features
- **Improved Blog Template** - Blog posts are now static HTML pages with Handlebars partials (navigation, footer, comments) instead of dynamically loaded from the database. Post links work correctly when published under `/sites/{siteId}/`
- **Async Edge Functions** - Edge functions now support `await` for calling external APIs (e.g., sending emails via Resend, webhooks)
- **Improved Edge Function Errors** - Edge function errors now return meaningful messages instead of generic failures
- **Bug Fix** - Fixed published sites rendering empty Handlebars variables (static builder was not loading `data.json` context)
- **Bug Fix** - Fixed "IndexedDB not initialized" errors across pages caused by a race condition during database initialization

### How It Works

Site templates in **Server Mode** automatically provision the full backend when you create a project: the project is synced to the server, a site is created, and all backend features (database tables, edge functions, server functions, secret placeholders) are set up in one request. You'll see a summary of what was provisioned and a reminder to fill in any secret values via the Admin panel.

In **Browser Mode**, site templates create the frontend files normally. A notification reminds you that backend features require Server Mode.

### For Template Authors

Export projects as site templates in two ways:

1. **From the Sites view** — Use the dropdown menu on any site card and select "Export as Site Template". Backend features (edge functions, database schema, server functions, secrets) from that site are automatically included in the `.oswt` file.
2. **From the Templates tab** — Export any project as a template using the template export dialog.

---

## v1.26.0 - Screenshot Reliability & Project Swap (2026-02-04)

Improved reliability for project and site screenshots, plus smoother save UX.

- **Improved Screenshot Reliability** - Resource-waiting before capture (fonts, images, idle network)
- **Non-blocking Save** - Project save completes instantly; thumbnail updates in the background
- **Publish Spinner** - Spinner overlay on site card during publish and thumbnail capture

---

## v1.25.2 - Binary File Sync Fix

- **Bug Fix** - Fixed binary file sync and serving in Server Mode

---

## v1.25.1 - Binary File Publishing Fix

- **Bug Fix** - Fixed binary files (JPG, PNG, GIF, etc.) not publishing correctly in Server Mode

---

## v1.25.0 - Skill Evaluation Pass (2026-02-02)

A new pre-flight evaluation pass checks which skills are relevant to your prompt before the main AI call. When a match is found, the AI receives an explicit instruction to read the skill first, radically improving skill adoption rates.

Enable it in **[Skills Settings](?doc=skills)** > **Skill Evaluation** toggle.

- **Automatic Skill Matching** - Your selected model evaluates your prompt against enabled skills before each message
- **Explicit Directives** - Matched skills are injected as high-priority read instructions in the user message
- **Debug Visibility** - New `skill_evaluation` event in the debug panel shows what was evaluated and matched
- **Non-Streaming API** - The generate API now supports `stream: false` for lightweight calls

**Note:** This feature is disabled by default as it adds an extra API call per message, which increases initial token usage.

---

## v1.24.0 - Vision/Image Input Support (2026-01-26)

Drop or paste images directly into the chat input to share visual context with the AI on supported models.

- **Image Input** - Drag & drop or paste (Ctrl/Cmd+V) images into the chat
- **Multi-Provider Support** - Works with OpenRouter, OpenAI, Anthropic, Gemini, and Ollama vision models
- **Supported Models** - GPT-5.x, Claude Opus 4.5, Gemini 3 Flash/Pro, GLM-4.7V, llava, Pixtral, and more
- **Smart Detection** - Image input automatically enabled when using a vision-capable model
- **Multiple Images** - Attach multiple images in a single message
- **Formats** - PNG, JPEG, WebP, and GIF supported

### How to Use

1. Select a vision-capable model (e.g., GPT-5.2 via OpenRouter, Claude Opus 4.5, Gemini 3 Pro)
2. Drop an image onto the chat input or paste from clipboard
3. Add your prompt describing what you want
4. Send the message

The AI will analyze the image and can help you recreate designs, extract content, or use it as reference for building your site.

**Note:** For Gemini vision models, use OpenRouter rather than the direct Gemini API for best compatibility.

---

## v1.22.0 - QuickJS WASM Sandbox

Edge and server functions now run in a QuickJS WebAssembly sandbox for stronger security isolation.

- **WASM Isolation** - Separate JavaScript engine via WebAssembly boundary
- **Memory Limits** - 64MB default, enforced by WASM runtime
- **Fetch Security** - 10 requests max, 10s timeout, 5MB limit, private IPs blocked in production
- **Base64 Support** - Added `atob()` and `btoa()` functions

Your existing functions work unchanged with the same API surface.

---

## v1.21.0 - Dashboard for Browser Mode

The dashboard is now available in browser mode and is the default landing page for both modes.

- **Dashboard for Browser Mode** - Dashboard now available in browser mode (previously server mode only)
- **Dashboard as Landing Page** - Dashboard is the default landing page for both modes
- **Quick Actions Bar** - Create projects, start guided tour, join Discord, and access docs
- **What's New Component** - Shows latest version highlights with link to full changelog
- **Recent Projects** - Quick access to recently updated projects from dashboard

---

## v1.20.0 - Admin Dashboard for server mode

A new dashboard is now the landing page after login, giving you a quick overview of your server:

- **System** - OSWS version, Node.js version, uptime, memory usage
- **Content** - Projects, templates, skills, and total files
- **Hosting** - Published sites, sites with databases, storage used
- **Traffic** - Requests per hour/day, error counts, top sites, recent errors

Traffic is logged server-side with automatic 7-day retention.

---

## v1.19.0 - Server Mode Backend

This release adds complete backend functionality for published sites, including edge functions, database management, server functions, secrets, and AI integration.

### Edge Functions

Create serverless JavaScript endpoints for your published sites:

- **REST API endpoints** - GET, POST, PUT, DELETE, or ANY method
- **Database access** - Query your site's SQLite database via `db.query()` and `db.run()`
- **External requests** - Use `fetch()` to call external APIs
- **Sandboxed execution** - Safe VM-based runtime with configurable timeouts (1-30 seconds)
- **Secrets access** - Use `secrets.get()`, `secrets.has()`, `secrets.list()` for API keys

```javascript
// Example: GET /api/sites/{siteId}/functions/get-users
const users = db.query('SELECT * FROM users LIMIT 10');
Response.json({ users });
```

### Server Functions (Helpers)

Create reusable JavaScript helpers callable from edge functions:

- **Code reuse** - Define shared logic once, use across all edge functions via `server.functionName()`
- **Same security model** - Runs in the same sandboxed VM as edge functions
- **Full access** - Helpers have access to `db`, `fetch`, and `console`

```javascript
// Server function "validateAuth"
const [apiKey] = args;
const users = db.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
return users.length > 0 ? { valid: true, user: users[0] } : { valid: false };
```

### Secrets Management

Encrypted storage for API keys and tokens:

- AES-256-GCM encryption with unique IVs per secret
- Admin-only access, values never logged or exposed
- AI can create secret placeholders, user sets values in admin UI

### Database Tools

- **SQL Editor** - Execute raw SQL queries with Monaco editor and query history
- **Schema Viewer** - Browse database structure with expandable table/column tree
- **Execution Logs** - Monitor function invocations with status, duration, timestamps

### Server Context Integration

The AI can now understand and work with your site's backend features! When you select a site:

- **Site Selector** dropdown in workspace header to choose site context
- **`/.server/` hidden folder** with transient files containing server context
- AI receives edge functions, database schema, server functions, and secret names

#### The `/.server/` Folder

A hidden folder appears in the file explorer (right-click → "Show Hidden Files"):

- `db/schema.sql` - Database schema (read-only, use sqlite3 for DDL)
- `edge-functions/*.json` - Edge functions (editable)
- `server-functions/*.json` - Server functions (editable)
- `secrets/*.json` - Secret placeholders (editable - AI creates, user sets values)

### AI Read-Write Access to Backend Features

The AI can create, modify, and delete backend features:

#### SQL Queries with `sqlite3`

```
sqlite3 "SELECT * FROM products"
sqlite3 -json "SELECT * FROM users WHERE active = 1"
sqlite3 "CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)"
```

System tables are protected from modification.

#### Creating Functions

Ask the AI to create endpoints or helpers:

```
Create an edge function called "list-products" that returns all products
```

Functions are stored as JSON files:

```json
{
  "name": "list-products",
  "method": "GET",
  "enabled": true,
  "timeoutMs": 5000,
  "code": "Response.json(db.query('SELECT * FROM products'));"
}
```

### Edge Function Routing for Published Sites

Published sites can call edge functions using simple paths like `/submit-contact` instead of the full API URL.

A lightweight interceptor script (~1.5KB) is injected into published HTML that:
- Intercepts `fetch()` and `XMLHttpRequest` calls
- Detects paths without file extensions (e.g., `/submit-contact`, not `/styles.css`)
- Routes them to `/api/sites/{siteId}/functions/{path}`
- Handles form submissions automatically

```javascript
// Your frontend code - simple and clean!
const response = await fetch('/submit-contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'John', email: 'john@example.com' })
});
```

Forms work automatically too:
```html
<form action="/submit-contact" method="POST">
  <input name="email" type="email" required>
  <button type="submit">Subscribe</button>
</form>
```

Custom events for response handling:
```javascript
document.addEventListener('edge-function-response', (e) => {
  console.log('Result:', e.detail.result);
});

document.addEventListener('edge-function-error', (e) => {
  console.error('Error:', e.detail.error);
});
```

### Preview Edge Function Support

The live preview now supports edge function routing when a site is selected. Test your edge functions directly in the preview without publishing first.

**[Backend Features Guide →](?doc=backend-features)** | **[Server Mode Guide →](?doc=server-mode)**

---

## v1.18.0

### SQLite Migration - Simpler Server Mode

Server Mode now uses SQLite instead of PostgreSQL. This means:

- **Zero database setup** - No need to install or configure PostgreSQL
- **Just run it** - `npm install && npm start` is all you need
- **Portable** - All data stored in local files, easy to backup and move

### Per-Site Databases

Each published site now has its own SQLite database containing its files, settings, and analytics. This keeps sites isolated from each other.

**Storage structure:**
- `data/osws.sqlite` - Your projects, templates, and skills
- `sites/{siteId}/site.sqlite` - Each site's files and analytics

### Breaking Change

PostgreSQL is no longer supported. If you have an existing Server Mode deployment with PostgreSQL, you'll need to migrate your data manually.

**[Server Mode Guide →](?doc=server-mode)**

---

## v1.17.0

### Reasoning Token Support

See what the AI is thinking! Models with reasoning capabilities now display their thought process in a collapsible "reasoning" block in the chat panel.

- **Anthropic extended thinking** - Claude models with thinking enabled
- **DeepSeek reasoning models** - DeepSeek v3.2 and other reasoning-capable models
- **Gemini thinking models** - Gemini Pro 3 with thinking enabled

### Reasoning Toggle

Enable or disable reasoning on a per-model basis directly from the model selector. The toggle appears for models that support it.

### Malformed Tool Call Detection

The AI now auto-detects when a model accidentally writes tool syntax as text instead of properly invoking functions, and automatically prompts it to retry correctly.

### UI Improvements

- Renamed "Thinking..." indicator to "Waiting for response..." for clarity
- Fixed indicator sometimes persisting after the response completed

---

## v1.16.0

### Server Mode

Self-host OSW Studio for a complete web publishing platform. Server Mode adds:

- **Admin authentication** - Password-protected admin area
- **Project sync** - Push projects to the server, pull them back to any browser
- **Static site publishing** - Publish projects directly at `/sites/{siteId}/` with clean URLs
- **Site settings** - Configure scripts, analytics, SEO meta tags, and compliance (cookie consent, GDPR)
- **Built-in analytics** - Privacy-focused tracking, or integrate Google Analytics, Plausible, and more
- **Auto-generated files** - Sitemap.xml and robots.txt created on publish

Server Mode is optional and requires setup. It's still being actively developed - expect improvements to authentication, publishing, and site management in future releases.

**[Server Mode Guide →](?doc=server-mode)**

### In-App Documentation

Browse all documentation without leaving OSW Studio. Access guides from the sidebar under Docs.

### Gemini Thinking Model Support

Full compatibility with Gemini thinking models via OpenRouter.

### Skills System Enhancements

- Split `osw-workflow` into focused skills: `osw-planning` (multi-page sites) and `osw-one-shot` (landing pages)
- Skills now appear in the project structure shown to AI

### Debug Panel Terminal

The Debug panel now includes a terminal for testing VFS shell commands directly.

---

## v1.15.0

- **Skills System** - Create, import, and export AI skills with markdown-based editor
- **Built-in skills** - OSW Workflow, Handlebars Advanced, Accessibility (WCAG 2.1 AA)
- **Skills tab** - New tab alongside Projects and Templates

---

## v1.14.0

- **Event-driven chat** - Real-time event streaming with improved UI responsiveness
- **Debug panel** - Real-time event monitoring with filtering and auto-scroll
- **Handlebars subdirectories** - Organize templates in `/templates/components/`, `/templates/partials/`, etc.

---

## v1.13.0

- **Templates system** - Create, export, and import reusable project templates
- **Template browser** - Grid/list views, search, and sorting
- **Project screenshots** - Automatic preview captures

---

## v1.12.0

- Rebranded from DeepStudio to OSW Studio
- Dual mode system: Chat mode (read-only) and Code mode (full editing)
- Consolidated IndexedDB architecture

---

## v1.0.0

- 10 AI providers (OpenRouter, OpenAI, Codex, Anthropic, Google, Groq, HuggingFace, Ollama, LM Studio, SambaNova)
- Virtual file system with project management
- Live preview with real-time updates
- Multi-tab Monaco editor
- Export to ZIP for deployment

---

**Ready to go?** Head back to **[Projects](?nav=projects)** or **[browse all docs](?doc=overview)**.
