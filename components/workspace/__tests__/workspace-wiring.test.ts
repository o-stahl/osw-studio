import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Wiring inside `Workspace` that only the file can show.
 *
 * Each is a call site or a prop in a component nothing in this repo renders (it opens a project from
 * the VFS, the store and some ninety modules), and each is the kind of thing a later edit silently
 * undoes. Source assertions, following `components/preview/__tests__/compile-gate-wiring.test.ts`:
 * lifted out of the file, with guards that fail if the anchors stop existing.
 */

const SOURCE = readFileSync(resolve(process.cwd(), 'components/workspace/index.tsx'), 'utf8');

/** The brace-matched block that opens at the first `{` at or after `from`. */
function blockAt(text: string, from: number): string {
  const open = text.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error('unbalanced braces');
}

/** The body of the arrow function a `useCallback` assigns to `name`. */
function callbackBody(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = useCallback(`);
  expect(start, `no ${name} in workspace/index.tsx`).toBeGreaterThan(-1);
  return blockAt(SOURCE, SOURCE.indexOf('=> {', start));
}

describe('a structural edit whose write throws', () => {
  it('is caught in runStructure, logged, and told to the user', () => {
    // Every caller starts it with `void runStructure(...)`, so an uncaught throw from the write is an
    // unhandled rejection the user never hears of.
    const body = callbackBody('runStructure');
    const call = body.indexOf('await applyStructure(');
    expect(call, 'runStructure no longer calls applyStructure').toBeGreaterThan(-1);

    const tryAt = body.lastIndexOf('try {', call);
    expect(tryAt, 'applyStructure is not awaited inside a try').toBeGreaterThan(-1);
    expect(blockAt(body, tryAt), 'the try ends before applyStructure').toContain('await applyStructure(');

    const catchAt = body.indexOf('} catch (', call);
    expect(catchAt, 'no catch after applyStructure').toBeGreaterThan(-1);
    const handler = blockAt(body, catchAt + 1);
    expect(handler).toContain('logger.error(');
    // Says the change could not be saved, with the reason, not that the page went stale.
    expect(handler).toMatch(/toast\.error\(t\('structure\.refused\.writeFailed', \{ message\b/);
    expect(handler).toContain('return;');
  });
});

describe('the desktop Canvas', () => {
  it('is off screen on a phone, where the desktop tree is only hidden', () => {
    // Mounted but invisible, an active Canvas compiles every change a second time.
    const at = SOURCE.search(/<CanvasPanel\s/);
    expect(at, 'no CanvasPanel element in workspace/index.tsx').toBeGreaterThan(-1);
    expect(SOURCE.slice(at + 1).search(/<CanvasPanel\s/), 'a second CanvasPanel element').toBe(-1);
    const element = SOURCE.slice(at, SOURCE.indexOf('/>', at));
    const onScreen = /onScreen=\{([^}]*)\}/.exec(element)?.[1] ?? '';
    expect(onScreen.split(/\s*&&\s*/).sort()).toEqual(['!mobileViewport', 'canvasOnScreen']);
  });
});

describe('the surface a selection is recorded on', () => {
  it('is decided by the mount that made a pick', () => {
    // A phone pick handed `'desktop'` here is recorded on whatever the hidden desktop Inspector reads.
    expect(callbackBody('handleFocusSelection')).toMatch(/surface: pickedOn\(surface, inspectTarget\(\)\)/);
  });

  it('is decided by the viewport for a re-resolve, which goes to the preview that viewport shows', () => {
    expect(callbackBody('handleSelectionResolved')).toMatch(/surface: pickedOn\(inspectorTargets\(\)\.surface, inspectTarget\(\)\)/);
  });

  it('never comes straight from the desktop Inspector', () => {
    expect(SOURCE).not.toMatch(/surface: inspectTarget\(\)/);
  });
});

describe('where the workspace opens', () => {
  it('reads opensIn from the project as just read from the VFS, not the prop', () => {
    // A caller can save opensIn and then open the project object it held from before the save.
    const read = SOURCE.indexOf('const latestProject = await vfs.getProject(project.id);');
    const init = SOURCE.indexOf('useWorkspaceStore.getState().initLayout({');
    expect(read, 'the opening sequence no longer reads latestProject').toBeGreaterThan(-1);
    expect(init, 'the opening sequence no longer calls initLayout').toBeGreaterThan(read);
    const args = blockAt(SOURCE, init);
    expect(args).toMatch(/front: normalizeProjectSettings\(latestProject\.settings\)\.opensIn/);
  });
});

describe('the phone layout, which has no Canvas', () => {
  it('sends the Inspector\'s Select element to Live Preview, whatever the hidden desktop layout shows', () => {
    // The phone Inspector's button calls the desktop handler. Addressed to Canvas, the press puts the
    // hidden desktop Canvas in front and arms nothing the person can see.
    expect(callbackBody('selectElementTarget')).toMatch(/canvas: [^\n]*!mobileViewportRef\.current/);
  });

  it('types a newly inserted Text in the popover, not on the hidden desktop Canvas', () => {
    const at = SOURCE.indexOf('const after = afterInsertRef.current;');
    expect(at, 'the after-insert effect no longer reads afterInsertRef').toBeGreaterThan(-1);
    const effect = blockAt(SOURCE, SOURCE.lastIndexOf('=> {', at));
    const line = effect.split('\n').find(l => l.includes('editTextAt('));
    expect(line, 'the after-insert effect no longer calls editTextAt').toBeDefined();
    expect(line).toMatch(/!mobileViewportRef\.current && inspectTarget\(\) === 'canvas'|inspectTarget\(\) === 'canvas' && !mobileViewportRef\.current/);
  });
});

describe('a confirmation toast\'s Change it', () => {
  /** The toast action's `onClick` in `body`. */
  const retry = (body: string) => {
    const at = body.indexOf('onClick: () =>');
    expect(at, 'no confirmation action').toBeGreaterThan(-1);
    return blockAt(body, at + 'onClick: () =>'.length);
  };

  // The toast stays up while the person goes on selecting, so the element is the one the first call
  // read, carried into the retry; read again at the click, it is whatever is selected then.
  it('repeats a structural edit on the element it asked about', () => {
    expect(retry(callbackBody('runStructure'))).toMatch(/target: selection\b/);
  });

  it('pastes the style onto the element it asked about', () => {
    const body = callbackBody('pasteStyle');
    expect(retry(body)).toMatch(/pasteStyle\(true, focus\)/);
    expect(body).toMatch(/const focus = asked \?\? useWorkspaceStore\.getState\(\)\.focusContext;/);
  });

  it('writes text typed on Canvas into the element it asked about', () => {
    const body = callbackBody('handleCanvasTextEdited');
    expect(retry(body)).toMatch(/handleCanvasTextEdited\(text, true, focus\)/);
    expect(body).toMatch(/handleApplyText\(text, confirmed, focus\)/);
    expect(callbackBody('handleApplyText')).toMatch(/const focus = asked \?\? useWorkspaceStore\.getState\(\)\.focusContext;/);
  });
});

describe('Copy style and Paste style from Canvas', () => {
  // A key pressed in Canvas while the Inspector reads Live Preview: the focus context is the Live
  // Preview element, and Canvas's own is the one the key is for.
  it('copy from and paste onto the element Canvas names, not the Inspector\'s selection', () => {
    const at = SOURCE.indexOf('onStyleClip={');
    expect(at, 'Canvas is given no onStyleClip').toBeGreaterThan(-1);
    const prop = blockAt(SOURCE, at);
    expect(prop).toMatch(/copyStyle\(element\)/);
    expect(prop).toMatch(/pasteStyle\(false, element\)/);
    expect(callbackBody('copyStyle')).toMatch(/\(element \?\? useWorkspaceStore\.getState\(\)\.focusContext\)\?\.attributes/);
  });
});

describe('a structural edit that leaves nothing selected', () => {
  it('ends the selection only when the edit was on the selected element', () => {
    // Removing a placed block's chip deletes its placeholder by target, while the person has
    // something else selected.
    const body = callbackBody('runStructure');
    const at = body.indexOf('result.select === null');
    expect(at, 'runStructure no longer handles an edit that selects nothing').toBeGreaterThan(-1);
    const condition = body.slice(at, body.indexOf(') {', at));
    expect(condition).toMatch(/!opts\.target \|\| opts\.target\.srcAttr === focus\?\.srcAttr/);
  });
});

describe('the element a structural edit leaves selected', () => {
  it('is kept for the recompiled document even when the frames were sent a patch', () => {
    // A frame that could not apply the patch never has the element, and nothing reads its answer.
    const body = callbackBody('runStructure');
    // Set on its own line, under no condition on the patch.
    expect(body).toMatch(/^\s*if \(result\.filesWritten\?\.length\) pendingSelectRef\.current = result\.select\b/m);
    expect(body).not.toMatch(/pendingSelectRef\.current = result\.patch/);
  });

  it('is left as it was by an edit that wrote nothing, which no recompile follows', () => {
    // An edit that changes nothing answers ok with the same element and no files; a pending
    // selection set then would wait for some unrelated later recompile.
    const body = callbackBody('runStructure');
    const set = body.indexOf('pendingSelectRef.current = result.select');
    expect(set, 'runStructure no longer sets the pending selection').toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, set - 120), set)).toMatch(/if \(result\.filesWritten\?\.length\)\s*$/);
  });

  it('is given up when another element is picked or the selection ends before the recompile', () => {
    expect(callbackBody('handleFocusSelection')).toMatch(/if \((selection\?\.srcAttr !== pendingSelectRef\.current|pendingSelectRef\.current !== selection\?\.srcAttr)\) pendingSelectRef\.current = null;/);
  });

  it('is taken in the recompiled document though the patched one already selected it', () => {
    // The same element by path, tag and length within 400 ms reads as a repeated click and is
    // dropped, which would leave the old document's node id in the selection.
    const body = callbackBody('handleFrameReady');
    const at = body.indexOf('if (pending)');
    expect(at, 'handleFrameReady no longer selects a pending element').toBeGreaterThan(-1);
    expect(blockAt(body, at)).toContain('lastFocusSignatureRef.current = null;');
  });
});

describe('quick writes to a variable', () => {
  it('share an undo step only with the same definition, not with every definition of the name', () => {
    // A name defined in :root and again in a dark-scheme rule is two fields in the Styles tab.
    const body = callbackBody('applyVariableEdit');
    expect(body).toMatch(/const key = variableKey\(def\);/);
    expect(body).toMatch(/last\.key === key\b/);
  });
});

describe('a failed redo', () => {
  it('is reported as a redo, not as an undo', () => {
    const line = callbackBody('afterJournal').split('\n').find(l => l.includes("outcome.reason === 'failed'"));
    expect(line, 'afterJournal no longer reports a failed write').toBeDefined();
    expect(line).toMatch(/way === 'undo' \? 'editUndoFailed' : 'editRedoFailed'/);
  });
});
