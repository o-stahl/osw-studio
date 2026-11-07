import { ProviderId } from '@/lib/llm/providers/types';
import { getProvider } from '@/lib/llm/providers/registry';
import type { UsageInfo } from '@/lib/llm/types';
import { OPENROUTER_ATTRIBUTION } from '@/lib/llm/request-builder';

/** Normalizes a judge provider's response usage into UsageInfo (undefined if absent). */
export function extractJudgeUsage(provider: string, model: string, data: unknown): UsageInfo | undefined {
  const d = data as Record<string, unknown>;
  if (provider === 'gemini') {
    const u = d?.usageMetadata as Record<string, number> | undefined;
    if (!u) return undefined;
    return {
      promptTokens: u.promptTokenCount || 0,
      completionTokens: u.candidatesTokenCount || 0,
      totalTokens: u.totalTokenCount || 0,
      model, provider,
    };
  }
  const u = d?.usage as Record<string, number> | undefined;
  if (!u) return undefined;
  if (provider === 'anthropic') {
    const pt = u.input_tokens || 0;
    const ct = u.output_tokens || 0;
    return { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct, model, provider };
  }
  const pt = u.prompt_tokens || 0;
  const ct = u.completion_tokens || 0;
  return { promptTokens: pt, completionTokens: ct, totalTokens: u.total_tokens || pt + ct, model, provider };
}

export interface JudgeConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
}

export interface JudgeContext {
  prompt: string;
  files: Record<string, string>;
  summary: string;
}

export interface JudgeResult {
  passed: boolean;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are a benchmark judge evaluating whether an AI coding assistant completed a task correctly.

You will be given:
1. The original task prompt
2. The final state of project files
3. A summary from the AI assistant

Evaluate whether the task was completed correctly based on the criteria provided.

Respond in EXACTLY this format:
VERDICT: PASS
REASONING: <one paragraph explaining your judgment>

Or:
VERDICT: FAIL
REASONING: <one paragraph explaining what was missing or incorrect>`;

function buildUserMessage(criteria: string, context: JudgeContext): string {
  const fileSummary = Object.entries(context.files)
    .map(([path, content]) => `--- ${path} ---\n${content.substring(0, 2000)}`)
    .join('\n\n');

  return `## Task Prompt
${context.prompt}

## Evaluation Criteria
${criteria}

## Assistant Summary
${context.summary}

## Project Files
${fileSummary}

Evaluate whether the task was completed correctly based on the criteria above.`;
}

function parseVerdict(response: string): JudgeResult {
  const verdictMatch = /VERDICT:\s*(PASS|FAIL)/i.exec(response);
  const reasoningMatch = /REASONING:\s*([\s\S]+)/i.exec(response);

  return {
    passed: verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : false,
    reasoning: reasoningMatch ? reasoningMatch[1].trim() : response.substring(0, 200),
  };
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  provider: ProviderId,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 512,
): Promise<{ text: string; usage?: UsageInfo }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    // The judge runs in the interview completion flow, so these are real requests from the app and
    // carry the same attribution as any other.
    Object.assign(headers, OPENROUTER_ATTRIBUTION);
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Judge API error (${provider}): ${error}`);
  }

  const data = await response.json();
  return { text: data.choices?.[0]?.message?.content || '', usage: extractJudgeUsage(provider, model, data) };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 512,
): Promise<{ text: string; usage?: UsageInfo }> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Judge API error (anthropic): ${error}`);
  }

  const data = await response.json();
  return { text: data.content?.[0]?.text || '', usage: extractJudgeUsage('anthropic', model, data) };
}

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 512,
): Promise<{ text: string; usage?: UsageInfo }> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Judge API error (gemini): ${error}`);
  }

  const data = await response.json();
  return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || '', usage: extractJudgeUsage('gemini', model, data) };
}

export async function runJudgeEvaluation(
  criteria: string,
  context: JudgeContext,
  config: JudgeConfig
): Promise<JudgeResult> {
  const providerConfig = getProvider(config.provider);
  const userMessage = buildUserMessage(criteria, context);

  let responseText: string;

  if (config.provider === 'anthropic') {
    responseText = (await callAnthropic(config.apiKey, config.model, SYSTEM_PROMPT, userMessage)).text;
  } else if (config.provider === 'gemini') {
    responseText = (await callGemini(config.apiKey, config.model, SYSTEM_PROMPT, userMessage)).text;
  } else {
    const baseUrl = providerConfig.baseUrl || 'https://openrouter.ai/api/v1';
    responseText = (await callOpenAICompatible(
      baseUrl, config.apiKey, config.model, config.provider, SYSTEM_PROMPT, userMessage
    )).text;
  }

  return parseVerdict(responseText);
}

// ---- Structured (multi-criteria) judge: one call, one verdict per criterion ----

const STRUCTURED_SYSTEM_PROMPT = `You are a completion judge. You are given several numbered criteria and the current state of project files. For EACH criterion, decide whether the files actually satisfy it.

Judge ONLY against what is actually recorded in the files — do not assume or invent. Respond with one line per criterion, EXACTLY in this format:
<number>: PASS
or
<number>: FAIL - <short reason of what is missing>

Output nothing else.`;

/**
 * How much of each file the structured judge reads. It judges the artifacts themselves, so it reads
 * them whole: at 2,000 characters a thorough brief lost its later sections, and the judge failed
 * items for text it was never shown.
 */
const STRUCTURED_FILE_CHARS = 24_000;

/**
 * The structured judge's reply budget. A reasoning model spends tokens before it answers; at 512 it
 * could run out before the verdict lines, and every item then failed as unverified.
 */
const STRUCTURED_MAX_TOKENS = 4096;

function buildStructuredUserMessage(criteria: string[], context: JudgeContext): string {
  const fileSummary = Object.entries(context.files)
    .map(([path, content]) => {
      const cut = content.length > STRUCTURED_FILE_CHARS;
      return `--- ${path} ---\n${cut ? `${content.substring(0, STRUCTURED_FILE_CHARS)}\n[file cut at ${STRUCTURED_FILE_CHARS} characters]` : content}`;
    })
    .join('\n\n') || '(no files)';
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

  return `## Context
${context.prompt}

## Criteria to evaluate
${criteriaList}

## Project Files
${fileSummary}

Evaluate each numbered criterion against the files above.`;
}

/**
 * Parses one PASS/FAIL verdict per criterion from the judge's response.
 * Tolerates "1:", "1.", "1)", "ITEM 1:", and en/em-dash reason separators.
 * Any criterion without a parseable verdict fails closed.
 */
export function parseStructuredVerdicts(response: string, count: number): JudgeResult[] {
  const results: JudgeResult[] = [];
  for (let i = 1; i <= count; i++) {
    const re = new RegExp(`^\\s*(?:item\\s*|#)?${i}\\s*[:.)\\]]\\s*(PASS|FAIL)\\b\\s*[-–—:]?\\s*(.*)$`, 'im');
    const m = re.exec(response);
    if (m) {
      results.push({ passed: m[1].toUpperCase() === 'PASS', reasoning: (m[2] || '').trim() });
    } else {
      results.push({ passed: false, reasoning: 'Could not verify this item.' });
    }
  }
  return results;
}

/**
 * Evaluates multiple criteria in a single judge call. Returns one verdict per
 * criterion, in the same order as the input.
 */
export async function runStructuredJudge(
  criteria: string[],
  context: JudgeContext,
  config: JudgeConfig
): Promise<{ verdicts: JudgeResult[]; usage?: UsageInfo }> {
  if (criteria.length === 0) return { verdicts: [] };
  const providerConfig = getProvider(config.provider);
  const userMessage = buildStructuredUserMessage(criteria, context);

  let result: { text: string; usage?: UsageInfo };
  if (config.provider === 'anthropic') {
    result = await callAnthropic(config.apiKey, config.model, STRUCTURED_SYSTEM_PROMPT, userMessage, STRUCTURED_MAX_TOKENS);
  } else if (config.provider === 'gemini') {
    result = await callGemini(config.apiKey, config.model, STRUCTURED_SYSTEM_PROMPT, userMessage, STRUCTURED_MAX_TOKENS);
  } else {
    const baseUrl = providerConfig.baseUrl || 'https://openrouter.ai/api/v1';
    result = await callOpenAICompatible(
      baseUrl, config.apiKey, config.model, config.provider, STRUCTURED_SYSTEM_PROMPT, userMessage, STRUCTURED_MAX_TOKENS
    );
  }

  return { verdicts: parseStructuredVerdicts(result.text, criteria.length), usage: result.usage };
}
