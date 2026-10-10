// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { deepMerge } from '@/lib/i18n/merge';

/**
 * The templates page in another language. A built-in's name and description are shown translated,
 * and a project made from it is named in the person's language. An exported `.oswt` file is a
 * template other people install, so it carries the template's English source copy whatever
 * language the exporter was using.
 *
 * A delete the server refused says why (the refusal's own message); any other failure says the
 * delete failed, in the interface language.
 */

const vfsMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  createProject: vi.fn(async (name: string, description: string) => ({ id: 'p-new', name, description })),
  deleteProject: vi.fn(async () => {}),
}));
const service = vi.hoisted(() => ({
  listCustomTemplates: vi.fn(async (): Promise<unknown[]> => []),
  deleteCustomTemplate: vi.fn(async () => {}),
  exportProjectAsTemplate: vi.fn(async () => new Blob(['x'])),
}));
const builtIns = vi.hoisted(() => ({
  applyBuiltInTemplate: vi.fn(async () => ({ backendFeatures: undefined })),
  getBuiltInTemplateDefinition: vi.fn((id: string) => ({ id })),
  instantiateBuiltInTemplate: vi.fn(async () => {}),
}));

vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/template-service', () => ({ templateService: service }));
vi.mock('@/lib/vfs/project-templates', () => builtIns);
vi.mock('@/lib/vfs/provision-backend-features', () => ({ provisionBackendFeatures: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ useViewMode: () => ['grid', () => {}], ViewModeToggle: () => null }));
vi.mock('@/lib/hooks/use-narrow-container', () => ({ useNarrowContainer: () => [false, () => {}] }));
vi.mock('@/components/template-browser/template-preview-dialog', () => ({ TemplatePreviewDialog: () => null }));
// The card is a separate component; here it only has to hand its template to the manager's actions.
vi.mock('../template-card', () => ({
  TemplateCard: ({ template, onSelect, onExport, onDelete }: {
    template: { id: string; name: string };
    onSelect: (t: unknown) => void;
    onExport?: (t: unknown) => void;
    onDelete?: (id: string) => void;
  }) => (
    <div data-card={template.id}>
      <span data-name>{template.name}</span>
      <button data-export onClick={() => onExport?.(template)} />
      <button data-create onClick={() => onSelect(template)} />
      <button data-delete onClick={() => onDelete?.(template.id)} />
    </div>
  ),
}));

import { TemplateManager } from '..';
import { BUILT_IN_TEMPLATES } from '@/lib/vfs/templates';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';

const source = (id: string) => BUILT_IN_TEMPLATES.find((t) => t.id === id)!;

let container: HTMLDivElement;
let root: Root;
let downloads: string[];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mountFinnish() {
  await mount('fi', deepMerge(en, fi));
}

async function mount(locale: 'en' | 'fi', messages: typeof en) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <TemplateManager />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

const card = (id: string) => container.querySelector(`[data-card="${id}"]`)!;
const press = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};

describe('a built-in template in another language', () => {
  it('is listed under its translated name', async () => {
    await mountFinnish();
    expect(card('business-website').querySelector('[data-name]')!.textContent).toBe(fi.templateCatalog['business-website'].name);
  });

  it('exports with its English source name and description', async () => {
    await mountFinnish();
    await press(card('business-website').querySelector('[data-export]')!);

    const english = source('business-website');
    expect(english.name).not.toBe(fi.templateCatalog['business-website'].name);
    expect(vfsMock.createProject).toHaveBeenCalledWith(english.name, english.description);
    expect(service.exportProjectAsTemplate).toHaveBeenCalledWith(vfsMock, 'p-new', expect.objectContaining({
      name: english.name,
      description: english.description,
    }));
    expect(downloads).toEqual([`${english.name.replace(/\s+/g, '-').toLowerCase()}.oswt`]);
  });

  it('names a project made from it in the person\'s language', async () => {
    await mountFinnish();
    await press(card('business-website').querySelector('[data-create]')!);
    expect(vfsMock.createProject.mock.calls[0][0]).toBe(fi.templateCatalog['business-website'].name);
  });

  it('names a project made from a starter as new, not after the starting point', async () => {
    await mountFinnish();
    await press(card('blank').querySelector('[data-create]')!);
    const name = vfsMock.createProject.mock.calls[0][0];
    expect(name).toContain(fi.templateCatalog.blank.name);
    expect(name).not.toBe(fi.templateCatalog.blank.name);
  });
});

describe('deleting a custom template', () => {
  const custom = {
    id: 'mine', name: 'Mine', description: 'd', version: '1', files: [], directories: [],
    metadata: { license: 'personal' }, updatedAt: new Date(),
  };

  beforeEach(() => {
    registerEnglishTranslator();
    vi.stubGlobal('confirm', () => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.listCustomTemplates.mockResolvedValue([custom]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the server's refusal", async () => {
    service.deleteCustomTemplate.mockRejectedValue(new ServerDeleteRefused('auth'));
    await mount('en', en);
    await press(card('mine').querySelector('[data-delete]')!);
    expect(toast.error).toHaveBeenCalledWith(en.sync.deleteRefused.auth);
  });

  it('says the delete failed on any other error', async () => {
    service.deleteCustomTemplate.mockRejectedValue(new Error('disk full'));
    await mountFinnish();
    await press(card('mine').querySelector('[data-delete]')!);
    expect(toast.error).toHaveBeenCalledWith(fi.templatesUi.deleteFailed);
  });
});
