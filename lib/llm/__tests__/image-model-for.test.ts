import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Which model generates images. Server-side runs ask the browser this before they start, so it
 * decides whether the agent is offered `generate-image` at all.
 */
let cached: Record<string, { id: string; outputModalities?: string[] }[]> = {};
vi.mock('@/lib/config/storage', () => ({
  configManager: { getCachedModels: (p: string) => (cached[p] ? { models: cached[p] } : null) },
}));

import { imageModelFor } from '../image-gen';
import type { ModelAssignment } from '@/lib/llm/models/assignment';

const agent = { provider: 'openrouter' as const, model: 'deepseek/deepseek-v4-flash' };
const assign = (imageGen: ModelAssignment['imageGen']): ModelAssignment =>
  ({ agent, imageGen, voiceInput: null, autoCompact: true, compactLimit: null });

beforeEach(() => { cached = {}; });

describe('imageModelFor', () => {
  it('is null when image generation is off', () => {
    expect(imageModelFor(assign(null))).toBeNull();
  });

  it('uses a chosen image model, with its declared output modalities', () => {
    cached.pollinations = [{ id: 'black-forest-labs/flux.1-schnell', outputModalities: ['image'] }];
    const ref = { provider: 'pollinations' as const, model: 'black-forest-labs/flux.1-schnell' };
    expect(imageModelFor(assign(ref))).toEqual({ ref, modalities: ['image'] });
  });

  it('reuses the agent model only when it outputs images', () => {
    expect(imageModelFor(assign('agent'))).toBeNull();
    cached.openrouter = [{ id: agent.model, outputModalities: ['text', 'image'] }];
    expect(imageModelFor(assign('agent'))?.ref).toEqual(agent);
  });
});
