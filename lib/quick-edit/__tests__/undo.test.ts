import { describe, it, expect } from 'vitest';
import { undoTarget, redoTarget, retryStart } from '@/lib/quick-edit/undo';

const ids = ['cp_0', 'cp_1', 'cp_2'];

describe('undo and redo over checkpoints', () => {
  it('undo from the newest goes one back, and redo has nowhere to go', () => {
    expect(undoTarget(ids, null)).toBe('cp_1');
    expect(redoTarget(ids, null)).toBeNull();
  });

  it('after an undo, redo returns to where it came from', () => {
    expect(redoTarget(ids, 'cp_1')).toBe('cp_2');
    expect(undoTarget(ids, 'cp_1')).toBe('cp_0');
  });

  it('stops at the oldest', () => {
    expect(undoTarget(ids, 'cp_0')).toBeNull();
  });

  it('has nothing to undo with one checkpoint or none', () => {
    expect(undoTarget(['cp_0'], null)).toBeNull();
    expect(undoTarget([], null)).toBeNull();
    expect(redoTarget([], null)).toBeNull();
  });

  it('treats a cursor on a checkpoint that has since been pruned as being at the newest', () => {
    expect(undoTarget(ids, 'cp_gone')).toBe('cp_1');
    expect(redoTarget(ids, 'cp_gone')).toBeNull();
  });
});

describe('where Retry starts', () => {
  it('starts from the checkpoint before the one the run finished on, not from that one', () => {
    expect(retryStart(ids, 'cp_2')).toBe('cp_1');
    expect(retryStart(ids, 'cp_1')).toBe('cp_0');
  });

  it('has nowhere to start when the run finished on the first checkpoint', () => {
    expect(retryStart(ids, 'cp_0')).toBeNull();
  });

  it('has nowhere to start when the run\'s checkpoint was pruned, rather than guessing from the newest', () => {
    expect(retryStart(ids, 'cp_gone')).toBeNull();
  });
});
