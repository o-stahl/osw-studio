import { describe, it, expect } from 'vitest';
import { parseStreamingResponse } from '../streaming-parser';

/**
 * OpenRouter's free router picks a model itself and names it on each chunk; that is the only place
 * the app learns which model is answering, so the parser announces it once.
 */

function makeSSEStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

const sse = (data: object) => `data: ${JSON.stringify(data)}\n\n`;

async function events(model: string, answeredBy: string) {
  const seen: Array<{ event: string; data?: unknown }> = [];
  await parseStreamingResponse(makeSSEStream([
    sse({ model: answeredBy, choices: [{ delta: { content: 'Hel' }, index: 0 }] }),
    sse({ model: answeredBy, choices: [{ delta: { content: 'lo' }, index: 0, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]), { provider: 'openrouter', model, onProgress: (event, data) => seen.push({ event, data }) });
  return seen.filter((e) => e.event === 'model_resolved');
}

describe('the model OpenRouter\'s free router answered with', () => {
  it('is announced once', async () => {
    expect(await events('openrouter/free', 'nvidia/nemotron-3-super-120b-a12b:free')).toEqual([
      { event: 'model_resolved', data: { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' } },
    ]);
  });

  it('is not announced for a model the request named, even when the reply spells it differently', async () => {
    expect(await events('anthropic/claude-x', 'anthropic/claude-x-20260101')).toEqual([]);
  });
});
