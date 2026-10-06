// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { configManager } from '@/lib/config/storage';
import { continueAfterStop } from '../continue-prompt';

/** The turn "Continue" sends; addressed to the agent, so it stays English. */
const CONTINUE_PROMPT = 'Continue the task from where you stopped.';

beforeEach(() => {
  localStorage.clear();
  configManager.migrateModels();
  configManager.setActiveAssignment({
    ...configManager.getActiveAssignment(),
    agent: { provider: 'openrouter', model: 'x/first' },
    autoCompact: false,
    compactLimit: 50_000,
  });
});

describe('continueAfterStop', () => {
  it('moves the working selection to the model picked on the stopped card, keeping the rest', () => {
    const before = configManager.getActiveAssignment();
    const generate = vi.fn();
    continueAfterStop({ provider: 'groq', model: 'y/second' }, generate);
    expect(configManager.getActiveAssignment()).toEqual({ ...before, agent: { provider: 'groq', model: 'y/second' } });
    expect(generate).toHaveBeenCalledExactlyOnceWith(CONTINUE_PROMPT);
  });

  it('continues on the same selection when no model was picked', () => {
    const before = configManager.getActiveAssignment();
    const generate = vi.fn();
    continueAfterStop(undefined, generate);
    expect(configManager.getActiveAssignment()).toEqual(before);
    expect(generate).toHaveBeenCalledExactlyOnceWith(CONTINUE_PROMPT);
  });
});
