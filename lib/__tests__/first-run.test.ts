import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldAutoCreateFirstProject, opensFirstProject, createFirstProject } from '../first-run';

const vfsMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  createProject: vi.fn(),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
}));
const fromTemplate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/templates/utils', () => ({ createProjectFromTemplate: fromTemplate }));
vi.mock('@/lib/vfs/templates/barebones', () => ({ BAREBONES_PROJECT_TEMPLATE: { name: 'barebones' } }));

describe('shouldAutoCreateFirstProject', () => {
  it('returns true for a fresh visitor with no params and no projects', () => {
    expect(shouldAutoCreateFirstProject({ search: '', projectCount: 0 })).toBe(true);
  });

  it('returns false when the user already has projects', () => {
    expect(shouldAutoCreateFirstProject({ search: '', projectCount: 2 })).toBe(false);
  });

  it('returns false when a specific project is targeted', () => {
    expect(shouldAutoCreateFirstProject({ search: '?project=abc', projectCount: 0 })).toBe(false);
  });

  it('returns false during an OAuth return (?code=)', () => {
    expect(shouldAutoCreateFirstProject({ search: '?code=xyz', projectCount: 0 })).toBe(false);
  });

  it('returns false when a doc is targeted', () => {
    expect(shouldAutoCreateFirstProject({ search: '?doc=whats-new', projectCount: 0 })).toBe(false);
  });

  it('returns false when settings is targeted', () => {
    expect(shouldAutoCreateFirstProject({ search: '?settings=1', projectCount: 0 })).toBe(false);
  });

  it('returns false on a failed OAuth return (?error=, no code)', () => {
    expect(shouldAutoCreateFirstProject({ search: '?error=access_denied', projectCount: 0 })).toBe(false);
  });

  it('returns false for an empty-valued param (has() still matches)', () => {
    expect(shouldAutoCreateFirstProject({ search: '?project=', projectCount: 0 })).toBe(false);
  });

  it('returns false when multiple relevant params are combined', () => {
    expect(shouldAutoCreateFirstProject({ search: '?code=x&doc=y', projectCount: 0 })).toBe(false);
  });
});

describe('opensFirstProject', () => {
  it('opens a project where people arrive to try building', () => {
    expect(['hf_space', 'managed', 'desktop'].every((s) => opensFirstProject(s as never))).toBe(true);
  });

  it('shows the projects page on a local or self-hosted install', () => {
    expect(opensFirstProject('browser')).toBe(false);
    expect(opensFirstProject('server')).toBe(false);
  });
});

describe('shouldAutoCreateFirstProject — provider sign-in return', () => {
  it('returns false while a sign-in is coming back', () => {
    expect(shouldAutoCreateFirstProject({ search: '?osw_sign_in=n1', projectCount: 0 })).toBe(false);
  });
});

describe('createFirstProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vfsMock.createProject.mockImplementation(async (name: string) => ({ id: 'p1', name, settings: { keep: 1 } }));
  });

  it('makes a static project from the barebones starter, under the name given', async () => {
    const project = await createFirstProject('Ensimmäinen sivustoni');
    expect(vfsMock.init).toHaveBeenCalled();
    expect(vfsMock.createProject).toHaveBeenCalledWith('Ensimmäinen sivustoni', '');
    expect(vfsMock.updateProject).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p1', settings: { keep: 1, runtime: 'static' },
    }));
    expect(fromTemplate).toHaveBeenCalledWith(vfsMock, 'p1', { name: 'barebones' });
    expect(project).toMatchObject({ id: 'p1', settings: { runtime: 'static' } });
    expect(vfsMock.deleteProject).not.toHaveBeenCalled();
  });

  it('takes a half-made project back out and reports the failure', async () => {
    fromTemplate.mockRejectedValueOnce(new Error('template failed'));
    await expect(createFirstProject('My First Site')).rejects.toThrow('template failed');
    expect(vfsMock.deleteProject).toHaveBeenCalledWith('p1');
  });

  it('still reports the original failure when taking it back out fails too', async () => {
    vfsMock.updateProject.mockRejectedValueOnce(new Error('write failed'));
    vfsMock.deleteProject.mockRejectedValueOnce(new Error('delete failed'));
    await expect(createFirstProject('My First Site')).rejects.toThrow('write failed');
  });
});
