import { describe, it, expect } from 'vitest';
import type { WireComment } from '@/lib/review/comment-view';
import {
  buildThreads,
  countThreads,
  describeAnchor,
  expiryOptionToIso,
  filterThreads,
  isReviewExpired,
  participantColor,
  shortSelector,
} from '../review-logic';

/**
 * The Review tab's logic, tested where it lives: as plain functions.
 *
 * The tab itself is presentation over these — a `Section`, some `SettingRow`s and a list — and the
 * layers beneath it (the merge rules, the access check, the comment API) have their own tests. What
 * is deliberately not covered here is the markup and the fetches; that is the manual pass's job.
 */

function comment(id: string, over: Partial<WireComment> = {}): WireComment {
  return {
    id,
    parent_id: null,
    participant_id: `p-${id}`,
    author_name: 'Priya',
    is_team: false,
    page_path: '/index.html',
    selector: null,
    anchor_text: null,
    body: `body ${id}`,
    status: 'open',
    created_at: '2026-08-29T10:00:00Z',
    resolved_at: null,
    resolved_by: null,
    ...over,
  };
}

describe('expiryOptionToIso', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('resolves a duration to an absolute deadline', () => {
    expect(expiryOptionToIso('1h', now)).toBe('2026-08-29T13:00:00.000Z');
    expect(expiryOptionToIso('24h', now)).toBe('2026-08-30T12:00:00.000Z');
    expect(expiryOptionToIso('7d', now)).toBe('2026-09-05T12:00:00.000Z');
    expect(expiryOptionToIso('30d', now)).toBe('2026-09-28T12:00:00.000Z');
    expect(expiryOptionToIso('1y', now)).toBe('2027-08-29T12:00:00.000Z');
  });

  it('resolves "never" to no deadline at all, not to a far-future one', () => {
    expect(expiryOptionToIso('never', now)).toBeUndefined();
  });
});

describe('isReviewExpired', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('treats an absent deadline as open-ended', () => {
    expect(isReviewExpired(undefined, now)).toBe(false);
  });

  it('closes on and after the deadline', () => {
    expect(isReviewExpired('2026-08-29T12:00:01Z', now)).toBe(false);
    expect(isReviewExpired('2026-08-29T12:00:00Z', now)).toBe(true);
    expect(isReviewExpired('2026-08-28T12:00:00Z', now)).toBe(true);
  });

  it('treats a deadline it cannot read as closed, matching the access layer', () => {
    expect(isReviewExpired('whenever', now)).toBe(true);
  });
});

describe('participantColor', () => {
  it('is stable per participant id', () => {
    expect(participantColor('abc', false)).toBe(participantColor('abc', false));
  });

  it('separates two participants who share a display name', () => {
    expect(participantColor('abc', false)).not.toBe(participantColor('abd', false));
  });

  it('gives every team member the one team colour', () => {
    expect(participantColor('user:1', true)).toBe('#3f7ae0');
    expect(participantColor('user:2', true)).toBe('#3f7ae0');
  });
});

describe('buildThreads', () => {
  it('keeps roots in the order given and hangs replies off them', () => {
    const threads = buildThreads([
      comment('a'),
      comment('b'),
      comment('a1', { parent_id: 'a' }),
    ]);

    expect(threads.map(t => t.root.id)).toEqual(['a', 'b']);
    expect(threads[0].replies.map(r => r.id)).toEqual(['a1']);
    expect(threads[1].replies).toEqual([]);
  });

  it('flattens a reply to a reply onto the thread root', () => {
    const threads = buildThreads([
      comment('a'),
      comment('a1', { parent_id: 'a' }),
      comment('a2', { parent_id: 'a1' }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map(r => r.id)).toEqual(['a1', 'a2']);
  });

  it('promotes a reply whose parent is not in the list rather than dropping it', () => {
    const threads = buildThreads([comment('orphan', { parent_id: 'gone' })]);

    expect(threads.map(t => t.root.id)).toEqual(['orphan']);
  });

  it('terminates on a parent cycle', () => {
    const threads = buildThreads([
      comment('a', { parent_id: 'b' }),
      comment('b', { parent_id: 'a' }),
    ]);

    expect(threads.length + threads.reduce((n, t) => n + t.replies.length, 0)).toBe(2);
  });
});

describe('filterThreads / countThreads', () => {
  const threads = buildThreads([
    comment('a'),
    comment('b', { status: 'resolved' }),
    // A reply is not a thread: it must not show up in either count.
    comment('b1', { parent_id: 'b' }),
  ]);

  it('filters on the root status', () => {
    expect(filterThreads(threads, 'open').map(t => t.root.id)).toEqual(['a']);
    expect(filterThreads(threads, 'resolved').map(t => t.root.id)).toEqual(['b']);
    expect(filterThreads(threads, 'all').map(t => t.root.id)).toEqual(['a', 'b']);
  });

  it('counts threads, not comments', () => {
    expect(countThreads(threads)).toEqual({ open: 1, resolved: 1, all: 2 });
  });
});

describe('shortSelector / describeAnchor', () => {
  it('keeps the tail of a selector, where the element actually is', () => {
    expect(shortSelector('html > body > div:nth-child(2) > h2')).toBe('div:nth-child(2) > h2');
    expect(shortSelector('h2')).toBe('h2');
  });

  it('has nothing to say about a comment with no selector', () => {
    expect(shortSelector(null)).toBeNull();
    expect(describeAnchor(comment('a'))).toBe('/index.html');
  });

  it('reads as page then element', () => {
    expect(describeAnchor(comment('a', { selector: 'body > h2', page_path: '/about.html' })))
      .toBe('/about.html · body > h2');
  });
});
