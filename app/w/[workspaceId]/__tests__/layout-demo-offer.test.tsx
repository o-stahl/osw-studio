import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type React from 'react';

/**
 * The demo-import offer opens for the workspace's owner only: a member who is not its owner lands
 * in someone else's workspace, where "Welcome to your workspace" would put their demo projects. The
 * offer is still there for them, to tell the first run at once that nobody will be asked.
 */
const access = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'editor' | 'viewer' }));
const RANK = { viewer: 0, editor: 1, owner: 2 } as const;

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ userId: 'u1' }) }));
vi.mock('@/lib/auth/system-database', () => ({
  verifyWorkspaceAccess: (_user: string, _workspace: string, required: keyof typeof RANK = 'viewer') => {
    if (RANK[access.role] < RANK[required]) throw new Error('Workspace access denied');
  },
  getUserById: () => ({ studio_view: 1 }),
  getUserDefaultWorkspace: () => null,
}));
vi.mock('@/components/view-mode-provider', () => ({ ViewModeProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/demo-import', () => ({ DemoImportOffer: () => null }));

import WorkspaceLayout from '../layout';
import { DemoImportOffer } from '@/components/demo-import';

/** The props of the offer in the layout's element tree, or null when it holds none. */
function offer(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map(offer).find(Boolean) ?? null;
  const element = node as React.ReactElement<{ children?: unknown }>;
  return element.type === DemoImportOffer ? (element.props as Record<string, unknown>) : offer(element.props?.children);
}

async function render() {
  return WorkspaceLayout({ children: 'page', params: Promise.resolve({ workspaceId: 'ws-1' }) });
}

beforeEach(() => {
  access.role = 'owner';
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('HOSTED_DEMO_URL', 'https://try.oswstudio.com');
});
afterEach(() => vi.unstubAllEnvs());

describe('the workspace layout and the demo-import offer', () => {
  it("offers the import on the owner's workspace", async () => {
    expect(offer(await render())).toMatchObject({ workspaceId: 'ws-1', owner: true });
  });

  it('does not offer it to an editor or a viewer of the workspace, whose landing it still answers', async () => {
    access.role = 'editor';
    expect(offer(await render())).toMatchObject({ workspaceId: 'ws-1', owner: false });
    access.role = 'viewer';
    expect(offer(await render())).toMatchObject({ workspaceId: 'ws-1', owner: false });
  });

  it('is not there where no demo stands in front of the instance', async () => {
    vi.stubEnv('HOSTED_DEMO_URL', '');
    expect(offer(await render())).toBeNull();
  });
});
