/**
 * The one runner every external call of `scripts/flow/` goes through (Issue #4367 PR1a,
 * docs/design/flow-metrics-4367.md §3.2, invariant V3).
 *
 * - The budget is computed right before the call from one absolute deadline on a
 *   monotonic clock, floored first and checked second: a positive fraction floored to 0
 *   never starts a child (`spawnSync` with `timeout: 0` would wait forever, F4).
 * - A result that comes back at or after the deadline is not used (`timeout`).
 * - Only the calls `isAllowedCall` names are run: identification git and the two
 *   `gh pr list` searches of §2.3. Anything else is refused without a child.
 */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const MAX_BUFFER = 32 * 1024 * 1024;
export const PR_LIMIT = 1000;
const DATE_RANGE = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
const REF_SEGMENT = /^[A-Za-z0-9._/-]+$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The JSON fields each search asks for (§2.3): nothing else is fetched. */
export const PR_QUERY_FIELDS = {
  created: 'number,createdAt,baseRefName',
  merged: 'number,mergedAt,baseRefName',
};

/** The default synchronous call: `spawnSync`, with the options the runner decided. */
export function defaultRun(cmd, args, options) {
  return spawnSync(cmd, args, options);
}

export const defaultMonoNow = () => performance.now();

function sameArgs(args, expected) {
  return args.length === expected.length && expected.every((value, i) => args[i] === value);
}

/**
 * Whether `cmd args` is one of the calls flow may make (T-I I13).
 * @param {string} cmd
 * @param {string[]} args
 * @returns {boolean}
 */
export function isAllowedCall(cmd, args) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return false;
  if (cmd === 'git') {
    if (sameArgs(args, ['remote', 'get-url', 'origin'])) return true;
    if (sameArgs(args, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return true;
    if (sameArgs(args, ['symbolic-ref', 'refs/remotes/origin/HEAD'])) return true;
    if (args.length === 3 && args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = args[2];
      return ref.startsWith('refs/remotes/origin/') && REF_SEGMENT.test(ref) && !ref.includes('..');
    }
    return false;
  }
  if (cmd === 'gh') {
    if (args.length !== 14) return false;
    const [pr, list, repoFlag, repo, baseFlag, base, stateFlag, state, searchFlag, search, limitFlag, limit, jsonFlag, json] = args;
    if (pr !== 'pr' || list !== 'list') return false;
    if (repoFlag !== '--repo' || !REPO_NAME.test(repo)) return false;
    if (baseFlag !== '--base' || !REF_SEGMENT.test(base)) return false;
    if (searchFlag !== '--search' || limitFlag !== '--limit' || limit !== String(PR_LIMIT) || jsonFlag !== '--json') return false;
    if (stateFlag !== '--state') return false;
    const [key, range] = search.split(':');
    if (search.split(':').length !== 2 || !DATE_RANGE.test(range)) return false;
    if (key === 'created') return state === 'all' && json === PR_QUERY_FIELDS.created;
    if (key === 'merged') return state === 'merged' && json === PR_QUERY_FIELDS.merged;
    return false;
  }
  return false;
}

/**
 * Builds `runBounded(cmd, args, { deadlineMono, capMs, cwd })` over a synchronous `run`.
 * @param {{ run?: Function, monoNow?: () => number }} [deps]
 */
export function makeRunBounded(deps = {}) {
  const run = deps.run ?? defaultRun;
  const monoNow = deps.monoNow ?? defaultMonoNow;
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ deadlineMono: number, capMs: number, cwd?: string }} options
   * @returns {{ status: 'ok' | 'fail' | 'timeout' | 'refused', called: boolean, stdout?: string, stderr?: string }}
   */
  return function runBounded(cmd, args, options) {
    const { deadlineMono, capMs, cwd } = options;
    if (!isAllowedCall(cmd, args)) return { status: 'refused', called: false };
    // Floor first, then check (design §3.2, R5): 0.5 ms floors to 0 and is not called.
    const budget = Math.floor(Math.min(capMs, deadlineMono - monoNow()));
    if (!Number.isFinite(budget) || budget <= 0) return { status: 'timeout', called: false };
    let result;
    try {
      result = run(cmd, args, {
        cwd,
        timeout: budget,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (monoNow() >= deadlineMono) return { status: 'timeout', called: true };
      return { status: 'fail', called: true, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
    const code = result?.error && /** @type {{ code?: string }} */ (result.error).code;
    if (monoNow() >= deadlineMono || code === 'ETIMEDOUT') return { status: 'timeout', called: true };
    const stdout = typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout ?? '');
    const stderr = typeof result?.stderr === 'string' ? result.stderr : String(result?.stderr ?? '');
    if (result?.error) return { status: 'fail', called: true, stdout, stderr: `${stderr}\n${String(code ?? result.error)}` };
    return { status: result?.status === 0 ? 'ok' : 'fail', called: true, stdout, stderr };
  };
}
