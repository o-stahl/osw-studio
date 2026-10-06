import { describe, it, expect } from 'vitest';
import { parseOpenRouterKey, parsePollinationsBalance, nextUtcMidnight } from '../provider-status';

describe('parseOpenRouterKey', () => {
  const now = Date.UTC(2026, 9, 3, 20, 15);

  it('reads the shared free-model daily count and the start of the next UTC day', () => {
    const status = parseOpenRouterKey({
      data: { is_free_tier: false, free_model_daily_requests: { used: 8, limit: 1000, remaining: 992 } },
    }, now);
    expect(status).toEqual({
      quota: { kind: 'daily', used: 8, limit: 1000, remaining: 992, resetAt: Date.UTC(2026, 9, 4) },
      freeOnly: false,
    });
  });

  it('derives remaining when only used and limit are given', () => {
    const status = parseOpenRouterKey({ data: { free_model_daily_requests: { used: 50, limit: 50 } } }, now);
    expect(status.quota).toMatchObject({ kind: 'daily', remaining: 0 });
  });

  it('says nothing about a quota it was not given', () => {
    expect(parseOpenRouterKey({ data: { is_free_tier: true } })).toEqual({ quota: { kind: 'none' }, freeOnly: true });
    expect(parseOpenRouterKey(null)).toEqual({ quota: { kind: 'none' } });
  });
});

describe('parsePollinationsBalance', () => {
  it('reads the balance in Pollen', () => {
    expect(parsePollinationsBalance({ balance: 4.25 })).toEqual({ quota: { kind: 'balance', remaining: 4.25, unit: 'pollen' } });
  });

  it('says nothing for a body without a number', () => {
    expect(parsePollinationsBalance({ balance: 'x' })).toEqual({ quota: { kind: 'none' } });
  });
});

describe('nextUtcMidnight', () => {
  it('is the next day even a minute before midnight', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 0, 31, 23, 59))).toBe(Date.UTC(2026, 1, 1));
  });
});
