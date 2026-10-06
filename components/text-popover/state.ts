/** Pure functions for the text popover. */

import type { ApplyResult } from '@/lib/direct-edit/types';

/**
 * The refusals reading or writing text can produce. `needs-confirmation` is handled separately —
 * it is a question, not a refusal, and the dialog renders it differently.
 */
export type TextRefusalReason =
  | 'unresolvable'
  | 'generating'
  | 'stale-index'
  | 'missing-file'
  | 'has-children'
  | 'has-expression'
  | 'unclosed'
  | 'void-element';

const TEXT_REFUSAL_REASONS: readonly TextRefusalReason[] = [
  'unresolvable', 'generating', 'stale-index', 'missing-file',
  'has-children', 'has-expression', 'unclosed', 'void-element',
];

export interface TextRefusal {
  reason: TextRefusalReason;
  file?: string;
}

/** Narrows ApplyResult reasons to those the text popover can render. */
export function textRefusal(
  result: { ok: boolean; reason?: ApplyResult['reason']; file?: string; instances?: number },
): TextRefusal | null {
  if (result.ok || result.reason === 'needs-confirmation') return null;
  const reason = TEXT_REFUSAL_REASONS.includes(result.reason as TextRefusalReason)
    ? (result.reason as TextRefusalReason)
    : 'unresolvable';
  return { reason, file: result.file };
}

/** The popover's own message keys, so a translator passed in is checked against them. */
export type TextPopoverMessageKey =
  | 'titleGenerating' | 'titleStale' | 'titleMissing' | 'titleChildren' | 'titleExpression' | 'titleUnclosed'
  | 'titleVoid' | 'titleUnresolvable'
  | 'msgGenerating' | 'msgStale' | 'msgStaleFile' | 'msgMissing' | 'msgMissingFile' | 'msgChildren' | 'msgExpression'
  | 'msgUnclosed' | 'msgUnclosedFile' | 'msgVoid' | 'msgUnresolvable'
  | 'confirmMany' | 'confirmManyFrom' | 'confirmShared' | 'confirmSharedFrom';

export type TextPopoverTranslator = (key: TextPopoverMessageKey, values?: Record<string, string | number>) => string;

/** Separate from message so the headline does not contradict the detail. */
export function textRefusalTitle(refusal: TextRefusal, t: TextPopoverTranslator): string {
  switch (refusal.reason) {
    case 'generating':      return t('titleGenerating');
    case 'stale-index':     return t('titleStale');
    case 'missing-file':    return t('titleMissing');
    case 'has-children':    return t('titleChildren');
    case 'has-expression':  return t('titleExpression');
    case 'unclosed':        return t('titleUnclosed');
    case 'void-element':    return t('titleVoid');
    case 'unresolvable':    return t('titleUnresolvable');
  }
}

export function textRefusalMessage(refusal: TextRefusal, t: TextPopoverTranslator): string {
  const file = refusal.file;
  switch (refusal.reason) {
    case 'generating':      return t('msgGenerating');
    case 'stale-index':     return file ? t('msgStaleFile', { file }) : t('msgStale');
    case 'missing-file':    return file ? t('msgMissingFile', { file }) : t('msgMissing');
    case 'has-children':    return t('msgChildren');
    case 'has-expression':  return t('msgExpression');
    case 'unclosed':        return file ? t('msgUnclosedFile', { file }) : t('msgUnclosed');
    case 'void-element':    return t('msgVoid');
    case 'unresolvable':    return t('msgUnresolvable');
  }
}

/**
 * The refusal as a request to the agent, in English like everything the agent is sent. The popover
 * shows {@link textRefusalMessage} instead.
 */
export function textRefusalAgentPrompt(refusal: TextRefusal): string {
  switch (refusal.reason) {
    case 'generating':
      return 'The agent is editing this project. Text changes wait until it finishes.'; // i18n-ignore: part of a request to the agent
    case 'stale-index':
      return `The preview is out of date${refusal.file ? `: ${refusal.file} has changed since it was compiled` : ''}. ` // i18n-ignore: part of a request to the agent
        + 'Refresh the preview and select the text again.'; // i18n-ignore: part of a request to the agent
    case 'missing-file':
      return `${refusal.file ?? 'The source file'} no longer exists, so there is nothing to edit. ` // i18n-ignore: part of a request to the agent
        + 'Refreshing will not help — ask the agent to rebuild it.'; // i18n-ignore: part of a request to the agent
    case 'has-children':
      return 'This element holds more than plain text — there is other markup inside it, and ' // i18n-ignore: part of a request to the agent
        + 'replacing the words here would delete it. Select the part you want to change on its own, ' // i18n-ignore: part of a request to the agent
        + 'or ask the agent to reword the whole thing.'; // i18n-ignore: part of a request to the agent
    case 'has-expression':
      return 'These words come from the template rather than from the page, so what is written in ' // i18n-ignore: part of a request to the agent
        + 'the file is not what you are reading. Ask the agent to change what the template says.'; // i18n-ignore: part of a request to the agent
    case 'unclosed':
      return `This element is never closed${refusal.file ? ` in ${refusal.file}` : ''}, so there is no ` // i18n-ignore: part of a request to the agent
        + 'text to replace. Ask the agent to fix the markup first.'; // i18n-ignore: part of a request to the agent
    case 'void-element':
      return 'This element cannot hold text, so there is nothing to retype.'; // i18n-ignore: part of a request to the agent
    case 'unresolvable':
      return 'This text is built at runtime, so there is no source to edit. ' // i18n-ignore: part of a request to the agent
        + 'Ask the agent to change it instead.'; // i18n-ignore: part of a request to the agent
  }
}

/** Whether the refusal is worth offering the agent. A wait, a refresh or an empty element is not. */
export function textRefusalOffersAgent(refusal: TextRefusal): boolean {
  return refusal.reason === 'unresolvable' || refusal.reason === 'missing-file'
    || refusal.reason === 'has-children' || refusal.reason === 'has-expression'
    || refusal.reason === 'unclosed';
}

/** What the popover says before writing to a source tag that renders more than once. */
export function textConfirmationMessage(instances: number, t: TextPopoverTranslator, file?: string): string {
  if (instances > 1) return file ? t('confirmManyFrom', { file, count: instances }) : t('confirmMany', { count: instances });
  return file ? t('confirmSharedFrom', { file }) : t('confirmShared');
}

/** Unchanged text is not a write. Compared against the text as read, entities included. */
export function textIsChanged(original: string, next: string): boolean {
  return next !== original;
}
