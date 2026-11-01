import { describe, it, expect } from 'vitest';
import { BRIDGE_CHANNEL, isBridgeReady, isBridgeReply, isBridgeRequest } from '../protocol';

/** The bridge acts only on messages of its own shape; anything else on the page is not for it. */
describe('bridge messages', () => {
  it('knows its requests', () => {
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'list' })).toBe(true);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'export', projectIds: ['a', 'b'] })).toBe(true);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'delete', projectIds: [] })).toBe(true);
  });

  it('ignores anything else', () => {
    expect(isBridgeRequest({ channel: 'something-else', id: 'r1', op: 'list' })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, op: 'list' })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'drop-everything' })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'delete', projectIds: 'a' })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'delete', projectIds: [1] })).toBe(false);
    expect(isBridgeRequest({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'export', projectIds: Array.from({ length: 1001 }, (_, i) => String(i)) })).toBe(false);
    expect(isBridgeRequest('list')).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
  });

  it('knows its replies and its ready signal', () => {
    expect(isBridgeReply({ channel: BRIDGE_CHANNEL, id: 'r1', ok: true, projects: [] })).toBe(true);
    expect(isBridgeReply({ channel: BRIDGE_CHANNEL, id: 'r1', ok: false, error: 'x' })).toBe(true);
    expect(isBridgeReply({ channel: BRIDGE_CHANNEL, id: 'r1' })).toBe(false);
    expect(isBridgeReady({ channel: BRIDGE_CHANNEL, ready: true })).toBe(true);
    expect(isBridgeReady({ channel: BRIDGE_CHANNEL, id: 'r1', ok: true })).toBe(false);
  });
});
