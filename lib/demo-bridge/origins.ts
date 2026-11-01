import { demoGatewayUrl, gatewayOrigin } from '@/lib/demo';

/**
 * The instance origins the demo's bridge answers, from the hosted service's gateway: every
 * instance's studio address, exactly. A published site is a subdomain of an instance and shares
 * its site, so a pattern would let it in; an exact list does not. Fails closed: no gateway, or
 * no answer, and the bridge answers nobody.
 *
 * The answer is kept in this process (the middleware's fetch has no cache of its own): instances
 * come and go rarely, so a few minutes' staleness only delays a new one. No answer is kept for half
 * a minute, so a gateway that is down is not asked on every request.
 */

const KEEP_MS = 5 * 60_000;
const RETRY_MS = 30_000;

let kept: { until: number; origins: string[] } | null = null;
let pending: Promise<string[]> | null = null;

export function bridgeOrigins(fetchFn: typeof fetch = fetch): Promise<string[]> {
  const gateway = demoGatewayUrl();
  if (!gateway) return Promise.resolve([]);
  if (kept && Date.now() < kept.until) return Promise.resolve(kept.origins);
  pending ??= askGateway(gateway, fetchFn)
    .then((origins) => {
      kept = { until: Date.now() + (origins ? KEEP_MS : RETRY_MS), origins: origins ?? [] };
      return kept.origins;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

async function askGateway(gateway: string, fetchFn: typeof fetch): Promise<string[] | null> {
  try {
    const res = await fetchFn(`${gateway}/api/demo/bridge-origins`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { origins?: unknown };
    if (!Array.isArray(body.origins)) return null;
    return body.origins
      .map((origin) => (typeof origin === 'string' ? gatewayOrigin(origin) : null))
      .filter((origin): origin is string => origin !== null);
  } catch {
    return null;
  }
}

/** Forget the kept answer. For tests. */
export function resetBridgeOrigins(): void {
  kept = null;
  pending = null;
}
