// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { StylesContent, type StylesContentHandle, type StylesContentProps } from '..';
import { ThemeVariables, VARIABLE_COMMIT_MS, pickerHex, stepLength, variableContext } from '../theme-variables';
import { scanVariables, type VariableDefinition } from '@/lib/direct-edit/css-variables';
import { discoverColorTokens } from '../tokens';
import type { VariableWrite } from '@/lib/direct-edit/apply-variable';
import type { FocusContextPayload } from '@/lib/preview/types';
import { logger } from '@/lib/utils';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';

/**
 * The project's variables in the Styles tab: the list shown with nothing selected, and the editor
 * behind a row whose value comes from a variable. Mounted, because what is asserted is wiring: which
 * definition a control writes to, when the pages are shown the value, and what a refused write does.
 */

const CSS = [
  ':root { --accent: #ff0000; --space-4: 1rem; --sans: system-ui, sans-serif; --ease: cubic-bezier(.2,.7,.2,1); }',
  '@media (prefers-color-scheme: dark) { :root { --accent: #00ff00; } }',
  '.card { --pad: 8px; }',
].join('\n');
const variables = scanVariables('/styles.css', CSS);
const uses = { '--accent': 3, '--space-4': 1 };

let container: HTMLDivElement;
let root: Root;
let onApply: ReturnType<typeof vi.fn<(def: VariableDefinition, value: string) => Promise<VariableWrite>>>;
let onPreview: ReturnType<typeof vi.fn<(name: string, value: string | null) => void>>;

const written = (file = '/styles.css'): VariableWrite => ({ ok: true, file, filesWritten: [file] });
const tv = createTranslator({ locale: 'en', messages: en, namespace: 'styles.variables' });

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onApply = vi.fn().mockResolvedValue(written());
  onPreview = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mountList(): void {
  act(() => {
    root.render(withMessages(<ThemeVariables variables={variables} uses={uses} onApply={onApply} onPreview={onPreview} />));
  });
}

/** The row of one definition: by name, and by place where a name is defined twice. */
function row(name: string, index = 0): HTMLElement {
  return container.querySelectorAll<HTMLElement>(`[data-osw-variable="${name}"]`)[index];
}
const valueOf = (el: HTMLElement) => el.querySelector<HTMLInputElement>('[data-osw-variable-value]')!;

/** Put text in a field without leaving it. */
function typeOnly(input: HTMLInputElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Type into a field and leave it, as a person does. */
function type(input: HTMLInputElement, text: string): void {
  typeOnly(input, text);
  act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, VARIABLE_COMMIT_MS + 30)); });

describe('the list of variables', () => {
  it('groups every definition by what its value is, in the file\'s order', () => {
    mountList();
    const groups = [...container.querySelectorAll('[data-osw-variable-group]')].map(group => [
      group.getAttribute('data-osw-variable-group'),
      [...group.querySelectorAll('[data-osw-variable]')].map(el => el.getAttribute('data-osw-variable')),
    ]);
    expect(groups).toEqual([
      ['color', ['--accent', '--accent']],
      ['length', ['--space-4', '--pad']],
      ['font', ['--sans']],
      ['other', ['--ease']],
    ]);
  });

  it('says where a definition stands when that is not a plain :root', () => {
    mountList();
    expect(row('--accent', 0).textContent).not.toContain('@media');
    expect(row('--accent', 1).textContent).toContain('@media (prefers-color-scheme: dark) :root');
    expect(row('--pad').textContent).toContain('.card');
    expect(variableContext(variables[0])).toBeNull();
  });

  it('is nothing at all for a project that defines no variables', () => {
    act(() => { root.render(withMessages(<ThemeVariables variables={[]} uses={{}} onApply={onApply} />)); });
    expect(container.textContent).toBe('');
  });
});

describe('changing a variable', () => {
  it('shows the value on the pages at once and writes it to its own definition after a pause', async () => {
    mountList();
    type(valueOf(row('--space-4')), '1.5rem');
    expect(onPreview).toHaveBeenCalledWith('--space-4', '1.5rem');
    expect(onApply).not.toHaveBeenCalled();
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ name: '--space-4', selector: ':root', context: [], file: '/styles.css' });
    expect(onApply.mock.calls[0][1]).toBe('1.5rem');
  });

  it('writes several quick changes once, with the last value', async () => {
    mountList();
    const plus = row('--space-4').querySelector<HTMLButtonElement>(`button[aria-label="${tv('increase', { name: '--space-4' })}"]`)!;
    act(() => { plus.click(); });
    act(() => { plus.click(); });
    expect(valueOf(row('--space-4')).value).toBe('1.25rem');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toBe('1.25rem');
  });

  it('writes a picked colour, to the definition whose row was used', async () => {
    mountList();
    const picker = row('--accent', 1).querySelector<HTMLInputElement>('[data-osw-variable-colour]')!;
    expect(picker.value).toBe('#00ff00');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(picker, '#123456');
      picker.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(onApply.mock.calls[0][0]).toMatchObject({ name: '--accent', context: ['@media (prefers-color-scheme: dark)'] });
    expect(onApply.mock.calls[0][1]).toBe('#123456');
  });

  it('writes a waiting change to its own definition when another of the same name comes before it', async () => {
    mountList();
    type(valueOf(row('--accent', 0)), '#111111');
    // The file is read again before the pause is over, and now defines the dark scheme's --accent first.
    const reordered = scanVariables('/styles.css', [
      '@media (prefers-color-scheme: dark) { :root { --accent: #00ff00; } }',
      ':root { --accent: #ff0000; --space-4: 1rem; --sans: system-ui, sans-serif; --ease: cubic-bezier(.2,.7,.2,1); }',
      '.card { --pad: 8px; }',
    ].join('\n'));
    act(() => { root.render(withMessages(<ThemeVariables variables={reordered} uses={uses} onApply={onApply} onPreview={onPreview} />)); });
    expect(valueOf(row('--accent', 0)).value).toBe('#00ff00');
    expect(valueOf(row('--accent', 1)).value).toBe('#111111');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ name: '--accent', selector: ':root', context: [] });
    expect(onApply.mock.calls[0][1]).toBe('#111111');
  });

  it('does not show a change early where the definition is conditional or belongs to part of the page', async () => {
    mountList();
    type(valueOf(row('--pad')), '12px');
    type(valueOf(row('--accent', 1)), '#111111');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(2);
    // Set on the root element, either would change pages the definition does not apply to.
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('takes the preview back and says why when the write is refused', async () => {
    onApply.mockResolvedValue({ ok: false, reason: 'generating', file: '/styles.css', filesWritten: [] });
    mountList();
    type(valueOf(row('--space-4')), '2rem');
    await settle();
    expect(onPreview.mock.calls).toEqual([['--space-4', '2rem'], ['--space-4', null]]);
    expect(row('--space-4').querySelector('[data-osw-variable-failed]')!.textContent).toBe(tv('reason.generating'));
    expect(valueOf(row('--space-4')).value).toBe('1rem');
  });

  it('takes the preview back and says the value was not changed when the write throws', async () => {
    const failure = new Error('storage is full');
    onApply.mockRejectedValue(failure);
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      mountList();
      type(valueOf(row('--space-4')), '2rem');
      await settle();
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
      expect(onPreview.mock.calls).toEqual([['--space-4', '2rem'], ['--space-4', null]]);
      // A storage failure, not a stylesheet that dropped the variable.
      const said = row('--space-4').querySelector('[data-osw-variable-failed]')!.textContent;
      expect(said).toBe(tv('reason.failed', { file: '/styles.css' }));
      expect(valueOf(row('--space-4')).value).toBe('1rem');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      logged.mockRestore();
    }
  });

  it('writes a change still waiting when its field goes away, rather than leaving it only on the pages', async () => {
    mountList();
    type(valueOf(row('--space-4')), '1.5rem');
    expect(onPreview).toHaveBeenCalledWith('--space-4', '1.5rem');
    // A selection replaces the list before the pause is over.
    act(() => { root.render(withMessages(<ThemeVariables variables={[]} uses={uses} onApply={onApply} onPreview={onPreview} />)); });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ name: '--space-4', selector: ':root', context: [] });
    expect(onApply.mock.calls[0][1]).toBe('1.5rem');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('takes the preview back when the write made as its field goes away is refused', async () => {
    onApply.mockResolvedValue({ ok: false, reason: 'generating', file: '/styles.css', filesWritten: [] });
    mountList();
    type(valueOf(row('--space-4')), '2rem');
    act(() => { root.render(withMessages(<ThemeVariables variables={[]} uses={uses} onApply={onApply} onPreview={onPreview} />)); });
    await settle();
    expect(onPreview.mock.calls).toEqual([['--space-4', '2rem'], ['--space-4', null]]);
  });

  it('drops what was typed on Escape, without showing it on the pages or writing it', async () => {
    mountList();
    const input = valueOf(row('--space-4'));
    act(() => { input.focus(); });
    typeOnly(input, '3rem');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(valueOf(row('--space-4')).value).toBe('1rem');
    act(() => { input.blur(); });
    await settle();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('writes nothing dropped on Escape when its field then goes away', async () => {
    mountList();
    const input = valueOf(row('--space-4'));
    act(() => { input.focus(); });
    typeOnly(input, '3rem');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    // A selection replaces the list while the field still has focus.
    act(() => { root.render(withMessages(<ThemeVariables variables={[]} uses={uses} onApply={onApply} onPreview={onPreview} />)); });
    await settle();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('writes what was typed when its field goes away before it is left', async () => {
    mountList();
    const input = valueOf(row('--space-4'));
    act(() => { input.focus(); });
    typeOnly(input, '3rem');
    act(() => { root.render(withMessages(<ThemeVariables variables={[]} uses={uses} onApply={onApply} onPreview={onPreview} />)); });
    expect(onPreview).toHaveBeenCalledWith('--space-4', '3rem');
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toBe('3rem');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a field typed in and put back as it was, or emptied', async () => {
    mountList();
    // Changed, then changed back before leaving: the field was touched and says what the file says.
    typeOnly(valueOf(row('--space-4')), '2rem');
    expect(valueOf(row('--space-4')).value).toBe('2rem');
    type(valueOf(row('--space-4')), '1rem');
    type(valueOf(row('--sans')), '   ');
    await settle();
    expect(onApply).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
  });
});

describe('stepLength and pickerHex', () => {
  it('steps in the value\'s own unit', () => {
    expect(stepLength('13px', 1)).toBe('14px');
    expect(stepLength('1rem', -1)).toBe('0.875rem');
    expect(stepLength('200ms', 1)).toBe('210ms');
    expect(stepLength('1.6', 1)).toBe('1.7');
    expect(stepLength('50%', -1)).toBe('49%');
    expect(stepLength('clamp(1rem, 2vw, 2rem)', 1)).toBeNull();
  });

  /**
   * A 2d context that paints as a browser does for the values given here and for `#rrggbb`, and,
   * as a browser does, leaves its fill as it was for a value it cannot parse.
   */
  function paints(known: Record<string, string>) {
    let fill = '#000000';
    let painted = fill;
    const ctx = {
      get fillStyle() { return fill; },
      set fillStyle(value: string) {
        const hex = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : known[value];
        if (hex) fill = hex;
      },
      fillRect() { painted = fill; },
      getImageData() {
        const n = parseInt(painted.slice(1), 16);
        return { data: new Uint8ClampedArray([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]) };
      },
    };
    return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as unknown as HTMLCanvasElement['getContext']);
  }

  it('gives a hex for what it can parse, and none for a colour built from other variables', () => {
    const canvas = paints({ 'hsl(120 100% 25%)': '#008000' });
    try {
      expect(pickerHex('#abc')).toBe('#aabbcc');
      expect(pickerHex('rgb(255, 0, 0)')).toBe('#ff0000');
      // A notation only the browser reads: painted, and read back.
      expect(pickerHex('hsl(120 100% 25%)')).toBe('#008000');
      // One the browser cannot read leaves the canvas painting the fill it had.
      expect(pickerHex('blurple')).toBeNull();
      expect(pickerHex('color-mix(in oklch, var(--accent), black 8%)')).toBeNull();
    } finally {
      canvas.mockRestore();
    }
  });
});

describe('in the Styles tab', () => {
  const ref = createRef<StylesContentHandle>();
  const tokens = discoverColorTokens([{ path: '/styles.css', content: CSS }]);
  const selection: FocusContextPayload = { domPath: 'html > body > p', tagName: 'P', nodeId: 'n1', attributes: { class: 'card' }, outerHTML: '<p></p>' };

  function mountTab(over: Partial<StylesContentProps> = {}): void {
    act(() => {
      root.render(withMessages(
        <StylesContent
          ref={ref}
          selection={null}
          sendToFrame={vi.fn()}
          applyStyle={vi.fn().mockResolvedValue({ ok: true, markerId: 'm1', filesWritten: ['/overrides.css'] })}
          tokens={tokens}
          variables={variables}
          variableUses={uses}
          onApplyVariable={onApply}
          onPreviewVariable={onPreview}
          onOpenFile={vi.fn()}
          onAskAgent={vi.fn()}
          onRefreshPreview={vi.fn()}
          {...over}
        />,
      ));
    });
  }

  it('lists the variables when nothing is selected, under the prompt to select', () => {
    mountTab();
    const list = container.querySelector('[data-osw-variables]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain(tv('title'));
    expect(container.querySelectorAll('[data-osw-variable]')).toHaveLength(variables.length);
    const prompt = [...container.querySelectorAll('p')].find(p => p.textContent === en.styles.noSelection);
    expect(prompt, 'no prompt to select').toBeDefined();
    expect(prompt!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists none where variables cannot be written, as before', () => {
    mountTab({ onApplyVariable: undefined });
    expect(container.querySelector('[data-osw-variables]')).toBeNull();
  });

  it('asks the frame which variable each row comes from, and names it under the row', () => {
    const sendToFrame = vi.fn();
    mountTab({ selection, sendToFrame });
    const query = sendToFrame.mock.calls.map(call => call[0]).find(message => message.type === 'style-query');
    expect(query.variables).toContain('padding-block-start');
    expect(container.querySelector('[data-osw-row-variable]')).toBeNull();

    act(() => {
      ref.current!.handleStyleComputed({
        type: 'style-computed', nodeId: 'n1',
        values: { 'padding-block-start': '16px', 'padding-block-end': '16px', 'padding-inline-start': '16px', 'padding-inline-end': '8px' },
        // Both vertical sides from one variable; only one horizontal side from it.
        variables: { 'padding-block-start': '--space-4', 'padding-block-end': '--space-4', 'padding-inline-start': '--space-4' },
      });
    });
    const named = [...container.querySelectorAll('[data-osw-row-variable]')].map(el => [el.closest('[data-osw-row]')!.getAttribute('data-osw-row'), el.textContent]);
    expect(named).toEqual([['padding-block', '--space-4']]);
  });

  it('opens the variable\'s own editor from the row, which writes to the variable and not the element', async () => {
    const applyStyle = vi.fn();
    mountTab({ selection, applyStyle });
    act(() => {
      ref.current!.handleStyleComputed({
        type: 'style-computed', nodeId: 'n1',
        values: { 'padding-block-start': '16px', 'padding-block-end': '16px' },
        variables: { 'padding-block-start': '--space-4', 'padding-block-end': '--space-4' },
      });
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-osw-row-variable]')!.click(); });
    const popover = document.querySelector<HTMLElement>('[data-osw-variable-popover]')!;
    expect(popover.textContent).toContain(tv('uses', { count: 1 }));
    type(popover.querySelector<HTMLInputElement>('[data-osw-variable-value]')!, '2rem');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ name: '--space-4', selector: ':root', context: [] });
    expect(applyStyle).not.toHaveBeenCalled();
  });

  /** Open the editor behind the padding row, which follows --space-4. */
  async function openPopover(): Promise<HTMLElement> {
    mountTab({ selection });
    act(() => {
      ref.current!.handleStyleComputed({
        type: 'style-computed', nodeId: 'n1',
        values: { 'padding-block-start': '16px', 'padding-block-end': '16px' },
        variables: { 'padding-block-start': '--space-4', 'padding-block-end': '--space-4' },
      });
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-osw-row-variable]')!.click(); });
    return document.querySelector<HTMLElement>('[data-osw-variable-popover]')!;
  }

  it('writes a step made just before the variable\'s editor is closed', async () => {
    const popover = await openPopover();
    act(() => { popover.querySelector<HTMLButtonElement>(`button[aria-label="${tv('increase', { name: '--space-4' })}"]`)!.click(); });
    expect(onPreview).toHaveBeenCalledWith('--space-4', '1.125rem');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-osw-row-variable]')!.click(); });
    expect(document.querySelector('[data-osw-variable-popover]')).toBeNull();
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toBe('1.125rem');
  });

  it('writes a step waiting in the variable\'s editor to that variable when the row comes to follow another', async () => {
    const popover = await openPopover();
    act(() => { popover.querySelector<HTMLButtonElement>(`button[aria-label="${tv('increase', { name: '--space-4' })}"]`)!.click(); });
    // The frame's next answer has the padding from another variable (another rule, at another width).
    act(() => {
      ref.current!.handleStyleComputed({
        type: 'style-computed', nodeId: 'n1',
        values: { 'padding-block-start': '8px', 'padding-block-end': '8px' },
        variables: { 'padding-block-start': '--pad', 'padding-block-end': '--pad' },
      });
    });
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ name: '--space-4' });
    expect(onApply.mock.calls[0][1]).toBe('1.125rem');
  });

  /**
   * A press on the page outside the editor, in the order a browser sends its events. Radix closes
   * the editor on the click after a primary press, so the mousedown before it moves focus out of the
   * field first; a secondary press closes it on the pointerdown, while the field still has focus.
   */
  async function pressOutside(button: 0 | 2): Promise<void> {
    // Radix starts listening for outside presses a tick after the editor opens.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const page = document.body;
    await act(async () => { page.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button, pointerType: 'mouse' })); });
    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button }));
      // The mousedown's default action: focus leaves whatever had it for the page.
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await act(async () => {
      page.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button, pointerType: 'mouse' }));
      page.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button }));
      if (button === 0) page.dispatchEvent(new MouseEvent('click', { bubbles: true, button }));
    });
  }

  it('writes what was typed when the variable\'s editor is closed by a press outside it', async () => {
    const popover = await openPopover();
    const input = popover.querySelector<HTMLInputElement>('[data-osw-variable-value]')!;
    act(() => { input.focus(); });
    typeOnly(input, '2rem');
    await pressOutside(0);
    expect(document.querySelector('[data-osw-variable-popover]')).toBeNull();
    expect(onPreview).toHaveBeenCalledWith('--space-4', '2rem');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toBe('2rem');
  });

  it('writes what was typed when a secondary press outside closes the editor before the field is left', async () => {
    const popover = await openPopover();
    const input = popover.querySelector<HTMLInputElement>('[data-osw-variable-value]')!;
    act(() => { input.focus(); });
    typeOnly(input, '2rem');
    await pressOutside(2);
    expect(document.querySelector('[data-osw-variable-popover]')).toBeNull();
    expect(onPreview).toHaveBeenCalledWith('--space-4', '2rem');
    await settle();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toBe('2rem');
  });

  it('closes the variable\'s editor on Escape without showing or writing what was typed', async () => {
    const popover = await openPopover();
    const input = popover.querySelector<HTMLInputElement>('[data-osw-variable-value]')!;
    act(() => { input.focus(); });
    typeOnly(input, '3rem');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-osw-variable-popover]')).toBeNull();
    await settle();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('writes nothing on an Escape whose close is drawn before the field hears the key', async () => {
    const popover = await openPopover();
    const input = popover.querySelector<HTMLInputElement>('[data-osw-variable-value]')!;
    act(() => { input.focus(); });
    typeOnly(input, '3rem');
    // Radix hears Escape on the document, ahead of the field. In a browser the close it asks for is
    // drawn at the microtask checkpoint after its listener, so the field is gone before React hands
    // it the key: flushed here at the same point.
    const drawNow = () => flushSync(() => {});
    document.addEventListener('keydown', drawNow, { capture: true });
    try {
      await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    } finally {
      document.removeEventListener('keydown', drawNow, { capture: true });
    }
    expect(document.querySelector('[data-osw-variable-popover]')).toBeNull();
    await settle();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('names the variable a colour row follows by its colour', () => {
    mountTab({ selection });
    act(() => {
      // The colour the project's --accent has where it is defined last, which is the one its swatch offers.
      ref.current!.handleStyleComputed({ type: 'style-computed', nodeId: 'n1', values: { 'background-color': 'rgb(0, 255, 0)', color: 'rgb(9, 9, 9)' } });
    });
    const named = [...container.querySelectorAll('[data-osw-row-variable]')].map(el => [el.closest('[data-osw-row]')!.getAttribute('data-osw-row'), el.textContent]);
    expect(named).toEqual([['background-color', '--accent']]);
  });
});
