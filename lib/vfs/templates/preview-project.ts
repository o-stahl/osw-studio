/**
 * Throwaway projects that exist only to render a template.
 *
 * Previewing a template means compiling it, and the compiler reads from the VFS: Handlebars needs
 * the partials registered, and a component runtime needs esbuild to bundle the real source files.
 * So there is no way to show a template without materialising it somewhere first. These projects
 * are that somewhere, and they are deleted as soon as the preview closes.
 *
 * They are deliberately not the same thing as creating a project from the template:
 *
 * - **No backend features are provisioned.** A preview should not create edge functions, secrets or
 *   database tables. A page whose server probe goes unanswered falls back to its no-server path,
 *   which is what it would do on a static host anyway, and is the more honest thing to show.
 * - **No auto-sync.** A scratch project must never reach a server.
 * - **No prompt suggestions**, since nothing is going to chat about it.
 */

import { getBuiltInTemplateDefinition } from './registry';
import { createProjectFromTemplate, customTemplateToProjectTemplate } from './utils';
import { getRuntimeConfig } from '@/lib/runtimes/registry';
import { TEMPLATE_PREVIEW_ID_PREFIX, isTemplatePreviewProject } from '../template-preview-marker';
import type { CustomTemplate, ProjectRuntime } from '../types';
import type { ProjectTemplate } from './types';

export { isTemplatePreviewProject };


/**
 * Scratch projects with a preview currently open on them.
 *
 * The sweep runs whenever the project list loads, and the preview opens from a dialog inside that
 * list, so without this a reload underneath an open preview would delete the project it is
 * rendering from. Module-level rather than a parameter because the sweep's caller is the list and
 * the id belongs to the dialog, which is three components away.
 */
const inUse = new Set<string>();

export function markTemplatePreviewInUse(projectId: string): void {
  inUse.add(projectId);
}

export function releaseTemplatePreview(projectId: string): void {
  inUse.delete(projectId);
}

export interface TemplatePreviewProject {
  projectId: string;
  runtime: ProjectRuntime;
}

/**
 * Why a template cannot be shown, as a code the UI words, or null when it can be.
 *
 * Terminal runtimes are the whole of it: Python and Lua produce console output rather than a page,
 * and there is nothing for an iframe to render. Everything else has an entry point, including the
 * Spring Boot kit, whose page is a project overview rather than the service.
 */
export function templatePreviewUnavailableReason(runtime: ProjectRuntime): 'console' | null {
  if (getRuntimeConfig(runtime).previewMode === 'terminal') {
    return 'console';
  }
  return null;
}

/** Resolves a template-browser selection value to the files it would create. */
async function resolveTemplate(
  value: string,
  customTemplates: CustomTemplate[]
): Promise<{ template: ProjectTemplate; runtime: ProjectRuntime } | null> {
  if (value.startsWith('custom:')) {
    const custom = customTemplates.find((t) => t.id === value.slice('custom:'.length));
    if (!custom) return null;
    return {
      template: customTemplateToProjectTemplate(custom),
      // Custom templates predate the runtime field; those without one are Handlebars, matching
      // how the browser lists them.
      runtime: custom.runtime || 'handlebars',
    };
  }

  const definition = getBuiltInTemplateDefinition(value);
  if (!definition) return null;
  return { template: await definition.loadProjectTemplate(), runtime: definition.runtime };
}

/**
 * Materialises a template into a scratch project and returns what the preview needs to render it.
 *
 * Returns null for a template that no longer resolves, which can come from a stale selection
 * rather than a bug, so the caller shows a message instead of failing.
 */
export async function createTemplatePreviewProject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vfs: any,
  value: string,
  customTemplates: CustomTemplate[]
): Promise<TemplatePreviewProject | null> {
  const resolved = await resolveTemplate(value, customTemplates);
  if (!resolved) return null;

  // The files are loaded before the project exists. A built-in's are a lazily imported chunk, so a
  // failure here would otherwise leave an empty scratch project behind.
  const projectId = `${TEMPLATE_PREVIEW_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const project = await vfs.createProject(
    `Preview: ${resolved.template.name}`, // i18n-ignore: the name of a throwaway project nobody sees listed
    undefined,
    projectId
  );
  await vfs.updateProject({
    ...project,
    settings: { ...project.settings, runtime: resolved.runtime },
  });

  await createProjectFromTemplate(vfs, projectId, resolved.template, resolved.template.assets);

  markTemplatePreviewInUse(projectId);
  return { projectId, runtime: resolved.runtime };
}

/** Best effort: a preview that fails to clean up is swept the next time the list opens. */
export async function discardTemplatePreviewProject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vfs: any,
  projectId: string
): Promise<void> {
  if (!isTemplatePreviewProject(projectId)) return;
  releaseTemplatePreview(projectId);
  try {
    await vfs.deleteProject(projectId);
  } catch {
    // Swept later. Failing loudly here would interrupt closing a dialog.
  }
}

/**
 * Removes scratch projects left by a tab that closed mid-preview.
 *
 * Callers run this when opening the project list, before it renders, so a leftover never appears
 * as a project. `except` keeps a preview that is open right now from being swept underneath itself.
 */
export async function sweepTemplatePreviewProjects(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vfs: any,
  except?: string | null
): Promise<void> {
  try {
    const projects: Array<{ id: string }> = await vfs.listProjects({ includeTemplatePreviews: true });
    for (const project of projects) {
      if (!isTemplatePreviewProject(project.id)) continue;
      if (project.id === except || inUse.has(project.id)) continue;
      await discardTemplatePreviewProject(vfs, project.id);
    }
  } catch {
    // Sweeping is housekeeping; it must never stop the list from loading.
  }
}
