import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { PREVIEW_SANDBOX, PROJECT_SANDBOX } from '@/lib/sandbox';

/**
 * Project code runs only where `lib/sandbox` puts it. A worker started anywhere in the app shares
 * the app's origin (where project code could read IndexedDB and call the API as the user),
 * and so does an iframe without a sandbox. So outside `lib/sandbox` the app's source creates no
 * `Worker` or `SharedWorker` and no iframe of its own, and an `<iframe>` element carries one of the
 * sandbox's values. A place with a real reason to differ is listed here with it.
 */

const ROOT = path.resolve(__dirname, '../../..');
const SCANNED = ['app', 'components', 'lib'];
const SANDBOX_DIR = 'lib/sandbox/';

/** Files that may create an iframe directly, each with the reason. */
const IFRAME_EXCEPTIONS: Record<string, string> = {
  'lib/demo-bridge/client.ts': 'frames the demo\'s own bridge page on another site; no project code runs in it',
};

/** Files skipped entirely, each with the reason. */
const SKIPPED: Record<string, string> = {
  'lib/vfs/templates/': 'template content written into projects, not code the app runs',
};

const WORKER = /\bnew\s+(?:(?:window|self|globalThis)\.)?(?:Shared)?Worker\s*\(/;
const CREATE_IFRAME = /createElement\(\s*['"`]iframe['"`]/i;
const JSX_IFRAME = /<iframe\b([^>]*)>/gi;
const SAME_ORIGIN_LITERAL = /['"`][^'"`\n]*allow-same-origin/;
const ALLOWED_JSX_SANDBOX = /\bsandbox=\{(?:PREVIEW_SANDBOX|PROJECT_SANDBOX)\}/;

/** Comments go first: they describe workers and frames without making any. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function violations(file: string, source: string): string[] {
  if (file.startsWith(SANDBOX_DIR)) return [];
  const code = stripComments(source);
  const found: string[] = [];
  if (WORKER.test(code)) found.push(`${file}: creates a worker outside lib/sandbox`);
  if (CREATE_IFRAME.test(code) && !(file in IFRAME_EXCEPTIONS)) found.push(`${file}: creates an iframe outside lib/sandbox`);
  if (SAME_ORIGIN_LITERAL.test(code)) found.push(`${file}: names allow-same-origin`);
  for (const match of code.matchAll(JSX_IFRAME)) {
    if (!ALLOWED_JSX_SANDBOX.test(match[1])) found.push(`${file}: <iframe> without a lib/sandbox sandbox value`);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(rel));
    } else if (/\.(tsx?|m?js)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('the scanner', () => {
  it('finds each kind of escape', () => {
    expect(violations('lib/x.ts', `const w = new Worker('/w.js');`)).toHaveLength(1);
    expect(violations('lib/x.ts', `const w = new window.SharedWorker(url);`)).toHaveLength(1);
    expect(violations('lib/x.ts', `const f = document.createElement("iframe");`)).toHaveLength(1);
    expect(violations('lib/x.tsx', `return <iframe src={u} />;`)).toHaveLength(1);
    expect(violations('lib/x.tsx', `return <iframe sandbox="allow-scripts" />;`)).toHaveLength(1);
    expect(violations('lib/x.ts', `f.setAttribute('sandbox', 'allow-scripts allow-same-origin');`)).toHaveLength(1);
  });

  it('passes what is allowed', () => {
    expect(violations('lib/sandbox/x.ts', `new Worker(u); document.createElement('iframe');`)).toEqual([]);
    expect(violations('lib/x.tsx', `return <iframe ref={r} sandbox={PREVIEW_SANDBOX} title="t" />;`)).toEqual([]);
    expect(violations('lib/x.ts', `// was: new Worker('/w.js')\n/* <iframe src> */ const url = 'https://a.example';`)).toEqual([]);
    expect(violations('lib/demo-bridge/client.ts', `document.createElement('iframe')`)).toEqual([]);
  });
});

describe('the app\'s source', () => {
  const files = SCANNED.flatMap(sourceFiles).filter((f) => !Object.keys(SKIPPED).some((s) => f.startsWith(s)));

  it('runs project code only through lib/sandbox', () => {
    const found = files.flatMap((f) => violations(f, readFileSync(path.join(ROOT, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('is actually scanned: the places that make frames and workers are among the files read', () => {
    for (const f of ['components/preview/multipage-preview.tsx', 'lib/sandbox/index.ts', 'lib/sandbox/script-sandbox.ts', 'lib/scripting/script-runner.ts']) {
      expect(files).toContain(f);
    }
    const preview = stripComments(readFileSync(path.join(ROOT, 'components/preview/multipage-preview.tsx'), 'utf8'));
    expect([...preview.matchAll(JSX_IFRAME)].length).toBeGreaterThan(0);
  });

  it('keeps the exceptions current', () => {
    for (const file of Object.keys(IFRAME_EXCEPTIONS)) {
      expect(CREATE_IFRAME.test(readFileSync(path.join(ROOT, file), 'utf8'))).toBe(true);
    }
  });
});

describe('the sandbox values', () => {
  it('never give project code the app\'s origin', () => {
    for (const value of [PREVIEW_SANDBOX, PROJECT_SANDBOX]) {
      expect(value.split(/\s+/)).not.toContain('allow-same-origin');
      expect(value.split(/\s+/)).toContain('allow-scripts');
    }
  });

  it('allow scripts, and forms only in the preview, and nothing more', () => {
    // Each token widens what project code may do; allow-top-navigation would let it navigate the studio's tab.
    expect(PREVIEW_SANDBOX.split(/\s+/).sort()).toEqual(['allow-forms', 'allow-scripts']);
    expect(PROJECT_SANDBOX.split(/\s+/)).toEqual(['allow-scripts']);
  });

  it('give the live preview the one that lets its forms submit', () => {
    const preview = stripComments(readFileSync(path.join(ROOT, 'components/preview/multipage-preview.tsx'), 'utf8'));
    const sandboxes = [...preview.matchAll(JSX_IFRAME)].map((match) => /\bsandbox=\{(\w+)\}/.exec(match[1])?.[1]);
    expect(sandboxes).toEqual(['PREVIEW_SANDBOX']);
  });
});
