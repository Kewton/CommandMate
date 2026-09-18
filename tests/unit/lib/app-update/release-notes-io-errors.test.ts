/**
 * How readReleaseNotesBetween treats I/O failures (Issue #2646).
 *
 * "There are no release notes" and "the notes could not be read" must not look
 * the same to the caller: a missing path is an empty list, anything else
 * (EACCES, EIO, ...) has to propagate so the route answers 500 instead of
 * quietly telling the user nothing changed in this release.
 *
 * `fs/promises` is partially mocked here rather than in
 * `release-notes.test.ts`, because that file asserts real filesystem
 * properties (regular file, size, symlink) and must keep talking to the real
 * module.
 *
 * @vitest-environment node
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'fs/promises';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

import { readdir, readFile } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { RELEASE_NOTES_DIRNAME, readReleaseNotesBetween } from '@/lib/app-update/release-notes';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('Issue #2646: readReleaseNotesBetween I/O failures', () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = makeTempDir('cm-release-notes-io-');
    const notesDir = join(root, RELEASE_NOTES_DIRNAME);
    mkdirSync(notesDir);
    writeFileSync(
      join(notesDir, '0.39.0.json'),
      JSON.stringify({
        version: '0.39.0',
        date: '2026-09-20',
        highlight: { ja: '更新の目玉', en: 'The highlight of this release' },
      })
    );
  });

  afterEach(() => {
    removeTempDir(root);
  });

  it('is a positive control: the note is returned when nothing fails', async () => {
    const notes = await readReleaseNotesBetween('0.38.0', '0.39.0', root);

    expect(notes.map((note) => note.version)).toEqual(['0.39.0']);
  });

  it.each(['EACCES', 'EIO'])('rejects when readFile fails with %s', async (code) => {
    vi.mocked(readFile).mockRejectedValueOnce(errnoError(code));

    await expect(readReleaseNotesBetween('0.38.0', '0.39.0', root)).rejects.toThrow(code);
  });

  it('returns [] when readFile fails with ENOENT (the file vanished after readdir)', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(errnoError('ENOENT'));

    await expect(readReleaseNotesBetween('0.38.0', '0.39.0', root)).resolves.toEqual([]);
  });

  it('rejects when readdir fails with EACCES', async () => {
    vi.mocked(readdir).mockRejectedValueOnce(errnoError('EACCES'));

    await expect(readReleaseNotesBetween('0.38.0', '0.39.0', root)).rejects.toThrow('EACCES');
  });

  it('returns [] when readdir fails with ENOTDIR', async () => {
    vi.mocked(readdir).mockRejectedValueOnce(errnoError('ENOTDIR'));

    await expect(readReleaseNotesBetween('0.38.0', '0.39.0', root)).resolves.toEqual([]);
  });
});
