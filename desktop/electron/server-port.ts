/**
 * The port the desktop app serves on.
 *
 * It used to ask for the first free port in [30011, 50000]. In practice that returned 30011 every
 * time, because the range is scanned from its start, so the app was already stable there by
 * accident. Two things made that worth pinning down:
 *
 * - An MCP connector is registered against a URL. If the port moves, the connector stops reaching
 *   the app, and nothing said so.
 * - The old range ran to 50000, past the start of the ephemeral range macOS allocates outgoing
 *   connections from (49152). A port taken from there can collide with an ephemeral allocation.
 *
 * 30011 stays the number: it is unassigned in the IANA registry, it is not a port development
 * tooling reaches for, and it is below the ephemeral floor on both macOS (49152) and Linux
 * (32768). The fallback range stays below 32768 for the same reason.
 *
 * `OSW_DESKTOP_PORT` overrides it, for running two instances or dodging a conflict.
 */

export const DESKTOP_DEFAULT_PORT = 30011;
export const DESKTOP_FALLBACK_RANGE: [number, number] = [30012, 30111];

export interface PortChoice {
  port: number;
  /** True when the preferred port was taken and a fallback was used. */
  movedFromPreferred: boolean;
  preferred: number;
}

export function preferredPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSW_DESKTOP_PORT;
  if (!raw) return DESKTOP_DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  // A port outside the usable range, or one in the ephemeral range, is ignored rather than
  // honoured: binding there fails or collides, and the app would not start.
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 32767) return DESKTOP_DEFAULT_PORT;
  return parsed;
}

/**
 * Resolve the port to serve on. `probe` answers whether a port is free; it is injected so this is
 * testable without binding sockets.
 */
export async function choosePort(
  probe: (port: number) => Promise<boolean>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PortChoice> {
  const preferred = preferredPort(env);
  if (await probe(preferred)) {
    return { port: preferred, movedFromPreferred: false, preferred };
  }
  for (let port = DESKTOP_FALLBACK_RANGE[0]; port <= DESKTOP_FALLBACK_RANGE[1]; port++) {
    if (port === preferred) continue;
    if (await probe(port)) {
      return { port, movedFromPreferred: true, preferred };
    }
  }
  throw new Error(
    `No free port for the OSW Studio desktop server: ${preferred} and ${DESKTOP_FALLBACK_RANGE[0]}-${DESKTOP_FALLBACK_RANGE[1]} are all in use. Set OSW_DESKTOP_PORT to a free port below 32768.`,
  );
}

/** What to write to the log when the app could not take its usual port. */
export function movedPortWarning(choice: PortChoice): string {
  return `Port ${choice.preferred} was in use, so the desktop server is on ${choice.port} instead. A connector registered at http://localhost:${choice.preferred} will not reach this app until it is restarted on its usual port.`;
}

/**
 * Where the app server listens and the address it knows itself by. `APP_URL` is set as well as
 * `NEXT_PUBLIC_APP_URL`: the app reads it first (lib/web/site-origin.ts), so one inherited from the
 * shell that started the app would otherwise name another address.
 */
export function serverAddressEnv(host: string, port: number): Record<'PORT' | 'HOSTNAME' | 'NEXT_PUBLIC_APP_URL' | 'APP_URL', string> {
  const url = `http://${host}:${port}`;
  return { PORT: String(port), HOSTNAME: host, NEXT_PUBLIC_APP_URL: url, APP_URL: url };
}
