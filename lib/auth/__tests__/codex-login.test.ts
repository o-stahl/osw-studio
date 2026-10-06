import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

/**
 * The ChatGPT login calls from the settings panel: the server's own error when it gives one,
 * otherwise the app's message in the interface language, and a 202 while the login is pending.
 */

vi.mock('@/lib/config/storage', () => ({ configManager: {} }));

import en from '@/messages/en.json';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';
import { setRuntimeTranslator } from '@/lib/i18n/runtime';
import { completeCodexLogin, pollCodexLogin, startCodexLogin } from '../codex-auth';

const respond = (status: number, body?: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body === undefined ? 'not json' : JSON.stringify(body), { status })));

beforeAll(() => registerEnglishTranslator());
afterAll(() => setRuntimeTranslator(null));
afterEach(() => vi.unstubAllGlobals());

describe('ChatGPT login calls', () => {
  it('reports the server\'s own error when it gives one', async () => {
    respond(400, { error: 'Codex is disabled here' });
    await expect(startCodexLogin()).rejects.toThrow('Codex is disabled here');
  });

  it('falls back to the app\'s message when the server gives none', async () => {
    respond(500);
    await expect(startCodexLogin()).rejects.toThrow(en.settings.codexStartFailed);
    respond(500);
    await expect(completeCodexLogin('http://localhost/cb')).rejects.toThrow(en.settings.codexCompleteFailed);
    respond(500);
    await expect(pollCodexLogin()).rejects.toThrow(en.settings.codexCompleteFailed);
  });

  it('polls as pending on a 202, and returns the tokens once they exist', async () => {
    respond(202, { pending: true });
    await expect(pollCodexLogin()).resolves.toBeNull();
    respond(200, { access_token: 'a', expires_at: 1 });
    await expect(pollCodexLogin()).resolves.toEqual({ access_token: 'a', expires_at: 1 });
  });
});
