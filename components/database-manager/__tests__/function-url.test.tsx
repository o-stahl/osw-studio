// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import { FunctionsManager } from '../functions-manager';

/**
 * The address the functions manager copies for an edge function is the one the deployment's site
 * calls: `/api/deployments/<id>/functions/<name>` on the site's host. Inside a workspace the
 * manager's own API base is `/api/w/<workspaceId>`, which serves no functions.
 */

const now = new Date().toISOString();
const EDGE = { id: 'f1', name: 'hello', method: 'GET', code: '', enabled: true, timeoutMs: 5000, createdAt: now, updatedAt: now };

let container: HTMLElement;
let root: Root;
let copied: string[];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  copied = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ functions: [EDGE] }), { status: 200 })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function copyUrl(props: { workspaceId?: string; publicUrl?: string }): Promise<string> {
  await act(async () => {
    root.render(withMessages(<FunctionsManager deploymentId="d1" {...props} />));
  });
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === en.common.actions.copyUrl);
  expect(button, 'copy button').toBeTruthy();
  await act(async () => { button!.click(); });
  return copied[0];
}

describe('FunctionsManager function address', () => {
  it('is the public function route in a workspace, not the workspace API', async () => {
    expect(await copyUrl({ workspaceId: 'ws1' })).toBe(`${window.location.origin}/api/deployments/d1/functions/hello`);
  });

  it("is on the site's own host where the site has one", async () => {
    expect(await copyUrl({ workspaceId: 'ws1', publicUrl: 'https://shop.example.com/' }))
      .toBe('https://shop.example.com/api/deployments/d1/functions/hello');
  });

  it('is the address "Open in Browser" opens too', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await act(async () => {
      root.render(withMessages(<FunctionsManager deploymentId="d1" workspaceId="ws1" publicUrl="https://shop.example.com/" />));
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label*="hello"]');
    expect(trigger, 'actions menu').toBeTruthy();
    await act(async () => { trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => el.textContent === en.backend.openInBrowser);
    expect(item, 'Open in Browser item').toBeTruthy();
    await act(async () => { (item as HTMLElement).click(); });

    expect(open).toHaveBeenCalledWith('https://shop.example.com/api/deployments/d1/functions/hello', '_blank');
  });
});

describe('the deployment page', () => {
  it("gives the functions manager the deployment's site address", async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(`${__dirname}/../../deployment-detail/index.tsx`, 'utf8');
    const mounts = source.match(/<FunctionsManager\b[^>]*\/>/g) ?? [];
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) expect(mount).toMatch(/publicUrl=\{deployment\.publicUrl\}/);
  });
});
