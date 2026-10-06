export type ProjectRuntime = 'static' | 'handlebars' | 'react' | 'preact' | 'svelte' | 'vue' | 'python' | 'lua';

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  settings: {
    runtime?: ProjectRuntime;  // defaults to 'handlebars' when absent (legacy compat)
    defaultTemplate?: string;
    globalStyles?: string;
    previewEntryPoint?: string;  // defaults to '/index.html' when absent
    databaseSchema?: string;     // project database DDL; see lib/vfs/project-schema.ts
    /** Seeded from the template that made the project, then owned and edited by the project. */
    promptSuggestions?: PromptSuggestion[];
    hfSpace?: {
      repoId: string;        // "<username>/<slug>"
      url: string;           // https://huggingface.co/spaces/<repoId>
      isPrivate: boolean;
      lastPublishedAt: string; // ISO timestamp
    };
  };
  lastSavedCheckpointId?: string | null;
  lastSavedAt?: Date | null;
  previewImage?: string; // base64 data URL of project preview
  previewUpdatedAt?: Date; // when the preview was last captured
  lastSyncedAt?: Date | null; // Server mode: when project was last synced with server
  serverUpdatedAt?: Date | null; // Server mode: cached server's updatedAt timestamp
  syncStatus?: 'synced' | 'syncing' | 'error' | 'never-synced'; // Server mode: current sync state
  /** Last server revision this copy has observed. Server-mode only; ignored in browser mode. */
  revision?: number;
  costTracking?: {
    totalCost: number;
    providerBreakdown: Record<string, {
      totalCost: number;
      tokenUsage: {
        input: number;
        output: number;
        reasoning?: number;
        cached?: number;
      };
      requestCount: number;
      lastUpdated: Date;
    }>;
    sessionHistory?: Array<{
      sessionId: string;
      cost: number;
      provider: string;
      timestamp: Date;
      tokenUsage?: {
        input: number;
        output: number;
      };
      correction?: boolean;
      /** A server run's running token total, so a call that cost nothing still counts once. */
      taskTokens?: number;
    }>;
  };
}

// Deployment - Published version of a project
export interface Deployment {
  // Identity
  id: string;
  projectId: string;
  name: string;
  slug?: string;

  // Publishing configuration
  underConstruction: boolean;
  customDomain?: string;
  headScripts: ScriptConfig[];
  bodyScripts: ScriptConfig[];
  cdnLinks: CdnConfig[];
  analytics: AnalyticsConfig;
  seo: SeoConfig;
  compliance: ComplianceConfig;

  // State tracking
  settingsVersion: number;
  lastPublishedVersion?: number;

  /**
   * Where this deployment is actually reachable, computed by the server.
   *
   * A slug alone does not mean the deployment is served at a subdomain: publish assigns one
   * regardless, and only the Caddy static proxy routes them. The UI must not derive this from
   * `slug` + `window.location.hostname`, which produces a dead `https://{slug}.localhost` on any
   * install without the proxy. Absent on locally-created deployments not yet round-tripped.
   */
  publicUrl?: string;

  // Review mode (private commentable copy)
  review?: ReviewConfig;

  /**
   * Open review threads, attached by the deployments list endpoint for its badge. Server-derived and
   * never stored: absent means none, or that review is off, or that no review copy has been built.
   */
  openReviewThreads?: number;

  // Preview
  previewImage?: string; // base64 data URL of deployment screenshot
  previewUpdatedAt?: Date;

  // Database feature (for edge functions - future feature)
  databaseEnabled?: boolean;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date | null;
}

// Legacy: Publish Settings (kept for backward compatibility)
export interface PublishSettings {
  // Status
  underConstruction: boolean;
  customDomain?: string;

  // Scripts & Resources
  headScripts: ScriptConfig[];
  bodyScripts: ScriptConfig[];
  cdnLinks: CdnConfig[];

  // Analytics
  analytics: AnalyticsConfig;

  // SEO
  seo: SeoConfig;

  // Compliance
  compliance: ComplianceConfig;

  // No `review` here on purpose: PublishSettings is the input to published public output — injected
  // HTML, sitemap, robots — and a review block carries a bcrypt hash. `Deployment.review` is the
  // one field review mode is read from and written to.

  // State tracking
  settingsVersion: number;
  lastPublishedVersion?: number;
}

export interface ReviewConfig {
  enabled: boolean;
  /** bcrypt. Never sent to a client — the API reports `reviewPasswordSet` instead. */
  passwordHash?: string;
  /** ISO timestamp. Absent means no expiry. */
  expiresAt?: string;
  /** Instance or workspace mail must also be configured for anything to send. */
  notifyByEmail?: boolean;
}

export interface ScriptConfig {
  id: string;
  name: string;
  content: string;
  type: 'inline' | 'external';
  src?: string; // URL for external scripts
  async?: boolean;
  defer?: boolean;
  enabled: boolean;
}

export interface CdnConfig {
  id: string;
  name: string;
  url: string;
  type: 'css' | 'js';
  integrity?: string;
  crossorigin?: 'anonymous' | 'use-credentials';
  enabled: boolean;
}

export interface AnalyticsConfig {
  enabled: boolean;
  provider: 'builtin' | 'gtm' | 'ga4' | 'plausible' | 'custom';
  trackingId?: string;
  customScript?: string;
  privacyMode: boolean;

  // Enhanced analytics features (toggleable)
  features?: {
    basicTracking?: boolean;       // Pageviews, referrers (always enabled if analytics on)
    heatmaps?: boolean;             // Click/scroll heatmaps (heavy data)
    sessionRecording?: boolean;     // Journey tracking
    performanceMetrics?: boolean;   // Core Web Vitals, load times
    engagementTracking?: boolean;   // Time on page, scroll depth
    customEvents?: boolean;         // Goal/conversion tracking
  };

  // Data retention settings (in days)
  retention?: {
    pageviews?: number;    // Default: 90 days
    interactions?: number; // Default: 30 days (heatmap data)
    sessions?: number;     // Default: 60 days
  };

  // Analytics token (for secure tracking)
  token?: string;
  tokenGeneratedAt?: string;
}

export interface SeoConfig {
  title?: string;
  description?: string;
  keywords?: string[];
  ogImage?: string;
  ogTitle?: string;
  ogDescription?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  canonical?: string;
  noIndex?: boolean;
  noFollow?: boolean;
}

export interface ComplianceConfig {
  enabled: boolean;
  bannerPosition: 'top' | 'bottom';
  bannerStyle: 'bar' | 'modal' | 'corner';
  message: string;
  acceptButtonText: string;
  declineButtonText: string;
  privacyPolicyUrl?: string;
  cookiePolicyUrl?: string;
  mode: 'opt-in' | 'opt-out';
  blockAnalytics: boolean;
}

export interface VirtualFile {
  id: string;
  projectId: string;
  path: string;
  name: string;
  type: 'html' | 'css' | 'js' | 'json' | 'text' | 'template' | 'image' | 'video' | 'audio' | 'font' | 'binary';
  content: string | ArrayBuffer;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
  metadata: {
    isEntry?: boolean;
    dependencies?: string[];
    isTransient?: boolean;
    isGenerated?: boolean;
    isBuiltIn?: boolean;
    isServerContext?: boolean;
    isReadOnly?: boolean;
  };
}

/**
 * Whether a record is build output injected into a listing rather than a file in storage.
 *
 * `VirtualFileSystem.getAllFilesAndDirectories` adds the records `setGeneratedFile` holds —
 * the bundler's `bundle.js` / `bundle.css` — to its own results whatever it was asked for, so every
 * caller that walks a project's files has to screen them out. `checkpointManager.createCheckpoint`
 * already does exactly this.
 *
 * Test the record, never the path. The injection is skipped when the project genuinely owns that
 * path, so a path test — `vfs.isGeneratedPath(file.path)` — discards the project's real source file
 * instead, and only in a session where the bundler happened to have run.
 */
export function isInjectedGeneratedFile(file: { metadata?: { isGenerated?: boolean } }): boolean {
  return file.metadata?.isGenerated === true;
}

export interface FileTreeNode {
  id: string;
  projectId: string;
  path: string;
  name: string;
  type: 'directory' | 'file';
  parentPath: string | null;
  isExpanded?: boolean;
  children?: string[];
  metadata?: Record<string, unknown>;
}

export interface FileOperation {
  projectId: string;
  path: string;
  content?: string | ArrayBuffer;
  newPath?: string;
}

export type FileType = VirtualFile['type'];

export const MIME_TYPES: Record<FileType, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  json: 'application/json',
  text: 'text/plain',
  template: 'text/x-handlebars-template',
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  font: 'font/*',
  binary: 'application/octet-stream'
};

export const SUPPORTED_EXTENSIONS = {
  html: ['html', 'htm'],
  css: ['css'],
  js: ['js', 'mjs', 'jsx', 'ts', 'tsx', 'svelte', 'vue', 'py', 'lua'],
  json: ['json'],
  text: [
    'txt', 'md', 'xml', 'svg',
    // Formats with no runtime here, which is not the same as no support: the agent edits them,
    // they survive a download, and they run wherever you take them. A .php moved to a WordPress
    // install is the motivating case.
    'php', 'phtml', 'ejs', 'erb', 'twig', 'njk', 'liquid', 'mustache', 'astro',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'jsonc', 'json5',
    'sql', 'csv', 'tsv', 'graphql', 'gql',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1', 'mk',
    'java', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'kt', 'swift', 'pl', 'r', 'scala', 'dart',
    'scss', 'sass', 'less', 'styl',
    'rst', 'adoc', 'tex', 'log', 'diff', 'patch',
    'gitignore', 'gitattributes', 'dockerignore', 'editorconfig', 'npmrc', 'nvmrc', 'example',
  ],
  template: ['hbs', 'handlebars'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'],
  video: ['mp4', 'webm', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'ogg', 'opus'],
  font: ['woff', 'woff2', 'ttf', 'otf', 'eot'],
  binary: ['pdf', 'zip', 'wasm']
};

export const FILE_SIZE_LIMITS = {
  text: 5 * 1024 * 1024,
  html: 5 * 1024 * 1024,
  css: 5 * 1024 * 1024,
  js: 5 * 1024 * 1024,
  json: 5 * 1024 * 1024,
  template: 5 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  font: 5 * 1024 * 1024,
  binary: 10 * 1024 * 1024
};

/** Extensionless files that are text. Matched on the whole filename, lowercased. */
export const TEXT_FILENAMES: ReadonlySet<string> = new Set([
  'dockerfile', 'containerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'brewfile',
  'license', 'licence', 'notice', 'authors', 'contributors', 'changelog', 'readme', 'codeowners',
  'jenkinsfile', 'vagrantfile', 'caddyfile', 'justfile',
]);

/**
 * Coarse category for a path, used for presentation: which icon to show, which viewer to open,
 * which size cap to apply. It does NOT decide how content is stored or transported — that follows
 * the content itself, because an extension is a guess and a wrong guess corrupted the file.
 *
 * Unknown extensions are 'binary', not 'text'. Reading unknown bytes as text destroys them;
 * treating text as bytes only costs you the editor. The safe default is the one that preserves
 * data, and it means a format nobody enumerated — .glb, .wasm, whatever comes next — just works.
 */
export function getFileTypeFromPath(path: string): FileType {
  const name = path.split('/').pop()?.toLowerCase() || '';

  // Text files that carry no extension. `'Dockerfile'.split('.').pop()` returns the whole name, so
  // without this they fall through to 'binary' and get read as bytes.
  if (TEXT_FILENAMES.has(name)) return 'text';

  const ext = path.split('.').pop()?.toLowerCase() || '';

  for (const [type, extensions] of Object.entries(SUPPORTED_EXTENSIONS)) {
    if (extensions.includes(ext)) {
      return type as FileType;
    }
  }

  return 'binary';
}

/**
 * Whether a path should be read and held as text. The inverse of the old allow-list: a short,
 * closed set of genuinely-textual formats, with everything else treated as bytes.
 */
export function isTextExtension(path: string): boolean {
  return !isBinaryFileType(getFileTypeFromPath(path));
}

export function getSpecificMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  
  const mimeMap: Record<string, string> = {
    'html': 'text/html',
    'htm': 'text/html',
    
    'css': 'text/css',
    
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'jsx': 'application/javascript',
    'ts': 'application/typescript',
    'tsx': 'application/typescript',
    'svelte': 'text/x-svelte',
    'vue': 'text/x-vue',
    'py': 'text/x-python',
    'lua': 'text/x-lua',

    'json': 'application/json',
    
    'txt': 'text/plain',
    'md': 'text/markdown',
    'xml': 'application/xml',
    'svg': 'image/svg+xml',
    
    'hbs': 'text/x-handlebars-template',
    'handlebars': 'text/x-handlebars-template',
    
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'ogv': 'video/ogg',

    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'oga': 'audio/ogg',
    'ogg': 'audio/ogg',
    'opus': 'audio/opus',

    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'eot': 'application/vnd.ms-fontobject',

    'pdf': 'application/pdf',
    'zip': 'application/zip',
    'wasm': 'application/wasm'
  };
  
  return mimeMap[ext || ''] || 'application/octet-stream';
}

/**
 * Whether a file of this type holds bytes rather than text.
 *
 * One place to ask, so a new binary category cannot be added and then silently mishandled by a
 * caller that happened to enumerate types by hand — which is how audio, fonts and PDFs ended up
 * being treated as text everywhere.
 */
const BINARY_FILE_TYPES: ReadonlySet<FileType> = new Set<FileType>([
  'image', 'video', 'audio', 'font', 'binary',
]);

function isBinaryFileType(type: FileType): boolean {
  return BINARY_FILE_TYPES.has(type);
}

export function getMimeType(type: FileType): string {
  return MIME_TYPES[type];
}

// Template System Types

/**
 * What someone is setting out to make, which is how the template list is organised.
 *
 * Deliberately not the runtime. A Static project can be any of these, and someone who wants a wiki
 * does not start by deciding between Handlebars and Preact. The runtime stays on the row as a badge
 * and stays searchable, but it no longer decides where a template appears.
 */
export type TemplateIntent = 'starter' | 'website' | 'workspace' | 'app' | 'project-kit';

/**
 * A first thing to ask the assistant, offered above the composer on an empty chat.
 *
 * Belongs to the project, not to the template: a template seeds these when the project is created
 * and has no say afterwards, so they can be edited, added to and removed like anything else in the
 * project. A template that ships none leaves the project with the generic starters.
 */
export interface PromptSuggestion {
  id: string;
  /** What the button says. Short enough to sit on one line. */
  label: string;
  /** What lands in the composer. Written as an instruction, not a topic. */
  prompt: string;
  /**
   * Preview paths this suggestion is offered on, as globs. Absent or empty means every page.
   * Presence of the field is what the editor's toggle reflects.
   */
  paths?: string[];
}

export interface CustomTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  files: Array<{path: string; content: string | ArrayBuffer}>;
  directories: string[];
  assets?: Array<{
    filename: string;
    path: string;
  }>;
  metadata: {
    author?: string;
    authorUrl?: string;
    license: string;              // Required, defaults to "personal"
    licenseLabel?: string;        // For custom licenses
    licenseDescription?: string;  // For custom licenses
    tags?: string[];
    thumbnail?: string;           // Base64 data URL
    previewImages?: string[];     // Array of base64 images
    downloadUrl?: string;
    /** Optional. Templates without one are listed together rather than guessed at. */
    intent?: TemplateIntent;
    /** Seeds `Project.settings.promptSuggestions` when a project is made from this template. */
    promptSuggestions?: PromptSuggestion[];
  };
  runtime?: ProjectRuntime;
  importedAt: Date;
  updatedAt?: Date;
  backendFeatures?: BackendFeatures;
}

export interface LicenseOption {
  value: string;
  label: string;
  description: string;
}

// Edge Functions Types
export interface EdgeFunction {
  id: string;
  projectId: string;
  name: string;          // URL-safe name (e.g., "products", "get-user")
  description?: string;
  code: string;          // JavaScript code
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'ANY';
  enabled: boolean;
  timeoutMs: number;     // Default 5000, max 30000
  createdAt: Date;
  updatedAt: Date;
}

export interface FunctionLog {
  id: number;
  functionId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  error?: string;
  timestamp: Date;
}

// Database Schema Types (for SQL schema viewer)
export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
  isSystemTable: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string;
}

// Server Functions (callable from edge functions)
export interface ServerFunction {
  id: string;
  projectId: string;
  name: string;          // Function name (e.g., 'validateAuth', 'formatPrice')
  description?: string;
  code: string;          // JavaScript function body (receives args, has db/fetch access)
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Secrets (encrypted key-value storage for edge functions)
export interface Secret {
  id: string;
  projectId: string;
  name: string;          // e.g., 'STRIPE_API_KEY', 'SENDGRID_KEY'
  description?: string;
  hasValue: boolean;     // true if user has set a value, false if placeholder
  value?: string;        // Cleartext value for project-level storage (never sent to client in API responses)
  createdAt: Date;
  updatedAt: Date;
}

// Scheduled Functions (cron-triggered edge function execution)
export interface ScheduledFunction {
  id: string;
  projectId: string;
  name: string;                          // URL-safe: lowercase, numbers, hyphens
  description?: string;
  functionId: string;                     // FK → edge_functions.id
  cronExpression: string;                 // e.g. '0 8 * * *'
  timezone: string;                       // e.g. 'UTC', 'America/New_York'
  config: Record<string, unknown>;        // Custom body passed to edge function
  enabled: boolean;
  lastRunAt?: Date;
  nextRunAt?: Date;
  lastStatus?: 'success' | 'error';
  lastError?: string;
  lastDurationMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

// Backend Features (for templates that include backend infrastructure)
export interface BackendFeatures {
  edgeFunctions?: Array<{
    name: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'ANY';
    code: string;
    description?: string;
    enabled?: boolean;
    timeoutMs?: number;
  }>;
  serverFunctions?: Array<{
    name: string;
    code: string;
    description?: string;
    enabled?: boolean;
  }>;
  secrets?: Array<{
    name: string;
    description?: string;
  }>;
  scheduledFunctions?: Array<{
    name: string;
    functionName: string;   // name of the edge function to link
    cronExpression: string;
    timezone?: string;
    description?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }>;
  databaseSchema?: string;
  deploymentSettings?: Record<string, unknown>;
}

export const LICENSE_OPTIONS: LicenseOption[] = [
  {
    value: 'personal',
    label: 'Personal Use Only',
    description: 'Cannot be resold or used commercially'
  },
  {
    value: 'commercial',
    label: 'Commercial Use',
    description: 'Can be used in commercial projects, cannot resell template'
  },
  {
    value: 'mit',
    label: 'MIT License',
    description: 'Use freely, must include copyright notice'
  },
  {
    value: 'apache-2.0',
    label: 'Apache 2.0',
    description: 'Similar to MIT, with patent protection'
  },
  {
    value: 'gpl-3.0',
    label: 'GPL 3.0',
    description: 'Open source, derivatives must also be GPL'
  },
  {
    value: 'bsd-3-clause',
    label: 'BSD 3-Clause',
    description: 'Permissive, cannot use author name for promotion'
  },
  {
    value: 'cc-by-4.0',
    label: 'CC BY 4.0',
    description: 'Free use with attribution'
  },
  {
    value: 'cc-by-sa-4.0',
    label: 'CC BY-SA 4.0',
    description: 'Free use with attribution, share-alike'
  },
  {
    value: 'cc-by-nc-4.0',
    label: 'CC BY-NC 4.0',
    description: 'Free for non-commercial use with attribution'
  },
  {
    value: 'unlicense',
    label: 'Unlicense (Public Domain)',
    description: 'No restrictions, completely free to use'
  },
  {
    value: 'all-rights-reserved',
    label: 'All Rights Reserved',
    description: 'Most restrictive, requires explicit permission'
  },
  {
    value: 'custom',
    label: 'Custom License',
    description: 'Specify your own terms'
  }
];
