/** How long a stopping server has to finish its requests before it exits regardless. */
export const SHUTDOWN_GRACE_MS = 5000;

const EXIT_CODES = { SIGTERM: 143, SIGINT: 130 } as const;

let installed = false;

/**
 * On SIGTERM or SIGINT, exits once `SHUTDOWN_GRACE_MS` have passed, whatever is still open.
 *
 * Next's own handler stops the server taking connections and exits when the last open one ends.
 * An events stream (`/api/server-generate/events`, held by every open Server Mode tab) never ends,
 * so without this a server with a tab open stays up until it is killed, which under systemd is its
 * 90 s stop timeout. The timer does not keep the process alive, so a server that finishes sooner
 * still exits as soon as it has.
 */
export function exitAfterShutdownGrace(): void {
  if (installed) return;
  installed = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => process.exit(EXIT_CODES[signal]), SHUTDOWN_GRACE_MS).unref();
    });
  }
}
