/**
 * The Review tab's pure logic.
 *
 * Kept out of the component so the parts that actually decide something, turning an expiry choice
 * into a stored deadline, assembling threads out of a flat comment list, deriving the colour a
 * participant is shown in, can be exercised without rendering anything.
 */

import type { WireComment } from '@/lib/review/comment-view';

/**
 * How long a review copy stays reachable, as offered in the picker.
 *
 * `current` is not a duration: it stands for the deadline already stored, so the select can read
 * back what is set instead of guessing which duration produced it. Only the durations reach
 * `expiryOptionToIso`, which is why it refuses `current` in its type.
 */
export type ReviewExpiryOption = 'current' | 'never' | '1h' | '24h' | '7d' | '30d' | '1y';

export type ReviewExpiryDuration = Exclude<ReviewExpiryOption, 'current' | 'never'>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DURATION_MS: Record<ReviewExpiryDuration, number> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '1y': 365 * DAY_MS,
};

/** The expiry menu, in order; each value is also its label's key under `publishSettings.expiry`. */
export const REVIEW_EXPIRY_CHOICES: ('never' | ReviewExpiryDuration)[] = ['never', '1h', '24h', '7d', '30d', '1y'];

/**
 * The deadline a choice resolves to, or undefined for "no expiry".
 *
 * An absolute timestamp is what gets stored, because the access layer compares it against the clock
 * on every request (`isReviewExpired`). A stored duration would need a start date to mean anything,
 * and would silently extend the round every time the record was rewritten.
 */
export function expiryOptionToIso(
  option: 'never' | ReviewExpiryDuration,
  now: Date = new Date()
): string | undefined {
  if (option === 'never') return undefined;
  return new Date(now.getTime() + DURATION_MS[option]).toISOString();
}

/**
 * Mirrors `isReviewExpired` in lib/review/access.ts, including its treatment of an unparseable
 * deadline as closed, a UI that called that one "no expiry" would promise access the server
 * refuses.
 */
export function isReviewExpired(expiresAt: string | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return true;
  return deadline <= now.getTime();
}

/** Matches TEAM_COLOR in lib/publishing/review-widget.ts. */
const TEAM_COLOR = '#3f7ae0';

/**
 * The colour a participant's comments are marked with.
 *
 * Derived from the server-minted participant id, not the display name, so two clients who both type
 * "Priya" stay visibly two people. The formula is a transcription of `colorFor` in
 * lib/publishing/review-widget.ts: that copy lives inside a template literal that ships as script
 * text to a customer's page, so it cannot be imported, and the two must agree, or a comment would
 * be one colour in the client's browser and another in the team's inbox.
 */
export function participantColor(participantId: string, isTeam: boolean): string {
  if (isTeam) return TEAM_COLOR;
  let hash = 0;
  const text = participantId || '';
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return `hsl(${hash}, 62%, 47%)`;
}

export interface ReviewThread {
  root: WireComment;
  replies: WireComment[];
}

/**
 * The id of the comment at the top of this one's parent chain.
 *
 * Walks up rather than looking one level, so a reply to a reply lands in the thread a reader would
 * expect. A parent that is not in the list stops the walk at the last ancestor that is, which keeps
 * the visible part of a broken chain together.
 *
 * A chain that loops back on itself has no top, so the comment is made its own root. Returning the
 * node the walk happened to stop on would leave every member of the cycle pointing at some other
 * member and none of them a root, and the whole cycle would vanish from the inbox.
 */
function rootIdOf(comment: WireComment, byId: Map<string, WireComment>): string {
  let current = comment;
  const seen = new Set<string>([comment.id]);

  while (current.parent_id) {
    const parent = byId.get(current.parent_id);
    if (!parent) break;
    if (seen.has(parent.id)) return comment.id;
    seen.add(parent.id);
    current = parent;
  }

  return current.id;
}

/**
 * Group a flat comment list into threads, preserving the server's order.
 *
 * Replies are flattened onto their root rather than nested: a reply shares its root's anchor and is
 * resolved with it, so there is one pin and one status per thread however deep the chain got.
 */
export function buildThreads(comments: WireComment[]): ReviewThread[] {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const threads: ReviewThread[] = [];
  const byRootId = new Map<string, ReviewThread>();

  for (const comment of comments) {
    if (rootIdOf(comment, byId) !== comment.id) continue;
    const thread: ReviewThread = { root: comment, replies: [] };
    threads.push(thread);
    byRootId.set(comment.id, thread);
  }

  for (const comment of comments) {
    const rootId = rootIdOf(comment, byId);
    if (rootId === comment.id) continue;
    byRootId.get(rootId)?.replies.push(comment);
  }

  return threads;
}

export type ReviewFilter = 'open' | 'resolved' | 'all';

/** A thread's status is its root's: replies do not carry one of their own. */
export function filterThreads(threads: ReviewThread[], filter: ReviewFilter): ReviewThread[] {
  if (filter === 'all') return threads;
  return threads.filter(thread => thread.root.status === filter);
}

export function countThreads(threads: ReviewThread[]): { open: number; resolved: number; all: number } {
  let open = 0;
  let resolved = 0;
  for (const thread of threads) {
    if (thread.root.status === 'resolved') resolved++;
    else open++;
  }
  return { open, resolved, all: threads.length };
}

/**
 * The tail of a selector, enough to recognise the element without printing its whole ancestry.
 *
 * Selectors are generated from the document root (`oswSelectorFor`), so the useful part is at the
 * end; the leading `html > body > div` is the same on every comment.
 */
export function shortSelector(selector: string | null, maxSegments = 2): string | null {
  if (!selector) return null;
  const segments = selector.split('>').map(segment => segment.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  return segments.slice(-maxSegments).join(' > ');
}

/** `/index.html · h2`, where the comment is pinned, in one line. */
export function describeAnchor(comment: WireComment): string {
  const element = shortSelector(comment.selector);
  return element ? `${comment.page_path} · ${element}` : comment.page_path;
}

/** The password row's state: what the next save will do to the stored password, or what is stored. */
export type ReviewPasswordState = 'pending-set' | 'pending-clear' | 'set' | 'unset';

/** Reads the draft's three-state `password` field (see `ReviewDraft`) against what is stored. */
export function reviewPasswordState(password: string | null | undefined, passwordSet: boolean): ReviewPasswordState {
  return typeof password === 'string'
    ? 'pending-set'
    : password === null
      ? 'pending-clear'
      : passwordSet
        ? 'set'
        : 'unset';
}

/** The password row's status line, as its key under `publishSettings`. */
export function passwordStateKey(state: ReviewPasswordState): 'setOnSave' | 'clearedOnSave' | 'set' | 'notSet' {
  return state === 'pending-set'
    ? 'setOnSave'
    : state === 'pending-clear'
      ? 'clearedOnSave'
      : state === 'set'
        ? 'set'
        : 'notSet';
}

/**
 * Whether the review copy exists and is current, and the notice that says why not.
 *
 * Two different situations were being reported with one sentence. A deployment that has never
 * produced a copy is not the same as one whose copy exists but predates the latest changes, and
 * the second is the ordinary state after any settings edit — settingsVersion bumps for SEO or
 * scripts just as it does for the review toggle. Calling that "not built yet" claimed the address
 * returns nothing while it was serving, and disabled Open on a link that works.
 */
export function reviewBuildState(state: {
  enabled: boolean;
  isDirty: boolean;
  hasBeenPublished: boolean;
  hasPendingChanges: boolean;
}): { nothingToOpen: boolean; outOfDate: boolean; notice: 'reviewNotSaved' | 'neverPublished' | 'changesNotInCopy' | null } {
  const { enabled, isDirty, hasBeenPublished, hasPendingChanges } = state;
  const nothingToOpen = enabled && (isDirty || !hasBeenPublished);
  const outOfDate = enabled && !nothingToOpen && hasPendingChanges;
  const notice = !enabled
    ? null
    : isDirty
      ? 'reviewNotSaved'
      : !hasBeenPublished
        ? 'neverPublished'
        : outOfDate
          ? 'changesNotInCopy'
          : null;
  return { nothingToOpen, outOfDate, notice };
}

/** The status badge beside the Review mode heading, as its key under `publishSettings`. */
export function reviewStatus(state: {
  enabled: boolean;
  notBuilt: boolean;
  outOfDate: boolean;
  expired: boolean;
}): 'off' | 'publishToApply' | 'publishToUpdate' | 'closed' | 'live' {
  return !state.enabled
    ? 'off'
    : state.notBuilt
      ? 'publishToApply'
      : state.outOfDate
        ? 'publishToUpdate'
        : state.expired
          ? 'closed'
          : 'live';
}

/** The expiry row's description, as its key under `publishSettings`. */
export function reviewExpiryKey(hasDeadline: boolean, expired: boolean): 'reviewClosedOn' | 'reviewClosesOn' | 'reviewNoExpiry' {
  return hasDeadline
    ? expired
      ? 'reviewClosedOn'
      : 'reviewClosesOn'
    : 'reviewNoExpiry';
}

/** What an empty comment list says: nothing at all yet, or nothing under the current filter. */
export function emptyThreadsKey(total: number, filter: ReviewFilter): 'noComments' | 'nothingOpen' | 'nothingResolved' {
  return total === 0
    ? 'noComments'
    : filter === 'open'
      ? 'nothingOpen'
      : 'nothingResolved';
}
