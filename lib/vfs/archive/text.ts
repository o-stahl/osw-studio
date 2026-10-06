import { createTranslator } from 'next-intl';

/**
 * What the archive layer says, as message keys rather than finished English.
 *
 * Issues and failures carry `text` so the import dialog and the explorer's export toast can show
 * them in the interface language; `message` is the English rendering of the same text, for logs
 * and for code that reads it. This table is the English: `messages/en.json` holds a copy under
 * `archive`, kept identical by `lib/vfs/archive/__tests__/text.test.ts`, and the other locales
 * translate that.
 */
const KIND = '{kind, select, edge {Edge function} server {Server function} secret {Secret} other {Scheduled function}}';
const KIND_LOWER = '{kind, select, edge {edge function} server {server function} secret {secret} other {scheduled function}}';

export const ARCHIVE_EN = {
  emptyPath: 'Empty path.',
  outsideProject: 'This path points outside the project. The archive may be damaged or unsafe.',
  whitespace: 'Path has leading or trailing whitespace.',
  nullByte: 'Path contains a null byte.',
  controlChar: 'Path contains a control or text-direction character.',
  doubleAt: "Path contains '@@', which file storage rejects.",
  windowsSeparators: 'Path uses Windows-style separators. Re-create the archive with a tool that writes forward slashes.',
  windowsAbsolute: 'Path is an absolute Windows path.',
  pathTooLong: 'Path is longer than {max} characters.',
  manifestNotJson: '{file} could not be read — it is not valid JSON.',
  manifestMissingFields: '{file} could not be read — it is missing required fields.',
  manifestNewer: 'This archive was made by a newer version of OSW Studio (format {version}). Update the app to import it.',
  zipTooLarge: 'This zip file is larger than the {limit} import limit.',
  zipTooManyEntries: 'This archive holds {count} entries, more than the {max} an import accepts.',
  unpackedTooLarge: 'This archive is larger than the {limit} import limit once unpacked.',
  notZip: 'This file could not be read as a zip archive. {detail}',
  folderTooManyFiles: 'This folder holds {count} files, more than the {max} an import accepts.',
  folderTooLarge: 'This folder is larger than the {limit} import limit.',
  duplicateInArchive: 'The archive holds more than one file for this path.',
  duplicateInFolder: 'The folder holds more than one file for this path.',
  fileTooLarge: '{path} is {size}MB, over the {limit}MB limit for this kind of file.',
  managedFolder: '{path} is in a folder OSW Studio manages itself, and a project archive does not carry it, so it was not imported.',
  aiInstructions: 'This archive contains {path}, which the AI assistant reads as standing instructions for this project. Importing it replaces the project’s own instructions and changes how the assistant works here. Open the file before you accept it.',
  notBackendLayout: '{path} is not part of the backend layout an archive stores, so it was not imported. Backend files are a .js and .json pair under edge-functions/ or server-functions/, plus secrets.json and scheduled.json.',
  browserModeBackend: 'This archive includes backend features. They will be imported and kept with the project, but backend features require Server Mode — edge functions, secrets and schedules will not run until the project is on a self-hosted instance.',
  isBackup: 'This is a full OSW Studio backup (.osws), not a project archive. Restore it from the backup importer instead.',
  isTemplate: 'This is an OSW Studio template (.oswt), not a project archive. Import it from the template manager instead.',
  unusableName: `${KIND} "{name}" was left out of the archive: its name cannot be used as a filename.`,
  emptyCode: `${KIND} "{name}" has no code, so it is exported empty and cannot be imported again until code is added.`,
  orphanSchedule: 'Scheduled function "{name}" points at an edge function that no longer exists, so it was left out of the archive.',
  secretValue: 'Secret "{name}" carries a value. Archives never store secret values, so it was ignored — set the value in the app after importing.',
  duplicateName: `The archive holds more than one ${KIND_LOWER} named "{name}", so only the first was imported.`,
  nestedBackendFile: `${KIND} files must sit directly in {dir}, so {path} was not imported.`,
  missingCode: '"{name}" has settings but no {name}.js file beside them, so there is no function to import.',
  sidecarNotJson: '{path} is not valid JSON, so "{name}" was skipped.',
  sidecarNotObject: '{path} does not contain a JSON object, so "{name}" was skipped.',
  listNotJson: '{path} is not valid JSON, so it was skipped.',
  listNotArray: '{path} does not contain a JSON array, so it was skipped.',
  entryNotObject: 'Entry {index} in {path} is not an object, so it was skipped.',
  invalidRecord: `${KIND} "{name}" was skipped: {detail}`,
  manifestRelocated: 'This project has files at both /{manifest} and /{alternate}, so the archive’s settings were written to /{fallback} instead. Importing this archive will treat that file as ordinary content and will not restore the project settings.',
  keepBothTooLong: 'Keeping both copies would make the path too long, so nothing was written.',
  unknownRuntime: '"{value}" is not a runtime this version of OSW Studio has, so the runtime was left unchanged.',
  missingEdgeFunction: '"{name}" runs the edge function "{edge}", which this project does not have.',
  cannotStore: 'This storage backend cannot store {what, select, edge {edge functions} server {server functions} secret {secrets} other {scheduled functions}}.',
  nothingToReplace: '"{name}" is no longer in this project, so there was nothing to replace.',
} as const;

export type ArchiveTextKey = keyof typeof ARCHIVE_EN;

/** A message the archive layer produced, to be rendered in whatever language the viewer reads. */
export interface ArchiveText {
  key: ArchiveTextKey;
  values?: Record<string, string | number>;
}

const english = createTranslator({ locale: 'en', messages: { archive: ARCHIVE_EN }, namespace: 'archive' });

function archiveText(key: ArchiveTextKey, values?: ArchiveText['values']): ArchiveText {
  return values ? { key, values } : { key };
}

/** The English rendering, which is what `message` holds. */
function englishText(text: ArchiveText): string {
  return (english as unknown as (key: string, values?: ArchiveText['values']) => string)(text.key, text.values);
}

/** An issue's `message` and `text` together, so the two cannot be written to say different things. */
export function said(key: ArchiveTextKey, values?: ArchiveText['values']): { message: string; text: ArchiveText } {
  const text = archiveText(key, values);
  return { message: englishText(text), text };
}

/** A thrown archive failure whose reason the UI can show translated. */
export class ArchiveError extends Error {
  readonly text: ArchiveText;
  constructor(key: ArchiveTextKey, values?: ArchiveText['values']) {
    const text = archiveText(key, values);
    super(englishText(text));
    this.name = 'ArchiveError';
    this.text = text;
  }
}
