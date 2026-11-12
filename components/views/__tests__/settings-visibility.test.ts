import { describe, it, expect, afterEach, vi } from 'vitest';
import { visiblePanes } from '@/components/unified-settings';
import { STUDIO_ONLY_SETTINGS } from '@/components/sidebar';

/**
 * Which settings the simple view offers.
 *
 * The rule is whether someone can finish their own editing loop without the pane, not whether it
 * looks advanced. Connections and Models stay: a person who cannot choose a provider or a model
 * cannot use the product at all, and switching model is the way out of a provider that has stopped
 * answering. Cost Tracking stays because the keys are the person's own and so is the bill. Mail is
 * instance administration and is not part of anyone's editing.
 *
 * Model templates and Permissions are refinements of a loop that already works with the defaults.
 *
 * The sidebar keeps its own copy of these flags for the menu shortcuts; this is the list the
 * settings view itself renders, which is the one that decides what is reachable. The two have to
 * agree, or the simple view's menu hides a pane its Settings still shows.
 */
const ids = (panes: { id: string }[]) => panes.map((p) => p.id);

afterEach(() => { vi.unstubAllEnvs(); });

describe('the settings panes the simple view shows', () => {
  it('keeps the two a person cannot work without', () => {
    const panes = ids(visiblePanes(undefined, null, false));

    expect(panes).toContain('connections');
    expect(panes).toContain('models');
  });

  it('keeps what the person is spending, since the key is theirs', () => {
    expect(ids(visiblePanes(undefined, null, false))).toContain('costs');
  });

  it('drops model templates and permissions', () => {
    const panes = ids(visiblePanes(undefined, null, false));

    expect(panes).not.toContain('templates');
    expect(panes).not.toContain('permissions');
    expect(ids(visiblePanes(undefined, null, true))).toEqual(expect.arrayContaining(['templates', 'permissions']));
  });

  it('hides the panes the simple view\'s menu leaves out of Settings, and no others', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    const simple = ids(visiblePanes('w1', true, false));
    const hidden = ids(visiblePanes('w1', true, true)).filter((id) => !simple.includes(id));

    expect(hidden.sort()).toEqual([...STUDIO_ONLY_SETTINGS].sort());
  });

  it('drops instance administration', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    const panes = ids(visiblePanes('w1', true, false));

    expect(panes).not.toContain('mail');
  });

  it('offers mail to the studio, where it is server mode and a workspace is in scope', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');

    expect(ids(visiblePanes('w1', true, true))).toContain('mail');
  });

  it('hides mail without a workspace to scope it to, whichever view is on', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');

    expect(ids(visiblePanes(undefined, true, true))).not.toContain('mail');
  });

  it('keeps members for the owner and hides them from everyone else', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');

    expect(ids(visiblePanes('w1', true, true))).toContain('users');
    expect(ids(visiblePanes('w1', false, true))).not.toContain('users');
  });
});
