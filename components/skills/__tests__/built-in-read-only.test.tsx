// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const service = vi.hoisted(() => ({
  updateSkill: vi.fn(), createSkill: vi.fn(),
  getAllSkills: vi.fn(async (): Promise<unknown[]> => []), getAllGroups: vi.fn(async () => []),
  isGloballyEnabled: vi.fn(async () => true), isEvaluationEnabled: vi.fn(async () => false),
  isSkillEnabled: vi.fn(async () => false), isGroupEnabled: vi.fn(async () => false),
}));
vi.mock('@/lib/vfs/skills', () => ({ skillsService: service }));
vi.mock('@/lib/vfs', () => ({ vfs: { reloadTransientSkills: vi.fn() } }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ ViewModeToggle: () => null, useViewMode: () => ['table', () => {}] }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { Skill } from '@/lib/vfs/skills/types';
import { SkillEditor } from '../SkillEditor';
import { SkillsManager } from '../SkillsManager';

/**
 * A skill opened from the Skills page. Built-in skills ship with the app and cannot be changed, so
 * one opens for reading: nothing to type into and no Save. A custom skill opens for editing.
 */

let container: HTMLElement;
let root: Root;

const skill = (isBuiltIn: boolean) => ({
  id: 'frontend-design', name: 'frontend-design', description: 'Distinctive interfaces',
  markdown: '# Frontend design', content: '---\nname: frontend-design\ndescription: Distinctive interfaces\n---\n# Frontend design',
  isBuiltIn, updatedAt: new Date('2026-01-01'),
}) as unknown as Skill;

function open(s: Skill) {
  act(() => {
    root.render(withMessages(<SkillEditor skill={s} mode="edit" onSave={() => {}} onCancel={() => {}} />));
  });
}

const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent!.trim());
const fields = () => [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no ResizeObserver; the page measures its rows with one.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('SkillEditor', () => {
  const editingHelp = [en.skills.editor.nameHelp, en.skills.editor.descHelp];
  const rawTab = () => [...container.querySelectorAll('button')].find((b) => b.textContent!.trim() === en.skills.editor.rawMarkdown)!;

  it('opens a built-in skill for reading, with nothing to change, no Save and no editing help', () => {
    open(skill(true));

    expect(buttons()).not.toContain(en.skills.editor.saveSkill);
    expect(fields().length).toBeGreaterThan(0);
    expect(fields().every((f) => f.readOnly)).toBe(true);
    for (const help of editingHelp) expect(container.textContent).not.toContain(help);
    act(() => rawTab().click());
    expect(container.textContent).not.toContain(en.skills.editor.rawHelp);
  });

  it('opens a custom skill for editing, with its help', () => {
    open(skill(false));

    expect(buttons()).toContain(en.skills.editor.saveSkill);
    expect(fields().some((f) => !f.readOnly)).toBe(true);
    for (const help of editingHelp) expect(container.textContent).toContain(help);
    act(() => rawTab().click());
    expect(container.textContent).toContain(en.skills.editor.rawHelp);
  });
});

describe('the Skills page', () => {
  it('offers a built-in skill to view, a custom one to edit, and opens the built-in one for reading', async () => {
    service.getAllSkills.mockResolvedValue([skill(true), { ...skill(false), id: 'my-forms', name: 'my-forms' }]);
    await act(async () => { root.render(withMessages(<SkillsManager />)); });

    const row = (name: string) => [...container.querySelectorAll('tr')].find((tr) => tr.textContent!.includes(name))!;
    const action = (name: string) => [...row(name).querySelectorAll('button')]
      .find((b) => [en.common.actions.view, en.common.actions.edit].includes(b.textContent!.trim()))!;
    expect(action('frontend-design').textContent!.trim()).toBe(en.common.actions.view);
    expect(action('my-forms').textContent!.trim()).toBe(en.common.actions.edit);

    await act(async () => { action('frontend-design').click(); });

    expect(document.body.textContent).toContain(en.skills.editor.viewTitle);
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent!.trim())).not.toContain(en.skills.editor.saveSkill);
  });
});
