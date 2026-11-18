import type { BackendFeatures, ProjectRuntime, PromptSuggestion, TemplateIntent } from '../types';

export interface AssetConfig {
  /** Public filename (in /public/) */
  filename: string;
  /** Target path in VFS */
  path: string;
}

/**
 * A complete project, ready to be written into the VFS file by file.
 *
 * A template is a set of files, not a recipe the app has to run: everything that distinguishes one
 * from another is already in `files`, so creating a project is a write loop with no template-specific
 * behaviour behind it.
 */
export interface ProjectTemplate {
  name: string;
  description: string;
  files: Array<{
    path: string;
    content: string;
    isBase64?: boolean; // For binary files encoded as base64
  }>;
  directories: string[];
  assets?: AssetConfig[];
  /**
   * Edge functions, secrets and schema provisioned alongside the files.
   *
   * Here rather than on the metadata because only creating a project reads them, while the metadata
   * is loaded to draw the template list. Two templates' functions came to 45 KB of JavaScript that
   * everyone who opened the list downloaded so that a badge could be shown, and the badge only ever
   * needed `hasBackendFeatures`.
   */
  backendFeatures?: BackendFeatures;
}

/** What the template list needs to draw a row, with none of the file content behind it. */
export interface BuiltInTemplateMetadata {
  id: string;
  name: string;
  description: string;
  isBuiltIn: true;
  runtime: ProjectRuntime;
  updatedAt: Date;
  /**
   * Whether creating this template provisions backend features, which is all the template list
   * needs in order to mark the row. The features themselves come with the files from
   * `loadProjectTemplate`. A test keeps the two in step.
   */
  hasBackendFeatures?: boolean;
  metadata?: {
    author?: string;
    /** A `LICENSE_OPTIONS` value, so built-ins and custom templates render the same string. */
    license?: string;
    tags?: string[];
    /** Which section of the template list this appears under. Every built-in declares one. */
    intent?: TemplateIntent;
  };
  /**
   * First things to ask the assistant, seeded into the project when one is created from this
   * template. The project owns them from then on; changing them here never reaches a project that
   * already exists.
   */
  promptSuggestions?: PromptSuggestion[];
  /**
   * The surface a project made from this template opens on (`Project.settings.opensIn`). Set from
   * what the template's pages are made of, measured on Canvas (`lib/canvas/tracing.ts`): `canvas`
   * where they are written as HTML, `preview` where a script or a bundle draws them. Absent: no
   * preference.
   */
  opensIn?: 'canvas' | 'preview';
}

/**
 * A built-in the app can actually create a project from.
 *
 * The body is behind `loadProjectTemplate` rather than a field so that importing the catalog costs
 * nothing but metadata. `components/template-browser` lists every built-in on a screen that may
 * never create one; with the files inlined, browsing the list would pull every template's content
 * into the bundle, and that cost grows with each template contributed.
 */
export interface BuiltInTemplateDefinition extends BuiltInTemplateMetadata {
  loadProjectTemplate: () => Promise<ProjectTemplate>;
}
