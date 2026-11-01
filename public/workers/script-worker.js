/**
 * Script Worker — Executes Python (Pyodide) and Lua (wasmoon) scripts
 * in a Web Worker to avoid blocking the UI thread.
 *
 * Not started from its URL: the app fetches this file as text and a sandboxed frame starts it from a blob
 * (lib/sandbox/script-sandbox.ts), so project code runs on an opaque origin, not the app's.
 *
 * Receives: { type: 'execute', payload: { runtime, entryPoint, files } }
 * Posts:    { type: 'stdout'|'stderr'|'status'|'error'|'complete'|'output-file', ... }
 */

/* global self, importScripts, postMessage */

let pyodide = null;
let luaFactory = null;

/**
 * Post a message back to the main thread.
 */
function send(type, data) {
  self.postMessage({ type, data });
}

function sendFile(path, content) {
  self.postMessage({ type: 'output-file', path, content });
}

// The Python/Lua runtimes are fetched from a CDN on first use, so they fail when the
// browser is offline or the CDN is blocked. Append a hint when we can detect offline.
function offlineHint() {
  try {
    return (self.navigator && self.navigator.onLine === false) ? ' The browser appears to be offline.' : '';
  } catch (_e) {
    return '';
  }
}

// ─── Python (Pyodide) ──────────────────────────────────────────────

// Pyodide raises a rejected promise in Python only when the value looks like an error, which it
// decides by a `stack` property (DOMException aside). WebKit's network errors have none, and an
// await on one never returns, so `await pyfetch(...)` to an unreachable host would hang the run.
// Failed requests rethrow as an error that has one.
const nativeFetch = self.fetch;
self.fetch = function fetch(input, init) {
  return nativeFetch.call(self, input, init).catch((err) => {
    if (err instanceof DOMException || (err && typeof err === 'object' && 'stack' in err)) throw err;
    throw new TypeError(err && err.message ? String(err.message) : String(err), { cause: err });
  });
};

async function ensurePyodide() {
  if (pyodide) return pyodide;

  send('status', 'Loading Python runtime...');

  try {
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js');
  } catch (_err) {
    throw new Error(
      'Python runtime unavailable — failed to download the interpreter (Pyodide) from the CDN.' +
      offlineHint() +
      ' python3/python cannot run in this environment; write the script to a file for the user to run instead, and do not retry until connectivity is restored.'
    );
  }

  try {
    pyodide = await self.loadPyodide({
      stdout: (msg) => send('stdout', msg),
      stderr: (msg) => send('stderr', msg),
    });
  } catch (_err) {
    throw new Error(
      'Python runtime unavailable — the interpreter failed to initialize.' +
      offlineHint() +
      ' python3/python cannot run in this environment; write the script to a file for the user to run instead.'
    );
  }

  // Pre-load micropip so users can install packages. Non-fatal: if it can't be fetched
  // (e.g. offline), core Python still works for scripts that don't install packages.
  try {
    await pyodide.loadPackage('micropip');
  } catch (_e) {
    send('status', 'micropip unavailable — package installation is disabled' + offlineHint());
  }

  send('status', 'Python runtime ready');
  return pyodide;
}

async function executePython(entryPoint, files) {
  const py = await ensurePyodide();

  // Mount VFS files into Pyodide's filesystem
  // Create /output/ directory for visual output
  try { py.FS.mkdir('/output'); } catch (_e) { /* exists */ }

  for (const [path, content] of Object.entries(files)) {
    // Skip dotfiles
    if (path.startsWith('/.')) continue;
    const dir = path.substring(0, path.lastIndexOf('/')) || '/';
    // Ensure parent directories exist
    const parts = dir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      try { py.FS.mkdir(current); } catch (_e) { /* exists */ }
    }
    py.FS.writeFile(path, content);
  }

  // Run the entry point script
  const code = files[entryPoint];
  if (!code) {
    send('error', `Entry point not found: ${entryPoint}`);
    return { exitCode: 1 };
  }

  // Set up Python environment so module imports work:
  const entryDir = entryPoint.substring(0, entryPoint.lastIndexOf('/')) || '/';
  try {
    await py.runPythonAsync(`
import sys, os
os.chdir(${JSON.stringify(entryDir)})
_ep_dir = ${JSON.stringify(entryDir)}
if _ep_dir not in sys.path:
    sys.path.insert(0, _ep_dir)
if '/' not in sys.path:
    sys.path.insert(0, '/')
__file__ = ${JSON.stringify(entryPoint)}
del _ep_dir
`);
  } catch (_e) { /* best effort */ }

  try {
    await py.runPythonAsync(code);
  } catch (err) {
    send('stderr', String(err));
    return { exitCode: 1 };
  }

  // Scan /output/ for new files and send them back
  try {
    const outputFiles = py.FS.readdir('/output').filter(f => f !== '.' && f !== '..');
    for (const filename of outputFiles) {
      const filePath = '/output/' + filename;
      try {
        const data = py.FS.readFile(filePath);
        const ext = filename.split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
          let binary = '';
          for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
          }
          const base64 = btoa(binary);
          sendFile(filePath, base64);
        } else {
          const decoder = new TextDecoder();
          sendFile(filePath, decoder.decode(data));
        }
      } catch (_e) { /* skip unreadable files */ }
    }
  } catch (_e) { /* /output/ may not have new files */ }

  return { exitCode: 0 };
}

// ─── Lua (wasmoon) ──────────────────────────────────────────────────

async function ensureLuaFactory() {
  if (luaFactory) return luaFactory;

  send('status', 'Loading Lua runtime...');

  try {
    // jsdelivr's browser build: esm.sh's build of wasmoon fails with "not compiled for this environment".
    const wasmoon = await import('https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm');
    luaFactory = new wasmoon.LuaFactory();
  } catch (_err) {
    throw new Error(
      'Lua runtime unavailable — failed to download the interpreter (wasmoon) from the CDN.' +
      offlineHint() +
      ' lua cannot run in this environment; write the script to a file for the user to run instead, and do not retry until connectivity is restored.'
    );
  }

  send('status', 'Lua runtime ready');
  return luaFactory;
}

async function executeLua(entryPoint, files) {
  const factory = await ensureLuaFactory();
  const engine = await factory.createEngine();

  try {
    // Override print to capture stdout
    engine.global.set('print', function (...args) {
      send('stdout', args.map(String).join('\t'));
    });

    // Pre-load module files so require() works
    const moduleFiles = {};
    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith('.lua') && path !== entryPoint) {
        const modName = path
          .replace(/^\//, '')
          .replace(/\.lua$/, '')
          .replace(/\//g, '.');
        moduleFiles[modName] = content;
      }
    }

    // Register custom searcher for VFS modules
    engine.global.set('__vfs_modules', JSON.stringify(moduleFiles));

    await engine.doString(`
      local vfs_modules = {}
      local json_str = __vfs_modules
      -- Simple JSON parse for module map (keys and string values only)
      for key, value in json_str:gmatch('"([^"]+)":"(.-[^\\\\])"') do
        -- Unescape basic sequences
        value = value:gsub('\\\\n', '\\n'):gsub('\\\\t', '\\t'):gsub('\\\\"', '"'):gsub('\\\\\\\\', '\\\\')
        vfs_modules[key] = value
      end
      __vfs_modules = nil

      table.insert(package.searchers, 2, function(modname)
        local source = vfs_modules[modname]
        if source then
          local fn, err = load(source, "@" .. modname .. ".lua")
          if fn then return fn
          else return "\\n\\tload error: " .. err end
        end
        return "\\n\\tno VFS module '" .. modname .. "'"
      end)
    `);

    // Run the entry point
    const code = files[entryPoint];
    if (!code) {
      send('error', 'Entry point not found: ' + entryPoint);
      engine.global.close();
      return { exitCode: 1 };
    }

    await engine.doString(code);

    engine.global.close();
    return { exitCode: 0 };

  } catch (err) {
    send('stderr', String(err));
    try { engine.global.close(); } catch (_e) { /* best effort */ }
    return { exitCode: 1 };
  }
}

// ─── Message handler ────────────────────────────────────────────────

self.onmessage = async function (event) {
  const msg = event.data;

  if (msg.type === 'execute') {
    const { runtime, entryPoint, files } = msg.payload;

    try {
      let result;
      if (runtime === 'python') {
        result = await executePython(entryPoint, files);
      } else if (runtime === 'lua') {
        result = await executeLua(entryPoint, files);
      } else {
        send('error', 'Unknown runtime: ' + runtime);
        self.postMessage({ type: 'complete', exitCode: 1 });
        return;
      }

      self.postMessage({ type: 'complete', exitCode: result.exitCode });
    } catch (err) {
      send('error', (err && err.message) ? err.message : String(err));
      self.postMessage({ type: 'complete', exitCode: 1 });
    }
  }
};
