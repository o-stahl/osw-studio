// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';

/**
 * In server mode a delete goes to the server first and touches the local copy only once the server
 * has accepted it. An expired session (401) used to remove the local copy anyway, then hide the
 * server's copy until the once-per-tab pull ran again.
 */

const vfsMock = vi.hoisted(() => ({
  init: vi.fn(),
  deleteProject: vi.fn(),
  getStorageAdapter: vi.fn(),
}));
vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import * as autoSync from '@/lib/vfs/auto-sync';
import { ServerDeleteRefused, deleteProjectServerFirst } from '@/lib/vfs/auto-sync';
import { clearAuthExpired, markAuthExpired } from '@/lib/api/backend-status';
import { skillsService } from '@/lib/vfs/skills/service';
import { TemplateService } from '@/lib/vfs/template-service';
import { interviewTemplatesService } from '@/lib/interview/templates-service';
import { configManager } from '@/lib/config/storage';
import { getCustomProviders } from '@/lib/llm/providers/custom-providers';

const fetchMock = vi.fn();

function respond(status: number) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status }));
}

beforeAll(() => {
  registerEnglishTranslator();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubGlobal('fetch', fetchMock);
  autoSync.setAutoSyncWorkspaceId('ws1');
  clearAuthExpired();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  autoSync.setAutoSyncWorkspaceId(undefined);
});

describe('autoDelete* server outcomes', () => {
  const deleters: [string, (id: string) => Promise<void>, string][] = [
    ['autoDeleteProject', autoSync.autoDeleteProject, '/api/w/ws1/sync/projects/x'],
    ['autoDeleteSkill', autoSync.autoDeleteSkill, '/api/w/ws1/sync/skills/x'],
    ['autoDeleteTemplate', autoSync.autoDeleteTemplate, '/api/w/ws1/sync/templates/x'],
    ['autoDeleteModelTemplate', autoSync.autoDeleteModelTemplate, '/api/w/ws1/sync/model-templates/x'],
    ['autoDeleteInterviewTemplate', autoSync.autoDeleteInterviewTemplate, '/api/w/ws1/sync/interview-templates/x'],
    ['autoDeleteConnection', autoSync.autoDeleteConnection, '/api/w/ws1/sync/connections/x'],
  ];

  it.each(deleters)('%s rejects with reason auth on a 401', async (_name, del, url) => {
    respond(401);
    const err = await del('x').catch(e => e);
    expect(err).toBeInstanceOf(ServerDeleteRefused);
    expect(err.reason).toBe('auth');
    expect(err.message).toBe('Your session has expired, so nothing was deleted. Log in and try again.');
    expect(fetchMock).toHaveBeenCalledWith(url, { method: 'DELETE' });
  });

  it.each([[403, 'forbidden'], [500, 'failed'], [409, 'failed']] as const)('maps %i to %s', async (status, reason) => {
    respond(status);
    await expect(autoSync.autoDeleteProject('x')).rejects.toMatchObject({ reason });
  });

  it('maps a network failure to failed', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(autoSync.autoDeleteProject('x')).rejects.toMatchObject({ reason: 'failed' });
  });

  it.each([200, 404])('resolves on %i (404: the item never reached the server)', async (status) => {
    respond(status);
    await expect(autoSync.autoDeleteProject('x')).resolves.toBeUndefined();
  });

  it('does not call the server in browser mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false');
    await expect(autoSync.autoDeleteProject('x')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('callers keep the local copy when the server refuses', () => {
  it('deleteProjectServerFirst', async () => {
    respond(401);
    await expect(deleteProjectServerFirst('p1')).rejects.toBeInstanceOf(ServerDeleteRefused);
    expect(vfsMock.deleteProject).not.toHaveBeenCalled();

    respond(200);
    await deleteProjectServerFirst('p1');
    expect(vfsMock.deleteProject).toHaveBeenCalledWith('p1');
  });

  it('skillsService.deleteSkill', async () => {
    respond(200);
    await skillsService.createSkill('---\nname: kept-skill\ndescription: Does a thing well\n---\n\n# Body\n');
    respond(401);
    await expect(skillsService.deleteSkill('kept-skill')).rejects.toBeInstanceOf(ServerDeleteRefused);
    expect(await skillsService.getSkill('kept-skill')).not.toBeNull();
  });

  it('TemplateService.deleteCustomTemplate passes the refusal through', async () => {
    const deleteCustomTemplate = vi.fn();
    vfsMock.getStorageAdapter.mockReturnValue({ deleteCustomTemplate });
    respond(401);
    await expect(new TemplateService().deleteCustomTemplate('t1')).rejects.toBeInstanceOf(ServerDeleteRefused);
    expect(deleteCustomTemplate).not.toHaveBeenCalled();
  });

  it('interviewTemplatesService.deleteTemplate', async () => {
    respond(200);
    await interviewTemplatesService.clearCustom();
    await interviewTemplatesService.createTemplate({
      id: 'kept-interview', title: 'Kept', description: 'd',
      artifacts: [{ path: '/.interviews/kept-interview.md' }],
      items: [{ id: 'q1', elicit: 'Q?', completion: [{ type: 'judge', criteria: 'C', description: 'c' }] }],
    });
    respond(401);
    await expect(interviewTemplatesService.deleteTemplate('kept-interview')).rejects.toBeInstanceOf(ServerDeleteRefused);
    const all = await interviewTemplatesService.getAllTemplates();
    expect(all.some(t => t.id === 'kept-interview')).toBe(true);
  });

  it('configManager.deleteModelTemplate', async () => {
    configManager.saveModelTemplate({ id: 'mt1', name: 'Mine', builtin: false, assignment: configManager.getModelTemplates()[configManager.getDefaultTemplateId()]?.assignment ?? ({} as never) });
    respond(401);
    await expect(configManager.deleteModelTemplate('mt1')).rejects.toBeInstanceOf(ServerDeleteRefused);
    expect(configManager.getModelTemplates().mt1).toBeDefined();
  });

  it('configManager.removeCustomProvider', async () => {
    configManager.saveCustomProvider('my-custom', {
      id: 'my-custom', name: 'Mine', description: 'x', apiKeyRequired: false, baseUrl: 'https://example.com/v1',
      supportsModelDiscovery: false, supportsFunctions: true, supportsStreaming: true,
    });
    respond(401);
    await expect(configManager.removeCustomProvider('my-custom')).rejects.toBeInstanceOf(ServerDeleteRefused);
    expect(getCustomProviders()['my-custom']).toBeDefined();
  });
});

describe('once-per-tab auto-pull after the session expires', () => {
  it('clears the pull flag so the next load in this tab pulls again', () => {
    sessionStorage.setItem('osw_auto_pull_done', '1');
    markAuthExpired();
    expect(sessionStorage.getItem('osw_auto_pull_done')).toBeNull();
  });
});
