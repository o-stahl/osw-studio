// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * What the Styles tab reads out of the project's files (`useProjectStyleFacts`): colour and font
 * tokens and variables from the stylesheets, and breakpoints from the stylesheets, the pages'
 * `<style>` blocks and the widths `/overrides.css` already has blocks for. Mounted through a probe
 * component over a VFS fake, with the text decoding watched so a file the facts never read is
 * never decoded.
 */

type FakeFile = { path: string; content: string | ArrayBuffer };
let files: FakeFile[];
vi.mock('@/lib/vfs', () => ({
  vfs: { init: vi.fn(async () => {}), listFiles: vi.fn(async () => files) },
}));
vi.mock('@/lib/vfs/as-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/vfs/as-text')>();
  return { asText: vi.fn(actual.asText) };
});

import { asText } from '@/lib/vfs/as-text';
import { useProjectStyleFacts } from '../use-tokens';

const bytes = (text: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(copy).set(encoded);
  return copy;
};

let container: HTMLDivElement;
let root: Root;
let facts: ReturnType<typeof useProjectStyleFacts>;

function Probe({ projectId }: { projectId: string | null }) {
  facts = useProjectStyleFacts(projectId, 0);
  return null;
}

async function mount(projectId: string | null): Promise<void> {
  await act(async () => { root.render(<Probe projectId={projectId} />); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(asText).mockClear();
  files = [
    { path: '/styles.css', content: ':root { --accent: #ff0000; --sans: "Inter", sans-serif; }\n.card { color: var(--accent); }\n@media (max-width: 900px) { .card { padding: 0; } }' },
    { path: '/index.html', content: bytes('<style>@media (max-width: 600px) { h1 { margin: 0; } }</style><h1>Hi</h1>') },
    { path: '/overrides.css', content: '@media (max-width: 480px) {\n  [data-osw-id="m1"][data-osw-id] {\n    color: red;\n  }\n}\n' },
    { path: '/logo.png', content: bytes('\u0089PNG') },
    { path: '/fonts/inter.woff2', content: bytes('wOF2') },
    { path: '/app.js', content: 'console.log("@media (max-width: 300px)")' },
  ];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the project\'s style facts', () => {
  it('reads tokens and variables from the stylesheets and breakpoints from stylesheets, pages and the overrides file', async () => {
    await mount('p1');
    expect(facts.colorTokens.map(token => token.name)).toEqual(['--accent']);
    expect(facts.fontTokens.map(token => token.name)).toEqual(['--sans']);
    expect(facts.variables.map(def => def.name)).toEqual(['--accent', '--sans']);
    expect(facts.variableUses).toEqual({ '--accent': 1, '--sans': 0 });
    expect(facts.breakpoints).toEqual([900, 600, 480]);
  });

  it('decodes no file the facts are not read from', async () => {
    await mount('p1');
    expect(facts.breakpoints).toEqual([900, 600, 480]);
    const decoded = vi.mocked(asText).mock.calls.map(([content]) => content);
    for (const path of ['/logo.png', '/fonts/inter.woff2', '/app.js']) {
      expect(decoded).not.toContain(files.find(file => file.path === path)!.content);
    }
  });

  it('decodes each stylesheet once', async () => {
    await mount('p1');
    const decoded = vi.mocked(asText).mock.calls.map(([content]) => content);
    expect(decoded.filter(content => content === files[0].content)).toHaveLength(1);
  });

  it('is empty without a project', async () => {
    await mount(null);
    expect(facts).toEqual({ colorTokens: [], fontTokens: [], breakpoints: [], variables: [], variableUses: {} });
  });
});
