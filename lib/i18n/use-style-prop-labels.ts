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
      Size: t('groups.Size'),
      Position: t('groups.Position'),
      Type: t('groups.Type'),
      Colour: t('groups.Colour'),
      Border: t('groups.Border'),
      Layout: t('groups.Layout'),
      Effects: t('groups.Effects'),
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
      width: t('labels.width'),
      height: t('labels.height'),
      'aspect-ratio': t('labels.aspect-ratio'),
      'object-fit': t('labels.object-fit'),
      'max-width': t('labels.max-width'),
      'min-width': t('labels.min-width'),
      'max-height': t('labels.max-height'),
      'min-height': t('labels.min-height'),
      position: t('labels.position'),
      left: t('sides.left'),
      top: t('sides.top'),
      right: t('sides.right'),
      bottom: t('sides.bottom'),
      rotate: t('labels.rotate'),
      'letter-spacing': t('labels.letter-spacing'),
      'font-weight': t('labels.font-weight'),
      'font-style': t('labels.font-style'),
      'text-decoration-line': t('labels.text-decoration-line'),
      'text-transform': t('labels.text-transform'),
      'text-wrap': t('labels.text-wrap'),
      'border-color': t('labels.border-color'),
      'flex-direction': t('labels.flex-direction'),
      'flex-wrap': t('labels.flex-wrap'),
      gap: t('labels.gap'),
      'grid-template-columns': t('labels.grid-template-columns'),
      'column-gap': t('labels.column-gap'),
      'row-gap': t('labels.row-gap'),
      overflow: t('labels.overflow'),
      opacity: t('labels.opacity'),
      'mix-blend-mode': t('labels.mix-blend-mode'),
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
      justify: t('options.justify'),
      // border-style
      none: t('borderStyle.none'),
      solid: t('borderStyle.solid'),
      dashed: t('borderStyle.dashed'),
      dotted: t('borderStyle.dotted'),
    };

    /** Options whose words depend on the property: `none` is no decoration, or the case as written. */
    const byProperty: Record<string, Record<string, string>> = {
      'font-weight': {
        100: t('options.weight.100'), 200: t('options.weight.200'), 300: t('options.weight.300'),
        400: t('options.weight.400'), 500: t('options.weight.500'), 600: t('options.weight.600'),
        700: t('options.weight.700'), 800: t('options.weight.800'), 900: t('options.weight.900'),
      },
      'text-decoration-line': { none: t('options.decoration.none'), underline: t('options.decoration.underline'), 'line-through': t('options.decoration.line-through') },
      'text-wrap': { wrap: t('options.wrap.wrap'), balance: t('options.wrap.balance'), pretty: t('options.wrap.pretty'), nowrap: t('options.wrap.nowrap') },
      'flex-direction': { row: t('options.direction.row'), column: t('options.direction.column') },
      'flex-wrap': { nowrap: t('options.flexWrap.nowrap'), wrap: t('options.flexWrap.wrap') },
      'aspect-ratio': { auto: t('options.auto') },
      overflow: { visible: t('options.overflow.visible'), hidden: t('options.overflow.hidden'), auto: t('options.overflow.auto') },
      'object-fit': { fill: t('options.fit.fill'), contain: t('options.fit.contain'), cover: t('options.fit.cover'), none: t('options.fit.none') },
    };

    /** The words for options whose label is a symbol (`Aa`), for their tooltips. */
    const tips: Record<string, Record<string, string>> = {
      'text-transform': { none: t('options.case.none'), uppercase: t('options.case.uppercase'), lowercase: t('options.case.lowercase'), capitalize: t('options.case.capitalize') },
    };

    /**
     * Left as the CSS keywords they are, as `display`'s are: a position, a blend mode, a case
     * written as its symbol (`Aa`), and a ratio.
     */
    const keywords = new Set(['display', 'position', 'mix-blend-mode', 'text-transform']);

    return {
      group: (group: PropertyGroup) => groups[group] ?? group,
      /** A row's label, for a whole property or for one of its sides. */
      label: (entry: StyleProperty) => {
        const side = sideOf(entry.property);
        if (side && entry.id.includes(':')) return sides[side] ?? entry.label;
        return labels[entry.property] ?? entry.label;
      },
      /**
       * A segmented or select option's label. Keywords (see above) fall through to the English in
       * the table rather than being translated into prose.
       */
      option: (property: string, value: string, fallback: string) => {
        if (keywords.has(property)) return fallback;
        const own = byProperty[property];
        if (own) return own[value] ?? fallback;
        return options[value] ?? fallback;
      },
      /** Tooltips for a segmented control's options, where their labels are symbols. */
      optionTips: (property: string): Readonly<Record<string, string>> | undefined => tips[property],
    };
  }, [t]);
}
