import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';

const ORIGINAL_SPACE_HOST = process.env.SPACE_HOST;

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_SPACE_HOST === undefined) delete process.env.SPACE_HOST;
  else process.env.SPACE_HOST = ORIGINAL_SPACE_HOST;
});

describe('auth capabilities', () => {
  it('offers Codex login off HF Spaces (local/desktop/self-hosted)', async () => {
    delete process.env.SPACE_HOST;
    const data = await (await GET()).json();
    expect(data.codexAvailable).toBe(true);
  });

  it('hides Codex login on HF Spaces, where the cross-site iframe drops the session cookie', async () => {
    process.env.SPACE_HOST = 'otst-osw-studio.hf.space';
    const data = await (await GET()).json();
    expect(data.codexAvailable).toBe(false);
  });
});

describe('the Space id a provider sign-in returns to', () => {
  it('is the Space\'s owner/name on HF Spaces', async () => {
    process.env.SPACE_HOST = 'otst-osw-studio.hf.space';
    vi.stubEnv('SPACE_ID', 'otst/osw-studio');
    expect((await (await GET()).json()).spaceId).toBe('otst/osw-studio');
  });

  it('is null off HF Spaces, even with SPACE_ID set', async () => {
    delete process.env.SPACE_HOST;
    vi.stubEnv('SPACE_ID', 'otst/osw-studio');
    expect((await (await GET()).json()).spaceId).toBeNull();
  });

  it('is null for a SPACE_ID that is not owner/name', async () => {
    process.env.SPACE_HOST = 'otst-osw-studio.hf.space';
    vi.stubEnv('SPACE_ID', 'evil.example/x?y=1');
    expect((await (await GET()).json()).spaceId).toBeNull();
  });
});
