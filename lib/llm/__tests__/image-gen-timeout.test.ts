import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageDelegationTimeoutMs, imageGenTimeoutMs } from '../image-gen-timeout';

afterEach(() => vi.unstubAllEnvs());

describe('image generation timeouts', () => {
  it('gives one image call four minutes unless IMAGE_GEN_TIMEOUT_MS says otherwise', () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '');
    expect(imageGenTimeoutMs()).toBe(240_000);
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '90000');
    expect(imageGenTimeoutMs()).toBe(90_000);
  });

  it('has a server-side run wait longer than the call it delegates', () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '90000');
    expect(imageDelegationTimeoutMs()).toBeGreaterThan(90_000);
  });
});
