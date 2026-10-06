import { describe, it, expect } from 'vitest';
import { detectKeyProvider } from '../providers/key-detect';

describe('detectKeyProvider', () => {
  it.each([
    ['sk-or-v1-0123', 'openrouter'],
    ['sk-ant-api03-xyz', 'anthropic'],
    ['sk-proj-abc', 'openai'],
    ['hf_abcdef', 'huggingface'],
    ['gsk_abcdef', 'groq'],
    ['AIzaSyA-123', 'gemini'],
    ['vck_abc', 'vercel'],
    ['sk_abc123', 'pollinations'],
    ['0123456789abcdef0123456789abcdef.AbCdEfGh12345678', 'zhipu'],
  ])('knows %s is %s', (key, provider) => {
    expect(detectKeyProvider(key).candidates).toEqual([provider]);
  });

  it('checks the longer OpenRouter prefix before the shared sk-', () => {
    expect(detectKeyProvider('  sk-or-v1-x  ').candidates).toEqual(['openrouter']);
  });

  it('returns every candidate for a bare sk- key', () => {
    expect(detectKeyProvider('sk-0123456789').candidates).toEqual(['openai', 'deepseek', 'opencode-go', 'minimax']);
  });

  it('offers the shapeless providers for an unrecognised key, and nothing for an empty one', () => {
    expect(detectKeyProvider('3f2c9a4e-1b').candidates).toEqual(['sambanova', 'minimax', 'deepseek', 'zhipu']);
    expect(detectKeyProvider('   ').candidates).toEqual([]);
  });
});
