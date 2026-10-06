import { configManager } from '@/lib/config/storage';
import type { ModelRef } from '@/lib/llm/models/assignment';

/**
 * What "Continue" sends after a task stopped on a provider error or limit: a new turn on the same
 * conversation, so the agent picks up from its own last step. Addressed to the agent, and shown in
 * the thread as the user's message.
 */
const CONTINUE_AFTER_STOP_PROMPT = 'Continue the task from where you stopped.'; // i18n-ignore: sent to the agent as the user's message

/**
 * Continue a stopped task as a new turn, on `withModel` when the user picked one from the stopped
 * card, which also becomes the working selection so the footer shows the same model.
 */
export function continueAfterStop(withModel: ModelRef | undefined, generate: (prompt: string) => unknown): void {
  if (withModel) configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: withModel });
  void generate(CONTINUE_AFTER_STOP_PROMPT);
}
