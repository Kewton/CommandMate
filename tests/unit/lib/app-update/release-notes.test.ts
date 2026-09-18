/**
 * Unit tests for the bundled release notes reader (Issue #2646).
 *
 * `parseReleaseNote` is the single gate every note file passes through, and
 * `readReleaseNotesBetween` is what the API hands to the "What's new" dialog:
 * a file that breaks one rule must be skipped whole, and nothing outside
 * `release-notes/<X.Y.Z>.json` may ever be opened. Both are exercised against a
 * real temp directory (never HOME, never the repository), because the rules
 * that matter here — regular file only, size ceiling, name pattern — are
 * properties of the filesystem entries, not of the parsed JSON.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  RELEASE_NOTES_DIRNAME,
  RELEASE_NOTE_ITEMS_MAX,
  RELEASE_NOTE_TEXT_MAX_LENGTH,
  parseReleaseNote,
  readReleaseNotesBetween,
} from '@/lib/app-update/release-notes';

/** A note with every field populated, as a plain record so tests can mutate it. */
function validNote(version = '0.39.0'): Record<string, unknown> {
  return {
    version,
    date: '2026-09-20',
    highlight: { ja: '更新の目玉', en: 'The highlight of this release' },
    added: [{ ja: '追加された機能', en: 'A new feature' }],
    improved: [{ ja: '改善された点', en: 'An improvement' }],
    fixed: [{ ja: '修正された不具合', en: 'A fix' }],
  };
}

/** `{ ja, en }` pairs, `count` of them. */
function items(count: number): { ja: string; en: string }[] {
  return Array.from({ length: count }, (_, i) => ({ ja: `項目 ${i}`, en: `item ${i}` }));
}

describe('Issue #2646: parseReleaseNote', () => {
  it('returns a fully populated note unchanged', () => {
    expect(parseReleaseNote(validNote(), '0.39.0')).toEqual({
      version: '0.39.0',
      date: '2026-09-20',
      highlight: { ja: '更新の目玉', en: 'The highlight of this release' },
      added: [{ ja: '追加された機能', en: 'A new feature' }],
      improved: [{ ja: '改善された点', en: 'An improvement' }],
      fixed: [{ ja: '修正された不具合', en: 'A fix' }],
    });
  });

  it('treats an omitted highlight as null and omitted lists as empty', () => {
    expect(parseReleaseNote({ version: '0.39.0', date: '2026-09-20' }, '0.39.0')).toEqual({
      version: '0.39.0',
      date: '2026-09-20',
      highlight: null,
      added: [],
      improved: [],
      fixed: [],
    });
  });

  it('treats an explicit null highlight as null', () => {
    const note = parseReleaseNote({ ...validNote(), highlight: null }, '0.39.0');

    expect(note?.highlight).toBeNull();
  });

  it('drops keys it does not know about, at both levels', () => {
    const raw = {
      ...validNote(),
      extra: 1,
      added: [{ ja: '追加された機能', en: 'A new feature', note: 'x' }],
    };

    // toEqual, not toMatchObject: the point is that `extra` and `note` are
    // absent from the value the API serialises, not merely that the known keys
    // survived.
    expect(parseReleaseNote(raw, '0.39.0')).toEqual({
      version: '0.39.0',
      date: '2026-09-20',
      highlight: { ja: '更新の目玉', en: 'The highlight of this release' },
      added: [{ ja: '追加された機能', en: 'A new feature' }],
      improved: [{ ja: '改善された点', en: 'An improvement' }],
      fixed: [{ ja: '修正された不具合', en: 'A fix' }],
    });
  });

  it.each([
    ['version disagrees with the file name', { ...validNote('0.38.0') }],
    ['version is missing', { date: '2026-09-20' }],
    ['version is a number', { ...validNote(), version: 39 }],
    ['date uses slashes', { ...validNote(), date: '2026/09/20' }],
    ['date is missing', { version: '0.39.0', highlight: null }],
    ['highlight is a string', { ...validNote(), highlight: 'まとめ' }],
    ['ja is empty', { ...validNote(), added: [{ ja: '', en: 'x' }] }],
    ['ja is whitespace only', { ...validNote(), added: [{ ja: '   ', en: 'x' }] }],
    [
      'ja is one character too long',
      {
        ...validNote(),
        added: [{ ja: 'x'.repeat(RELEASE_NOTE_TEXT_MAX_LENGTH + 1), en: 'x' }],
      },
    ],
    ['en is missing', { ...validNote(), added: [{ ja: 'x' }] }],
    ['en is a number', { ...validNote(), added: [{ ja: 'x', en: 1 }] }],
    ['added is a string', { ...validNote(), added: 'なし' }],
    ['added has one entry too many', { ...validNote(), added: items(RELEASE_NOTE_ITEMS_MAX + 1) }],
    ['an entry is a string', { ...validNote(), improved: ['改善'] }],
  ])('rejects the whole note when %s', (_label, raw) => {
    expect(parseReleaseNote(raw, '0.39.0')).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', [validNote()]],
    ['a string', JSON.stringify(validNote())],
  ])('rejects a document that is %s', (_label, raw) => {
    expect(parseReleaseNote(raw, '0.39.0')).toBeNull();
  });

  it('accepts the boundary values: 1 and 500 characters, and 30 entries', () => {
    const note = parseReleaseNote(
      {
        version: '0.39.0',
        date: '2026-09-20',
        highlight: { ja: 'あ', en: 'x'.repeat(RELEASE_NOTE_TEXT_MAX_LENGTH) },
        added: items(RELEASE_NOTE_ITEMS_MAX),
      },
      '0.39.0'
    );

    expect(note?.highlight).toEqual({ ja: 'あ', en: 'x'.repeat(RELEASE_NOTE_TEXT_MAX_LENGTH) });
    expect(note?.added).toHaveLength(RELEASE_NOTE_ITEMS_MAX);
  });
});

describe('Issue #2646: readReleaseNotesBetween', () => {
  let root: string;
  let notesDir: string;

  beforeEach(() => {
    root = makeTempDir('cm-release-notes-');
    notesDir = join(root, RELEASE_NOTES_DIRNAME);
    mkdirSync(notesDir);
  });

  afterEach(() => {
    removeTempDir(root);
  });

  /** Place `<version>.json` (or `name`) holding `note`. */
  function writeNote(version: string, note: unknown = validNote(version), name?: string): void {
    writeFileSync(join(notesDir, name ?? `${version}.json`), JSON.stringify(note));
  }

  /** Versions of the notes returned, in the order they were returned. */
  async function versionsBetween(from: string, to: string): Promise<string[]> {
    const notes = await readReleaseNotesBetween(from, to, root);
    return notes.map((note) => note.version);
  }

  it('returns from < v <= to, newest first', async () => {
    for (const version of ['0.37.0', '0.38.0', '0.38.1', '0.39.0', '0.40.0']) {
      writeNote(version);
    }

    expect(await versionsBetween('0.37.0', '0.39.0')).toEqual(['0.39.0', '0.38.1', '0.38.0']);
  });

  it('orders numerically, not lexically', async () => {
    writeNote('0.9.0');
    writeNote('0.10.0');

    // '0.10.0' < '0.9.0' as strings; compareVersions must win.
    expect(await versionsBetween('0.8.0', '0.10.0')).toEqual(['0.10.0', '0.9.0']);
  });

  it('accepts v-prefixed arguments', async () => {
    for (const version of ['0.38.0', '0.38.1', '0.39.0']) {
      writeNote(version);
    }

    expect(await versionsBetween('v0.37.0', 'v0.39.0')).toEqual(['0.39.0', '0.38.1', '0.38.0']);
  });

  it('skips a file that is not JSON and one whose version disagrees with its name', async () => {
    writeNote('0.39.0');
    writeFileSync(join(notesDir, '0.38.1.json'), '{ "version": "0.38.1",');
    writeNote('0.38.0', { ...validNote('0.38.0'), version: '0.37.9' });

    expect(await versionsBetween('0.37.0', '0.39.0')).toEqual(['0.39.0']);
  });

  it('never opens a name outside ^\\d+\\.\\d+\\.\\d+\\.json$', async () => {
    writeNote('0.39.0');
    const valid = validNote('0.38.0');
    writeFileSync(join(notesDir, 'README.md'), '# notes');
    writeNote('0.38.0', valid, '0.38.json');
    writeNote('0.38.0', valid, 'v0.38.0.json');
    writeNote('0.38.0', valid, '0.38.0.json.bak');

    expect(await versionsBetween('0.37.0', '0.39.0')).toEqual(['0.39.0']);
  });

  it('skips a directory and a symlink even when the name and target are valid', async () => {
    writeNote('0.39.0');
    mkdirSync(join(notesDir, '0.38.2.json'));
    const outside = join(root, 'outside-0.38.3.json');
    writeFileSync(outside, JSON.stringify(validNote('0.38.3')));
    symlinkSync(outside, join(notesDir, '0.38.3.json'));

    expect(await versionsBetween('0.38.1', '0.39.0')).toEqual(['0.39.0']);
  });

  it('skips a file larger than the size ceiling, and returns the same note without the padding', async () => {
    const padded = { ...validNote('0.38.0'), padding: 'x'.repeat(600 * 1024) };
    writeNote('0.38.0', padded);

    expect(await versionsBetween('0.37.0', '0.38.0')).toEqual([]);

    // Negative control: identical note, padding removed.
    writeNote('0.38.0');
    expect(await versionsBetween('0.37.0', '0.38.0')).toEqual(['0.38.0']);
  });

  it('returns [] when release-notes/ does not exist', async () => {
    rmSync(notesDir, { recursive: true, force: true });

    expect(await readReleaseNotesBetween('0.38.0', '0.39.0', root)).toEqual([]);
  });

  it.each([
    ['the same version', '0.39.0', '0.39.0'],
    ['a reversed range', '0.40.0', '0.39.0'],
    ['a non-comparable from (latest)', 'latest', '0.39.0'],
    ['a prerelease from', '0.39.0-rc.1', '0.40.0'],
  ])('returns [] for %s', async (_label, from, to) => {
    writeNote('0.39.0');
    writeNote('0.40.0');

    expect(await readReleaseNotesBetween(from, to, root)).toEqual([]);
  });

  it('returns at most 20 notes, newest first', async () => {
    for (let patch = 0; patch <= 24; patch++) {
      writeNote(`1.0.${patch}`);
    }

    const versions = await versionsBetween('0.0.0', '2.0.0');

    expect(versions).toHaveLength(20);
    expect(versions[0]).toBe('1.0.24');
    expect(versions[19]).toBe('1.0.5');
  });

  it('counts only valid notes toward the limit', async () => {
    for (let patch = 0; patch <= 24; patch++) {
      writeNote(`1.0.${patch}`);
    }
    for (const version of ['1.0.24', '1.0.23', '1.0.22']) {
      writeFileSync(join(notesDir, `${version}.json`), '{ not json');
    }

    const versions = await versionsBetween('0.0.0', '2.0.0');

    expect(versions).toHaveLength(20);
    expect(versions[0]).toBe('1.0.21');
    expect(versions[19]).toBe('1.0.2');
  });
});
