/**
 * Bundled release notes (Issue #2646).
 *
 * `release-notes/<X.Y.Z>.json` holds a short, user-facing summary of each
 * release in both UI languages, so the "What's new" dialog can follow the UI
 * locale instead of showing the Japanese CHANGELOG. The directory ships in the
 * npm package (`files`), and the server runs with cwd = package root, so it is
 * read from `process.cwd()` like `readRuntimeServerVersion()` reads package.json.
 *
 * Path safety: only names returned by `readdir` that match
 * RELEASE_NOTE_FILE_PATTERN are ever opened. Request values are compared as
 * versions and never used to build a path.
 *
 * @module lib/app-update/release-notes
 */

import { lstat, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { compareVersions, isComparableVersion } from '@/cli/utils/semver';

/** Directory (relative to the package root) holding `<X.Y.Z>.json` */
export const RELEASE_NOTES_DIRNAME = 'release-notes';

/** The only file names that are read. Group 1 is the version. */
export const RELEASE_NOTE_FILE_PATTERN = /^(\d+\.\d+\.\d+)\.json$/;

/** Max length (String.prototype.length) of each ja / en string */
export const RELEASE_NOTE_TEXT_MAX_LENGTH = 500;

/** Max entries in each of added / improved / fixed */
export const RELEASE_NOTE_ITEMS_MAX = 30;

/** Max notes returned by readReleaseNotesBetween() */
export const RELEASE_NOTES_RESPONSE_MAX = 20;

/** Files larger than this are skipped without being read */
export const RELEASE_NOTE_FILE_MAX_BYTES = 512 * 1024;

const RELEASE_NOTE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** One sentence in both UI languages (plain text) */
export interface LocalizedText {
  ja: string;
  en: string;
}

/** A validated release note */
export interface ReleaseNote {
  version: string;
  date: string;
  highlight: LocalizedText | null;
  added: LocalizedText[];
  improved: LocalizedText[];
  fixed: LocalizedText[];
}

function isNoteText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= RELEASE_NOTE_TEXT_MAX_LENGTH
  );
}

function parseLocalizedText(value: unknown): LocalizedText | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { ja, en } = value as Record<string, unknown>;
  return isNoteText(ja) && isNoteText(en) ? { ja, en } : null;
}

/** undefined → []; anything invalid → null (the whole note is rejected) */
function parseItems(value: unknown): LocalizedText[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > RELEASE_NOTE_ITEMS_MAX) return null;
  const items: LocalizedText[] = [];
  for (const entry of value) {
    const text = parseLocalizedText(entry);
    if (text === null) return null;
    items.push(text);
  }
  return items;
}

/**
 * Validate one parsed JSON document.
 *
 * @param raw - `JSON.parse` result
 * @param expectedVersion - the version taken from the file name
 * @returns the note with only the known keys, or null when any rule fails
 */
export function parseReleaseNote(raw: unknown, expectedVersion: string): ReleaseNote | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== expectedVersion) return null;
  if (typeof record.date !== 'string' || !RELEASE_NOTE_DATE_PATTERN.test(record.date)) {
    return null;
  }

  let highlight: LocalizedText | null = null;
  if (record.highlight !== undefined && record.highlight !== null) {
    highlight = parseLocalizedText(record.highlight);
    if (highlight === null) return null;
  }

  const added = parseItems(record.added);
  const improved = parseItems(record.improved);
  const fixed = parseItems(record.fixed);
  if (added === null || improved === null || fixed === null) return null;

  return { version: expectedVersion, date: record.date, highlight, added, improved, fixed };
}

/** A path that is simply not there (or stopped being a directory). */
function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * One note file, or null when the file should be skipped: it vanished after
 * readdir, is not a regular file, is too large, is not JSON, or breaks the
 * rules. Any other I/O failure (EACCES, EIO, ...) is thrown so the route can
 * answer 500 instead of pretending there are no notes.
 */
async function readNoteFile(dir: string, version: string): Promise<ReleaseNote | null> {
  const filePath = join(dir, `${version}.json`);
  let text: string;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size > RELEASE_NOTE_FILE_MAX_BYTES) return null;
    text = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return parseReleaseNote(raw, version);
}

/**
 * Notes for every version v with `from < v <= to`, newest first, at most
 * RELEASE_NOTES_RESPONSE_MAX. Invalid files are skipped and do not count
 * toward the limit. A missing directory yields []. I/O failures other than a
 * missing path are thrown.
 *
 * @param from - the version the user was on (exclusive)
 * @param to - the version now running (inclusive)
 * @param rootDir - package root (defaults to process.cwd())
 */
export async function readReleaseNotesBetween(
  from: string,
  to: string,
  rootDir: string = process.cwd()
): Promise<ReleaseNote[]> {
  if (!isComparableVersion(from) || !isComparableVersion(to)) return [];
  if (compareVersions(from, to) >= 0) return [];

  const dir = join(rootDir, RELEASE_NOTES_DIRNAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const versions = names
    .map((name) => RELEASE_NOTE_FILE_PATTERN.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .filter((version) => compareVersions(version, from) > 0 && compareVersions(version, to) <= 0)
    .sort((a, b) => compareVersions(b, a));

  const notes: ReleaseNote[] = [];
  for (const version of versions) {
    if (notes.length >= RELEASE_NOTES_RESPONSE_MAX) break;
    const note = await readNoteFile(dir, version);
    if (note !== null) notes.push(note);
  }
  return notes;
}
