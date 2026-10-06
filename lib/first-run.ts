import type { Project } from '@/lib/vfs/types';
import type { detectDeploymentType } from '@/lib/telemetry/config';

// Decide whether a fresh visitor should be dropped into an auto-created first project.
// False when any URL param indicates an existing destination (a specific project, a sign-in
// return, a doc, or settings), or when the user already has projects.
export function shouldAutoCreateFirstProject(opts: { search: string; projectCount: number }): boolean {
  if (opts.projectCount > 0) return false;
  const params = new URLSearchParams(opts.search);
  for (const key of ['project', 'code', 'error', 'osw_sign_in', 'doc', 'settings']) {
    if (params.has(key)) return false;
  }
  return true;
}

/**
 * Where a first visit opens a project rather than the projects page: the surfaces someone arrives at
 * to try building something (the HF Space, hosted, desktop). A git clone and a self-hosted server
 * are usually being set up, and an unasked-for project there is clutter.
 */
export function opensFirstProject(surface: ReturnType<typeof detectDeploymentType>): boolean {
  return surface === 'hf_space' || surface === 'managed' || surface === 'desktop';
}

/**
 * A static starter project, ready to build in. `name` is the person's own project name from here
 * on, so it is passed in the language they are using.
 */
export async function createFirstProject(name: string): Promise<Project> {
  const { vfs } = await import('@/lib/vfs');
  const { createProjectFromTemplate } = await import('@/lib/vfs/templates/utils');
  const { BAREBONES_PROJECT_TEMPLATE } = await import('@/lib/vfs/templates/barebones');
  await vfs.init();
  const project = await vfs.createProject(name, '');
  try {
    project.settings = { ...(project.settings ?? {}), runtime: 'static' };
    await vfs.updateProject(project);
    await createProjectFromTemplate(vfs, project.id, BAREBONES_PROJECT_TEMPLATE);
  } catch (error) {
    // A half-made project would suppress the next visit's first run; take it back out.
    try { await vfs.deleteProject(project.id); } catch { /* best effort */ }
    throw error;
  }
  return project;
}
