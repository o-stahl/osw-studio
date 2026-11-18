import { describe, it, expect, vi } from 'vitest';
import { inspectCommand, formatReport, styleLines } from '../commands/inspect';
import { screenshotCommand } from '../commands/screenshot';
import { parseRenderArgs, render } from '../commands/render-shared';
import type { InspectReport, RenderJob, RenderResult, ScreenshotImage } from '@/lib/canvas/render-types';
import type { VirtualFileSystem } from '@/lib/vfs';

/**
 * `inspect` and `screenshot` outside a browser: the page is rendered by whatever `renderInBrowser`
 * the run was given (a server run asks an open tab), and the commands turn the answer into what
 * the agent reads. The rendering itself is `lib/canvas/render-job.ts`, checked in a browser.
 */

const SOURCE = '<html>\n<body>\n  <section class="hero">\n    <h1>Hi</h1>\n  </section>\n</body>\n</html>';
const fs = {
  readFile: vi.fn(async (_id: string, path: string) => {
    if (path === '/index.html') return { content: SOURCE };
    throw new Error('missing');
  }),
} as unknown as VirtualFileSystem;

const HERO = SOURCE.indexOf('<section');
const H1 = SOURCE.indexOf('<h1>');

const report: InspectReport = {
  page: '/index.html', width: 375, height: 667, pageHeight: 1200, matches: 1,
  node: {
    tag: 'section', classes: ['hero'], src: `/index.html:${HERO}`, marker: 'h7x2m4qp', box: { x: 0, y: 64, w: 375, h: 600 },
    children: [{ tag: 'h1', classes: [], src: `/index.html:${H1}`, marker: null, box: { x: 24, y: 112, w: 327, h: 88 }, text: 'Hi' }],
    more: 2,
  },
  styles: [
    { property: 'display', computed: 'flex', declared: { value: 'flex', selector: '.hero', origin: '/styles.css' } },
    { property: 'position', computed: 'static' },
    { property: 'margin-top', computed: '0px' }, { property: 'margin-right', computed: '0px' },
    { property: 'margin-bottom', computed: '0px' }, { property: 'margin-left', computed: '0px' },
    { property: 'padding-top', computed: '28px', declared: { value: '28px', selector: '[data-osw-id="h7x2m4qp"][data-osw-id]', origin: '/overrides.css', media: '(max-width: 767px)' } },
    { property: 'padding-right', computed: '24px', declared: { value: '24px', selector: '.hero', origin: '/styles.css' } },
    { property: 'padding-bottom', computed: '28px', declared: { value: '28px', selector: '[data-osw-id="h7x2m4qp"][data-osw-id]', origin: '/overrides.css', media: '(max-width: 767px)' } },
    { property: 'padding-left', computed: '24px', declared: { value: '24px', selector: '.hero', origin: '/styles.css' } },
    { property: 'row-gap', computed: '20px', declared: { value: '20px', selector: '.hero', origin: '/styles.css' } },
    { property: 'column-gap', computed: '20px', declared: { value: '20px', selector: '.hero', origin: '/styles.css' } },
    { property: 'transform', computed: 'none' },
    { property: 'color', computed: 'rgb(17, 24, 39)' },
  ],
};

const where = async (src: string | null) => src ?? '(built by a script)';

describe('styleLines', () => {
  it('folds sides into their shorthand, names the rules that set them, and leaves unset defaults out', () => {
    expect(styleLines(report.styles!)).toEqual([
      'display: flex  ← .hero (/styles.css)',
      'margin: 0px',
      'padding: 28px 24px  ← [data-osw-id="h7x2m4qp"][data-osw-id] (/overrides.css, @media (max-width: 767px)); .hero (/styles.css)',
      'gap: 20px  ← .hero (/styles.css)',
      'color: rgb(17, 24, 39)',
    ]);
  });
});

describe('formatReport', () => {
  it('leads with the page and the element, then its styles and children', async () => {
    const text = await formatReport(report, '.hero', where);
    expect(text.split('\n')).toEqual([
      '/index.html at 375 × 667, page 1200 px tall',
      `section.hero  /index.html:${HERO}  @h7x2m4qp  375×600 at 0,64`,
      '  display: flex  ← .hero (/styles.css)',
      '  margin: 0px',
      '  padding: 28px 24px  ← [data-osw-id="h7x2m4qp"][data-osw-id] (/overrides.css, @media (max-width: 767px)); .hero (/styles.css)',
      '  gap: 20px  ← .hero (/styles.css)',
      '  color: rgb(17, 24, 39)',
      'children:',
      `  h1  /index.html:${H1}  327×88 at 24,112  "Hi"`,
      '  … 2 more',
    ]);
  });

  it('says when a selector matched several', async () => {
    expect(await formatReport({ ...report, matches: 3 }, 'li', where)).toContain('"li" matches 3 elements; this is the first.');
  });
});

describe('inspect', () => {
  it('renders through the run\'s renderer and gives each element its position, line and column', async () => {
    const renderInBrowser = vi.fn(async (): Promise<RenderResult> => ({ ok: true, kind: 'inspect', report }));
    const out = await inspectCommand({ vfs: fs, projectId: 'p', args: ['/', '.hero', '--width', '375'], ctx: { renderInBrowser } });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(renderInBrowser).toHaveBeenCalledWith({ kind: 'inspect', projectId: 'p', page: '/', width: 375, target: '.hero', depth: undefined });
    expect(out.stdout).toContain('section.hero  /index.html:3:3  @h7x2m4qp');
    expect(out.stdout).toContain('h1  /index.html:4:5');
  });

  it('names an element no source tag made as built by a script', async () => {
    const built = { tag: 'span', classes: ['badge'], src: null, marker: null, box: { x: 24, y: 210, w: 60, h: 20 }, text: 'New' };
    const withBuilt: InspectReport = { ...report, styles: [], node: { ...report.node!, children: [built], more: 0 } };
    const renderInBrowser = vi.fn(async (): Promise<RenderResult> => ({ ok: true, kind: 'inspect', report: withBuilt }));
    const out = await inspectCommand({ vfs: fs, projectId: 'p', args: ['/', '.hero'], ctx: { renderInBrowser } });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout.split('\n')).toContain('  span.badge  (built by a script)  60×20 at 24,210  "New"');
  });

  it('writes what it reads to the file a redirect names, as cat does', async () => {
    const createFile = vi.fn(async () => {});
    const writable = { readFile: fs.readFile, createFile } as unknown as VirtualFileSystem;
    const renderInBrowser = vi.fn(async (): Promise<RenderResult> => ({ ok: true, kind: 'inspect', report }));
    const out = await inspectCommand({ vfs: writable, projectId: 'p', args: ['/', '.hero'], ctx: { renderInBrowser }, redirect: { file: '/report.txt', append: false } });
    expect(out).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(createFile).toHaveBeenCalledWith('p', '/report.txt', expect.stringContaining('section.hero  /index.html:3:3  @h7x2m4qp'));
  });

  it('asks the frame for a position by the offset the compile stamps, and for the page it is in', async () => {
    const renderInBrowser = vi.fn(async (): Promise<RenderResult> => ({ ok: true, kind: 'inspect', report }));
    await inspectCommand({ vfs: fs, projectId: 'p', args: ['/index.html:4'], ctx: { renderInBrowser } });
    expect(renderInBrowser).toHaveBeenCalledWith(expect.objectContaining({ page: '/index.html', target: `/index.html:${H1}` }));
    await inspectCommand({ vfs: fs, projectId: 'p', args: ['/', '/index.html:3:3'], ctx: { renderInBrowser } });
    expect(renderInBrowser).toHaveBeenLastCalledWith(expect.objectContaining({ page: '/', target: `/index.html:${HERO}` }));
  });

  it('answers in the caller\'s terms: a miss lists what is there, and an error names the element as given', async () => {
    const renderInBrowser = vi.fn(async (job: RenderJob): Promise<RenderResult> => ({ ok: false, error: `"${job.target}" is not shown at 375 px wide` }));
    const miss = await inspectCommand({ vfs: fs, projectId: 'p', args: ['/index.html:1'], ctx: { renderInBrowser } });
    expect(miss.stderr).toContain('no element\'s open tag starts on line 1 of /index.html');
    expect(miss.stderr).toContain('<section>  /index.html:3:3');
    expect(renderInBrowser).not.toHaveBeenCalled();
    const hidden = await inspectCommand({ vfs: fs, projectId: 'p', args: ['/index.html:4'], ctx: { renderInBrowser } });
    expect(hidden.stderr).toContain('"/index.html:4" is not shown at 375 px wide');
  });

  it('says so when there is no browser to render in', async () => {
    const out = await inspectCommand({ vfs: fs, projectId: 'p', args: ['/'] });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('no OSW Studio tab is connected');
  });
});

describe('screenshot', () => {
  const image = (y: number, h: number): ScreenshotImage => ({ mediaType: 'image/jpeg', data: 'AAAA', width: 375, height: h, region: { x: 0, y, w: 375, h } });

  it('hands the images on and describes them', async () => {
    const onImages = vi.fn();
    const renderInBrowser = vi.fn(async (job: RenderJob): Promise<RenderResult> => ({ ok: true, kind: 'screenshot', images: [image(0, 1568), image(1568, 632)], width: job.width, height: 667, pageHeight: 2200 }));
    const out = await screenshotCommand({ vfs: fs, projectId: 'p', args: ['/about', '--width', '375', '--full'], ctx: { renderInBrowser, onImages, imageInput: true } });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(onImages).toHaveBeenCalledWith([image(0, 1568), image(1568, 632)]);
    expect(out.stdout).toBe('Screenshot of /about at 375 px wide (page 2200 px tall): 2 images, top to bottom (1: y 0–1568, 2: y 1568–2200).');
  });

  it('says where a long page was cut', async () => {
    const renderInBrowser = async (): Promise<RenderResult> => ({ ok: true, kind: 'screenshot', images: [image(0, 1568)], width: 375, height: 667, pageHeight: 20000, cut: true });
    const out = await screenshotCommand({ vfs: fs, projectId: 'p', args: ['/', '--full'], ctx: { renderInBrowser, onImages: vi.fn(), imageInput: true } });
    expect(out.stdout).toContain('Cut at y 1568; name an element further down to see the rest.');
  });

  it('refuses for a model that does not read images, and where nothing can carry them', async () => {
    const renderInBrowser = vi.fn();
    expect((await screenshotCommand({ vfs: fs, projectId: 'p', args: ['/'], ctx: { renderInBrowser, onImages: vi.fn(), imageInput: false } })).stderr).toContain('does not read images');
    expect((await screenshotCommand({ vfs: fs, projectId: 'p', args: ['/'], ctx: { renderInBrowser } })).stderr).toContain('preview_screenshot');
    expect(renderInBrowser).not.toHaveBeenCalled();
  });

  it('answers a shell no MCP client drives, as the Console is, without naming an MCP tool', async () => {
    const out = await screenshotCommand({ vfs: fs, projectId: 'p', args: ['/'] });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('screenshot: this shell cannot pass images on. To read the rendered page as text, use inspect.');
  });
});

describe('parseRenderArgs', () => {
  it('takes a page, an element and the flags', () => {
    expect(parseRenderArgs('inspect', ['about', '.hero h1', '--width=768', '--depth', '2'], { depth: true })).toEqual({ page: '/about', target: '.hero h1', width: 768, depth: 2, full: false });
    expect(parseRenderArgs('inspect', ['/'], {})).toMatchObject({ page: '/', width: 1440 });
    expect(parseRenderArgs('inspect', ['/', '--width', '375px'], {})).toMatchObject({ width: 375 });
    // A position names its own page.
    expect(parseRenderArgs('inspect', ['/about.html:12:3'], {})).toMatchObject({ page: '/about.html', target: '/about.html:12:3' });
  });

  it('refuses what it cannot use, with the command as it should have been', () => {
    expect(parseRenderArgs('inspect', [], {})).toBe('say which page: inspect /index.html');
    expect(parseRenderArgs('inspect', ['/', '--width', '50'], {})).toContain('between 240 and 3840');
    expect(parseRenderArgs('inspect', ['/', '.a', '.b'], {})).toContain('inspect /index.html ".a .b"');
    expect(parseRenderArgs('inspect', ['/', '--full'], {})).toBe('unknown option --full');
    // The element where the page belongs.
    expect(parseRenderArgs('screenshot', ['.hero'], {})).toBe('the page comes first, then the element: screenshot /index.html ".hero"');
    expect(parseRenderArgs('inspect', ['h1'], {})).toContain('inspect /index.html "h1"');
  });
});

describe('render', () => {
  it('asks the run\'s renderer where there is no window', async () => {
    const renderInBrowser = vi.fn(async (): Promise<RenderResult> => ({ ok: false, error: 'x' }));
    await render({ vfs: fs, projectId: 'p', args: [], ctx: { renderInBrowser } }, { kind: 'inspect', projectId: 'p', page: '/', width: 1440 });
    expect(renderInBrowser).toHaveBeenCalledTimes(1);
  });
});
