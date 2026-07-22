/**
 * Tests for the raw-control-character CI guard (Issue #1432).
 *
 * The guard exists because raw NUL in src/lib/skills/{operation-lock,preview-diff}.ts
 * made grep/rg skip both files silently. A guard that never fires is worse than
 * none, so these tests plant a violation and assert it is actually caught.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findControlCharViolations } from '../../../scripts/check-control-chars.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');

type Violation = { file: string; line: number; column: number; byte: string };
const scan = (root: string): Violation[] => findControlCharViolations(root) as Violation[];

describe('Issue #1432: repository is free of raw control characters', () => {
  it('finds no violation under src/', () => {
    expect(scan(REPO_ROOT)).toEqual([]);
  });

  it('keeps the de-NUL-ed hash separators greppable as escapes', () => {
    const lock = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/skills/operation-lock.ts'), 'utf-8');
    const diff = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/skills/preview-diff.ts'), 'utf-8');
    expect(lock).toContain('`${worktreeRealPath}\\x00${skillId}`');
    expect(diff).toContain('`${file.path}\\x00${file.sha256}\\x00');
  });
});

describe('Issue #1432: the guard actually fires', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ctrl-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, contents: string): void => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  };

  it('rejects a raw NUL byte', () => {
    write('src/bad.ts', 'export const sep = `a\x00b`;\n');
    expect(scan(root)).toEqual([
      { file: 'src/bad.ts', line: 1, column: 22, byte: '0x00' },
    ]);
  });

  it('rejects other C0 control characters', () => {
    write('src/bell.ts', 'export const x = "\x07";\n');
    expect(scan(root)[0]).toMatchObject({ file: 'src/bell.ts', byte: '0x07' });
  });

  it('allows tab, LF and CR', () => {
    write('src/fine.ts', 'export const x = 1;\r\n\texport const y = 2;\n');
    expect(scan(root)).toEqual([]);
  });

  it('accepts the escaped form that replaced the raw separator', () => {
    write('src/good.ts', 'export const sep = `${a}\\x00${b}`;\n');
    expect(scan(root)).toEqual([]);
  });

  it('reports the line number of a violation on a later line', () => {
    write('src/late.ts', 'const a = 1;\nconst b = 2;\nconst c = "\x00";\n');
    expect(scan(root)[0]).toMatchObject({ file: 'src/late.ts', line: 3 });
  });

  it('does not scan tests/, which needs raw control bytes as fixtures', () => {
    write('tests/fixture.ts', 'const nul = "\x00";\n');
    expect(scan(root)).toEqual([]);
  });

  it('scans nested directories but skips node_modules', () => {
    write('src/lib/deep/nested.ts', 'const x = "\x00";\n');
    write('src/node_modules/vendor.ts', 'const y = "\x00";\n');
    const files = scan(root).map((v) => v.file);
    expect(files).toEqual([path.join('src/lib/deep/nested.ts')]);
  });
});
