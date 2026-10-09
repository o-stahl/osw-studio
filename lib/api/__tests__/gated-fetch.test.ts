import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Client calls to the auth-gated routes go through `apiFetch`, which raises the session-expired
 * banner on a 401. A plain `fetch` there leaves an expired session showing only "Unauthorized".
 */

const ROOT = path.resolve(__dirname, '../../..');
const PLAIN_GATED_FETCH = /(?<![\w.$])fetch\(\s*[`'"](?:\/api\/(?:w|admin)\/|\$\{apiBase\})/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('auth-gated client calls', () => {
  it('matches a plain fetch to a gated route (positive control)', () => {
    expect(PLAIN_GATED_FETCH.test("await fetch(`/api/w/${id}/sync/status`)")).toBe(true);
    expect(PLAIN_GATED_FETCH.test("await fetch(`${apiBase}/deployments`)")).toBe(true);
    expect(PLAIN_GATED_FETCH.test("await apiFetch(`/api/w/${id}/sync/status`)")).toBe(false);
  });

  it('uses apiFetch in components and client lib code', () => {
    const offenders = [...sources(path.join(ROOT, 'components')), ...sources(path.join(ROOT, 'lib'))]
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => (PLAIN_GATED_FETCH.test(line) ? `${path.relative(ROOT, file)}:${i + 1}` : null))
        .filter((hit): hit is string => hit !== null));
    expect(offenders).toEqual([]);
  });
});
