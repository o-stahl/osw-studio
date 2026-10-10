// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearPreviewStorage, setPreviewStorageArea } from '@/lib/preview/preview-storage';

/**
 * The thumbnail capture has to supply the blob-URL map itself.
 *
 * Compiled pages no longer carry a copy of it, so the asset interceptor inside the captured frame
 * resolves runtime requests through `window.__oswVfsBlobUrls` and nothing else. The preview host
 * injects it; this is the other renderer, and a thumbnail that skipped it would lose every asset a
 * script asks for while the page renders, with no error.
 */

const mocks = vi.hoisted(() => ({
  compileProject: vi.fn(),
  cleanupBlobUrls: vi.fn(),
  captureIframeScreenshot: vi.fn(),
  loadIntoShell: vi.fn(),
  getProject: vi.fn(),
  init: vi.fn(),
}));

vi.mock('@/lib/vfs', () => ({
  vfs: { init: mocks.init, getProject: mocks.getProject },
}));
vi.mock('@/lib/preview/virtual-server', () => ({
  VirtualServer: class {
    compileProject = mocks.compileProject;
    cleanupBlobUrls = mocks.cleanupBlobUrls;
  },
}));
vi.mock('../screenshot', () => ({ captureIframeScreenshot: mocks.captureIframeScreenshot }));
// jsdom cannot run a sandboxed frame; the shell itself is covered in lib/preview/__tests__/preview-shell.test.ts.
vi.mock('@/lib/preview/preview-shell', () => ({ loadIntoShell: mocks.loadIntoShell }));

/** The page the capture handed to the frame, and the frame's sandbox when it did. */
let renderedHtml = '';
let sandbox: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  renderedHtml = '';
  sandbox = null;
  mocks.init.mockResolvedValue(undefined);
  mocks.getProject.mockResolvedValue({ id: 'p1', settings: { runtime: 'static' } });
  mocks.loadIntoShell.mockImplementation(async (iframe: HTMLIFrameElement, html: string) => {
    renderedHtml = html;
    sandbox = iframe.getAttribute('sandbox');
  });
  mocks.captureIframeScreenshot.mockResolvedValue('data:image/jpeg;base64,x');
});

describe('capturing a project thumbnail', () => {
  it('gives the frame the blob-URL map its interceptor needs', async () => {
    mocks.compileProject.mockResolvedValue({
      files: [{ path: '/index.html', content: '<html><head></head><body></body></html>' }],
      blobUrls: new Map([['/img/hero.png', 'blob:http://localhost/hero']]),
    });

    const { captureProjectScreenshot } = await import('../project-thumbnail');
    const result = await captureProjectScreenshot('p1');

    expect(result).toBe('data:image/jpeg;base64,x');
    expect(renderedHtml).toContain('window.__oswVfsBlobUrls');
    expect(renderedHtml).toContain('/img/hero.png');
    expect(renderedHtml).toContain('blob:http://localhost/hero');
  });

  it('renders the project in a frame that cannot reach the app', async () => {
    mocks.compileProject.mockResolvedValue({
      files: [{ path: '/index.html', content: '<html><head></head><body></body></html>' }],
      blobUrls: new Map(),
    });

    const { captureProjectScreenshot } = await import('../project-thumbnail');
    await captureProjectScreenshot('p1');

    expect(sandbox).toBe('allow-scripts');
    expect(renderedHtml).toContain('data-osw-bridge');
  });

  it("starts the page from the project's own preview storage, and captures it at thumbnail size", async () => {
    // A page that reads its state from localStorage renders the same as it does in the preview.
    clearPreviewStorage();
    setPreviewStorageArea('p1', 'local', { theme: 'dark' });
    setPreviewStorageArea('p2', 'local', { theme: 'light' });
    mocks.compileProject.mockResolvedValue({
      files: [{ path: '/index.html', content: '<html><head></head><body></body></html>' }],
      blobUrls: new Map(),
    });

    const { captureProjectScreenshot } = await import('../project-thumbnail');
    await captureProjectScreenshot('p1');

    expect(mocks.loadIntoShell.mock.calls[0][4]).toEqual({ local: { theme: 'dark' }, session: {}, cookie: {} });
    const [frame, ...size] = mocks.captureIframeScreenshot.mock.calls[0];
    expect(frame).toBe(mocks.loadIntoShell.mock.calls[0][0]);
    expect(size).toEqual([1280, 720, 640, 0.8, false]);
    clearPreviewStorage();
  });

  it('returns nothing when the project has no index page to capture', async () => {
    mocks.compileProject.mockResolvedValue({ files: [], blobUrls: new Map() });

    const { captureProjectScreenshot } = await import('../project-thumbnail');

    expect(await captureProjectScreenshot('p1')).toBeNull();
  });
});
