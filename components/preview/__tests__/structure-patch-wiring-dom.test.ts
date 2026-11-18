// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import { injectProvenance } from '@/lib/preview/provenance';
import {
  moveElement,
  wrapElement,
  unwrapElement,
  duplicateElement,
  removeElement,
  insertElement,
  type StructureResult,
  type StructureEdit,
} from '@/lib/direct-edit/structure';
import type { StructurePatchOp } from '@/lib/preview/types';

/**
 * A structural edit shown in the frame before the recompile, through the frame's own handler.
 *
 * The claim is exact: after the patch, the frame's elements and every `data-osw-src` they carry are
 * what a recompile of the new source would produce. So each case builds the frame from the old
 * source with provenance, sends the patch, and compares with the new source compiled the same way.
 *
 * One script instance for the file: each `new Function(...)` run adds another `message` listener.
 */

const FILE = '/index.html';
const posted: { type?: string; ok?: boolean; payload?: { srcAttr?: string } }[] = [];

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

/** Every element in the body, as tag and provenance, in document order. */
function described(): string[] {
  return Array.from(document.body.querySelectorAll('*'), el => `${el.tagName.toLowerCase()}@${el.getAttribute('data-osw-src') ?? '-'}`);
}

/** What a recompile of `source` would show. */
function compiled(source: string): string[] {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = injectProvenance(source, FILE);
  return Array.from(doc.body.querySelectorAll('*'), el => `${el.tagName.toLowerCase()}@${el.getAttribute('data-osw-src') ?? '-'}`);
}

function edited(result: StructureResult): StructureEdit {
  expect(result.ok).toBe(true);
  return (result as { ok: true; edit: StructureEdit }).edit;
}

const src = (source: string, needle: string) => `${FILE}:${source.indexOf(needle)}`;

/** Load `source` as the frame's document, patch it, and expect the recompiled document. */
function expectPatched(source: string, edit: StructureEdit, op: StructurePatchOp): void {
  document.body.innerHTML = injectProvenance(source, FILE);
  posted.length = 0;
  send({ type: 'structure-patch', file: FILE, pieces: edit.pieces, op, created: edit.created });
  expect(posted.find(m => m.type === 'structure-patched')?.ok).toBe(true);
  expect(described()).toEqual(compiled(edit.content));
}

const SOURCE = [
  '<main>',
  '  <ul class="list">',
  '    <li>One</li>',
  '    <li>Two <b>bold</b></li>',
  '    <li>Three</li>',
  '  </ul>',
  '  <div data-osw-frame class="frame">',
  '    <p class="a">A</p>',
  '    <p class="b">B</p>',
  '  </div>',
  '  <p class="after" data-osw-id="aaaaaaaa">After <i>x</i></p>',
  '</main>',
  '',
].join('\n');

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: { type?: string }) => { posted.push(message); } },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  posted.length = 0;
});

describe('structure-patch', () => {
  it('moves an element and renames every element of the file as the recompile would', () => {
    const edit = edited(moveElement(SOURCE, SOURCE.indexOf('<li>Three'), { before: SOURCE.indexOf('<li>One') }));
    expectPatched(SOURCE, edit, { kind: 'move', target: src(SOURCE, '<li>Three'), place: { before: src(SOURCE, '<li>One') } });
  });

  it('moves into another parent, re-indented', () => {
    const edit = edited(moveElement(SOURCE, SOURCE.indexOf('<p class="after"'), { parent: SOURCE.indexOf('<ul'), at: 'end' }));
    expectPatched(SOURCE, edit, { kind: 'move', target: src(SOURCE, '<p class="after"'), place: { parent: src(SOURCE, '<ul'), at: 'end' } });
  });

  it('wraps an element in a frame', () => {
    const html = '<div data-osw-frame data-osw-id="ffffffff"></div>';
    const edit = edited(wrapElement(SOURCE, SOURCE.indexOf('<ul'), '<div data-osw-frame data-osw-id="ffffffff">', '</div>'));
    expectPatched(SOURCE, edit, { kind: 'wrap', target: src(SOURCE, '<ul'), html });
    expect(document.querySelector('[data-osw-id="ffffffff"] > ul.list')).not.toBeNull();
  });

  it('unwraps a frame', () => {
    const edit = edited(unwrapElement(SOURCE, SOURCE.indexOf('<div data-osw-frame')));
    expectPatched(SOURCE, edit, { kind: 'unwrap', target: src(SOURCE, '<div data-osw-frame') });
  });

  it('duplicates with the copy\'s markers renamed', () => {
    const edit = edited(duplicateElement(SOURCE, SOURCE.indexOf('<p class="after"'), m => m.replace('aaaaaaaa', 'bbbbbbbb')));
    expectPatched(SOURCE, edit, { kind: 'duplicate', target: src(SOURCE, '<p class="after"'), ids: { aaaaaaaa: 'bbbbbbbb' } });
    expect(Array.from(document.querySelectorAll('[data-osw-id]'), el => el.getAttribute('data-osw-id'))).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('leaves a copy to the recompile when its elements are not its source tags one for one', () => {
    // A `{{#each}}` inside the copied element renders one tag three times, and an `{{#if}}` that is
    // false renders it not at all: either way the copy's elements cannot be paired with the copy's
    // tags by position.
    const source = ['<main>', '  <ul class="list">', '    <li>Item</li>', '  </ul>', '</main>', ''].join('\n');
    const edit = edited(duplicateElement(source, source.indexOf('<ul'), m => m));
    const op: StructurePatchOp = { kind: 'duplicate', target: src(source, '<ul'), ids: {} };

    document.body.innerHTML = injectProvenance(source, FILE);
    const li = document.querySelector('li')!;
    li.after(li.cloneNode(true), li.cloneNode(true));
    const repeated = described();
    send({ type: 'structure-patch', file: FILE, pieces: edit.pieces, op, created: edit.created });
    expect(posted.find(m => m.type === 'structure-patched')?.ok).toBe(false);
    expect(described()).toEqual(repeated);

    posted.length = 0;
    document.body.innerHTML = injectProvenance(source, FILE);
    document.querySelector('li')!.remove();
    const none = described();
    send({ type: 'structure-patch', file: FILE, pieces: edit.pieces, op, created: edit.created });
    expect(posted.find(m => m.type === 'structure-patched')?.ok).toBe(false);
    expect(described()).toEqual(none);
  });

  it('deletes', () => {
    const edit = edited(removeElement(SOURCE, SOURCE.indexOf('<li>Two')));
    expectPatched(SOURCE, edit, { kind: 'delete', target: src(SOURCE, '<li>Two') });
  });

  it('inserts, giving the new element its offset', () => {
    const markup = '<hr data-osw-id="cccccccc">';
    const edit = edited(insertElement(SOURCE, { after: SOURCE.indexOf('<p class="a"') }, markup));
    expectPatched(SOURCE, edit, { kind: 'insert', place: { after: src(SOURCE, '<p class="a"') }, html: markup });
  });

  it('leaves elements of other files alone', () => {
    const edit = edited(removeElement(SOURCE, SOURCE.indexOf('<li>One')));
    document.body.innerHTML = injectProvenance(SOURCE, FILE) + '<footer data-osw-src="/templates/footer.hbs:12"></footer>';
    send({ type: 'structure-patch', file: FILE, pieces: edit.pieces, op: { kind: 'delete', target: src(SOURCE, '<li>One') }, created: [] });
    expect(document.querySelector('footer')!.getAttribute('data-osw-src')).toBe('/templates/footer.hbs:12');
  });

  it('answers not-applied when the element is not there, and changes nothing', () => {
    document.body.innerHTML = injectProvenance(SOURCE, FILE);
    const before = described();
    send({ type: 'structure-patch', file: FILE, pieces: [[0, SOURCE.length]], op: { kind: 'delete', target: `${FILE}:9999` }, created: [] });
    expect(posted.find(m => m.type === 'structure-patched')?.ok).toBe(false);
    expect(described()).toEqual(before);
  });
});

describe('select-src', () => {
  it('selects the element by its data-osw-src, as a tree selection would', () => {
    document.body.innerHTML = injectProvenance(SOURCE, FILE);
    send({ type: 'select-src', src: src(SOURCE, '<p class="b"') });
    const selection = posted.find(m => m.type === 'selector-selection');
    expect(selection?.payload?.srcAttr).toBe(src(SOURCE, '<p class="b"'));
  });
});
