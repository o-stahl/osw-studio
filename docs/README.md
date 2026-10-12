# OSW Studio Documentation

**Your guide to building websites with AI.**

Welcome to OSW Studio - a browser-based development environment where you chat with AI to build websites and web apps.

---

## Quick Links

**New to OSW Studio?**
- 👉 **[Overview](?doc=overview)** - What is OSW Studio? (1 min read)
- 🚀 **[Getting Started](?doc=getting-started)** - Build your first site (5 min)

**Common Tasks:**
- 💾 [Manage Projects](?doc=projects)
- 🤖 [Work with AI](?doc=working-with-ai)
- 🌐 [Deploy Your Site](?doc=deploying-sites)

**Features:**
- 📦 [Templates](?doc=templates) - Start faster
- ⚡ [Skills](?doc=skills) - Teach AI your preferences

**Need Help?**
- ❓ [FAQ](?doc=faq)
- 🔧 [Troubleshooting](?doc=troubleshooting)

---

## Documentation Structure

### Getting Started

Perfect for newcomers and casual users:

- **[Overview](?doc=overview)** - What is OSW Studio and who is it for?
- **[Getting Started](?doc=getting-started)** - Set up and create your first project
- **[Projects](?doc=projects)** - Create, manage, and export projects

### Using OSW Studio

Guides for regular users:

- **[Working with AI](?doc=working-with-ai)** - Chat vs Code modes, prompting tips
- **[Templates](?doc=templates)** - Use and create project templates
- **[Skills](?doc=skills)** - Teach AI your workflow preferences
- **[Deploying Your Sites](?doc=deploying-sites)** - Deploy to Vercel, Netlify, etc.

### Help & Advanced

For support and self-hosters:

- **[FAQ](?doc=faq)** - Common questions answered
- **[Troubleshooting](?doc=troubleshooting)** - Fix common issues
- **[Server Mode](?doc=server-mode)** - Self-hosting and deployment
- **[Multitenancy](?doc=multitenancy)** - Workspaces, users, roles, quotas (Server Mode)
- **[Deployment Publishing](?doc=site-publishing)** - Analytics, SEO, compliance (Server Mode)
- **[Custom Domains](?doc=custom-domains)** - Use your own domain for published sites (Server Mode)
- **[Backend](?doc=backend-features)** - Database, API endpoints, secrets (Server Mode)

---

## What Can I Build?

OSW Studio supports multiple project runtimes — pick the one that fits your needs:

**Static (HTML/CSS/JS):**
✅ **Personal websites** - Portfolios, blogs, resumes
✅ **Landing pages** - Marketing sites, product pages
✅ **Documentation sites** - Project docs, help centers
✅ **Interactive apps** - Calculators, tools, games (client-side)

**React, Preact, Svelte, Vue:**
✅ **Component-based apps** - Dashboards, admin panels, SPAs
✅ **Interactive UIs** - Forms, data visualization, real-time interfaces
✅ **npm ecosystem** - Import packages by name, fetched from CDN at runtime
✅ **Single-file components** - Svelte `.svelte` and Vue `.vue` files compiled in-browser

**Python & Lua:**
✅ **Scripts and algorithms** - Run Python (via Pyodide) and Lua (via wasmoon) in an interactive Console
✅ **Data processing** - Experiment with code without leaving the browser
✅ **Learning environment** - Try language features with instant feedback

**Server Mode adds:**
✅ **Workspaces** - Isolated environments for teams, clients, or projects
✅ **Multi-user** - User accounts with shared workspace access
✅ **API endpoints** - REST APIs with database access via edge functions
✅ **Dynamic sites** - Store and retrieve data with SQLite databases

---

## Key Concepts

### Chat with AI to Build

Describe what you want in plain English. AI writes the code, creates files, and explains what it's doing.

```
Create a portfolio website with a hero section,
about section, and project gallery
```

### Two Modes

**💬 Chat Mode** - Ask questions, plan, explore (read-only)
**🔧 Code Mode** - AI builds and modifies your project

### Live Preview

See your website update in real-time as AI builds it.

### Export & Deploy

Download your complete site and deploy to Vercel, Netlify, or any static host in minutes.

---

## Resources

### External Links

- **[Live Demo](https://huggingface.co/spaces/otst/osw-studio)** - Try OSW Studio now
- **[GitHub Repository](https://github.com/o-stahl/osw-studio)** - Source code
- **[Report Issues](https://github.com/o-stahl/osw-studio/issues)** - Bug reports & feature requests

### Features

**Major Features:**
- Multiple project runtimes (Static, Handlebars, React, Preact, Svelte, Vue, Python, Lua)
- Multi-provider AI support (18 providers, including a ChatGPT subscription and OpenRouter's free models)
- Dual modes (Chat/Code)
- Semantic blocks — drag pre-defined layouts onto the preview
- Templates & Skills systems
- Browser mode (IndexedDB) and Desktop app (macOS/Windows/Linux)
- Optional Server mode with workspaces and multi-user support
- Site publishing with SEO & analytics
- Edge functions & database management
- Cost tracking

---

## Getting Help

**Before asking for help:**

1. Check the [FAQ](?doc=faq)
2. Search [GitHub Issues](https://github.com/o-stahl/osw-studio/issues)
3. Review [Troubleshooting](?doc=troubleshooting)

**Still stuck?**

Create an issue on GitHub with:
- What you're trying to do
- What's happening instead
- Steps to reproduce
- Browser and OS version
- Screenshots if relevant

---

**Ready to start?** → **[Get Started](?doc=getting-started)**
