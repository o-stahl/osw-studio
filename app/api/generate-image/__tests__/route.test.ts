import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/generate-image/route';

function codexToken(accountId = 'acct-123'): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `header.${payload}.signature`;
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/generate-image Codex image generation', () => {
  it('uses the Responses image_generation tool and returns its PNG', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response([
      'event: response.output_item.done',
      'data: {"item":{"type":"image_generation_call","result":"png-base64"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = {
      json: async () => ({
        provider: 'openai-codex',
        apiKey: codexToken(),
        model: 'gpt-image-2-high',
        prompt: 'a lighthouse in a storm',
        image_config: { aspect_ratio: '16:9' },
      }),
    } as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ image: 'data:image/png;base64,png-base64' });

    const [url, maybeInit] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = maybeInit!;
    const headers = init.headers as Headers;
    expect(headers.get('chatgpt-account-id')).toBe('acct-123');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5.5');
    expect(body.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2',
      quality: 'high',
      size: '1536x1024',
    });
    expect(body.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'image_generation' }],
    });
  });
});
