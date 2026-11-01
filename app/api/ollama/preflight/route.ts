import { NextRequest, NextResponse } from 'next/server';
import { getProvider } from '@/lib/llm/providers/registry';
import { ollamaOrigin, resolveOllamaNumCtx } from '@/lib/llm/ollama-adapter';
import type { PreflightCheck, PreflightResult } from '@/lib/llm/ollama-preflight';
import { isDemo } from '@/lib/demo';

/**
 * Checks an Ollama setup the way a task would use it and returns one row per check,
 * each with the command that fixes it. Requests go through this server, so the check
 * runs from the same place the tasks do; a hosted instance cannot reach a user's
 * machine at all, which is reported as such rather than as "not running".
 */

// True when the server is not on the visitor's computer (the HF Space, the hosted demo). Read per request.
const hosted = () => Boolean(process.env.SPACE_ID) || isDemo();

async function getJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const model = typeof body.model === 'string' ? body.model : '';
  const requested = typeof body.contextLength === 'number' ? body.contextLength : undefined;
  const origin = ollamaOrigin(getProvider('ollama').baseUrl || 'http://127.0.0.1:11434');

  const checks: PreflightCheck[] = [];
  const result: PreflightResult = { checks, models: [] };

  try {
    const version = await getJson<{ version?: string }>(`${origin}/api/version`);
    result.version = version?.version;
    checks.push({ id: 'reachable', ok: true, detail: `Ollama ${result.version ?? ''} at ${origin}`.trim() });
  } catch {
    checks.push({
      id: 'reachable',
      ok: false,
      detail: hosted()
        ? 'This hosted instance cannot reach a model server on your computer. Ollama works in the desktop app or a self-hosted OSW Studio.'
        : `Nothing answered at ${origin}.`,
      fix: hosted() ? undefined : 'ollama serve',
      ...(hosted() ? { hosted: true as const } : {}),
    });
    return NextResponse.json(result);
  }

  let tags: Array<{ name: string }> = [];
  try {
    tags = (await getJson<{ models?: Array<{ name: string }> }>(`${origin}/api/tags`))?.models ?? [];
  } catch {
    // Treated as no models below.
  }
  result.models = tags.map((t) => t.name);
  if (result.models.length === 0) {
    checks.push({ id: 'models', ok: false, detail: 'No models are pulled.', fix: 'ollama pull qwen3:4b' });
    return NextResponse.json(result);
  }
  checks.push({ id: 'models', ok: true, detail: `${result.models.length} model${result.models.length === 1 ? '' : 's'} pulled` });

  if (!model) {
    checks.push({ id: 'model_pulled', ok: false, detail: 'No Ollama model selected. Pick one under Settings → Models, then check again.' });
    return NextResponse.json(result);
  }

  let show: { capabilities?: unknown; model_info?: Record<string, unknown> };
  try {
    show = await getJson<typeof show>(`${origin}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
  } catch {
    checks.push({ id: 'model_pulled', ok: false, detail: `${model} is not pulled.`, fix: `ollama pull ${model}` });
    return NextResponse.json(result);
  }
  checks.push({ id: 'model_pulled', ok: true, detail: `${model} is pulled` });

  const capabilities = Array.isArray(show.capabilities) ? (show.capabilities as string[]) : [];
  const hasTools = capabilities.includes('tools');
  checks.push({
    id: 'tools',
    ok: hasTools,
    detail: hasTools ? `${model} supports tool calls` : `${model} does not support tool calls, which every task needs.`,
    fix: hasTools ? undefined : 'ollama pull qwen3:4b',
  });

  const info = show.model_info ?? {};
  const entry = Object.entries(info).find(([k]) => k.endsWith('.context_length'));
  const trained = entry && typeof entry[1] === 'number' ? entry[1] : undefined;
  const numCtx = resolveOllamaNumCtx(trained, requested);
  const capped = trained !== undefined && numCtx < resolveOllamaNumCtx(undefined, requested);
  checks.push({
    id: 'context',
    ok: true,
    ...(capped ? { capped: true as const } : {}),
    detail: capped
      ? `Loaded with a ${numCtx.toLocaleString()}-token context, the model's limit (the setting asks for more)`
      : `Loaded with a ${numCtx.toLocaleString()}-token context${trained ? ` (model limit ${trained.toLocaleString()})` : ''}`,
  });

  return NextResponse.json(result);
}
