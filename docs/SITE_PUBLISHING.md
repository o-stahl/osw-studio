# Deployment Publishing

Publish and configure deployments directly from OSW Studio in **Server Mode**.

---

## Overview

Server Mode lets you publish static sites directly from your OSW Studio instance. Each deployment gets its own URL, configurable settings for analytics, SEO, compliance, and more.

**Key Features:**
- **One-click publishing** - Compile and deploy instantly
- **Deployment settings** - Scripts, CDN resources, analytics
- **SEO optimization** - Meta tags, Open Graph, sitemaps
- **Compliance** - Cookie consent, GDPR/CCPA banners
- **Custom domains** - Use your own domain (advanced)

---

## Creating a Deployment

### From Projects View

1. Right-click on a project card
2. Select **"Create Deployment"**
3. Enter deployment name
4. Click **"Create Deployment"**

### From Deployments View

1. Click **"+ New Deployment"** button
2. Select source project
3. Enter deployment details
4. Click **"Create Deployment"**

---

## Publishing Workflow

1. Create/edit deployment settings
2. Click **"Save & Close"**
3. Click **"Publish Now"** (or right-click deployment → Publish)
4. Static builder runs:
   - Loads project files from server
   - Compiles Handlebars templates (partials from `/templates/`, context from `/data.json`)
   - Uses pre-built `bundle.js` for framework runtimes (React, Preact, Svelte, Vue)
   - Rewrites internal links to include `/deployments/{id}/` prefix
   - Injects configured settings (scripts, analytics, SEO)
   - Generates sitemap.xml and robots.txt
   - Writes to `/public/deployments/{id}/`
5. Site is live!

**Note**: Python and Lua projects cannot be published — they run only in the browser's WASM runtime. Use ZIP export for offline distribution instead.

### Accessing Published Deployments

Where a deployment is served depends on the install: its own subdomain or custom domain (`STATIC_PROXY`), `https://sites.example.com/deployments/{id}/` (`SITES_ORIGIN`), or the studio's own address when neither is set. On the studio's address, `/deployments/{id}/` redirects to the site. See [Where Published Sites Are Served](?doc=server-mode).

**Clean URLs**, under a `/deployments/{id}/` path:
```
/deployments/{id}/about → /deployments/{id}/about.html
/deployments/{id}/blog/post → /deployments/{id}/blog/post.html
```

---

## Deployment Settings

Access deployment settings by clicking the gear icon on any deployment card, or right-click → Settings.

### General

- **Deployment name** - Display name for the deployment
- **URL slug** - Optional custom slug
- **Custom domain** - For advanced setups (see below)
- **Under construction** - Show maintenance page

### Scripts

Add custom scripts to your deployment's HTML:

**Head Scripts:**
- Analytics code
- Meta tag generators
- Preload hints

**Body Scripts:**
- Chat widgets
- Tracking pixels
- Third-party integrations

**Options:**
- Inline or external URL
- Async/defer loading
- Enable/disable per script

### CDN Resources

Load external CSS and JavaScript libraries:

- Bootstrap, Tailwind CDN
- Font Awesome, Material Icons
- jQuery, Alpine.js
- Google Fonts

**Configuration:**
- Resource URL
- Type (CSS or JS)
- Integrity hash (optional)
- Crossorigin setting

### Analytics

Track visitors with built-in or third-party analytics:

**Built-in Analytics** (privacy-focused):
- No cookies required
- Basic pageview tracking
- Referrer tracking
- Privacy mode option

**Third-party Providers:**
- Google Analytics 4
- Google Tag Manager
- Plausible
- Custom tracking code

**Enhanced Features** (toggleable):
- Heatmaps
- Session recording
- Performance metrics
- Engagement tracking
- Custom events

**Data Retention:**
- Configurable retention periods
- Pageviews: 90 days default
- Interactions: 30 days default
- Sessions: 60 days default

### SEO

Optimize your deployment for search engines:

**Meta Tags:**
- Title
- Description
- Keywords

**Open Graph:**
- OG Title
- OG Description
- OG Image

**Twitter Card:**
- Summary or Large Image

**Advanced:**
- Canonical URL
- noindex/nofollow options

**Auto-generated:**
- sitemap.xml
- robots.txt

**A page's own tags come first.** These settings apply to the whole deployment, so they are used as
defaults: if a page already has its own title, description, keywords, canonical URL or Open Graph
image in its `<head>`, that is what gets published and the setting is left unused for that page.
Anything a page does not set is filled in from here. That keeps a multi-page site's per-page titles,
which is what you want for search results; set the title on the page itself when you want it to
differ per page.

A few tags are applied to every page regardless, because they describe the deployment rather than
the page: the Open Graph URL and type, the Twitter card type, and the noindex/nofollow options.

### Compliance

GDPR/CCPA cookie consent and privacy compliance:

**Banner Settings:**
- Position: Top, Bottom, or Corner
- Style: Bar, Modal, or Corner popup
- Custom message text
- Accept/Decline button text

**Behavior:**
- Opt-in mode (block until consent)
- Opt-out mode (allow until decline)
- Block analytics until consent

**Policy Links:**
- Privacy policy URL
- Cookie policy URL

---

## Managing Deployments

### Deployment Actions

Right-click any deployment card for actions:

| Action | Description |
|--------|-------------|
| **View Live** | Open published site in new tab |
| **Settings** | Configure deployment options |
| **Republish** | Rebuild and deploy |
| **Copy Link** | Copy deployment URL to clipboard |
| **View Source** | Open source project |
| **Analytics** | View deployment analytics dashboard |
| **Capture Thumbnail** | Update preview image |
| **Unpublish** | Take the site off traffic, keeping the deployment and its data |
| **Delete** | Permanently remove deployment |

### Unpublish vs Delete

- **Unpublish**: Removes the published files, so the site stops answering. Its edge functions stop
  answering too, and its scheduled functions stop running. The deployment keeps its settings, its
  database and its analytics, and it keeps its address, so publishing again puts the same site back
  at the same URL.
  Pages are served with an hour of cache, so a visitor who loaded the site recently may still see it
  from their own browser cache for up to that long.
- **Delete**: Permanently removes the deployment, its settings, its database and its analytics. The
  address is released, so a later deployment of the same project gets a different one.

### Version Tracking

Each deployment shows:
- **Settings Version**: Current configuration version
- **Published Version**: Last published version

If these differ, the deployment has unpublished changes.

---

## Custom Domains

Use a custom domain (e.g., `sweetcandies.com`) for your published deployment. Enter the domain in Deployment Settings, add a DNS A record, and publish. See [Custom Domains Guide](CUSTOM_DOMAINS.md) for full details.

---

## Troubleshooting

### Publishing Errors

**Symptoms**: Deployment not building, empty `/public/deployments/`

**Solutions**:
1. Check build logs in terminal
2. Verify project has files synced to server
3. Check Handlebars syntax in templates
4. Verify disk permissions:
   ```bash
   ls -la public/
   chmod 755 public/
   ```
5. Check available disk space:
   ```bash
   df -h
   ```

### Deployment Not Updating After Republish

**Symptoms**: Changes not showing on published site

**Solutions**:
1. Hard refresh browser (Ctrl+Shift+R)
2. Check `settingsVersion` vs `lastPublishedVersion` in deployment card
3. Verify "Publish" was clicked (not just "Save")
4. Check build succeeded in terminal logs
5. Inspect HTML source for changes
6. Clear CDN cache (if using one)

### Custom Domain Not Working

See troubleshooting section in [Custom Domains Guide](CUSTOM_DOMAINS.md#troubleshooting).

---

## Next Steps

- **[Backend](?doc=backend-features)** - Database, edge functions, secrets
- **[MCP Server](?doc=mcp-server)** - Create, publish and unpublish deployments from an outside agent
- **[Server Mode](?doc=server-mode)** - Setup and deployment
- **[Troubleshooting](?doc=troubleshooting)** - Fix common issues
