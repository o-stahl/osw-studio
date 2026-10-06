import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/vfs', () => ({ vfs: {} }));

import { titleFor } from '../index';
import type { ImportPlan } from '@/lib/vfs/archive/types';

/** The import dialog's heading for each phase. */
const t = (key: string, values?: Record<string, string>) => (values ? `<${key}:${JSON.stringify(values)}>` : `<${key}>`);
const plan = (format: string) => ({ format }) as unknown as ImportPlan;

describe('titleFor', () => {
  it('names what a wrong-format archive actually is', () => {
    expect(titleFor(t, 'wrong-format', plan('osws-backup'), false)).toBe('<isWorkspaceBackup>');
    expect(titleFor(t, 'wrong-format', plan('oswt-template'), false)).toBe('<isTemplate>');
  });

  it('says finished once done, whatever the target', () => {
    expect(titleFor(t, 'done', plan('osws-project'), true, 'Site')).toBe('<finished>');
  });

  it('names the new project or the one being imported into', () => {
    expect(titleFor(t, 'ready', plan('osws-project'), true, 'Site')).toBe('<asNewProject>');
    expect(titleFor(t, 'ready', plan('osws-project'), false, 'Site')).toBe('<intoProject:{"name":"Site"}>');
    expect(titleFor(t, 'ready', plan('osws-project'), false)).toBe('<intoThisProject>');
  });

  it('keeps the ordinary heading when there is nothing to do', () => {
    expect(titleFor(t, 'nothing-to-do', plan('osws-project'), false, 'Site')).toBe('<intoProject:{"name":"Site"}>');
  });
});
