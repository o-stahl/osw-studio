import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import ko from '@/messages/ko.json';
import { ARCHIVE_EN, ArchiveError, said } from '../text';

describe('archive text', () => {
  // `message` is rendered from ARCHIVE_EN and the UI from messages/en.json; if they drifted, the
  // English UI and the English logs would disagree about the same issue.
  it('keeps the English table and en.json identical', () => {
    expect(en.archive).toEqual(ARCHIVE_EN);
  });

  it('has every key in every language', () => {
    for (const messages of [fi, ko]) {
      expect(Object.keys(messages.archive).sort()).toEqual(Object.keys(ARCHIVE_EN).sort());
    }
  });

  it('renders each kind of function by name, in every language', () => {
    for (const [locale, messages] of [['fi', fi], ['ko', ko]] as const) {
      // next-intl answers a missing key or a formatting error with the key path, which carries
      // neither the name nor a brace; throwing makes either one fail here instead.
      const t = createTranslator({
        locale, messages, namespace: 'archive',
        onError: (error) => { throw error; },
      });
      const rendered = ['edge', 'server', 'secret', 'scheduled'].map((kind) =>
        t('invalidRecord', { kind, name: 'fn-name', detail: 'the-detail' }));
      for (const text of rendered) {
        expect(text, locale).toContain('fn-name');
        expect(text, locale).toContain('the-detail');
      }
      // Each kind is worded as itself, not collapsed into the fallback branch.
      expect(new Set(rendered).size, locale).toBe(4);
    }
  });

  it('gives a thrown error and an issue the same English', () => {
    const error = new ArchiveError('nothingToReplace', { name: 'send-email' });
    expect(error.message).toBe(said('nothingToReplace', { name: 'send-email' }).message);
    expect(error.message).toBe('"send-email" is no longer in this project, so there was nothing to replace.');
  });
});
