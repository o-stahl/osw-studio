# Deploying Your Website

Export your OSW Studio project and deploy it to any static hosting platform.

---

## Overview

OSW Studio projects export as static HTML/CSS/JavaScript that can be hosted anywhere:

1. Export your project as a ZIP file
2. Extract and upload to a hosting platform
3. Get a live URL

**Popular options:**
- **Netlify** - Simple drag & drop deployment
- **GitHub Pages** - Free hosting with Git integration
- **Cloudflare Pages** - Fast global CDN
- **Vercel** - Requires Git integration
- And many others (Render, Railway, traditional web hosts, etc.)

Most platforms offer free tiers for static sites, automatic HTTPS, and custom domain support.

---

## Deploy from OSW Studio

When available, the workspace header has a **Deploy** button that publishes the current project directly, without a manual export. It opens a dialog where you pick a **deployment target**. Only static-serveable projects can be deployed this way (Python and Lua projects run in a terminal and can't be served as a static site — use ZIP export instead).

### Hugging Face Space

Publishes the project as a **static Hugging Face Space** under your own HuggingFace account. Available when HuggingFace is connected (on a HuggingFace Space you can "Sign in with HuggingFace"; elsewhere, paste an HF access token with write access in Settings → Connections).

- Pick a name (suggested from the project), an optional description, and public/private.
- The Space is **live as soon as it finishes** — no separate step. You get the link in the dialog.
- Re-deploying updates the same Space; you can also publish it as a new Space.
- Each published Space's README credits OSW Studio, and the site gets an optional "Built with OSW Studio" footer you can turn off.

### Open Source Web Studio (this instance)

Available in **Server Mode**. Publishes to this OSW Studio instance as a managed **deployment** with its own publish settings, custom domain, and analytics. Selecting this target takes you to the **Deployments** page to create, enable, and publish. See [Server Mode](?doc=server-mode) and [Deployment Publishing](?doc=site-publishing) for details.

### Download as ZIP

Always available, for every project type. Downloads the compiled project as a ZIP you can upload to any static host — Netlify, GitHub Pages, Cloudflare Pages, Vercel, or a traditional web host. This is the same export described below, offered directly from the Deploy dialog.

---

## Export Your Project

### ZIP Export (For Deployment)

1. Open your project in OSW Studio
2. Click the **⋮** menu icon on the project card
3. Select **Export as ZIP**
4. Save the file

The ZIP contains compiled HTML/CSS/JS ready for deployment:
- **Static/Handlebars**: Handlebars `.hbs` templates are pre-compiled using `/data.json` and excluded from the export
- **React/Preact/Svelte/Vue**: Source files (`.tsx`, `.svelte`, `.vue`) are bundled into a single `bundle.js` that the export references — the bundle is runtime-independent and works on any static host
- **Python/Lua**: These runtimes execute in the browser via WASM and cannot be deployed to external hosts — use ZIP export for offline use or self-host in Server Mode instead

### .osws Export (For Backup)

For backing up projects with full history (checkpoints, conversations):

1. Click the **⋮** menu icon on the project card
2. Select **Export** (JSON format)
3. Save the `.osws` file

This format is for importing back into OSW Studio, not for deployment.

---

## Deploying to Netlify

**Simple drag & drop deployment:**

1. Go to [netlify.com](https://netlify.com) and sign up
2. On the dashboard, look for the **Sites** drop zone
3. Extract your ZIP file to a folder
4. Drag the folder into Netlify
5. Wait for deployment

Your site will be live at `random-name-12345.netlify.app`. You can customize the subdomain or add a custom domain in settings.

**CLI deployment:**
```bash
npm install -g netlify-cli
cd your-extracted-folder
netlify deploy --prod
```

---

## Deploying to GitHub Pages

**Requires Git and GitHub account:**

1. Extract your ZIP into a folder
2. Initialize Git repo:
   ```bash
   cd your-website
   git init
   git add .
   git commit -m "Initial commit"
   ```

3. Create a new repo at [github.com/new](https://github.com/new)

4. Push to GitHub:
   ```bash
   git remote add origin https://github.com/yourusername/repo-name.git
   git branch -M main
   git push -u origin main
   ```

5. Enable GitHub Pages:
   - Go to repo **Settings** → **Pages**
   - Source: **Deploy from a branch**
   - Branch: **main** → **/ (root)**
   - Click **Save**

Your site will be live at `yourusername.github.io/repo-name`

---

## Deploying to Cloudflare Pages

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com) and sign up
2. Click **Create a project** → **Upload assets**
3. Extract your ZIP and drag the folder
4. Enter a project name and deploy

Your site goes live at `project-name.pages.dev`

For automatic deployments, connect a Git repository instead of uploading manually.

---

## Deploying to Vercel

Vercel requires Git integration (no direct ZIP upload):

1. Push your extracted site to GitHub/GitLab
2. Go to [vercel.com](https://vercel.com) and sign up
3. Click **Add New** → **Project**
4. Import your repository
5. Deploy

See [Vercel's documentation](https://vercel.com/docs) for detailed instructions.

---

## Custom Domains

All major platforms support custom domains:

1. Buy a domain from a registrar (Namecheap, Cloudflare, Porkbun, etc.)
2. In your hosting platform, add the custom domain
3. Configure DNS records as instructed by the platform
4. Wait for DNS propagation (usually minutes to hours)

**DNS setup typically requires:**
- `A` record or `ALIAS` for apex domain (`example.com`)
- `CNAME` record for www subdomain (`www.example.com`)

Free SSL certificates are included automatically by all recommended platforms.

---

## Updating Your Site

When you make changes:

1. Export a new ZIP from OSW Studio
2. Extract the files
3. Upload to your hosting platform

**Netlify/Cloudflare Pages**: Drag new folder to deploy dashboard

**GitHub Pages**: Commit and push changes:
```bash
git add .
git commit -m "Update site"
git push
```

**Vercel**: Push to your connected Git repository

---

## Troubleshooting

### Site Shows 404

**Check:** Is there an `index.html` file in the root of your deployed folder?

**Fix:** Ensure your main page is named `index.html`

### Assets Not Loading

**Check:** Browser console for 404 errors

**Common causes:**
- Files not uploaded (check deployed folder contents)
- Case sensitivity (use lowercase filenames on Linux hosts)
- Path issues (ensure assets are in the correct folders)

**Fix:** Verify all files from the ZIP were uploaded and folder structure is intact

### Custom Domain Not Working

**Check:** DNS configuration

**Fix:**
1. Verify DNS records match platform instructions
2. Wait for DNS propagation (up to 24 hours, usually faster)
3. Clear browser cache or try incognito mode
4. Check platform status page for issues

### Deploy Fails on Platform

**Check:** Platform build logs for specific errors

**Common causes:**
- Platform looking for a build script (OSW Studio exports are pre-built)
- Incorrect publish directory setting

**Fix:** Configure platform to serve the root directory as static files (no build step needed)

---

## Server Mode Alternative

**Want to publish sites directly from OSW Studio without exporting?**

OSW Studio's **Server Mode** lets you:
- Host OSW Studio on your own server
- Create and publish deployments directly from the studio, served from their own address when the install has one
- Configure SEO, analytics, and custom domains per deployment
- Skip the export/upload cycle

See [Server Mode Documentation](?doc=server-mode) for setup instructions.

---

## Performance Tips

### Before Deploying

- **Optimize images**: Compress with [TinyPNG](https://tinypng.com) or similar
- **Use modern formats**: WebP for images when possible
- **Clean up code**: Remove unused files and commented code

### After Deploying

All recommended platforms automatically provide:
- Global CDN (content delivery network)
- Asset caching
- Compression (gzip/brotli)
- HTTP/2 or HTTP/3

No additional configuration needed.

---

## Next Steps

- Test your site on mobile devices
- Verify all links and forms work
- Submit sitemap to search engines (Google Search Console)
- Monitor traffic with analytics

**Continue learning:**
- [Working with AI](?doc=working-with-ai) - Improve your site
- [Projects](?doc=projects) - Manage multiple sites
- [Templates](?doc=templates) - Start new projects faster
