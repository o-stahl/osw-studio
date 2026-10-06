import type { ProviderId } from './providers/types';

/**
 * Context length for local model servers.
 *
 * A cloud model's window is the provider's business. A local one is loaded on the user's
 * machine, where the window sets memory use and, for Ollama, is decided per request: with
 * nothing set, Ollama loads every model at 4096 tokens and drops the start of anything
 * longer. So local providers carry a user-set context length that bounds compaction and,
 * where the server takes it, is applied at load.
 *
 * How each server takes it (checked against their docs and, for Ollama, live):
 * - Ollama: per request, `options.num_ctx` on the native chat endpoint.
 * - LM Studio: at load only (`lms load --context-length`, or the GUI); the setting here must match.
 * - llama.cpp: at startup only (`llama-server -c`); the setting here must match.
 * - mesh-llm: not configurable from the client; the setting here must match the server.
 */
export const DEFAULT_LOCAL_CONTEXT_LENGTH = 32768;

/** The context length a local provider runs with: the user's setting, else the default. */
export function resolveLocalContextLength(setting: number | undefined | null): number {
  return setting && setting > 0 ? Math.floor(setting) : DEFAULT_LOCAL_CONTEXT_LENGTH;
}

/** Compaction cannot be allowed past the window the model is loaded with. */
export function boundCompactionLimit(limit: number, localContextLength: number | undefined): number {
  return localContextLength ? Math.min(limit, localContextLength) : limit;
}

export const LOCAL_CONTEXT_APPLIED: Partial<Record<ProviderId, boolean>> = { ollama: true };
