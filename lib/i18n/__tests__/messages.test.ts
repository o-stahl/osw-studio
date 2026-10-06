import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { createTranslator } from 'next-intl';

import { locales, defaultLocale, type OfferLocale } from '../config';
import { getOfferStrings } from '../offer';
import en from '@/messages/en.json';
import ko from '@/messages/ko.json';
import fi from '@/messages/fi.json';
import offers from '@/messages/offer.json';

const byLocale: Record<string, unknown> = { en, ko, fi };
const translations = locales.filter((locale) => locale !== defaultLocale) as OfferLocale[];

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (out, [key, child]) => Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key)),
    {},
  );
}

const enKeys = flatten(en);

it('has a message file for every declared locale, so adding one cannot be half done', () => {
  // The file `i18n/request.ts` imports as `../messages/${locale}.json`.
  const dir = path.resolve(__dirname, '../../../messages');
  for (const locale of locales) expect(fs.existsSync(path.join(dir, `${locale}.json`)), locale).toBe(true);
});

describe.each(translations)('%s.json', (locale) => {
  it('introduces no key that English does not define', () => {
    // English is the typed source of truth, so an extra key here is unreachable and untyped.
    const keys = flatten(byLocale[locale]);
    expect(Object.keys(keys).filter((key) => !(key in enKeys))).toEqual([]);
  });
});

describe.each(locales)('%s.json ICU', (locale) => {
  it('parses every message', () => {
    for (const [key, message] of Object.entries(flatten(byLocale[locale]))) {
      expect(() => parse(message), `${locale}: ${key}`).not.toThrow();
    }
  });
});

/**
 * Completeness is a tsc error in lib/i18n/offer.ts, so what is left to check at runtime is that the
 * strings are real and parseable, and that English is genuinely absent rather than merely unused.
 */
describe('offer strings', () => {
  it.each(translations)('%s has non-empty, parseable strings', (locale) => {
    const strings = getOfferStrings(locale);
    for (const [key, value] of Object.entries(strings)) {
      expect(value.trim(), `${locale}.${key}`).not.toBe('');
      expect(() => parse(value), `${locale}.${key}`).not.toThrow();
    }
  });

  it('mentions the language it offers, in that language', () => {
    // The point of the offer is that a reader who cannot read English still understands it.
    expect(getOfferStrings('ko').accept).toMatch(/한국어/);
    expect(getOfferStrings('fi').accept).toMatch(/suomeksi/i);
  });

  it('carries no entry for the default locale', () => {
    expect(Object.keys(offers)).not.toContain(defaultLocale);
  });
});

/**
 * The messages that take a variable, formatted in every locale.
 *
 * Parsing only proves the ICU is well formed; it says nothing about the placeholder being the name
 * the call site passes. A translator who writes {versio} instead of {version} produces a message
 * that parses and then renders the placeholder name to the user.
 */
/** Every argument and tag name a message uses, including those inside plural/select branches and tags. */
function argumentNames(message: string): Set<string> {
  const names = new Set<string>();
  (function walk(nodes: MessageFormatElement[]) {
    for (const node of nodes) {
      if (node.type === TYPE.argument || node.type === TYPE.number || node.type === TYPE.date || node.type === TYPE.time) {
        names.add(node.value);
      }
      if (node.type === TYPE.tag) {
        names.add(`<${node.value}>`);
        walk(node.children);
      }
      if (node.type === TYPE.plural || node.type === TYPE.select) {
        names.add(node.value);
        for (const option of Object.values(node.options)) walk(option.value);
      }
    }
  })(parse(message));
  return names;
}

/**
 * Arguments the call site passes although the English message has no use for them. Every tally label
 * is rendered as `t(tally.label, { count })` (components/import-dialog/sections.tsx), and Finnish
 * inflects "new" and "identical" for number where English does not.
 */
const PASSED_BUT_UNUSED_IN_ENGLISH: Record<string, string[]> = {
  'importDialog.tally.new': ['count'],
  'importDialog.tally.identical': ['count'],
};

describe('messages with variables', () => {
  /**
   * A translation may leave an argument out (ko has no plural forms to branch on), but every name it
   * uses must be one the call site passes, which is what the English message for the key declares.
   */
  it.each(translations)('%s uses only the arguments English declares for each key', (locale) => {
    const misnamed: string[] = [];
    for (const [key, message] of Object.entries(flatten(byLocale[locale]))) {
      if (!(key in enKeys)) continue;
      const declared = new Set([...argumentNames(enKeys[key]), ...(PASSED_BUT_UNUSED_IN_ENGLISH[key] ?? [])]);
      for (const name of argumentNames(message)) {
        if (!declared.has(name)) misnamed.push(`${key}: ${name}`);
      }
    }
    expect(misnamed).toEqual([]);
  });


  it.each(locales)('%s formats the placeholders it declares', (locale) => {
    const t = createTranslator({ locale, messages: byLocale[locale] as typeof en });

    expect(t('dashboard.whatsNewIn', { version: '1.104.1' })).toContain('1.104.1');
    expect(t('projects.preview', { name: 'Papertop' })).toContain('Papertop');
    // A rendered placeholder name is the tell that the variable was misspelled.
    expect(t('dashboard.whatsNewIn', { version: '1.104.1' })).not.toMatch(/\{|\}/);
    expect(t('projects.preview', { name: 'Papertop' })).not.toMatch(/\{|\}/);
  });
});
