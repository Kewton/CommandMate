/**
 * Tests for the token-discipline guard (Issue #1082 / #1116, extracted in #1882).
 *
 * The check used to live as inline shell inside `.github/workflows/ci-pr.yml`,
 * where nothing could execute it except a CI run. `.commandmate/verify.yaml` now
 * runs it as a gate too, which is only safe while both call the SAME script — so
 * the exclusions have to be pinned somewhere that fails loudly when one of them
 * is dropped. Losing the `*Terminal*` exemption in particular would turn every
 * terminal component in the repository into a violation at once.
 *
 * Each case plants a real file in a real git repository and runs the real
 * `git grep`: the pathspec list and the exclusions are the behaviour under test,
 * and a unit test that only exercised the line filter would not see either.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GUARDED_PATHSPECS,
  TOKEN_DISCIPLINE_PATTERN,
  filterGitGrepLines,
  findTokenDisciplineViolations,
} from '../../../scripts/check-token-discipline.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const scan = (root: string): string[] => findTokenDisciplineViolations(root) as string[];
const filesOf = (root: string): string[] => scan(root).map((line) => line.split(':')[0]);

describe('Issue #1882: the repository itself is clean', () => {
  it('finds no violation in the migrated directories', () => {
    expect(scan(REPO_ROOT)).toEqual([]);
  });
});

describe('Issue #1882: the guard fires, and only where it should', () => {
  let root: string;

  /** A single fixture repository: every case below is one file inside it. */
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-')));
    execFileSync('git', ['init', '-q'], { cwd: root });

    const write = (relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };

    // Violations that MUST be caught.
    write('src/components/ui/Badge.tsx', 'export const c = "bg-sky-50 text-sky-700";\n');
    write('src/app/page.tsx', 'export const c = "border-gray-200";\n');
    // The exemption reads the PATH field only: a file whose CONTENT mentions
    // Terminal is still guarded.
    write('src/components/home/AboutTheConsole.tsx', 'const label = "bg-slate-100"; // Terminal\n');

    // Exempt: always-dark terminal islands (#1079). The terminal output surfaces
    // stay dark in BOTH themes and use raw dark utilities on purpose.
    write('src/components/worktree/MyTerminalView.tsx', 'const c = "bg-gray-900 text-gray-300";\n');
    write('src/components/error/TerminalErrorFallback.tsx', 'const c = "bg-gray-800";\n');

    // Exempt: tests assert on concrete class strings.
    write('src/components/ui/Badge.test.tsx', 'expect(c).toBe("bg-sky-50");\n');
    write('src/components/ui/Badge.spec.tsx', 'expect(c).toBe("bg-sky-50");\n');
    write('src/components/ui/__tests__/Card.tsx', 'expect(c).toBe("bg-sky-50");\n');

    // Exempt: the worktree detail route keeps its CLI brand colors.
    write('src/app/worktrees/[id]/page.tsx', 'const c = "bg-purple-600 bg-blue-600";\n');

    // Out of scope: directories that were never migrated.
    write('src/lib/theme.ts', 'export const c = "bg-sky-50";\n');

    execFileSync('git', ['add', '-A'], { cwd: root });
  });

  afterAll(() => {
    removeTempDir(root);
  });

  it('catches raw chromatic utilities in a migrated component directory', () => {
    expect(filesOf(root)).toContain('src/components/ui/Badge.tsx');
  });

  it('catches raw neutral utilities under src/app', () => {
    expect(filesOf(root)).toContain('src/app/page.tsx');
  });

  it('exempts *Terminal* files — the always-dark islands of #1079', () => {
    expect(filesOf(root)).not.toContain('src/components/worktree/MyTerminalView.tsx');
    expect(filesOf(root)).not.toContain('src/components/error/TerminalErrorFallback.tsx');
  });

  it('exempts by path, not by content: a file merely mentioning Terminal is caught', () => {
    expect(filesOf(root)).toContain('src/components/home/AboutTheConsole.tsx');
  });

  it('exempts .test. / .spec. / __tests__, which assert on class strings', () => {
    const files = filesOf(root);
    expect(files).not.toContain('src/components/ui/Badge.test.tsx');
    expect(files).not.toContain('src/components/ui/Badge.spec.tsx');
    expect(files).not.toContain('src/components/ui/__tests__/Card.tsx');
  });

  it('excludes src/app/worktrees, which keeps its CLI brand colors', () => {
    expect(filesOf(root)).not.toContain('src/app/worktrees/[id]/page.tsx');
  });

  it('does not reach directories outside the guarded list', () => {
    expect(filesOf(root)).not.toContain('src/lib/theme.ts');
  });

  it('reports path:line:content, so a violation is addressable', () => {
    const line = scan(root).find((l) => l.startsWith('src/components/ui/Badge.tsx:'));
    expect(line).toBe('src/components/ui/Badge.tsx:1:export const c = "bg-sky-50 text-sky-700";');
  });
});

describe('Issue #1882: the declared surface stays put', () => {
  it('guards every directory the CI job guarded, and excludes src/app/worktrees', () => {
    expect(GUARDED_PATHSPECS).toEqual([
      'src/app',
      'src/components/ui',
      'src/components/layout',
      'src/components/home',
      'src/components/review',
      'src/components/repository',
      'src/components/common',
      'src/components/sidebar',
      'src/components/providers',
      'src/components/worktree',
      'src/components/mobile',
      'src/components/external-apps',
      'src/components/error',
      'src/components/auth',
      ':(exclude)src/app/worktrees',
    ]);
  });

  it('matches every palette family the CI job matched', () => {
    expect(TOKEN_DISCIPLINE_PATTERN).toBe(
      '(bg|text|border|ring)-(gray|slate|red|green|yellow|amber|orange|purple|violet|sky|blue)-[0-9]'
    );
  });

  it('drops empty lines so a trailing newline is not a violation', () => {
    expect(filterGitGrepLines(['src/app/page.tsx:1:bg-sky-50', ''])).toEqual([
      'src/app/page.tsx:1:bg-sky-50',
    ]);
  });
});
