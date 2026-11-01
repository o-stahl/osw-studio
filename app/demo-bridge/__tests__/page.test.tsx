import { describe, it, expect, afterEach, vi } from 'vitest';
import type React from 'react';

/** The bridge page exists only on the hosted demo, and answers the origins its gateway lists. */
const mocks = vi.hoisted(() => ({ bridgeOrigins: vi.fn(async () => ['https://inst-1.example.com']) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('@/lib/demo-bridge/origins', () => ({ bridgeOrigins: mocks.bridgeOrigins }));

import DemoBridgePage from '../page';
import { DemoBridgeHost } from '@/components/demo-bridge-host';

afterEach(() => vi.unstubAllEnvs());

describe('/demo-bridge', () => {
  it('is not found anywhere but the hosted demo', async () => {
    vi.stubEnv('DEMO_GATEWAY_URL', '');
    await expect(DemoBridgePage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.bridgeOrigins).not.toHaveBeenCalled();
  });

  it("serves the bridge with its gateway's instance origins on the demo", async () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    const el = (await DemoBridgePage()) as React.ReactElement<React.ComponentProps<typeof DemoBridgeHost>>;
    expect(el.type).toBe(DemoBridgeHost);
    expect(el.props.allowedOrigins).toEqual(['https://inst-1.example.com']);
  });
});
