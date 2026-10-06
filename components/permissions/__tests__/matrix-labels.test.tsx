// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import { PermissionMatrix, GLOSS_KEYS, NOTE_KEYS } from '../PermissionMatrix';
import { GATE_COMMANDS, ALWAYS_ALLOWED_NOTES } from '@/lib/llm/permissions';
import { deepMerge } from '@/lib/i18n/merge';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';

/**
 * The permission matrix keeps the English command names (they are what the agent types) and words
 * their glosses, facets and the always-allowed reasons in the interface language.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <NextIntlClientProvider locale="fi" messages={deepMerge(en, fi)}>
        <PermissionMatrix />
      </NextIntlClientProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PermissionMatrix in Finnish', () => {
  it('glosses each command in the interface language, replacing the English gloss', () => {
    const glossed = GATE_COMMANDS.filter((c) => c.command in GLOSS_KEYS);
    expect(glossed.length).toBeGreaterThan(0);
    for (const cmd of glossed) {
      // Read from the messages by the command's own name, not through the component's table, so a
      // command wired to another command's gloss fails here.
      const gloss = fi.permissions.gloss[cmd.command as keyof typeof fi.permissions.gloss];
      expect(container.textContent, cmd.command).toContain(`${cmd.label.replace(/ \(.*\)$/, '')} (${gloss})`);
    }
    expect(container.textContent).not.toContain('cat (read file)');
  });

  it('leaves a command with no gloss as it is', () => {
    expect(container.textContent).toContain('head');
  });

  it('gives each always-allowed command its translated reason', () => {
    for (const note of ALWAYS_ALLOWED_NOTES) {
      expect(NOTE_KEYS[note.command as keyof typeof NOTE_KEYS], note.command).toBeTruthy();
      const camel = note.command.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
      expect(container.textContent).toContain(fi.permissions.notes[camel as keyof typeof fi.permissions.notes]);
      expect(container.textContent).not.toContain(note.reason);
    }
  });

  it('names the read and write sides of a command in Finnish', () => {
    expect(container.textContent).toContain(fi.permissions.facets.read);
    expect(container.textContent).toContain(fi.permissions.facets.write);
  });
});
