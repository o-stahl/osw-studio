// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import fi from '@/messages/fi.json';
import { useArchiveMessage } from '@/lib/i18n/use-archive-message';
import { ArchiveError, said } from '@/lib/vfs/archive/text';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function inFinnish(item: unknown): string {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let out = '';
  function Probe() {
    out = useArchiveMessage()(item);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale="fi" messages={fi}>
        <Probe />
      </NextIntlClientProvider>,
    );
  });
  return out;
}

describe('useArchiveMessage', () => {
  it('renders an issue from its text, not its English message', () => {
    const issue = { path: '/x', code: 'path-rejected', ...said('duplicateInArchive') };
    expect(inFinnish(issue)).toBe(fi.archive.duplicateInArchive);
  });

  it('renders a thrown archive error in the interface language', () => {
    expect(inFinnish(new ArchiveError('pathTooLong', { max: 200 }))).toBe(fi.archive.pathTooLong.replace('{max}', '200'));
  });

  it('shows an error the archive layer did not word as it is', () => {
    expect(inFinnish(new Error('QuotaExceededError'))).toBe('QuotaExceededError');
  });
});
