import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configManager } from '@/lib/config/storage';
import { BUILT_IN_MODEL_TEMPLATES } from '@/lib/llm/models/registry';
import type { ModelTemplate } from '@/lib/llm/models/assignment';

function stubBrowserStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { dispatchEvent: () => true } as unknown as Window);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

beforeEach(stubBrowserStorage);
afterEach(() => vi.unstubAllGlobals());

const t: ModelTemplate = {
  id: 't1',
  name: 'Mine',
  builtin: false,
  assignment: {
    agent: { provider: 'openrouter', model: 'x/y' },
    imageGen: null,
    voiceInput: 'browser',
    autoCompact: true,
    compactLimit: null,
  },
};

describe('configManager model templates', () => {
  it('round-trips templates and the default id, stamping updatedAt', async () => {
    configManager.saveModelTemplate(t);
    const saved = configManager.getModelTemplate('t1');
    expect(saved).toMatchObject({ id: 't1', name: 'Mine', assignment: t.assignment });
    expect(saved?.updatedAt).toBeInstanceOf(Date); // stamped on save
    configManager.setDefaultTemplateId('t1');
    expect(configManager.getDefaultTemplateId()).toBe('t1');
    await configManager.deleteModelTemplate('t1');
    expect(configManager.getModelTemplate('t1')).toBeNull();
  });

  it('merges built-in templates in at read time without persisting them', () => {
    // Built-ins are visible even with nothing stored.
    for (const b of BUILT_IN_MODEL_TEMPLATES) {
      expect(configManager.getModelTemplate(b.id)).toEqual(b);
    }
    // Nothing was written to storage.
    expect(localStorage.getItem('osw-studio-settings')).toBeNull();
  });

  it('lists built-ins alongside stored custom templates', () => {
    configManager.saveModelTemplate(t);
    const all = configManager.getModelTemplates();
    expect(all['t1']).toMatchObject({ id: 't1', name: 'Mine', assignment: t.assignment });
    for (const b of BUILT_IN_MODEL_TEMPLATES) expect(all[b.id]).toEqual(b);
  });

  it('normalizes a stored template with a stale builtin:true flag to editable', () => {
    // An older build persisted the migrated "Default" with builtin:true.
    configManager.saveModelTemplate({ ...t, id: 'default', name: 'Default', builtin: true });
    expect(configManager.getModelTemplate('default')?.builtin).toBe(false);
  });

  it('refuses to overwrite or delete a built-in template', async () => {
    const builtin = BUILT_IN_MODEL_TEMPLATES[0];
    configManager.saveModelTemplate({ ...builtin, name: 'Hacked' });
    expect(configManager.getModelTemplate(builtin.id)).toEqual(builtin); // unchanged
    await configManager.deleteModelTemplate(builtin.id);
    expect(configManager.getModelTemplate(builtin.id)).toEqual(builtin); // still present
  });

  it('importModelTemplateFromServer stores with sync metadata and server timestamp', () => {
    const serverUpdated = new Date('2026-06-01T00:00:00Z');
    configManager.importModelTemplateFromServer({ ...t, updatedAt: serverUpdated });
    const got = configManager.getModelTemplate('t1');
    expect(got?.builtin).toBe(false);
    expect(got?.updatedAt).toEqual(serverUpdated);
    expect(got?.serverUpdatedAt).toEqual(serverUpdated);
    expect(got?.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('updateModelTemplateSyncMetadata sets sync fields without bumping updatedAt', () => {
    configManager.saveModelTemplate(t);
    const before = configManager.getModelTemplate('t1')!.updatedAt!;
    const synced = new Date('2026-06-02T00:00:00Z');
    configManager.updateModelTemplateSyncMetadata('t1', synced, synced);
    const after = configManager.getModelTemplate('t1');
    expect(after?.lastSyncedAt).toEqual(synced);
    expect(after?.serverUpdatedAt).toEqual(synced);
    expect(after?.updatedAt).toEqual(before); // unchanged — not a content edit
  });
});
