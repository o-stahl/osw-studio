import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { CustomTemplate, BackendFeatures, EdgeFunction, ServerFunction, Secret } from './types';
import { StorageAdapter } from './adapters/types';
import { encodeTemplateFiles, decodeTemplateFiles } from './binary-encoding';
import { logger } from '@/lib/utils';
import { translator } from '@/lib/i18n/runtime';

const MAX_TEMPLATE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_THUMBNAIL_SIZE = 500 * 1024; // 500KB
const MAX_PREVIEW_IMAGE_SIZE = 1024 * 1024; // 1MB
const MAX_PREVIEW_IMAGES = 5;

export interface TemplateMetadata {
  name: string;
  description: string;
  version: string;
  author?: string;
  authorUrl?: string;
  license: string;
  licenseLabel?: string;
  licenseDescription?: string;
  tags?: string[];
  thumbnail?: string;
  previewImages?: string[];
  downloadUrl?: string;
}

export class TemplateService {
  private adapter: StorageAdapter | null = null;
  private initPromise: Promise<void> | null = null;

  private async doInit(): Promise<void> {
    if (this.adapter) return;
    const { vfs } = await import('./index');
    await vfs.init();
    this.adapter = vfs.getStorageAdapter();
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private getAdapter(): StorageAdapter {
    if (!this.adapter) {
      throw new Error('TemplateService not initialized. Call init() first.');
    }
    return this.adapter;
  }

  /**
   * Export a project as a template (.oswt file)
   */
  async exportProjectAsTemplate(
    vfs: any,
    projectId: string,
    metadata: TemplateMetadata
  ): Promise<Blob> {
    try {
      logger.info('[TemplateService] Exporting project as template', { projectId, name: metadata.name });

      // Validate metadata
      this.validateMetadata(metadata);

      // Get project runtime setting
      const project = await vfs.getProject(projectId);
      const runtime = project?.settings?.runtime;

      // Get all files and directories from the project
      const items = await vfs.getAllFilesAndDirectories(projectId);

      // Separate files and directories
      const files = items.filter((item: any) => item.type !== 'directory');
      const directories = items
        .filter((item: any) => item.type === 'directory')
        .map((item: any) => item.path);

      // Extract backend features from project IndexedDB stores
      let backendFeatures: BackendFeatures | undefined;
      try {
        const adapter = vfs.getStorageAdapter();
        const edgeFunctions = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
        const serverFunctions = adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [];
        const secrets = adapter.listSecrets ? await adapter.listSecrets(projectId) : [];

        if (edgeFunctions.length > 0 || serverFunctions.length > 0 || secrets.length > 0) {
          backendFeatures = {
            edgeFunctions: edgeFunctions.length > 0 ? edgeFunctions.map((fn: EdgeFunction) => ({
              name: fn.name,
              method: fn.method,
              code: fn.code,
              description: fn.description,
              enabled: fn.enabled,
              timeoutMs: fn.timeoutMs,
            })) : undefined,
            serverFunctions: serverFunctions.length > 0 ? serverFunctions.map((fn: ServerFunction) => ({
              name: fn.name,
              code: fn.code,
              description: fn.description,
              enabled: fn.enabled,
            })) : undefined,
            secrets: secrets.length > 0 ? secrets.map((s: Secret) => ({
              name: s.name,
              description: s.description,
            })) : undefined,
          };
        }
      } catch {
        logger.warn('[TemplateService] Could not extract backend features from project stores');
      }

      // Create template data
      const templateData = {
        version: backendFeatures ? '2.0.0' : '1.0.0', // Template format version
        name: metadata.name,
        description: metadata.description,
        templateVersion: metadata.version,
        author: metadata.author,
        authorUrl: metadata.authorUrl,
        license: metadata.license,
        licenseLabel: metadata.licenseLabel,
        licenseDescription: metadata.licenseDescription,
        tags: metadata.tags || [],
        thumbnail: metadata.thumbnail,
        previewImages: metadata.previewImages || [],
        downloadUrl: metadata.downloadUrl,
        runtime,
        directories,
        files: encodeTemplateFiles(files),
        assets: [],
        backendFeatures,
      };

      // Create ZIP archive
      const zip = new JSZip();
      zip.file('template.json', JSON.stringify(templateData, null, 2));

      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      logger.info('[TemplateService] Template exported successfully', {
        name: metadata.name,
        size: blob.size
      });

      return blob;
    } catch (error) {
      logger.error('[TemplateService] Failed to export template:', error);
      throw new Error(`Failed to export template: ${error instanceof Error ? error.message : 'Unknown error'}`); // i18n-ignore: logged by every caller, never shown
    }
  }

  /**
   * Save a project as a custom template directly to IndexedDB (no file download)
   */
  async saveProjectAsTemplate(
    vfs: any,
    projectId: string,
    metadata: TemplateMetadata
  ): Promise<CustomTemplate> {
    try {
      logger.info('[TemplateService] Saving project as template', { projectId, name: metadata.name });

      this.validateMetadata(metadata);

      const project = await vfs.getProject(projectId);
      const runtime = project?.settings?.runtime;

      const items = await vfs.getAllFilesAndDirectories(projectId);
      const files = items.filter((item: any) => item.type !== 'directory');
      const directories = items
        .filter((item: any) => item.type === 'directory')
        .map((item: any) => item.path);

      let backendFeatures: BackendFeatures | undefined;
      try {
        const adapter = vfs.getStorageAdapter();
        const edgeFunctions = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
        const serverFunctions = adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [];
        const secrets = adapter.listSecrets ? await adapter.listSecrets(projectId) : [];

        if (edgeFunctions.length > 0 || serverFunctions.length > 0 || secrets.length > 0) {
          backendFeatures = {
            edgeFunctions: edgeFunctions.length > 0 ? edgeFunctions.map((fn: EdgeFunction) => ({
              name: fn.name, method: fn.method, code: fn.code,
              description: fn.description, enabled: fn.enabled, timeoutMs: fn.timeoutMs,
            })) : undefined,
            serverFunctions: serverFunctions.length > 0 ? serverFunctions.map((fn: ServerFunction) => ({
              name: fn.name, code: fn.code, description: fn.description, enabled: fn.enabled,
            })) : undefined,
            secrets: secrets.length > 0 ? secrets.map((s: Secret) => ({
              name: s.name, description: s.description,
            })) : undefined,
          };
        }
      } catch {
        logger.warn('[TemplateService] Could not extract backend features from project stores');
      }

      const template: CustomTemplate = {
        id: uuidv4(),
        name: metadata.name,
        description: metadata.description,
        version: metadata.version || '1.0.0',
        files: files.map((file: any) => ({ path: file.path, content: file.content })),
        directories,
        assets: [],
        metadata: {
          author: metadata.author,
          authorUrl: metadata.authorUrl,
          license: metadata.license,
          licenseLabel: metadata.licenseLabel,
          licenseDescription: metadata.licenseDescription,
          tags: metadata.tags || [],
          thumbnail: metadata.thumbnail,
          previewImages: metadata.previewImages || [],
          downloadUrl: metadata.downloadUrl,
        },
        runtime,
        importedAt: new Date(),
        backendFeatures,
      };

      await this.init();
      await this.getAdapter().saveCustomTemplate(template);

      // Background sync to server
      import('./auto-sync').then(({ autoSyncTemplate }) => autoSyncTemplate(template)).catch(() => {});
      this.emitTemplatesChanged();

      logger.info('[TemplateService] Template saved successfully', { id: template.id, name: template.name });

      return template;
    } catch (error) {
      logger.error('[TemplateService] Failed to save template:', error);
      throw new Error(translator()('templatesUi.errors.saveFailed', { error: error instanceof Error ? error.message : translator()('common.labels.unknown') }));
    }
  }

  /**
   * Import a template file (.oswt)
   */
  async importTemplateFile(file: File): Promise<CustomTemplate> {
    try {
      logger.info('[TemplateService] Importing template file', { name: file.name, size: file.size });

      // Validate file
      if (!file.name.endsWith('.oswt')) {
        throw new Error(translator()('templatesUi.errors.invalidFileType'));
      }

      if (file.size > MAX_TEMPLATE_SIZE) {
        throw new Error(translator()('templatesUi.errors.fileTooLarge', { mb: Math.round(MAX_TEMPLATE_SIZE / 1024 / 1024) }));
      }

      // Read ZIP file
      const zip = new JSZip();
      const zipData = await zip.loadAsync(file);
      const templateFile = zipData.file('template.json');

      if (!templateFile) {
        throw new Error(translator()('templatesUi.errors.missingManifest'));
      }

      // Parse template data
      const templateJson = await templateFile.async('string');
      const templateData = JSON.parse(templateJson);

      // Validate template structure
      this.validateTemplateStructure(templateData);

      // Create CustomTemplate object
      const template: CustomTemplate = {
        id: uuidv4(),
        name: templateData.name,
        description: templateData.description,
        version: templateData.templateVersion || '1.0.0',
        files: decodeTemplateFiles(templateData.files || []),
        directories: templateData.directories || [],
        assets: templateData.assets,
        metadata: {
          author: templateData.author,
          authorUrl: templateData.authorUrl,
          license: templateData.license || 'personal',
          licenseLabel: templateData.licenseLabel,
          licenseDescription: templateData.licenseDescription,
          tags: templateData.tags || [],
          thumbnail: templateData.thumbnail,
          previewImages: templateData.previewImages || [],
          downloadUrl: templateData.downloadUrl
        },
        runtime: templateData.runtime,
        importedAt: new Date(),
        backendFeatures: templateData.backendFeatures || templateData.serverFeatures,
      };

      // Save to IndexedDB
      await this.init();
      await this.getAdapter().saveCustomTemplate(template);

      // Background sync to server
      import('./auto-sync').then(({ autoSyncTemplate }) => autoSyncTemplate(template)).catch(() => {});
      this.emitTemplatesChanged();

      logger.info('[TemplateService] Template imported successfully', {
        id: template.id,
        name: template.name
      });

      return template;
    } catch (error) {
      logger.error('[TemplateService] Failed to import template:', error);
      throw new Error(translator()('templatesUi.errors.importFailed', { error: error instanceof Error ? error.message : translator()('common.labels.unknown') }));
    }
  }

  /**
   * Notify the UI that the custom-template set changed (import / save / delete), so lists that
   * fetch templates once on mount — notably the new-project template picker in ProjectManager —
   * can refresh without a full app reload. Guarded for non-browser (SSR) contexts.
   */
  private emitTemplatesChanged(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('templatesChanged'));
    }
  }

  /**
   * List all custom templates
   */
  async listCustomTemplates(): Promise<CustomTemplate[]> {
    try {
      await this.init();
      const templates = await this.getAdapter().getAllCustomTemplates();
      return templates.sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime());
    } catch (error) {
      logger.error('[TemplateService] Failed to list templates:', error);
      throw new Error('Failed to list templates');
    }
  }

  /**
   * Delete a custom template
   */
  async deleteCustomTemplate(id: string): Promise<void> {
    try {
      await this.init();
      await this.getAdapter().deleteCustomTemplate(id);

      // Background sync to server
      import('./auto-sync').then(({ autoDeleteTemplate }) => autoDeleteTemplate(id)).catch(() => {});
      this.emitTemplatesChanged();

      logger.info('[TemplateService] Template deleted', { id });
    } catch (error) {
      logger.error('[TemplateService] Failed to delete template:', error);
      throw new Error('Failed to delete template');
    }
  }

  /**
   * Export a custom template back to .oswt file
   */
  async exportTemplateAsFile(template: CustomTemplate): Promise<Blob> {
    try {
      logger.info('[TemplateService] Re-exporting custom template', { id: template.id, name: template.name });

      const zip = new JSZip();

      // Serialise to the SAME shape exportProjectAsTemplate writes, rather than dumping the
      // CustomTemplate verbatim. A CustomTemplate holds the template's semver in `version`
      // and nests its metadata, whereas the .oswt format reserves `version` for the FORMAT
      // version and keeps metadata flat. Writing the object as-is produced an archive that
      // importTemplateFile could not read back (it looks for flat fields), silently losing
      // author, license, tags and thumbnail, and that external validators reject outright.
      const hasFunctions = !!template.backendFeatures && (
        (template.backendFeatures.edgeFunctions?.length ?? 0) +
        (template.backendFeatures.serverFunctions?.length ?? 0) +
        (template.backendFeatures.scheduledFunctions?.length ?? 0)
      ) > 0;
      const templateData = {
        version: hasFunctions ? '2.0.0' : '1.0.0', // Template FORMAT version
        name: template.name,
        description: template.description,
        templateVersion: template.version,
        author: template.metadata?.author,
        authorUrl: template.metadata?.authorUrl,
        license: template.metadata?.license,
        licenseLabel: template.metadata?.licenseLabel,
        licenseDescription: template.metadata?.licenseDescription,
        tags: template.metadata?.tags || [],
        thumbnail: template.metadata?.thumbnail,
        previewImages: template.metadata?.previewImages || [],
        downloadUrl: template.metadata?.downloadUrl,
        runtime: template.runtime,
        directories: template.directories,
        files: encodeTemplateFiles(template.files),
        assets: template.assets ?? [],
        backendFeatures: template.backendFeatures,
      };

      // template.json holds the file contents and is the only entry any reader looks at, here or
      // on the marketplace. Writing each file as its own entry as well just doubled the archive.
      zip.file('template.json', JSON.stringify(templateData, null, 2));

      // DEFLATE, matching exportProjectAsTemplate: file content now travels base64-encoded inside
      // template.json (+33%), so an uncompressed archive can exceed the import size cap that the
      // same template passed before.
      return await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
    } catch (error) {
      logger.error('[TemplateService] Failed to re-export template:', error);
      throw new Error(`Failed to export template: ${error instanceof Error ? error.message : 'Unknown error'}`); // i18n-ignore: logged by every caller, never shown
    }
  }

  /**
   * Validate template metadata
   */
  private validateMetadata(metadata: TemplateMetadata): void {
    if (!metadata.name || metadata.name.length < 1 || metadata.name.length > 50) {
      throw new Error(translator()('templatesUi.nameLength'));
    }

    if (!metadata.description || metadata.description.length < 10 || metadata.description.length > 500) {
      throw new Error(translator()('templatesUi.descLength'));
    }

    if (!metadata.version || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
      throw new Error(translator()('templatesUi.versionFormat'));
    }

    if (metadata.author && metadata.author.length > 50) {
      throw new Error(translator()('templatesUi.errors.authorTooLong', { max: 50 }));
    }

    if (metadata.authorUrl && !this.isValidUrl(metadata.authorUrl)) {
      throw new Error(translator()('templatesUi.errors.authorUrlInvalid'));
    }

    if (!metadata.license) {
      throw new Error(translator()('templatesUi.errors.licenseRequired'));
    }

    if (metadata.tags && metadata.tags.length > 10) {
      throw new Error(translator()('templatesUi.errors.tooManyTags', { max: 10 }));
    }

    if (metadata.thumbnail && metadata.thumbnail.length > MAX_THUMBNAIL_SIZE) {
      throw new Error(translator()('templatesUi.errors.thumbnailTooLarge', { kb: Math.round(MAX_THUMBNAIL_SIZE / 1024) }));
    }

    if (metadata.previewImages && metadata.previewImages.length > MAX_PREVIEW_IMAGES) {
      throw new Error(translator()('templatesUi.errors.tooManyPreviews', { max: MAX_PREVIEW_IMAGES }));
    }

    if (metadata.previewImages) {
      for (const img of metadata.previewImages) {
        if (img.length > MAX_PREVIEW_IMAGE_SIZE) {
          throw new Error(translator()('templatesUi.errors.previewTooLarge', { kb: Math.round(MAX_PREVIEW_IMAGE_SIZE / 1024) }));
        }
      }
    }
  }

  /**
   * Validate template structure after import
   */
  private validateTemplateStructure(data: any): void {
    if (!data.name || typeof data.name !== 'string') {
      throw new Error(translator()('templatesUi.errors.invalidField', { field: 'name' }));
    }

    if (!data.description || typeof data.description !== 'string') {
      throw new Error(translator()('templatesUi.errors.invalidField', { field: 'description' }));
    }

    if (!data.files || !Array.isArray(data.files)) {
      throw new Error(translator()('templatesUi.errors.invalidField', { field: 'files' }));
    }

    if (!data.directories || !Array.isArray(data.directories)) {
      throw new Error(translator()('templatesUi.errors.invalidField', { field: 'directories' }));
    }

    // Validate required fields in files
    for (const file of data.files) {
      if (!file.path || typeof file.path !== 'string') {
        throw new Error(translator()('templatesUi.errors.invalidField', { field: 'files[].path' }));
      }
      if (file.content === undefined) {
        throw new Error(translator()('templatesUi.errors.invalidField', { field: 'files[].content' }));
      }
    }

    // Validate backend features if present (accept legacy "serverFeatures" key too)
    const bf = data.backendFeatures || data.serverFeatures;
    if (bf) {
      if (typeof bf !== 'object') {
        throw new Error(translator()('templatesUi.errors.invalidField', { field: 'backendFeatures' }));
      }
      if (bf.edgeFunctions && !Array.isArray(bf.edgeFunctions)) {
        throw new Error(translator()('templatesUi.errors.invalidField', { field: 'backendFeatures.edgeFunctions' }));
      }
      if (bf.serverFunctions && !Array.isArray(bf.serverFunctions)) {
        throw new Error(translator()('templatesUi.errors.invalidField', { field: 'backendFeatures.serverFunctions' }));
      }
      if (bf.secrets && !Array.isArray(bf.secrets)) {
        throw new Error(translator()('templatesUi.errors.invalidField', { field: 'backendFeatures.secrets' }));
      }
    }
  }

  /**
   * Validate URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}

export const templateService = new TemplateService();
