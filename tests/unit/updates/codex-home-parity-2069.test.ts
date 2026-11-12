/**
 * `$CODEX_HOME` is spelled in two modules; this file is the join (Issue #2069).
 *
 * `lib/hooks/sources/codex/hooks-config` decides where codex WRITES (it puts
 * the resolved value on codex's own launch line) and `lib/updates/codex-version`
 * decides where CommandMate READS. If those two disagree, the Agent CLI versions
 * card does not show "unknown" — it shows some other install's version, with the
 * same confidence as a real reading.
 *
 * They cannot share a module. `hooks-config` reaches `@/lib/logger` through
 * `@/config/safe-directory`, and `tsconfig.cli.json` resets `"paths"` to `{}`,
 * so importing it from `lib/updates` would break `npm run build:cli` with
 * TS2307 — the #1933 defect PR #1991 fixed — because `commandmate agents update`
 * puts `codex-version` in the CLI's transitive closure. This test file is not
 * in that closure, so it can import both and hold them together, which is the
 * same shape `tests/unit/security/child-process-agent-env-1996.test.ts` uses
 * for the other list `lib/security` is not allowed to import.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { CODEX_HOME_ENV_VAR, getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';
import { getCodexHomeForVersionRead } from '@/lib/updates/codex-version';

const HOME_CODEX = join(homedir(), '.codex');

describe('[#2069] the two $CODEX_HOME resolvers agree where they must', () => {
  it('spells the variable the same way', () => {
    // `codex-version` keeps a private copy of this literal. It does not export
    // one: `hooks-config` owns the public name, and this assertion is what
    // stops the private copy from drifting.
    expect(getCodexHomeForVersionRead({ [CODEX_HOME_ENV_VAR]: '/tmp/x' })).toBe('/tmp/x');
    expect(CODEX_HOME_ENV_VAR).toBe('CODEX_HOME');
  });

  it('holds the private copy to the exported spelling, by source', () => {
    // A source-level check as well as a behavioural one: a rename of the
    // exported constant that left the private literal behind would still pass
    // the assertion above (both would read 'CODEX_HOME' until one changed).
    const source = readFileSync('src/lib/updates/codex-version.ts', 'utf-8');
    expect(source).toContain(`const CODEX_HOME_ENV_VAR = '${CODEX_HOME_ENV_VAR}'`);
    // And it must NOT export it — one public spelling, repository-wide.
    expect(source).not.toContain('export const CODEX_HOME_ENV_VAR');
  });

  it.each([
    ['absolute', '/opt/shared/codex-home', '/opt/shared/codex-home'],
    ['inside /proc (#1774)', '/proc/self/codex', HOME_CODEX],
    ['inside /sys (#1774)', '/sys/kernel/codex', HOME_CODEX],
    ['inside /dev (#1774)', '/dev/shm/codex', HOME_CODEX],
  ])('resolves a %s value identically on both sides', (_label, value, expected) => {
    expect(getCodexHome({ codexHome: value })).toBe(expected);
    expect(getCodexHomeForVersionRead({ [CODEX_HOME_ENV_VAR]: value })).toBe(expected);
  });

  it('reads the SAME ambient environment when nothing is passed', () => {
    // Not `~/.codex` here: tests/setup.ts pins `CODEX_HOME` to a temp directory
    // (Issue #1760) so no suite can write into a developer's real one. What the
    // parity claim needs is that both sides land on whatever the ambient value
    // says — which is exactly what would break if one of them read a different
    // variable name.
    expect(getCodexHomeForVersionRead()).toBe(getCodexHome());
    expect(getCodexHomeForVersionRead()).toBe(process.env[CODEX_HOME_ENV_VAR]);
  });

  it('falls back to ~/.codex on both sides when the variable really is unset', () => {
    const withoutCodexHome: Record<string, string | undefined> = { PATH: process.env.PATH };
    expect(getCodexHomeForVersionRead(withoutCodexHome)).toBe(HOME_CODEX);
    // hooks-config reads process.env directly, so its unset behaviour is pinned
    // through the option it exposes for the same purpose.
    expect(getCodexHome({ codexHome: undefined, ...{} })).toBe(process.env[CODEX_HOME_ENV_VAR]);
  });
});

describe('[#2069] the one deliberate divergence: a relative $CODEX_HOME', () => {
  it('hooks-config makes it absolute against the server cwd and pins that on the launch line', () => {
    // Issue #4233 changed this expectation (the one change the design allows,
    // docs/design/relative-config-home-4233.md §2.2). #2069 decided only that
    // the VERSION READER answers "unknown" for a relative value instead of
    // guessing; the verbatim pass-through it pinned here was the pre-existing
    // behaviour it cited as the reason, not a decision of its own. That
    // pass-through was itself the #4233 defect: the server wrote hooks.json and
    // the relay under `<serverCwd>/<rel>` while codex, started in the worktree,
    // read `<worktree>/<rel>`. hooks-config now resolves the value against the
    // server's cwd, so the file it writes and the home codex is pinned to are
    // one directory. The divergence #2069 cares about still stands — see the
    // next case: the version reader may run from a CLI in any cwd, so it still
    // refuses to guess.
    expect(getCodexHome({ codexHome: '.codex-shared' })).toBe(resolve(process.cwd(), '.codex-shared'));
  });

  it('the version reader answers UNKNOWN instead of guessing ~/.codex', () => {
    // Since #4233 hooks-config resolves the value against the SERVER's cwd, but
    // this reader is also called from CLI processes in an arbitrary cwd, so it
    // cannot reproduce that resolution and must not guess. Null makes every surface say "no update information" — the same
    // thing they say when codex has never run — instead of reporting an
    // unrelated install's version as this one's.
    expect(getCodexHomeForVersionRead({ [CODEX_HOME_ENV_VAR]: '.codex-shared' })).toBeNull();
    expect(getCodexHomeForVersionRead({ [CODEX_HOME_ENV_VAR]: '.codex-shared' })).not.toBe(
      HOME_CODEX
    );
  });
});
