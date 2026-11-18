// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SERIALIZE_TREE_JS } from '../element-tree';
import type { SerializedLevel } from '../element-tree';
import { CAPTURE_RUNTIME_JS } from '../frame-capture';
import { TOOLBAR_HOST_ATTR } from '../toolbar-dom';

/**
 * The serializer is a JavaScript source string, because it is interpolated into the preview frame's
 * script and cannot be imported there. So the tests **execute** the emitted text rather than
 * inspecting it: a collapsed escape or a mis-authored character changes behaviour, and only running
 * it can see that. (An earlier plan draft proposed asserting the text contained no collapsed escape
 * and had the polarity backwards — it failed on correct code.)
 *
 * One evaluated instance per test, so the id counter and the stamping are observable across calls
 * within a test but cannot leak between them.
 */
let serialize: (root: Element) => SerializedLevel;

beforeEach(() => {
  document.body.innerHTML = '';
  serialize = new Function(`${SERIALIZE_TREE_JS} return __oswSerializeLevel;`)() as typeof serialize;
});

const tag = (t: string, src = '/i.hbs:0', inner = '') =>
  `<${t} data-osw-src="${src}">${inner}</${t}>`;

describe('__oswSerializeLevel', () => {
  it('returns one level and stamps only that level', () => {
    document.body.innerHTML = tag('main', '/i.hbs:0', tag('section', '/i.hbs:5', tag('p', '/i.hbs:9')));
    const { nodes } = serialize(document.body);
    expect(nodes.map(n => n.tag)).toEqual(['main']);
    // Laziness: asserting `children === undefined` would pass for a full walk too.
    expect(document.querySelectorAll('[data-osw-node]')).toHaveLength(1);
  });

  it('gives siblings distinct ids that resolve back to the right element', () => {
    document.body.innerHTML = tag('p', '/i.hbs:0', 'a') + tag('p', '/i.hbs:4', 'b');
    const { nodes } = serialize(document.body);
    expect(new Set(nodes.map(n => n.id)).size).toBe(2);
    const el = document.querySelector(`[data-osw-node="${nodes[1].id}"]`);
    expect(el!.textContent).toBe('b');
  });

  it('reports hasChildren before the level is expanded', () => {
    document.body.innerHTML = tag('main', '/i.hbs:0', tag('p', '/i.hbs:4')) + tag('span', '/i.hbs:9');
    const { nodes } = serialize(document.body);
    expect(nodes.find(n => n.tag === 'main')!.hasChildren).toBe(true);
    expect(nodes.find(n => n.tag === 'span')!.hasChildren).toBe(false);
  });

  it('splits the source on the LAST colon, because a path may contain one', () => {
    document.body.innerHTML = tag('p', '/a:b/c.html:99');
    expect(serialize(document.body).nodes[0].file).toBe('/a:b/c.html');
  });

  it('counts shared sources so the marker can render', () => {
    document.body.innerHTML = tag('article', '/i.hbs:7').repeat(3) + tag('footer', '/f.hbs:1');
    const { nodes } = serialize(document.body);
    expect(nodes.filter(n => n.instances === 3)).toHaveLength(3);
    expect(nodes.find(n => n.tag === 'footer')!.instances).toBe(1);
  });

  it('skips everything without provenance — the real shapes, not a made-up marker', () => {
    // An earlier draft asserted against `data-osw-overlay`, which nothing set. These are the
    // elements that are genuinely present at runtime.
    document.body.innerHTML =
      tag('p', '/i.hbs:0', 'real') +
      '<div data-osw-overlay="1" style="position:absolute"></div>' + // the selector overlay
      '<div data-semantic-indicator="true"></div>' +      // placement indicator
      '<div data-osw-toolbar=""></div>' +                 // the selection toolbar's host
      '<script>1</script><style>p{}</style><template><p>t</p></template>';
    expect(serialize(document.body).nodes.map(n => n.tag)).toEqual(['p']);
  });

  it('lists what the page\'s script built as script rows that do not open', () => {
    document.body.innerHTML = tag('section', '/i.hbs:0', '<div class="card"><b>built</b></div>');
    const section = serialize(document.body).nodes[0];
    expect(section.hasChildren).toBe(true);
    const [card] = serialize(document.querySelector('section')!).nodes;
    expect(card).toMatchObject({ tag: 'div', className: 'card', script: true, hasChildren: false });
    expect(card.file).toBeUndefined();
  });

  it('says what a leaf reads, and whether it is hidden or locked', () => {
    document.body.innerHTML =
      tag('p', '/i.hbs:0', '  Hello\n   there,   a sentence long enough to be cut  ') +
      '<p data-osw-src="/i.hbs:9" style="display:none" data-osw-lock>x</p>';
    const [long, hidden] = serialize(document.body).nodes;
    expect(long.text).toBe('Hello there, a sentence lon\u2026');
    expect(hidden).toMatchObject({ text: 'x', hidden: true, locked: true });
  });

  it('caps a wide level and reports exactly how many were dropped', () => {
    document.body.innerHTML = tag('div', '/i.hbs:0').repeat(500);
    const { nodes, truncated } = serialize(document.body);
    expect(nodes).toHaveLength(200);      // not `toBeLessThanOrEqual` — [] would pass that
    expect(truncated).toBe(300);
  });

  it('resolves a removed element to null rather than a detached node', () => {
    document.body.innerHTML = tag('p', '/i.hbs:0');
    const { nodes } = serialize(document.body);
    document.querySelector('p')!.remove();
    expect(document.querySelector(`[data-osw-node="${nodes[0].id}"]`)).toBeNull();
  });

  // --- contracts the panel depends on beyond the plan's block ---

  it('reuses an existing stamp, so an id the host already holds stays valid', () => {
    // The panel re-requests a level it has already expanded (collapse, re-expand). Minting a fresh
    // id there would strand the selection the host is holding on a live, unchanged element.
    document.body.innerHTML = tag('p', '/i.hbs:0');
    const first = serialize(document.body).nodes[0].id;
    const second = serialize(document.body).nodes[0].id;
    expect(second).toBe(first);
    expect(document.querySelectorAll('[data-osw-node]')).toHaveLength(1);
  });

  it('does not offer a caret for children that the same skip rule would drop', () => {
    // A `<div>` whose only child is an injected script has nothing to expand to. Counting raw
    // children here would render a caret that opens an empty level.
    document.body.innerHTML = tag('div', '/i.hbs:0', '<script>1</script>');
    expect(serialize(document.body).nodes[0].hasChildren).toBe(false);
  });

  it('reports the source index as a number and the class as a string', () => {
    document.body.innerHTML = '<p data-osw-src="/i.hbs:42" class=" lead  big ">x</p>';
    const node = serialize(document.body).nodes[0];
    expect(node.line).toBe(42);
    expect(node.className).toBe('lead  big');
  });

  it('omits line when the source carries no index at all', () => {
    document.body.innerHTML = '<p data-osw-src="/i.hbs">x</p>';
    const node = serialize(document.body).nodes[0];
    expect(node.file).toBe('/i.hbs');
    expect(node.line).toBeUndefined();
  });

  it('omits line rather than emitting NaN when the index is not a number', () => {
    // Reachable without a compiler bug: `data-osw-src` is a plain attribute, so a project's own
    // source can carry one. NaN survives postMessage's structured clone and would render as a row
    // labelled "NaN" in the panel.
    document.body.innerHTML = '<p data-osw-src="notes:hello">x</p>';
    const node = serialize(document.body).nodes[0];
    expect(node.file).toBe('notes');
    expect(node.line).toBeUndefined();
  });

  it('serializes a nested level when handed a stamped element as the root', () => {
    document.body.innerHTML = tag('main', '/i.hbs:0', tag('section', '/i.hbs:5') + tag('p', '/i.hbs:9'));
    const root = serialize(document.body).nodes[0];
    const el = document.querySelector(`[data-osw-node="${root.id}"]`)!;
    expect(serialize(el).nodes.map(n => n.tag)).toEqual(['section', 'p']);
  });
});

describe('__oswSerializeLevel while a screenshot is painting', () => {
  type Win = Window & { modernScreenshot?: unknown; __oswCaptureLibs?: unknown };
  const win = window as Win;

  afterEach(() => {
    delete win.modernScreenshot;
    delete win.__oswCaptureLibs;
    vi.unstubAllGlobals();
  });

  it('leaves out the sandbox host the capture appends to the body, and does not stamp it', async () => {
    document.body.innerHTML = tag('main', '/i.hbs:0');
    let seen: { hosts: number; rows: string[]; stamped: number } | null = null;
    // The real capture runtime with a stub painter: the tree is read at the moment it paints.
    win.modernScreenshot = {
      createContext: async (root: Element, options: object) => ({ root, options }),
      domToCanvas: async () => {
        const rows = serialize(document.body).nodes.map(n => n.tag);
        seen = {
          hosts: document.querySelectorAll('[data-osw-capture]').length,
          rows,
          stamped: document.querySelectorAll('[data-osw-capture][data-osw-node]').length,
        };
        return { width: 1, height: 1 };
      },
    };
    vi.stubGlobal('createImageBitmap', async () => ({}));

    await new Promise(resolve => {
      new Function('msg', 'post', CAPTURE_RUNTIME_JS)({
        reqId: 1,
        opts: { captureWidth: 1280, captureHeight: 720, fullPage: false, waitForContent: false, minWaitDelay: 0 },
        toolbarAttr: TOOLBAR_HOST_ATTR,
        libBase: '',
      }, resolve);
    });

    expect(seen).toEqual({ hosts: 1, rows: ['main'], stamped: 0 });
  });
});
