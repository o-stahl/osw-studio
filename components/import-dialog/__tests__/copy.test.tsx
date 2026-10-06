// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { useImportCopy } from '../copy';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function words(fn: (copy: ReturnType<typeof useImportCopy>) => string, locale: 'en' | 'fi' = 'en') {
  let out = '';
  function Probe() {
    out = fn(useImportCopy());
    return null;
  }
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : fi}>
        <Probe />
      </NextIntlClientProvider>,
    );
  });
  return out;
}

// Each count is pluralised on its own and the parts are joined as the language lists things, so
// these pin the composition, not one fixed string per case.
describe('useImportCopy', () => {
  it('words the confirm button from what it replaces', () => {
    expect(words((c) => c.confirm({ kind: 'create' }))).toBe('Create project');
    expect(words((c) => c.confirm({ kind: 'import', files: 0, backend: 0, settings: 0 }))).toBe('Import');
    expect(words((c) => c.confirm({ kind: 'import', files: 2, backend: 0, settings: 0 }))).toBe(
      'Import · replace 2 files',
    );
    expect(words((c) => c.confirm({ kind: 'import', files: 1, backend: 1, settings: 1 }))).toBe(
      'Import · replace 1 file, 1 function, and 1 setting',
    );
  });

  it('agrees the verb with the whole subject when everything matches', () => {
    expect(words((c) => c.nothingToDo({ files: 1, backend: 0 }))).toBe(
      '1 file in this archive already matches the project.',
    );
    expect(words((c) => c.nothingToDo({ files: 2, backend: 1 }))).toBe(
      '2 files and 1 server function in this archive already match the project.',
    );
    // One of each: each part is singular, the subject is not.
    expect(words((c) => c.nothingToDo({ files: 1, backend: 1 }))).toBe(
      '1 file and 1 server function in this archive already match the project.',
    );
    expect(words((c) => c.nothingToDo({ files: 0, backend: 0 }))).toBe(
      'This archive has no files to import.',
    );
  });

  it('reports what an apply wrote', () => {
    expect(words((c) => c.applied({ files: 0, backend: 0, settings: 0 }))).toBe('Nothing was written.');
    expect(words((c) => c.applied({ files: 4, backend: 2, settings: 0 }))).toBe(
      'Imported 4 files and 2 functions.',
    );
  });

  it('pluralises and lists in the interface language', () => {
    expect(words((c) => c.applied({ files: 1, backend: 3, settings: 0 }), 'fi')).toBe(
      'Tuotiin 1 tiedosto ja 3 funktiota.',
    );
  });

  it('words sizes in the locale, in whole units', () => {
    expect(words((c) => c.size(512))).toBe('512 bytes');
    expect(words((c) => c.size(1536))).toBe('2 kB');
    // Binary steps: 1500 bytes is 1.46 KiB, which a 1000-byte kilobyte would round to 2.
    expect(words((c) => c.size(1500))).toBe('1 kB');
    expect(words((c) => c.size(5 * 1024 * 1024), 'fi')).toBe('5 Mt');
  });
});
