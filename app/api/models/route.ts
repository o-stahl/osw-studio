import { NextRequest, NextResponse } from 'next/server';
import { ProviderId, InputModality } from '@/lib/llm/providers/types';
import { getProvider } from '@/lib/llm/providers/registry';
import { assertPublicHttpUrl } from '@/lib/llm/providers/url-safety';
import { CODEX_BASE_URL, createCodexHeaders, getCodexAccountId } from '@/lib/llm/codex-utils';
import { logger } from '@/lib/utils';
import pkg from '@/package.json';
import type { ModelEntry } from '@/lib/llm/llm-client';

// Shape of an entry in GET /backend-api/codex/models (only the fields we read).
interface CodexCatalogModel {
  slug?: string;
  display_name?: string;
  description?: string;
  context_window?: number;
  max_context_window?: number;
  input_modalities?: InputModality[];
  visibility?: string;
  priority?: number;
}

const CODEX_DEFAULT_MODALITIES: InputModality[] = ['text', 'image'];

export async function POST(request: NextRequest) {
  try {
    const { apiKey, provider, baseUrl: requestBaseUrl } = await request.json();
    
    if (!provider) {
      return NextResponse.json(
        { error: 'Provider is required' },
        { status: 400 }
      );
    }

    const providerConfig = getProvider(provider as ProviderId);
    const customBaseUrl = requestBaseUrl;
    const effectiveBaseUrl = customBaseUrl || providerConfig.baseUrl;

    // Custom endpoints are external-only: reject loopback/private/non-http URLs. Built-in
    // local providers (Ollama/LM Studio/llama.cpp) legitimately point at localhost and are
    // exempt. On hosted instances, network egress filtering blocks DNS-rebinding past this.
    if (customBaseUrl && !providerConfig.isLocal) assertPublicHttpUrl(customBaseUrl);

    // If no API key but required (and not OAuth), return empty array
    if (providerConfig.apiKeyRequired && !apiKey && !providerConfig.usesOAuth) {
      return NextResponse.json({ models: [] });
    }

    let models: ModelEntry[] = [];

    try {
      switch (provider) {
        case 'openrouter':
          const orResponse = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': request.headers.get('referer') || 'http://localhost:3000',
              'X-Title': 'OSW-Studio'
            }
          });
          if (orResponse.ok) {
            const orData = await orResponse.json();
            models = orData.data
              ?.filter((model: { id: string }) =>
                model.id.includes('deepseek') ||
                model.id.includes('qwen') ||
                model.id.includes('claude') ||
                model.id.includes('gpt') ||
                model.id.includes('llama')
              )
              ?.map((model: { id: string; context_length: number; architecture?: { input_modalities?: string[] } }) => ({
                id: model.id,
                contextLength: model.context_length,
                inputModalities: model.architecture?.input_modalities,
              })) || [];
          }
          break;

        case 'anthropic':
          const anthropicResponse = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            }
          });
          if (anthropicResponse.ok) {
            const anthropicData = await anthropicResponse.json();
            models = anthropicData.data?.map((model: { id: string; capabilities?: Record<string, { supported?: boolean }> }) => {
              const modalities: string[] = ['text'];
              if (model.capabilities?.image_input?.supported) modalities.push('image');
              return { id: model.id, inputModalities: modalities };
            }) || [];
          }
          break;

        case 'openai':
          const openaiResponse = await fetch('https://api.openai.com/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            }
          });
          if (openaiResponse.ok) {
            const openaiData = await openaiResponse.json();
            models = openaiData.data?.map((model: { id: string }) => model.id) || [];
          }
          break;

        case 'openai-codex': {
          const headers = createCodexHeaders(undefined, getCodexAccountId(apiKey), apiKey);
          headers.set('accept', 'application/json');
          const codexResponse = await fetch(
            `${CODEX_BASE_URL}/codex/models?client_version=${encodeURIComponent(pkg.version)}`,
            { headers },
          );
          if (!codexResponse.ok) throw new Error(`Codex models returned HTTP ${codexResponse.status}`);

          const codexData = await codexResponse.json();
          const catalog: CodexCatalogModel[] = codexData.models || [];
          models = catalog
            // Hardcoded 5.5/5.6-series gate — drop when the catalog's
            // visibility/priority alone is enough to hide unwanted series.
            .filter((model): model is CodexCatalogModel & { slug: string } =>
              model.visibility === 'list' && !!model.slug && /^gpt-5\.[56]/.test(model.slug))
            .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
            .map((model) => ({
              id: model.slug,
              name: model.display_name || model.slug,
              description: model.description,
              contextLength: model.context_window ?? model.max_context_window,
              supportsFunctions: true,
              supportsVision: (model.input_modalities ?? CODEX_DEFAULT_MODALITIES).includes('image'),
              inputModalities: model.input_modalities ?? CODEX_DEFAULT_MODALITIES,
              outputModalities: ['text'],
            }));
          models.push(...(providerConfig.models || []).filter(model => model.outputModalities?.includes('image')));
          break;
        }

        case 'groq':
          const groqResponse = await fetch('https://api.groq.com/openai/v1/models', {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            }
          });
          if (groqResponse.ok) {
            const groqData = await groqResponse.json();
            models = groqData.data?.map((model: { id: string }) => model.id) || [];
          }
          break;

        case 'ollama':
          try {
            // Use Ollama's native API endpoint for model discovery
            // 127.0.0.1, not localhost: Node may resolve localhost to IPv6 (::1)
            // while local servers bind IPv4 only — that yields ECONNREFUSED.
            const ollamaResponse = await fetch(`http://127.0.0.1:11434/api/tags`);
            if (ollamaResponse.ok) {
              const ollamaData = await ollamaResponse.json();
              // Ollama returns models array directly in the response
              models = ollamaData.models?.map((m: any) => m.name) || [];
            }
          } catch (error) {
            logger.debug('Ollama models fetch failed (server not running?):', error);
          }
          break;

        case 'lmstudio':
          try {
            // LM Studio REST API returns capabilities (vision, tool_use)
            // Force IPv4 — localhost can resolve to ::1 where the server isn't bound.
            const lmsRestUrl = (providerConfig.baseUrl?.replace('/v1', '') || 'http://localhost:1234').replace('localhost', '127.0.0.1');
            const lmsResponse = await fetch(`${lmsRestUrl}/api/v1/models`);
            if (lmsResponse.ok) {
              const lmsData = await lmsResponse.json();
              // LM Studio's /api/v1/models returns { models: [{ key, type, capabilities }] };
              // the OpenAI-compat shape (older builds / fallback) is { data: [{ id }] }.
              const lmsModels = Array.isArray(lmsData) ? lmsData : (lmsData.models || lmsData.data || []);
              models = lmsModels
                .filter((m: any) => !String(m.type ?? '').startsWith('embed'))
                .map((m: any) => {
                  const modalities: string[] = ['text'];
                  if (m.capabilities?.vision) modalities.push('image');
                  return { id: m.key || m.id, inputModalities: modalities };
                });
            }
          } catch (error) {
            logger.debug('LM Studio models fetch failed (server not running?):', error);
          }
          break;

        case 'llamacpp':
        case 'meshllm':
          try {
            const lmResponse = await fetch(`${providerConfig.baseUrl?.replace('localhost', '127.0.0.1')}/models`);
            if (lmResponse.ok) {
              const lmData = await lmResponse.json();
              models = lmData.data?.map((m: any) => m.id) || [];
            }
          } catch (error) {
            logger.debug(`${provider} models fetch failed (server not running?):`, error);
          }
          break;

        case 'gemini':
          const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${apiKey}`
          );
          if (geminiResponse.ok) {
            const geminiData = await geminiResponse.json();
            models = (geminiData.models || [])
              .filter((m: any) =>
                m.supportedGenerationMethods?.includes('generateContent') &&
                /gemini/i.test(m.name)
              )
              .map((m: any) => ({
                id: m.name.replace('models/', ''),
                contextLength: m.inputTokenLimit,
                inputModalities: m.supportedGenerationMethods?.includes('generateContent')
                  ? ['text', 'image'] : ['text'],
              }));
          }
          break;

        case 'huggingface':
          try {
            const hfHeaders: Record<string, string> = {};
            if (apiKey) {
              hfHeaders['Authorization'] = `Bearer ${apiKey}`;
            }
            const hfResponse = await fetch('https://router.huggingface.co/v1/models', {
              headers: hfHeaders,
            });
            if (hfResponse.ok) {
              const hfData = await hfResponse.json();
              models = hfData.data?.map((m: any) => ({
                id: m.id,
                inputModalities: m.architecture?.input_modalities,
              })) || [];
            }
          } catch (error) {
            logger.error('HuggingFace models fetch error:', error);
          }
          break;

        case 'opencode-go': {
          const mdResp = await fetch('https://models.dev/api.json');
          if (mdResp.ok) {
            const mdData = await mdResp.json();
            const ocg = (mdData['opencode-go']?.models ?? {}) as Record<string, any>;
            models = Object.values(ocg)
              .filter((m: any) => m.status !== 'deprecated')
              .map((m: any) => ({
                id: m.id,
                contextLength: m.limit?.context,
                inputModalities: m.modalities?.input,
              }));
          }
          break;
        }

        default:
          // For other OpenAI-compatible providers (including custom ones)
          if (effectiveBaseUrl) {
            const headers: Record<string, string> = {};
            if (apiKey) {
              headers['Authorization'] = `Bearer ${apiKey}`;
            }
            const defaultResponse = await fetch(`${effectiveBaseUrl}/models`, { headers });
            const responseText = await defaultResponse.text();
            if (defaultResponse.ok) {
              try {
                const defaultData = JSON.parse(responseText);
                // OpenAI-compatible shape: { data: [...] }. Some providers use { models: [...] }
                // or a plain array. Each entry may be a string id or an object with id/name/model.
                const list = Array.isArray(defaultData)
                  ? defaultData
                  : (defaultData.data || defaultData.models || defaultData.list || []);
                models = list
                  .map((m: any) => (typeof m === 'string' ? m : (m.id || m.model || m.name || m.model_id || m.slug)))
                  .filter(Boolean);
                if (models.length === 0) {
                  logger.warn(`[models] ${provider} /models returned no recognizable models`);
                  logger.debug(`[models] ${provider} raw response:`, responseText.slice(0, 300));
                }
              } catch {
                logger.warn(`[models] ${provider} /models returned non-JSON`);
                logger.debug(`[models] ${provider} raw response:`, responseText.slice(0, 300));
              }
            } else {
              logger.warn(`[models] ${provider} /models returned HTTP ${defaultResponse.status}`);
              logger.debug(`[models] ${provider} raw response:`, responseText.slice(0, 300));
            }
          }
          break;
      }
    } catch (error) {
      logger.error(`Error fetching models for ${provider}:`, error);
      // Fall back to hardcoded models if available
      if (providerConfig.models) {
        models = providerConfig.models;
      }
    }

    return NextResponse.json({ models });

  } catch (error) {
    logger.error('Models API error:', error);
    return NextResponse.json({ models: [] });
  }
}
