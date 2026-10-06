import { NextRequest, NextResponse } from 'next/server';
import { buildSnapshot } from '@/lib/llm/suggestions/snapshot';
import { OPENROUTER_ATTRIBUTION } from '@/lib/llm/request-builder';

const TIMEOUT_MS = 10_000;

/**
 * Benchmark and usage figures from OpenRouter's Data API, read with the caller's own key and
 * reduced to what suggestions rank by. The API needs a key and allows 500 requests a day per
 * account; the browser asks at most once a day.
 */
export async function POST(request: NextRequest) {
  let apiKey: unknown;
  try {
    ({ apiKey } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (typeof apiKey !== 'string' || !apiKey) return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });

  const get = (path: string) => fetch(`https://openrouter.ai/api/v1/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  try {
    const [benchmarks, tasks] = await Promise.all([get('benchmarks?source=artificial-analysis'), get('classifications/task')]);
    if (!benchmarks.ok || !tasks.ok) {
      return NextResponse.json({ error: 'OpenRouter Data API unavailable' }, { status: 502 });
    }
    const taskBody = await tasks.json();
    const asOf = typeof taskBody?.data?.as_of === 'string' ? taskBody.data.as_of : new Date().toISOString().slice(0, 10);
    return NextResponse.json(buildSnapshot(await benchmarks.json(), taskBody, asOf));
  } catch {
    return NextResponse.json({ error: 'OpenRouter Data API unavailable' }, { status: 502 });
  }
}
