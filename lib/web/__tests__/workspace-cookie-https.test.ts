// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://studio.example.com/w/ws-1/projects" }
import { describe, it, expect } from 'vitest';
import { readWorkspaceCookie, writeWorkspaceCookie } from '../workspace-cookie';

/** In the browser on HTTPS, a selection is written under the prefixed name and the old one goes. */
describe('writeWorkspaceCookie on HTTPS', () => {
  it('writes __Host-osw_workspace with Secure and Path=/, and clears osw_workspace', () => {
    const writes: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => desc.get!.call(document),
      set: (v: string) => { writes.push(v); desc.set!.call(document, v); },
    });
    writeWorkspaceCookie('ws-2');
    expect(writes[0]).toMatch(/^__Host-osw_workspace=ws-2; Path=\/; Max-Age=\d+; Secure; SameSite=Lax$/);
    expect(writes[1]).toBe('osw_workspace=; Path=/; Max-Age=0');
    expect(readWorkspaceCookie()).toBe('ws-2');
    delete (document as unknown as Record<string, unknown>).cookie;
  });
});
