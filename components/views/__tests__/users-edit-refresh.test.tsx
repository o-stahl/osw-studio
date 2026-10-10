// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The edit-user dialog's workspace list applies changes immediately, so after removing the user
 * from a workspace the open dialog shows the user as the server now has them, not as they were
 * when the dialog opened.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { UsersView } from '../users-view';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const now = new Date().toISOString();
const WORKSPACE = {
  id: 'w1', name: 'Studio', owner_id: 'u0', max_projects: 10, max_deployments: 5, max_storage_mb: 100,
  role: 'editor', created_at: now, updated_at: now,
};
const user = (workspaces: unknown[]) => ({
  id: 'u1', email: 'ann@example.com', displayName: null, isAdmin: false, active: true, studioView: true,
  workspaces, projectCount: 0, storageMb: 0, lastActive: null, createdAt: now, updatedAt: now,
});

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('removing a user from a workspace in the edit dialog', () => {
  it('shows the refreshed user in the open dialog', async () => {
    let revoked = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return json({ user: { isAdmin: true } });
      if (url === '/api/admin/users') return json({ users: [user(revoked ? [] : [WORKSPACE])] });
      if (url === '/api/admin/workspaces') return json({ workspaces: [] });
      if (url === '/api/admin/workspaces/w1/access' && init?.method === 'DELETE') {
        revoked = true;
        return json({ success: true });
      }
      return json({}, 404);
    }));

    await act(async () => { root.render(withMessages(<UsersView />)); });
    await settle();
    const row = Array.from(container.querySelectorAll('tr')).find(r => r.textContent?.includes('ann@example.com'));
    expect(row).toBeDefined();
    await act(async () => { row!.click(); });
    await settle();

    const remove = document.body.querySelector<HTMLButtonElement>(
      `[role="dialog"] button[aria-label="${en.admin.removeFrom.replace('{name}', 'Studio')}"]`);
    expect(remove).not.toBeNull();
    await act(async () => { remove!.click(); });
    await settle();

    expect(revoked).toBe(true);
    expect(toast.success).toHaveBeenCalledWith(en.admin.accessRevoked);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(en.admin.notInAnyWorkspace);
  });
});
