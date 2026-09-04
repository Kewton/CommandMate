/**
 * The build and integration gates are declared, and declared in the one order
 * that keeps `typecheck` honest (Issue #1994).
 *
 * ## What happened
 *
 * Between 2026-08-22 and 2026-08-23, three defects reached `develop` that only
 * CI's `Build` and `Integration Tests` jobs could see. All three had a
 * `wait --verify` on them, and all three came back **exit 0**:
 *
 *   #1943  `export const SERVER_CAPABILITIES` in `src/app/api/capabilities/route.ts`
 *          -- broke `npm run build` (fixed by PR #1945, Issue #1946 filed)
 *   #1927  `tests/integration/current-output-structured-status-1723.test.ts` left
 *          un-updated -- red in Integration Tests (fixed by PR #1987)
 *   #1933  `@/types/...` reached `src/lib/cli-tools/types.ts`, which the CLI
 *          bundle compiles with `"paths": {}` -- `npm run build:cli` TS2307
 *          (fixed by PR #1991)
 *
 * `.commandmate/verify.yaml` declared seven of CI's twelve jobs. #1946 had
 * already closed the narrowest part of the first hole with a static guard
 * (`scripts/check-route-exports.mjs`) and deliberately left `build` and
 * `integration` out; #1994 measured the two again and declared them.
 *
 * ## The three things worth pinning
 *
 * ### 1. The gate commands are CI's commands
 *
 * Same rule as `static-guard-single-source.test.ts`: two places running one
 * check must run the SAME command, or the next person to change one of them
 * makes verify green about something CI is red about — which is the #1881
 * accident that started this line of guards.
 *
 * ### 2. `build` is declared BEFORE `typecheck`
 *
 * This is the only place in `verify.yaml` where the ORDER of two gates is load-
 * bearing, and nothing else in the repository fails if someone sorts the file
 * by cost.
 *
 * `tsconfig.json` includes `.next/types/**\/*.ts`, so `tsc --noEmit` reads the
 * route type-guards that a previous `next build` generated. Measured on this
 * branch: with `.next` present, moving one `route.ts` out of the tree makes
 * `npx tsc --noEmit` exit 2 with
 *
 *     .next/types/app/api/capabilities/route.ts(2,24): error TS2307: Cannot find
 *       module '../../../../../src/app/api/capabilities/route.js'
 *     .next/types/validator.ts(287,39): error TS2307: Cannot find module ...
 *
 * — errors about a build artifact, not about the tree. A diff that renames or
 * deletes a route would produce exactly that, so a `build` gate declared after
 * `typecheck` would hand every later run a stale artifact to trip over.
 *
 * The same measurement shows the cure: `next build` regenerates `.next/types`
 * wholesale (after removing that route and rebuilding, the generated directory
 * is gone and `validator.ts` mentions it zero times). Declared before
 * `typecheck`, the build always hands it types generated from THIS run's tree.
 *
 * ### 3. The timeouts are budgets, not guesses
 *
 * The three build gates carry no `mutex` (see `verify-heavy-gate-mutex.test.ts`
 * for the per-gate decision and the measurement tables). For a deterministic
 * gate the only route from machine load to a verdict is exhausting `timeoutSec`,
 * so the budget is what protects it. Worst durations measured under four
 * concurrent full `test:unit` runs — a load `unit`'s own mutex now prevents, so
 * this is an upper bound rather than a forecast:
 *
 *     build-cli      11.4s   budget  600   (52x)
 *     build-server   29.5s   budget  600   (20x)
 *     build         215.4s   budget 1800   (8.4x)
 *
 * ### 4. `npm run build` states the NODE_ENV it needs
 *
 * Gates are spawned by the CommandMate **server**, so they inherit the server's
 * NODE_ENV: `production` under `commandmate start`, `development` under
 * `commandmate start --dev` and `npm run dev`. Measured: `npm run build`
 * (Next.js 15) exits 0 with NODE_ENV unset and **exits 1 with
 * NODE_ENV=development**, failing to prerender `/404`, `/500` and `/offline`
 * with `<Html> should not be imported outside of pages/_document`. Declaring a
 * build gate without fixing that would have made it red for every worker on
 * every run whenever an operator had started the server with `--dev`.
 *
 * #1994 closed it twice on purpose, because the two closures cover different
 * exposures rather than duplicating one check:
 *
 *   - `gateProcessEnv()` in `gate-runner.ts` drops NODE_ENV from the inherited
 *     environment, so EVERY repository's gates see CI's shape rather than the
 *     host server's. Pinned by gate-runner.test.ts.
 *   - the `build` script names `NODE_ENV=production` itself, so the command is
 *     correct under the standalone runner and under a developer's shell too.
 *     Pinned below.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { loadVerifyConfig } from '@/lib/verification/verify-config';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci-pr.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = parse(readFileSync(CI_WORKFLOW, 'utf-8')) as Workflow;
const config = loadVerifyConfig(REPO_ROOT);

/** Every `run:` in a CI job except the dependency install, which verify never does. */
const jobCommands = (jobId: string): string[] =>
  (workflow.jobs[jobId]?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === 'string')
    // [Issue #2313] `npm ci --no-audit`: match the command, not the exact
    // string, so the install stays excluded when it carries flags.
    .filter((run) => !/^npm ci(\s|$)/.test(run.trim()));

const gate = (id: string) => config?.gates.find((candidate) => candidate.id === id);

const gateIndex = (id: string): number =>
  (config?.gates ?? []).findIndex((candidate) => candidate.id === id);

/** gate id -> the CI job whose step it re-runs. */
const GATES_FROM_CI = [
  { id: 'build', jobId: 'build', command: 'npm run build' },
  { id: 'build-cli', jobId: 'build', command: 'npm run build:cli' },
  { id: 'build-server', jobId: 'build', command: 'npm run build:server' },
  { id: 'integration', jobId: 'test-integration', command: 'npm run test:integration' },
] as const;

describe('the gates Issue #1994 declared', () => {
  it.each(GATES_FROM_CI)('$id runs exactly what CI runs', ({ id, command }) => {
    expect(gate(id), `.commandmate/verify.yaml declares no '${id}' gate`).toBeDefined();
    expect(gate(id)?.command).toBe(command);
  });

  it.each(GATES_FROM_CI)('$id names a command the $jobId job actually has', ({ jobId, command }) => {
    expect(jobCommands(jobId)).toContain(command);
  });

  it('covers every build step the CI Build job runs', () => {
    // The CI job is one job with three build steps. Splitting it into three
    // gates is deliberate — the runner does not stop at the first failure, so
    // three rows name WHICH build broke, and the two cheap ones (0.9s / 2.0s)
    // report before the 30s one starts. What must not happen is a fourth step
    // appearing in CI with no gate beside it.
    const declared = GATES_FROM_CI.filter((entry) => entry.jobId === 'build').map(
      (entry) => entry.command
    );
    expect(jobCommands('build').sort()).toEqual([...declared].sort());
  });
});

describe('gate order', () => {
  it('runs build before typecheck', () => {
    // See the header: `tsconfig.json` includes `.next/types`, so `tsc --noEmit`
    // reads generated route type-guards. Only a build in the SAME run can
    // guarantee they describe this tree.
    const buildAt = gateIndex('build');
    const typecheckAt = gateIndex('typecheck');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(typecheckAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(typecheckAt);
  });

  it('keeps `.next/types` inside the type-check surface', () => {
    // If this ever stops being true the ordering rule above is dead weight, and
    // the next person should delete it rather than wonder what it was for.
    const tsconfig = JSON.parse(
      readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf-8').replace(/^\s*\/\/.*$/gm, '')
    ) as { include: string[] };
    expect(tsconfig.include).toContain('.next/types/**/*.ts');
  });
});

describe('timeout budgets', () => {
  // Worst observed duration under four concurrent full `test:unit` runs.
  const WORST_OBSERVED_SEC: Record<string, number> = {
    'build-cli': 11.4,
    'build-server': 29.5,
    build: 215.4,
  };

  it.each(Object.keys(WORST_OBSERVED_SEC))('%s keeps at least 5x headroom', (id) => {
    expect(gate(id)?.timeoutSec).toBeGreaterThanOrEqual(WORST_OBSERVED_SEC[id] * 5);
  });
});

describe('what the integration gate inherits, and from where', () => {
  /**
   * CI's `Integration Tests` job sets `CI: 'true'`, which `vitest.config.ts`
   * reads as `fileParallelism: false` / `maxConcurrency: 1` — CI runs the suite
   * SERIALLY. The gate command does not say so, and does not need to under the
   * product runner: `gate-runner.ts` injects `CI=true` into every gate for
   * exactly this reason (pinned by `tests/unit/verification/gate-runner.test.ts`
   * -> "exports CI=true to gate commands").
   *
   * The standalone runner (`.claude/skills/cmate-verify/scripts/verify-run.sh`)
   * injects nothing, so through that path the same declaration runs vitest in
   * parallel: 10.2-12.0s instead of 49.9-50.3s solo, and red in ten of eleven
   * loaded runs on Issue #1985's two files. That divergence — not a measured
   * failure under the product runner, which was 9/9 green — is why the gate
   * carries `cpu.heavy`: one line of configuration runs in both runners, and a
   * gate whose determinism depends on which runner started it is not a
   * determinate gate.
   */
  const integrationStep = (workflow.jobs['test-integration']?.steps ?? []).find(
    (step) => step.run?.trim() === 'npm run test:integration'
  );

  it('CI asks vitest for the serial configuration', () => {
    expect(integrationStep?.env?.CI).toBe('true');
  });

  it('the gate leaves that to the runner and carries the mutex instead', () => {
    expect(gate('integration')?.command).not.toContain('CI=');
    expect(gate('integration')?.mutex).toBe('cpu.heavy');
  });
});

describe('the build script states the NODE_ENV it needs', () => {
  /**
   * See the header. A gate inherits the CommandMate server's NODE_ENV, and
   * `next build` under NODE_ENV=development exits 1 on a tree that is fine.
   * `gateProcessEnv()` removes the inherited value for every repository; this
   * line makes the command right for the standalone runner and for a human
   * typing it in a shell that happens to export one.
   */
  const scripts = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('pins NODE_ENV=production ahead of next build', () => {
    expect(scripts.build).toBe('NODE_ENV=production next build');
  });

  it('is still the command CI runs, spelled the same way', () => {
    // The pin lives inside the npm script precisely so that both places keep
    // saying `npm run build` and cannot drift apart on the env.
    expect(jobCommands('build')).toContain('npm run build');
    expect(gate('build')?.command).toBe('npm run build');
  });
});
