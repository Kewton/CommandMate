/**
 * Tests for the token-discipline guard (Issue #1082 / #1116 / #1882 / #1889).
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
 * #1889 added the second check — the token being referenced has to EXIST — and
 * with it a second, larger risk: a guard that reads every class name in the
 * migrated directories can just as easily fail on a correct one. So the cases
 * below pin BOTH directions. The "does not fire" cases are not padding; they
 * are transcribed from a measurement of this repository, where every single
 * false positive of a naive implementation turned out to be either a Tailwind
 * built-in utility or an ordinary English sentence in a comment.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GUARDED_PATHSPECS,
  TOKEN_DISCIPLINE_PATTERN,
  classifyColorUtility,
  filterGitGrepLines,
  findTokenDisciplineViolations,
  findUnknownTokenViolations,
  formatUnknownTokenViolation,
  readColorTokens,
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

/* ==========================================================================
 * Issue #1889: the token being referenced has to exist.
 * ========================================================================== */

interface UnknownTokenViolation {
  file: string;
  line: number;
  utility: string;
}

const scanUnknown = (root: string): UnknownTokenViolation[] =>
  findUnknownTokenViolations(root) as UnknownTokenViolation[];

describe('Issue #1889: the repository itself references no token that is missing', () => {
  it('is clean, so this guard does not fail its own commit', () => {
    expect(scanUnknown(REPO_ROOT)).toEqual([]);
  });
});

describe('Issue #1889: unknown token names', () => {
  let root: string;
  let violations: UnknownTokenViolation[];
  const utilitiesIn = (file: string): string[] =>
    violations.filter((v) => v.file === file).map((v) => v.utility);

  /**
   * One fixture repository, with the REAL `globals.css` copied in: the point of
   * the check is the comparison against the tokens this project actually
   * declares, and a hand-written stub would only prove the fixture consistent
   * with itself.
   */
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-exists-')));
    execFileSync('git', ['init', '-q'], { cwd: root });

    const write = (relative: string, contents: string): void => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    };

    fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'src/app/globals.css'),
      path.join(root, 'src/app/globals.css')
    );

    // Typos: exactly what #1889 exists to catch. Every one of these passes the
    // raw-palette check, and Tailwind emits nothing for them.
    write(
      'src/components/ui/Typo.tsx',
      [
        'export const a = "bg-surface-elevated-typo";',
        'export const b = "text-info-forground";',
        'export const c = "hover:bg-mutedd focus-visible:ring-rng";',
        'export const d = "border-t-danger-bordr";',
      ].join('\n') + '\n'
    );

    // A multi-line `className` template literal: the lines in the middle carry
    // no quote of their own, so anything that only inspected quoted regions of
    // a single line would miss this.
    write(
      'src/components/home/Multiline.tsx',
      [
        'export const cls = `',
        '  flex items-center',
        '  bg-surface-doesnt-exist',
        '`;',
      ].join('\n') + '\n'
    );

    // Real tokens (the acceptance list) must survive untouched.
    write(
      'src/components/ui/Valid.tsx',
      'export const c = "bg-info-subtle text-info-foreground bg-surface hover:bg-muted ring-ring ' +
        'ring-offset-background bg-surface-2 text-muted-foreground border-sidebar-border ' +
        'dark:bg-muted/40 border-t-accent-600 text-surface-foreground bg-warning-subtle";\n'
    );

    // Tailwind built-ins, taken verbatim from the #1889 measurement.
    write(
      'src/components/ui/Builtins.tsx',
      'export const c = "text-center text-xs text-base text-lg text-current text-left ' +
        'border-b border-b-0 border-b-2 border-l border-l-2 border-l-4 border-2 border-dashed ' +
        'bg-gradient-to-b bg-gradient-to-br bg-none bg-transparent bg-black bg-white ' +
        'ring-offset-2 ring-inset border-collapse border-none text-white text-nowrap ' +
        'bg-cover bg-center bg-no-repeat bg-clip-text bg-blend-multiply border-separate";\n'
    );

    // Prose. The rest of the #1889 measurement was English in comments; an
    // ordinary sentence must not be able to fail CI.
    write(
      'src/components/common/Prose.tsx',
      [
        '/**',
        ' * A text-entry context, the border-trick spinner, and text-and- a wrap.',
        ' */',
        '/*',
        'A block comment continuation line with no leading asterisk: bg-not-a-token.',
        '*/',
        '// A plain-text-only note mentioning bg-also-not-a-token.',
        'export const c = "bg-surface"; // trailing note about text-nonexistent',
        '{/* JSX comment: border-imaginary */}',
      ].join('\n') + '\n'
    );

    // CSS property names are not class names. `text-align:` and friends showed
    // up in the measurement purely because they share the prefix.
    write(
      'src/app/declarations.css',
      [
        '.probe {',
        '  text-align: left;',
        '  text-decoration: underline;',
        '  text-overflow: ellipsis;',
        '  border-radius: 2px;',
        '  border-left: 3px solid rgb(var(--border));',
        '  border-top: 1px solid rgb(var(--border));',
        '  border-color: var(--color-gray-200, currentcolor);',
        '  border-collapse: collapse;',
        '}',
        '.applied {',
        '  @apply text-lg md:text-xl bg-surface;',
        '}',
      ].join('\n') + '\n'
    );

    // `@apply` is a class-name context too, so a typo there is caught.
    write('src/app/applied.css', '.card {\n  @apply bg-surface-nope text-foreground;\n}\n');

    // A URL path segment is not a class name. `/` is legal at the END of a
    // candidate (the opacity modifier) but never at the start of one.
    write(
      'src/components/ui/Urls.tsx',
      'export const href = "https://example.com/docs/text-formatting/bg-hero";\n'
    );

    // Documented blind spots: nothing is reported for these.
    write(
      'src/components/ui/Dynamic.tsx',
      [
        'export const a = (tone: string) => `bg-${tone}-subtle`;',
        'export const b = (g: string) => `text-input-${g}`;',
        'export const c = "bg-[#123456] text-[11px] border-[var(--x)]";',
        'export const d = "data-[state=active]:border-accent-500";',
      ].join('\n') + '\n'
    );

    // The shared exclusions apply to this check too.
    write('src/components/worktree/MyTerminalView.tsx', 'const c = "bg-terminal-typo";\n');
    write('src/components/ui/Badge.test.tsx', 'expect(c).toBe("bg-test-typo");\n');
    write('src/app/worktrees/[id]/page.tsx', 'const c = "bg-worktrees-typo";\n');
    write('src/lib/theme.ts', 'export const c = "bg-unguarded-typo";\n');
    // Not a scanned extension.
    write('src/app/notes.md', 'A markdown note about bg-markdown-typo.\n');

    execFileSync('git', ['add', '-A'], { cwd: root });
    violations = scanUnknown(root);
  });

  afterAll(() => {
    removeTempDir(root);
  });

  it('catches a token name that does not exist in globals.css', () => {
    expect(utilitiesIn('src/components/ui/Typo.tsx')).toEqual([
      'bg-surface-elevated-typo',
      'text-info-forground',
      'bg-mutedd',
      'ring-rng',
      'border-t-danger-bordr',
    ]);
  });

  it('sees inside a multi-line className template literal', () => {
    expect(violations).toContainEqual({
      file: 'src/components/home/Multiline.tsx',
      line: 3,
      utility: 'bg-surface-doesnt-exist',
    });
  });

  it('reports path:line: class, so a violation is addressable', () => {
    const first = violations.find((v) => v.utility === 'bg-surface-elevated-typo');
    expect(formatUnknownTokenViolation(first)).toBe(
      'src/components/ui/Typo.tsx:1: bg-surface-elevated-typo'
    );
  });

  it('passes every token that really is declared', () => {
    expect(utilitiesIn('src/components/ui/Valid.tsx')).toEqual([]);
  });

  it('passes the Tailwind built-ins measured on this repository', () => {
    expect(utilitiesIn('src/components/ui/Builtins.tsx')).toEqual([]);
  });

  it('does not turn an English comment into a CI failure', () => {
    expect(utilitiesIn('src/components/common/Prose.tsx')).toEqual([]);
  });

  it('does not read a CSS declaration as a class name', () => {
    expect(utilitiesIn('src/app/declarations.css')).toEqual([]);
  });

  it('checks `@apply`, which is a class-name context', () => {
    expect(utilitiesIn('src/app/applied.css')).toEqual(['bg-surface-nope']);
  });

  it('does not read a URL path segment as a class name', () => {
    expect(utilitiesIn('src/components/ui/Urls.tsx')).toEqual([]);
  });

  it('stays silent on dynamic names and arbitrary values (the documented blind spots)', () => {
    expect(utilitiesIn('src/components/ui/Dynamic.tsx')).toEqual([]);
  });

  it('keeps the *Terminal* / test / worktrees exclusions of the first check', () => {
    const files = violations.map((v) => v.file);
    expect(files).not.toContain('src/components/worktree/MyTerminalView.tsx');
    expect(files).not.toContain('src/components/ui/Badge.test.tsx');
    expect(files).not.toContain('src/app/worktrees/[id]/page.tsx');
  });

  it('does not reach outside the guarded list, or into unscanned extensions', () => {
    const files = violations.map((v) => v.file);
    expect(files).not.toContain('src/lib/theme.ts');
    expect(files).not.toContain('src/app/notes.md');
  });
});

describe('Issue #1889: classification of a single utility', () => {
  const tokens = readColorTokens(REPO_ROOT) as Set<string>;

  it('reads the 42 color tokens out of globals.css, and no `var()` use', () => {
    expect(tokens.has('info-subtle')).toBe(true);
    expect(tokens.has('surface-2')).toBe(true);
    expect(tokens.has('accent-950')).toBe(true);
    // `border-color: var(--color-gray-200, currentcolor)` is a USE, not a
    // declaration; picking it up would whitelist a raw palette step.
    expect(tokens.has('gray-200')).toBe(false);
  });

  const cases: readonly [string, string][] = [
    // Project tokens.
    ['bg-info-subtle', 'token'],
    ['text-info-foreground', 'token'],
    ['bg-surface', 'token'],
    ['bg-muted', 'token'],
    ['ring-ring', 'token'],
    ['ring-offset-background', 'token'],
    ['border-t-accent-600', 'token'],
    ['bg-surface-2', 'token'],
    // Tailwind built-in colors — check 1's business, not this one's.
    ['text-white', 'palette'],
    ['bg-black', 'palette'],
    ['border-transparent', 'palette'],
    ['text-current', 'palette'],
    ['text-pink-500', 'palette'],
    ['bg-neutral-900', 'palette'],
    // Tailwind built-in non-color utilities.
    ['text-center', 'builtin'],
    ['text-xs', 'builtin'],
    ['text-base', 'builtin'],
    ['border-b-0', 'builtin'],
    ['border-l-4', 'builtin'],
    ['border-dashed', 'builtin'],
    ['border-collapse', 'builtin'],
    ['border-none', 'builtin'],
    ['bg-gradient-to-br', 'builtin'],
    ['bg-none', 'builtin'],
    ['ring-offset-2', 'builtin'],
    ['ring-inset', 'builtin'],
    // Typos.
    ['bg-surface-elevated-typo', 'unknown'],
    ['text-info-forground', 'unknown'],
    ['bg-card', 'unknown'],
    // Not one of the four guarded prefixes.
    ['from-accent-500', 'skip'],
  ];

  it.each(cases)('classifies %s as %s', (utility, verdict) => {
    expect(classifyColorUtility(utility, tokens)).toBe(verdict);
  });
});

describe('Issue #1889: a guard that cannot run does not report clean', () => {
  it('throws when globals.css is missing', () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-none-')));
    try {
      expect(() => readColorTokens(empty)).toThrow(/could not be read/);
    } finally {
      removeTempDir(empty);
    }
  });

  it('throws when globals.css declares no --color-* token', () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-bare-')));
    try {
      fs.mkdirSync(path.join(bare, 'src/app'), { recursive: true });
      fs.writeFileSync(path.join(bare, 'src/app/globals.css'), 'body { color: red; }\n');
      expect(() => readColorTokens(bare)).toThrow(/declares no --color-\* tokens/);
    } finally {
      removeTempDir(bare);
    }
  });
});

describe('Issue #1889: the CLI runs both checks', () => {
  const SCRIPT = path.join(REPO_ROOT, 'scripts/check-token-discipline.mjs');

  const run = (root: string): { status: number; stderr: string; stdout: string } => {
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
    return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
  };

  it('exits non-zero and names the offending class for an unknown token', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-cli-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
      fs.copyFileSync(
        path.join(REPO_ROOT, 'src/app/globals.css'),
        path.join(root, 'src/app/globals.css')
      );
      fs.writeFileSync(
        path.join(root, 'src/components/ui/Card.tsx'),
        'export const c = "bg-surface-elevated-typo";\n'
      );
      execFileSync('git', ['add', '-A'], { cwd: root });

      const failing = run(root);
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain('Issue #1889');
      expect(failing.stderr).toContain('bg-surface-elevated-typo');

      // The same tree with the token spelled correctly passes.
      fs.writeFileSync(
        path.join(root, 'src/components/ui/Card.tsx'),
        'export const c = "bg-surface";\n'
      );
      execFileSync('git', ['add', '-A'], { cwd: root });
      const passing = run(root);
      expect(passing.status).toBe(0);
      expect(passing.stdout).toContain('every color token referenced exists');
    } finally {
      removeTempDir(root);
    }
  });
});
