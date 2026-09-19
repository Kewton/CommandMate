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

interface WorkflowStep extends Record<string, unknown> {
  name?: string;
  run?: string;
  'timeout-minutes'?: number;
}

type WorkflowJob = Record<string, unknown> & { steps?: WorkflowStep[] };

function lintJob(): WorkflowJob {
  const workflow = parse(readFileSync(CI_WORKFLOW, 'utf-8')) as {
    jobs: Record<string, WorkflowJob>;
  };
  const job = workflow.jobs.lint;
  expect(job, 'ci-pr.yml must still have a `lint` job').toBeTruthy();
  return job;
}

/** The single step of the CI Lint job that runs `npm run lint:sh`. */
function shellcheckStep(): WorkflowStep {
  const steps = (lintJob().steps ?? []).filter((step) =>
    (step.run ?? '').includes('npm run lint:sh'),
  );
  expect(
    steps,
    'the CI Lint job must run `npm run lint:sh` in exactly one step',
  ).toHaveLength(1);
  return steps[0];
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
    const step = shellcheckStep();

    // Issue #2719 removed `continue-on-error` from this job; a step-level one
    // would put it straight back for the check added here.
    expect(Object.keys(lintJob())).not.toContain('continue-on-error');
    expect(
      Object.keys(step),
      'the shellcheck step must not opt out of its own result',
    ).not.toContain('continue-on-error');
  });

  /**
   * The step is fail-closed, and that is the whole contract. PR #2742 proved the
   * guard works — the self-hosted runner had no shellcheck and the Lint job went
   * red (run 35454416714) — and the fix was to install it first, not to let the
   * step pass when the tool is missing. The two escape hatches that would make
   * "shellcheck unavailable" look green are `continue-on-error` (above) and an
   * `if:` that skips the step, so both are closed here.
   */
  it('cannot be skipped, and is bounded while it fetches', () => {
    const step = shellcheckStep();

    expect(
      Object.keys(step),
      'an `if:` on this step would skip the check instead of failing it',
    ).not.toContain('if');

    // Unbounded network waiting is what #1830 exists to prevent, and the
    // Playwright deps step on this same hardware has 10.4m samples (#1844).
    expect(
      step['timeout-minutes'],
      'the download must be bounded (#1830 / #1844)',
    ).toEqual(expect.any(Number));
  });

  /**
   * The version is pinned, and the condition for installing is "is the pinned
   * version here", not "is shellcheck here". Run 35454963546 is why: apt served
   * `shellcheck (0.9.0-1)` and `lint:sh` failed on two SC2002 (useless cat)
   * findings that **local 0.11.0 does not emit at all** — SC2002 left the default
   * set in 0.10.0 and is not in `--list-optional`. `ubuntu-latest`, the fork-PR
   * fallback, is Ubuntu 24.04 and ships the same 0.9.0, so an existence check
   * would have run 0.9.0 down every path.
   *
   * The property being defended is that CI and a developer's machine see the same
   * finding set. This file cannot run shellcheck to measure that (it is not part
   * of `npm ci`), so it pins the shape instead: one version literal, used to build
   * the download URL, and re-checked after the install so the wrong binary on PATH
   * fails the job rather than linting with it.
   */
  it('pins the shellcheck version rather than taking whatever is installed', () => {
    const step = shellcheckStep();
    const run = step.run ?? '';
    const version = (step.env as Record<string, unknown> | undefined)
      ?.SHELLCHECK_VERSION;

    expect(
      version,
      'the step must pin an exact shellcheck version via env.SHELLCHECK_VERSION',
    ).toMatch(/^\d+\.\d+\.\d+$/);

    // apt is the thing that went wrong: Ubuntu 24.04 (both runner flavours) has
    // 0.9.0 and no way to ask it for anything else.
    expect(
      run,
      'apt only offers 0.9.0 on these runners — fetch the pinned release instead',
    ).not.toContain('apt-get install');

    // The pin has to drive the download, or the literal and the binary drift.
    expect(run).toContain(
      'koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}',
    );
    expect(run).toContain('shellcheck-v${SHELLCHECK_VERSION}.linux.');

    // Fail-closed backstop, and the reason a stale hash or an earlier PATH entry
    // cannot quietly lint with the wrong version.
    expect(
      run,
      'the step must re-verify the version and exit non-zero on a mismatch',
    ).toMatch(/test "\$\([^)]*\)" = "\$SHELLCHECK_VERSION"/);
    expect(run, 'a bad download must be fatal').toContain('curl -fsSL');
    expect(run).toContain('set -euo pipefail');

    // In the log on purpose: a CI-only difference in findings is answered by this
    // line instead of by another run.
    expect(run).toContain('shellcheck --version');
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
