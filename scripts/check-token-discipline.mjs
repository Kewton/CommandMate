#!/usr/bin/env node
/**
 * Fails when a raw Tailwind color utility reappears in a directory that has
 * already been migrated to semantic tokens.
 *
 * [Issue #1082 / #1116] Migrated directories use tokens, not raw palette steps:
 *   - gray/slate  → neutral tokens (foreground / muted / muted-foreground /
 *                   border / surface / input / ring). (#1082, #1061)
 *   - chromatic (red/green/yellow/amber/orange/purple/violet/sky/blue)
 *                 → status tint tokens (bg-{status}-subtle /
 *                   border-{status}-border / text-{status}-foreground /
 *                   bg-{status}, status = success|warning|danger|info). (#1116)
 * Fix violations with the tokens in docs/design-system.md, NOT by widening the
 * lists below.
 *
 * [Issue #1882] This file is the SINGLE authority for the pattern, the guarded
 * directory list and the exclusions. `.github/workflows/ci-pr.yml` (job
 * `token-discipline`) and `.commandmate/verify.yaml` (gate `token-discipline`)
 * both run this script and hold no copy of the check, because the same guard
 * written twice is a guard that gets updated in one place and quietly diverges
 * in the other. Same shape as `scripts/check-control-chars.mjs`, which was
 * already the correct precedent in this repository.
 *
 * KNOWN LIMITATION (out of scope, recorded deliberately): the check only sees
 * the ABSENCE of raw palette utilities. Replacing `bg-sky-50` with a token name
 * that does not exist in `src/app/globals.css` still PASSES — the element just
 * renders unstyled. Cross-checking token names against the `--color-*` custom
 * properties would close that, and is not what this guard does today.
 *
 * Usage: node scripts/check-token-discipline.mjs [repoRoot]
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

/** Raw palette utilities that must not appear in a migrated directory. */
export const TOKEN_DISCIPLINE_PATTERN =
  '(bg|text|border|ring)-(gray|slate|red|green|yellow|amber|orange|purple|violet|sky|blue)-[0-9]';

/**
 * WHITELIST (guarded) = directories already migrated to semantic tokens.
 * #1061 added worktree/mobile/external-apps; #1116 added error/ + auth/.
 *
 * EXCLUDED: `src/app/worktrees/**` — the worktree detail route / terminal page,
 * including the CLI brand colors bg-purple-600 / bg-blue-600 / bg-green-600.
 */
export const GUARDED_PATHSPECS = [
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
];

/**
 * Test files are excluded because they assert on concrete class strings: a
 * suite that pins `bg-sky-50` as the expected output of something is not a
 * violation, it is the assertion.
 */
export const TEST_FILE_EXCLUDE = /\.test\.|\.spec\.|__tests__/;

/**
 * `*Terminal*` source files are excluded (incl. error/TerminalErrorFallback.tsx).
 *
 * DO NOT REMOVE. The terminal output surfaces stay dark in BOTH themes, matching
 * the fixed xterm theme (#1079) — they use raw dark utilities on purpose. Drop
 * this and every terminal component in the repository turns into a violation.
 *
 * Anchored at the start and stopped at the first `:` so it only ever inspects
 * the PATH field of a `path:line:content` grep line — a file whose *content*
 * mentions "Terminal" is not exempt.
 */
export const TERMINAL_FILE_EXCLUDE = /^[^:]*Terminal[^:]*:/;

/**
 * Apply the two exclusions to raw `git grep -n` output lines.
 *
 * Split out from the git call so the exclusions can be asserted directly:
 * `tests/unit/guards/token-discipline-guard.test.ts` feeds this synthetic lines
 * and checks that a `*Terminal*` path survives and a plain one does not.
 */
export function filterGitGrepLines(lines) {
  return lines.filter(
    (line) =>
      line.length > 0 && !TEST_FILE_EXCLUDE.test(line) && !TERMINAL_FILE_EXCLUDE.test(line)
  );
}

/**
 * @param root repository root to scan (defaults to this repository)
 * @returns the offending `path:line:content` lines, empty when clean
 * @throws when `git grep` itself failed (exit > 1) — a guard that could not run
 *         must not report "clean"
 */
export function findTokenDisciplineViolations(root) {
  const result = spawnSync(
    'git',
    ['grep', '-nE', TOKEN_DISCIPLINE_PATTERN, '--', ...GUARDED_PATHSPECS],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error) {
    throw new Error(`git grep could not be spawned: ${result.error.message}`);
  }
  // git grep: 0 = matches, 1 = no matches, >1 = failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git grep exited ${result.status}: ${(result.stderr || '').trim() || 'no stderr'}`
    );
  }
  return filterGitGrepLines((result.stdout || '').split('\n'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let violations;
  try {
    violations = findTokenDisciplineViolations(root);
  } catch (error) {
    console.error(`::error::Token discipline guard could not run — ${error.message}`);
    process.exit(2);
  }
  if (violations.length > 0) {
    console.error(
      '::error::Raw gray/slate or chromatic color utilities found in migrated directories (Issue #1082 / #1116). Replace with semantic tokens — see docs/design-system.md.'
    );
    for (const line of violations) console.error(line);
    process.exit(1);
  }
  console.log('Token discipline: no raw gray/slate or chromatic utilities in migrated directories.');
}
