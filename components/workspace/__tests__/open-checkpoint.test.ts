import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The checkpoint a project gets on its first open. A new project's first push can finish while the
 * checkpoint is being created, and stamps a server revision on the stored project; the write that
 * records the checkpoint must be of the project as it is after that, or it erases the revision and
 * every later push is refused as a conflict.
 */

type StoredProject = { id: string; updatedAt: Date; revision?: number; lastSavedCheckpointId?: string | null; lastSavedAt?: Date };

const store = vi.hoisted(() => ({ project: null as StoredProject | null }));
const vfsMock = vi.hoisted(() => ({
  getProject: vi.fn(async () => ({ ...store.project! })),
  updateProject: vi.fn(async (p: StoredProject) => { store.project = { ...p }; }),
}));
const checkpoints = vi.hoisted(() => ({ createCheckpoint: vi.fn() }));

vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/checkpoint', () => ({ checkpointManager: checkpoints }));

import { createOpenCheckpoint } from '../open-checkpoint';

const UPDATED = new Date('2026-10-01T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  store.project = { id: 'p1', updatedAt: UPDATED, lastSavedCheckpointId: null };
  checkpoints.createCheckpoint.mockImplementation(async () => ({ id: 'cp1' }));
});

describe('createOpenCheckpoint', () => {
  it('creates an auto checkpoint labelled as the project being opened', async () => {
    await expect(createOpenCheckpoint('p1')).resolves.toBe('cp1');
    expect(checkpoints.createCheckpoint).toHaveBeenCalledWith('p1', 'Project opened', { kind: 'auto', label: { key: 'projectOpened' } });
  });

  it('records it as the last save without making the project read as changed', async () => {
    await createOpenCheckpoint('p1');
    expect(vfsMock.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', lastSavedCheckpointId: 'cp1', lastSavedAt: UPDATED }),
      { preserveUpdatedAt: true },
    );
  });

  it('keeps a revision the first push stamped while the checkpoint was being created', async () => {
    checkpoints.createCheckpoint.mockImplementation(async () => {
      store.project = { ...store.project!, revision: 7 };
      return { id: 'cp1' };
    });
    await createOpenCheckpoint('p1');
    expect(store.project).toMatchObject({ revision: 7, lastSavedCheckpointId: 'cp1' });
  });

  it('writes nothing when the checkpoint cannot be created', async () => {
    checkpoints.createCheckpoint.mockRejectedValue(new Error('quota'));
    await expect(createOpenCheckpoint('p1')).rejects.toThrow('quota');
    expect(vfsMock.updateProject).not.toHaveBeenCalled();
  });
});
