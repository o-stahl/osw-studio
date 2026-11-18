/**
 * The custom properties a project's stylesheets define, and writing one back where it stands.
 *
 * A variable is the project's own vocabulary for a value: `--accent`, `--space-4`. The Styles tab
 * lists them and edits them in place, in the stylesheet that declares them, so one change restyles
 * everything that uses the variable and the file goes on saying what is in force. Nothing here
 * needs a manifest or a naming convention: whatever the CSS declares is what there is.
 *
 * Pure: strings in, strings out. Not a CSS parser, only enough state (comments, strings, parens,
 * braces) to know which rule a declaration sits in and where its value starts and ends.
 */

export type VariableKind = 'color' | 'length' | 'font' | 'shadow' | 'other';

/** One `--name: value` as a file has it. A name defined in two rules is two definitions. */
export interface VariableDefinition {
  /** With its dashes, as `var()` takes it. */
  name: string;
  /** As written, trimmed. */
  value: string;
  file: string;
  /** Where the value's text starts and ends in the file. */
  start: number;
  end: number;
  /** The selector of the rule it is declared in, whitespace collapsed. */
  selector: string;
  /** The at-rules around that rule, outermost first, whitespace collapsed. */
  context: string[];
  /**
   * Declared for the whole document: the rule names `:root` or `html`, and nothing around it but
   * conditions (`@media`, `@supports`, `@layer`). Only these can be shown changing before the write.
   */
  root: boolean;
  kind: VariableKind;
}

const collapse = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();

const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const NAMED_COLOR = /^(?:transparent|currentcolor|black|white|red|green|blue|gray|grey|silver|maroon|purple|fuchsia|lime|olive|yellow|navy|teal|aqua|orange|rebeccapurple)$/i;
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt|fr|ms|s|deg)?$/i;
const GENERIC_FONT = /(^|,)\s*(?:serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|cursive|fantasy)\s*$/i;

/** What a value is, as far as choosing a control for it needs. A reference to another variable is `other`. */
export function variableKind(value: string): VariableKind {
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v) || COLOR_FUNCTION.test(v) || NAMED_COLOR.test(v)) return 'color';
  if (LENGTH.test(v)) return 'length';
  if (GENERIC_FONT.test(v)) return 'font';
  // An offset pair and a colour: `0 1px 2px rgba(...)`, one or several.
  if (/(?:^|[\s,])-?\d*\.?\d+(?:px|rem|em)?\s+-?\d*\.?\d+(?:px|rem|em)?\b/.test(v) && /#|rgba?\(|hsla?\(|oklch\(|color-mix\(|var\(/i.test(v)) return 'shadow';
  return 'other';
}

/** Whether a rule's selector list names the document root. */
function namesRoot(selector: string): boolean {
  return selector.split(',').some(part => /^(?::root|html)$/i.test(part.trim()));
}

const CONDITION = /^@(?:media|supports|layer|container)\b/i;

/**
 * Every custom property declaration in `css`, in document order, each with the rule it is in.
 * A declaration cut off by the end of the file is left out, as the browser leaves it out.
 */
export function scanVariables(file: string, css: string): VariableDefinition[] {
  const out: VariableDefinition[] = [];
  /** Open blocks, outermost first: what was written before each `{`. */
  const stack: string[] = [];
  const n = css.length;
  /** Where the statement being read began: just past the last `;`, `{` or `}`. */
  let from = 0;
  let paren = 0;
  let i = 0;

  const declaration = (to: number) => {
    if (stack.length === 0) return;
    const text = css.slice(from, to);
    const lead = text.length - text.trimStart().length;
    if (!text.startsWith('--', lead)) return;
    const colon = text.indexOf(':', lead);
    if (colon === -1) return;
    const name = text.slice(lead, colon).trim();
    if (!/^--[A-Za-z0-9_-]+$/.test(name)) return;
    const raw = text.slice(colon + 1);
    const value = raw.trim();
    if (value === '') return;
    const start = from + colon + 1 + (raw.length - raw.trimStart().length);
    const rules = stack.map(collapse);
    const selector = rules[rules.length - 1];
    const context = rules.slice(0, -1);
    out.push({
      name,
      value,
      file,
      start,
      end: start + value.length,
      selector,
      context,
      root: namesRoot(selector) && context.every(rule => CONDITION.test(rule)),
      kind: variableKind(value),
    });
  };

  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      // A comment before a statement is not part of it: the statement starts past the comment.
      const leads = css.slice(from, i).trim() === '';
      i = end === -1 ? n : end + 2;
      if (leads) from = i;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      i = Math.min(n, j + 1);
      continue;
    }
    if (c === '(') { paren++; i++; continue; }
    if (c === ')') { if (paren > 0) paren--; i++; continue; }
    if (paren > 0) { i++; continue; }
    if (c === '{') {
      stack.push(css.slice(from, i));
      from = i + 1;
    } else if (c === '}') {
      declaration(i);
      stack.pop();
      from = i + 1;
    } else if (c === ';') {
      declaration(i);
      from = i + 1;
    }
    i++;
  }
  return out;
}

/** The definitions of every stylesheet given, in the order given. */
export function scanProjectVariables(sources: readonly { path: string; content: string }[]): VariableDefinition[] {
  return sources.flatMap(source => scanVariables(source.path, source.content));
}

/**
 * `defs` without the document-level definitions a later one replaces.
 *
 * A stylesheet may give a variable a plain value and then, inside `@supports`, a better one for
 * browsers that can read it (a colour worked out from another). Only one of them is in force, and
 * listing both would offer an edit that changes nothing. Among the definitions of one name that
 * stand for the whole document under no condition but `@supports`, the last whose conditions this
 * browser meets is kept. Definitions under `@media`, or in a rule of their own, are other cases
 * and are all kept.
 *
 * @param supports whether the browser meets a condition, as `CSS.supports` answers its text.
 */
export function withoutShadowed(defs: readonly VariableDefinition[], supports: (condition: string) => boolean): VariableDefinition[] {
  const plain = (def: VariableDefinition) => def.root && def.context.every(rule => /^@supports\b/i.test(rule));
  const applies = (def: VariableDefinition) => def.context.every(rule => supports(rule.replace(/^@supports\s*/i, '')));
  const inForce = new Map<string, VariableDefinition>();
  for (const def of defs) if (plain(def) && applies(def)) inForce.set(def.name, def);
  return defs.filter(def => !plain(def) || inForce.get(def.name) === def);
}

/** Which definition of a name is meant: the rule it stands in, and the value it had, to tell two in one rule apart. */
export type VariableRef = Pick<VariableDefinition, 'name' | 'selector' | 'context' | 'value'>;

const sameRule = (a: Pick<VariableDefinition, 'selector' | 'context'>, b: Pick<VariableDefinition, 'selector' | 'context'>) =>
  a.selector === b.selector && a.context.length === b.context.length && a.context.every((rule, k) => rule === b.context[k]);

/**
 * The definition `ref` names in a file as it is now: in the same rule, with the value it had if two
 * stand there, else the last of them (the one in force). Null when the rule no longer declares it.
 */
export function findDefinition(file: string, css: string, ref: VariableRef): VariableDefinition | null {
  const inRule = scanVariables(file, css).filter(def => def.name === ref.name && sameRule(def, ref));
  if (inRule.length === 0) return null;
  return inRule.find(def => def.value === ref.value) ?? inRule[inRule.length - 1];
}

/**
 * Whether every parenthesis, square bracket and quote the value opens, it also closes, in order.
 * One left open runs on past the `;` written after the value: the declaration takes in what follows
 * it, and an unclosed `(` takes every later rule of the stylesheet with it. An escaped character
 * counts as itself, so a backslash at the very end, which would escape that `;`, does not close.
 */
export function closesWhatItOpens(value: string): boolean {
  const open: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') {
      if (i + 1 >= value.length) return false;
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < value.length && value[j] !== c) {
        // CSS ends a string at a newline it does not escape, leaving the rest of the line open.
        if (value[j] === '\n' || value[j] === '\r' || value[j] === '\f') return false;
        j += value[j] === '\\' ? 2 : 1;
      }
      if (j >= value.length) return false;
      i = j;
    } else if (c === '(' || c === '[') {
      open.push(c === '(' ? ')' : ']');
    } else if ((c === ')' || c === ']') && open.pop() !== c) {
      return false;
    }
  }
  return open.length === 0;
}

/** A value that cannot end the declaration it is written into. */
export function isSafeVariableValue(value: string): boolean {
  const v = value.trim();
  return v !== '' && !/[;{}]/.test(v) && !v.includes('/*') && !v.includes('*/') && closesWhatItOpens(v);
}

/**
 * `css` with the definition `ref` names set to `next`. Null when the definition is not there any
 * more, or the value could not stand in a declaration. `!important` on the old value is kept.
 */
export function writeVariable(file: string, css: string, ref: VariableRef, next: string): string | null {
  if (!isSafeVariableValue(next)) return null;
  const def = findDefinition(file, css, ref);
  if (!def) return null;
  const mark = /\s*!\s*important\s*$/i.exec(def.value)?.[0] ?? '';
  const value = next.trim().replace(/\s*!\s*important\s*$/i, '') + mark;
  return css.slice(0, def.start) + value + css.slice(def.end);
}

/** How many times the project's CSS reads the variable: `var(--name` in any of the sources. */
export function countUses(sources: readonly { path: string; content: string }[], name: string): number {
  const pattern = new RegExp(`var\\(\\s*${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g');
  return sources.reduce((count, source) => count + (source.content.match(pattern)?.length ?? 0), 0);
}

/** The variable a declared value is, when it is one reference and nothing else: `var(--accent)`. */
export function variableOf(value: string | null | undefined): string | null {
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]*)?\)$/.exec((value ?? '').trim());
  return m ? m[1] : null;
}
