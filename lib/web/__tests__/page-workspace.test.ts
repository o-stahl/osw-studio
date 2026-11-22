// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { pageWorkspace } from '../workspace-cookie';

/**
 * The cookie is shared by every tab, so a tab opening another workspace changes it under a tab still
 * showing the first one. A request a page makes for its own workspace goes by the page's address.
 */

afterEach(() => {
  document.cookie = 'osw_workspace=; Path=/; Max-Age=0';
  window.history.replaceState(null, '', '/');
});

describe('the workspace a page works in', () => {
  it('is the one in its address, whatever another tab selected since', () => {
    window.history.replaceState(null, '', '/w/ws-a/projects?project=p1');
    document.cookie = 'osw_workspace=ws-b; Path=/';
    expect(pageWorkspace()).toBe('ws-a');
  });

  it('is the selected one on a page outside any workspace', () => {
    window.history.replaceState(null, '', '/admin/login');
    document.cookie = 'osw_workspace=ws-b; Path=/';
    expect(pageWorkspace()).toBe('ws-b');
  });

  it('ignores an address segment not shaped like a workspace id', () => {
    window.history.replaceState(null, '', '/w/a%3Bb/projects');
    document.cookie = 'osw_workspace=ws-b; Path=/';
    expect(pageWorkspace()).toBe('ws-b');
  });
});
