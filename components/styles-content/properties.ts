/**
 * Property table and stepping ladders for the Styles tab.
 * Entries list longhands (not shorthands) so per-side stepping and loss reporting work on individual values.
 * Ladders are a proposed scale — not derived from project tokens yet.
 */

import { SHORTHAND_LONGHANDS } from '@/lib/preview/style-preview';

/** Where an entry sits in the panel. Presentation only. */
export type PropertyGroup = 'Spacing' | 'Size' | 'Position' | 'Type' | 'Colour' | 'Border' | 'Layout' | 'Effects';

/** The panel's groups, in the order they are shown. */
export const PROPERTY_GROUPS: readonly PropertyGroup[] = ['Spacing', 'Size', 'Position', 'Type', 'Colour', 'Border', 'Layout', 'Effects'];

/**
 * When a row is shown, beyond its group: the offsets and Z only for a positioned element, the flex
 * rows for a flex container, the grid rows for a grid, the border colour once there is a border,
 * the fit for an image or a video.
 */
export type RowCondition = 'positioned' | 'flex' | 'grid' | 'bordered' | 'replaced';

/**
 * The units a stepper can write.
 *
 * `''` is unitless — `line-height: 1.5`, the only property in the table whose value is legal with no
 * unit at all. It is a member of this type rather than a separate case because the control offers it
 * in the same selector as the other two, and CSS accepts all three there.
 */
export type StyleUnit = 'rem' | 'px' | '' | 'em' | '%' | 'deg' | 'vw' | 'vh';

/** What the unit selector prints. `×` for unitless, because `1.5×` is how a ratio reads aloud. */
export const UNIT_LABELS: Readonly<Record<StyleUnit, string>> = {
  rem: 'rem',
  px: 'px',
  '': '×',
  em: 'em',
  '%': '%',
  deg: 'deg',
  vw: 'vw',
  vh: 'vh',
};

/**
 * The keyword values a number row can also take, offered after its units: `auto` for a margin, an
 * offset, a minimum or a stacking order, `none` for a maximum.
 */
export type StyleKeyword = 'auto' | 'none';

/** Units offered for a length. Order is menu order. */
const LENGTH_UNITS: readonly StyleUnit[] = ['rem', 'px'];

/** Unitless first: it inherits as a ratio, the others as fixed lengths. */
const RATIO_UNITS: readonly StyleUnit[] = ['', 'rem', 'px'];

export interface SegmentedOption {
  /** Written verbatim into the declaration. */
  value: string;
  label: string;
  /**
   * Extra computed spellings that count as this option.
   *
   * `text-align` is the reason: an untouched element computes to `start`, not `left`, so without
   * this the commonest case in the project would light up nothing. Deliberately narrow: a spelling
   * counts for one option only, and `justify` is an option of its own.
   */
  matches?: readonly string[];
}

interface BaseEntry {
  /** Stable key for React and for tests. */
  id: string;
  group: PropertyGroup;
  label: string;
  /** The CSS property written into `/overrides.css`. */
  property: string;
  /** The computed property names to ask the frame for, and the keys its replies come back under. */
  read: readonly string[];
  /** Shown only when this holds. Absent: always, within its group. */
  when?: RowCondition;
}

/**
 * One side or corner of a shorthand, as its own writable property.
 *
 * The computed value is already in hand: the parent's {@link BaseEntry.read} names every longhand,
 * so an expanded row costs no extra round trip to the frame. What it adds is the ability to *write*
 * one of them, which the collapsed control cannot — its whole value is a single number.
 */
export interface StepperPart {
  /** The longhand written, and the name its computed value comes back under. */
  property: string;
  label: string;
}

export interface StepperEntry extends BaseEntry {
  control: 'stepper';
  /**
   * The sides or corners this control can be opened up into.
   *
   * Absent for a value that has no parts — `font-size` is one number about the whole element.
   * `Mixed` on a control that has parts is the signal that opening it will say something: the
   * longhands disagree, which is exactly the case the collapsed control cannot express.
   */
  parts?: readonly StepperPart[];
  kind: 'length' | 'ratio';
  /**
   * The unit written **until the user picks another one**, and the unit the ladder is expressed in.
   *
   * Not a fixed property of the declaration any more: the control carries a unit selector, and
   * switching it converts the element's current size into the new unit rather than relabelling the
   * number — see `convertUnit` in `./controls.tsx`. This is the default and the ladder's own unit,
   * which is why {@link ladder} does not move when the display unit does.
   */
  unit: StyleUnit;
  /** Every unit this property may be written in, in menu order. Must contain {@link unit}. */
  units: readonly StyleUnit[];
  /**
   * The rungs `+` and `−` land on, **in {@link unit}** whatever the control is currently displaying.
   *
   * A ladder is a scale — `1.125rem` is a type-scale step and `18px` is the same step; expressing the
   * rungs in the display unit would make `+` in px walk a scale nobody designed. Stepping therefore
   * converts into ladder space, steps, and converts the rung back out.
   */
  ladder: readonly number[];
  /** Keywords the value can be instead of a number, offered after the units. */
  keywords?: readonly StyleKeyword[];
  /**
   * For a ratio: the computed property whose px value one ladder unit is worth.
   *
   * Must also appear in {@link BaseEntry.read} — it is fetched in the same reply — but it is not a
   * *value* of this entry, so it is excluded when the read names are checked for agreement.
   */
  divisor?: string;
}

/** A choice between named keyword values. Numbers use a stepper instead. */
export interface SegmentedEntry extends BaseEntry {
  control: 'segmented';
  kind: 'keyword';
  options: readonly SegmentedOption[];
}

export interface SwatchEntry extends BaseEntry {
  control: 'swatch';
  kind: 'color';
}

/** A choice from a list too long for segments, in the stepper's pill. */
export interface SelectEntry extends BaseEntry {
  control: 'select';
  kind: 'keyword';
  options: readonly SegmentedOption[];
}

/** Two values as a switch: on writes `on`, off writes `off`. */
export interface SwitchEntry extends BaseEntry {
  control: 'switch';
  kind: 'keyword';
  on: string;
  off: string;
  /** Computed values that count as on. */
  onMatches: readonly string[];
}

/**
 * A number with no scale to climb: `+` and `−` move it by {@link step} in the unit on screen. What
 * it shows comes from the declaration as written when that is in one of its units, else from the
 * computed value.
 */
export interface NumberEntry extends BaseEntry {
  control: 'number';
  kind: 'number';
  /** In menu order; the first is written until the user picks another. */
  units: readonly StyleUnit[];
  step: number;
  min?: number;
  max?: number;
  /**
   * A value the control shows in other terms than CSS writes it: `percent` shows `opacity: 0.5` as
   * 50, `columns` shows `grid-template-columns` as its number of tracks and writes `repeat(n, …)`.
   */
  shape?: 'percent' | 'columns';
  /** Keywords the value can be instead of a number, offered after the units. */
  keywords?: readonly StyleKeyword[];
  /**
   * The computed value `+`, `−`, a drag and a unit change start from when there is no number to
   * show (`max-width: none`): the element's own width or height.
   */
  startFrom?: 'width' | 'height';
}

export type StyleProperty = StepperEntry | SegmentedEntry | SwatchEntry | SelectEntry | SwitchEntry | NumberEntry;

/** The spacing scale. See the module note — this is a proposal, not a reading of the templates. */
const SPACING_LADDER = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6] as const;

/** The type scale, in rem. */
const TYPE_LADDER = [0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.875, 2.25, 3] as const;

/** Every property the tab edits. */
export const STYLE_PROPERTIES: readonly StyleProperty[] = [
  {
    id: 'padding-block',
    group: 'Spacing',
    label: 'Padding, vertical',
    property: 'padding-block',
    read: ['padding-block-start', 'padding-block-end'],
    control: 'stepper',
    kind: 'length',
    unit: 'rem',
    units: LENGTH_UNITS,
    ladder: SPACING_LADDER,
    parts: [
      { property: 'padding-block-start', label: 'Top' },
      { property: 'padding-block-end', label: 'Bottom' },
    ],
  },
  {
    id: 'padding-inline',
    group: 'Spacing',
    label: 'Padding, horizontal',
    property: 'padding-inline',
    read: ['padding-inline-start', 'padding-inline-end'],
    control: 'stepper',
    kind: 'length',
    unit: 'rem',
    units: LENGTH_UNITS,
    ladder: SPACING_LADDER,
    parts: [
      { property: 'padding-inline-start', label: 'Left' },
      { property: 'padding-inline-end', label: 'Right' },
    ],
  },
  {
    id: 'margin-block',
    group: 'Spacing',
    label: 'Margin, vertical',
    property: 'margin-block',
    read: ['margin-block-start', 'margin-block-end'],
    control: 'stepper',
    kind: 'length',
    unit: 'rem',
    units: LENGTH_UNITS,
    keywords: ['auto'],
    ladder: SPACING_LADDER,
    parts: [
      { property: 'margin-block-start', label: 'Top' },
      { property: 'margin-block-end', label: 'Bottom' },
    ],
  },
  {
    id: 'margin-inline',
    group: 'Spacing',
    label: 'Margin, horizontal',
    property: 'margin-inline',
    read: ['margin-inline-start', 'margin-inline-end'],
    control: 'stepper',
    kind: 'length',
    unit: 'rem',
    units: LENGTH_UNITS,
    keywords: ['auto'],
    ladder: SPACING_LADDER,
    parts: [
      { property: 'margin-inline-start', label: 'Left' },
      { property: 'margin-inline-end', label: 'Right' },
    ],
  },
  {
    id: 'font-size',
    group: 'Type',
    label: 'Size',
    property: 'font-size',
    read: ['font-size'],
    control: 'stepper',
    kind: 'length',
    unit: 'rem',
    units: LENGTH_UNITS,
    ladder: TYPE_LADDER,
  },
  {
    id: 'line-height',
    group: 'Type',
    label: 'Line height',
    // `font-size` is not a longhand of `line-height`; it is the divisor. Chrome computes
    // `line-height` to px, so a unitless ladder cannot be read back without it.
    read: ['line-height', 'font-size'],
    property: 'line-height',
    control: 'stepper',
    kind: 'ratio',
    unit: '',
    units: RATIO_UNITS,
    ladder: [1, 1.25, 1.5, 1.75, 2],
    divisor: 'font-size',
  },
  {
    id: 'text-align',
    group: 'Type',
    label: 'Align',
    property: 'text-align',
    read: ['text-align'],
    control: 'segmented',
    kind: 'keyword',
    options: [
      { value: 'left', label: 'Left', matches: ['start'] },
      { value: 'center', label: 'Centre' },
      { value: 'right', label: 'Right', matches: ['end'] },
      { value: 'justify', label: 'Justify' },
    ],
  },
  {
    id: 'color',
    group: 'Colour',
    label: 'Text',
    property: 'color',
    read: ['color'],
    control: 'swatch',
    kind: 'color',
  },
  {
    id: 'background-color',
    group: 'Colour',
    label: 'Background',
    property: 'background-color',
    read: ['background-color'],
    control: 'swatch',
    kind: 'color',
  },
  {
    id: 'border-style',
    group: 'Border',
    label: 'Style',
    property: 'border-style',
    read: SHORTHAND_LONGHANDS['border-style'],
    control: 'segmented',
    kind: 'keyword',
    options: [
      { value: 'none', label: 'None' },
      { value: 'solid', label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
    ],
  },
  {
    id: 'border-width',
    group: 'Border',
    label: 'Width',
    property: 'border-width',
    read: SHORTHAND_LONGHANDS['border-width'],
    control: 'stepper',
    kind: 'length',
    unit: 'px',
    units: LENGTH_UNITS,
    ladder: [0, 1, 2, 4],
    parts: [
      { property: 'border-top-width', label: 'Top' },
      { property: 'border-right-width', label: 'Right' },
      { property: 'border-bottom-width', label: 'Bottom' },
      { property: 'border-left-width', label: 'Left' },
    ],
  },
  {
    id: 'border-radius',
    group: 'Border',
    label: 'Corner radius',
    property: 'border-radius',
    read: SHORTHAND_LONGHANDS['border-radius'],
    control: 'stepper',
    kind: 'length',
    unit: 'px',
    units: LENGTH_UNITS,
    ladder: [0, 4, 8, 16, 999],
    parts: [
      { property: 'border-top-left-radius', label: 'Top left' },
      { property: 'border-top-right-radius', label: 'Top right' },
      { property: 'border-bottom-right-radius', label: 'Bottom right' },
      { property: 'border-bottom-left-radius', label: 'Bottom left' },
    ],
  },
  {
    id: 'display',
    group: 'Layout',
    label: 'Display',
    property: 'display',
    read: ['display'],
    control: 'segmented',
    kind: 'keyword',
    options: [
      // The inline forms light their block form; the Inline switch beside them says which it is.
      { value: 'block', label: 'Block', matches: ['inline-block'] },
      { value: 'flex', label: 'Flex', matches: ['inline-flex'] },
      { value: 'grid', label: 'Grid', matches: ['inline-grid'] },
      { value: 'none', label: 'Hidden' },
    ],
  },
  // ---- Size: the modes and the max/min sizes are drawn by the Size group itself; these are its
  // fields, written as they are.
  { id: 'width', group: 'Size', label: 'W', property: 'width', read: ['width'], control: 'number', kind: 'number', units: ['px', '%', 'rem', 'vw'], step: 1, min: 0 },
  { id: 'height', group: 'Size', label: 'H', property: 'height', read: ['height'], control: 'number', kind: 'number', units: ['px', '%', 'rem', 'vh'], step: 1, min: 0 },
  {
    id: 'aspect-ratio', group: 'Size', label: 'Aspect ratio', property: 'aspect-ratio', read: ['aspect-ratio'],
    control: 'select', kind: 'keyword',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: '1 / 1', label: '1 : 1' },
      { value: '4 / 3', label: '4 : 3' },
      { value: '3 / 2', label: '3 : 2' },
      { value: '16 / 9', label: '16 : 9' },
      { value: '21 / 9', label: '21 : 9' },
    ],
  },
  { id: 'max-width', group: 'Size', label: 'Max width', property: 'max-width', read: ['max-width'], control: 'number', kind: 'number', units: ['px', '%', 'rem', 'vw'], keywords: ['none'], startFrom: 'width', step: 1, min: 0 },
  { id: 'min-width', group: 'Size', label: 'Min width', property: 'min-width', read: ['min-width'], control: 'number', kind: 'number', units: ['px', '%', 'rem', 'vw'], keywords: ['auto'], startFrom: 'width', step: 1, min: 0 },
  { id: 'max-height', group: 'Size', label: 'Max height', property: 'max-height', read: ['max-height'], control: 'number', kind: 'number', units: ['px', '%', 'rem', 'vh'], keywords: ['none'], startFrom: 'height', step: 1, min: 0 },
  { id: 'min-height', group: 'Size', label: 'Min height', property: 'min-height', read: ['min-height'], control: 'number', kind: 'number', units: ['px', '%', 'rem', 'vh'], keywords: ['auto'], startFrom: 'height', step: 1, min: 0 },
  {
    id: 'object-fit', group: 'Size', label: 'Fit', property: 'object-fit', read: ['object-fit'],
    control: 'select', kind: 'keyword', when: 'replaced',
    options: [
      { value: 'fill', label: 'Fill' },
      { value: 'contain', label: 'Contain' },
      { value: 'cover', label: 'Cover' },
      { value: 'none', label: 'None' },
    ],
  },
  // ---- Position
  {
    id: 'position', group: 'Position', label: 'Position', property: 'position', read: ['position'],
    control: 'select', kind: 'keyword',
    options: [
      { value: 'static', label: 'Static' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'relative', label: 'Relative' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'absolute', label: 'Absolute' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'fixed', label: 'Fixed' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'sticky', label: 'Sticky' }, // i18n-ignore: a CSS keyword, kept in English as display's are
    ],
  },
  { id: 'left', group: 'Position', label: 'Left', property: 'left', read: ['left'], control: 'number', kind: 'number', units: ['px', '%'], keywords: ['auto'], step: 1, when: 'positioned' },
  { id: 'top', group: 'Position', label: 'Top', property: 'top', read: ['top'], control: 'number', kind: 'number', units: ['px', '%'], keywords: ['auto'], step: 1, when: 'positioned' },
  { id: 'right', group: 'Position', label: 'Right', property: 'right', read: ['right'], control: 'number', kind: 'number', units: ['px', '%'], keywords: ['auto'], step: 1, when: 'positioned' },
  { id: 'bottom', group: 'Position', label: 'Bottom', property: 'bottom', read: ['bottom'], control: 'number', kind: 'number', units: ['px', '%'], keywords: ['auto'], step: 1, when: 'positioned' },
  { id: 'z-index', group: 'Position', label: 'Z', property: 'z-index', read: ['z-index'], control: 'number', kind: 'number', units: [''], keywords: ['auto'], step: 1, when: 'positioned' },
  { id: 'rotate', group: 'Position', label: 'Rotation', property: 'rotate', read: ['rotate'], control: 'number', kind: 'number', units: ['deg'], step: 1 },
  // ---- Type: the rest of the group, whose first rows are higher up
  { id: 'letter-spacing', group: 'Type', label: 'Letter spacing', property: 'letter-spacing', read: ['letter-spacing'], control: 'number', kind: 'number', units: ['px', 'em'], step: 0.5 },
  {
    id: 'font-weight', group: 'Type', label: 'Weight', property: 'font-weight', read: ['font-weight'],
    control: 'select', kind: 'keyword',
    options: [
      { value: '100', label: 'Thin' },
      { value: '200', label: 'Extra light' },
      { value: '300', label: 'Light' },
      { value: '400', label: 'Regular', matches: ['normal'] },
      { value: '500', label: 'Medium' },
      { value: '600', label: 'Semibold' },
      { value: '700', label: 'Bold', matches: ['bold'] },
      { value: '800', label: 'Extra bold' },
      { value: '900', label: 'Black' },
    ],
  },
  { id: 'font-style', group: 'Type', label: 'Italic', property: 'font-style', read: ['font-style'], control: 'switch', kind: 'keyword', on: 'italic', off: 'normal', onMatches: ['italic', 'oblique'] },
  {
    id: 'text-decoration-line', group: 'Type', label: 'Decoration', property: 'text-decoration-line', read: ['text-decoration-line'],
    control: 'segmented', kind: 'keyword',
    options: [
      { value: 'none', label: 'None' },
      { value: 'underline', label: 'Underline' },
      { value: 'line-through', label: 'Strike' },
    ],
  },
  {
    id: 'text-transform', group: 'Type', label: 'Case', property: 'text-transform', read: ['text-transform'],
    control: 'segmented', kind: 'keyword',
    options: [
      { value: 'none', label: 'Aa' },
      { value: 'uppercase', label: 'AA' },
      { value: 'lowercase', label: 'aa' },
      { value: 'capitalize', label: 'Ab' },
    ],
  },
  {
    id: 'text-wrap', group: 'Type', label: 'Wrap', property: 'text-wrap', read: ['text-wrap-mode', 'text-wrap-style'],
    control: 'select', kind: 'keyword',
    options: [
      { value: 'wrap', label: 'Normal' },
      { value: 'balance', label: 'Balance' },
      { value: 'pretty', label: 'Pretty' },
      { value: 'nowrap', label: 'No wrap' },
    ],
  },
  // ---- Border: the rest of the group, whose first rows are higher up
  { id: 'border-color', group: 'Border', label: 'Colour', property: 'border-color', read: SHORTHAND_LONGHANDS['border-color'], control: 'swatch', kind: 'color', when: 'bordered' },
  // ---- Layout: the alignment pad and its switches are drawn by the Layout group itself
  {
    id: 'flex-direction', group: 'Layout', label: 'Direction', property: 'flex-direction', read: ['flex-direction'],
    control: 'segmented', kind: 'keyword', when: 'flex',
    options: [
      { value: 'row', label: 'Row', matches: ['row-reverse'] },
      { value: 'column', label: 'Column', matches: ['column-reverse'] },
    ],
  },
  {
    id: 'flex-wrap', group: 'Layout', label: 'Wrap', property: 'flex-wrap', read: ['flex-wrap'],
    control: 'segmented', kind: 'keyword', when: 'flex',
    options: [
      { value: 'nowrap', label: 'No wrap' },
      { value: 'wrap', label: 'Wrap', matches: ['wrap-reverse'] },
    ],
  },
  { id: 'gap', group: 'Layout', label: 'Gap', property: 'gap', read: ['row-gap', 'column-gap'], control: 'stepper', kind: 'length', unit: 'px', units: ['px', 'rem'], ladder: [0, 4, 8, 12, 16, 24, 32, 48, 64], when: 'flex' },
  { id: 'grid-columns', group: 'Layout', label: 'Columns', property: 'grid-template-columns', read: ['grid-template-columns'], control: 'number', kind: 'number', units: [''], step: 1, min: 1, max: 12, shape: 'columns', when: 'grid' },
  { id: 'column-gap', group: 'Layout', label: 'Column gap', property: 'column-gap', read: ['column-gap'], control: 'stepper', kind: 'length', unit: 'px', units: ['px', 'rem'], ladder: [0, 4, 8, 12, 16, 24, 32, 48, 64], when: 'grid' },
  { id: 'row-gap', group: 'Layout', label: 'Row gap', property: 'row-gap', read: ['row-gap'], control: 'stepper', kind: 'length', unit: 'px', units: ['px', 'rem'], ladder: [0, 4, 8, 12, 16, 24, 32, 48, 64], when: 'grid' },
  {
    id: 'overflow', group: 'Layout', label: 'Overflow', property: 'overflow', read: ['overflow-x', 'overflow-y'],
    control: 'select', kind: 'keyword',
    options: [
      { value: 'visible', label: 'Visible' },
      { value: 'hidden', label: 'Clip', matches: ['clip'] },
      { value: 'auto', label: 'Scroll', matches: ['scroll'] },
    ],
  },
  // ---- Effects: shadow, blur and backdrop blur are drawn by the Effects group itself
  { id: 'opacity', group: 'Effects', label: 'Opacity', property: 'opacity', read: ['opacity'], control: 'number', kind: 'number', units: ['%'], step: 5, min: 0, max: 100, shape: 'percent' },
  {
    id: 'mix-blend-mode', group: 'Effects', label: 'Blend', property: 'mix-blend-mode', read: ['mix-blend-mode'],
    control: 'select', kind: 'keyword',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'multiply', label: 'Multiply' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'screen', label: 'Screen' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'overlay', label: 'Overlay' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'darken', label: 'Darken' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'lighten', label: 'Lighten' }, // i18n-ignore: a CSS keyword, kept in English as display's are
      { value: 'luminosity', label: 'Luminosity' }, // i18n-ignore: a CSS keyword, kept in English as display's are
    ],
  },
];

/**
 * What the compound rows read besides the table's own: the Size modes' flex, the effects and the
 * gradient, the font, the alignment pad. Computed values.
 */
const COMPOUND_READS: readonly string[] = [
  'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items',
  'box-shadow', 'filter', 'backdrop-filter', 'background-image', 'font-family',
];

/**
 * The properties whose declaration as written the frame reports (`style-query`'s `specified`):
 * where a computed value cannot say what was written (`100%` and `fit-content` both compute to
 * pixels, `var(--font-body)` to a font list) or a number field shows the unit it was written in.
 */
export const SPECIFIED_PROPERTIES: readonly string[] = [
  'width', 'height', 'flex', 'max-width', 'min-width', 'max-height', 'min-height',
  'left', 'top', 'right', 'bottom', 'letter-spacing', 'font-family', 'background-image', 'box-shadow',
  'filter', 'backdrop-filter', 'display',
  // A margin of `auto` computes to the pixels it comes to: only the declaration says it is `auto`.
  'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end',
];

/**
 * The properties the frame is asked to name the variable of (`style-computed`'s `variables`): the
 * read names of the rows whose value a project commonly keeps in a custom property.
 */
export const VARIABLE_PROPERTIES: readonly string[] = [
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end',
  'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end',
  'font-size', 'line-height', 'letter-spacing', 'font-family', 'font-weight',
  'row-gap', 'column-gap', 'width', 'max-width', 'min-height',
  'color', 'background-color', 'border-top-color', 'box-shadow',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
];

/**
 * Shorthand → its longhands, for the invariant the table is checked against.
 *
 * Extends the frame's table rather than restating it, so the physical box shorthands have one
 * definition. The logical ones are added here because the frame has no need of them — it expands
 * what it is *asked* for, and it is asked for the `read` lists below, which are already longhands.
 */
export const CSS_SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  ...SHORTHAND_LONGHANDS,
  'padding-block': ['padding-block-start', 'padding-block-end'],
  'padding-inline': ['padding-inline-start', 'padding-inline-end'],
  'margin-block': ['margin-block-start', 'margin-block-end'],
  'margin-inline': ['margin-inline-start', 'margin-inline-end'],
};

/** Every computed property name the tab needs, deduplicated, in table order. */
export const QUERY_PROPERTIES: readonly string[] = Array.from(
  new Set([...STYLE_PROPERTIES.flatMap(entry => entry.read), ...COMPOUND_READS]),
);

/**
 * The read names that carry this entry's *value*, as opposed to the divisor it also fetches.
 *
 * A stepper over several sides is only showing a number when the sides agree; this is the set that
 * has to agree. `line-height` reads `font-size` too and would never agree with it.
 */
export function valueNames(entry: StyleProperty): readonly string[] {
  const divisor = entry.control === 'stepper' ? entry.divisor : undefined;
  return divisor ? entry.read.filter(name => name !== divisor) : entry.read;
}

/** The physical longhands a logical shorthand's sides are also written as, by hand or by the agent. */
const PHYSICAL: Readonly<Record<string, readonly string[]>> = {
  'padding-block': ['padding-top', 'padding-bottom'],
  'padding-inline': ['padding-left', 'padding-right'],
  'margin-block': ['margin-top', 'margin-bottom'],
  'margin-inline': ['margin-left', 'margin-right'],
};

/**
 * The properties a row stands for: its own, its sides, and the other spellings of the same thing.
 * Its dot shows when this width's block sets any of them, and pressing the dot removes all of them.
 */
export function rowProperties(entry: StyleProperty): string[] {
  const own = [entry.property];
  if (entry.control === 'stepper' && entry.parts) own.push(...entry.parts.map(part => part.property));
  own.push(...(PHYSICAL[entry.property] ?? []));
  own.push(...(CSS_SHORTHANDS[entry.property] ?? []));
  if (entry.property === 'text-wrap') own.push('text-wrap-mode', 'text-wrap-style');
  if (entry.property === 'overflow') own.push('overflow-x', 'overflow-y');
  return Array.from(new Set(own));
}

/** Entry lookup by the property actually written. */
export function propertyEntry(property: string): StyleProperty | undefined {
  return STYLE_PROPERTIES.find(entry => entry.property === property);
}

/**
 * The computed names a written property comes back under.
 *
 * Falls back to the property itself so a declaration the table does not own — there are none today,
 * but the reducer takes declarations, not entries — still names something the frame can answer.
 */
export function readNamesFor(property: string): readonly string[] {
  return propertyEntry(property)?.read ?? [property];
}

/** Ladder numbers are exact halves and quarters, so this only absorbs float division noise. */
const EPSILON = 1e-6;

/**
 * Move one step along a ladder.
 *
 * Both ends clamp: stepping up from the top stays at the top and stepping down from the bottom stays
 * at the bottom, rather than running off the array into `undefined` or producing a negative length.
 *
 * A value that is not *on* the ladder — an element whose padding the project set to `0.9rem` — steps
 * to the nearest ladder value in the requested direction. That is the same answer as "snap to the
 * nearest step, then step unless snapping already moved you the right way", for every input, and it
 * needs no special case for a tie.
 *
 * `null` means the computed value could not be read as a number (`auto`, `normal`, an empty reply).
 * Both directions then land on the bottom of the ladder, because there is no position to move from
 * and the bottom is the only value that is definitely representable.
 */
export function stepLadder(
  ladder: readonly number[],
  current: number | null,
  direction: 1 | -1,
): number {
  const first = ladder[0];
  const last = ladder[ladder.length - 1];
  if (current === null || !Number.isFinite(current)) return first;

  if (direction === 1) {
    for (const value of ladder) {
      if (value > current + EPSILON) return value;
    }
    return last;
  }

  for (let i = ladder.length - 1; i >= 0; i--) {
    if (ladder[i] < current - EPSILON) return ladder[i];
  }
  return first;
}

/**
 * A part, as a stepper entry in its own right.
 *
 * Everything the collapsed control does — reading a computed value, stepping the ladder, converting
 * units, writing — already works on a `StepperEntry`. Rather than a second implementation for sides,
 * a part borrows its parent's whole configuration and changes only what it *is*: the property it
 * writes and the single name it reads back under. `parts` is dropped so a part cannot itself expand.
 */
export function partEntry(parent: StepperEntry, part: StepperPart): StepperEntry {
  return {
    ...parent,
    parts: undefined,
    id: `${parent.id}:${part.property}`,
    label: part.label,
    property: part.property,
    read: [part.property],
  };
}

/** Flat set of all writable properties including longhands. */
export const WRITABLE_PROPERTIES: readonly StyleProperty[] = STYLE_PROPERTIES.flatMap(entry =>
  entry.control === 'stepper' && entry.parts
    ? [entry, ...entry.parts.map(part => partEntry(entry, part))]
    : [entry],
);
