// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { generateNavigationScript } from '@/lib/preview/navigation-script';
import { canvasBridgeJs, type CanvasFrameMode } from '../bridge';

/**
 * The canvas bridge, run for real inside the navigation script's closure against a document, the way
 * the preview's wiring tests run theirs: a stand-in window whose parent collects what is posted.
 * jsdom does no layout, so boxes are zero; picking stubs `elementFromPoint`.
 */

interface Posted { type?: string; [key: string]: unknown }

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

function frame(markup: string, mode: CanvasFrameMode = 'live', extras: Record<string, unknown> = {}, loadId = 1) {
  const doc = document.implementation.createHTMLDocument('artboard');
  doc.body.innerHTML = markup;
  const bus = new EventTarget();
  const posted: Posted[] = [];
  const win = {
    parent: { postMessage: (m: unknown) => { posted.push(m as Posted); } },
    scrollX: 0,
    scrollY: 0,
    innerHeight: 900,
    addEventListener: (type: string, h: EventListener, o?: boolean | AddEventListenerOptions) => bus.addEventListener(type, h, o),
    removeEventListener: (type: string, h: EventListener, o?: boolean) => bus.removeEventListener(type, h, o),
    ...extras,
  };
  new Function('document', 'window', jsOf(generateNavigationScript('/index.html', false, canvasBridgeJs(mode, 900, loadId))))(doc, win);
  const send = (data: unknown) => bus.dispatchEvent(Object.assign(new Event('message'), { data, source: win.parent }));
  const only = (type: string) => {
    const found = posted.filter((m) => m.type === type);
    expect(found, `expected one ${type}, got ${posted.map((m) => m.type).join(', ')}`).toHaveLength(1);
    return found[0];
  };
  return { doc, win, bus, posted, send, only };
}

const MARKUP =
  '<main data-osw-src="/index.html:10">' +
    '<section class="hero wide intro" data-osw-src="/index.html:40"><h1 data-osw-src="/index.html:70">Hello</h1></section>' +
    '<ul data-osw-src="/index.html:100"><li data-osw-src="/index.html:120">one</li><li data-osw-src="/index.html:120">two</li></ul>' +
    '<form data-osw-src="/index.html:200"><input data-osw-src="/index.html:220" name="who" value=""><textarea data-osw-src="/index.html:260"></textarea>' +
    '<select data-osw-src="/index.html:300"><option>a</option><option>b</option></select><input type="password" data-osw-src="/index.html:340"></form>' +
  '</main>';

describe('what a settled page is made of', () => {
  it('counts visible elements by whether a file wrote them, and how much of the first screen is a canvas', async () => {
    // jsdom lays nothing out: an element is visible here unless it is `hidden`, and the canvas is given a box.
    const rects = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return (this.hasAttribute('hidden') ? [] : [{}]) as unknown as DOMRectList;
    });
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const b = this.tagName === 'CANVAS' ? { left: 0, top: 450, right: 400, bottom: 1300 } : { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
    });
    try {
      const f = frame(
        '<main data-osw-src="/index.html:1"><h1 data-osw-src="/index.html:9">A</h1><p data-osw-src="/index.html:20" hidden>no</p>'
        + '<div id="app"><span>built</span><span>built</span></div><script>1</script><br>'
        + '<canvas data-osw-src="/index.html:50"></canvas></main>',
        'settle', { innerWidth: 400 },
      );
      // The stand-in document never finishes loading on its own: the load event is what the bridge
      // waits for, then fonts (a second at most) and a quiet moment.
      f.bus.dispatchEvent(new Event('load'));
      for (let i = 0; i < 80 && !f.posted.some((m) => m.type === 'canvas:settled'); i++) await new Promise((r) => setTimeout(r, 50));
      // main, h1 and the canvas are written in the file; the div and its two spans are not. The
      // canvas covers the lower half of the 900 px first screen, and what runs past it does not count.
      expect(f.only('canvas:settled').traced).toEqual({ source: 3, script: 3, drawn: 0.5 });
    } finally {
      rects.mockRestore();
      box.mockRestore();
    }
  });

  it('is posted with the load it belongs to, so a page from an earlier load is told apart', async () => {
    vi.useFakeTimers();
    try {
      const f = frame('<main data-osw-src="/index.html:1"><h1 data-osw-src="/index.html:9">A</h1></main>', 'settle', {}, 42);
      f.bus.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.only('canvas:settled').loadId).toBe(42);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('canvas:pick', () => {
  it('answers with the elements from source files under the point, outermost first', () => {
    const f = frame(MARKUP);
    const h1 = f.doc.querySelector('h1')!;
    (f.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => h1;
    f.send({ type: 'canvas:pick', reqId: 3, x: 10, y: 20 });
    const picked = f.only('canvas:picked') as unknown as { reqId: number; chain: { nodeId: string; parentId: string | null; tag: string; cls: string[]; src: string; index: number; leafText: boolean }[] };
    expect(picked.reqId).toBe(3);
    expect(picked.chain.map((c) => c.tag)).toEqual(['main', 'section', 'h1']);
    expect(picked.chain[1].cls).toEqual(['hero', 'wide']);
    expect(picked.chain[2].parentId).toBe(picked.chain[1].nodeId);
    // The heading's words are its own; the section's are its heading's.
    expect(picked.chain.map((c) => c.leafText)).toEqual([false, false, true]);
  });

  it('mints the node ids the Inspector uses, so a picked element can be selected by them', () => {
    const f = frame(MARKUP);
    const li = f.doc.querySelectorAll('li')[1];
    (f.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => li;
    f.send({ type: 'canvas:pick', reqId: 1, x: 0, y: 0 });
    const chain = (f.only('canvas:picked') as unknown as { chain: { nodeId: string; index: number }[] }).chain;
    expect(chain[chain.length - 1].index).toBe(1);
    f.send({ type: 'tree-select', nodeId: chain[chain.length - 1].nodeId });
    const selection = f.only('selector-selection') as unknown as { payload: { tagName: string; srcAttr: string; instanceCount: number; outerHTML: string } };
    expect(selection.payload.tagName).toBe('li');
    expect(selection.payload.srcAttr).toBe('/index.html:120');
    expect(selection.payload.instanceCount).toBe(2);
    expect(selection.payload.outerHTML).toBe('<li>two</li>');
  });
});

describe('canvas:watch', () => {
  it('reports the boxes of the elements it is asked about, by node id or by source and index, and the height', () => {
    const f = frame(MARKUP);
    f.send({ type: 'canvas:watch', targets: [{ src: '/index.html:120', index: 1 }, { src: '/index.html:999', index: 0 }] });
    const rects = (f.only('canvas:rects') as unknown as { rects: (object | null)[] }).rects;
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(rects[1]).toBeNull();
    expect((f.only('canvas:height') as unknown as { height: number }).height).toBe(900);
  });
});

describe('canvas:freeze', () => {
  it('copies the page without scripts or tree stamps, with typed values written in and file URLs back as the host\'s', () => {
    const f = frame(MARKUP + '<script>window.x = 1</script><img src="blob:frame/123">', 'live', { __oswShellUrls: { 'blob:host/abc': 'blob:frame/123' } });
    f.send({ type: 'tree-request', nodeId: null });
    (f.doc.querySelector('input[name="who"]') as HTMLInputElement).value = 'Aino';
    (f.doc.querySelector('textarea') as HTMLTextAreaElement).value = 'Window seat';
    (f.doc.querySelector('select') as HTMLSelectElement).selectedIndex = 1;
    (f.doc.querySelector('input[type="password"]') as HTMLInputElement).value = 'secret';
    f.send({ type: 'canvas:freeze', reqId: 5 });
    const frozen = f.only('canvas:frozen') as unknown as { reqId: number; html: string; fields: { list: unknown[] } };
    expect(frozen.reqId).toBe(5);
    expect(frozen.html).not.toContain('<script');
    expect(frozen.html).not.toContain('data-osw-node');
    expect(frozen.html).toContain('value="Aino"');
    expect(frozen.html).toContain('>Window seat</textarea>');
    expect(frozen.html).toContain('<option selected="">b</option>');
    expect(frozen.html).not.toContain('secret');
    expect(frozen.html).toContain('src="blob:host/abc"');
    expect(frozen.fields.list).toHaveLength(3);
  });
});

describe('canvas:fields', () => {
  it('gives a page that loads again what was typed before, by element, and tells the page\'s own listeners', () => {
    const first = frame(MARKUP);
    (first.doc.querySelector('textarea') as HTMLTextAreaElement).value = 'Window seat';
    first.send({ type: 'canvas:freeze', reqId: 1 });
    const kept = (first.only('canvas:frozen') as unknown as { fields: unknown }).fields;

    const again = frame(MARKUP);
    const heard: string[] = [];
    const field = again.doc.querySelector('textarea')!;
    for (const type of ['input', 'change']) field.addEventListener(type, () => heard.push(type));
    again.send({ type: 'canvas:fields', kept });
    expect((again.doc.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Window seat');
    expect(heard).toEqual(['input', 'change']);
  });
});

describe('a live page', () => {
  it('says it is ready, with its height, once loaded; and holds its frames when told', () => {
    const paced: boolean[] = [];
    const f = frame(MARKUP, 'live', { __oswPace: (p: boolean) => paced.push(p) });
    f.bus.dispatchEvent(new Event('load'));
    expect((f.only('canvas:ready') as unknown as { height: number }).height).toBe(900);
    f.send({ type: 'canvas:pace', paused: true });
    f.send({ type: 'canvas:pace', paused: false });
    expect(paced).toEqual([true, false]);
  });

  it('keeps a form on the page', () => {
    const f = frame(MARKUP);
    const submit = new Event('submit', { cancelable: true, bubbles: true });
    f.doc.querySelector('form')!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });
});

describe('canvas:describe by source and index', () => {
  it('answers with that one of the elements sharing the source, or null past the last', () => {
    const f = frame(MARKUP);
    const describe = (reqId: number, src: string, index: number) => {
      f.send({ type: 'canvas:describe', reqId, src, index });
      return (f.posted.find((m) => m.type === 'canvas:described' && m.reqId === reqId) as unknown as { item: { tag: string; src: string; index: number } | null }).item;
    };
    expect(describe(1, '/index.html:120', 1)).toMatchObject({ tag: 'li', src: '/index.html:120', index: 1 });
    expect(describe(2, '/index.html:120', 0)).toMatchObject({ tag: 'li', index: 0 });
    expect(describe(3, '/index.html:120', 2)).toBeNull();
    expect(describe(4, '/index.html:999', 0)).toBeNull();
  });
});

describe('canvas:describe with childOf', () => {
  it('answers with the first child from source, skipping what the page built', () => {
    const f = frame('<section data-osw-src="/index.html:0"><div class="built"></div><h2 data-osw-src="/index.html:30">t</h2></section>');
    const section = f.doc.querySelector('section')!;
    (f.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => section;
    f.send({ type: 'canvas:pick', reqId: 1, x: 0, y: 0 });
    const [item] = (f.only('canvas:picked') as unknown as { chain: { nodeId: string }[] }).chain;
    f.send({ type: 'canvas:describe', reqId: 2, childOf: item.nodeId });
    const child = (f.only('canvas:described') as unknown as { item: { tag: string; src: string } }).item;
    expect(child).toMatchObject({ tag: 'h2', src: '/index.html:30' });
  });
});

describe('canvas:drop-at', () => {
  const DROP =
    '<main data-osw-src="/index.html:0">' +
      '<div class="empty" data-osw-src="/index.html:10"></div>' +
      '<p data-osw-src="/index.html:40">a</p><p data-osw-src="/index.html:60">b</p>' +
      '<div data-osw-lock data-osw-src="/index.html:80"><div class="inner" data-osw-src="/index.html:100"></div></div>' +
      '<p class="credit" data-osw-src="/templates/footer.hbs:0">c</p>' +
    '</main>';
  const dropOver = (selector: string, box?: { top: number; height: number }) => {
    const f = frame(DROP);
    const el = f.doc.querySelector(selector)!;
    if (box) el.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, bottom: box.top + box.height, x: 0, y: box.top, toJSON: () => ({}), ...box }) as DOMRect;
    (f.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => el;
    f.send({ type: 'canvas:drop-at', reqId: 5, x: 1, y: 1 });
    return (f.only('canvas:dropped') as unknown as { reqId: number; drop: { place: unknown; locked: boolean; parentName: string } }).drop;
  };

  it('goes into an empty container, at its end', () => {
    expect(dropOver('.empty')).toMatchObject({ place: { parent: '/index.html:10', at: 'end' }, locked: false, parentName: 'div.empty' });
  });

  it('goes beside an element that holds no others, named by its neighbours from the same file', () => {
    // jsdom has no layout: every box is empty, so the point counts as past the middle.
    expect(dropOver('p:nth-of-type(1)')).toMatchObject({ place: { before: '/index.html:60' }, parentName: 'main' });
  });

  it('says when the place is locked', () => {
    expect(dropOver('.inner')).toMatchObject({ locked: true });
  });

  it('names a place before a partial\'s element by the element before it from this file', () => {
    // The point is above the middle of the partial's paragraph, so the new element goes before it.
    expect(dropOver('.credit', { top: 10, height: 20 }).place).toEqual({ after: '/index.html:80' });
  });

  it('appends to the parent after a partial\'s last element', () => {
    expect(dropOver('.credit').place).toEqual({ parent: '/index.html:0', at: 'end' });
  });
});

describe('canvas:edit-text', () => {
  const editable = () => {
    const f = frame('<p data-osw-src="/index.html:0">Before</p>');
    const p = f.doc.querySelector('p')!;
    (f.doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => p;
    f.send({ type: 'canvas:pick', reqId: 1, x: 0, y: 0 });
    const [item] = (f.only('canvas:picked') as unknown as { chain: { nodeId: string }[] }).chain;
    f.send({ type: 'canvas:edit-text', nodeId: item.nodeId });
    return { f, p, nodeId: item.nodeId };
  };
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('lets the element be typed into, and Enter hands the text over', () => {
    const { f, p, nodeId } = editable();
    expect(p.getAttribute('contenteditable')).toBe('true');
    p.textContent = 'After';
    key(p, 'Enter');
    expect(f.only('canvas:text-done')).toMatchObject({ nodeId, text: 'After', changed: true, cancelled: false });
    expect(p.hasAttribute('contenteditable')).toBe(false);
  });

  it('puts the text back on Escape', () => {
    const { f, p } = editable();
    p.textContent = 'Typed';
    key(p, 'Escape');
    expect(f.only('canvas:text-done')).toMatchObject({ cancelled: true, changed: false });
    expect(p.textContent).toBe('Before');
  });

  it('reports no change when nothing changed', () => {
    const { f, p } = editable();
    key(p, 'Enter');
    expect(f.only('canvas:text-done')).toMatchObject({ changed: false, cancelled: false });
  });
});

describe('canvas:inspect', () => {
  const STYLED =
    '<style>.hero { padding: 48px 24px; } @media (max-width: 767px) { .hero h1 { font-size: 36px; } }' +
    '[data-osw-id="h1abc123"][data-osw-id] { color: red; }</style>' + MARKUP.replace('<h1 ', '<h1 data-osw-id="h1abc123" ');
  const inspect = (f: ReturnType<typeof frame>, message: Record<string, unknown>) => {
    f.send({ type: 'canvas:inspect', reqId: 9, ...message });
    const reply = f.only('canvas:inspected') as unknown as { reqId: number; report: Record<string, unknown> };
    expect(reply.reqId).toBe(9);
    return reply.report as {
      page: string; width: number; matches?: number; error?: string;
      node: { tag: string; classes: string[]; src: string | null; marker: string | null; text?: string; children?: { tag: string; children?: unknown[] }[]; more?: number } | null;
      styles?: { property: string; computed: string; declared?: { value: string; selector: string; origin: string; media?: string } }[];
    };
  };

  it('lists the page from the body, to the depth asked, naming page and width', () => {
    const f = frame(STYLED, 'settle', { innerWidth: 375, matchMedia: () => ({ matches: true }) });
    const report = inspect(f, { target: null, depth: 1 });
    expect(report.page).toBe('/index.html');
    expect(report.width).toBe(375);
    expect(report.node!.tag).toBe('body');
    expect(report.node!.children!.map((c) => c.tag)).toEqual(['main']);
    expect(report.node!.children![0].children).toBeUndefined();
    expect(report.node!.children![0]).toMatchObject({ more: 3 });
  });

  it('finds a target by selector, marker or source position, with its source and words', () => {
    const f = frame(STYLED, 'settle', { innerWidth: 375, matchMedia: () => ({ matches: true }) });
    for (const target of ['.hero h1', '@h1abc123', '/index.html:70']) {
      f.posted.length = 0;
      const report = inspect(f, { target, depth: 0, props: [] });
      expect(report.matches, target).toBe(1);
      expect(report.node, target).toMatchObject({ tag: 'h1', src: '/index.html:70', marker: 'h1abc123', text: 'Hello' });
    }
  });

  it('keeps a leaf\'s words and an element\'s classes whole', () => {
    // A lost backslash in the emitted script turns \s into a literal s: these words and classes
    // are full of them, and an "s"-free fixture would pass either way.
    const f = frame('<p class="lens  stories" data-osw-src="/index.html:5">Fresh   pastries,\n  sweets</p>', 'settle', { innerWidth: 375, matchMedia: () => ({ matches: true }) });
    const report = inspect(f, { target: 'p', depth: 0, props: [] });
    expect(report.node).toMatchObject({ classes: ['lens', 'stories'], text: 'Fresh pastries, sweets' });
  });

  it('finds every element at a source position, and lists no screenshot host among the children', () => {
    const f = frame(STYLED + '<div data-osw-capture=""><p>painting</p></div>', 'settle', { innerWidth: 375, matchMedia: () => ({ matches: true }) });
    const bySource = inspect(f, { target: '/index.html:120', depth: 0, props: [] });
    expect(bySource.matches).toBe(2);
    expect(bySource.node!.text).toBe('one');
    f.posted.length = 0;
    expect(inspect(f, { target: null, depth: 1 }).node!.children!.map((c) => c.tag)).toEqual(['main']);
  });

  it('says how many a selector matched, and reports the first', () => {
    const f = frame(STYLED, 'settle', { innerWidth: 375, matchMedia: () => ({ matches: true }) });
    const report = inspect(f, { target: 'li', depth: 0, props: [] });
    expect(report.matches).toBe(2);
    expect(report.node!.text).toBe('one');
  });

  it('answers a selector the browser rejects with an error, not a throw', () => {
    const f = frame(STYLED, 'settle', { innerWidth: 375, matchMedia: () => ({ matches: true }) });
    expect(inspect(f, { target: '.hero >>', depth: 0 }).error).toBe('bad-selector');
  });
});
