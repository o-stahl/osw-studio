// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../dropdown-menu';
import { Switch } from '../switch';
import { Tip, TooltipProvider } from '../tooltip';

/**
 * The app's tooltip: 0.7 s of hover opens it, leaving closes it at once, and a press holds it
 * back, which on a drag handle is the whole drag.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // The tooltip places itself with a ResizeObserver, which jsdom does not have.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (node: React.ReactNode) => act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
const tooltip = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
const hover = (el: Element) => act(() => { el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); });
const leave = (el: Element) => act(() => { el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); });
const press = (el: Element) => act(() => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })); });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('Tip', () => {
  it('opens after 0.7 s of hover and closes the moment the pointer leaves', () => {
    render(<Tip label="New file"><button aria-label="New file">+</button></Tip>);
    const button = container.querySelector('button')!;
    hover(button);
    wait(650);
    expect(tooltip()).toBeNull();
    wait(100);
    expect(tooltip()).toBe('New file');
    leave(button);
    expect(tooltip()).toBeNull();
  });

  it('shows nothing while the control is held, as a drag handle is for a whole drag', () => {
    render(<Tip label="Drag to move"><button aria-label="Drag to move">::</button></Tip>);
    const button = container.querySelector('button')!;
    hover(button);
    wait(200);
    press(button);
    wait(1000);
    expect(tooltip()).toBeNull();
    leave(button);
    hover(button);
    wait(800);
    expect(tooltip()).toBe('Drag to move');
  });

  it('wraps a disabled button, which takes no pointer events, so it can still say why it is off', () => {
    render(<Tip label="Choose a file to run"><button disabled>Run</button></Tip>);
    const wrapper = container.querySelector('span')!;
    expect(wrapper.querySelector('button')?.disabled).toBe(true);
    hover(wrapper);
    wait(800);
    expect(tooltip()).toBe('Choose a file to run');
  });

  it('leaves a menu trigger its own state, so the control still shows the menu is open', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <Tip label="More actions"><button aria-label="More actions">…</button></Tip>
        </DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(container.querySelector('button')!.getAttribute('data-state')).toBe('open');
  });

  it('repeats a label only while it is cut off', () => {
    let room = 200;
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => room);
    render(<Tip label="Project opened" truncated><p className="truncate">Project opened</p></Tip>);
    const p = container.querySelector('p')!;
    const enter = () => act(() => { p.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); });
    enter();
    hover(p);
    wait(800);
    expect(tooltip()).toBeNull();
    leave(p);
    room = 80;
    enter();
    hover(p);
    wait(800);
    expect(tooltip()).toBe('Project opened');
    vi.restoreAllMocks();
  });

  it('opens on keyboard focus, not on focus a script moves after a click or a closing menu hands back', () => {
    // jsdom counts every focus as keyboard focus, so whether this one is stands in for the browser.
    let keyboard = false;
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? keyboard : matches.call(this, selector);
    });
    render(<><button aria-label="Before">b</button><Tip label="New file"><button aria-label="New file">+</button></Tip></>);
    const [before, button] = Array.from(container.querySelectorAll('button'));
    act(() => before.focus());
    act(() => button.focus());
    expect(tooltip()).toBeNull();
    act(() => button.blur());
    keyboard = true;
    // From nowhere, as a closing menu returns it: its items are gone by then.
    act(() => button.focus());
    expect(tooltip()).toBeNull();
    act(() => before.focus());
    act(() => button.focus());
    expect(tooltip()).toBe('New file');
    vi.restoreAllMocks();
  });

  it('shows from a span around a switch, which keeps its own state', () => {
    render(<Tip label="Stop the AI using Frontend Design" wrap><Switch checked aria-label="Frontend Design" /></Tip>);
    const sw = container.querySelector('[role="switch"]')!;
    expect(sw.getAttribute('data-state')).toBe('checked');
    hover(sw.parentElement!);
    wait(800);
    expect(tooltip()).toBe('Stop the AI using Frontend Design');
    expect(sw.getAttribute('data-state')).toBe('checked');
  });

  it('counts a line clamp that cuts the text off in height as cut off', () => {
    let lines = 2;
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => lines * 20);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    render(<Tip label="A long description" truncated><p className="line-clamp-2">A long description</p></Tip>);
    const p = container.querySelector('p')!;
    const enter = () => act(() => { p.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); });
    enter();
    hover(p);
    wait(800);
    expect(tooltip()).toBeNull();
    leave(p);
    lines = 3;
    enter();
    hover(p);
    wait(800);
    expect(tooltip()).toBe('A long description');
    vi.restoreAllMocks();
  });

  it('renders the control alone without a label, with none of the tooltip on it', () => {
    render(<Tip label=""><button aria-label="Save">S</button></Tip>);
    const button = container.querySelector('button')!;
    hover(button);
    wait(800);
    expect(tooltip()).toBeNull();
    expect(button.parentElement).toBe(container);
    expect(button.hasAttribute('data-state')).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps the control, and its focus, while the label comes and goes', () => {
    const view = (label?: string) => render(<Tip label={label}><button aria-label="Select all">All</button></Tip>);
    view('Select every item');
    const button = container.querySelector('button')!;
    act(() => button.focus());
    view(undefined);
    expect(container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    view('Select every item');
    expect(container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it('keeps a wrapped control in its span while the label comes and goes', () => {
    const view = (label?: string) => render(
      <Tip label={label} wrap wrapClassName="ml-auto inline-flex"><Switch checked aria-label="Studio view" /></Tip>,
    );
    view(undefined);
    const sw = container.querySelector('[role="switch"]')!;
    expect(sw.parentElement!.className).toBe('ml-auto inline-flex');
    view('Turn the studio view off');
    expect(container.querySelector('[role="switch"]')).toBe(sw);
    expect(sw.getAttribute('data-state')).toBe('checked');
  });
});
