/**
 * The Size group's Width and Height modes: what the declarations as written amount to, and what
 * choosing a mode writes.
 *
 * Hug is `width: fit-content`; Fill is `flex: 1 1 0` in a flex row and `width: 100%` elsewhere (and
 * `height: 100%`, or flex in a flex column, for Height); Fixed is a px size; Auto declares nothing
 * of the element's own. A value none of these describe (`60ch`, `calc(…)`) is Custom and is kept.
 */

import type { StyleChange } from '@/lib/direct-edit/types';
import type { SpecifiedValue } from '@/lib/preview/types';

export type WidthMode = 'auto' | 'hug' | 'fill' | 'fixed' | 'custom';
export type HeightMode = 'auto' | 'fill' | 'fixed' | 'custom';

export interface SizeFacts {
  width?: SpecifiedValue | null;
  height?: SpecifiedValue | null;
  flex?: SpecifiedValue | null;
  parent: { display: string; flexDirection: string } | null;
}

const isFlex = (parent: SizeFacts['parent']): parent is NonNullable<SizeFacts['parent']> => !!parent && parent.display.includes('flex');
const inFlexRow = (parent: SizeFacts['parent']) => isFlex(parent) && parent.flexDirection.startsWith('row');
const inFlexColumn = (parent: SizeFacts['parent']) => isFlex(parent) && !parent.flexDirection.startsWith('row');

/** `flex: 1`, `1 1`, `1 1 0`, `1 1 0px`: grows to fill, from nothing. */
const FILLS = /^1(\s+1(\s+0(px|%)?)?)?$/;

export function widthMode(f: SizeFacts): WidthMode {
  const w = f.width?.value.trim() ?? '';
  const flex = f.flex?.value.trim() ?? '';
  if (w === 'fit-content') return 'hug';
  if (w === '100%' || (inFlexRow(f.parent) && FILLS.test(flex))) return 'fill';
  if (/^-?[\d.]+px$/.test(w)) return 'fixed';
  if (w !== '' && w !== 'auto') return 'custom';
  return 'auto';
}

export function heightMode(f: SizeFacts): HeightMode {
  const h = f.height?.value.trim() ?? '';
  const flex = f.flex?.value.trim() ?? '';
  if (h === '100%' || (inFlexColumn(f.parent) && FILLS.test(flex))) return 'fill';
  if (/^-?[\d.]+px$/.test(h)) return 'fixed';
  if (h !== '' && h !== 'auto') return 'custom';
  return 'auto';
}

/**
 * Takes a property back to what it would be without a declaration: removes the element's own, or,
 * where another stylesheet's declaration wins or would win once ours is gone, writes the property's
 * initial value over it.
 */
function release(property: string, value: SpecifiedValue | null | undefined, initial: string): StyleChange {
  return { property, value: value && (!value.ours || value.under) ? initial : null };
}

/**
 * What choosing a width mode writes. `px` is the element's width now, for Fixed; `null` (the frame
 * gave no length in px, as for an inline element's `auto`) writes nothing rather than a width of 0.
 */
export function widthModeChanges(mode: WidthMode, f: SizeFacts, px: number | null): StyleChange[] {
  const flex = release('flex', f.flex, '0 1 auto');
  switch (mode) {
    case 'hug':
      return [{ property: 'width', value: 'fit-content' }, flex];
    case 'fill':
      return inFlexRow(f.parent)
        ? [release('width', f.width, 'auto'), { property: 'flex', value: '1 1 0' }]
        : [{ property: 'width', value: '100%' }, flex];
    case 'fixed':
      return px === null ? [] : [{ property: 'width', value: `${Math.round(px)}px` }, flex];
    case 'auto':
    case 'custom':
      return [release('width', f.width, 'auto'), flex];
  }
}

/** What choosing a height mode writes. `px` is the element's height now, for Fixed, as for the width. */
export function heightModeChanges(mode: HeightMode, f: SizeFacts, px: number | null): StyleChange[] {
  const flexFills = inFlexColumn(f.parent) && FILLS.test(f.flex?.value.trim() ?? '');
  const flex = flexFills ? [release('flex', f.flex, '0 1 auto')] : [];
  switch (mode) {
    case 'fill':
      return inFlexColumn(f.parent)
        ? [release('height', f.height, 'auto'), { property: 'flex', value: '1 1 0' }]
        : [{ property: 'height', value: '100%' }, ...flex];
    case 'fixed':
      return px === null ? [] : [{ property: 'height', value: `${Math.round(px)}px` }, ...flex];
    case 'auto':
    case 'custom':
      return [release('height', f.height, 'auto'), ...flex];
  }
}
