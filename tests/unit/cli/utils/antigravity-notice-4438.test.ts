/**
 * Issue #4438 G4: the CLI's Antigravity usage notice is said once per CLI
 * environment (a record in the config directory keyed by the terms' check date),
 * on stderr only, for antigravity only.
 *
 * The record lives in a temp directory named by CM_ANTIGRAVITY_NOTICE_DIR; the real
 * config directory is never touched.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_NOTICE_DIR_ENV,
  cliPackageRoot,
  defaultRecordDir,
  ANTIGRAVITY_NOTICE_FILE_NAME,
  antigravityNoticeLines,
  noteAntigravityNotice,
} from '../../../../src/cli/utils/antigravity-notice';
import {
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_CHECKED_AT,
  ANTIGRAVITY_TERMS_URL,
} from '../../../../src/lib/tool-policy/policy';

let dir: string;
let said: string[];
const emit = (line: string): void => {
  said.push(line);
};
const recordFile = (): string => path.join(dir, ANTIGRAVITY_NOTICE_FILE_NAME);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4438-g4-'));
  said = [];
  vi.stubEnv(ANTIGRAVITY_NOTICE_DIR_ENV, dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('noteAntigravityNotice (#4438 G4)', () => {
  it('G4-d: the first time it says the notice with both links, and records the check date', () => {
    expect(noteAntigravityNotice('antigravity', emit)).toBe(true);
    const text = said.join('\n');
    expect(text).toContain(ANTIGRAVITY_TERMS_URL);
    expect(text).toContain(ANTIGRAVITY_FAQ_URL);
    expect(text).toContain('CM_ANTIGRAVITY_USAGE');
    expect(JSON.parse(fs.readFileSync(recordFile(), 'utf8'))).toMatchObject({ termsCheckedAt: ANTIGRAVITY_TERMS_CHECKED_AT });
    expect(fs.statSync(recordFile()).mode & 0o777).toBe(0o600);
  });

  it('G4-d: the second time it says nothing', () => {
    noteAntigravityNotice('antigravity', emit);
    said.length = 0;
    expect(noteAntigravityNotice('antigravity', emit)).toBe(false);
    expect(said).toEqual([]);
  });

  it('G4-d: a record of another check date says it again, and updates the record', () => {
    fs.writeFileSync(recordFile(), JSON.stringify({ termsCheckedAt: '2000-01-01' }));
    expect(noteAntigravityNotice('antigravity', emit)).toBe(true);
    expect(JSON.parse(fs.readFileSync(recordFile(), 'utf8')).termsCheckedAt).toBe(ANTIGRAVITY_TERMS_CHECKED_AT);
  });

  it.each(['not json', '', '[]', 'null', '{"termsCheckedAt":5}'])('G4-d / P1: an unreadable record (%j) says it', (content) => {
    fs.writeFileSync(recordFile(), content);
    expect(noteAntigravityNotice('antigravity', emit)).toBe(true);
  });

  it('P1: a record that cannot be read at all (a directory in its place) says it and does not throw', () => {
    fs.mkdirSync(recordFile());
    expect(() => noteAntigravityNotice('antigravity', emit)).not.toThrow();
    expect(said.length).toBeGreaterThan(0);
  });

  it('P1: a record that cannot be written says it and goes on (no throw, no exit)', () => {
    // The "directory" is a file: reading and writing under it both fail.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    vi.stubEnv(ANTIGRAVITY_NOTICE_DIR_ENV, blocker);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    expect(() => noteAntigravityNotice('antigravity', emit)).not.toThrow();
    expect(said.length).toBeGreaterThan(0);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
    // and it says it again the next time, since nothing was recorded
    said.length = 0;
    noteAntigravityNotice('antigravity', emit);
    expect(said.length).toBeGreaterThan(0);
  });

  it('G4-c: other tools hear nothing and leave no record', () => {
    for (const tool of ['claude', 'codex', 'gemini', undefined]) {
      expect(noteAntigravityNotice(tool, emit)).toBe(false);
    }
    expect(said).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('under vitest with no named directory the record is off: nothing is said or written', () => {
    vi.stubEnv(ANTIGRAVITY_NOTICE_DIR_ENV, '');
    expect(noteAntigravityNotice('antigravity', emit)).toBe(false);
    expect(said).toEqual([]);
  });

  it('the lines name the usual caution and are plain lines (no newline inside)', () => {
    for (const line of antigravityNoticeLines()) expect(line).not.toContain('\n');
    expect(antigravityNoticeLines()[0]).toMatch(/Section 6/);
  });
});

describe('record location (#4438 G4, L1-L3)', () => {
  it('L1: a local run records in the CLI package root, never under the cwd', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4438-cwd-'));
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const where = defaultRecordDir(false);
      expect(where).toBe(cliPackageRoot());
      expect(fs.existsSync(path.join(where, 'package.json'))).toBe(true);
      expect(path.relative(cwd, where).startsWith('..')).toBe(true);
      expect(where.startsWith(cwd)).toBe(false);
    } finally {
      spy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('L3: a global install records in ~/.commandmate (a temp HOME here)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4438-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      expect(defaultRecordDir(true)).toBe(path.join(home, '.commandmate'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
