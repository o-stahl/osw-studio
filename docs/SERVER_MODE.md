# Server Mode - Self-Hosting Guide

Self-host OSW Studio with persistence, authentication, and static site publishing.

---

## Overview

OSW Studio supports two deployment modes:

- **Browser Mode** (default): Pure client-side application using IndexedDB
- **Server Mode**: Full-stack deployment with publishing

Server Mode adds:
- Local database for persistent storage (no external database needed)
- Admin authentication with JWT sessions
- Deployment publishing system with static site serving
- Project sync between browser and server
- Server-side generation (AI tasks continue if browser disconnects, reattach on reconnect)
- Built-in analytics and compliance features
- An optional MCP connector so an outside agent can work on a workspace (see [MCP Server](?doc=mcp-server))

---

## Browser Mode vs Server Mode

### Browser Mode (Default)

**Characteristics:**
- No backend required
- Deploy to any static host (Vercel, Netlify, GitHub Pages, HuggingFace)
- Zero configuration
- Complete privacy (data never leaves browser)
- No multi-user support
- No server-side persistence
- No static site publishing

**Use Cases:**
- Personal development environment
- Quick prototyping
- Privacy-focused workflows
- Static deployment (HuggingFace Spaces)

### Server Mode

**Characteristics:**
- Local persistence (no external database)
- Admin authentication
- Multiple deployments per project
- Static site publishing at `/deployments/{id}/`, or on its own address (see [Where Published Sites Are Served](?doc=server-mode#where-published-sites-are-served))
- Built-in analytics
- Project sync (browser <-> server)
- Server-side generation (close browser, AI keeps working)
- Optional MCP connector for outside agents
- Requires persistent file system
- Requires server hosting

**Use Cases:**
- Production deployments
- Multi-user environments (see **[Multitenancy](?doc=multitenancy)**)
- Publishing static sites
- Persistent project storage

---

## Quick Start

### 1. Configure Environment

Create `.env` file in project root:

```bash
# Enable Server Mode
NEXT_PUBLIC_SERVER_MODE=true

# Session security (generate with: openssl rand -base64 32)
SESSION_SECRET=your_random_secret_here

# Admin password (optional — only needed for headless/scripted bootstrap)
# For interactive setup, skip this and create admin via /admin/register on first visit
# ADMIN_PASSWORD=your_secure_password_here

# Optional: Analytics secret
ANALYTICS_SECRET=your_analytics_secret_here

# Optional: Secrets encryption (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
SECRETS_ENCRYPTION_KEY=your_encryption_key_here

# Optional: App URL (the studio's address; used for SEO/sitemaps and origin checks)
NEXT_PUBLIC_APP_URL=https://your-domain.com

# Optional: a separate address for published sites (see "Where Published Sites Are Served")
# SITES_ORIGIN=https://sites.example.com

# Optional: MCP connector for outside agents (Claude Code, Cursor, …)
# MCP_ENABLED=true
```

### 2. Start Server

```bash
npm install
npm run dev
```

SQLite databases are created automatically:
- `data/osws.sqlite` - Core database (projects, deployments, templates, skills)
- `deployments/{id}/runtime.sqlite` - Per-deployment runtime (edge functions, secrets, user tables)
- `deployments/{id}/analytics.sqlite` - Per-deployment analytics (pageviews, sessions)

### 3. Access Application

- **Studio**: http://localhost:3000/
- **Admin panel**: http://localhost:3000/admin/login
- **Published sites**: http://localhost:3000/deployments/{id}/ when no separate address is set. See [Where Published Sites Are Served](#where-published-sites-are-served).

**On first visit**, you'll be prompted to create an admin account. After login, you'll land on the **Dashboard** with server stats and traffic metrics.

---

## Server Context Integration

In Server Mode, the AI gains awareness of your deployment's backend features through a special `/.server/` folder that appears in the file explorer.

### How It Works

When you select a deployment from the **Deployment Selector** dropdown (in the workspace header), OSW Studio:
1. Loads that deployment's backend features (edge functions, database schema, server functions, secrets)
2. Mounts them as transient files in `/.server/`
3. Informs the AI about these capabilities in its system prompt

### The `/.server/` Folder

This hidden folder contains:
- **db/schema.sql** - Database schema (read-only, use `sqlite3` for DDL)
- **edge-functions/*.json** - Edge functions (editable via bash commands)
- **server-functions/*.json** - Server functions (editable via bash commands)
- **secrets/*.json** - Secret placeholders (editable - AI creates, user sets values in admin UI)

These files are:
- **Transient** - They are not saved with the project
- **Auto-updated** - They reflect the current deployment's state
- **Partially editable** - Schema is read-only, but functions and secrets can be modified

### Using Backend Features with AI

Once a deployment is selected, you can ask the AI to:

```
What edge functions are available for this deployment?
```

```
Help me create an edge function that uses the products table
```

```
Show me the database schema
```

The AI will use the `/.server/` files to understand your deployment's capabilities and provide relevant assistance.

### Viewing the `/.server/` Folder

The folder is hidden by default. To view it:
1. Right-click in the File Explorer
2. Select **Show Hidden Files**
3. The `/.server/` folder appears with an orange server icon

---

## Project Sync

Server Mode uses a hybrid storage approach: projects are edited locally in the browser (for speed) and synced to the server (for persistence). This gives you the best of both worlds - fast local editing with server-side backup.

### How Sync Works

**Automatic Push (on save):**
When you save a project in Server Mode, it automatically syncs to the server. You'll see a brief "Project synced" notification.

**Automatic Pull (on load):**
When you open the Project Manager, OSW Studio checks for any updates from the server and pulls them automatically. Projects that exist on the server but not locally are downloaded.

**Manual Sync:**
For bulk operations or troubleshooting, use the Sync button in the sidebar. This opens a dialog where you can:
- **Push to Server** - Upload all local projects to the database
- **Pull from Server** - Download all server projects to your browser

### When to Use Manual Sync

- **Setting up a new browser** - Pull to populate your IndexedDB from the server
- **After server restore** - Pull to get the restored data locally
- **Troubleshooting** - Force push/pull if auto-sync isn't working

---

## Deployment Options

> **Important**: Server Mode requires **persistent file system** storage because published sites are written to `/public/deployments/` and databases are stored locally. Serverless platforms like Vercel, Netlify, and Cloudflare Workers **will not work** for Server Mode.

### Option 1: Desktop App (Easiest)

**Why**: Zero setup — download, install, run. The desktop app bundles the full server with SQLite, so you get publishing and sync without running a server.

**Pricing**: Free

**Steps:**

1. Download the installer for your platform from [GitHub Releases](https://github.com/o-stahl/osw-studio/releases)
2. Install and launch — authentication is bypassed for the single local user
3. Published sites are served on a second local port, e.g. `http://127.0.0.1:30012/deployments/{id}/`, so their scripts do not run on the studio's address

**Best for**: Personal use, local development, and evaluating Server Mode features without provisioning a server.

---

### Option 2: Railway (Recommended for Hosting)

**Why**: Simple setup, persistent storage, usage-based pricing

**Pricing**: $5/month minimum (includes $5 in usage credits). Free trial: 30 days with $5 credits.

**Steps:**

1. **Create Railway Account:**
   - Go to https://railway.app
   - Sign up with GitHub

2. **New Project:**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your OSW Studio fork

3. **Configure Variables:**
   - Go to project variables
   - Add:
     ```
     NEXT_PUBLIC_SERVER_MODE=true
     SESSION_SECRET=<generate>
     NEXT_PUBLIC_APP_URL=https://${{ RAILWAY_PUBLIC_DOMAIN }}
     ```
   - With only the Railway domain, published sites are served from the studio's address. To serve them separately, add a second domain to the service and set `SITES_ORIGIN` to it.

4. **Deploy:**
   - Railway auto-deploys on push
   - Access at: `https://your-project.up.railway.app`

---

### Option 3: VPS (Full Control)

**Why**: Complete control, custom domains, lowest cost at scale

**Requirements:**
- Ubuntu 22.04+ server (Hetzner, DigitalOcean, Linode, etc.)
- SSH access
- Domain (optional, but recommended for SSL)

**Quick Overview:**
1. Create server with SSH key and firewall (ports 22, 80, 443 only)
2. Create non-root user, harden SSH, install fail2ban
3. Install Node.js via nvm, clone repo, configure environment
4. Build app and run with PM2
5. Setup Nginx reverse proxy
6. Add SSL with certbot

**See the full guide:** **[VPS Deployment Guide](?doc=vps-deployment)** — includes security hardening, swap setup, PM2 auto-start, and detailed step-by-step instructions.

---

## Where Published Sites Are Served

A published site runs code you did not write line by line: what the AI wrote, an imported template, a widget a client asked for. If it is served from the same address as the studio, its scripts run with the access of whoever opens it. They can call the studio's API with that person's session and read the API keys the studio keeps in their browser. OSW Studio can serve published sites from a different address than the studio, and does so when the install is set up for it.

| Set-up | Where sites are served | What to configure |
|--------|-----------------------|-------------------|
| Server with neither of the below (the default) | The studio's own address, at `/deployments/{id}/` | Nothing, but the Deployments view shows a warning |
| Server with a sites address (`SITES_ORIGIN`) | `https://sites.example.com/deployments/{id}/` | One DNS record, a certificate and one setting |
| Server with subdomains (`STATIC_PROXY=true` and Caddy) | Each site on its own subdomain or custom domain | Caddy with the generated Caddyfile (see below) |
| Desktop app | A second local port, e.g. `http://127.0.0.1:30012/deployments/{id}/` | Nothing; the port is chosen when the app starts |

When sites have their own address, links to `/deployments/{id}/` and `/review/{id}/` on the studio's address redirect to it, so links shared before keep working. The site's address answers only site paths: its pages, its review copy, its edge functions and the analytics collector. The studio's API is not answered there; its public static files (icons, scripts) are.

### Setting up a sites address

With the Nginx set-up from the [VPS Deployment guide](?doc=vps-deployment):

1. Add a DNS record for the sites address (for example `sites.example.com`) pointing at the same server.
2. Add a certificate for it: `sudo certbot --nginx -d sites.example.com`.
3. Add `SITES_ORIGIN=https://sites.example.com` to `.env`, and set `NEXT_PUBLIC_APP_URL` to the address you open the studio on. Without it the studio's address keeps serving sites. `NEXT_PUBLIC_APP_URL` is read when the app is built, so run `npm run build` before restarting if you set or change it.
4. Republish your sites, so their sitemaps and canonical URLs use the new address.

The guide's Nginx configuration answers any host name and passes the `Host` header through. Any proxy in front of OSW Studio must do the same (`proxy_set_header Host $host;` in Nginx). Otherwise the app cannot tell the two addresses apart and the redirect loops.

A separate domain (such as `example-sites.com`) keeps sites further from the studio than a subdomain of the studio's own domain. Browsers treat subdomains of one domain as the same site for cookies, so a subdomain relies on the browser's cross-origin rules and the studio's origin checks rather than on cookies staying apart.

### Setting up subdomains

With `STATIC_PROXY=true`, OSW Studio writes a Caddyfile that serves each deployment from its own subdomain (`{slug}.{your instance domain}`) or custom domain, and reloads Caddy when it changes. It needs:

- `NEXT_PUBLIC_APP_URL` set to the studio's address, which the subdomains hang off
- wildcard DNS for `*.{your instance domain}` pointing at the server
- a Caddy build with the Cloudflare DNS module and `CLOUDFLARE_API_TOKEN`, for the wildcard certificate
- Caddy's admin API on `localhost:2019`
- a Caddyfile the app can write (`CADDYFILE_PATH`, default `/etc/caddy/Caddyfile`)

### Review copies

A site's review copy is served from the site's address too, or from the sites address for a site whose custom domain is not served by Caddy. Clients use it as before. Workspace members reply from the Review tab in the studio, which shows the team badge. On the review copy itself they are visitors like anyone else.

### Limits of each set-up

- **The default shares the studio's address.** A site's scripts can act as whoever opens it in the studio. That is a reasonable choice when you write or check every site you host and you are the only person using the studio.
- **A sites address is shared by every site on it.** In a visitor's browser, one site's scripts can read another site's storage, and can post review comments as a visitor who has a review copy open. The desktop app's sites port is shared the same way. Use subdomains when the sites on an instance belong to different people.
- **The wildcard subdomain answers any deployment by path.** With `STATIC_PROXY`, a subdomain no deployment uses still answers `/deployments/{id}/` for any deployment, on its own address.
- **The desktop app has no login.** While it is open, any program on the same computer can use its local API.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SERVER_MODE` | Yes | Set to `true` to enable Server Mode |
| `SESSION_SECRET` | Yes | Random string for JWT signing |
| `ADMIN_PASSWORD` | No | Bootstrap only. Used for initial setup when no user accounts exist. Once the first account is created via `/admin/register`, this is ignored. New installs can skip this entirely. |
| `ANALYTICS_SECRET` | No | Secret for analytics API |
| `SECRETS_ENCRYPTION_KEY` | No | 256-bit key for encrypting secrets |
| `SECURE_COOKIES` | No | Set to `false` to allow insecure cookies (pre-SSL only) |
| `NEXT_PUBLIC_APP_URL` | No | The studio's address. Used for SEO, sitemaps and origin checks, and for site subdomains with `STATIC_PROXY` |
| `SITES_ORIGIN` | No | A separate address to serve published sites from, e.g. `https://sites.example.com`. See [Where Published Sites Are Served](#where-published-sites-are-served) |
| `STATIC_PROXY` | No | Set to `true` when Caddy serves each site on its own subdomain or custom domain (the generated Caddyfile) |
| `ALLOWED_ORIGINS` | No | Comma-separated origins allowed to send write requests to the API, for a reverse proxy that rewrites the `Host` header and passes no `X-Forwarded-Host` (requests from other sites are refused with 403) |
| `REGISTRATION_MODE` | No | `open` to allow user self-registration, `closed` (default) for admin-only provisioning |
| `NEXT_PUBLIC_REGISTRATION_MODE` | No | Client-side mirror of `REGISTRATION_MODE` |
| `INSTANCE_API_KEY` | No | Shared secret for machine-to-machine admin API auth |
| `INSTANCE_ID` | No | Instance identifier for multi-instance setups |
| `MCP_ENABLED` | No | Set to `true` to expose the MCP connector at `/api/mcp`. See [MCP Server](?doc=mcp-server). |

For multitenancy details, see **[Multitenancy](?doc=multitenancy)**.

---

## Troubleshooting

### Database Issues

**Symptoms**: "Failed to initialize database"

**Solutions**:
1. Check write permissions on `data/` directory
2. Ensure disk space is available
3. Check file system supports SQLite (most do)
4. Try deleting `data/osws.sqlite` and restarting (loses data)

### Migration Failures

**Symptoms**: Tables not created, "relation does not exist"

**Solutions**:
1. Migrations run automatically on first request
2. Check terminal logs for errors
3. Restart the server to trigger migrations

### Authentication Issues

**Symptoms**: Can't login to /admin

**Solutions**:
1. If no users exist yet, visit `/admin` to create the admin account
2. Clear browser cookies and try again
3. Try incognito mode
4. Check `SESSION_SECRET` is set in .env
5. If you've forgotten your password, delete `data/system.sqlite` and restart to re-create the admin account (workspace data is preserved)

### Performance Issues

**Symptoms**: Slow site loads, high memory

**Solutions**:
1. Optimize published sites:
   - Compress images
   - Minify CSS/JS
   - Use CDN for libraries
2. Monitor server resources:
   ```bash
   htop  # or top
   df -h  # disk space
   free -m  # memory
   ```
3. Scale server resources (RAM/CPU)
4. Add caching (Nginx cache)

---

## Next Steps

- **[Deployment Publishing](?doc=site-publishing)** - Publish deployments with analytics, SEO, compliance
- **[Backend](?doc=backend-features)** - Database, edge functions, secrets
- **[FAQ](?doc=faq)** - Common Server Mode questions
- **[Troubleshooting](?doc=troubleshooting)** - Fix common issues
