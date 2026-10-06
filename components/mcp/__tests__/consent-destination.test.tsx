// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConsentForm } from '../consent-form';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { ACTIVE_SCOPES, type McpScope } from '@/lib/mcp/scopes';
import en from '@/messages/en.json';

/**
 * Registration is open by design, so `client_name` is whatever the registrant typed: a client
 * calling itself "Claude Code" and sending the code to its own host looked identical to the real
 * one. The redirect destination is the part that cannot be faked, because it has to match a URI
 * the client registered, so the screen shows it.
 */

let container: HTMLDivElement;
let root: Root;

function mount(redirectUri: string, grantable: McpScope[] = ['projects:read']) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(withMessages(
      <ConsentForm
        clientName="Claude Code"
        clientId="c1"
        redirectUri={redirectUri}
        state=""
        codeChallenge="abc"
        resource=""
        accountEmail="me@example.test"
        workspaces={[{ id: 'w1', name: 'Mine', role: 'owner' }]}
        requestedScopes={[]}
        grantableByRole={{ w1: grantable }}
      />
    ));
  });
}

afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('the consent screen names where approval goes', () => {
  it('shows a remote host and warns about it', () => {
    mount('https://not-really-claude.example/callback');
    expect(container.textContent).toContain('not-really-claude.example');
    expect(container.textContent).toContain('another machine');
  });

  it('marks a loopback client as local', () => {
    mount('http://localhost:47100/callback');
    expect(container.textContent).toContain('localhost:47100');
    expect(container.textContent).toContain('this machine');
  });
});

describe('the consent screen names each capability', () => {
  // Written out rather than derived from the component's own table, so a scope wired to the wrong
  // sentence fails here: a write grant described as read-only is the mistake that matters.
  const EXPECTED: Record<McpScope, string> = {
    'projects:read': en.mcpConsent.scopes.projectsRead,
    'projects:write': en.mcpConsent.scopes.projectsWrite,
    agent: en.mcpConsent.scopes.agent,
    deploy: en.mcpConsent.scopes.deploy,
    analytics: en.mcpConsent.scopes.analytics,
    'workspace:admin': en.mcpConsent.scopes.workspaceAdmin,
  };

  it('labels every grantable scope with its own description', () => {
    mount('http://localhost:47100/callback', [...ACTIVE_SCOPES]);
    expect(ACTIVE_SCOPES.length).toBeGreaterThan(0);
    for (const scope of ACTIVE_SCOPES) {
      const label = container.querySelector(`label[for="scope-${scope}"]`);
      expect(label?.textContent, scope).toBe(EXPECTED[scope]);
    }
  });
});

describe('a connection the server refuses', () => {
  const connect = async () => {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === en.mcpConsent.connect);
    await act(async () => { button!.click(); });
  };

  it('shows the server\'s own reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'invalid_request', error_description: 'redirect_uri is not registered' }) }));
    mount('http://localhost:47100/callback');
    await connect();
    expect(container.textContent).toContain('redirect_uri is not registered');
  });

  it('falls back to its own words when the server gives none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    mount('http://localhost:47100/callback');
    await connect();
    expect(container.textContent).toContain(en.mcpConsent.connectFailed);
  });

  it('says when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    mount('http://localhost:47100/callback');
    await connect();
    expect(container.textContent).toContain(en.mcpConsent.unreachable);
  });
});
