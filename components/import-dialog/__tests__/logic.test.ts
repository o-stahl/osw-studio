import { describe, expect, it } from 'vitest';
import { backendResolutionKey } from '@/lib/vfs/archive';
import type {
  FileConflict,
  ImportPlan,
  ImportResolutions,
  ImportTarget,
} from '@/lib/vfs/archive';
import {
  applyToAllBackend,
  applyToAllFiles,
  backendResolutionOf,
  canConfirm,
  confirmAction,
  countReplacements,
  emptyResolutions,
  fileOptionsFor,
  fileResolutionOf,
  formatSettingValue,
  hasAnythingToImport,
  isWrongFormat,
  nothingToDoCounts,
  planTallies,
  selectPhase,
  settingResolutionOf,
  sharedBackendResolution,
  sharedFileResolution,
  splitPath,
} from '../logic';

const EXISTING: ImportTarget = { kind: 'existing-project', projectId: 'p1' };
const NEW: ImportTarget = { kind: 'new-project' };

function conflict(path: string, keepBoth?: string): FileConflict {
  return {
    path,
    currentSize: 10,
    incomingSize: 20,
    currentIsNewer: false,
    keepBothPath: keepBoth,
  };
}

function makePlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    format: 'archive',
    files: { added: [], conflicts: [], unchanged: [] },
    backend: {
      added: [],
      conflicts: [],
      unchanged: [],
      secretsAdded: [],
      secretsMetadataChanged: [],
    },
    settingChanges: [],
    errors: [],
    warnings: [],
    totals: { entries: 0, bytes: 0 },
    ...overrides,
  };
}

describe('resolution defaulting', () => {
  it('reads an absent file resolution as keep-mine', () => {
    expect(fileResolutionOf(emptyResolutions(), '/index.html')).toBe('keep-mine');
  });

  it('reads an absent backend resolution as keep-mine', () => {
    expect(backendResolutionOf(emptyResolutions(), 'edge', 'nightly')).toBe('keep-mine');
  });

  it('reads an absent setting resolution as keep-current', () => {
    expect(settingResolutionOf(emptyResolutions(), 'runtime')).toBe('keep-current');
  });

  it('keeps an edge function and a schedule of the same name apart', () => {
    const resolutions: ImportResolutions = {
      ...emptyResolutions(),
      backend: { [backendResolutionKey('scheduled', 'nightly')]: 'replace' },
    };
    expect(backendResolutionOf(resolutions, 'scheduled', 'nightly')).toBe('replace');
    expect(backendResolutionOf(resolutions, 'edge', 'nightly')).toBe('keep-mine');
  });
});

describe('fileOptionsFor', () => {
  it('offers keep-both only when a renamed path exists', () => {
    expect(fileOptionsFor(conflict('/a.txt', '/a (2).txt'))).toEqual([
      'keep-mine',
      'replace',
      'keep-both',
    ]);
    expect(fileOptionsFor(conflict('/a.txt'))).toEqual(['keep-mine', 'replace']);
  });
});

describe('countReplacements', () => {
  const plan = makePlan({
    files: {
      added: [],
      conflicts: [conflict('/a.txt', '/a (2).txt'), conflict('/b.txt', '/b (2).txt')],
      unchanged: [],
    },
    backend: {
      added: [],
      conflicts: [{ kind: 'edge', name: 'nightly', detail: 'POST', keepBothName: 'nightly-2' }],
      unchanged: [],
      secretsAdded: [],
      secretsMetadataChanged: [],
    },
    settingChanges: [{ key: 'runtime', from: 'handlebars', to: 'static' }],
  });

  it('counts only explicit replaces', () => {
    expect(countReplacements(plan, emptyResolutions(), EXISTING)).toEqual({
      files: 0,
      backend: 0,
      settings: 0,
    });
  });

  it('counts each category separately', () => {
    const resolutions: ImportResolutions = {
      files: { '/a.txt': 'replace', '/b.txt': 'keep-both' },
      backend: { [backendResolutionKey('edge', 'nightly')]: 'replace' },
      settings: { runtime: 'use-archive' },
      skipBlocked: false,
    };
    expect(countReplacements(plan, resolutions, EXISTING)).toEqual({
      files: 1,
      backend: 1,
      settings: 1,
    });
  });

  it('counts nothing for a new project, whatever the map holds', () => {
    const resolutions: ImportResolutions = {
      files: { '/a.txt': 'replace' },
      backend: {},
      settings: {},
      skipBlocked: false,
    };
    expect(countReplacements(plan, resolutions, NEW)).toEqual({
      files: 0,
      backend: 0,
      settings: 0,
    });
  });
});

describe('confirmAction', () => {
  const plan = makePlan({
    files: {
      added: [],
      conflicts: [
        conflict('/a.txt', '/a (2).txt'),
        conflict('/b.txt', '/b (2).txt'),
        conflict('/c.txt'),
      ],
      unchanged: [],
    },
    backend: {
      added: [],
      conflicts: [{ kind: 'edge', name: 'nightly', detail: 'POST', keepBothName: 'nightly-2' }],
      unchanged: [],
      secretsAdded: [],
      secretsMetadataChanged: [],
    },
    settingChanges: [{ key: 'runtime', from: 'handlebars', to: 'static' }],
  });

  it('creates a new project', () => {
    expect(confirmAction(plan, emptyResolutions(), NEW)).toEqual({ kind: 'create' });
  });

  it('replaces nothing when no conflict is set to replace', () => {
    expect(confirmAction(plan, emptyResolutions(), EXISTING)).toEqual({
      kind: 'import', files: 0, backend: 0, settings: 0,
    });
  });

  it('counts the damage', () => {
    const resolutions: ImportResolutions = {
      files: { '/a.txt': 'replace', '/b.txt': 'replace' },
      backend: {},
      settings: {},
      skipBlocked: false,
    };
    expect(confirmAction(plan, resolutions, EXISTING)).toEqual({
      kind: 'import', files: 2, backend: 0, settings: 0,
    });
  });

  it('names every category that loses something', () => {
    const resolutions: ImportResolutions = {
      files: { '/a.txt': 'replace' },
      backend: { [backendResolutionKey('edge', 'nightly')]: 'replace' },
      settings: { runtime: 'use-archive' },
      skipBlocked: false,
    };
    expect(confirmAction(plan, resolutions, EXISTING)).toEqual({
      kind: 'import', files: 1, backend: 1, settings: 1,
    });
  });
});

describe('canConfirm', () => {
  const blocked = makePlan({
    files: { added: ['/a.txt'], conflicts: [], unchanged: [] },
    errors: [{ path: '/x', code: 'too-large', message: 'too big' }],
  });

  it('blocks on errors until the user opts to skip them', () => {
    expect(canConfirm(blocked, emptyResolutions())).toBe(false);
    expect(canConfirm(blocked, { ...emptyResolutions(), skipBlocked: true })).toBe(true);
  });

  it('never blocks on warnings', () => {
    const warned = makePlan({
      files: { added: ['/a.txt'], conflicts: [], unchanged: [] },
      warnings: [{ code: 'server-mode-required', message: 'needs server mode' }],
    });
    expect(canConfirm(warned, emptyResolutions())).toBe(true);
  });
});

describe('apply-to-all', () => {
  const plan = makePlan({
    files: {
      added: [],
      conflicts: [conflict('/a.txt', '/a (2).txt'), conflict('/long.txt')],
      unchanged: [],
    },
    backend: {
      added: [],
      conflicts: [
        { kind: 'edge', name: 'nightly', detail: 'POST', keepBothName: 'nightly-2' },
        { kind: 'scheduled', name: 'nightly', detail: '0 3 * * * · cleanup', keepBothName: 'nightly-2' },
      ],
      unchanged: [],
      secretsAdded: [],
      secretsMetadataChanged: [],
    },
  });

  it('never assigns keep-both to a row that cannot offer it', () => {
    expect(applyToAllFiles(plan, 'keep-both')).toEqual({
      '/a.txt': 'keep-both',
      '/long.txt': 'keep-mine',
    });
  });

  it('keys backend by kind and name', () => {
    expect(applyToAllBackend(plan, 'replace')).toEqual({
      'edge:nightly': 'replace',
      'scheduled:nightly': 'replace',
    });
  });

  it('reports a shared value only when every row agrees', () => {
    const all = { ...emptyResolutions(), files: applyToAllFiles(plan, 'replace') };
    expect(sharedFileResolution(plan, all)).toBe('replace');
    const mixed: ImportResolutions = {
      ...emptyResolutions(),
      files: { '/a.txt': 'replace', '/long.txt': 'keep-mine' },
    };
    expect(sharedFileResolution(plan, mixed)).toBeUndefined();
    expect(sharedBackendResolution(plan, emptyResolutions())).toBe('keep-mine');
  });
});

describe('plan shape helpers', () => {
  it('recognizes a plan with nothing to do', () => {
    expect(hasAnythingToImport(makePlan({ files: { added: [], conflicts: [], unchanged: ['/a'] } })))
      .toBe(false);
    expect(hasAnythingToImport(makePlan({ files: { added: ['/a'], conflicts: [], unchanged: [] } })))
      .toBe(true);
  });

  it('recognizes the two formats that belong to other importers', () => {
    expect(isWrongFormat(makePlan({ format: 'osws-backup' }))).toBe(true);
    expect(isWrongFormat(makePlan({ format: 'oswt-template' }))).toBe(true);
    expect(isWrongFormat(makePlan({ format: 'loose-files' }))).toBe(false);
  });

  it('drops zero tallies', () => {
    const plan = makePlan({
      files: { added: ['/a'], conflicts: [], unchanged: ['/b', '/c'] },
    });
    expect(planTallies(plan, EXISTING)).toEqual([
      { tone: 'added', count: 1, label: 'new' },
      { tone: 'unchanged', count: 2, label: 'identical' },
    ]);
  });

  it('tallies a new project by what it will hold', () => {
    const plan = makePlan({
      files: { added: ['/a', '/b'], conflicts: [], unchanged: [] },
      backend: {
        added: [{ kind: 'edge', name: 'x', detail: 'POST' }],
        conflicts: [],
        unchanged: [],
        secretsAdded: [],
        secretsMetadataChanged: [],
      },
    });
    expect(planTallies(plan, NEW)).toEqual([
      { tone: 'added', count: 2, label: 'files' },
      { tone: 'added', count: 1, label: 'serverFunctions' },
    ]);
  });

  // A backend-only import into an existing project counted nothing at all, so the one screen where
  // a function can actually be replaced was the one that summarized nothing.
  it('counts backend records for an existing project', () => {
    const plan = makePlan({
      backend: {
        added: [{ kind: 'edge', name: 'x', detail: 'POST' }],
        conflicts: [
          { kind: 'server', name: 'send-email', detail: 'POST', keepBothName: 'send-email-2' },
          { kind: 'scheduled', name: 'nightly', detail: '0 3 * * *', keepBothName: 'nightly-2' },
        ],
        unchanged: [],
        secretsAdded: [],
        secretsMetadataChanged: [],
      },
    });
    expect(planTallies(plan, EXISTING)).toEqual([
      { tone: 'added', count: 1, label: 'newServerFunctions' },
      { tone: 'conflicting', count: 2, label: 'serverFunctionsExist' },
    ]);
  });

  // The one tally both target kinds produce, and the one that says a file the user can see listed
  // in the archive is not going to arrive.
  it('tallies refused entries after the ones that will be written', () => {
    const plan = makePlan({
      files: { added: ['/a'], conflicts: [], unchanged: [] },
      errors: [
        { path: '/x', code: 'too-large', message: 'too big' },
        { path: '/y', code: 'path-rejected', message: 'bad path' },
      ],
    });
    expect(planTallies(plan, EXISTING)).toEqual([
      { tone: 'added', count: 1, label: 'new' },
      { tone: 'blocked', count: 2, label: 'blocked' },
    ]);
    expect(planTallies(plan, NEW)).toEqual([
      { tone: 'added', count: 1, label: 'files' },
      { tone: 'blocked', count: 2, label: 'blocked' },
    ]);
  });

  // The tally row is rendered only when this is non-empty — see the dialog. A settings-only import
  // writes no files and no functions, and a row of nothing is not a summary of anything.
  it('counts nothing for a settings-only import', () => {
    const plan = makePlan({
      settingChanges: [{ key: 'runtime', from: 'static', to: 'react' }],
    });
    expect(planTallies(plan, EXISTING)).toEqual([]);
  });
});

describe('selectPhase', () => {
  const error = { path: '/x', code: 'too-large' as const, message: 'too big' };

  it('calls an archive that matches the project nothing-to-do, not blocked', () => {
    // The headline round trip: download a project, import it straight back. Everything matches,
    // nothing was refused. Deciding this on "would it write anything" alone put a success on a red
    // "every entry was refused" screen.
    const plan = makePlan({ files: { added: [], conflicts: [], unchanged: ['/a', '/b'] } });
    expect(selectPhase(plan)).toBe('nothing-to-do');
  });

  it('counts matching backend records as nothing-to-do too', () => {
    const plan = makePlan({
      backend: {
        added: [],
        conflicts: [],
        unchanged: [{ kind: 'edge', name: 'send-email' }],
        secretsAdded: [],
        secretsMetadataChanged: [],
      },
    });
    expect(selectPhase(plan)).toBe('nothing-to-do');
  });

  it('does not offer an import for a secret description alone', () => {
    // Nothing applies a changed secret description — apply reads a `secret:` resolution no
    // component ever writes — so counting it sent the user to a confirm button that then said
    // 'Nothing was written.'
    const plan = makePlan({
      files: { added: [], conflicts: [], unchanged: ['/index.html'] },
      backend: {
        added: [],
        conflicts: [],
        unchanged: [],
        secretsAdded: [],
        secretsMetadataChanged: ['STRIPE_KEY'],
      },
    });
    expect(hasAnythingToImport(plan)).toBe(false);
    expect(selectPhase(plan)).toBe('nothing-to-do');
  });

  it('is blocked only when nothing matched and something was refused', () => {
    expect(selectPhase(makePlan({ errors: [error] }))).toBe('blocked');
  });

  it('stays nothing-to-do when the archive matches but some entries were refused', () => {
    const plan = makePlan({
      files: { added: [], conflicts: [], unchanged: ['/a'] },
      errors: [error],
    });
    // 'it matches, except for these two I could not read' is a real state, and it is not a failure.
    expect(selectPhase(plan)).toBe('nothing-to-do');
  });

  it('does not call an empty archive a refusal', () => {
    expect(selectPhase(makePlan())).toBe('nothing-to-do');
  });

  it('is ready as soon as one thing would be written', () => {
    const plan = makePlan({ files: { added: ['/new.css'], conflicts: [], unchanged: ['/a'] } });
    expect(selectPhase(plan)).toBe('ready');
  });

  it('routes the two other importers formats to their own screen', () => {
    expect(selectPhase(makePlan({ format: 'osws-backup', errors: [error] }))).toBe('wrong-format');
    expect(selectPhase(makePlan({ format: 'oswt-template', errors: [error] }))).toBe(
      'wrong-format'
    );
  });

  it('counts what already matches, which is why there is nothing to do', () => {
    expect(nothingToDoCounts(makePlan({ files: { added: [], conflicts: [], unchanged: ['/a'] } })))
      .toEqual({ files: 1, backend: 0 });
    expect(
      nothingToDoCounts(
        makePlan({
          files: { added: [], conflicts: [], unchanged: ['/a', '/b'] },
          backend: {
            added: [],
            conflicts: [],
            unchanged: [{ kind: 'edge', name: 'x' }],
            secretsAdded: [],
            secretsMetadataChanged: [],
          },
        })
      )
    ).toEqual({ files: 2, backend: 1 });
    expect(nothingToDoCounts(makePlan())).toEqual({ files: 0, backend: 0 });
  });
});

describe('presentation helpers', () => {
  it('splits a path into a dimmable directory and a filename', () => {
    expect(splitPath('/styles/theme.css')).toEqual({ dir: '/styles/', name: 'theme.css' });
    expect(splitPath('/index.html')).toEqual({ dir: '/', name: 'index.html' });
    expect(splitPath('nightly')).toEqual({ dir: '', name: 'nightly' });
  });

  it('shows a runtime by its label, not its id', () => {
    expect(formatSettingValue('runtime', 'handlebars')).toBe('HTML + Handlebars');
    expect(formatSettingValue('runtime', 'static')).toBe('Static');
    expect(formatSettingValue('runtime', 'nonsense')).toBe('nonsense');
    expect(formatSettingValue('entryPoint', '/index.html')).toBe('/index.html');
  });

  it('leaves an unset or empty setting value for the view to word', () => {
    expect(formatSettingValue('description', undefined)).toBeUndefined();
    expect(formatSettingValue('description', '')).toBeUndefined();
  });
});
