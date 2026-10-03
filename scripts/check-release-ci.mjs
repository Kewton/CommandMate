#!/usr/bin/env node
/**
 * Refuses to let the publish workflow reach `npm publish` unless CI has passed
 * on the exact commit the release tag points at.
 *
 * [Issue #3111] The publish job used to run the whole `npm run test:unit` again
 * (23 minutes for 0.43.0, run 36725586872), on a commit whose `main` push had
 * already run the same suite in `ci-pr.yml`. That re-run was most of the 34-43
 * minutes between a GitHub Release appearing and the version reaching npm.
 * This script replaces it with a check of the verdict CI already produced.
 *
 * What it reads: `GET /repos/{repo}/commits/{sha}/check-runs?check_name=<name>`
 * for each required check, limited to the `github-actions` app (so a check run
 * some other app happens to name `Unit Tests` cannot satisfy it) and to the
 * latest run of that name (so a re-run that went green after a red one counts).
 *
 * Why it waits. Measured on v0.41.1-v0.43.0 (dev-reports/issue/3111): the tag
 * commit always carries these check runs, but the `Unit Tests` aggregate
 * completed 2.2-8.4 minutes AFTER the Release was published — `/release`
 * creates the Release right after merging, while the `main` push CI is still
 * running. So "pending" and "not created yet" are polled until a deadline; only
 * a completed run decides.
 *
 * Exit 0 only when every required check's latest run is `completed/success`.
 * Every other outcome exits 1 and the job stops before `npm publish`:
 *   - a required check completed with any other conclusion (failure, cancelled,
 *     skipped, timed_out ...) — immediately, without waiting further
 *   - a required check is missing or still running at the deadline
 *   - `gh` itself failed or answered something that is not a check-runs payload
 *     — immediately: an unreadable verdict is not a passing one
 *
 * Usage (in the workflow; GH_TOKEN needs `checks: read`):
 *   node scripts/check-release-ci.mjs --repo <owner/repo> --sha <sha> \
 *     [--checks "Unit Tests,Build"] [--timeout-minutes 20] [--interval-seconds 30]
 */

import { execFileSync } from 'child_process';

/**
 * `main`'s branch protection requires exactly these (measured 2026-10-03:
 * `gh api repos/Kewton/CommandMate/branches/main/protection/required_status_checks`).
 * `Unit Tests` is the aggregate of the four shards (ci-pr.yml `test-unit-result`).
 */
export const DEFAULT_REQUIRED_CHECKS = ['Unit Tests', 'Build'];

/** The GitHub Actions app. ci-pr.yml's check runs are all created by it. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * @typedef {{ id?: number, name?: string, status?: string, conclusion?: string | null }} CheckRun
 * @typedef {{ state: 'success' | 'failure' | 'pending' | 'missing', detail: string }} CheckState
 * @typedef {{ ok: boolean, reason: string }} Verdict
 * @typedef {(args: string[]) => string} RunGh
 */

/**
 * Reduce the check runs returned for ONE check name to a single state.
 * Pure. The highest id is the latest run (re-runs get new ids).
 *
 * @param {CheckRun[]} runs
 * @returns {CheckState}
 */
export function classifyCheckRuns(runs) {
  if (runs.length === 0) return { state: 'missing', detail: 'no check run found' };
  const latest = runs.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a));
  if (latest.status !== 'completed') {
    return { state: 'pending', detail: `status=${latest.status ?? 'unknown'}` };
  }
  if (latest.conclusion === 'success') return { state: 'success', detail: 'success' };
  return { state: 'failure', detail: `conclusion=${latest.conclusion ?? 'null'}` };
}

/**
 * Fetch the check runs of one name on one commit. Throws when `gh` fails or
 * the answer is not a check-runs payload.
 *
 * @param {RunGh} runGh
 * @param {string} repo
 * @param {string} sha
 * @param {string} name
 * @returns {CheckRun[]}
 */
export function fetchCheckRuns(runGh, repo, sha, name) {
  const query = new URLSearchParams({
    check_name: name,
    app_id: String(GITHUB_ACTIONS_APP_ID),
    filter: 'latest',
    per_page: '100',
  });
  const stdout = runGh(['api', `repos/${repo}/commits/${sha}/check-runs?${query.toString()}`]);
  const json = JSON.parse(stdout);
  if (!json || !Array.isArray(json.check_runs)) {
    throw new Error(`unexpected response for '${name}': no check_runs array`);
  }
  // check_name is an exact match server-side; filter again so a looser server never widens it.
  return json.check_runs.filter((/** @type {CheckRun} */ r) => r.name === name);
}

/**
 * Poll until every required check is decided or the deadline passes.
 *
 * @param {{
 *   repo: string,
 *   sha: string,
 *   checks?: string[],
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   runGh: RunGh,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {Promise<Verdict>}
 */
export async function checkReleaseCi({
  repo,
  sha,
  checks = DEFAULT_REQUIRED_CHECKS,
  timeoutMs = 20 * 60_000,
  intervalMs = 30_000,
  runGh,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  if (checks.length === 0) return { ok: false, reason: 'no required checks given' };
  const deadline = now() + timeoutMs;

  for (;;) {
    /** @type {Record<string, CheckState>} */
    const states = {};
    for (const name of checks) {
      try {
        states[name] = classifyCheckRuns(fetchCheckRuns(runGh, repo, sha, name));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: `could not read check runs for '${name}': ${message}` };
      }
    }
    log(checks.map((n) => `${n}: ${states[n].state} (${states[n].detail})`).join(' | '));

    const failed = checks.filter((n) => states[n].state === 'failure');
    if (failed.length > 0) {
      return { ok: false, reason: `CI did not pass on ${sha}: ${failed.map((n) => `${n} ${states[n].detail}`).join(', ')}` };
    }
    if (checks.every((n) => states[n].state === 'success')) {
      return { ok: true, reason: `CI passed on ${sha}: ${checks.join(', ')}` };
    }

    if (now() >= deadline) {
      const undecided = checks.filter((n) => states[n].state !== 'success');
      return {
        ok: false,
        reason: `gave up after ${Math.round(timeoutMs / 60_000)} min waiting for CI on ${sha}: ${undecided
          .map((n) => `${n} ${states[n].detail}`)
          .join(', ')}`,
      };
    }
    await sleep(intervalMs);
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error(`bad argument near '${key ?? ''}'`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

/** @param {string[]} argv */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.log(`::error::${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (!args.repo || !args.sha) {
    console.log('::error::usage: check-release-ci.mjs --repo <owner/repo> --sha <sha> [--checks "A,B"] [--timeout-minutes N] [--interval-seconds N]');
    return 2;
  }
  const checks = args.checks
    ? args.checks.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_REQUIRED_CHECKS;
  const timeoutMinutes = Number(args['timeout-minutes'] ?? 20);
  const intervalSeconds = Number(args['interval-seconds'] ?? 30);
  // A NaN deadline never passes, so a typo here would poll until the job cap.
  if (!(timeoutMinutes > 0) || !(intervalSeconds > 0)) {
    console.log('::error::--timeout-minutes and --interval-seconds must be positive numbers');
    return 2;
  }
  const verdict = await checkReleaseCi({
    repo: args.repo,
    sha: args.sha,
    checks,
    timeoutMs: timeoutMinutes * 60_000,
    intervalMs: intervalSeconds * 1000,
    runGh: (ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    log: (line) => console.log(line),
  });
  if (verdict.ok) {
    console.log(verdict.reason);
    return 0;
  }
  console.log(`::error title=Release CI check::${verdict.reason}. Not publishing. See Issue #3111.`);
  return 1;
}

// Only run as a CLI when invoked directly; the unit test imports the functions.
if (process.argv[1] && /check-release-ci\.mjs$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
