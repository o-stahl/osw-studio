/**
 * OSW Studio Desktop — Electron main process.
 *
 * Boots the bundled Next.js standalone server (Server Mode) on a free local
 * port and points a BrowserWindow at it. This file is the single source of
 * truth for the desktop shell: CI builds (.github/workflows/desktop-release.yml)
 * and local builds (deploy-osw-desktop.sh) both compile it from here.
 *
 * Updates are consent-based: the app checks for new releases and asks before
 * downloading or installing — it never switches versions on its own.
 */

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { migrateLegacyDir } from './migrate-legacy';
import { choosePort, movedPortWarning } from './server-port';
import { chooseSitePort, startSiteProxy } from './site-proxy';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
// Headless CI/diagnostic flag: runs the real boot path as a pass/fail command
// (no window). End users never pass it, so normal launch is unaffected.
const isSelfTest = process.argv.includes('--self-test') || process.env.OSW_SELFTEST === '1';
const RELEASES_URL = 'https://github.com/o-stahl/osw-studio/releases/latest';
const RELEASES_API_URL = 'https://api.github.com/repos/o-stahl/osw-studio/releases/latest';

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

// ---------------------------------------------------------------------------
// Logging — boot/update failures land in userData/logs/main.log so users can
// attach something useful to bug reports.
// ---------------------------------------------------------------------------

function logToFile(message: string): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'main.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never crash the app
  }
}

// ---------------------------------------------------------------------------
// Next.js standalone server
// ---------------------------------------------------------------------------

async function startNextServer(host: string = 'localhost'): Promise<number> {
  // A fixed port, so a URL that reaches this app keeps reaching it: an MCP connector is
  // registered against one. See server-port.ts for why 30011 and why the fallback stays low.
  const { checkPort } = await import('get-port-please');
  const choice = await choosePort(async (candidate) => (await checkPort(candidate, host)) !== false);
  const port = choice.port;
  if (choice.movedFromPreferred) logToFile(movedPortWarning(choice));

  process.env.PORT = String(port);
  process.env.HOSTNAME = host;
  process.env.NEXT_PUBLIC_APP_URL = `http://${host}:${port}`;
  process.env.OSW_DESKTOP = 'true';

  // Published sites on a second port, a different origin from the studio (see site-proxy.ts).
  const sitePort = await chooseSitePort(port, async (candidate) => (await checkPort(candidate, host)) !== false);
  await startSiteProxy(host, sitePort, port);
  process.env.SITES_ORIGIN = `http://${host}:${sitePort}`;

  // Platform-appropriate writable locations. The install dir is read-only on
  // Linux (AppImage squashfs) and often on Windows — every server-side path
  // that defaults to process.cwd() MUST be redirected here. The server reads
  // DATA_DIR / DEPLOYMENTS_DIR; the CI smoke test asserts this contract.
  const appDir = app.getAppPath();
  const dataDir = path.join(app.getPath('userData'), 'data');
  const deploymentsDir = path.join(app.getPath('userData'), 'deployments');
  const deploymentsStaticDir = path.join(app.getPath('userData'), 'deployments-static');

  // One-time rescue: versions ≤1.75 stored data inside the install directory.
  // If that data is still reachable (e.g. a Windows update that preserved it),
  // copy it to userData before first use. Best-effort — on macOS a drag-install
  // replaces the bundle (and the data inside it) before this code can run.
  migrateLegacyDir(path.join(appDir, 'data'), dataDir, logToFile);
  migrateLegacyDir(path.join(appDir, 'deployments'), deploymentsDir, logToFile);
  migrateLegacyDir(path.join(appDir, 'public', 'deployments'), deploymentsStaticDir, logToFile);

  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;

  fs.mkdirSync(deploymentsDir, { recursive: true });
  process.env.DEPLOYMENTS_DIR = deploymentsDir;

  // Published static output. Without this the builder writes into `cwd/public/deployments`, and
  // cwd is the app bundle (see the chdir below): publishing fails with EACCES on Linux and
  // Windows, and on macOS lands inside the bundle where the next drag-install discards it.
  fs.mkdirSync(deploymentsStaticDir, { recursive: true });
  process.env.DEPLOYMENTS_STATIC_DIR = deploymentsStaticDir;

  // Security secrets — generated on first launch, persisted across restarts
  const secretsFile = path.join(app.getPath('userData'), '.secrets.json');
  let secrets: { sessionSecret: string; encryptionKey: string };
  try {
    secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf-8'));
  } catch {
    secrets = {
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      encryptionKey: crypto.randomBytes(32).toString('base64'),
    };
    fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  }
  process.env.SESSION_SECRET = secrets.sessionSecret;
  process.env.SECRETS_ENCRYPTION_KEY = secrets.encryptionKey;
  // No admin password for desktop — it's a local single-user app

  // electron-builder's `directories.app: app` flattens the app directory,
  // so appDir points at the directory containing server.js.
  process.chdir(appDir);
  require(path.join(appDir, 'server.js'));

  return port;
}

async function waitForServer(url: string, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Self-test — full headless boot, used by CI and manual distro checks.
// ---------------------------------------------------------------------------

function postJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('request timed out')); });
    req.end();
  });
}

/**
 * Boots the real server and drives the workspace-init request, exiting 0/1.
 * Exercises the native-module/filesystem paths under Electron's ABI that a
 * system-Node smoke test misses.
 */
async function runSelfTest(): Promise<void> {
  console.log(`[self-test] OSW Studio Desktop v${app.getVersion()} on ${process.platform}/${process.arch}`);
  console.log(`[self-test] electron=${process.versions.electron} node=${process.versions.node} abi(modules)=${process.versions.modules}`);
  try {
    // Bind + probe 127.0.0.1 explicitly: `localhost` can resolve to IPv6 in CI
    // containers and miss the IPv4-bound server. The shipped app keeps localhost.
    const port = await startNextServer('127.0.0.1');
    const base = `http://127.0.0.1:${port}`;

    const ready = await waitForServer(base);
    if (!ready) {
      console.error('[self-test] FAIL: server did not respond within the startup timeout');
      app.exit(1);
      return;
    }

    const { status, body } = await postJson(`${base}/api/auth/desktop-init`);
    let parsed: { workspaceId?: string; error?: string; detail?: string } = {};
    try { parsed = JSON.parse(body); } catch { /* keep raw body for the log */ }

    if (status === 200 && parsed.workspaceId) {
      console.log(`[self-test] PASS: workspace initialized (${parsed.workspaceId})`);
      app.exit(0);
      return;
    }

    console.error(`[self-test] FAIL: desktop-init returned HTTP ${status}`);
    if (parsed.error) console.error(`[self-test] error: ${parsed.error}`);
    if (parsed.detail) console.error(`[self-test] detail:\n${parsed.detail}`);
    if (!parsed.error && body) console.error(`[self-test] body: ${body}`);
    app.exit(1);
  } catch (err) {
    console.error(`[self-test] FAIL: ${(err as Error)?.stack || String(err)}`);
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Failure diagnostics — never leave the user staring at a blank window.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function diagnosticPage(rawTitle: string, rawDetail: string): string {
  const title = escapeHtml(rawTitle);
  const detail = escapeHtml(rawDetail);
  const logPath = escapeHtml(path.join(app.getPath('userData'), 'logs', 'main.log'));
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OSW Studio — Problem</title>
<style>
  body { font-family: system-ui, sans-serif; background: #121212; color: #eaeaea; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .box { max-width: 560px; padding: 2rem; }
  h1 { font-size: 1.3rem; } p, li { line-height: 1.6; color: #bbb; }
  code { background: #1e1e1e; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.85em; }
  a { color: #7aa2f7; }
</style></head>
<body><div class="box">
  <h1>${title}</h1>
  <p>${detail}</p>
  <p>OSW Studio Desktop v${app.getVersion()}</p>
  <ul>
    <li>Restarting the app usually resolves transient startup problems.</li>
    <li>If this happened after an update, download the latest installer from the
        <a href="${RELEASES_URL}" target="_blank">releases page</a> and reinstall — your projects and data are kept.</li>
    <li>Log file for bug reports: <code>${logPath}</code></li>
  </ul>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showDiagnostic(title: string, detail: string): void {
  logToFile(`${title}: ${detail}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(diagnosticPage(title, detail));
  }
}

// ---------------------------------------------------------------------------
// Updates — check automatically, but download and install only on user consent.
// ---------------------------------------------------------------------------

interface UpdatePrefs { skippedVersion?: string }

function updatePrefsFile(): string {
  return path.join(app.getPath('userData'), 'update-prefs.json');
}

function readUpdatePrefs(): UpdatePrefs {
  try {
    return JSON.parse(fs.readFileSync(updatePrefsFile(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeUpdatePrefs(prefs: UpdatePrefs): void {
  try {
    fs.writeFileSync(updatePrefsFile(), JSON.stringify(prefs));
  } catch {
    // Non-fatal
  }
}

function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(n => parseInt(n, 10) || 0);
  const b = current.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

let updaterWired = false;
let updateDownloaded = false;
let downloadedVersion = '';

async function promptRestartToUpdate(version: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update ready',
    message: `OSW Studio v${version} has been downloaded.`,
    detail: 'Restart now to apply the update, or keep working — it will NOT install until you choose to.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    autoUpdater.quitAndInstall();
  }
}

async function showUpdateError(err: unknown): Promise<void> {
  const logPath = path.join(app.getPath('userData'), 'logs', 'main.log');
  const message = err instanceof Error ? err.message : String(err);
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Update failed',
    message: 'The update could not be downloaded.',
    detail: `${message}\n\nYou can download the latest version manually from the releases page. Details are saved to the log:\n${logPath}`,
    buttons: ['Open releases page', 'Close'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal(RELEASES_URL);
}

function wireUpdater(): void {
  if (updaterWired) return;
  updaterWired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Error dialogs are surfaced at the download call site (which owns the user
  // interaction); here we only record the error and clear any progress state.
  autoUpdater.on('error', (err) => {
    logToFile(`Updater error: ${err?.message || err}`);
    mainWindow?.setProgressBar(-1);
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.setProgressBar((progress?.percent ?? 0) / 100);
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.setProgressBar(-1);
    updateDownloaded = true;
    downloadedVersion = info.version;
    void promptRestartToUpdate(info.version);
  });
}

/**
 * Windows/Linux: prompt to download via electron-updater.
 * interactive = true for menu-triggered checks (always prompts, ignores skips).
 */
async function checkForUpdatesElectron(interactive: boolean): Promise<void> {
  wireUpdater();
  // An update is already downloaded and waiting — re-offer the restart on
  // manual checks instead of silently doing nothing.
  if (updateDownloaded) {
    if (interactive) await promptRestartToUpdate(downloadedVersion);
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (!version || !isNewerVersion(version, app.getVersion())) {
      if (interactive) {
        dialog.showMessageBox({ type: 'info', message: 'You are on the latest version.', detail: `OSW Studio v${app.getVersion()}` });
      }
      return;
    }
    if (!interactive && readUpdatePrefs().skippedVersion === version) return;

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `OSW Studio v${version} is available.`,
      detail: `You are on v${app.getVersion()}. If you download, it downloads in the background (progress shows on the taskbar) and prompts you to restart when it is ready. It will not install until you choose to.`,
      buttons: ['Download', 'Skip this version', 'Later'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) {
      logToFile(`Downloading update v${version}`);
      mainWindow?.setProgressBar(0);
      autoUpdater.downloadUpdate().catch(err => {
        mainWindow?.setProgressBar(-1);
        logToFile(`Update download failed: ${err?.message || err}`);
        void showUpdateError(err);
      });
    } else if (response === 1) {
      writeUpdatePrefs({ skippedVersion: version });
    }
  } catch (err) {
    logToFile(`Update check failed: ${(err as Error)?.message || err}`);
    if (interactive) {
      dialog.showMessageBox({ type: 'warning', message: 'Update check failed.', detail: 'See the log file for details, or check the releases page manually.' });
    }
  }
}

/**
 * macOS: in-place updates require code signing, which isn't set up — check the
 * GitHub API for a newer desktop release and point the user at the download.
 */
async function checkForUpdatesMac(interactive: boolean): Promise<void> {
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.get(RELEASES_API_URL, { headers: { 'User-Agent': 'osw-studio-desktop' } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    const release = JSON.parse(body);
    const version = String(release.tag_name || '').replace(/^desktop-v/, '');
    if (!version || !isNewerVersion(version, app.getVersion())) {
      if (interactive) {
        dialog.showMessageBox({ type: 'info', message: 'You are on the latest version.', detail: `OSW Studio v${app.getVersion()}` });
      }
      return;
    }
    if (!interactive && readUpdatePrefs().skippedVersion === version) return;

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `OSW Studio v${version} is available.`,
      detail: `You are on v${app.getVersion()}. Auto-update is not available on macOS (the app is unsigned) — download the new version from the releases page. Your projects and data are kept.`,
      buttons: ['Open releases page', 'Skip this version', 'Later'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) {
      shell.openExternal(RELEASES_URL);
    } else if (response === 1) {
      writeUpdatePrefs({ skippedVersion: version });
    }
  } catch (err) {
    logToFile(`Update check failed: ${(err as Error)?.message || err}`);
    if (interactive) {
      dialog.showMessageBox({ type: 'warning', message: 'Update check failed.', detail: 'Check the releases page manually.' });
    }
  }
}

function checkForUpdates(interactive: boolean): void {
  if (isDev) return;
  if (isMac) {
    void checkForUpdatesMac(interactive);
  } else {
    void checkForUpdatesElectron(interactive);
  }
}

// ---------------------------------------------------------------------------
// Menu — standard roles plus update actions under Help.
// ---------------------------------------------------------------------------

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' as const },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
    {
      role: 'help' as const,
      submenu: [
        { label: 'Check for Updates…', click: () => checkForUpdates(true) },
        { label: 'Open Releases Page', click: () => shell.openExternal(RELEASES_URL) },
        { type: 'separator' as const },
        { label: 'Report an Issue', click: () => shell.openExternal('https://github.com/o-stahl/osw-studio/issues') },
        { label: 'Open Logs Folder', click: () => {
          const logDir = path.join(app.getPath('userData'), 'logs');
          try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* opening still surfaces the path */ }
          shell.openPath(logDir);
        } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function createWindow(port: number): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'OSW Studio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const serverUrl = `http://localhost:${port}`;

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 (ERR_ABORTED) fires on normal in-app navigation interruptions
    if (errorCode === -3) return;
    showDiagnostic('The app failed to load', `${errorDescription} (${errorCode}) while loading ${validatedURL}.`);
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith('http://localhost')) return { action: 'allow' as const };
    shell.openExternal(url);
    return { action: 'deny' as const };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (!isDev) {
    const ready = await waitForServer(serverUrl);
    if (!ready) {
      showDiagnostic('The local server did not start', 'The bundled server did not respond within 30 seconds.');
      return;
    }
  }

  mainWindow.loadURL(serverUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  if (isSelfTest) {
    // Headless: boot, probe workspace init, exit. No window, no menu, no updater.
    await runSelfTest();
    return;
  }

  logToFile(`OSW Studio Desktop v${app.getVersion()} starting on ${process.platform}/${process.arch}`);
  buildMenu();
  try {
    if (isDev) {
      // Dev mode: run `npm run dev` in osw-studio-git and point at it
      serverPort = 3000;
    } else {
      serverPort = await startNextServer();
    }
    await createWindow(serverPort);
    checkForUpdates(false);
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    logToFile(`Failed to start: ${message}`);
    if (!mainWindow) {
      mainWindow = new BrowserWindow({ width: 900, height: 600, title: 'OSW Studio' });
    }
    mainWindow.loadURL(diagnosticPage('OSW Studio failed to start', message));
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && serverPort) {
    createWindow(serverPort);
  }
});
