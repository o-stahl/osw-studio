import { describe, it, expect } from 'vitest';
import {
  choosePort,
  preferredPort,
  movedPortWarning,
  DESKTOP_DEFAULT_PORT,
  DESKTOP_FALLBACK_RANGE,
  serverAddressEnv,
} from '../server-port';

/**
 * The desktop server's port. It has to be the same one every launch, because an MCP connector is
 * registered against the URL, and it has to stay below the ephemeral range the OS allocates
 * outgoing connections from (49152 on macOS, 32768 on Linux).
 */

/** A fake port probe: every port is free except the ones named. */
function probeExcept(...busy: number[]) {
  return async (port: number) => !busy.includes(port);
}

describe('preferredPort', () => {
  it('is 30011 by default', () => {
    expect(preferredPort({})).toBe(DESKTOP_DEFAULT_PORT);
  });

  it('honours OSW_DESKTOP_PORT', () => {
    expect(preferredPort({ OSW_DESKTOP_PORT: '31500' })).toBe(31500);
  });

  it('ignores an override that would not bind or would collide with ephemeral ports', () => {
    for (const value of ['0', '80', '1023', '49152', '60000', '70000', 'abc', '']) {
      expect(preferredPort({ OSW_DESKTOP_PORT: value }), value).toBe(DESKTOP_DEFAULT_PORT);
    }
  });
});

describe('choosePort', () => {
  it('takes the same port every launch when it is free', async () => {
    const first = await choosePort(probeExcept(), {});
    const second = await choosePort(probeExcept(), {});

    expect(first.port).toBe(DESKTOP_DEFAULT_PORT);
    expect(second.port).toBe(first.port);
    expect(first.movedFromPreferred).toBe(false);
  });

  it('falls back when its port is taken, and says it moved', async () => {
    const choice = await choosePort(probeExcept(DESKTOP_DEFAULT_PORT), {});

    expect(choice.port).toBe(DESKTOP_FALLBACK_RANGE[0]);
    expect(choice.movedFromPreferred).toBe(true);
    expect(movedPortWarning(choice)).toContain(String(DESKTOP_DEFAULT_PORT));
    expect(movedPortWarning(choice)).toContain(String(DESKTOP_FALLBACK_RANGE[0]));
  });

  it('never falls back into the ephemeral range', async () => {
    // Everything in the fallback range is busy, so the only options left would be ephemeral.
    const everything: number[] = [DESKTOP_DEFAULT_PORT];
    for (let p = DESKTOP_FALLBACK_RANGE[0]; p <= DESKTOP_FALLBACK_RANGE[1]; p++) everything.push(p);

    await expect(choosePort(probeExcept(...everything), {})).rejects.toThrow(/OSW_DESKTOP_PORT/);
    expect(DESKTOP_FALLBACK_RANGE[1]).toBeLessThan(32768);
  });

  it('keeps an override out of the fallback scan, so it is not handed back as a fallback', async () => {
    const choice = await choosePort(probeExcept(31000), { OSW_DESKTOP_PORT: '31000' });

    expect(choice.preferred).toBe(31000);
    expect(choice.port).not.toBe(31000);
    expect(choice.movedFromPreferred).toBe(true);
  });
});

describe('serverAddressEnv', () => {
  it('names the address under both names, so an APP_URL inherited from the shell is replaced', () => {
    const env: NodeJS.ProcessEnv = { APP_URL: 'https://somewhere.else' };
    Object.assign(env, serverAddressEnv('127.0.0.1', 30011));
    expect(env).toEqual({ PORT: '30011', HOSTNAME: '127.0.0.1', NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:30011', APP_URL: 'http://127.0.0.1:30011' });
  });
});
