import { notFound } from 'next/navigation';

import { DemoBridgeHost } from '@/components/demo-bridge-host';
import { isDemo } from '@/lib/demo';
import { bridgeOrigins } from '@/lib/demo-bridge/origins';

// Read per request: the allowed origins come from the gateway, and the demo is a run-time setting.
export const dynamic = 'force-dynamic';

/** The demo's bridge page (`lib/demo-bridge/protocol.ts`). Nothing to see: it lives in a hidden frame. */
export default async function DemoBridgePage() {
  if (!isDemo()) notFound();
  return <DemoBridgeHost allowedOrigins={await bridgeOrigins()} />;
}
