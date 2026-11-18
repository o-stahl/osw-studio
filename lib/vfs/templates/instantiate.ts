import { provisionBackendFeatures } from '../provision-backend-features';
import { seedPromptSuggestions } from '../prompt-suggestions';
import { getBuiltInTemplateDefinition } from './registry';
import { createProjectFromTemplate } from './utils';
import type { BuiltInTemplateDefinition, ProjectTemplate } from './types';

/**
 * A named built-in's files, for the few callers that want one specific template rather than
 * whichever the user picked. Throws on an unknown id: these callers name the template in their own
 * source, so a missing one is a bug rather than stale user data.
 */
export async function loadBuiltInProjectTemplate(id: string): Promise<ProjectTemplate> {
  const definition = getBuiltInTemplateDefinition(id);
  if (!definition) throw new Error(`Unknown built-in template: ${id}`);
  return definition.loadProjectTemplate();
}

/**
 * Gives an existing empty project a built-in's runtime and files.
 *
 * The runtime is part of the template, not something the caller supplies: Template Manager used to
 * write the files and leave the runtime at its default, so a project created there from a React
 * built-in was a React project the app treated as static.
 *
 * Takes a `vfs` rather than reaching for the singleton so a caller can hand it another instance,
 * matching `createProjectFromTemplate`.
 */
export async function applyBuiltInTemplate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vfs: any,
  projectId: string,
  definition: BuiltInTemplateDefinition
): Promise<ProjectTemplate> {
  const template = await definition.loadProjectTemplate();

  const project = await vfs.getProject(projectId);
  await vfs.updateProject({
    ...project,
    settings: {
      ...project.settings,
      runtime: definition.runtime,
      promptSuggestions: seedPromptSuggestions(definition.promptSuggestions),
      ...(definition.opensIn ? { opensIn: definition.opensIn } : {}),
    },
  });

  await createProjectFromTemplate(vfs, projectId, template, template.assets);

  // Returned so a caller that provisions the backend features itself can read them off the
  // template this already loaded, rather than loading the chunk a second time.
  return template;
}

/**
 * The whole template: runtime, files, and the backend features that belong to it.
 *
 * For callers with nothing useful to say about the parts. Creating a project from the template
 * list reports what was provisioned, so it composes `applyBuiltInTemplate` with its own
 * provisioning instead; exporting a built-in as `.oswt` has no such reporting, and used to skip
 * provisioning entirely, which is why those exports carried no edge functions, secrets or schema.
 */
export async function instantiateBuiltInTemplate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vfs: any,
  projectId: string,
  definition: BuiltInTemplateDefinition
): Promise<void> {
  const template = await applyBuiltInTemplate(vfs, projectId, definition);

  if (template.backendFeatures) {
    await provisionBackendFeatures(projectId, template.backendFeatures);
  }
}
