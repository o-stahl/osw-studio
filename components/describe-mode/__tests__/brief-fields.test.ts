import { describe, it, expect } from 'vitest';
import { formatValue, getCapabilitiesList, getExtraFields } from '../brief-sidebar';
import type { ProjectBrief } from '@/lib/describe/types';

/** How the describe-mode sidebar words a brief, with yes/no in the reader's language. */
const LABELS = { serverFunctions: 'Server functions', database: 'Database', auth: 'Sign-in' };

describe('formatValue', () => {
  it('uses the given words for booleans', () => {
    expect(formatValue(true, 'kyllä', 'ei')).toBe('kyllä');
    expect(formatValue(false, 'kyllä', 'ei')).toBe('ei');
  });

  it('joins lists, keeps strings and numbers, and spells out objects', () => {
    expect(formatValue(['a', true, 2], 'y', 'n')).toBe('a, y, 2');
    expect(formatValue({ a: 1 }, 'y', 'n')).toBe('{"a":1}');
  });
});

describe('getCapabilitiesList', () => {
  it('lists the known capabilities that are on, by their label', () => {
    expect(getCapabilitiesList({ database: true, auth: false } as ProjectBrief['capabilities'], LABELS, 'y', 'n'))
      .toEqual(['Database']);
  });

  it('adds the free-form extras as they are', () => {
    expect(getCapabilitiesList({ other: ['Payments', 'Maps'] } as ProjectBrief['capabilities'], LABELS, 'y', 'n'))
      .toEqual(['Payments', 'Maps']);
  });

  it('names an unexpected capability with its value, in the reader\'s yes/no', () => {
    expect(getCapabilitiesList({ realTime: true, regions: ['eu', 'us'] } as unknown as ProjectBrief['capabilities'], LABELS, 'kyllä', 'ei'))
      .toEqual(['Real Time: kyllä', 'Regions: eu, us']);
  });

  it('gives nothing for a missing set', () => {
    expect(getCapabilitiesList(undefined, LABELS, 'y', 'n')).toEqual([]);
  });
});

describe('getExtraFields', () => {
  it('shows only fields the sidebar has no place for, and skips empty ones', () => {
    const brief = { name: 'Site', type: 'blog', audience: 'kids', launch_date: null, multilingual: false } as unknown as ProjectBrief;
    expect(getExtraFields(brief, 'y', 'n')).toEqual([
      { label: 'Audience', value: 'kids' },
      { label: 'Multilingual', value: 'n' },
    ]);
  });
});
