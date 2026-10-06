// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import fi from '@/messages/fi.json';
import { useBlockCatalog } from '@/lib/i18n/use-block-catalog';
import { useInterviewCatalog } from '@/lib/i18n/use-interview-catalog';
import { useTemplateCatalog } from '@/lib/i18n/use-template-catalog';
import { useSkillGroupCatalog, useSkillGroupCopy } from '@/lib/i18n/use-skill-group-catalog';
import { useRuntimeDescriptions } from '@/lib/i18n/use-runtime-descriptions';
import { useModelTemplateCopy } from '@/lib/i18n/use-model-template-copy';
import { useProviderDescriptions } from '@/lib/i18n/use-provider-descriptions';
import { useTemplateIntents } from '@/lib/i18n/use-template-intents';
import { useViewNames } from '@/lib/i18n/use-view-names';
import { useCheckpointLabel } from '@/lib/i18n/use-checkpoint-label';
import { useArchiveMessage } from '@/lib/i18n/use-archive-message';
import { useStylePropLabels } from '@/lib/i18n/use-style-prop-labels';
import { WRITABLE_PROPERTIES } from '@/components/styles-content/properties';
import type { SkillGroup } from '@/lib/vfs/skills/types';

/**
 * The registry hooks map an id to its own message. Coverage tests elsewhere check every id has
 * some translated copy; these check it is the right copy, under `fi` so a fallback shows.
 */
const tFi = createTranslator({ locale: 'fi', messages: fi });

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

function readHook<T>(hook: () => T): T {
  let value: T | undefined;
  function Probe() {
    value = hook();
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale="fi" messages={fi} timeZone="UTC">
        <Probe />
      </NextIntlClientProvider>
    );
  });
  return value as T;
}

type Copy = Record<string, { name?: string; title?: string; description: string }>;

describe('catalog hooks give each id its own message', () => {
  it('semantic blocks', () => {
    const copy = readHook(useBlockCatalog);
    const blocks = fi.semanticBlocks.blocks as Copy;
    for (const [id, entry] of Object.entries(copy)) {
      expect(entry, id).toEqual({ name: blocks[id].name, description: blocks[id].description });
    }
  });

  it('interviews', () => {
    const copy = readHook(useInterviewCatalog);
    const catalog = fi.interviewCatalog as Copy;
    for (const [id, entry] of Object.entries(copy)) {
      expect(entry, id).toEqual({ title: catalog[id].title, description: catalog[id].description });
    }
  });

  it('templates', () => {
    const copy = readHook(useTemplateCatalog);
    const catalog = fi.templateCatalog as Copy;
    for (const [id, entry] of Object.entries(copy)) {
      expect(entry, id).toEqual({ name: catalog[id].name, description: catalog[id].description });
    }
  });

  it('skill groups', () => {
    const copy = readHook(useSkillGroupCatalog);
    const catalog = fi.skillGroups as Copy;
    for (const [id, entry] of Object.entries(copy)) {
      expect(entry, id).toEqual({ name: catalog[id].name, description: catalog[id].description });
    }
  });

  it('runtimes', () => {
    const copy = readHook(useRuntimeDescriptions);
    for (const [id, text] of Object.entries(copy)) {
      expect(text, id).toBe((fi.runtimes as Record<string, string>)[id]);
    }
  });

  it('views', () => {
    const names = readHook(useViewNames);
    expect(names.mail).toBe(fi.nav.settings.mail);
    expect(names.users).toBe(fi.nav.settings.users);
    expect(names.interviews).toBe(fi.nav.items.interviews);
  });

  it('template intents, falling back for an intent it does not know', () => {
    const intent = readHook(useTemplateIntents);
    const fallback = { label: 'Other', description: 'other' };
    expect(intent('app', fallback)).toEqual(fi.templatesUi.intents.app);
    expect(intent('website', fallback)).toEqual(fi.templatesUi.intents.website);
    expect(intent('something-new', fallback)).toBe(fallback);
  });
});

describe('copy that falls back to what was written', () => {
  it('model templates: the two recommended ones translated, a custom one as written', () => {
    const copy = readHook(useModelTemplateCopy);
    expect(copy({ id: 'hf-recommended', name: 'HF', builtin: true })).toEqual({ name: fi.modelTemplates.hfRecommended, description: fi.modelTemplates.recommendedDescription });
    expect(copy({ id: 'or-recommended', name: 'OR', builtin: true }).name).toBe(fi.modelTemplates.orRecommended);
    expect(copy({ id: 'mine', name: 'Mine', description: 'my notes' })).toEqual({ name: 'Mine', description: 'my notes' });
    expect(copy({ id: 'bare', name: 'Bare' })).toEqual({ name: 'Bare', description: '' });
  });

  it('skill groups: a custom one keeps its own description', () => {
    const copy = readHook(useSkillGroupCopy);
    const custom = { id: 'mine', name: 'Mine', description: 'my notes', isBuiltIn: false } as unknown as SkillGroup;
    expect(copy(custom)).toEqual({ name: 'Mine', description: 'my notes' });
  });

  it('providers: built-in translated, a custom endpoint named by its URL, else as written', () => {
    const describe = readHook(useProviderDescriptions);
    expect(describe({ id: 'openai', description: 'English' })).toBe(fi.providerCatalog.descriptions.openai);
    expect(describe({ id: 'custom-1', description: 'English', baseUrl: 'http://box:8080/v1' }))
      .toBe(tFi('providerCatalog.custom', { url: 'http://box:8080/v1' }));
    expect(describe({ id: 'custom-2', description: 'Typed by the user' })).toBe('Typed by the user');
  });

  it('checkpoints: a labelled one translated, with its time; an unlabelled one as stored', () => {
    const label = readHook(useCheckpointLabel);
    expect(label({ description: 'typed', timestamp: '2026-10-03T12:00:00Z' })).toBe('typed');
    expect(label({ description: 'After: x', label: { key: 'afterPrompt', values: { prompt: 'x' } }, timestamp: '2026-10-03T12:00:00Z' } as never))
      .toBe(tFi('checkpoints.afterPrompt', { prompt: 'x' }));
    const saved = label({ description: 'Manual', label: { key: 'manualSave' }, timestamp: '2026-10-03T12:34:56Z' } as never);
    expect(saved).toContain('34');
    expect(saved).not.toContain('{time}');
    expect(saved).not.toContain('2026-10-03T');
  });

  it('archive messages: anything without text or a message is shown as itself', () => {
    const word = readHook(useArchiveMessage);
    expect(word('a bare string')).toBe('a bare string');
  });

  it('style labels: each radius corner by its own name', () => {
    const sp = readHook(useStylePropLabels);
    const corner = (property: string) => sp.label(WRITABLE_PROPERTIES.find((e) => e.property === property)!);
    expect(corner('border-top-left-radius')).toBe(fi.styleProps.sides.topLeft);
    expect(corner('border-top-right-radius')).toBe(fi.styleProps.sides.topRight);
    expect(corner('border-bottom-right-radius')).toBe(fi.styleProps.sides.bottomRight);
    expect(corner('border-bottom-left-radius')).toBe(fi.styleProps.sides.bottomLeft);
  });
});
