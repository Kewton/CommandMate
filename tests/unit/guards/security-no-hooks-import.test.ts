/**
 * `src/lib/security/**` must not import `src/lib/hooks/**` (Issue #1996).
 *
 * ## What this protects
 *
 * The dependency between the two packages already runs one way:
 * `hooks/agent-event-service`, `hooks/sources/copilot/hook-settings` and
 * `hooks/sources/codex/hooks-config` all import `lib/security/path-validator`.
 * Inverting it — even for one array of strings — would put a package cycle
 * underneath four child-process spawners and drag `hook-settings-generator`'s
 * fs/crypto/logger graph in behind it.
 *
 * #1942 measured those three edges and chose a prefix rule so that
 * `env-sanitizer` would need no import at all. #1996 replaced the prefix with a
 * prefix **plus an enumeration**, which makes the temptation concrete: the
 * enumeration is a second copy of a list `lib/hooks/sources/launch-command`
 * also declares, and the obvious way to remove a duplicated list is to import
 * it. That is the edit this file exists to stop. The lists are joined by
 * `tests/unit/security/child-process-agent-env-1996.test.ts` instead.
 *
 * ## Why a test rather than a `no-restricted-imports` entry
 *
 * `npm run lint` runs over `src` and would catch a static `import`, but ESLint 8's
 * core rule sees neither `await import()` nor `require()` (§10.11 of
 * `docs/design/multi-agent-state-architecture.md`, re-measured in
 * `tmux-import-allowlist.test.ts`). A text rule that covers all three forms is
 * one file, needs no allowlist, and fails in the job whose job it is.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();

/**
 * Any way a module can name another one: `import … from`, `export … from`,
 * `import(…)` and `require(…)`, with either quote style.
 */
const REACHES_HOOKS =
  /(?:from|import|require)\s*\(?\s*['"](?:@\/lib\/hooks|\.\.\/hooks|\.\.\/\.\.\/lib\/hooks)[/'"]/;

/** Tracked `.ts` files under one directory. Untracked scratch files are not the repo. */
function trackedTsFilesUnder(dir: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', dir], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\0')
    .filter((f) => f.endsWith('.ts'));
}

describe('lib/security does not depend on lib/hooks (Issue #1996)', () => {
  const securityFiles = trackedTsFilesUnder('src/lib/security');

  it('finds the directory at all (guards against a broken glob)', () => {
    expect(securityFiles.length).toBeGreaterThan(4);
  });

  it('matches a real import line, so a clean result means something', () => {
    // The predicate proved non-vacuous against the four spellings it claims to
    // cover, and against a line it must NOT flag.
    expect(REACHES_HOOKS.test("import { X } from '@/lib/hooks/sources/launch-command';")).toBe(
      true
    );
    expect(REACHES_HOOKS.test("export { X } from '../hooks/agent-event-types';")).toBe(true);
    expect(REACHES_HOOKS.test("const m = await import('@/lib/hooks/sources/registry');")).toBe(
      true
    );
    expect(REACHES_HOOKS.test("const m = require('../../lib/hooks/x');")).toBe(true);
    expect(REACHES_HOOKS.test("import { createLogger } from '@/lib/logger';")).toBe(false);
  });

  it('has no file that reaches into lib/hooks', () => {
    const offenders = securityFiles.filter((file) =>
      REACHES_HOOKS.test(readFileSync(join(REPO_ROOT, file), 'utf-8'))
    );

    expect(
      offenders,
      'lib/security must not import lib/hooks — the dependency already runs the ' +
        'other way (hooks/sources/copilot/hook-settings -> security/path-validator). ' +
        'If this is the shared launch-line list, keep the second copy and let ' +
        'tests/unit/security/child-process-agent-env-1996.test.ts join them.\n' +
        offenders.map((f) => `  ${f}`).join('\n')
    ).toEqual([]);
  });

  it('still has the edge it is protecting, in the other direction', () => {
    // If hooks ever stopped importing security, the cycle argument would be
    // stale and this guard would be cargo. Pinned so that shows up as a
    // decision rather than as a comment nobody re-checked.
    const consumer = readFileSync(
      join(REPO_ROOT, 'src/lib/hooks/sources/copilot/hook-settings.ts'),
      'utf-8'
    );
    expect(consumer).toMatch(/from '@\/lib\/security\//);
  });
});
