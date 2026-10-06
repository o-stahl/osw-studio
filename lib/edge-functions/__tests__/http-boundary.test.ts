import { describe, it, expect } from 'vitest';
import { functionRequestHeaders, functionResponseHeaders } from '../http-boundary';

/**
 * The edges of the cookie parsing in `http-boundary`; the route-level behaviour (which headers and
 * which cookies cross) is covered through the function route in `headers.test.ts`.
 */
describe('cookies crossing into function code', () => {
  it('drops empty pairs left by stray separators', () => {
    const out = functionRequestHeaders(new Headers({ cookie: 'a=1; ; b=2;' }));
    expect(out.cookie).toBe('a=1; b=2');
  });
});

describe('cookies a function sets', () => {
  it('refuses a value with no name=value pair at all', () => {
    for (const value of ['foo', 'foo; Path=/']) {
      expect(functionResponseHeaders({ 'set-cookie': value }).get('set-cookie'), value).toBeNull();
    }
  });
});
