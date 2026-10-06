import type { ProviderId } from './types';

/**
 * Which provider a pasted key belongs to, from its shape alone.
 *
 * Most providers stamp their keys with a prefix. A bare `sk-` is shared by several, and a key with
 * no recognisable shape could be anyone's; both return every candidate, and the caller asks each
 * provider which one accepts it. Order is the order to ask in.
 */

const PREFIXES: Array<[RegExp, ProviderId[]]> = [
  [/^sk-or-/, ['openrouter']],
  [/^sk-ant-/, ['anthropic']],
  [/^(sk-proj-|sk-svcacct-|sk-admin-)/, ['openai']],
  [/^hf_/, ['huggingface']],
  [/^gsk_/, ['groq']],
  [/^AIza/, ['gemini']],
  [/^vck_/, ['vercel']],
  [/^(sk|pk)_/, ['pollinations']],
  // Z.ai keys are an id and a secret joined by a dot.
  [/^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/, ['zhipu']],
  [/^sk-/, ['openai', 'deepseek', 'opencode-go', 'minimax']],
];

/** Providers whose keys have no shape of their own; asked when nothing else matched. */
const SHAPELESS: ProviderId[] = ['sambanova', 'minimax', 'deepseek', 'zhipu'];

interface KeyDetection {
  /** Providers the key could belong to, most likely first. One entry means it is certain. */
  candidates: ProviderId[];
}

export function detectKeyProvider(raw: string): KeyDetection {
  const key = raw.trim();
  if (!key) return { candidates: [] };
  for (const [pattern, providers] of PREFIXES) {
    if (pattern.test(key)) return { candidates: providers };
  }
  return { candidates: SHAPELESS };
}
