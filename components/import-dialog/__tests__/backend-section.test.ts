import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';

import { describeBackendRecord, backendCountLabel } from '../sections';
import type { ImportPlan } from '@/lib/vfs/archive/types';
import en from '@/messages/en.json';

/** How the import preview words a server function and the server-functions section's count. */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'importDialog' });
const plan = (added: number, conflicts: number) =>
  ({ backend: { added: Array(added).fill({}), conflicts: Array(conflicts).fill({}) } }) as unknown as ImportPlan;

describe('describeBackendRecord', () => {
  it('names the kind and the method or schedule', () => {
    expect(describeBackendRecord(t, { kind: 'edge', detail: 'POST' })).toBe('edge · POST');
    expect(describeBackendRecord(t, { kind: 'scheduled', detail: '0 3 * * *' })).toBe('scheduled · 0 3 * * *');
  });

  it('calls a function with neither a helper', () => {
    expect(describeBackendRecord(t, { kind: 'server', detail: '' })).toBe('server · Helper');
  });

  it('says when it is disabled', () => {
    expect(describeBackendRecord(t, { kind: 'scheduled', detail: '@daily', disabled: true })).toBe('scheduled · @daily · disabled');
  });
});

describe('backendCountLabel', () => {
  it('counts new and existing functions, new first', () => {
    expect(backendCountLabel(t, plan(2, 1))).toBe('2 new · 1 exists');
  });

  it('leaves out a side with nothing in it', () => {
    expect(backendCountLabel(t, plan(3, 0))).toBe('3 new');
    expect(backendCountLabel(t, plan(0, 2))).toBe('2 exist');
    expect(backendCountLabel(t, plan(0, 0))).toBe('');
  });
});
