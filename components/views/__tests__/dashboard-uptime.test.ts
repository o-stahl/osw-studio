import { describe, it, expect } from 'vitest';
import { formatUptime } from '../dashboard-view';

/** Server uptime on the dashboard, in its two largest units. */
const number = ((value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat('en', options).format(value)) as Parameters<typeof formatUptime>[1];

describe('formatUptime', () => {
  it('gives days and hours from the first full day', () => {
    expect(formatUptime(86400 + 2 * 3600, number)).toBe('1d 2h');
    expect(formatUptime(3 * 86400 + 5 * 3600 + 59, number)).toBe('3d 5h');
  });

  it('gives hours and minutes within the first day, and minutes within the first hour', () => {
    expect(formatUptime(2 * 3600 + 15 * 60, number)).toBe('2h 15m');
    expect(formatUptime(3600 + 5 * 60, number)).toBe('1h 5m');
    expect(formatUptime(42 * 60 + 5, number)).toBe('42m');
  });
});
