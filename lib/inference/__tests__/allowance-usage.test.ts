import { describe, it, expect } from 'vitest';
import {
  ALLOWANCE_LOW_AT, allowanceLow, allowanceUsageHeaders, readAllowanceUsage,
} from '../allowance-usage';

/** How much of the day's OSW Studio inference is used, from the inference server to the page. */
const upstream = (h: Record<string, string>) => new Headers(h);

describe('allowanceUsageHeaders', () => {
  it('passes the spend on as a share of the cap, with the reset and the sessions still to come', () => {
    const h = allowanceUsageHeaders(upstream({ 'x-osws-allowance-spent': '82000', 'x-osws-allowance-limit': '100000', 'x-osws-allowance-reset': '1794700800000' }), 2);
    expect(h).toEqual({ 'x-osws-allowance-used': '0.820', 'x-osws-allowance-reset': '1794700800000', 'x-osws-allowance-sessions-left': '2' });
  });

  it('never says more than all of it is used, and leaves the sessions out where there are none', () => {
    const h = allowanceUsageHeaders(upstream({ 'x-osws-allowance-spent': '104000', 'x-osws-allowance-limit': '100000' }));
    expect(h).toEqual({ 'x-osws-allowance-used': '1.000' });
  });

  it('says nothing when the inference server said nothing usable', () => {
    expect(allowanceUsageHeaders(upstream({}), 3)).toEqual({});
    expect(allowanceUsageHeaders(upstream({ 'x-osws-allowance-spent': '5' }), 3)).toEqual({});
    expect(allowanceUsageHeaders(upstream({ 'x-osws-allowance-spent': '5', 'x-osws-allowance-limit': '0' }))).toEqual({});
    expect(allowanceUsageHeaders(upstream({ 'x-osws-allowance-spent': 'lots', 'x-osws-allowance-limit': '100' }))).toEqual({});
  });
});

describe('readAllowanceUsage', () => {
  it('reads back what the server sent', () => {
    const sent = allowanceUsageHeaders(upstream({ 'x-osws-allowance-spent': '50000', 'x-osws-allowance-limit': '100000', 'x-osws-allowance-reset': '1794700800000' }), 0);
    expect(readAllowanceUsage(new Headers(sent))).toEqual({ used: 0.5, resetAt: 1794700800000, sessionsLeft: 0 });
    expect(readAllowanceUsage(new Headers({ 'x-osws-allowance-used': '0.9' }))).toEqual({ used: 0.9 });
  });

  it('is null for an answer that says nothing about the allowance', () => {
    expect(readAllowanceUsage(new Headers({ 'content-type': 'text/event-stream' }))).toBeNull();
    expect(readAllowanceUsage(new Headers({ 'x-osws-allowance-used': 'most' }))).toBeNull();
  });
});

describe('allowanceLow', () => {
  it('is low from the threshold on, unless another trial session is still to come', () => {
    expect(allowanceLow({ used: ALLOWANCE_LOW_AT - 0.01 })).toBe(false);
    expect(allowanceLow({ used: ALLOWANCE_LOW_AT })).toBe(true);
    expect(allowanceLow({ used: 0.95, sessionsLeft: 1 })).toBe(false);
    expect(allowanceLow({ used: 0.95, sessionsLeft: 0 })).toBe(true);
  });
});
