/**
 * `npm run lint:sh` covers every `.sh` under `scripts/` (Issue #2734).
 *
 * ## Why shellcheck runs at `--severity=style` with three codes named
 *
 * `scripts/` holds the server's own start/stop path, and none of its 18 shell
 * scripts had ever been read by a static checker: `npm run lint` is ESLint and
 * `.sh` is not in its `--ext` list. Turning shellcheck on found 27 findings
 * (with `-x -P scripts`, which teaches it to follow `source` rather than
 * suppressing SC1091), of which exactly one is a `warning` — the `export "$line"`
 * in `load-env.sh`, silenced there with a reason.
 *
 * The other 26 are `note`s and they are deliberately named, not severity-filtered:
 * 23 SC2086 in `stop.sh` / `stop-server.sh` are unquoted `$PIDS` **whose word
 * splitting is the point** — quoting them collapses a list of PIDs into one
 * argument and breaks the kill path — so fixing them means rewriting the
 * production stop flow as bash arrays (separate Issue), plus 2 SC2317 (trap
 * callbacks misread as unreachable) and 1 SC2116. `--severity=warning` would
 * have hidden those 26 *and* every future `info` / `style` finding; naming the
 * three codes keeps everything else, down to `style`, failing the build.
 *
 * ## What this file pins
 *
 * shellcheck itself is never invoked here — it is not part of `npm ci`, so a
 * developer or worker without it must still be able to run the unit suite. This
 * reads the two config files instead, the same way
 * `tests/unit/guards/lint-tests-scope.test.ts` reads `.eslintrc.json`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const REPO_ROOT = process.cwd();
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const CI_WORKFLOW = join(REPO_ROOT, '.github/workflows/ci-pr.yml');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

/**
 * The complete set of codes `lint:sh` is allowed to skip, and why each one is
 * here rather than fixed:
 *
 * - `SC2086` — unquoted `$PIDS` / `$REMAINING` in `stop.sh`, `stop-server.sh`,
 *   `status.sh`, `start.sh`, `build-and-start.sh`. Word splitting is intended;
 *   quoting breaks the stop path. Fix = bash arrays in the production kill flow.
 * - `SC2317` — two functions reached only through `trap`, which shellcheck reads
 *   as unreachable. Nothing to fix in the script.
 * - `SC2116` — one redundant `echo`. Cosmetic, bundled with the above.
 *
 * **Do not add to this set.** A new code here is a whole class of finding going
 * unread across every start/stop script; open an Issue instead.
 */
const ALLOWED_EXCLUDES = ['SC2086', 'SC2116', 'SC2317'];

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as {
  scripts: Record<string, string>;
};

function lintSh(): string {
  const script = pkg.scripts['lint:sh'];
  expect(script, 'package.json must define a `lint:sh` script').toBeTruthy();
  return script;
}

/** Every `.sh` under `scripts/`, at any depth. */
function shellScripts(recursive: boolean): string[] {
  return (readdirSync(SCRIPTS_DIR, { recursive }) as string[])
    .map((entry) => entry.split('\\').join('/'))
    .filter((entry) => entry.endsWith('.sh'));
}

describe('lint:sh covers scripts/**.sh (Issue #2734)', () => {
  it('lets shellcheck follow `source` instead of suppressing SC1091', () => {
    const script = lintSh();
    // -x follows sourced files; -P is the search path they are found on. Without
    // both, 12 of the 39 findings are SC1091 "can't follow" noise.
    expect(script).toContain('-x');
    expect(script).toContain('-P scripts');
  });

  it('checks down to `style`, not just `warning`', () => {
    const script = lintSh();
    expect(script).toContain('--severity=style');
    // The whole point of naming three codes: `--severity=warning` would also mute
    // every note/info/style finding added to these scripts in future.
    expect(
      script,
      '`--severity=warning` mutes the note/info/style findings too — ' +
        'keep `--severity=style` and name the codes you skip',
    ).not.toContain('--severity=warning');
    expect(script.match(/--severity=/g) ?? []).toHaveLength(1);
  });

  it('skips exactly the three known codes', () => {
    const excludes = [...lintSh().matchAll(/--exclude=(\S+)/g)].flatMap((m) =>
      m[1].split(','),
    );
    expect(
      [...excludes].sort(),
      'the excluded set is pinned — see ALLOWED_EXCLUDES above before changing it',
    ).toEqual([...ALLOWED_EXCLUDES].sort());
  });

  it('selects its files with `find`, not a top-level glob', () => {
    const script = lintSh();
    expect(
      script,
      "`scripts/*.sh` only matches the top level — use $(find scripts -name '*.sh')",
    ).not.toContain('scripts/*.sh');
    expect(script).toContain("find scripts -name '*.sh'");
  });

  it('keeps shellcheck out of `npm run lint`', () => {
    // `npm run lint` is the `lint` gate of `.commandmate/verify.yaml` and the CI
    // Lint step. Chaining shellcheck onto it fails that gate wholesale wherever
    // shellcheck is not installed.
    expect(
      pkg.scripts.lint,
      '`lint` must stay ESLint-only; shellcheck has its own script and CI step',
    ).not.toContain('shellcheck');
  });

  it('runs `lint:sh` in CI without letting the job swallow the result', () => {
    const workflow = parse(readFileSync(CI_WORKFLOW, 'utf-8')) as {
      jobs: Record<
        string,
        { steps?: { name?: string; run?: string }[] } & Record<string, unknown>
      >;
    };
    const lintJob = workflow.jobs.lint;
    expect(lintJob, 'ci-pr.yml must still have a `lint` job').toBeTruthy();

    const steps = lintJob.steps ?? [];
    const shellcheckSteps = steps.filter((step) =>
      (step.run ?? '').includes('npm run lint:sh'),
    );
    expect(
      shellcheckSteps,
      'the CI Lint job must run `npm run lint:sh` in exactly one step',
    ).toHaveLength(1);

    // Issue #2719 removed `continue-on-error` from this job; a step-level one
    // would put it straight back for the check added here.
    expect(Object.keys(lintJob)).not.toContain('continue-on-error');
    expect(
      Object.keys(shellcheckSteps[0]),
      'the shellcheck step must not opt out of its own result',
    ).not.toContain('continue-on-error');
  });

  /**
   * Positive control for the test above. The string assertion on `find` only says
   * *what* the command is; this says *why* it has to be that — there really are
   * `.sh` files below the top level, `scripts/lib/port-pids.sh` among them, and it
   * is the one carrying the `-sTCP:LISTEN` PID lookup that `stop.sh` sources
   * (Issue #2473). Without this, a future edit back to `scripts/*.sh` would keep
   * every other test in this file green.
   */
  it('still has .sh files in subdirectories, which is why `find` is required', () => {
    const all = shellScripts(true);
    const topLevel = shellScripts(false);
    expect(
      all.length,
      'サブディレクトリの .sh が無くなった。`lint:sh` が直下限定の glob に' +
        '戻されていないか確認すること',
    ).toBeGreaterThan(topLevel.length);
  });
});
