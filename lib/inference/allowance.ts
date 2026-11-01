import { detectDeploymentType } from '@/lib/telemetry/config';
import type { ProviderId } from '@/lib/llm/providers/types';

/**
 * The free allowance, which the app calls OSW Studio inference: OSW Studio's own inference server
 * (inference.oswstudio.com), paid for by the project and capped per visitor. It exists only where OSW
 * Studio's own servers can vouch for the caller, and the browser never holds a token:
 *
 * - **The demo** (try.oswstudio.com): an anonymous trial run by the demo's server (`./trial/`). The
 *   browser passes a bot check (`./trial-check.ts`) for a session cookie, and the server mints a token
 *   for each request.
 * - **Hosted instances**: the instance asks the gateway for its signed-in user's token
 *   (`./account-token.ts`).
 *
 * Everywhere else (a git clone, the desktop app, self-hosted Server Mode) it is not offered at all.
 */

export const OSWS_PROVIDER: ProviderId = 'osws';
export const OSWS_AGENT_MODEL = 'osws/agent';
/** The inference server's API. */
export const OSWS_INFERENCE_API = 'https://inference.oswstudio.com/v1';

/** Where the server sends the allowance's requests: `OSWS_INFERENCE_URL` (local testing), else the inference server. */
export function inferenceBaseUrl(): string {
  return (process.env.OSWS_INFERENCE_URL || OSWS_INFERENCE_API).replace(/\/+$/, '');
}

export function freeAllowanceOffered(): boolean {
  const type = detectDeploymentType();
  return type === 'demo' || type === 'managed';
}

/** Hosted instance: the token is the signed-in user's, from the gateway, rather than a trial session's. */
export function allowanceFromServer(): boolean {
  return detectDeploymentType() === 'managed';
}
