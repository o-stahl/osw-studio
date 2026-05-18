<div align="center">
  <img src="public/osw-studio-logo.svg" alt="OSW Studio Logo" width="128" height="128" />

# Open Source Web Studio

### Build websites through natural language conversations with agentic AI

[![GitHub Stars](https://img.shields.io/github/stars/o-stahl/osw-studio?style=social)](https://github.com/o-stahl/osw-studio/stargazers)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Live Demo](https://img.shields.io/badge/Demo-Try%20Now-success)](https://huggingface.co/spaces/otst/osw-studio)
[![Version](https://img.shields.io/badge/Version-1.67.0-blue)](https://github.com/o-stahl/osw-studio/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/o-stahl/osw-studio/pulls)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mAJ8Ss4u)

[Try it Now](https://huggingface.co/spaces/otst/osw-studio) · [Documentation](docs/README.md) · [Discord](https://discord.gg/mAJ8Ss4u) · [GitHub](https://github.com/o-stahl/osw-studio)

---

<img src="public/osws-demo.gif" alt="OSW Studio Demo" width="800" />

</div>

## Overview

**OSW Studio** is an AI-powered development platform where you build and maintain websites and web apps through natural language conversations.

Static sites have always been fast, cheap to host, and secure. The tradeoff was that maintaining them required technical skill. OSW Studio removes that tradeoff - describe what you want, and AI handles the implementation.

**For developers:** Skip the boilerplate. Rapid prototyping, full code access when you need it, and an AI that understands your project's context.

**For everyone else:** Finally maintain the site that was built for you. Add blog posts, update business hours, swap team photos - without filing a support ticket or hiring an agency.

**What you get:**
- **Multiple runtimes** - Static (HTML/CSS/JS), Handlebars (templated websites), React, Preact, Svelte, Vue, Python, Lua
- **Sandboxed agent** - AI operates in a virtual file system with automatic checkpoints - explore freely, rollback anytime
- **Dual AI modes** - Chat (exploration, planning) + Code (full implementation)
- **Multi-provider AI** - OpenRouter (200+ models), OpenAI, Anthropic, Google Gemini, Groq, HuggingFace, MiniMax, Zhipu AI, SambaNova, Ollama, LM Studio, llama.cpp, mesh-llm
- **Full IDE** - Monaco editor, live preview, file explorer, multi-tab support
- **Templates & Skills** - Reusable project templates (with bundled backend infrastructure) and AI workflow guides
- **Export anywhere** - Download as ZIP, deploy to Vercel/Netlify/GitHub Pages
- **Optional Server Mode** - Self-host a multi-user platform with workspaces, publishing, SEO, analytics, and admin dashboard

**Perfect for:** Business websites, landing pages, portfolios, documentation sites, blogs, React apps, interactive tools

**Two modes:** Browser Mode (build and export as ZIP) or [Server Mode](#server-mode-optional) (self-hosted platform with workspaces, databases, APIs, and publishing)

## 🚀 Quick Start

Get started in **3 steps**:

```bash
# 1. Clone and install
git clone https://github.com/o-stahl/osw-studio.git
cd osw-studio
npm install

# 2. Start development server
npm run dev
```

**3. Open browser and start building:**

1. ✅ Get an API key from [OpenRouter](https://openrouter.ai), [OpenAI](https://platform.openai.com), or run [Ollama](https://ollama.ai) locally
2. ✅ Open http://localhost:3000
3. ✅ Click settings → Select provider → Enter API key
4. ✅ Create project → Describe your website
5. ✅ Export as ZIP → Deploy anywhere

**Try the hosted version:** [Live Demo](https://huggingface.co/spaces/otst/osw-studio) (no installation required)

## Key Features

### Development Environment
- **Monaco Editor** - Full-featured code editor with syntax highlighting, IntelliSense
- **Live Preview** - Hot reload, instant updates as AI builds
- **File Explorer** - Tree view with right-click context menus
- **Multi-tab Support** - Work on multiple files simultaneously
- **Handlebars Templates** - Build reusable components with partials

### AI Capabilities
- **Dual Modes**:
  - 💬 **Chat Mode** - Exploration, planning, Q&A
  - 🔧 **Code Mode** - Full implementation with file operations
- **13 LLM Providers** - OpenRouter, OpenAI, Anthropic Claude, Google Gemini, Groq, HuggingFace, MiniMax, Zhipu AI, SambaNova, Ollama, LM Studio, llama.cpp, mesh-llm
- **200+ Models** - From tiny 4B tool models to SOTA frontier models
- **Smart Agent** - Uses shell commands for all file operations, with explicit build verification and status evaluation
- **Skills System** - Teach AI your workflow preferences with Anthropic-style skills

### Project Management
- **Templates** - Export/import reusable project templates (.oswt files)
- **Checkpoints** - Rollback to any point in conversation with per-message restore
- **Export Options** - ZIP deployment packages or .osws backups (full history)
- **Project Gallery** - Grid/list views with screenshots, search, sorting

## What Can You Build?

| ✅ Browser Mode | Details |
|----------------|---------|
| **Landing Pages** | Marketing sites, product pages, SaaS homepages |
| **Portfolios** | Personal websites, photography, design portfolios |
| **Documentation** | Project docs, help centers, knowledge bases |
| **Blogs** | Static blogs with templates and navigation |
| **Framework Apps** | React, Preact, Svelte, Vue with in-browser bundling via esbuild |
| **Scripts** | Python (Pyodide) and Lua (wasmoon) with interactive Console |
| **Client-side Apps** | Calculators, tools, games, interactive demos |

| ✅ Server Mode | Details |
|----------------|---------|
| **Dynamic Websites** | Contact forms, comment systems, user submissions via Edge Functions |
| **Database-backed Apps** | CRUD apps, dashboards, admin panels with per-deployment SQLite |
| **Blogs & CMS** | Static posts with Handlebars partials, comments via Edge Functions |
| **API Backends** | REST APIs with database access, secrets management, auth flows |
| **Multi-user Platform** | Workspaces with shared access, quotas, and per-workspace isolation |

See [Server Mode](#server-mode-optional) for full details.

## How It Works

OSW Studio uses an agentic AI system with a single tool:

1. **Shell Tool** - File system operations and editing (`ls`, `cat`, `grep`, `find`, `mkdir`, `rm`, `mv`, `cp`, `sed -i`, `cat >`, `echo >`, `tree`, `head`, `tail`, `build`, `status`)

The `status` command signals task completion — the AI must articulate what it did and what remains before finishing.

**Command validation** → **Execution** → **Checkpoint** → **Continue**

The agent runs entirely in your browser, operating on a virtual file system (IndexedDB). You describe what you want, AI handles the implementation.

## Model Recommendations

### ✅ Recommended Models (Tool Calling)
- **Gemini 3** - Good pricing, speed and quality, best value currently
- **Haiku 4.5** - Reasonable pricing, speed and quality
- **GLM4.7, GLM4.6, GLM4.5 & air** - Fast, reliable and cheap, among SOTA for webdev
- **Grok Code Fast 1** - Good balance of speed, quality and price
- **Kimi K2** - Good balance of speed, quality and price
- **gpt-oss-120b & 20b** - Strong agentic capabilities
- **Qwen3 series** - Some models perform better than others, but functional across the board
- **DeepSeek v3.2, v3.1 and R1** - Can handle most tasks, but not optimized for this use case
- **Claude Sonnet 4.5 & Opus 4.5** - Good, but can rack up a large bill quickly (Gemini 3 is much better value)
- **SOTA models** - Generally SOTA models will perform, but come with a higher pricing

### ⚠️ Models Without Tool Calling (JSON Parsing Fallback)
- DeepSeek V3, Qwen2.5, Gemma3, Mistral-small, Granite 3.x, Llama4 Maverick/Scout

**Rule of thumb:** A 4B tool-calling model typically outperforms a 70B non-tool model for this use case. Models released after summer 2025 should work well.

## Supported Providers

**Local (Free, Private):**
- [Ollama](https://ollama.ai) - Run models locally (no API key)
- [LM Studio](https://lmstudio.ai) - Local model hosting
- [llama.cpp](https://github.com/ggerganov/llama.cpp) - Lightweight C++ inference server
- [mesh-llm](https://github.com/michaelneale/mesh-llm) - Peer-to-peer network for free open-model inference

**Cloud:**
- [OpenRouter](https://openrouter.ai) - 200+ models, pay-per-use
- [OpenAI](https://platform.openai.com) - GPT-4, GPT-5 series (+ ChatGPT subscription)
- [Anthropic](https://console.anthropic.com) - Claude 3/4 series
- [Google](https://aistudio.google.com) - Gemini models
- [Groq](https://console.groq.com) - Fast inference
- [HuggingFace](https://huggingface.co) - Free tier ($0.10/month), 120+ models
- [MiniMax](https://platform.minimaxi.com) - MiniMax models
- [Zhipu AI](https://open.bigmodel.cn) - GLM series
- [SambaNova](https://sambanova.ai) - High-performance models

## File Support

| Type | Formats | Limits |
|------|---------|--------|
| **Code** | HTML, CSS, JS/JSX, TS/TSX, JSON, HBS, Svelte, Vue, Python, Lua | 5MB per file |
| **Docs** | TXT, MD, XML, SVG | 5MB per file |
| **Media** | PNG, JPG, GIF, WebP, MP4, WebM | 10MB images, 50MB video |

## Server Mode (Optional)

OSW Studio runs client-side by default (Browser Mode). For advanced use cases, enable **Server Mode**:

### Browser Mode (Default)
- ✅ Client-side only, no backend required
- ✅ IndexedDB storage (stays in browser)
- ✅ Deploy to Vercel, Netlify, HuggingFace
- ✅ Complete privacy
- ✅ Zero configuration

### Server Mode (Optional)
- ✅ **Workspaces** - Isolated environments with own projects, deployments, and quotas
- ✅ **Multi-user** - User accounts with shared workspace access and admin management
- ✅ SQLite persistence (no external database setup)
- ✅ Static site publishing to `/deployments/{deploymentId}/`
- ✅ Edge Functions - JavaScript API endpoints with database access
- ✅ Scheduled Functions - Run edge functions on cron schedules
- ✅ Per-deployment SQLite databases (WAL mode) with SQL editor
- ✅ Secrets management (AES-256-GCM encrypted)
- ✅ SEO controls - Meta tags, Open Graph, Twitter Cards, auto-sitemap
- ✅ Built-in analytics (privacy-focused) or external (GA4, Plausible)
- ✅ Compliance - Cookie consent banners with GDPR/CCPA support
- ✅ Custom scripts - Inject head/body scripts, CDN resources
- ✅ Project sync (IndexedDB ↔ SQLite)
- ✅ Custom domains via reverse proxy
- ✅ **Server-Side Generation** - AI tasks continue on server if browser disconnects, with automatic reattach on reconnect
- ✅ Site Templates - Create from templates with automatic backend provisioning

**Quick Start (Server Mode):**

```bash
# 1. Configure .env
NEXT_PUBLIC_SERVER_MODE=true
SESSION_SECRET=$(openssl rand -base64 32)
ANALYTICS_SECRET=$(openssl rand -base64 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)

# 2. Start server (SQLite databases created automatically)
npm install && npm run dev

# 3. Visit http://localhost:3000/admin — create admin account on first visit
```

**Documentation:**
- [Server Mode Guide](docs/SERVER_MODE.md) - Full setup and features
- [Multitenancy Guide](docs/MULTITENANCY.md) - Workspaces, users, quotas
- [Backend Features](docs/BACKEND_FEATURES.md) - Edge Functions, Secrets, Database

## Tech Stack

- **Framework**: Next.js 15.5, React 19, TypeScript
- **UI**: TailwindCSS v4, Radix UI primitives
- **Editor**: Monaco Editor (VS Code engine)
- **Storage**: IndexedDB (browser), SQLite (server mode)
- **AI**: 13 LLM provider integrations
- **Templating**: Handlebars.js for components
- **Export**: JSZip for deployment packages

## Architecture

```
/components/       # React UI components (workspace, editor, preview)
/lib/vfs/          # Virtual file system with checkpoints
/lib/llm/          # AI orchestration, tool execution, providers
/app/api/          # API routes (generation, models, validation)
/docs/             # Comprehensive documentation
```

## Debugging

### Environment Variables

Create `.env`:

```bash
# Log level: error, warn, info, debug (default: warn)
NEXT_PUBLIC_LOG_LEVEL=warn

# Tool streaming debug (default: 0)
NEXT_PUBLIC_DEBUG_TOOL_STREAM=0
```

### Troubleshooting

- **Generation fails** → Check DevTools console (F12)
- **Model compatibility** → Test at `/test-generation`
- **Tool issues** → Enable `DEBUG_TOOL_STREAM=1`
- **Rate limits** → Watch for toast notifications
- **Local providers** → Ensure Ollama/LM Studio running

## Privacy

- **API keys** - Stored in browser `localStorage` (never sent to OSW Studio servers)
- **Network calls** - Direct to AI providers or via optional proxy endpoints
- **Data storage** - Projects stay in IndexedDB (browser mode) or SQLite (server mode)
- **Complete privacy** - Use Ollama/LM Studio for 100% local operation
- **Anonymous telemetry** - Lightweight usage analytics (page views, provider/model selection, task success rates) help improve OSW Studio. No prompts, code, file names, or API keys are ever collected. A random anonymous ID in localStorage counts unique visitors — no cookies, no fingerprinting. Opt out anytime in Settings, or disable entirely with `NEXT_PUBLIC_TELEMETRY_ENABLED=false`

**Note:** Remote LLM providers (OpenAI, Anthropic, etc.) will receive your code during generation. For complete privacy, use local models.

## Limitations

- **No package managers** - Static projects use CDN links for libraries; framework projects (React, Preact, Svelte, Vue) auto-resolve npm imports via esm.sh
- **Browser Mode** - Client-side projects only, no backend (use Server Mode for APIs/databases)

## Contributing

OSW Studio is a **solo-maintained, community-driven** project. Contributions welcome!

**Ways to help:**
- 🐛 [Report bugs](https://github.com/o-stahl/osw-studio/issues)
- 💡 [Request features](https://github.com/o-stahl/osw-studio/issues)
- 🔀 [Submit pull requests](https://github.com/o-stahl/osw-studio/pulls)
- 📣 Share what you've built (open an issue or discussion!)

**Built something cool?** I'd love to see it! Share your creations in GitHub Discussions or open an issue with screenshots.

## License

MIT License - See [LICENSE](LICENSE) file for details

## 🙏 Credits

**Original Inspiration:**
- [@enzostvs](https://github.com/enzostvs) & [@victor](https://github.com/victor) - DeepSite v2 (original fork source)
- [Hugging Face](https://huggingface.co) - Hosting platform

**Technical Inspiration:**
- [Google AI Studio](https://aistudio.google.com) - App Builder workflow
- [OpenAI Codex CLI](https://github.com/openai/codex-cli) - Agentic patterns
- [Anthropic Claude](https://www.anthropic.com) - Agentic patterns

**Special Thanks:**
- All open source contributors making projects like this possible
- The AI community for pushing boundaries

---

**Note:** OSW Studio is not affiliated with Anthropic, OpenAI, Google, Hugging Face, or other mentioned organizations. All trademarks belong to their respective owners.
