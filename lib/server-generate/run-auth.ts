import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * A server-side run (`server-orchestrator-runner.ts`) sends its model requests to this server's own
 * `/api/generate`, without the user's session cookie. For the free allowance, whose token that route
 * looks up for the user itself (lib/inference/account-token.ts), the run says whom it runs for and
 * proves it is this process with a secret that exists only in its memory. A request without the
 * secret is treated like any other.
 */

const SECRET_HEADER = 'x-osws-server-run';
const USER_HEADER = 'x-osws-server-run-user';

// On globalThis: Next can load this module more than once in one process, and every copy must agree.
const holder = globalThis as typeof globalThis & { __oswsServerRunSecret?: string };

function secret(): string {
  holder.__oswsServerRunSecret ??= randomBytes(32).toString('base64url');
  return holder.__oswsServerRunSecret;
}

/** The headers a server-side run sends with its requests to this server, for the user it runs for. */
export function serverRunHeaders(userId: string): Record<string, string> {
  return { [SECRET_HEADER]: secret(), [USER_HEADER]: userId };
}

/** The user a server-side run is for, when the request carries this process's secret; otherwise null. */
export function serverRunUser(headers: Headers): string | null {
  const given = headers.get(SECRET_HEADER);
  const userId = headers.get(USER_HEADER);
  if (!given || !userId) return null;
  const expected = Buffer.from(secret());
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? userId : null;
}
