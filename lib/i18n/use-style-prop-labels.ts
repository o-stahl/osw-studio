'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { PropertyGroup, StyleProperty } from '@/components/styles-content/properties';

/**
 * Translated copy for the Styles panel's property table.
 *
 * The table itself is a module-level constant, so it cannot call a hook: its English `label` and
 * `group` stay in place as the fallback, and this maps an entry to the translated string instead.
 * Every `t()` call is a literal, because typed messages reject a computed key.
 *
 * Display keywords (`block`, `flex`, `grid`) and units (`rem`, `px`) are left in English: they are
 * the CSS tokens the user writes in a stylesheet, not prose about them.
 */
export function useStylePropLabels() {
  const t = useTranslations('styleProps');

  return useMemo(() => {
    const groups: Record<PropertyGroup, string> = {
      Spacing: t('groups.Spacing'),
      Type: t('groups.Type'),
      Colour: t('groups.Colour'),
      Border: t('groups.Border'),
      Layout: t('groups.Layout'),
    };

    const labels: Record<string, string> = {
      'padding-block': t('labels.padding-block'),
      'padding-inline': t('labels.padding-inline'),
      'margin-block': t('labels.margin-block'),
      'margin-inline': t('labels.margin-inline'),
      'font-size': t('labels.font-size'),
      'line-height': t('labels.line-height'),
      'text-align': t('labels.text-align'),
      color: t('labels.color'),
      'background-color': t('labels.background-color'),
      'border-style': t('labels.border-style'),
      'border-width': t('labels.border-width'),
      'border-radius': t('labels.border-radius'),
      display: t('labels.display'),
    };

    const sides: Record<string, string> = {
      top: t('sides.top'),
      bottom: t('sides.bottom'),
      left: t('sides.left'),
      right: t('sides.right'),
      center: t('sides.center'),
      topLeft: t('sides.topLeft'),
      topRight: t('sides.topRight'),
      bottomRight: t('sides.bottomRight'),
      bottomLeft: t('sides.bottomLeft'),
    };

    /** The longhand a part writes, as one of the nine side names. */
    const sideOf = (property: string): string | undefined => {
      if (/-block-start$|^border-top-width$/.test(property)) return 'top';
      if (/-block-end$|^border-bottom-width$/.test(property)) return 'bottom';
      if (/-inline-start$|^border-left-width$/.test(property)) return 'left';
      if (/-inline-end$|^border-right-width$/.test(property)) return 'right';
      if (property === 'border-top-left-radius') return 'topLeft';
      if (property === 'border-top-right-radius') return 'topRight';
      if (property === 'border-bottom-right-radius') return 'bottomRight';
      if (property === 'border-bottom-left-radius') return 'bottomLeft';
      return undefined;
    };

    const options: Record<string, string> = {
      // text-align
      left: sides.left,
      center: sides.center,
      right: sides.right,
      // border-style
      none: t('borderStyle.none'),
      solid: t('borderStyle.solid'),
      dashed: t('borderStyle.dashed'),
    };

    return {
      group: (group: PropertyGroup) => groups[group] ?? group,
      /** A row's label, for a whole property or for one of its sides. */
      label: (entry: StyleProperty) => {
        const side = sideOf(entry.property);
        if (side && entry.id.includes(':')) return sides[side] ?? entry.label;
        return labels[entry.property] ?? entry.label;
      },
      /**
       * A segmented option's label. `display`'s values are CSS keywords, so they fall through to
       * the English in the table rather than being translated into prose.
       */
      option: (property: string, value: string, fallback: string) =>
        property === 'display' ? fallback : options[value] ?? fallback,
    };
  }, [t]);
}
