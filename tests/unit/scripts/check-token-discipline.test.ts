/**
 * Tests for the token-discipline guard (Issue #1082 / #1116 / #1882 / #1889 / #1892).
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
 * #1892 widened the raw-palette check from 11 hand-picked families to Tailwind's
 * whole default palette, and the cases below pin the two things that failure
 * mode needs: that every family Tailwind ships is matched, and that the list is
 * compared against Tailwind's own `theme.css` rather than maintained by hand.
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
  TAILWIND_PALETTE_FAMILY_NAMES,
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

  it('is built from the palette list, so the pattern cannot be edited apart from it', () => {
    expect(TOKEN_DISCIPLINE_PATTERN).toBe(
      `(bg|text|border|ring)-((x|y|t|r|b|l|s|e|offset)-)?(${TAILWIND_PALETTE_FAMILY_NAMES.join(
        '|'
      )})-[0-9]`
    );
  });

  it('still matches the 11 families the CI job matched before #1892', () => {
    const pattern = new RegExp(TOKEN_DISCIPLINE_PATTERN);
    for (const family of 'gray slate red green yellow amber orange purple violet sky blue'.split(
      ' '
    )) {
      expect(pattern.test(`bg-${family}-500`)).toBe(true);
    }
  });

  it('drops empty lines so a trailing newline is not a violation', () => {
    expect(filterGitGrepLines(['src/app/page.tsx:1:bg-sky-50', ''])).toEqual([
      'src/app/page.tsx:1:bg-sky-50',
    ]);
  });
});

/* ==========================================================================
 * Issue #1892: the guarded palette is Tailwind's, not a hand-picked subset.
 * ========================================================================== */

/**
 * Tailwind's own palette, read out of the package rather than restated here.
 *
 * This is the anti-drift mechanism, and it is the reason `TAILWIND_PALETTE_
 * FAMILY_NAMES` may be a hard-coded array at all: the script itself has to run
 * on a checkout with no `npm install` (the CI job is one `run:` step), so it
 * cannot ask Tailwind — but the unit suite can, and does. A Tailwind upgrade
 * that adds a family fails HERE, at upgrade time, instead of silently widening
 * the hole #1892 exists to close.
 */
const tailwindPaletteFamilies = (): string[] => {
  const themeCss = path.join(REPO_ROOT, 'node_modules/tailwindcss/theme.css');
  if (!fs.existsSync(themeCss)) {
    throw new Error(
      `${themeCss} not found. Tailwind is a devDependency of this repository; if the ` +
        'package layout changed, update this test rather than deleting it — it is what ' +
        'keeps TAILWIND_PALETTE_FAMILY_NAMES from falling behind (#1892).'
    );
  }
  const families = new Set<string>();
  const css = fs.readFileSync(themeCss, 'utf8');
  for (const match of css.matchAll(/^[ \t]*--color-([a-z]+)-\d+[ \t]*:/gm)) families.add(match[1]);
  if (families.size === 0) {
    throw new Error(`${themeCss} declares no --color-<family>-<step>; the cross-check cannot run`);
  }
  return [...families].sort();
};

describe('Issue #1892: the palette list is cross-checked against Tailwind itself', () => {
  it('enumerates exactly the families Tailwind ships', () => {
    expect([...TAILWIND_PALETTE_FAMILY_NAMES].sort()).toEqual(tailwindPaletteFamilies());
  });

  it('includes the families Tailwind 4.3 added, which the #1116 list predates', () => {
    expect(TAILWIND_PALETTE_FAMILY_NAMES).toEqual(
      expect.arrayContaining(['mauve', 'olive', 'mist', 'taupe'])
    );
  });

  it('matches a raw step of every family, so no family is enumerated but unmatched', () => {
    const pattern = new RegExp(TOKEN_DISCIPLINE_PATTERN);
    for (const family of TAILWIND_PALETTE_FAMILY_NAMES) {
      expect(pattern.test(`bg-${family}-500`)).toBe(true);
      expect(pattern.test(`text-${family}-50`)).toBe(true);
      expect(pattern.test(`border-${family}-950`)).toBe(true);
      expect(pattern.test(`ring-${family}-300`)).toBe(true);
    }
  });

  /**
   * `border-t-cyan-500` is a raw palette color that the bare
   * `<prefix>-<family>-<step>` shape walks past. Check 2 already called it a
   * palette color, so before #1892 the two checks disagreed about one class —
   * and `FileTreeView`'s spinner was sitting in the gap.
   */
  it('matches a color hidden behind a side or offset segment', () => {
    const pattern = new RegExp(TOKEN_DISCIPLINE_PATTERN);
    expect(pattern.test('border-t-cyan-500')).toBe(true);
    expect(pattern.test('border-b-2')).toBe(false);
    expect(pattern.test('border-l-teal-400')).toBe(true);
    expect(pattern.test('ring-offset-slate-900')).toBe(true);
    expect(pattern.test('ring-offset-2')).toBe(false);
    expect(pattern.test('border-t-accent-500')).toBe(false);
  });

  it('leaves the documented out-of-scope shapes alone', () => {
    const pattern = new RegExp(TOKEN_DISCIPLINE_PATTERN);
    // No palette step: `text-white` on a token-backed surface is legitimate and
    // is explicitly out of scope for #1892.
    expect(pattern.test('text-white')).toBe(false);
    expect(pattern.test('bg-black')).toBe(false);
    // Arbitrary values, and the tokens the fixes above use.
    expect(pattern.test('bg-[#123456]')).toBe(false);
    expect(pattern.test('bg-surface')).toBe(false);
    expect(pattern.test('text-accent-500')).toBe(false);
    expect(pattern.test('bg-terminal-surface')).toBe(false);
    expect(pattern.test('text-terminal-foreground')).toBe(false);
  });
});

/**
 * The raw palette occurrences that survived on develop, verbatim and at their
 * real paths. With the 11-family list of #1116 the guard read this exact tree
 * and exited 0 — "no raw palette utilities" — which is the regression #1892
 * fixes. Note that none of the three paths is `*Terminal*`, so none of them is
 * reachable by the always-dark exemption.
 */
const DEVELOP_SURVIVORS: readonly (readonly [string, string])[] = [
  [
    'src/components/worktree/TreeNode.tsx',
    "      css: 'text-pink-500',\n      scss: 'text-pink-500',\n",
  ],
  [
    'src/components/worktree/VerificationPane.tsx',
    '              <pre className="max-h-64 overflow-auto rounded bg-neutral-900 p-2 ' +
      'font-mono text-[11px] leading-relaxed text-neutral-100">\n',
  ],
  [
    'src/components/worktree/git/gitPaneShared.tsx',
    "  untracked: 'text-teal-600 dark:text-teal-400',\n",
  ],
  // The fifth occurrence, which the Issue did not list: a palette color behind
  // a side segment, invisible to the widened palette alone.
  [
    'src/components/worktree/FileTreeView.tsx',
    '                className="w-3 h-3 border-2 border-input border-t-cyan-500 ' +
      'rounded-full animate-spin"\n',
  ],
];

/** The tokens those lines were replaced with. */
const REPLACEMENTS: readonly (readonly [string, string])[] = [
  [
    'src/components/worktree/TreeNode.tsx',
    "      css: 'text-accent-500',\n      scss: 'text-accent-500',\n",
  ],
  [
    'src/components/worktree/VerificationPane.tsx',
    '              <pre className="max-h-64 overflow-auto rounded bg-terminal-surface p-2 ' +
      'font-mono text-[11px] leading-relaxed text-terminal-foreground">\n',
  ],
  [
    'src/components/worktree/git/gitPaneShared.tsx',
    "  untracked: 'text-accent-600 dark:text-accent-400',\n",
  ],
  [
    'src/components/worktree/FileTreeView.tsx',
    '                className="w-3 h-3 border-2 border-input border-t-accent-500 ' +
      'rounded-full animate-spin"\n',
  ],
];

describe('Issue #1892: the occurrences that develop reported as clean', () => {
  const SCRIPT = path.join(REPO_ROOT, 'scripts/check-token-discipline.mjs');
  let root: string;

  const plant = (entries: readonly (readonly [string, string])[]): void => {
    for (const [relative, contents] of entries) {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents);
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-1892-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    // The real globals.css: the CLI runs check 2 as well, and check 2 needs the
    // declared tokens (it exits 2 rather than judging without them).
    fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'src/app/globals.css'),
      path.join(root, 'src/app/globals.css')
    );
    plant(DEVELOP_SURVIVORS);
  });

  afterAll(() => {
    removeTempDir(root);
  });

  it('reports every one of them, at the lines they were on', () => {
    expect(scan(root)).toEqual([
      'src/components/worktree/FileTreeView.tsx:1:                className="w-3 h-3 border-2 ' +
        'border-input border-t-cyan-500 rounded-full animate-spin"',
      "src/components/worktree/TreeNode.tsx:1:      css: 'text-pink-500',",
      "src/components/worktree/TreeNode.tsx:2:      scss: 'text-pink-500',",
      'src/components/worktree/VerificationPane.tsx:1:              <pre className="max-h-64 ' +
        'overflow-auto rounded bg-neutral-900 p-2 font-mono text-[11px] leading-relaxed ' +
        'text-neutral-100">',
      "src/components/worktree/git/gitPaneShared.tsx:1:  untracked: 'text-teal-600 dark:text-teal-400',",
    ]);
  });

  it('exits non-zero on them, and zero once they are tokens', () => {
    const run = (): { status: number; stderr: string; stdout: string } => {
      const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
      return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
    };

    const failing = run();
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('text-pink-500');
    expect(failing.stderr).toContain('bg-neutral-900');
    expect(failing.stderr).toContain('text-neutral-100');
    expect(failing.stderr).toContain('text-teal-600');
    expect(failing.stderr).toContain('border-t-cyan-500');

    // The same three files, with the tokens this Issue replaced them with. The
    // pass proves the replacements resolve too: `terminal-surface` and
    // `terminal-foreground` have to exist in globals.css or check 2 fails here.
    plant(REPLACEMENTS);
    const passing = run();
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain('no raw Tailwind palette utilities');
  });
});

describe('Issue #1892: families the #1116 list left out', () => {
  /**
   * The families named in the Issue, plus the four Tailwind 4.3 additions.
   * Every one of them was invisible to the guard before this change.
   */
  const NEWLY_COVERED = [
    'neutral',
    'zinc',
    'stone',
    'pink',
    'rose',
    'fuchsia',
    'indigo',
    'cyan',
    'teal',
    'emerald',
    'lime',
    'mauve',
    'olive',
    'mist',
    'taupe',
  ];
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-families-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const full = path.join(root, 'src/components/ui/Palette.tsx');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full,
      NEWLY_COVERED.map((family) => `export const ${family} = "bg-${family}-500";`).join('\n') + '\n'
    );
    // The exemptions have to keep working on the widened palette too, or #1892
    // turns every terminal component into a violation at once.
    fs.writeFileSync(
      path.join(root, 'src/components/ui/MyTerminalView.tsx'),
      'const c = "bg-neutral-900 text-neutral-100";\n'
    );
    fs.writeFileSync(
      path.join(root, 'src/components/ui/Palette.test.tsx'),
      'expect(c).toBe("bg-teal-600");\n'
    );
    fs.mkdirSync(path.join(root, 'src/app/worktrees'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/app/worktrees/page.tsx'), 'const c = "bg-cyan-600";\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
  });

  afterAll(() => {
    removeTempDir(root);
  });

  it.each(NEWLY_COVERED)('catches a raw %s step', (family) => {
    expect(scan(root).some((line) => line.includes(`bg-${family}-500`))).toBe(true);
  });

  it('keeps the *Terminal* / test / worktrees exemptions on the widened palette', () => {
    expect([...new Set(filesOf(root))]).toEqual(['src/components/ui/Palette.tsx']);
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

  it('reads the color tokens out of globals.css, and no `var()` use', () => {
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
