// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * What the frame says and does about custom properties, driven the way the host drives it: which
 * variable a property's winning declaration is (`style-computed`'s `variables`), and showing a
 * variable's value before its stylesheet is written (`variable-preview`).
 *
 * One script instance for the whole file, as in the other wiring specs.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface Posted { type?: string; variables?: Record<string, string>; payload?: FocusContextPayload }
const posted: Posted[] = [];

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function only(type: string): Posted {
  const matches = posted.filter(m => m.type === type);
  expect(matches, `expected exactly one ${type}, got ${posted.map(m => m.type).join(', ') || 'nothing'}`).toHaveLength(1);
  return matches[0];
}

function selectCard(): string {
  posted.length = 0;
  send({ type: 'selector-toggle', active: true });
  document.querySelector('.card')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return (only('selector-selection').payload as FocusContextPayload).nodeId;
}

function variablesOf(nodeId: string, names: string[]): Record<string, string> | undefined {
  posted.length = 0;
  send({ type: 'style-query', nodeId, properties: [], specified: [], variables: names });
  return only('style-computed').variables;
}

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { posted.push(message as Posted); } },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.head.innerHTML = '<style>'
    + ':root { --ink: rgb(10, 10, 10); --space-4: 16px; }'
    + '.card { color: var(--ink); padding-top: var(--space-4); padding-bottom: var( --space-4 , 8px ); '
    + 'font-size: calc(var(--space-4) * 2); letter-spacing: 1px; margin-top: var(--space-4); }'
    + '</style>';
  document.body.innerHTML = '<main><div class="card">c</div></main>';
  posted.length = 0;
});

describe('the variable a property comes from', () => {
  it('is named for a declaration that is one var() and nothing else', () => {
    const nodeId = selectCard();
    expect(variablesOf(nodeId, ['color', 'letter-spacing', 'font-size', 'gap'])).toEqual({ color: '--ink' });
  });

  it('is found for a logical side under the physical name the stylesheet wrote, fallback and all', () => {
    const nodeId = selectCard();
    expect(variablesOf(nodeId, ['padding-block-start', 'padding-block-end', 'padding-inline-start', 'margin-block-start'])).toEqual({
      'padding-block-start': '--space-4',
      'padding-block-end': '--space-4',
      'margin-block-start': '--space-4',
    });
  });

  it('is not named once the element\'s own style attribute sets the property', () => {
    const nodeId = selectCard();
    (document.querySelector('.card') as HTMLElement).style.color = 'red';
    expect(variablesOf(nodeId, ['color'])).toEqual({});
  });

  it('answers an empty list for a dead node or no list at all', () => {
    expect(variablesOf('nope', ['color'])).toEqual({});
    const nodeId = selectCard();
    posted.length = 0;
    send({ type: 'style-query', nodeId, properties: [], specified: [] });
    expect(only('style-computed').variables).toEqual({});
  });
});

describe('variable-preview', () => {
  it('sets the variable on the root element, where it stands in for the stylesheet\'s :root', () => {
    send({ type: 'variable-preview', name: '--ink', value: 'rgb(200, 0, 0)' });
    expect(document.documentElement.style.getPropertyValue('--ink')).toBe('rgb(200, 0, 0)');
  });

  it('takes it off again for null', () => {
    send({ type: 'variable-preview', name: '--ink', value: 'rgb(200, 0, 0)' });
    send({ type: 'variable-preview', name: '--ink', value: null });
    expect(document.documentElement.style.getPropertyValue('--ink')).toBe('');
  });

  it('ignores a name that is not a custom property', () => {
    send({ type: 'variable-preview', name: 'color', value: 'red' });
    send({ type: 'variable-preview', name: '--x; color', value: 'red' });
    expect(document.documentElement.getAttribute('style') ?? '').toBe('');
  });
});
