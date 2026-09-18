/**
 * The bundled release notes themselves (Issue #2646).
 *
 * `readReleaseNotesBetween` skips a bad file silently — that is the right
 * behaviour at runtime (one broken note must not empty the dialog), but it
 * means a note that was written wrong ships and simply never appears. This
 * file is the loud half: it re-states the runtime reader's rules over the
 * files actually in `release-notes/`, so a file that would be skipped at
 * runtime fails here instead. #2652's release procedure runs it after writing
 * a note.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  RELEASE_NOTES_DIRNAME,
  RELEASE_NOTE_FILE_MAX_BYTES,
  RELEASE_NOTE_FILE_PATTERN,
  parseReleaseNote,
} from '@/lib/app-update/release-notes';
import { compareVersions } from '@/cli/utils/semver';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const NOTES_DIR = path.join(REPO_ROOT, RELEASE_NOTES_DIRNAME);

const PACKAGE_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')
).version;

/**
 * Every problem with the entries of a release-notes directory ([] when all
 * are valid, or when the directory does not exist). Mirrors what the runtime
 * reader would silently skip, so a bundled file can never be skipped at runtime.
 */
function collectReleaseNoteErrors(dir: string, packageVersion: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const errors: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const filePath = path.join(dir, name);
    const info = fs.lstatSync(filePath);
    const match = RELEASE_NOTE_FILE_PATTERN.exec(name);
    if (!match) {
      errors.push(`${name}: file name must be X.Y.Z.json`);
      continue;
    }
    if (!info.isFile()) {
      errors.push(`${name}: not a regular file`);
      continue;
    }
    if (info.size > RELEASE_NOTE_FILE_MAX_BYTES) {
      errors.push(`${name}: larger than ${RELEASE_NOTE_FILE_MAX_BYTES} bytes`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      errors.push(`${name}: not valid JSON`);
      continue;
    }
    if (parseReleaseNote(raw, match[1]) === null) {
      errors.push(`${name}: violates the release note rules`);
      continue;
    }
    if (compareVersions(match[1], packageVersion) > 0) {
      errors.push(`${name}: newer than package.json version ${packageVersion}`);
    }
  }
  return errors;
}

describe('Issue #2646: every bundled release note is readable at runtime', () => {
  it('has no problem in release-notes/', () => {
    // Empty (or absent, as it is until the first note is written by #2652)
    // means zero entries to check, which is a pass.
    expect(collectReleaseNoteErrors(NOTES_DIR, PACKAGE_VERSION)).toEqual([]);
  });
});

describe('Issue #2646: the bundled-note check can fail', () => {
  let root: string | null = null;

  afterEach(() => {
    removeTempDir(root);
    root = null;
  });

  /** A temp directory to scan, plus the temp root that contains it. */
  function sandbox(): string {
    root = makeTempDir('cm-release-notes-files-');
    const dir = path.join(root, RELEASE_NOTES_DIRNAME);
    fs.mkdirSync(dir);
    return dir;
  }

  const VALID_NOTE = { version: '0.39.0', date: '2026-09-20' };

  it('reports a name that is not X.Y.Z.json', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '0.39.JSON'), '{}');

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual([
      '0.39.JSON: file name must be X.Y.Z.json',
    ]);
  });

  it('reports a file that is not JSON', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '0.39.0.json'), '{');

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual(['0.39.0.json: not valid JSON']);
  });

  it('reports a note that breaks the rules', () => {
    const dir = sandbox();
    fs.writeFileSync(
      path.join(dir, '0.39.0.json'),
      JSON.stringify({ version: '0.39.0', date: '2026-09-20', added: [{ ja: '', en: 'x' }] })
    );

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual([
      '0.39.0.json: violates the release note rules',
    ]);
  });

  it('reports a note newer than package.json', () => {
    const dir = sandbox();
    fs.writeFileSync(
      path.join(dir, '0.40.0.json'),
      JSON.stringify({ version: '0.40.0', date: '2026-09-20' })
    );

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual([
      '0.40.0.json: newer than package.json version 0.39.0',
    ]);
  });

  it('reports a symlink to a valid note', () => {
    const dir = sandbox();
    const outside = path.join(dir, '..', 'outside-0.39.0.json');
    fs.writeFileSync(outside, JSON.stringify(VALID_NOTE));
    fs.symlinkSync(outside, path.join(dir, '0.39.0.json'));

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual(['0.39.0.json: not a regular file']);
  });

  it('reports a note larger than the size ceiling even though it is valid', () => {
    const dir = sandbox();
    fs.writeFileSync(
      path.join(dir, '0.39.0.json'),
      JSON.stringify({ ...VALID_NOTE, padding: 'x'.repeat(600 * 1024) })
    );

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual([
      `0.39.0.json: larger than ${RELEASE_NOTE_FILE_MAX_BYTES} bytes`,
    ]);
  });

  it('is a positive control: a lone valid note, and a missing directory, report nothing', () => {
    const dir = sandbox();
    fs.writeFileSync(path.join(dir, '0.39.0.json'), JSON.stringify(VALID_NOTE));

    expect(collectReleaseNoteErrors(dir, '0.39.0')).toEqual([]);
    expect(collectReleaseNoteErrors(path.join(dir, 'does-not-exist'), '0.39.0')).toEqual([]);
  });
});
