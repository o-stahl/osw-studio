import { describe, it, expect, vi } from 'vitest';
import { when } from '../mcp-pane';

/** The MCP pane's "last used" and "connected" times. */
const t = (key: string) => `<${key}>`;
const dateTime = vi.fn((d: Date) => d.toISOString());

describe('when', () => {
  it('says never for a time that was never set', () => {
    expect(when(t, dateTime, null)).toBe('<never>');
    expect(when(t, dateTime, undefined)).toBe('<never>');
    expect(when(t, dateTime, '')).toBe('<never>');
  });

  it('reads a timestamp in milliseconds and an ISO string alike', () => {
    expect(when(t, dateTime, Date.UTC(2026, 0, 2))).toBe('2026-01-02T00:00:00.000Z');
    expect(when(t, dateTime, '2026-01-02T00:00:00Z')).toBe('2026-01-02T00:00:00.000Z');
  });

  it('says it does not know rather than printing Invalid Date', () => {
    expect(when(t, dateTime, 'yesterday-ish')).toBe('<unknownTime>');
  });
});
