import { Project, VirtualFile, FileTreeNode, CustomTemplate, PublishSettings, Deployment, EdgeFunction, ServerFunction, Secret, ScheduledFunction } from '../types';
import { Skill } from '../skills/types';

/**
 * Storage adapter interface
 *
 * Abstracts storage operations to support multiple backends:
 * - IndexedDB (browser mode - local storage)
 * - SQLite (Server mode - server persistence)
 *
 * Note: Checkpoints and conversations are NOT part of this interface.
 * They remain browser-only in IndexedDB regardless of mode.
 */
export interface StorageAdapter {
  /**
   * Initialize the storage adapter
   * Sets up database connections, runs migrations, etc.
   */
  init(): Promise<void>;

  /**
   * Close the storage adapter
   * Cleanup resources, close connections
   */
  close?(): Promise<void>;

  // ============================================
  // Projects
  // ============================================

  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project | null>;
  updateProject(project: Project): Promise<void>;
  /** Server-owned monotonic revision. IndexedDB working copies omit this. */
  bumpRevision?(projectId: string, expected: number): number | null;
  deleteProject(id: string): Promise<void>;
  listProjects(fields?: string[]): Promise<Project[]>;
  updateProjectPublishSettings?(projectId: string, settings: PublishSettings): Promise<void>;

  // ============================================
  // Files
  // ============================================

  createFile(file: VirtualFile): Promise<void>;
  getFile(projectId: string, path: string): Promise<VirtualFile | null>;
  updateFile(file: VirtualFile): Promise<void>;
  deleteFile(projectId: string, path: string): Promise<void>;
  listFiles(projectId: string): Promise<VirtualFile[]>;
  deleteProjectFiles(projectId: string): Promise<void>;

  /**
   * Directory this adapter keeps its files beside, when it keeps any on disk.
   *
   * Binary content lives in a content-addressed store there rather than in the database, so
   * publishing can hardlink a file into a deployment instead of writing a second copy of it.
   * Undefined for an adapter with no such directory, which is the browser's IndexedDB and an
   * in-memory database; those callers fall back to writing the bytes.
   */
  getBaseDir?(): string | undefined;

  /** Every blob hash a file row still refers to. The blob sweep removes what this omits. */
  listReferencedBlobHashes?(): Promise<string[]>;
  /** A project's file paths, without reading the files. Absent: `listFiles` stands in. */
  listFilePaths?(projectId: string): Promise<string[]>;

  // ============================================
  // File Tree
  // ============================================

  createTreeNode(node: FileTreeNode): Promise<void>;
  getTreeNode(projectId: string, path: string): Promise<FileTreeNode | null>;
  updateTreeNode(node: FileTreeNode): Promise<void>;
  deleteTreeNode(projectId: string, path: string): Promise<void>;
  getChildNodes(projectId: string, parentPath: string | null): Promise<FileTreeNode[]>;
  getAllTreeNodes(projectId: string): Promise<FileTreeNode[]>;

  // ============================================
  // Custom Templates
  // ============================================

  saveCustomTemplate(template: CustomTemplate): Promise<void>;
  getCustomTemplate(id: string): Promise<CustomTemplate | null>;
  getAllCustomTemplates(): Promise<CustomTemplate[]>;
  deleteCustomTemplate(id: string): Promise<void>;

  // ============================================
  // Custom Skills
  // ============================================

  createSkill(skill: Omit<Skill, 'isBuiltIn'>): Promise<void>;
  getSkill(id: string): Promise<Skill | null>;
  updateSkill(skill: Omit<Skill, 'isBuiltIn'>): Promise<void>;
  deleteSkill(id: string): Promise<void>;
  getAllSkills(): Promise<Skill[]>;

  // ============================================
  // Deployments (Server Mode Only)
  // ============================================

  createDeployment?(deployment: Deployment): Promise<void>;
  getDeployment?(deploymentId: string): Promise<Deployment | null>;
  getDeploymentBySlug?(slug: string): Promise<Deployment | null>;
  listDeployments?(): Promise<Deployment[]>;
  listDeploymentsByProject?(projectId: string): Promise<Deployment[]>;
  updateDeployment?(deployment: Deployment): Promise<void>;
  deleteDeployment?(deploymentId: string): Promise<void>;

  // ============================================
  // Backend Features (Project-scoped)
  // ============================================

  createEdgeFunction?(fn: EdgeFunction): Promise<void>;
  getEdgeFunction?(id: string): Promise<EdgeFunction | null>;
  listEdgeFunctions?(projectId: string): Promise<EdgeFunction[]>;
  updateEdgeFunction?(fn: EdgeFunction): Promise<void>;
  deleteEdgeFunction?(id: string): Promise<void>;

  createServerFunction?(fn: ServerFunction): Promise<void>;
  getServerFunction?(id: string): Promise<ServerFunction | null>;
  listServerFunctions?(projectId: string): Promise<ServerFunction[]>;
  updateServerFunction?(fn: ServerFunction): Promise<void>;
  deleteServerFunction?(id: string): Promise<void>;

  createSecret?(secret: Secret): Promise<void>;
  getSecret?(id: string): Promise<Secret | null>;
  listSecrets?(projectId: string): Promise<Secret[]>;
  updateSecret?(secret: Secret): Promise<void>;
  deleteSecret?(id: string): Promise<void>;

  createScheduledFunction?(fn: ScheduledFunction): Promise<void>;
  getScheduledFunction?(id: string): Promise<ScheduledFunction | null>;
  listScheduledFunctions?(projectId: string): Promise<ScheduledFunction[]>;
  updateScheduledFunction?(fn: ScheduledFunction): Promise<void>;
  deleteScheduledFunction?(id: string): Promise<void>;
}
