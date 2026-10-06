import { describe, it, expect } from 'vitest';
import { costTotalFormat } from '../cost-tracking-pane';

/** The lifetime cost total in Settings → Costs, as the formatter renders it in English. */
const total = (usd: number) => new Intl.NumberFormat('en-US', costTotalFormat(usd) as Intl.NumberFormatOptions).format(usd);

describe('costTotalFormat', () => {
  it('shows a total that has not started as plain dollars', () => {
    expect(total(0)).toBe('$0.00');
  });

  it('keeps four digits for a total under a cent, so it does not read as zero', () => {
    expect(total(0.0042)).toBe('$0.0042');
    expect(total(0.00001)).toBe('$0.0000');
    expect(total(0.005)).toBe('$0.0050');
  });

  it('allows a third digit under a dollar', () => {
    expect(total(0.125)).toBe('$0.125');
    expect(total(0.5)).toBe('$0.50');
  });

  it('rounds to cents from a dollar up', () => {
    expect(total(1.239)).toBe('$1.24');
    expect(total(12)).toBe('$12.00');
  });
});
