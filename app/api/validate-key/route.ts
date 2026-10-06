import { NextRequest, NextResponse } from 'next/server';
import { ProviderId } from '@/lib/llm/providers/types';
import { getProvider } from '@/lib/llm/providers/registry';
import { logger } from '@/lib/utils';

export async function POST(request: NextRequest) {
  const { apiKey, provider } = await request.json().catch(() => ({}));
  if (!apiKey || !provider) {
    return NextResponse.json(
      { error: 'API key and provider are required' },
      { status: 400 }
    );
  }

  try {

    const providerConfig = getProvider(provider as ProviderId);
    let isValid = false;

    switch (provider) {
      case 'openrouter':
        const openrouterResp = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        isValid = openrouterResp.ok;
        break;

      case 'openai':
      case 'openai-codex':
        const openaiResp = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        isValid = openaiResp.ok;
        break;

      case 'anthropic':
        const anthropicResp = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          }
        });
        isValid = anthropicResp.ok;
        break;

      case 'groq':
        const groqResp = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        isValid = groqResp.ok;
        break;

      case 'ollama':
      case 'lmstudio':
      case 'llamacpp':
        const localResp = await fetch(`${providerConfig.baseUrl}/models`);
        isValid = localResp.ok;
        break;

      case 'gemini':
        isValid = !!apiKey && apiKey.length > 10;
        break;

      case 'zhipu':
      case 'minimax':
        isValid = !!apiKey && apiKey.length > 10;
        break;

      case 'huggingface':
        const hfResp = await fetch('https://huggingface.co/api/whoami-v2', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        isValid = hfResp.ok;
        break;

      // Both model catalogs are public, so listing models says nothing about the key.
      case 'pollinations': {
        const polResp = await fetch('https://gen.pollinations.ai/account/key', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        isValid = polResp.ok && (await polResp.json().catch(() => null))?.valid === true;
        break;
      }

      case 'vercel': {
        const vercelResp = await fetch('https://ai-gateway.vercel.sh/v1/credits', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        isValid = vercelResp.ok;
        break;
      }

      default:
        // For other OpenAI-compatible providers (including custom ones)
        if (providerConfig.baseUrl) {
          const headers: Record<string, string> = {};
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          const defaultResp = await fetch(`${providerConfig.baseUrl}/models`, { headers });
          isValid = defaultResp.ok;
        } else {
          isValid = false;
        }
        break;
    }

    return NextResponse.json({ valid: isValid });

  } catch (error) {
    // The provider could not be asked, which says nothing about the key.
    logger.error('Validation error:', error);
    return NextResponse.json({ error: 'Could not reach the provider' }, { status: 502 });
  }
}
