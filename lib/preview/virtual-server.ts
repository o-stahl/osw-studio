import { VirtualFileSystem } from '../vfs';
import { FALLBACK_RUNTIME } from '@/lib/vfs/project-settings';
import { VirtualFile, ProjectRuntime } from '../vfs/types';
import { ProcessedFile, Route, CompiledProject } from './types';
import Handlebars from 'handlebars';
import { logger } from '@/lib/utils';
import { beginCompilation, pushCompileError, commitCompilation } from './compile-errors';
import { isRuntimeBundled } from '@/lib/runtimes/registry';
import { injectProvenance } from './provenance';

export class VirtualServer {
  private vfs: VirtualFileSystem;
  private projectId: string;
  private deploymentId?: string;
  private baseUrl: string;
  private blobUrls: Map<string, string> = new Map();
  private fileHashes: Map<string, string> = new Map();
  private handlebars: typeof Handlebars;
  private templateCache: Map<string, HandlebarsTemplateDelegate> = new Map();
  private partialsRegistered: boolean = false;
  private entryPoint: string;
  private runtime: ProjectRuntime;
  private minify: boolean;
  private provenance: boolean;

  constructor(vfs: VirtualFileSystem, projectId: string, opts?: { deploymentId?: string; entryPoint?: string; runtime?: ProjectRuntime; minify?: boolean; provenance?: boolean }) {
    this.vfs = vfs;
    this.projectId = projectId;
    this.deploymentId = opts?.deploymentId;
    this.entryPoint = opts?.entryPoint || '/index.html';
    // FALLBACK_RUNTIME rather than a literal: the features gated on the runtime answer the absent
    // case from the same constant, so a project with none cannot be rendered as one thing and
    // reasoned about as another.
    this.runtime = opts?.runtime || FALLBACK_RUNTIME;
    // Off unless a caller asks: the editor preview wants readable output, and
    // only the paths that produce something a visitor downloads turn it on.
    this.minify = opts?.minify === true;
    // Preview-only element provenance. Off unless a caller asks: this instrumentation must never
    // reach published output, and the publish, export and thumbnail paths all construct a
    // VirtualServer in the same browser tab as the preview.
    this.provenance = opts?.provenance === true;
    this.baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

    // Initialize Handlebars instance
    this.handlebars = Handlebars.create();
    this.registerHelpers();
  }

  private registerHelpers(): void {
    // Register common comparison helpers that LLMs expect
    this.handlebars.registerHelper('eq', (a: any, b: any) => a === b);
    this.handlebars.registerHelper('ne', (a: any, b: any) => a !== b);
    this.handlebars.registerHelper('lt', (a: any, b: any) => a < b);
    this.handlebars.registerHelper('gt', (a: any, b: any) => a > b);
    this.handlebars.registerHelper('lte', (a: any, b: any) => a <= b);
    this.handlebars.registerHelper('gte', (a: any, b: any) => a >= b);
    
    // Logical helpers
    this.handlebars.registerHelper('and', (...helperArgs: unknown[]) => {
      // Last argument is the Handlebars options object
      return helperArgs.slice(0, -1).every((arg) => arg);
    });
    this.handlebars.registerHelper('or', (...helperArgs: unknown[]) => {
      return helperArgs.slice(0, -1).some((arg) => arg);
    });
    this.handlebars.registerHelper('not', (value: any) => !value);
    
    // Math helpers
    this.handlebars.registerHelper('add', (a: number, b: number) => a + b);
    this.handlebars.registerHelper('subtract', (a: number, b: number) => a - b);
    this.handlebars.registerHelper('multiply', (a: number, b: number) => a * b);
    this.handlebars.registerHelper('divide', (a: number, b: number) => a / b);
    
    // String helpers
    this.handlebars.registerHelper('uppercase', (str: string) => str?.toUpperCase());
    this.handlebars.registerHelper('lowercase', (str: string) => str?.toLowerCase());
    this.handlebars.registerHelper('concat', (...helperArgs: unknown[]) => {
      return helperArgs.slice(0, -1).join('');
    });
    
    // Utility helpers
    this.handlebars.registerHelper('json', (context: any) => JSON.stringify(context, null, 2));
    this.handlebars.registerHelper('formatDate', (date: Date | string) => {
      const d = new Date(date);
      return d.toLocaleDateString();
    });

    // Array helpers
    this.handlebars.registerHelper('limit', (array: any[], max: number) =>
      array?.slice(0, max)
    );

    // Repeat helpers - repeat content N times (times, repeat, for are all equivalent)
    const repeatHelper = function(this: any, n: number, options: Handlebars.HelperOptions) {
      let result = '';
      for (let i = 0; i < n; i++) {
        result += options.fn({ index: i, first: i === 0, last: i === n - 1 });
      }
      return result;
    };
    this.handlebars.registerHelper('times', repeatHelper);
    this.handlebars.registerHelper('repeat', repeatHelper);
    this.handlebars.registerHelper('for', repeatHelper);
  }

  private async registerPartials(): Promise<void> {
    if (this.partialsRegistered) {
      return;
    }

    try {
      // Get ALL files in the project
      const allItems = await this.vfs.getAllFilesAndDirectories(this.projectId);

      // Filter for files only (not directories) and handlebars files in /templates directory
      const templateFiles = allItems.filter((item): item is VirtualFile =>
        'content' in item &&
        item.path.startsWith('/templates/') &&
        (item.path.endsWith('.hbs') || item.path.endsWith('.handlebars'))
      );

      for (const file of templateFiles) {
        const raw = file.content as string;
        // A partial is registered from its own file's raw text, which is what makes an element
        // inside /templates/navigation.hbs name that file rather than the page that included it.
        // Injected once per file, above the registration calls: the same string is registered
        // under up to three names below. The runtime guard avoids scanning every /templates/*.hbs
        // for a `static` project, where partials are never used.
        const content = this.provenance && this.runtime === 'handlebars'
          ? injectProvenance(raw, file.path)
          : raw;

        // Extract path relative to /templates/
        // e.g., /templates/components/header.hbs → components/header
        const relativePath = file.path
          .replace(/^\/templates\//, '')
          .replace(/\.hbs$/, '')
          .replace(/\.handlebars$/, '');

        // Register with multiple names for maximum compatibility:

        // 1. Full relative path: components/header
        this.handlebars.registerPartial(relativePath, content);

        // 2. Just filename: header (for backwards compatibility)
        const filename = relativePath.split('/').pop();
        if (filename) {
          this.handlebars.registerPartial(filename, content);
        }

        // 3. Dash-separated variant: components-header (some LLMs prefer this)
        if (relativePath.includes('/')) {
          const dashName = relativePath.replace(/\//g, '-');
          this.handlebars.registerPartial(dashName, content);
        }
      }

      this.partialsRegistered = true;
    } catch (error) {
      // Templates directory might not exist, which is fine
    }
  }

  private async compileTemplate(templatePath: string, context: any = {}): Promise<string> {
    // Check cache first
    let compiled = this.templateCache.get(templatePath);
    
    if (!compiled) {
      try {
        const file = await this.vfs.readFile(this.projectId, templatePath);
        const templateContent = file.content as string;
        compiled = this.handlebars.compile(templateContent);
        this.templateCache.set(templatePath, compiled);
      } catch (error) {
        logger.error(`Failed to compile template ${templatePath}:`, error);
        return '';
      }
    }
    
    return compiled(context);
  }

  async compileProject(incrementalUpdate = false): Promise<CompiledProject> {
    beginCompilation();
    try {
    // Clear any stale generated files from previous compiles (e.g. switching from bundled to non-bundled runtime)
    this.vfs.clearGeneratedFiles();

    // Register partials before processing
    await this.registerPartials();

    let files = await this.vfs.listDirectory(this.projectId, '/');
    files = await this.runBundleStep(files);

    const oldBlobUrls = new Map(this.blobUrls);
    const newBlobUrls = new Map<string, string>();
    const rawProcessedFiles: ProcessedFile[] = [];
    // Built once and handed to every page. Each page used to read the project itself to answer
    // whether a referenced path exists, which is a full content-bearing read per page.
    const projectPaths: ReadonlySet<string> = new Set(files.map((file) => file.path));
    
    // First pass: Create blob URLs for all non-HTML files (images, JS, etc.)
    for (const file of files) {
      // Skip template files and HTML files in first pass
      if (file.type === 'template' || file.type === 'html' || file.type === 'css') {
        continue;
      }

      // Content is passed through as-is, bytes or text alike.
      const processedFile: ProcessedFile = {
        path: file.path,
        content: file.content,
        mimeType: file.mimeType
      };
      
      const contentHash = this.hashContent(processedFile.content);
      const previousHash = this.fileHashes.get(processedFile.path);
      
      if (incrementalUpdate && previousHash === contentHash && oldBlobUrls.has(processedFile.path)) {
        const existingUrl = oldBlobUrls.get(processedFile.path)!;
        newBlobUrls.set(processedFile.path, existingUrl);
        processedFile.blobUrl = existingUrl;
        oldBlobUrls.delete(processedFile.path);
      } else {
        const blob = new Blob([processedFile.content], { type: processedFile.mimeType });
        const blobUrl = URL.createObjectURL(blob);
        newBlobUrls.set(processedFile.path, blobUrl);
        processedFile.blobUrl = blobUrl;
        this.fileHashes.set(processedFile.path, contentHash);
      }
      
      rawProcessedFiles.push(processedFile);
    }
    
    // Second pass: Process HTML files with available blob URLs
    for (const file of files) {
      if (file.type !== 'html') {
        continue;
      }
      
      const processedFile = await this.processHTML(file, newBlobUrls, projectPaths);
      
      const contentHash = this.hashContent(processedFile.content);
      const previousHash = this.fileHashes.get(processedFile.path);
      
      if (incrementalUpdate && previousHash === contentHash && oldBlobUrls.has(processedFile.path)) {
        const existingUrl = oldBlobUrls.get(processedFile.path)!;
        newBlobUrls.set(processedFile.path, existingUrl);
        processedFile.blobUrl = existingUrl;
        oldBlobUrls.delete(processedFile.path);
      } else {
        const blob = new Blob([processedFile.content], { type: processedFile.mimeType });
        const blobUrl = URL.createObjectURL(blob);
        newBlobUrls.set(processedFile.path, blobUrl);
        processedFile.blobUrl = blobUrl;
        this.fileHashes.set(processedFile.path, contentHash);
      }
      
      rawProcessedFiles.push(processedFile);
    }
    
    const processedFiles = [...rawProcessedFiles];
    for (const file of files) {
      if (file.type === 'css') {
        const processedFile = await this.processCSS(file, newBlobUrls);
        
        const contentHash = this.hashContent(processedFile.content);
        const previousHash = this.fileHashes.get(processedFile.path);
        
        if (incrementalUpdate && previousHash === contentHash && oldBlobUrls.has(processedFile.path)) {
          const existingUrl = oldBlobUrls.get(processedFile.path)!;
          newBlobUrls.set(processedFile.path, existingUrl);
          processedFile.blobUrl = existingUrl;
          oldBlobUrls.delete(processedFile.path);
        } else {
          const blob = new Blob([processedFile.content], { type: processedFile.mimeType });
          const blobUrl = URL.createObjectURL(blob);
          newBlobUrls.set(processedFile.path, blobUrl);
          processedFile.blobUrl = blobUrl;
          this.fileHashes.set(processedFile.path, contentHash);
        }
        
        processedFiles.push(processedFile);
      }
    }
    
    const routes = this.generateRoutes(files);
    
    if (incrementalUpdate) {
      for (const [, url] of oldBlobUrls) {
        URL.revokeObjectURL(url);
      }
    } else if (!incrementalUpdate) {
      this.cleanupBlobUrls();
    }
    
    this.blobUrls = newBlobUrls;

    return {
      entryPoint: this.entryPoint,
      files: processedFiles,
      routes,
      blobUrls: this.blobUrls
    };

    } finally {
      commitCompilation();
    }
  }
  
  private async runBundleStep(files: VirtualFile[]): Promise<VirtualFile[]> {
    if (!isRuntimeBundled(this.runtime)) return files;

    // Pre-compiled bundle from client (synced before publish) — skip server-side bundling.
    // Only skip if bundle.js exists AND no source files are present (source files
    // mean we should rebundle, even if a stale bundle.js was restored from checkpoint).
    const hasBundle = files.some(f => f.path === '/bundle.js');
    const hasSourceFiles = files.some(f => /\.(tsx|ts|jsx|svelte|vue)$/.test(f.path) && !f.path.startsWith('/.'));
    if (hasBundle && !hasSourceFiles) {
      return files.filter(f => !/\.(tsx|ts|jsx|svelte|vue)$/.test(f.path));
    }

    // Lazy-import to avoid loading esbuild for non-bundleable projects
    const { detectBundleEntryPoint, bundleProject, isBundleableSource } =
      await import('./esbuild-bundler');

    const entryPoint = detectBundleEntryPoint(files);
    if (!entryPoint) return files;

    const result = await bundleProject({ files, entryPoint, runtime: this.runtime, minify: this.minify });

    for (const err of result.errors) {
      const fileMatch = err.match(/^\[esbuild\] (\/[^:]+)/);
      pushCompileError(fileMatch ? fileMatch[1] : entryPoint, err);
    }

    if (result.errors.length > 0) {
      // Bundle failed — clear any previous generated files and return unmodified
      this.vfs.clearGeneratedFiles();
      return files;
    }

    // Filter out source files that were compiled into the bundle
    const filtered = files.filter(f => !isBundleableSource(f.path));

    // Inject synthetic bundle.js
    const now = new Date();
    filtered.push({
      id: '__bundle_js__',
      projectId: this.projectId,
      path: '/bundle.js',
      name: 'bundle.js',
      type: 'js',
      content: result.js,
      mimeType: 'application/javascript',
      size: result.js.length,
      createdAt: now,
      updatedAt: now,
      metadata: { isTransient: true },
    });

    // Inject synthetic bundle.css (empty if esbuild produced no CSS, to avoid 404s
    // from templates that reference /bundle.css unconditionally)
    const cssContent = result.css || '';
    filtered.push({
      id: '__bundle_css__',
      projectId: this.projectId,
      path: '/bundle.css',
      name: 'bundle.css',
      type: 'css',
      content: cssContent,
      mimeType: 'text/css',
      size: cssContent.length,
      createdAt: now,
      updatedAt: now,
      metadata: { isTransient: true },
    });

    // Publish bundle files to VFS so they appear in file explorer and are readable
    this.vfs.setGeneratedFile('/bundle.js', result.js, 'application/javascript');
    this.vfs.setGeneratedFile('/bundle.css', cssContent, 'text/css');

    return filtered;
  }

  private hashContent(content: string | ArrayBuffer): string {
    let hash = 0;
    
    if (content instanceof ArrayBuffer) {
      const view = new Uint8Array(content);
      for (let i = 0; i < Math.min(view.length, 10000); i++) {
        hash = ((hash << 5) - hash) + view[i];
        hash = hash & hash;
      }
    } else {
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
    }
    
    return hash.toString(36);
  }

  private async processHTML(
    file: VirtualFile,
    blobUrls?: Map<string, string>,
    projectPaths?: ReadonlySet<string>
  ): Promise<ProcessedFile> {
    let content = file.content as string;

    // The single shared HTML path for both runtimes, and so the only injection point for page
    // content. For `handlebars` the injected string is what gets compiled below, so a `{{#each}}`
    // copies the attribute onto every rendered instance and the offsets stay the template's.
    // Injecting again inside processHandlebarsTemplates would double-tag every element, the second
    // attribute carrying offsets shifted by this pass.
    if (this.provenance) {
      content = injectProvenance(content, file.path);
    }

    // Only run Handlebars for the handlebars runtime; skip /output/ files (script-generated)
    if (this.runtime === 'handlebars' && !file.path.startsWith('/output/')) {
      content = await this.processHandlebarsTemplates(content, file.path);
    }

    // Then process internal references with available blob URLs
    content = await this.processInternalReferences(content, blobUrls, projectPaths);
    
    // Inject VFS asset interceptor for transparent HTTP requests
    // Always inject the interceptor, even if no blob URLs yet (for future dynamic loading)
    const deploymentIdForScript = this.deploymentId || '';
    const vfsScript = `<script>
// VFS Asset Interceptor - Auto-injected by OSW Studio
(function() {
  const deploymentId = ${JSON.stringify(deploymentIdForScript)};

  // Edge functions are called by the host on the preview's behalf (lib/preview/function-proxy.ts):
  // the preview runs on an opaque origin, and the function route answers no other origin.
  const hostCalls = {};
  let hostCallSeq = 0;
  // A host that never answers (it reloaded, or was closed) fails the call rather than leaving it
  // pending; well past any function's own time limit.
  const HOST_CALL_TIMEOUT_MS = 120000;
  window.addEventListener('message', function(e) {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.type !== 'preview:function-response' || !hostCalls[d.id]) return;
    const call = hostCalls[d.id];
    call.done();
    if (d.error) call.reject(new TypeError('Failed to fetch: ' + d.error));
    else call.resolve(new Response(d.body, { status: d.status, statusText: d.statusText, headers: d.headers }));
  });
  function hostFetch(apiPath, input, init) {
    let request;
    try {
      request = input instanceof Request ? new Request(input, init) : new Request('http://preview.invalid' + apiPath, init);
    } catch (err) {
      return Promise.reject(err);
    }
    const signal = request.signal;
    const aborted = function() { return new DOMException('The operation was aborted.', 'AbortError'); };
    if (signal && signal.aborted) return Promise.reject(aborted());
    const method = request.method.toUpperCase();
    const read = method === 'GET' || method === 'HEAD' ? Promise.resolve(null) : request.arrayBuffer();
    return read.then(function(body) {
      return new Promise(function(resolve, reject) {
        const id = ++hostCallSeq;
        const onAbort = function() { done(); reject(aborted()); };
        const timer = setTimeout(function() { done(); reject(new TypeError('Failed to fetch: no answer')); }, HOST_CALL_TIMEOUT_MS);
        function done() {
          delete hostCalls[id];
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
        if (signal) signal.addEventListener('abort', onAbort);
        hostCalls[id] = { resolve: resolve, reject: reject, done: done };
        const headers = [];
        request.headers.forEach(function(value, name) { headers.push([name, value]); });
        window.parent.postMessage({ type: 'preview:function-call', id: id, path: apiPath, method: method, headers: headers, body: body }, '*', body ? [body] : []);
      });
    });
  }

  // Helper function to resolve VFS paths to blob URLs
  function resolveVfsUrl(url) {
    if (!url || typeof url !== 'string') return url;
    // The map is injected by whoever renders the page, not baked in here: it is the same map for
    // every page, so a project of several hundred pages carried several hundred copies of it.
    // Both renderers supply it — the preview host and the thumbnail capture — and each supplies
    // the complete one, where a baked copy could only hold the files processed before its page.
    try {
      if (window.__oswVfsBlobUrls && window.__oswVfsBlobUrls[url]) {
        return window.__oswVfsBlobUrls[url];
      }
    } catch {}
    return url;
  }

  // Helper function to check if a URL looks like an edge function call
  function isEdgeFunctionUrl(url) {
    if (!url || typeof url !== 'string' || !deploymentId) return false;
    // Skip external URLs, blob URLs, data URLs, and hash-only URLs
    if (url.startsWith('http://') || url.startsWith('https://') ||
        url.startsWith('blob:') || url.startsWith('data:') ||
        url.startsWith('//') || url.startsWith('#')) {
      return false;
    }
    // Skip if already an API path
    if (url.startsWith('/api/')) return false;
    // Skip if it has a file extension (likely an asset)
    const pathWithoutQuery = url.split('?')[0].split('#')[0];
    const lastSegment = pathWithoutQuery.split('/').pop() || '';
    if (lastSegment.includes('.')) return false;
    // This looks like an edge function path
    return true;
  }

  // Helper function to convert an edge function URL to the API endpoint
  function toEdgeFunctionApiUrl(url) {
    if (!deploymentId) return url;
    // Normalize the path
    let path = url;
    if (!path.startsWith('/')) path = '/' + path;
    // Remove leading slash for the function name
    const functionPath = path.substring(1);
    // Return the API endpoint URL
    return '/api/deployments/' + deploymentId + '/functions/' + functionPath;
  }
  
  // Intercept Image src setter to handle ALL image loading
  const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get: function() {
      return originalSrcDescriptor.get.call(this);
    },
    set: function(value) {
      const resolvedUrl = resolveVfsUrl(value);
      return originalSrcDescriptor.set.call(this, resolvedUrl);
    },
    enumerable: true,
    configurable: true
  });
  
  // Intercept setAttribute for src attributes
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if ((name === 'src' || name === 'href') && this instanceof HTMLImageElement) {
      value = resolveVfsUrl(value);
    }
    return originalSetAttribute.call(this, name, value);
  };
  
  // Intercept innerHTML to catch template-generated images
  const originalInnerHTMLDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    get: function() {
      return originalInnerHTMLDescriptor.get.call(this);
    },
    set: function(value) {
      if (typeof value === 'string' && value.includes('/assets/')) {
        // Replace asset URLs in the HTML string before setting
        const srcRegex = new RegExp('src=["\\']([^"\\']*/assets/[^"\\']*)["\\']', 'g');
        value = value.replace(srcRegex, function(match, url) {
          const resolvedUrl = resolveVfsUrl(url);
          if (resolvedUrl !== url) {
            return match.replace(url, resolvedUrl);
          }
          return match;
        });
      }
      return originalInnerHTMLDescriptor.set.call(this, value);
    },
    enumerable: true,
    configurable: true
  });
  
  // Intercept Image constructor
  const OriginalImage = window.Image;
  window.Image = function(...args) {
    const img = new OriginalImage(...args);
    // Override src setter for this instance too
    const descriptor = Object.getOwnPropertyDescriptor(img, 'src') || 
                      Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (descriptor) {
      Object.defineProperty(img, 'src', {
        get: descriptor.get,
        set: function(value) {
          const resolvedUrl = resolveVfsUrl(value);
          return originalSrcDescriptor.set.call(this, resolvedUrl);
        },
        enumerable: true,
        configurable: true
      });
    }
    return img;
  };
  // Preserve original Image properties
  Object.setPrototypeOf(window.Image, OriginalImage);
  window.Image.prototype = OriginalImage.prototype;
  
  // Intercept createElement for img elements
  const originalCreateElement = document.createElement;
  document.createElement = function(tagName, options) {
    const element = originalCreateElement.call(this, tagName, options);
    if (tagName.toLowerCase() === 'img') {
      const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      Object.defineProperty(element, 'src', {
        get: function() {
          return originalSrcDescriptor.get.call(this);
        },
        set: function(value) {
          const resolvedUrl = resolveVfsUrl(value);
          return originalSrcDescriptor.set.call(this, resolvedUrl);
        },
        enumerable: true,
        configurable: true
      });
    }
    return element;
  };
  
  // Intercept fetch requests to VFS assets and edge functions
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.url;

    // First check if this is an edge function call
    if (isEdgeFunctionUrl(url)) {
      return hostFetch(toEdgeFunctionApiUrl(url), input, init);
    }

    // Then check for VFS asset resolution
    const resolvedUrl = resolveVfsUrl(url);
    if (resolvedUrl !== url) {
      return originalFetch(resolvedUrl, init);
    }

    return originalFetch(input, init);
  };
  
  // Intercept XMLHttpRequest for older code and edge functions. An edge-function request is made
  // through the host like fetch, and its outcome is set on this XHR and announced with its events.
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    const originalSetRequestHeader = xhr.setRequestHeader;
    let edge = null;
    let edgeResponseHeaders = null;
    // Set while an edge call is in flight; abort() or the timeout clears it, and a late answer is dropped.
    let edgeCall = null;

    function settle(fields) {
      Object.keys(fields).forEach(function(key) {
        Object.defineProperty(xhr, key, { value: fields[key], configurable: true });
      });
    }
    function fire(type) {
      xhr.dispatchEvent(type === 'readystatechange' ? new Event(type) : new ProgressEvent(type));
    }

    xhr.open = function(method, url, ...args) {
      edgeResponseHeaders = null;
      edgeCall = null;
      if (isEdgeFunctionUrl(url)) {
        edge = { method: method, path: toEdgeFunctionApiUrl(url), headers: [] };
        return;
      }
      edge = null;
      return originalOpen.call(this, method, resolveVfsUrl(url), ...args);
    };
    xhr.setRequestHeader = function(name, value) {
      if (edge) { edge.headers.push([name, value]); return; }
      return originalSetRequestHeader.call(this, name, value);
    };
    xhr.getResponseHeader = function(name) {
      return edgeResponseHeaders ? edgeResponseHeaders.get(name) : OriginalXHR.prototype.getResponseHeader.call(this, name);
    };
    xhr.getAllResponseHeaders = function() {
      if (!edgeResponseHeaders) return OriginalXHR.prototype.getAllResponseHeaders.call(this);
      let all = '';
      edgeResponseHeaders.forEach(function(value, name) { all += name + ': ' + value + '\\r\\n'; });
      return all;
    };
    function fail(type) {
      edgeCall = null;
      settle({ readyState: 4, status: 0, statusText: '', responseText: '', response: null });
      fire('readystatechange'); fire(type); fire('loadend');
    }
    xhr.abort = function() {
      if (!edge) return OriginalXHR.prototype.abort.call(this);
      if (edgeCall) { edgeCall.controller.abort(); clearTimeout(edgeCall.timer); fail('abort'); }
    };
    xhr.send = function(body) {
      if (!edge) return originalSend.call(this, body);
      const call = edge;
      const controller = new AbortController();
      const current = { controller: controller, timer: 0 };
      edgeCall = current;
      if (xhr.timeout > 0) {
        current.timer = setTimeout(function() {
          if (edgeCall !== current) return;
          controller.abort();
          fail('timeout');
        }, xhr.timeout);
      }
      const type = xhr.responseType;
      hostFetch(call.path, call.path, { method: call.method, headers: call.headers, body: body, signal: controller.signal })
        .then(function(res) {
          const read = type === 'arraybuffer' ? res.arrayBuffer() : type === 'blob' ? res.blob() : res.text();
          return read.then(function(content) {
            if (edgeCall !== current) return;
            edgeCall = null;
            clearTimeout(current.timer);
            edgeResponseHeaders = res.headers;
            const isText = type === '' || type === 'text' || type === 'json';
            let response = content;
            if (type === 'json') { try { response = JSON.parse(content); } catch (e) { response = null; } }
            settle({ readyState: 4, status: res.status, statusText: res.statusText, responseText: isText ? content : '', response: response });
            fire('readystatechange'); fire('load'); fire('loadend');
          });
        })
        .catch(function() {
          if (edgeCall !== current) return;
          clearTimeout(current.timer);
          fail('error');
        });
    };

    return xhr;
  };

  // Intercept form submissions for edge functions
  if (deploymentId) {
    document.addEventListener('submit', function(e) {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;

      const action = form.getAttribute('action') || '';
      if (isEdgeFunctionUrl(action)) {
        e.preventDefault();
        e.stopPropagation();

        const apiUrl = toEdgeFunctionApiUrl(action);
        const method = (form.method || 'GET').toUpperCase();

        // Collect form data
        const formData = new FormData(form);

        // Convert to JSON for edge functions
        const data = {};
        formData.forEach(function(value, key) {
          data[key] = value;
        });

        // Made through the host, like every edge-function call from the preview
        hostFetch(apiUrl, apiUrl, {
          method: method,
          headers: {
            'Content-Type': 'application/json'
          },
          body: method !== 'GET' ? JSON.stringify(data) : undefined
        })
        .then(function(response) {
          return response.json().catch(function() {
            return response.text();
          });
        })
        .then(function(result) {
          // Dispatch custom event with the result
          const event = new CustomEvent('edge-function-response', {
            detail: { action: action, result: result }
          });
          form.dispatchEvent(event);
          document.dispatchEvent(event);

        })
        .catch(function(error) {
          console.error('[Edge Function] Error:', error);
          const event = new CustomEvent('edge-function-error', {
            detail: { action: action, error: error.message }
          });
          form.dispatchEvent(event);
          document.dispatchEvent(event);
        });
      }
    }, true);
  }
  
  // Process any existing images in the DOM when ready
  function processExistingImages() {
    const images = document.querySelectorAll('img[src*="/assets/"]');
    images.forEach(img => {
      const currentSrc = img.src;
      const resolvedSrc = resolveVfsUrl(currentSrc);
      if (resolvedSrc !== currentSrc) {
        img.src = resolvedSrc;
      }
    });
  }
  
  // Use MutationObserver to catch dynamically added images
  function setupMutationObserver() {
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1) { // Element node
              if (node.tagName === 'IMG' && node.src && node.src.includes('/assets/')) {
                const resolvedSrc = resolveVfsUrl(node.src);
                if (resolvedSrc !== node.src) {
                  node.src = resolvedSrc;
                }
              }
              // Also check children
              const childImages = node.querySelectorAll && node.querySelectorAll('img[src*="/assets/"]');
              if (childImages) {
                childImages.forEach(img => {
                  const resolvedSrc = resolveVfsUrl(img.src);
                  if (resolvedSrc !== img.src) {
                    img.src = resolvedSrc;
                  }
                });
              }
            }
          });
        });
      });
      
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
    }
  }
  
  // Setup everything when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      processExistingImages();
      setupMutationObserver();
    });
  } else {
    processExistingImages();
    setupMutationObserver();
  }
})();
</script>`;

    const consoleScript = `<script>
// Console Capture - Auto-injected by OSW Studio
(function() {
  if (window === window.parent) return;
  var levels = ['log', 'warn', 'error', 'info', 'debug'];
  var originals = {};
  var queue = [];
  var timer = null;

  function serialize(arg) {
    if (typeof arg === 'string') return arg;
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    if (typeof arg === 'function') return 'function ' + (arg.name || 'anonymous') + '()';
    if (typeof HTMLElement !== 'undefined' && arg instanceof HTMLElement) return '<' + arg.tagName.toLowerCase() + '>';
    try {
      var seen = [];
      return JSON.stringify(arg, function(key, val) {
        if (typeof val === 'object' && val !== null) {
          if (seen.indexOf(val) !== -1) return '[Circular]';
          seen.push(val);
        }
        return val;
      });
    } catch (e) {
      return String(arg);
    }
  }

  function flush() {
    timer = null;
    if (queue.length === 0) return;
    var batch = queue.splice(0, 50);
    for (var i = 0; i < batch.length; i++) {
      try {
        window.parent.postMessage(batch[i], '*');
      } catch (e) {}
    }
    if (queue.length > 0) {
      timer = setTimeout(flush, 100);
    }
  }

  for (var i = 0; i < levels.length; i++) {
    (function(level) {
      originals[level] = console[level];
      console[level] = function() {
        originals[level].apply(console, arguments);
        var args = [];
        for (var j = 0; j < arguments.length; j++) {
          args.push(serialize(arguments[j]));
        }
        queue.push({ type: 'console', level: level, args: args });
        if (!timer) {
          timer = setTimeout(flush, 100);
        }
      };
    })(levels[i]);
  }

  // Capture uncaught errors (SyntaxError, ReferenceError, etc.)
  window.onerror = function(message, source, lineno, colno) {
    var loc = source ? ' (' + source.replace(/^.*[\\/]/, '') + ':' + lineno + ':' + colno + ')' : '';
    queue.push({ type: 'console', level: 'error', args: [String(message) + loc] });
    if (!timer) timer = setTimeout(flush, 100);
  };

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason;
    var msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    queue.push({ type: 'console', level: 'error', args: ['Unhandled rejection: ' + msg] });
    if (!timer) timer = setTimeout(flush, 100);
  });

  // Capture failed resource loads (images, scripts, stylesheets). These fire an
  // 'error' event on the element that does NOT bubble to window.onerror, so listen
  // in the capture phase. Cross-origin failures (e.g. broken Unsplash URLs) report here.
  window.addEventListener('error', function(e) {
    var t = e.target;
    if (!t || t === window) return;
    var tag = t.tagName;
    if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'LINK') {
      var url = t.src || t.href || '';
      if (!url) return;
      queue.push({ type: 'console', level: 'error', args: ['Failed to load ' + tag.toLowerCase() + ': ' + url] });
      if (!timer) timer = setTimeout(flush, 100);
    }
  }, true);
})();
</script>`;

    // Build ES module import map for non-bundled runtimes.
    // Maps VFS JS/TS paths to blob URLs so <script type="module"> imports resolve.
    let importMapScript = '';
    if (!isRuntimeBundled(this.runtime) && blobUrls) {
      const imports: Record<string, string> = {};
      for (const [path, url] of blobUrls) {
        if (/\.(js|mjs|ts)$/i.test(path)) {
          imports[path] = url;                                       // /scripts/utils.js
          if (path.startsWith('/')) imports['.' + path] = url;       // ./scripts/utils.js
        }
      }
      if (Object.keys(imports).length > 0) {
        importMapScript = `<script type="importmap">${JSON.stringify({ imports })}</script>\n`;
      }
    }

    // Insert in head for early execution.
    // Import map must precede any <script type="module">, so it goes first.
    const injectedScripts = importMapScript + vfsScript + '\n' + consoleScript;
    if (content.includes('</head>')) {
      content = content.replace('</head>', injectedScripts + '\n</head>');
    } else if (content.includes('<body>')) {
      content = content.replace('<body>', injectedScripts + '\n<body>');
    } else {
      content = injectedScripts + '\n' + content;
    }

    return {
      path: file.path,
      content,
      mimeType: file.mimeType
    };
  }
  
  private extractPartialReferences(content: string): string[] {
    // Match {{> partialName}} or {{>partialName}} syntax
    const partialRegex = /\{\{>\s*([\w-]+)\s*(?:\s+[^}]*)?\}\}/g;
    const partials = new Set<string>();
    let match;

    while ((match = partialRegex.exec(content)) !== null) {
      partials.add(match[1]);
    }

    return Array.from(partials);
  }

  private registerErrorStubsForMissingPartials(partialRefs: string[]): void {
    for (const partialName of partialRefs) {
      // Check if partial is already registered
      if (!this.handlebars.partials[partialName]) {
        // Register error stub for missing partial
        const errorStub = `<div style="border: 2px solid #f99; background: #fee; padding: 1rem; margin: 1rem 0; border-radius: 4px; font-family: monospace;">
  <strong style="color: #c33;">⚠️ Missing partial: "${partialName}"</strong>
  <p style="margin: 0.5rem 0 0 0; font-size: 0.9em;">Create file in /templates/ directory (e.g., /templates/${partialName}.hbs or /templates/components/${partialName}.hbs)</p>
</div>`;
        this.handlebars.registerPartial(partialName, errorStub);
      }
    }
  }

  private async processHandlebarsTemplates(content: string, filePath?: string): Promise<string> {
    // Ensure partials are registered
    await this.registerPartials();

    try {
      // Check for common invalid LLM-generated patterns before compilation
      const invalidPatterns = this.detectInvalidHandlebarsPatterns(content);
      if (invalidPatterns.length > 0) {
        for (const p of invalidPatterns) {
          pushCompileError(filePath || 'unknown', `${p.error} — ${p.suggestion}`);
        }
        const errorMessages = invalidPatterns.map(pattern => `❌ ${pattern.error}\n💡 ${pattern.suggestion}`).join('\n\n');
        return `<!-- Handlebars Syntax Error -->\n<div style="background: #fee; border: 1px solid #f99; padding: 1rem; margin: 1rem; border-radius: 4px; font-family: monospace;">\n<h3 style="color: #c33; margin: 0 0 1rem 0;">⚠️ Handlebars Template Error</h3>\n<pre style="margin: 0; white-space: pre-wrap;">${errorMessages}</pre>\n</div>\n<!-- Original content:\n${content}\n-->`;
      }

      // Extract partial references and register error stubs for missing ones
      const partialRefs = this.extractPartialReferences(content);
      this.registerErrorStubsForMissingPartials(partialRefs);

      // Look for a data.json file for template context
      let context = {};
      try {
        if (await this.vfs.fileExists(this.projectId, '/data.json')) {
          const dataFile = await this.vfs.readFile(this.projectId, '/data.json');
          context = JSON.parse(dataFile.content as string);
        }
      } catch {
        // Invalid data file, use empty context
      }

      // Compile the content as a Handlebars template
      const template = this.handlebars.compile(content);
      const result = template(context);
      return result;
    } catch (error) {
      logger.error('VirtualServer: Error processing Handlebars templates:', error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      pushCompileError(filePath || 'unknown', errorMessage);

      // Return a helpful error message instead of original content
      return `<!-- Handlebars Compilation Error -->\n<div style="background: #fee; border: 1px solid #f99; padding: 1rem; margin: 1rem; border-radius: 4px; font-family: monospace;">\n<h3 style="color: #c33; margin: 0 0 1rem 0;">⚠️ Handlebars Template Error</h3>\n<p><strong>Error:</strong> ${errorMessage}</p>\n<p><strong>Common fixes:</strong></p>\n<ul>\n<li>Check for typos in helper names and partial references</li>\n<li>Ensure all opening tags have matching closing tags</li>\n<li>Verify partial names exist in /templates/ directory</li>\n<li>Use <code>{{> partialName}}</code> syntax, not <code>(> partialName)</code></li>\n</ul>\n</div>\n<!-- Original content:\n${content}\n-->`;
    }
  }

  private detectInvalidHandlebarsPatterns(content: string): Array<{error: string, suggestion: string}> {
    const patterns = [];
    
    // Pattern 1: Invalid (> partial) syntax in parameters
    const invalidPartialInParam = /\w+\s*=\s*\(\s*>\s*[\w-]+\s*\)/g;
    if (invalidPartialInParam.test(content)) {
      patterns.push({
        error: "Invalid syntax: Using (> partial) as parameter value",
        suggestion: "Use string-based dynamic partials: content=\"partial-name\" then {{> (lookup this 'content')}}"
      });
    }
    
    // Pattern 2: Common typos in partial syntax
    const typoPartialSyntax = /\{\{\s*>\s*\(\s*>\s*[\w-]+\s*\)\s*\}\}/g;
    if (typoPartialSyntax.test(content)) {
      patterns.push({
        error: "Invalid syntax: Double partial reference {{> (> partial)}}",
        suggestion: "Use {{> partialName}} for static partials or {{> (lookup data 'partialName')}} for dynamic"
      });
    }
    
    // Pattern 3: Missing quotes in parameter values (literal strings with spaces)
    const unquotedParams = /\{\{\s*>\s*[\w-]+\s+\w+\s*=\s*[^"'\s}][^}]*\s[^}]*(?:\s|}})/g;
    if (unquotedParams.test(content)) {
      patterns.push({
        error: "Missing quotes in parameter values",
        suggestion: "Wrap parameter values in quotes: title=\"My Title\" not title=My Title"
      });
    }
    
    return patterns;
  }

  private async processCSS(file: VirtualFile, blobUrls: Map<string, string>): Promise<ProcessedFile> {
    let content = file.content as string;

    content = await this.processUrlReferences(content, blobUrls, file.path);

    return {
      path: file.path,
      content,
      mimeType: file.mimeType
    };
  }

  private isAssetReference(url: string): boolean {
    // Asset extensions that should be converted to blob URLs
    const assetExtensions = [
      '.css', '.js', '.jsx', '.ts', '.tsx',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
      '.woff', '.woff2', '.ttf', '.otf', '.eot',
      '.mp4', '.webm', '.ogg', '.mp3', '.wav',
      '.pdf', '.zip', '.json', '.xml'
    ];
    
    // Extract extension from URL (handle query params and fragments)
    const cleanUrl = url.split('?')[0].split('#')[0];
    const extension = cleanUrl.substring(cleanUrl.lastIndexOf('.')).toLowerCase();
    
    return assetExtensions.includes(extension);
  }

  /**
   * Rewrite a page's internal asset references to their blob URLs.
   *
   * `projectPaths` is every path the project holds, used to tell an asset reference from a link
   * to something that is not there. It is passed in rather than read here: this runs once per HTML
   * file, and reading it here meant a full `listDirectory` — which loads every file's *content* —
   * for each page. On a 621-page project that was the whole project read 621 times, and the
   * preview timed out before it finished rather than because anything stalled.
   */
  private async processInternalReferences(
    content: string,
    blobUrls?: Map<string, string>,
    projectPaths?: ReadonlySet<string>
  ): Promise<string> {
    const paths = projectPaths ?? new Set(
      (await this.vfs.listDirectory(this.projectId, '/')).map((file) => file.path)
    );

    // Use provided blob URLs or fall back to instance blob URLs
    const urlMap = blobUrls || this.blobUrls;
    
    const patterns = [
      /href="([^"]+)"/g,
      /src="([^"]+)"/g,
      /href='([^']+)'/g,
      /src='([^']+)'/g
    ];

    let processed = content;
    for (const pattern of patterns) {
      processed = processed.replace(pattern, (match, url) => {
        if (url.startsWith('http') || url.startsWith('data:') || url.startsWith('//') || url.startsWith('blob:') || url.startsWith('#')) {
          return match;
        }

        // For href attributes, only convert asset references to blob URLs
        // Leave navigation links (HTML pages and routes) as-is for proper routing
        const isHref = match.includes('href=');
        if (isHref && !this.isAssetReference(url)) {
          return match; // Keep navigation links unchanged
        }

        const normalizedPath = this.normalizePath(url);
        
        const fileExists = paths.has(normalizedPath);
        if (fileExists) {
          // Check if we have a blob URL for this file
          const blobUrl = urlMap.get(normalizedPath);
          if (blobUrl) {
            // Replace the URL with the blob URL
            return match.replace(url, blobUrl);
          }
        }

        return match;
      });
    }

    return processed;
  }

  /**
   * Points a stylesheet's `url()` references at the files' blob URLs.
   *
   * A relative reference resolves against the stylesheet's own folder, as a browser resolves it: a
   * font's `url("./x.woff2")` in `/assets/fonts/x.css` is `/assets/fonts/x.woff2`. Resolving it from
   * the root instead found nothing, left the reference relative, and a relative URL inside a blob:
   * stylesheet leads nowhere, so self-hosted fonts and icon fonts were missing in the preview only.
   * The root-based lookup stays as a fallback for a reference the correct path doesn't find.
   */
  private async processUrlReferences(content: string, blobUrls: Map<string, string>, cssPath = '/'): Promise<string> {
    return content.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
      if (url.startsWith('http') || url.startsWith('data:') || url.startsWith('//') || url.startsWith('blob:')) {
        return match;
      }

      // `?v=2` and `#iefix` / `#Font` aren't part of the file's path; a fragment is kept on the result.
      const [, target, , fragment = ''] = url.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/) || [];
      const blobUrl = blobUrls.get(this.resolveFrom(cssPath, target ?? url)) ?? blobUrls.get(this.normalizePath(url));
      if (blobUrl) {
        return `url('${blobUrl}${fragment}')`;
      }

      return match;
    });
  }

  /** `ref` as a browser resolves it from a file at `fromPath`: relative to its folder, `.` and `..` applied. */
  private resolveFrom(fromPath: string, ref: string): string {
    const base = ref.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
    const parts = [...base, ...ref.split('/')];
    const out: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return '/' + out.join('/');
  }

  private normalizePath(path: string): string {
    if (path.startsWith('./')) {
      path = path.slice(2);
    }

    if (!path.startsWith('/')) {
      path = '/' + path;
    }

    // If path ends with /, it's a directory - look for index.html
    if (path.endsWith('/')) {
      return path + 'index.html';
    }

    // If no extension, assume HTML file
    if (!path.includes('.')) {
      return path + '.html';
    }

    return path;
  }

  private generateRoutes(files: VirtualFile[]): Route[] {
    const htmlFiles = files.filter(f => f.type === 'html');
    
    return htmlFiles.map(file => {
      const content = file.content as string;
      const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1] : file.name.replace('.html', '');

      const routePath = file.path.replace('.html', '') || '/';

      return {
        path: routePath === '/index' ? '/' : routePath,
        file: file.path,
        title
      };
    });
  }

  cleanupBlobUrls(): void {
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
    
    // Also clear template cache and re-register partials on next compile
    this.templateCache.clear();
    this.partialsRegistered = false;
  }

  async getCompiledFile(path: string): Promise<ProcessedFile | null> {
    try {
      const file = await this.vfs.readFile(this.projectId, path);
      
      if (file.type === 'html') {
        return await this.processHTML(file, this.blobUrls);
      } else if (file.type === 'css') {
        return await this.processCSS(file, new Map());
      } else {
        return {
          path: file.path,
          content: file.content as string,
          mimeType: file.mimeType
        };
      }
    } catch {
      return null;
    }
  }
}
