import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
  releaseSavePin: vi.fn(),
  checkpointExists: vi.fn(),
  restoreCheckpoint: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  scheduleAutoSync: vi.fn(),
  init: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../checkpoint', () => ({
  checkpointManager: {
    createCheckpoint: mocks.createCheckpoint,
    releaseSavePin: mocks.releaseSavePin,
    checkpointExists: mocks.checkpointExists,
    restoreCheckpoint: mocks.restoreCheckpoint,
  },
}));

vi.mock('../index', () => ({
  getActiveVFS: () => ({
    init: mocks.init,
    getProject: mocks.getProject,
    updateProject: mocks.updateProject,
    scheduleAutoSync: mocks.scheduleAutoSync,
  }),
}));

import { saveManager } from '../save-manager';

const PROJECT = 'proj-1';

describe('saveManager.save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCheckpoint.mockResolvedValue({
      id: 'cp_new',
      timestamp: '2026-09-20T12:00:00.000Z',
    });
    mocks.releaseSavePin.mockResolvedValue(true);
    mocks.getProject.mockResolvedValue({
      id: PROJECT,
      lastSavedCheckpointId: 'cp_old',
    });
  });

  it('makes the save unpinned and takes an earlier Save\'s pin off the previous save after the pointer moves', async () => {
    await saveManager.save(PROJECT, 'Manual save');

    expect(mocks.createCheckpoint).toHaveBeenCalledWith(
      PROJECT,
      'Manual save',
      expect.objectContaining({ kind: 'manual', baseRevisionId: 'cp_old' }),
    );
    // Pruning keeps the last save; a pin is only ever the person's.
    expect(mocks.createCheckpoint.mock.calls[0][2]).not.toHaveProperty('pinned');
    expect(mocks.updateProject).toHaveBeenCalled();
    const written = mocks.updateProject.mock.calls[0][0];
    expect(written.lastSavedCheckpointId).toBe('cp_new');
    expect(mocks.updateProject.mock.calls[1][1]).toEqual({ preserveUpdatedAt: true });
    expect(mocks.releaseSavePin).toHaveBeenCalledWith('cp_old');
  });

  it('records lastSavedAt from the stamped updatedAt so a later open can see a draft', async () => {
    mocks.updateProject.mockImplementation(async (project: { updatedAt?: Date; lastSavedAt?: Date }) => {
      if (!project.updatedAt) project.updatedAt = new Date('2026-09-20T12:00:01.000Z');
    });

    await saveManager.save(PROJECT);

    expect(mocks.updateProject.mock.calls[0][0].lastSavedCheckpointId).toBe('cp_new');
    expect(mocks.updateProject.mock.calls[1][0].lastSavedAt).toEqual(new Date('2026-09-20T12:00:01.000Z'));
  });

  it('on discard, moves the saved baseline up to the restore so the project reads as saved', async () => {
    // The restore stamps updatedAt as a change so it syncs (end to end in sync-end-state.test.ts).
    const restoredAt = new Date('2026-09-20T12:05:00.000Z');
    mocks.getProject.mockResolvedValue({
      id: PROJECT,
      lastSavedCheckpointId: 'cp_new',
      lastSavedAt: new Date('2026-09-20T12:00:00.000Z'),
      updatedAt: restoredAt,
    });
    mocks.checkpointExists.mockResolvedValue(true);
    mocks.restoreCheckpoint.mockResolvedValue(true);

    expect(await saveManager.restoreLastSaved(PROJECT)).toBe(true);
    expect(mocks.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: restoredAt, lastSavedAt: restoredAt }),
      { preserveUpdatedAt: true },
    );
  });

  it('does not unpin when this is the first save', async () => {
    mocks.getProject.mockResolvedValue({ id: PROJECT, lastSavedCheckpointId: null });

    await saveManager.save(PROJECT);

    expect(mocks.releaseSavePin).not.toHaveBeenCalled();
    expect(mocks.createCheckpoint).toHaveBeenCalledWith(
      PROJECT,
      expect.any(String),
      expect.objectContaining({ kind: 'manual', baseRevisionId: null }),
    );
  });
});

/**
 * The header reads the workspace store's flag, which a finished server run sets on its own. The
 * save manager may never have seen that change, and Discard back to the save has to clear it anyway.
 */
describe('saveManager.markClean', () => {
  it('tells its listeners the project is clean even when it had not marked it dirty', () => {
    const heard: { projectId: string; dirty: boolean }[] = [];
    const stop = saveManager.subscribe((event) => heard.push(event));
    saveManager.markClean('never-dirty');
    stop();
    expect(heard).toEqual([{ projectId: 'never-dirty', dirty: false }]);
  });
});

describe('saveManager.markDirty', () => {
  it('tells its listeners once, however many edits follow', () => {
    const heard: { projectId: string; dirty: boolean }[] = [];
    const stop = saveManager.subscribe((event) => heard.push(event));
    saveManager.markDirty('edited');
    saveManager.markDirty('edited');
    saveManager.markDirty('edited');
    stop();
    saveManager.markClean('edited');
    expect(heard).toEqual([{ projectId: 'edited', dirty: true }]);
  });
});
