// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import fi from '@/messages/fi.json';
import { useStylePropLabels } from '@/lib/i18n/use-style-prop-labels';
import { useTemplateCatalog } from '@/lib/i18n/use-template-catalog';
import { useBlockCatalog, useBlockCategories } from '@/lib/i18n/use-block-catalog';
import { useInterviewCatalog } from '@/lib/i18n/use-interview-catalog';
import { useRuntimeDescriptions } from '@/lib/i18n/use-runtime-descriptions';
import { useSkillGroupCatalog, useSkillGroupCopy } from '@/lib/i18n/use-skill-group-catalog';
import type { SkillGroup } from '@/lib/vfs/skills/types';
import { useModelTemplateCopy } from '@/lib/i18n/use-model-template-copy';
import { BUILT_IN_MODEL_TEMPLATES } from '@/lib/llm/models/registry';
import { BUILT_IN_GROUPS } from '@/lib/vfs/skills/registry';
import { SEMANTIC_BLOCKS, BLOCK_CATEGORIES } from '@/lib/semantic-blocks/registry';
import { BUILT_IN_INTERVIEWS } from '@/lib/interview/templates';
import { RUNTIME_CONFIGS } from '@/lib/runtimes/registry';
import { BUILT_IN_TEMPLATES } from '@/lib/vfs/templates';
import { STYLE_PROPERTIES, WRITABLE_PROPERTIES } from '@/components/styles-content/properties';
import { FACET_KEYS, GLOSS_KEYS, NOTE_KEYS } from '@/components/permissions/PermissionMatrix';
import { GATE_COMMANDS, ALWAYS_ALLOWED_NOTES } from '@/lib/llm/permissions';

/**
 * The registry hooks resolve a constant's id to a translated string and fall back to the English
 * already in the constant when no key matches. That fallback is deliberate — a missing key must not
 * blank the UI — but it means an entry added to the table without a message renders English with
 * nothing failing: `tsc` sees only literal `t()` calls, and the key check sees matching key sets.
 *
 * Reading the labels under a non-English locale is what distinguishes "translated" from "fell back",
 * so these tests render against `fi` rather than `en`.
 */
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

/** Renders a probe that reports what the hook resolves, under the Finnish messages. */
function readLabels(): { group: string[]; label: string[]; option: string[]; optionsOf: Record<string, string[]> } {
  const out = { group: [] as string[], label: [] as string[], option: [] as string[], optionsOf: {} as Record<string, string[]> };

  function Probe() {
    const sp = useStylePropLabels();
    for (const entry of STYLE_PROPERTIES) {
      if (!out.group.includes(sp.group(entry.group))) out.group.push(sp.group(entry.group));
      if (entry.control === 'segmented') {
        for (const option of entry.options) {
          const text = sp.option(entry.property, option.value, option.label);
          out.option.push(text);
          (out.optionsOf[entry.property] ??= []).push(text);
        }
      }
    }
    for (const entry of WRITABLE_PROPERTIES) out.label.push(sp.label(entry));
    return null;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale="fi" messages={fi}>
        <Probe />
      </NextIntlClientProvider>
    );
  });
  return out;
}

describe('useStylePropLabels', () => {
  it('translates every group in the property table', () => {
    const { group } = readLabels();
    const english = STYLE_PROPERTIES.map(e => e.group);
    expect(group.length).toBeGreaterThan(0);
    expect(group.filter(g => english.includes(g as never))).toEqual([]);
  });

  it('translates every writable property, including the expanded sides', () => {
    const { label } = readLabels();
    const english = WRITABLE_PROPERTIES.map(e => e.label);
    expect(label).toHaveLength(WRITABLE_PROPERTIES.length);
    // A fallback would come back as the entry's own English label.
    expect(label.filter(l => english.includes(l))).toEqual([]);
  });

  it('leaves the display keywords in English and translates the rest', () => {
    const { optionsOf } = readLabels();
    // The display values are the CSS the user writes, so every one stays as the table words it,
    // `none` included, even though border-style's `none` is translated.
    const display = STYLE_PROPERTIES.find((e) => e.property === 'display');
    expect(display?.control).toBe('segmented');
    const displayLabels = display && display.control === 'segmented' ? display.options.map((o) => o.label) : [];
    expect(displayLabels).toContain('Hidden');
    expect(optionsOf.display).toEqual(displayLabels);
    // border-style and text-align are prose and must not come back English.
    expect(optionsOf['border-style']).toContain(fi.styleProps.borderStyle.solid);
    expect(optionsOf['text-align']).toContain(fi.styleProps.sides.center);
  });
});

describe('useTemplateCatalog', () => {
  it('has translated copy for every built-in template', () => {
    let catalog: ReturnType<typeof useTemplateCatalog> = {};
    function Probe() {
      catalog = useTemplateCatalog();
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <NextIntlClientProvider locale="fi" messages={fi}>
          <Probe />
        </NextIntlClientProvider>
      );
    });

    const missing = BUILT_IN_TEMPLATES.filter((tpl) => !catalog[tpl.id]).map((tpl) => tpl.id);
    expect(missing).toEqual([]);
    // Present but untranslated would show the registry's English name. Two names are the same in
    // every language on purpose: a fictional company's name, and a framework's.
    const SAME_IN_EVERY_LANGUAGE = new Set(['demo', 'spring-rest-postgres']);
    const english = BUILT_IN_TEMPLATES
      .filter((tpl) => !SAME_IN_EVERY_LANGUAGE.has(tpl.id) && catalog[tpl.id]?.name === tpl.name)
      .map((tpl) => tpl.id);
    expect(english).toEqual([]);
  });
});

/**
 * The other registries keyed by string, which `tsc` cannot check for completeness: each id the
 * registry declares must have an entry in its hook. Rendered under `fi` like the rest of this file.
 */
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
      <NextIntlClientProvider locale="fi" messages={fi}>
        <Probe />
      </NextIntlClientProvider>
    );
  });
  return value as T;
}

describe('registry hooks keyed by string', () => {
  it('cover every semantic block', () => {
    const copy = readHook(useBlockCatalog);
    expect(SEMANTIC_BLOCKS.filter((b) => !copy[b.id]).map((b) => b.id)).toEqual([]);
  });

  it('cover every block category', () => {
    const copy = readHook(useBlockCategories);
    expect(BLOCK_CATEGORIES.filter((c) => !copy[c]).map((c) => c)).toEqual([]);
  });

  it('cover every built-in interview', () => {
    const copy = readHook(useInterviewCatalog);
    expect(BUILT_IN_INTERVIEWS.filter((i) => !copy[i.id]).map((i) => i.id)).toEqual([]);
  });

  it('cover every built-in skill group', () => {
    const copy = readHook(useSkillGroupCatalog);
    expect(BUILT_IN_GROUPS.filter((g) => !copy[g.id]).map((g) => g.id)).toEqual([]);
  });

  it('show a built-in skill group translated and a custom one as written', () => {
    const copy = readHook(useSkillGroupCopy);
    const group = { ...BUILT_IN_GROUPS[0], isBuiltIn: true } as unknown as SkillGroup;
    expect(copy(group).name).toBe(fi.skillGroups[group.id as keyof typeof fi.skillGroups].name);
    expect(copy({ ...group, isBuiltIn: false, name: 'My group' }).name).toBe('My group');
  });

  it('cover every built-in model template', () => {
    const copy = readHook(useModelTemplateCopy);
    // A built-in id the hook does not know falls back to the English name in the registry.
    const fallen = BUILT_IN_MODEL_TEMPLATES.filter((tpl) => copy(tpl).name === tpl.name).map((tpl) => tpl.id);
    expect(fallen).toEqual([]);
  });

  it('cover every runtime', () => {
    const copy = readHook(useRuntimeDescriptions);
    expect(RUNTIME_CONFIGS.filter((r) => !copy[r.id]).map((r) => r.id)).toEqual([]);
  });
});

/**
 * The permission matrix words `GATE_COMMANDS` and `ALWAYS_ALLOWED_NOTES` through id maps, falling
 * back to their English. A new note, facet or parenthetical gloss needs an entry there.
 */
describe('PermissionMatrix label maps', () => {
  const permissions = (fi as unknown as { permissions: Record<string, Record<string, unknown>> }).permissions;
  const resolves = (key: string) => {
    const [group, leaf] = key.split('.');
    return typeof permissions[group]?.[leaf] === 'string';
  };

  it('covers every always-allowed note', () => {
    for (const note of ALWAYS_ALLOWED_NOTES) {
      const key = (NOTE_KEYS as Record<string, string>)[note.command];
      expect(key, note.command).toBeDefined();
      expect(resolves(key), key).toBe(true);
    }
  });

  it('covers every facet', () => {
    const facets = new Set(GATE_COMMANDS.flatMap((c) => c.keys).filter((k) => k.includes(':')).map((k) => k.split(':')[1]));
    for (const facet of facets) {
      const key = (FACET_KEYS as Record<string, string>)[facet];
      expect(key, facet).toBeDefined();
      expect(resolves(key), key).toBe(true);
    }
  });

  it('covers every parenthetical gloss but the ripgrep name', () => {
    for (const cmd of GATE_COMMANDS.filter((c) => / \(.*\)$/.test(c.label) && c.command !== 'rg')) {
      const key = (GLOSS_KEYS as Record<string, string>)[cmd.command];
      expect(key, cmd.command).toBeDefined();
      expect(resolves(key), key).toBe(true);
    }
  });
});
