import { NextRequest, NextResponse } from 'next/server';
import { parseOpenRouterKey, parsePollinationsBalance, type ProviderStatus } from '@/lib/llm/provider-status';
import { OPENROUTER_ATTRIBUTION } from '@/lib/llm/request-builder';

const NONE: ProviderStatus = { quota: { kind: 'none' } };
const TIMEOUT_MS = 8_000;

/**
 * The live allowance on the caller's own key. Like `/api/generate` this only forwards the key the
 * browser holds, to a fixed host per provider; it stores nothing.
 */
export async function POST(request: NextRequest) {
  let provider: unknown;
  let apiKey: unknown;
  try {
    ({ provider, apiKey } = await request.json());
  } catch {
    return NextResponse.json(NONE);
  }
  if (typeof apiKey !== 'string' || !apiKey) return NextResponse.json(NONE);

  try {
    if (provider === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return NextResponse.json(response.ok ? parseOpenRouterKey(await response.json()) : NONE);
    }
    if (provider === 'pollinations') {
      const response = await fetch('https://gen.pollinations.ai/account/balance', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return NextResponse.json(response.ok ? parsePollinationsBalance(await response.json()) : NONE);
    }
  } catch {
    // A provider that does not answer has told us nothing; the chat words the limit without numbers.
  }
  return NextResponse.json(NONE);
}
