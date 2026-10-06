/**
 * Interview Templates Service - Manages interview template CRUD operations.
 * Custom templates are stored in localStorage and merged with built-ins at read time.
 */

import { translator } from '@/lib/i18n/runtime';
import type { InterviewTemplate } from './types';
import { BUILT_IN_INTERVIEWS, isBuiltInInterviewTemplateId } from './templates';
import { slugify } from './template-form';
import { logger } from '@/lib/utils';

const CUSTOM_KEY = 'osw_custom_interview_templates';

class InterviewTemplatesService {
  private custom: Map<string, InterviewTemplate> = new Map();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(CUSTOM_KEY);
        if (stored) {
          const arr: InterviewTemplate[] = JSON.parse(stored);
          for (const t of arr) {
            t.createdAt = t.createdAt ? new Date(t.createdAt) : undefined;
            t.updatedAt = t.updatedAt ? new Date(t.updatedAt) : undefined;
            t.lastSyncedAt = t.lastSyncedAt ? new Date(t.lastSyncedAt) : null;
            t.serverUpdatedAt = t.serverUpdatedAt ? new Date(t.serverUpdatedAt) : null;
            this.custom.set(t.id, { ...t, isBuiltIn: false });
          }
        }
      }
      this.initialized = true;
    } catch (e) {
      logger.error('[InterviewTemplates] load failed', e);
    }
  }

  /** Test helper: force a fresh read from localStorage. */
  async forceReload(): Promise<void> {
    this.initialized = false;
    this.custom.clear();
    await this.init();
  }

  /** Test helper: clear all custom templates from memory and localStorage. */
  async clearCustom(): Promise<void> {
    this.custom.clear();
    this.initialized = false;
    if (typeof localStorage !== 'undefined') localStorage.removeItem(CUSTOM_KEY);
  }

  private save(): void {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(Array.from(this.custom.values())));
    } catch (e) {
      logger.error('[InterviewTemplates] save failed', e);
      throw new Error('Failed to save interview template');
    }
  }

  async getAllTemplates(): Promise<InterviewTemplate[]> {
    await this.init();
    const builtins = BUILT_IN_INTERVIEWS.map(t => ({ ...t, isBuiltIn: true as const }));
    return [...builtins, ...Array.from(this.custom.values())];
  }

  async getTemplate(id: string): Promise<InterviewTemplate | null> {
    await this.init();
    if (this.custom.has(id)) return this.custom.get(id)!;
    const b = BUILT_IN_INTERVIEWS.find(t => t.id === id);
    return b ? { ...b, isBuiltIn: true } : null;
  }

  /** Generate a unique custom id from a title. */
  async generateId(title: string): Promise<string> {
    await this.init();
    const base = slugify(title) || 'interview';
    let id = base, n = 2;
    while (this.custom.has(id) || isBuiltInInterviewTemplateId(id)) {
      id = `${base}-${n++}`;
    }
    return id;
  }

  async createTemplate(t: InterviewTemplate): Promise<InterviewTemplate> {
    await this.init();
    if (isBuiltInInterviewTemplateId(t.id)) throw new Error(translator()('interviews.builtInOverwrite'));
    if (this.custom.has(t.id)) throw new Error(translator()('interviews.idTaken', { id: t.id }));
    const now = new Date();
    const saved: InterviewTemplate = { ...t, isBuiltIn: false, createdAt: now, updatedAt: now };
    this.custom.set(saved.id, saved);
    this.save();
    import('@/lib/vfs/auto-sync').then(({ autoSyncInterviewTemplate }) => autoSyncInterviewTemplate(saved)).catch(() => {});
    return saved;
  }

  async updateTemplate(id: string, t: InterviewTemplate): Promise<InterviewTemplate> {
    await this.init();
    if (isBuiltInInterviewTemplateId(id)) throw new Error(translator()('interviews.builtInEdit'));
    const existing = this.custom.get(id);
    if (!existing) throw new Error(`Template "${id}" not found.`); // i18n-ignore: an invariant
    const saved: InterviewTemplate = { ...existing, ...t, id, isBuiltIn: false, updatedAt: new Date() };
    this.custom.set(id, saved);
    this.save();
    import('@/lib/vfs/auto-sync').then(({ autoSyncInterviewTemplate }) => autoSyncInterviewTemplate(saved)).catch(() => {});
    return saved;
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.init();
    if (isBuiltInInterviewTemplateId(id)) throw new Error(translator()('interviews.builtInDelete'));
    if (!this.custom.delete(id)) throw new Error(`Template "${id}" not found.`); // i18n-ignore: an invariant
    this.save();
    import('@/lib/vfs/auto-sync').then(({ autoDeleteInterviewTemplate }) => autoDeleteInterviewTemplate(id)).catch(() => {});
  }

  // ---- Sync support (mirrors SkillsService) ----

  async getCustomTemplates(): Promise<InterviewTemplate[]> {
    await this.init();
    return Array.from(this.custom.values());
  }

  async updateSyncMetadata(id: string, lastSyncedAt: Date, serverUpdatedAt: Date): Promise<void> {
    await this.init();
    const t = this.custom.get(id);
    if (!t) return;
    this.custom.set(id, { ...t, lastSyncedAt, serverUpdatedAt });
    this.save();
  }

  async importFromServer(server: InterviewTemplate): Promise<void> {
    await this.init();
    const now = new Date();
    const t: InterviewTemplate = {
      ...server,
      isBuiltIn: false,
      createdAt: server.createdAt ? new Date(server.createdAt) : now,
      updatedAt: server.updatedAt ? new Date(server.updatedAt) : now,
      lastSyncedAt: now,
      serverUpdatedAt: server.updatedAt ? new Date(server.updatedAt) : now,
    };
    this.custom.set(t.id, t);
    this.save();
  }
}

export const interviewTemplatesService = new InterviewTemplatesService();
