import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** Recording that the user dealt with the demo-import offer: a webhook event for the gateway. */
const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  verifyWorkspaceAccess: vi.fn(),
  enqueueEventOnce: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/auth/system-database', () => ({ verifyWorkspaceAccess: mocks.verifyWorkspaceAccess }));
vi.mock('@/lib/webhooks/outbox', () => ({ enqueueEventOnce: mocks.enqueueEventOnce }));
vi.mock('@/lib/utils', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST } from '../demo-import/route';

const call = () => POST(new NextRequest(`http://localhost/api/w/${WS}/demo-import`, { method: 'POST' }), { params: Promise.resolve({ workspaceId: WS }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: 'u-1', email: 'a@example.com', isAdmin: false });
});

describe('POST /api/w/{id}/demo-import', () => {
  it("tells the gateway, through the webhook outbox, about the signed-in user", async () => {
    const res = await call();
    expect(res.status).toBe(204);
    expect(mocks.verifyWorkspaceAccess).toHaveBeenCalledWith('u-1', WS, 'viewer');
    expect(mocks.enqueueEventOnce).toHaveBeenCalledWith('user.demo_import_handled', { userId: 'u-1' });
  });

  it('records nothing for someone signed out or outside the workspace', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await call()).status).toBe(401);
    mocks.verifyWorkspaceAccess.mockImplementationOnce(() => { throw new Error('Workspace access denied'); });
    expect((await call()).status).toBe(403);
    expect(mocks.enqueueEventOnce).not.toHaveBeenCalled();
  });
});
