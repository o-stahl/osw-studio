// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';

/**
 * The checks a template has to pass before it is saved or imported: a version the app can compare,
 * and the structure import reads straight out of template.json.
 */

vi.mock('@/lib/utils', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../auto-sync', () => ({ autoSyncTemplate: vi.fn() }));

import { templateService } from '../template-service';

const METADATA = {
  name: 'Checked Template',
  description: 'A template whose metadata is checked',
  version: '1.0.0',
  license: 'personal' as const,
  tags: [],
};

function fakeVfs() {
  return {
    getProject: async () => ({ id: 'p1', settings: { runtime: 'static' } }),
    getAllFilesAndDirectories: async () => [{ type: 'file', path: '/index.html', content: '<h1>hi</h1>' }],
    getStorageAdapter: () => ({}),
  };
}

async function oswt(templateJson: unknown): Promise<File> {
  const zip = new JSZip();
  zip.file('template.json', JSON.stringify(templateJson));
  return new File([await zip.generateAsync({ type: 'blob' })], 'x.oswt');
}

beforeAll(() => {
  registerEnglishTranslator();
});

describe('template validation', () => {
  it('refuses a version that is not x.y.z', async () => {
    await expect(templateService.exportProjectAsTemplate(fakeVfs(), 'p1', { ...METADATA, version: '1.0' }))
      .rejects.toThrow('Version must be in format x.y.z');
  });

  it('refuses an imported template with no directories list', async () => {
    const file = await oswt({ name: 'T', description: 'A template', files: [] });
    await expect(templateService.importTemplateFile(file)).rejects.toThrow('“directories” is missing or invalid');
  });
});
