import type { ActionKind } from '@/lib/agent-activity/parse-command';
import type { Tally, TallyStep } from './tally';

/**
 * A stretch of steps as one sentence.
 *
 * Reads the way a person would sum up what they watched: "Read 3 files, then edited index.html,
 * rebuilt the site". The sentence gets more general as the stretch grows, in three levels, so a
 * long run never becomes a long sentence:
 *
 * 1. consecutive steps of one kind become one clause, in order;
 * 2. past four clauses, all steps of one kind become one clause, ordered by first appearance;
 * 3. past four kinds, the whole stretch is a count of commands and files.
 */

/** The verb families that read as one activity. */
type Family = 'read' | 'change' | 'create' | 'delete' | 'move' | 'copy' | 'search' | 'list' | 'lookup'
  | 'build' | 'evaluate' | 'preview' | 'delegate' | 'image' | 'database' | 'plan' | 'run' | 'other';

const FAMILY: Record<ActionKind, Family> = {
  read: 'read', write: 'change', edit: 'change', create: 'create', delete: 'delete', move: 'move',
  copy: 'copy', search: 'search', list: 'list', lookup: 'lookup', build: 'build', evaluate: 'evaluate',
  preview: 'preview', delegate: 'delegate', image: 'image', database: 'database', plan: 'plan',
  run: 'run', other: 'other',
};

/** Families whose clause names the file, or counts them. */
const FILE_FAMILIES = new Set<Family>(['read', 'change', 'create', 'delete', 'move', 'copy']);

/** Families whose clause is one fixed phrase however often they ran. */
const FIXED_FAMILIES = new Set<Family>([
  'search', 'list', 'lookup', 'build', 'evaluate', 'preview', 'delegate', 'database', 'plan',
]);

/**
 * One clause of the sentence, before it is worded: its family, the one file it names when it named
 * exactly one, and how many files or commands it counts otherwise.
 */
export interface Clause {
  family: Family;
  file: string | null;
  count: number;
}

/** A stretch as clauses in reading order, or, past four kinds, a count of commands and files. */
export type CollatedLine =
  | { kind: 'clauses'; clauses: Clause[] }
  | { kind: 'total'; commands: number; changed: number };

interface Group {
  family: Family;
  /** Distinct files named, in order. */
  files: string[];
  /** Steps that named no file. */
  unnamed: number;
  commands: number;
}

const MAX_CLAUSES = 4;

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function add(group: Group, step: TallyStep): void {
  group.commands += step.steps;
  if (step.path) {
    if (!group.files.includes(step.path)) group.files.push(step.path);
  } else {
    group.unnamed += step.steps;
  }
}

function groupConsecutive(steps: TallyStep[]): Group[] {
  const groups: Group[] = [];
  for (const step of steps) {
    const family = FAMILY[step.kind];
    const last = groups[groups.length - 1];
    if (last && last.family === family) add(last, step);
    else {
      const group: Group = { family, files: [], unnamed: 0, commands: 0 };
      add(group, step);
      groups.push(group);
    }
  }
  return groups;
}

function groupByFamily(steps: TallyStep[]): Group[] {
  const groups: Group[] = [];
  for (const step of steps) {
    const family = FAMILY[step.kind];
    let group = groups.find((g) => g.family === family);
    if (!group) {
      group = { family, files: [], unnamed: 0, commands: 0 };
      groups.push(group);
    }
    add(group, step);
  }
  return groups;
}

function toClause(group: Group): Clause {
  if (FILE_FAMILIES.has(group.family)) {
    const named = group.files.length === 1 && group.unnamed === 0;
    return { family: group.family, file: named ? fileName(group.files[0]) : null, count: group.files.length + group.unnamed };
  }
  return { family: group.family, file: null, count: group.commands };
}

/**
 * The keys a collated line is worded with, under `quickEdit.collate`. Every clause takes a
 * `position`: the first clause opens the sentence and the rest follow "then", and whether that
 * changes the clause (English lowercases it, Korean does not) is the translation's call.
 */
type FileClauseKey = `${'read' | 'change' | 'create' | 'delete' | 'move' | 'copy'}${'File' | 'Count'}`;
export type CollateKey =
  | FileClauseKey
  | 'search' | 'list' | 'lookup' | 'build' | 'evaluate' | 'preview' | 'delegate' | 'database' | 'plan'
  | 'image' | 'run' | 'other' | 'then' | 'and' | 'total' | 'totalChanged';
export type CollateTranslator = (key: CollateKey, values?: Record<string, string | number>) => string;

function phraseClause(clause: Clause, position: 'first' | 'later', t: CollateTranslator): string {
  const { family } = clause;
  if (FILE_FAMILIES.has(family)) {
    const base = family as 'read' | 'change' | 'create' | 'delete' | 'move' | 'copy';
    return clause.file
      ? t(`${base}File`, { position, file: clause.file }) // i18n-ignore: a message key, checked by tsc
      : t(`${base}Count`, { position, count: clause.count }); // i18n-ignore: a message key, checked by tsc
  }
  if (FIXED_FAMILIES.has(family)) return t(family as CollateKey, { position });
  const counted = family === 'image' || family === 'run' ? family : 'other';
  return t(counted, { position, count: clause.count });
}

/** The line in words: "Read 3 files, then edited index.html, rebuilt the site". */
export function phraseCollated(line: CollatedLine, t: CollateTranslator): string {
  if (line.kind === 'total') {
    return line.changed > 0
      ? t('totalChanged', { commands: line.commands, changed: line.changed })
      : t('total', { commands: line.commands });
  }
  return line.clauses.reduce<string>((text, clause, i) => {
    if (i === 0) return phraseClause(clause, 'first', t);
    const after = phraseClause(clause, 'later', t);
    return t(i === 1 ? 'then' : 'and', { before: text, after });
  }, '');
}

/** The steps of a tally collated into clauses, or null when there are none yet. */
export function collate(tally: Tally): CollatedLine | null {
  if (tally.steps.length === 0) return null;

  const ordered = groupConsecutive(tally.steps);
  if (ordered.length <= MAX_CLAUSES) return { kind: 'clauses', clauses: ordered.map(toClause) };

  const byFamily = groupByFamily(tally.steps);
  if (byFamily.length <= MAX_CLAUSES) return { kind: 'clauses', clauses: byFamily.map(toClause) };

  return { kind: 'total', commands: tally.commandCount, changed: tally.filesChanged.length };
}
