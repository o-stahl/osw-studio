import { describe, it, expect } from 'vitest';
import {
  reviewPasswordState,
  passwordStateKey,
  reviewBuildState,
  reviewStatus,
  reviewExpiryKey,
  emptyThreadsKey,
} from '../review-logic';

/** What the Review tab says about its own state: password, build, status badge, expiry, inbox. */

describe('reviewPasswordState', () => {
  it('reads the draft field before what is stored', () => {
    expect(reviewPasswordState('hunter22', false)).toBe('pending-set');
    expect(reviewPasswordState('', true)).toBe('pending-set');
    expect(reviewPasswordState(null, true)).toBe('pending-clear');
  });

  it('falls back to what is stored when the draft leaves it alone', () => {
    expect(reviewPasswordState(undefined, true)).toBe('set');
    expect(reviewPasswordState(undefined, false)).toBe('unset');
  });

  it('words each state', () => {
    expect(passwordStateKey('pending-set')).toBe('setOnSave');
    expect(passwordStateKey('pending-clear')).toBe('clearedOnSave');
    expect(passwordStateKey('set')).toBe('set');
    expect(passwordStateKey('unset')).toBe('notSet');
  });
});

describe('reviewBuildState', () => {
  const base = { enabled: true, isDirty: false, hasBeenPublished: true, hasPendingChanges: false };

  it('says nothing with review off, whatever else is true', () => {
    expect(reviewBuildState({ ...base, enabled: false, isDirty: true, hasPendingChanges: true }))
      .toEqual({ nothingToOpen: false, outOfDate: false, notice: null });
  });

  it('has nothing to open until the change is saved', () => {
    expect(reviewBuildState({ ...base, isDirty: true, hasBeenPublished: false }))
      .toEqual({ nothingToOpen: true, outOfDate: false, notice: 'reviewNotSaved' });
    // Even with an earlier copy published: the unsaved toggle has not reached the server.
    expect(reviewBuildState({ ...base, isDirty: true, hasPendingChanges: true }))
      .toEqual({ nothingToOpen: true, outOfDate: false, notice: 'reviewNotSaved' });
  });

  it('has nothing to open before the first publish', () => {
    expect(reviewBuildState({ ...base, hasBeenPublished: false, hasPendingChanges: true }))
      .toEqual({ nothingToOpen: true, outOfDate: false, notice: 'neverPublished' });
  });

  it('calls a published copy out of date, not missing, when changes are pending', () => {
    expect(reviewBuildState({ ...base, hasPendingChanges: true }))
      .toEqual({ nothingToOpen: false, outOfDate: true, notice: 'changesNotInCopy' });
  });

  it('says nothing about a current copy', () => {
    expect(reviewBuildState(base)).toEqual({ nothingToOpen: false, outOfDate: false, notice: null });
  });
});

describe('reviewStatus', () => {
  const base = { enabled: true, notBuilt: false, outOfDate: false, expired: false };

  it('ranks off, then not built, then out of date, then closed, then live', () => {
    expect(reviewStatus({ ...base, enabled: false, notBuilt: true, outOfDate: true, expired: true })).toBe('off');
    expect(reviewStatus({ ...base, notBuilt: true, outOfDate: true, expired: true })).toBe('publishToApply');
    expect(reviewStatus({ ...base, outOfDate: true, expired: true })).toBe('publishToUpdate');
    expect(reviewStatus({ ...base, expired: true })).toBe('closed');
    expect(reviewStatus(base)).toBe('live');
  });
});

describe('reviewExpiryKey', () => {
  it('says when the copy closes or closed, or that it does not', () => {
    expect(reviewExpiryKey(true, false)).toBe('reviewClosesOn');
    expect(reviewExpiryKey(true, true)).toBe('reviewClosedOn');
    expect(reviewExpiryKey(false, false)).toBe('reviewNoExpiry');
  });
});

describe('emptyThreadsKey', () => {
  it('tells an empty round from an empty filter', () => {
    expect(emptyThreadsKey(0, 'open')).toBe('noComments');
    expect(emptyThreadsKey(0, 'resolved')).toBe('noComments');
    expect(emptyThreadsKey(3, 'open')).toBe('nothingOpen');
    expect(emptyThreadsKey(3, 'resolved')).toBe('nothingResolved');
  });
});
