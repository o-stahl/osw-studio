# OSW Studio Desktop

Electron shell around the OSW Studio Next.js standalone server (full Server
Mode: SQLite storage, deployments, server functions). This directory is the
single source of truth for the desktop app — CI releases and local builds both
use these exact files.

## Layout

- `electron/main.ts` — boots the bundled server, failure diagnostics,
  consent-based updates, menu
- `electron/site-proxy.ts` — serves published sites on a second local port, so
  their scripts never run on the studio's origin
- `electron/icons/` — committed app icons (no build-time generation)
- `electron-builder.yml` — packaging config (dmg / nsis / AppImage / deb)
- `assemble-app.sh` — copies a finished Next.js standalone build into `app/`;
  shared verbatim by CI and local builds
- `tsup.config.ts` — compiles `main.ts` into `app/main.js`
- `package.json` — version is a `0.0.0` placeholder, set at build time from
  the repo root `package.json`

## Releasing

Releases are built and published by CI (`.github/workflows/desktop-release.yml`),
triggered by pushing a `desktop-v{version}` tag — normally via
`release-osw.sh` at the repo parent. The workflow builds all three platforms,
verifies the complete artifact set, generates release notes from
`.github/desktop-release-notes.md`, and publishes the GitHub release in a
single atomic step. If any platform build fails, nothing is published and
auto-updaters keep serving the previous complete release.

## Local build

From the repo parent directory:

```bash
./deploy-osw-desktop.sh [mac|win|linux|all]
```

Or manually from the repo root:

```bash
NEXT_PUBLIC_SERVER_MODE=true NEXT_PUBLIC_DESKTOP=true npm run build
./desktop/assemble-app.sh
cd desktop && npm ci && npm pkg set version=$(node -p "require('../package.json').version")
npx tsup && npx electron-builder --mac --publish never
```

## Dev mode

Run `npm run dev` in the repo root, then `npm run dev` in this directory —
the Electron window points at `localhost:3000` instead of booting the bundled
server. Dev mode does not start the second port for published sites, so they are
served from `localhost:3000` as in a plain server install.

## Updates

Updates are consent-based: the app checks GitHub releases on launch and via
Help → Check for Updates, but only downloads and installs when the user agrees
(`Download` → `Restart now`). Users can skip a version. On macOS, in-place
updates require code signing (not set up), so the app links to the releases
page instead.
