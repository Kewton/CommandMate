/**
 * `src/lib/tmux/**` may only be reached through the sanctioned gateways (Issue #1922).
 *
 * ## What this pins
 *
 * `.eslintrc.json` carries a `no-restricted-imports` rule that makes a direct
 * import of the tmux modules an **error**, plus an `overrides` allowlist of the
 * files that already do it. §4 D4 of `docs/design/multi-agent-state-architecture.md`
 * says that allowlist may only ever **shrink** — #1905 and #1906 each delete a line
 * from it — so the interesting property is not "the rule exists" but "the exact set
 * of exempt files is this one".
 *
 * The lists below are that pin. Editing `.eslintrc.json` without editing this file
 * turns the suite red, and the only edit this file should ever receive is a
 * **deletion** from `STAGED_REMOVAL`.
 *
 * ## Why the guard is re-run here instead of trusted
 *
 * Three ways this guard could exist and still guard nothing, all of them measured
 * on this branch rather than assumed:
 *
 * 1. **`npm run lint` only looks at `src`** (`package.json`), so nothing in ESLint
 *    can hold the allowlist to a count. The count lives here.
 * 2. **`overrides.files` is matched with minimatch.** A literal Next.js dynamic
 *    segment written as `src/app/api/worktrees/[id]/route.ts` is a *character
 *    class* and matches `.../i/route.ts` — not the real directory. Five of the 31
 *    entries have `[id]` in them; unescaped, they would silently stop exempting
 *    their file and lint would go red on day one. They are escaped as `\[id\]`.
 * 3. **ESLint 8's core `no-restricted-imports` never sees `await import()` or
 *    `require()`** (DR4-005 — re-measured here: the fixtures below prove the
 *    `no-restricted-syntax` selectors, not the import rule, are what catch them).
 *
 * So every assertion that matters is made by running ESLint over real text and
 * looking at what it reports, with the fixtures that must be caught and the
 * fixtures that must *not* be caught spelled out side by side.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import { createRequire } from 'module';
import { ESLint, type Linter } from 'eslint';

const REPO_ROOT = process.cwd();
const ESLINTRC = join(REPO_ROOT, '.eslintrc.json');
const require_ = createRequire(import.meta.url);

/**
 * Gateway implementations. These are the modules the rest of the codebase is
 * supposed to go *through*, so they are exempt by directory and are never counted
 * as debt.
 */
const GATEWAY_GLOBS = ['src/lib/tmux/**', 'src/lib/cli-tools/**'];

/**
 * 恒久除外 — permanent. No `ICLITool` method (and no `captureSessionOutput` path)
 * corresponds to what these files do, so they are not expected to reach zero.
 * They are excluded from the progress metric.
 */
const PERMANENT_EXEMPT = [
  'src/app/api/assistant/conversation/route.ts',
  'src/app/api/assistant/current-output/route.ts',
  'src/app/api/assistant/session/route.ts',
  'src/app/api/assistant/start/route.ts',
  'src/app/api/assistant/terminal/route.ts',
  'src/app/api/worktrees/[id]/route.ts',
  'src/app/api/worktrees/route.ts',
  'src/cli/commands/capture.ts',
  'src/lib/session/cli-session.ts',
  'src/lib/session/current-output-builder.ts',
  'src/lib/session/worktree-session-reconcile.ts',
  'src/lib/ws-server.ts',
] as const;

/**
 * 段階解消 — staged removal. This list, and only this list, is the progress
 * metric for Epic #1891. Entries leave it as the corresponding call site moves
 * onto `ICLITool` / `captureSessionOutput`; nothing is ever added.
 */
const STAGED_REMOVAL = [
  'src/app/api/worktrees/[id]/capture/route.ts',
  'src/app/api/worktrees/[id]/clear-composer/route.ts',
  'src/app/api/worktrees/[id]/kill-session/route.ts',
  'src/app/api/worktrees/[id]/special-keys/route.ts',
  'src/app/api/worktrees/[id]/terminal/route.ts',
  'src/app/worktrees/[id]/terminal/page.tsx',
  'src/components/Terminal.tsx',
  'src/lib/auto-yes-poller.ts',
  'src/lib/pasted-text-helper.ts',
  'src/lib/polling/assistant-conversation-poller.ts',
  'src/lib/polling/global-session-poller.ts',
  'src/lib/polling/response-checker.ts',
  'src/lib/prompt-answer-sender.ts',
  'src/lib/realtime/terminal-broadcast.ts',
  'src/lib/session-cleanup.ts',
  'src/lib/session-key-sender.ts',
  'src/lib/session/claude-session.ts',
  'src/lib/session/composer-clear.ts',
  'src/lib/session/send-user-message.ts',
] as const;

const ALLOWLIST = [...PERMANENT_EXEMPT, ...STAGED_REMOVAL].slice().sort();

// --------------------------------------------------------------------------
// .eslintrc.json access
// --------------------------------------------------------------------------

interface EslintOverride {
  files: string[];
  rules?: Record<string, unknown>;
}

interface EslintRcShape {
  rules: Record<string, unknown>;
  overrides: EslintOverride[];
}

/**
 * ESLint parses `.eslintrc.json` through `strip-json-comments`, so the file is
 * allowed to carry `//` section labels and `JSON.parse` alone would throw on it.
 * Only whole-line comments are written there, which is all this strips.
 */
function readEslintRc(): EslintRcShape {
  const raw = readFileSync(ESLINTRC, 'utf-8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as EslintRcShape;
}

/** `overrides.files` escapes `[` and `]` for minimatch; paths on disk do not. */
function unescapeGlob(pattern: string): string {
  return pattern.replace(/\\([[\]])/g, '$1');
}

const rc = readEslintRc();

// --------------------------------------------------------------------------
// Programmatic ESLint, deliberately reading the repo's real rule config
// --------------------------------------------------------------------------

/**
 * Only the tmux selectors, so a scan over `src` is not drowned out by the i18n
 * selector that shares the `no-restricted-syntax` key. The severity and the
 * presence of both selectors in the real config is asserted separately.
 */
function tmuxSyntaxSelectors(): unknown[] {
  const entry = rc.rules['no-restricted-syntax'] as unknown[];
  return entry
    .slice(1)
    .filter((s) => /tmux/.test(JSON.stringify(s)));
}

/**
 * A minimal ESLint that carries the repo's real `no-restricted-imports` config,
 * the real tmux selectors and the real overrides — but none of the `next/*`
 * presets, so a scan costs a parse per file instead of a full lint.
 */
function makeEslint(options: { withAllowlist: boolean }): ESLint {
  const overrides = options.withAllowlist
    ? rc.overrides
    : rc.overrides.filter((o) => o.files.join('|') === GATEWAY_GLOBS.join('|'));

  const baseConfig = {
    root: true,
    parser: require_.resolve('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    },
    rules: {
      'no-restricted-imports': rc.rules['no-restricted-imports'],
      // Severity comes from the shipped config too: a downgrade to `warn` has to
      // show up here as a failing positive control, not only as a failing pin.
      'no-restricted-syntax': [(rc.rules['no-restricted-syntax'] as unknown[])[0], ...tmuxSyntaxSelectors()],
    },
    overrides,
  } as unknown as Linter.Config;

  return new ESLint({ useEslintrc: false, cwd: REPO_ROOT, baseConfig });
}

const TMUX_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

async function lintOne(eslint: ESLint, filePath: string, text: string): Promise<string[]> {
  const results = await eslint.lintText(text, { filePath });
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId !== null && TMUX_RULES.has(m.ruleId))
    .map((m) => `${m.severity === 2 ? 'error' : 'warn'}:${m.ruleId}`);
}

// --------------------------------------------------------------------------
// Source enumeration
// --------------------------------------------------------------------------

const LINTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
    } else if (LINTED_EXTENSIONS.some((e) => entry.endsWith(e))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Every linted source file whose text mentions `tmux` at all.
 *
 * This prefilter cannot hide a violation: an import specifier with a `tmux` path
 * segment necessarily contains the substring, so a file without it cannot import
 * one. It exists only so the scan parses ~1/6 of `src`.
 */
function candidateSources(): { rel: string; text: string }[] {
  return walk(join(REPO_ROOT, 'src'))
    .map((abs) => ({ rel: relative(REPO_ROOT, abs).split(sep).join('/'), text: readFileSync(abs, 'utf-8') }))
    .filter((f) => f.text.includes('tmux'))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

// --------------------------------------------------------------------------
// Re-export detection (§4 D4 (d))
// --------------------------------------------------------------------------

const REEXPORT_RE =
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z0-9_$]+)?|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;

/** A specifier points at the tmux modules iff one of its path segments is `tmux`. */
function isTmuxSpecifier(specifier: string): boolean {
  return specifier.split('/').includes('tmux');
}

function tmuxReexports(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REEXPORT_RE)) {
    if (isTmuxSpecifier(match[1])) found.push(match[1]);
  }
  return found;
}

// --------------------------------------------------------------------------

describe('lib/tmux import guard: ESLint configuration', () => {
  it('makes a direct tmux import an error, not a warning', () => {
    const entry = rc.rules['no-restricted-imports'] as [string, { patterns: { group: string[] }[] }];
    expect(entry[0]).toBe('error');
    expect(entry[1].patterns).toHaveLength(1);
  });

  it('forbids every spelling that reaches the tmux modules', () => {
    const entry = rc.rules['no-restricted-imports'] as [string, { patterns: { group: string[] }[] }];
    // The design doc named three spellings. `**/tmux/**` and `**/tmux` were added
    // after measuring that the three leave `../tmux/x` (how every file in
    // `src/lib/cli-tools/` already spells it) and the `src/lib/tmux/index.ts`
    // barrel wide open. See the positive controls below.
    expect(entry[1].patterns[0].group).toEqual([
      '@/lib/tmux/**',
      '**/lib/tmux/**',
      './tmux/**',
      '**/tmux/**',
      '**/tmux',
    ]);
  });

  it('runs no-restricted-syntax at error severity with both dynamic-access selectors', () => {
    const entry = rc.rules['no-restricted-syntax'] as [string, ...{ selector: string }[]];
    expect(entry[0]).toBe('error');

    const selectors = entry.slice(1).map((s) => (s as { selector: string }).selector);
    expect(selectors.some((s) => s.startsWith('ImportExpression['))).toBe(true);
    expect(selectors.some((s) => s.includes("callee.name='require'"))).toBe(true);
  });

  it('has no allowlist for the dynamic-access selectors', () => {
    // A `no-restricted-syntax` override would silently drop the i18n selector for
    // those files (DR2-005), so the dynamic form is kept at exactly zero instead.
    for (const override of rc.overrides) {
      expect(Object.keys(override.rules ?? {})).not.toContain('no-restricted-syntax');
    }
  });
});

describe('lib/tmux import guard: the allowlist', () => {
  it('is exactly 12 permanent + 19 staged files', () => {
    expect(PERMANENT_EXEMPT).toHaveLength(12);
    expect(STAGED_REMOVAL).toHaveLength(19);
    expect(ALLOWLIST).toHaveLength(31);
  });

  it('keeps the two groups sorted, deduplicated and disjoint', () => {
    for (const group of [PERMANENT_EXEMPT, STAGED_REMOVAL]) {
      const list = [...group];
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
    }
    const permanent = new Set<string>(PERMANENT_EXEMPT);
    expect(STAGED_REMOVAL.filter((p) => permanent.has(p))).toEqual([]);
  });

  it('matches .eslintrc.json entry for entry, in order', () => {
    const groups = rc.overrides.map((o) => o.files.map(unescapeGlob));
    expect(groups).toEqual([[...GATEWAY_GLOBS], [...PERMANENT_EXEMPT], [...STAGED_REMOVAL]]);
    for (const override of rc.overrides) {
      expect(override.rules?.['no-restricted-imports']).toBe('off');
    }
  });

  it('escapes the Next.js dynamic segments so minimatch matches the real directory', () => {
    // Unescaped, `[id]` is a character class: the entry would match `.../i/route.ts`
    // and stop exempting the file it names.
    const withBrackets = rc.overrides
      .flatMap((o) => o.files)
      .filter((f) => unescapeGlob(f).includes('[id]'));
    expect(withBrackets).toHaveLength(7);
    for (const pattern of withBrackets) {
      expect(pattern).toContain('\\[id\\]');
      expect(pattern).not.toMatch(/(^|[^\\])\[id\]/);
    }
  });

  it('names only files that exist and still import tmux', () => {
    for (const rel of ALLOWLIST) {
      const abs = join(REPO_ROOT, rel);
      expect(existsSync(abs), `${rel} is on the allowlist but not on disk`).toBe(true);
      expect(readFileSync(abs, 'utf-8').includes('tmux'), `${rel} no longer mentions tmux`).toBe(true);
    }
  });
});

describe('lib/tmux import guard: positive controls', () => {
  const eslint = makeEslint({ withAllowlist: true });
  // A file that is deliberately NOT on the allowlist, so the rule is live in it.
  const UNEXEMPT = join(REPO_ROOT, 'src/lib/session/index.ts');

  const caught: [string, string, string][] = [
    ['aliased static import', "import { sendKeys } from '@/lib/tmux/tmux';", 'no-restricted-imports'],
    ['relative static import', "import { sendKeys } from '../tmux/tmux';", 'no-restricted-imports'],
    ['barrel import', "import { hasSession } from '../tmux';", 'no-restricted-imports'],
    ['deep relative import', "import { x } from '../../lib/tmux/transcript-squeeze';", 'no-restricted-imports'],
    ['re-export', "export * from '@/lib/tmux/tmux';", 'no-restricted-imports'],
    ['dynamic import', "const f = () => import('@/lib/tmux/tmux');", 'no-restricted-syntax'],
    ['relative dynamic import', "const f = () => import('./tmux/tmux');", 'no-restricted-syntax'],
    ['require', "const m = require('@/lib/tmux/tmux-capture-cache');", 'no-restricted-syntax'],
  ];

  it.each(caught)('reports %s as an error', async (_label, source, ruleId) => {
    expect(await lintOne(eslint, UNEXEMPT, source)).toEqual([`error:${ruleId}`]);
  });

  const ignored: [string, string][] = [
    ['a config module that merely has tmux in its name', "import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';"],
    ['a sibling of the tmux modules', "import { invalidateCache } from './tmux-capture-cache';"],
    ['the session gateway', "import { captureSessionOutput } from '@/lib/session/cli-session';"],
  ];

  it.each(ignored)('leaves %s alone', async (_label, source) => {
    expect(await lintOne(eslint, UNEXEMPT, source)).toEqual([]);
  });

  it('exempts an allowlisted file from the very import it flags elsewhere', async () => {
    const source = "import { killSession } from '@/lib/tmux/tmux';";
    const exempt = join(REPO_ROOT, 'src/app/api/worktrees/[id]/kill-session/route.ts');
    expect(await lintOne(eslint, exempt, source)).toEqual([]);
    expect(await lintOne(eslint, UNEXEMPT, source)).toEqual(['error:no-restricted-imports']);
  });

  it('reports the dynamic form through no-restricted-syntax even inside an allowlisted file', async () => {
    // The allowlist only turns off `no-restricted-imports`; the dynamic selectors
    // have no exemption anywhere, which is the whole point of splitting them.
    const exempt = join(REPO_ROOT, 'src/lib/session/cli-session.ts');
    expect(await lintOne(eslint, exempt, "const f = () => import('@/lib/tmux/tmux');")).toEqual([
      'error:no-restricted-syntax',
    ]);
  });
});

describe('lib/tmux import guard: the whole of src', () => {
  it('reports nothing today', async () => {
    const eslint = makeEslint({ withAllowlist: true });
    const offenders: string[] = [];
    for (const file of candidateSources()) {
      if ((await lintOne(eslint, join(REPO_ROOT, file.rel), file.text)).length > 0) offenders.push(file.rel);
    }
    expect(offenders).toEqual([]);
  }, 120_000);

  it('reports exactly the allowlisted files once the allowlist is removed', async () => {
    // The acceptance criterion from §4 D4: a pattern set that catches fewer files
    // than the allowlist names has a silent hole the size of the difference.
    const eslint = makeEslint({ withAllowlist: false });
    const offenders: string[] = [];
    for (const file of candidateSources()) {
      if ((await lintOne(eslint, join(REPO_ROOT, file.rel), file.text)).length > 0) offenders.push(file.rel);
    }
    expect(offenders.sort()).toEqual(ALLOWLIST);
  }, 120_000);
});

describe('lib/tmux import guard: re-export leaks', () => {
  it('detects a tmux re-export (control for the detector itself)', () => {
    expect(tmuxReexports("export * from './tmux/tmux'")).toEqual(['./tmux/tmux']);
    expect(tmuxReexports("export { sendKeys } from '@/lib/tmux/tmux'")).toEqual(['@/lib/tmux/tmux']);
    expect(tmuxReexports("export type { NavigationKey } from '../tmux'")).toEqual(['../tmux']);
    expect(tmuxReexports("export * from './tmux-capture-cache'")).toEqual([]);
    expect(tmuxReexports("export * from '@/config/tmux-pane-config'")).toEqual([]);
  });

  it('finds no allowlisted module re-exporting a tmux symbol', () => {
    // An allowlisted module has the import rule switched off, so anything it
    // re-exports is reachable from anywhere with a specifier the rule cannot see.
    for (const rel of ALLOWLIST) {
      expect(tmuxReexports(readFileSync(join(REPO_ROOT, rel), 'utf-8')), rel).toEqual([]);
    }
  });

  it('keeps the session barrel on explicit named re-exports', () => {
    // `export * from './claude-session'` would re-open the leak above the moment
    // `claude-session.ts` grows a tmux re-export, and the diff would not show it.
    const barrel = readFileSync(join(REPO_ROOT, 'src/lib/session/index.ts'), 'utf-8');
    expect(barrel).not.toMatch(/^\s*export\s+\*/m);
  });
});

describe('lib/tmux import guard: dynamic access stays at zero', () => {
  it('has no dynamic import or require of a tmux module anywhere in src', () => {
    // Duplicated on purpose (DR4-005 (b)): editing `.eslintrc.json` alone must not
    // be enough to make the dynamic form legal again.
    const patterns = [/\bimport\s*\(\s*['"`]([^'"`]+)/g, /\brequire\s*\(\s*['"`]([^'"`]+)/g];
    const offenders: string[] = [];
    for (const file of candidateSources()) {
      if (file.rel.startsWith('src/lib/tmux/') || file.rel.startsWith('src/lib/cli-tools/')) continue;
      for (const re of patterns) {
        for (const match of file.text.matchAll(re)) {
          if (isTmuxSpecifier(match[1])) offenders.push(`${file.rel}: ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
