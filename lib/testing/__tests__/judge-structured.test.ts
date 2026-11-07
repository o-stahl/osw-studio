import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseStructuredVerdicts, extractJudgeUsage, runStructuredJudge } from '../judge';

describe('parseStructuredVerdicts', () => {
  it('parses per-item PASS/FAIL with reasons, in order', () => {
    const r = parseStructuredVerdicts('1: PASS\n2: FAIL - missing audience\n3: PASS', 3);
    expect(r).toHaveLength(3);
    expect(r[0].passed).toBe(true);
    expect(r[1].passed).toBe(false);
    expect(r[1].reasoning).toContain('audience');
    expect(r[2].passed).toBe(true);
  });

  it('handles ITEM prefixes, dot separators, and em-dashes', () => {
    const r = parseStructuredVerdicts('ITEM 1: FAIL — nope\n2. PASS', 2);
    expect(r[0].passed).toBe(false);
    expect(r[0].reasoning).toBe('nope');
    expect(r[1].passed).toBe(true);
  });

  it('does not confuse item 1 with item 10', () => {
    const r = parseStructuredVerdicts('10: FAIL - x\n1: PASS', 10);
    expect(r[0].passed).toBe(true);   // item 1
    expect(r[9].passed).toBe(false);  // item 10
  });

  it('fails closed when an item has no parseable verdict', () => {
    const r = parseStructuredVerdicts('1: PASS', 2);
    expect(r[1].passed).toBe(false);
    expect(r[1].reasoning).toBeTruthy();
  });

  it('returns empty for zero items', () => {
    expect(parseStructuredVerdicts('whatever', 0)).toEqual([]);
  });
});

describe('extractJudgeUsage', () => {
  it('parses OpenAI-compatible usage', () => {
    const u = extractJudgeUsage('openrouter', 'm', { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    expect(u).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, model: 'm', provider: 'openrouter' });
  });

  it('parses Anthropic usage (input/output tokens)', () => {
    const u = extractJudgeUsage('anthropic', 'claude', { usage: { input_tokens: 80, output_tokens: 15 } });
    expect(u).toMatchObject({ promptTokens: 80, completionTokens: 15, totalTokens: 95, provider: 'anthropic' });
  });

  it('parses Gemini usage (usageMetadata)', () => {
    const u = extractJudgeUsage('gemini', 'g', { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 } });
    expect(u).toMatchObject({ promptTokens: 50, completionTokens: 10, totalTokens: 60, provider: 'gemini' });
  });

  it('returns undefined when no usage is present', () => {
    expect(extractJudgeUsage('openrouter', 'm', {})).toBeUndefined();
    expect(extractJudgeUsage('gemini', 'g', { candidates: [] })).toBeUndefined();
  });
});

/**
 * The interview's completion check judges the artifact itself. It was sent the first 2,000
 * characters of each file and allowed a 512-token reply, so a thorough brief lost the sections after
 * that point and was failed for them, and a model that reasons before answering ran out before its
 * verdicts and failed every item as unverified.
 */
describe('runStructuredJudge', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '1: PASS' } }] }) });
  const judge = async (artifact: string) => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => answer());
    vi.stubGlobal('fetch', fetchMock);
    await runStructuredJudge(['Lists acceptance criteria'], { prompt: 'Plan a feature', files: { '/.interviews/plan.md': artifact }, summary: 'done' }, { provider: 'openrouter', apiKey: 'k', model: 'm' });
    return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { max_tokens: number; messages: Array<{ content: string }> };
  };

  it('reads an artifact whole, past its first 2,000 characters', async () => {
    const body = await judge(`${'Notes on the feature. '.repeat(120)}\n## Acceptance criteria\n1. Loads at /status.html`);
    expect(body.messages[1].content).toContain('## Acceptance criteria');
    expect(body.messages[1].content).not.toContain('[file cut at');
  });

  it('says where it cut a file too long to send whole', async () => {
    const body = await judge('x'.repeat(30_000));
    expect(body.messages[1].content).toContain('[file cut at 24000 characters]');
  });

  it('leaves a model that reasons first room for its verdicts', async () => {
    expect((await judge('short')).max_tokens).toBeGreaterThanOrEqual(4096);
  });
});
