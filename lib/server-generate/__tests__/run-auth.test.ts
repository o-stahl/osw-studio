import { describe, it, expect, vi } from 'vitest';
import { serverRunHeaders, serverRunUser } from '../run-auth';

/**
 * A server-side run's requests to this server's own `/api/generate` say whom the run is for, and only a
 * request carrying this process's secret is believed.
 */
describe('server run headers', () => {
  it('name the user the run is for', () => {
    expect(serverRunUser(new Headers(serverRunHeaders('osws-user-1')))).toBe('osws-user-1');
  });

  it('name nobody without the secret, with a wrong one, or without a user', () => {
    const headers = serverRunHeaders('osws-user-1');
    const userName = Object.keys(headers).find((name) => headers[name] === 'osws-user-1')!;
    const secretName = Object.keys(headers).find((name) => name !== userName)!;
    expect(serverRunUser(new Headers({ [userName]: 'osws-user-1' }))).toBeNull();
    expect(serverRunUser(new Headers({ ...headers, [secretName]: 'x'.repeat(headers[secretName].length) }))).toBeNull();
    expect(serverRunUser(new Headers({ ...headers, [secretName]: headers[secretName].slice(1) }))).toBeNull();
    expect(serverRunUser(new Headers({ ...headers, [secretName]: headers[secretName].slice(0, -1) }))).toBeNull();
    expect(serverRunUser(new Headers({ ...headers, [secretName]: headers[secretName].slice(0, 1) }))).toBeNull();
    expect(serverRunUser(new Headers({ ...headers, [secretName]: `${headers[secretName]}x` }))).toBeNull();
    expect(serverRunUser(new Headers({ [secretName]: headers[secretName] }))).toBeNull();
    expect(serverRunUser(new Headers())).toBeNull();
  });

  it('agree between copies of the module in one process', async () => {
    const headers = serverRunHeaders('osws-user-1');
    vi.resetModules();
    const fresh = await import('../run-auth');
    expect(fresh.serverRunUser(new Headers(headers))).toBe('osws-user-1');
  });
});
