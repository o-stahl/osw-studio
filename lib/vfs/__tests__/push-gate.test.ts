import { describe, it, expect, beforeEach } from 'vitest';
import { holdPush, releaseHeldPush, requestPush, setHeldPushSender, setPushGate } from '../push-gate';

describe('the push gate', () => {
  let held: Set<string>;
  let sent: string[];

  beforeEach(() => {
    held = new Set();
    sent = [];
    setPushGate((projectId) => held.has(projectId));
    setHeldPushSender((projectId) => { sent.push(projectId); });
    // Nothing left waiting from another test.
    releaseHeldPush('p1');
    sent = [];
  });

  it('lets a push through for a project nothing holds', () => {
    expect(holdPush('p1')).toBe(false);
    requestPush('p1');
    expect(sent).toEqual(['p1']);
  });

  it('keeps a push waiting until its project is free, and sends it once', () => {
    held.add('p1');
    expect(holdPush('p1')).toBe(true);
    requestPush('p1');

    releaseHeldPush('p1');
    expect(sent).toEqual([]);

    held.delete('p1');
    releaseHeldPush('p1');
    releaseHeldPush('p1');
    expect(sent).toEqual(['p1']);
  });

  it('sends nothing on release when no push waited', () => {
    releaseHeldPush('p1');
    expect(sent).toEqual([]);
  });
});
