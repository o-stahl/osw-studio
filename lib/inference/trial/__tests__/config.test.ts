import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** The demo's trial settings: read once, and read again later when the signing key could not be read. */

const ENV = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TRIAL_SIGNING_KID', 'TRIAL_SIGNING_KEY', 'TRIAL_SIGNING_KEY_FILE'];
let dir: string;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'trial-config-'));
  process.env.TURNSTILE_SITE_KEY = 'site-key';
  process.env.TURNSTILE_SECRET_KEY = 'secret-key';
  process.env.TRIAL_SIGNING_KID = 'trial-1';
});
afterEach(() => {
  for (const name of ENV) delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('trialConfig', () => {
  it('reads the signing key from its file', async () => {
    const file = join(dir, 'trial.pem');
    writeFileSync(file, pem());
    process.env.TRIAL_SIGNING_KEY_FILE = file;
    const { trialConfig } = await import('../config');
    const config = await trialConfig();
    expect(config).toMatchObject({ siteKey: 'site-key', secretKey: 'secret-key', kid: 'trial-1' });
    expect(config!.sealKey).not.toEqual(config!.blockKey);
  });

  it('reads an inline signing key written with \\n for its line breaks', async () => {
    process.env.TRIAL_SIGNING_KEY = pem().replace(/\n/g, '\\n');
    const { trialConfig } = await import('../config');
    expect(await trialConfig()).toMatchObject({ kid: 'trial-1' });
  });

  it('derives the seal and block keys from the signing key, so a restart keeps sessions and a new key ends them', async () => {
    const load = async () => {
      vi.resetModules();
      const { trialConfig } = await import('../config');
      return (await trialConfig())!;
    };
    process.env.TRIAL_SIGNING_KEY = pem();
    const first = await load();
    const restarted = await load();
    process.env.TRIAL_SIGNING_KEY = pem();
    const rotated = await load();
    expect(restarted.sealKey).toEqual(first.sealKey);
    expect(restarted.blockKey).toEqual(first.blockKey);
    expect(rotated.sealKey).not.toEqual(first.sealKey);
    expect(rotated.blockKey).not.toEqual(first.blockKey);

    const { newTrialSession, openSession, sealSession } = await import('../session');
    const sealed = sealSession(newTrialSession('203.0.113.7', first.blockKey), first.sealKey);
    expect(openSession(sealed, restarted.sealKey)).not.toBeNull();
    expect(openSession(sealed, rotated.sealKey)).toBeNull();
  });

  it('has no trial without its settings, and keeps that answer', async () => {
    const { trialConfig } = await import('../config');
    expect(await trialConfig()).toBeNull();
    expect(trialConfig()).toBe(trialConfig());
  });

  it('tries a key file it could not read again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-27T12:00:00Z'));
    const file = join(dir, 'trial.pem');
    process.env.TRIAL_SIGNING_KEY_FILE = file;
    const { trialConfig } = await import('../config');
    expect(await trialConfig()).toBeNull();

    writeFileSync(file, pem());
    vi.setSystemTime(Date.parse('2026-10-27T12:00:30Z'));
    expect(await trialConfig()).toBeNull();
    vi.setSystemTime(Date.parse('2026-10-27T12:01:00Z'));
    expect(await trialConfig()).toMatchObject({ kid: 'trial-1' });
  });

  it('tries a key file that held no usable key again too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-27T12:00:00Z'));
    const file = join(dir, 'trial.pem');
    writeFileSync(file, '-----BEGIN PRIVATE KEY-----\n');
    process.env.TRIAL_SIGNING_KEY_FILE = file;
    const { trialConfig } = await import('../config');
    expect(await trialConfig()).toBeNull();
    writeFileSync(file, pem());
    vi.setSystemTime(Date.parse('2026-10-27T12:01:00Z'));
    expect(await trialConfig()).toMatchObject({ kid: 'trial-1' });
  });
});
