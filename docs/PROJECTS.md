# Managing Projects

**Everything you need to know about creating, organizing, and exporting projects.**

---

## Creating Projects

1. Click **Projects** in the sidebar
2. Click **+ New Project**
3. Enter a project name
4. Choose a template:
   The list is grouped by what you're setting out to make. A few of the twenty:
   - **Handlebars Starter** - an empty website with partials and a data file (the default)
   - **Static Starter** - an empty website in plain HTML, CSS and JavaScript
   - **Business Website** - one page for a local business: services, prices, hours, location
   - **Portfolio & CV** - one page about one person: selected work, bio, work history
   - **LLM Wiki** - a knowledge base the assistant writes and keeps current as you add sources
   - **Projects & Tasks** - a board of what you are working on, kept in order by the assistant
   - **Store Locator** - a searchable map of your locations, ready to embed elsewhere
   - **Guided Chat** - a chat widget with pre-set replies, needing no backend
   - **AI Assistant** - a chat page whose key stays in a server function (Backend)
   - **Landing Page with Contact Form** - contact form with Resend email (Backend)
   - **Blog with Comments** - blog with auth and moderated comments (Backend)
   - **Spring Boot REST API** - a Java service you edit here and build elsewhere
   - **Runtime starters** - a closed section holding the eight minimal setups, one per runtime
   - Or select any custom template you've created

   See [Templates](TEMPLATES.md) for the full list.
5. Optionally add a description
6. Click **Create Project**

All projects start from a template. The built-in templates provide a foundation to build upon.

**[Learn more about templates →](?doc=templates)**

---

## Opening Projects

### From Projects View

1. Click **Projects** in the sidebar
2. Find your project in the grid
3. Click on the project card

### Recent Projects

Your 3 most recent projects appear in the sidebar for quick access.

---

## Project Workspace

The workspace displays up to 3 panels side-by-side. Open, close, and reorder panels from the sidebar or panel headers — drag the grip handle in a panel header to rearrange. Panel widths, order, and visibility persist between sessions.

Available panels: Chat, File Explorer, Code Editor, Preview, Console (Python/Lua), Skills, Checkpoints, Debug, Settings. When you open a 4th panel, the rightmost panel is replaced.

### Workspace Header

The header contains key controls:
- **Project name** - Displayed in the header
- **Mode toggle** - Switch between Chat (read-only) and Code (full access) modes
- **Deployment selector** (Server Mode only) - Choose which published deployment's backend context to load

#### Deployment Selector (Server Mode)

In Server Mode, a dropdown appears in the workspace header that lets you select a deployment. When selected:
- The AI gains awareness of that deployment's backend features
- A `/.server/` hidden folder appears with server context files
- You can ask the AI about edge functions, database schema, etc.

See **[Server Mode → Server Context Integration](?doc=server-mode#server-context-integration)** for details.

### Chat

Talk to AI to build and modify your project. The chat panel has two modes:

**Chat Mode** (read-only):
- AI uses read-only bash commands
- Explore and discuss without making changes
- See how the AI understands your project
- Perfect for planning before building

**Code Mode** (full access):
- AI can create, edit, and delete files
- Make actual changes to your project
- Build features and fix bugs

**Pro tip**: If unsure, start with Chat mode to see how the AI views your project. You can also one-shot prompt full multi-page websites, though smaller, focused tasks are generally more consistent.

### File Explorer

Browse your project structure:
- Click folders to expand/collapse
- Click files to open in editor
- Right-click for options (rename, delete, etc.)
- Right-click and select **Show Hidden Files** to view hidden folders

#### Hidden Folders

OSW Studio uses hidden folders (starting with `.`) to provide AI context:

| Folder | Icon | Purpose |
|--------|------|---------|
| `/.skills/` | Purple book | Skill documents that teach the AI your preferences |
| `/.server/` | Orange server | Server context (Server Mode only) - database schema, edge functions, etc. |

These folders are **read-only** and **transient** - their contents are generated dynamically to provide context to the AI and are not saved with your project

### Code Editor

View and edit code:
- Multiple tabs for different files
- Syntax highlighting
- Save with `Cmd/Ctrl+S`
- Supports HTML, CSS, JavaScript, TypeScript, TSX, JSON, Markdown, XML, SVG, Python, Lua, Svelte, Vue SFCs

### Live Preview

See your website in real-time:
- Updates automatically when files change
- Click links to navigate
- Test responsive design with mobile/tablet/desktop size presets
- Click **Maximize** to fill the whole screen with the preview (hides all other panels)
- Use the **focus tool** to select specific elements and add them to message context for targeted AI edits
- Drag **semantic blocks** from the Blocks palette onto the preview — the AI writes code that fits your project

The preview runs isolated from the studio: a project's `localStorage`, `sessionStorage` and cookies are kept in memory per project until you reload or close the studio, and IndexedDB is not available. Test IndexedDB on a published or exported copy.

### Console (Python/Lua)

For terminal runtimes (Python, Lua), the Console panel shows script output and lets you see errors from script execution. Opens automatically for terminal runtimes.

---

## Saving Your Work

### Manual Save

Press `Ctrl+S` (Windows/Linux) or `Cmd+S` (Mac) to save your project.

**Important**: Projects require manual save to persist. While checkpoints are created automatically during AI operations, you must manually save to create a permanent restore point.

### Checkpoints

OSW Studio creates checkpoints automatically after AI makes changes:

- **Auto-checkpoints** are created during AI operations (last 5 kept per project)
- **Manual saves** (Cmd/Ctrl+S) persist across refreshes and are never evicted
- **Pinned checkpoints** — pin any checkpoint to prevent it from being pruned. Great for bookmarking a known-good state before experimenting

**How to restore:**
1. Open the **Checkpoints Panel** in the workspace
2. Browse auto-checkpoints, manual saves, and pinned checkpoints
3. Click any checkpoint to restore your project to that state

---

## Exporting Projects

### Export as ZIP

Download your complete website ready to deploy:

1. Click the **Menu** icon (⋮) in the top right
2. Select **Export**
3. Choose **ZIP** (suitable for hosting)
4. Save the ZIP file

The ZIP contains:
- All HTML, CSS, JavaScript files
- Images and assets
- Clean structure ready for hosting

**Deploy it to:**
- Vercel, Netlify, GitHub Pages
- Any static file host
- Your own server

**[Deployment guide →](?doc=deploying-sites)**

### Download the Project

Export as ZIP gives you the compiled site, the pages a web host serves. Downloading gives you the project itself, so you can work on it in another editor and bring it back.

1. Open the **File Explorer** panel
2. Click the **Download** icon in the panel header
3. Save the `.zip`

Inside you get:
- Every file at its real path, including `.PROMPT.md` and other dot-files
- `project.json`, holding the runtime, entry point and other settings
- `.server/`, with each edge and server function as an editable `.js` file next to a small `.json` holding its settings — its description and whether it's enabled, plus the method and timeout for an edge function — and a `README.md` explaining the layout

Secret **values** are never included. Their names and descriptions are, so you can see what the project expects.

**Which one do I want?**

| | Use |
|---|---|
| **Export as ZIP** | Publishing to a web host |
| **Download** | Editing elsewhere, or keeping a copy of the project |
| **Export as JSON** | A backup with chat history and checkpoints |

### Export as JSON (Backup)

Save your entire project including chat history and checkpoints:

1. Click the **Menu** icon (⋮)
2. Select **Export**
3. Choose **JSON** (backup format)
4. Save the file

Use this to:
- Back up your work
- Transfer projects between computers
- Share projects with others
- Keep complete history

### Importing

You can bring in a downloaded `.zip`, a folder of files, or a `.json` backup.

**As a new project:**

1. Click **Projects** in the sidebar
2. Click **Import** and choose **From a file** or **From a folder**
3. Review what will be created, then confirm

**Into the project you have open:**

1. Open the **File Explorer** panel
2. Click the **Import** icon in the panel header
3. Review what will change, then confirm

Nothing is written until you confirm. Before that you see what will be added, what already exists, what is identical, and anything that can't be imported along with the reason.

**When a file already exists**, choose per file, or set one choice for all of them:

- **Keep mine** - leave the project's copy alone
- **Replace** - take the version from the archive
- **Keep both** - bring the new one in under a different name, like `logo (2).svg`

Importing into an existing project takes a checkpoint first, so the file changes can be undone in one step from **Checkpoints**. A replaced server function or a changed runtime is not recoverable, so those are called out separately while you're deciding.

A `.json` backup imports the old way, without a preview.

**Note:** an archive may carry server functions, secrets and schedules. They come across and stay with the project, but they only run in Server Mode.

---

## Organizing Projects

### Naming

Give projects clear names:
- ✅ "Portfolio Website"
- ✅ "Client Landing Page - Acme Corp"
- ✅ "Blog v2"
- ❌ "Untitled 1"
- ❌ "New Project"

### Deleting Projects

1. Go to **Projects** view
2. Find the project
3. Click the **Delete** button (trash icon)
4. Confirm deletion

**⚠️ Warning**: Deletion is permanent. Export a backup first if you might need it later.

---

## Tips for Project Management

**💡 Name Projects Clearly**
You'll thank yourself later when you have many projects

**💡 Export Backups Regularly**
Especially before major changes or experiments

**💡 Use Templates**
Don't rebuild the same structure every time

**💡 One Feature at a Time**
Make changes incrementally and test as you go

**💡 Test in Preview**
Always check the live preview before exporting

**💡 Keep Chat History Clean**
Start new conversations when switching to different features

---

## Common Tasks

### Duplicate a Project

1. Export project as JSON
2. Import it back with a new name
3. Continue working on the copy

### Start Over

1. Delete old project
2. Create new project with same name
3. Or keep old as reference and create new

### Share a Project

1. Export as JSON
2. Share file with others
3. They import it in their OSW Studio

---

**Next Steps:**

- **[Working with AI](?doc=working-with-ai)** - Get better results from AI
- **[Templates](?doc=templates)** - Start projects faster
- **[Deploying Sites](?doc=deploying-sites)** - Put your site online
