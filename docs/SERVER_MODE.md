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
- Static site publishing at `/deployments/{id}/`
- Built-in analytics
- Project sync (browser <-> server)
- Server-side generation (close browser, AI keeps working)
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

# Optional: App URL (for SEO/sitemaps)
NEXT_PUBLIC_APP_URL=https://your-domain.com
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
- **Published sites**: http://localhost:3000/deployments/{id}/

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
- **edge-functions/*.json** - Edge functions (editable via shell commands)
- **server-functions/*.json** - Server functions (editable via shell commands)
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
3. Published sites are served locally at `http://localhost:3000/deployments/{id}/`

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
     NEXT_PUBLIC_APP_URL=${{ RAILWAY_PUBLIC_DOMAIN }}
     ```

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SERVER_MODE` | Yes | Set to `true` to enable Server Mode |
| `SESSION_SECRET` | Yes | Random string for JWT signing |
| `ADMIN_PASSWORD` | No | Bootstrap only. Used for initial setup when no user accounts exist. Once the first account is created via `/admin/register`, this is ignored. New installs can skip this entirely. |
| `ANALYTICS_SECRET` | No | Secret for analytics API |
| `SECRETS_ENCRYPTION_KEY` | No | 256-bit key for encrypting secrets |
| `SECURE_COOKIES` | No | Set to `false` to allow insecure cookies (pre-SSL only) |
| `NEXT_PUBLIC_APP_URL` | No | Base URL for SEO/sitemaps |
| `REGISTRATION_MODE` | No | `open` to allow user self-registration, `closed` (default) for admin-only provisioning |
| `NEXT_PUBLIC_REGISTRATION_MODE` | No | Client-side mirror of `REGISTRATION_MODE` |
| `INSTANCE_API_KEY` | No | Shared secret for machine-to-machine admin API auth |
| `INSTANCE_ID` | No | Instance identifier for multi-instance setups |

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
