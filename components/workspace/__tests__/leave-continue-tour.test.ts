import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The workspace's small decisions: leaving with unsaved changes, continuing a stop, the tour's lock. */

const continueAfterStop = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/continue-prompt', () => ({ continueAfterStop }));

import { continueHandler, mayLeave, tourLocksInput } from '../index';

beforeEach(() => continueAfterStop.mockClear());

describe('mayLeave', () => {
  it('asks before leaving unsaved changes, and stays when the answer is no', () => {
    const no = vi.fn(() => false);
    expect(mayLeave({ generating: false, isDirty: true }, no)).toBe(false);
    expect(no).toHaveBeenCalledTimes(1);
    expect(mayLeave({ generating: false, isDirty: true }, () => true)).toBe(true);
  });

  it('leaves without asking when nothing is unsaved, or while the agent is generating', () => {
    const ask = vi.fn(() => false);
    expect(mayLeave({ generating: false, isDirty: false }, ask)).toBe(true);
    expect(mayLeave({ generating: true, isDirty: true }, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('continueHandler', () => {
  it('continues on the model picked on the stopped task\'s card', () => {
    const generate = vi.fn();
    const model = { provider: 'openrouter', model: 'm' } as never;
    continueHandler(generate)(model);
    expect(continueAfterStop).toHaveBeenCalledWith(model, generate);
  });

  it('continues on the current model when none was picked', () => {
    const generate = vi.fn();
    continueHandler(generate)();
    expect(continueAfterStop).toHaveBeenCalledWith(undefined, generate);
  });
});

describe('tourLocksInput', () => {
  it('locks the composer for the whole of a running tour, wrap-up included, and not otherwise', () => {
    expect(tourLocksInput({ status: 'running' })).toBe(true);
    expect(tourLocksInput({ status: 'running', currentStep: { id: 'wrap-up' } } as never)).toBe(true);
    expect(tourLocksInput({ status: 'idle' })).toBe(false);
    expect(tourLocksInput({ status: 'completed' })).toBe(false);
  });
});
