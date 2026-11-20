import { describe, it, expect } from 'vitest';
import { parseStreamingResponse } from '../streaming-parser';

/**
 * OpenRouter passes the upstream model's own finish reason as `native_finish_reason` beside its
 * normalised `finish_reason`. For an answer with no text and no tool call, it is the only record of
 * why (Gemini's `MALFORMED_FUNCTION_CALL`, say).
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

describe('the finish reasons of a streamed answer', () => {
  it('keeps the upstream model\'s own reason beside the normalised one', async () => {
    const result = await parseStreamingResponse(makeSSEStream([
      sse({ choices: [{ delta: { content: '' }, index: 0 }] }),
      sse({ choices: [{ delta: {}, index: 0, finish_reason: 'stop', native_finish_reason: 'MALFORMED_FUNCTION_CALL' }] }),
      'data: [DONE]\n\n',
    ]), { provider: 'openrouter', model: 'google/gemini-4-neon' });

    expect({ finishReason: result.finishReason, nativeFinishReason: result.nativeFinishReason })
      .toEqual({ finishReason: 'stop', nativeFinishReason: 'MALFORMED_FUNCTION_CALL' });
  });

  it('has no native reason where the provider gives none', async () => {
    const result = await parseStreamingResponse(makeSSEStream([
      sse({ choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]), { provider: 'openai', model: 'gpt-5' });

    expect(result.finishReason).toBe('stop');
    expect(result.nativeFinishReason).toBeUndefined();
  });
});
