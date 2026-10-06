import { describe, it, expect } from 'vitest';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

import fi from '@/messages/fi.json';
import ko from '@/messages/ko.json';

/**
 * The terminology each locale settled on, enforced.
 *
 * These were not chosen here: each one is what the existing translations already used by a wide
 * margin when this file was written, so a rule records a convention rather than inventing one. The
 * failure they guard against is a translator (person or model) working file by file without reading
 * how the rest of the catalogue renders the same word, which produced, among others, a checkpoint
 * panel whose tab said "Checkpointit" while its body said "tarkistuspisteitä".
 *
 * A rule is a pattern that must not appear, with the word to use instead. `only` narrows a rule to
 * keys under one prefix, for a word that is wrong in one place and fine in another.
 */
interface Rule {
  forbid: RegExp;
  use: string;
  why: string;
  only?: string;
}

const GLOSSARY: Record<'fi' | 'ko', Rule[]> = {
  fi: [
    { forbid: /deploy/i, use: 'julkaisu', why: 'the Deployments view is "Julkaisut"' },
    { forbid: /tarkistuspist/i, use: 'checkpoint', why: 'the panel and its tab say "Checkpointit"' },
    { forbid: /työtil/i, use: 'workspace', why: 'established as the loanword throughout' },
    // `secrets.get` and SECRETS_ENCRYPTION_KEY are code, so only the word as Finnish is matched.
    { forbid: /\bSecret|\bsecret(in|it|tien|ia|eja)\b/, use: 'salaisuus', why: 'the Secrets manager says "Salaisuudet"' },
    { forbid: /server-til/i, use: 'palvelintila', why: 'Server Mode is "Palvelintila" in its own setting' },
    { forbid: /aloitus$/i, use: 'pohja', why: 'a template is a "pohja"; "aloitus" read as a step, not a thing', only: 'templateCatalog.' },
  ],
  ko: [
    // The catalogue's voice is 해요체 (…어요); a 합니다체 string reads as a register change mid-panel.
    { forbid: /니다/, use: '해요체 (…어요/…해요)', why: 'the catalogue is written in 해요체' },
    { forbid: /게시/, use: '배포', why: 'Publish is "배포" in every action label' },
  ],
};

function entries(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => entries(child, prefix ? `${prefix}.${key}` : key));
}

/**
 * The words a reader sees, without argument names. `{deployment}` is a variable, and a rule about
 * the word "deployment" has no business matching it; plural branches and tag contents are prose.
 */
function prose(message: string): string {
  const out: string[] = [];
  (function walk(nodes: MessageFormatElement[]) {
    for (const node of nodes) {
      if (node.type === TYPE.literal) out.push(node.value);
      if (node.type === TYPE.tag) walk(node.children);
      if (node.type === TYPE.plural || node.type === TYPE.select) {
        for (const option of Object.values(node.options)) walk(option.value);
      }
    }
  })(parse(message));
  return out.join('');
}

const MESSAGES = { fi, ko };

describe.each(Object.keys(GLOSSARY) as Array<keyof typeof GLOSSARY>)('%s glossary', (locale) => {
  const all = entries(MESSAGES[locale]);

  it.each(GLOSSARY[locale].map((rule) => [rule.use, rule] as const))('uses "%s"', (_use, rule) => {
    const violations = all
      .filter(([key]) => !rule.only || key.startsWith(rule.only))
      .filter(([, text]) => rule.forbid.test(prose(text)))
      .map(([key, text]) => `${key}: ${text}`);
    expect(violations, `use "${rule.use}" (${rule.why})`).toEqual([]);
  });
});
