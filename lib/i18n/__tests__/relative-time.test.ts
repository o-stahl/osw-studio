import { describe, it, expect } from 'vitest';
import { elapsed } from '@/lib/i18n/relative-time';

const MIN = 60, HOUR = 3600, DAY = 86400;

describe('elapsed', () => {
  it('uses the coarsest unit that still says something', () => {
    expect(elapsed(30)).toEqual({ value: 30, unit: 'second' });
    expect(elapsed(30 * MIN)).toEqual({ value: 30, unit: 'minute' });
    expect(elapsed(3 * HOUR)).toEqual({ value: 3, unit: 'hour' });
    expect(elapsed(17 * DAY)).toEqual({ value: 17, unit: 'day' });
    expect(elapsed(90 * DAY)).toEqual({ value: 3, unit: 'month' });
    expect(elapsed(800 * DAY)).toEqual({ value: 2, unit: 'year' });
  });

  it('keeps the sign, so the past reads as "ago" and the future as "in"', () => {
    expect(elapsed(-3 * HOUR)).toEqual({ value: -3, unit: 'hour' });
  });

  it('moves to the next unit exactly at its boundary', () => {
    expect(elapsed(MIN - 1).unit).toBe('second');
    expect(elapsed(MIN).unit).toBe('minute');
    expect(elapsed(DAY - 1).unit).toBe('hour');
    expect(elapsed(DAY).unit).toBe('day');
  });
});
