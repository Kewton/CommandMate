#!/usr/bin/env node
/**
 * `node scripts/orchestrate/flow-wip.mjs <count|check> [--worktree <path>] [--deadline-sec <n>] [--json]`
 * — the unmerged branches of a repo against its base, and an advisory check against the
 * `wip.total` limit (Issue #4368 PR1, docs/design/flow-wip-4368.md §1・§2.2・§3.1・§5・§6).
 *
 * C = (branches of the worktrees on disk ∪ heads of the open PRs to base) \ exclude \ merged.
 * A worktree branch is merged only with proof: a MERGED PR of the same repo, the same base,
 * the same head name and `headRefOid` = the observed tip, or the tip being an ancestor of an
 * `origin/<base>` that GitHub confirms is current. Anything not proven is counted; a proof
 * that could not be run puts the branch in `unknown` and makes the count incomplete.
 *
 * `check` answers one question only: whether this observation leaves room for one more
 * unmerged branch. It is advice, not a permit or a reservation: two checks can both see the
 * same room (design §2.3). It writes nothing, takes no lock and starts no operation (P1).
 *
 * Every external call goes through one runner against one absolute deadline on a monotonic
 * clock, floored to whole ms and started only when at least 1 ms is left (P7). A result that
 * comes back after the deadline is dropped. Nothing is retried.
 *
 * Exit: 0 room / off (check), counted (count) · 60 full (check) · 61 cannot be judged ·
 * 2 usage or settings · 1 unexpected.
 */
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defaultMonoNow, makeRunBounded } from '../flow/runner.mjs';
import { readFlowConfig, readRawFlowConfig } from '../flow/config.mjs';
import { isGhRead } from './pr-common.mjs';

export const EXIT_WIP_FULL = 60;
export const EXIT_WIP_UNKNOWN = 61;
export const EXIT_USAGE = 2;
export const DEFAULT_DEADLINE_SEC = 120;
export const MAX_DEADLINE_SEC = 3600;
export const GIT_CAP_MS = 10_000;
export const GH_CAP_MS = 30_000;
export const OPEN_PR_LIMIT = 1000;
export const MERGED_WINDOW_LIMIT = 300;
export const MERGED_BRANCH_LIMIT = 100;
export const MAX_BUFFER = 32 * 1024 * 1024;
export const SHOWN_BRANCHES = 5;
export const OPEN_PR_FIELDS = 'number,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,baseRefName';
export const MERGED_PR_FIELDS = 'number,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt';
export const ADVISORY = 'Advisory only — not a permit or reservation';

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

const USAGE = `usage: flow-wip.mjs count [--worktree <path>] [--deadline-sec <n>] [--json]
       flow-wip.mjs check [--worktree <path>] [--deadline-sec <n>] [--json]`;

/** @typedef {{ path: string, branch: string | null, head: string | null }} WorktreeRow */
/** @typedef {{ number: number, headRefName: string, headOwner: string | null, isCrossRepository: boolean, baseRefName: string, headRefOid: string, mergedAt?: string }} PrRow */
/** @typedef {{ repo: string, base: string, exclude: string[], worktrees: WorktreeRow[], openPrs: PrRow[],
 *   merged: Record<string, 'proved' | 'not-proved' | 'unknown'>, observedFrom: string, observedTo: string }} WipInput */
/** @typedef {{ unmerged: string[], active: null, unknown: string[], excluded: string[], complete: boolean }} WipCount */
/** @typedef {{ status: 'ok' | 'fail' | 'timeout' | 'refused', code: number | null, stdout: string, stderr: string, called: boolean, timedOut: boolean, skipped: boolean }} RunResult */

const okArgs = (args, expected) => args.length === expected.length && expected.every((v, i) => args[i] === v);
const isRef = (value) => typeof value === 'string' && BRANCH.test(value) && !value.includes('..');

/**
 * The calls flow-wip itself may make (design §6.1, R9): three kinds of git and reading gh.
 * @param {string} cmd
 * @param {string[]} args
 */
export function isAllowedWipCall(cmd, args) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return false;
  if (cmd === 'git') {
    if (okArgs(args, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return true;
    if (okArgs(args, ['rev-parse', 'HEAD'])) return true;
    if (args.length === 3 && args[0] === 'rev-parse' && args[1] === '--verify') {
      return args[2].startsWith('refs/remotes/origin/') && isRef(args[2]);
    }
    if (okArgs(args, ['worktree', 'list', '--porcelain'])) return true;
    if (args.length === 4 && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      return SHA.test(args[2]) && args[3].startsWith('refs/remotes/origin/') && isRef(args[3]);
    }
    return false;
  }
  if (cmd === 'gh') {
    if (!isGhRead(args)) return false;
    if (args[0] === 'api') {
      return args.length === 4 && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/branches\/[A-Za-z0-9._/-]+$/.test(args[1])
        && !args[1].includes('..') && args[2] === '--jq' && args[3] === '.commit.sha';
    }
    return args[0] === 'pr' && args[1] === 'list' && args.includes('--repo') && args.includes('--base') && args.includes('--json')
      && args.includes('--limit') && !args.some((a) => a === '--web');
  }
  return false;
}

/**
 * `(cmd, args, { capMs, deadlineMono, cwd }) → RunResult` over a spawnSync-shaped call (P7).
 * @param {{ spawnSync?: Function, monoNow?: () => number }} [deps]
 */
export function makeRunner(deps = {}) {
  const spawn = deps.spawnSync ?? nodeSpawnSync;
  const monoNow = deps.monoNow ?? defaultMonoNow;
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ capMs: number, deadlineMono: number, cwd?: string }} options
   * @returns {RunResult}
   */
  return function run(cmd, args, { capMs, deadlineMono, cwd }) {
    const base = { code: null, stdout: '', stderr: '', timedOut: false, skipped: false };
    if (!isAllowedWipCall(cmd, args)) return { ...base, status: 'refused', called: false };
    // Floor first, then check: 0.6 ms floors to 0 and is not started (`timeout: 0` waits forever).
    const budget = Math.floor(Math.min(capMs, deadlineMono - monoNow()));
    if (!Number.isFinite(budget) || budget < 1) return { ...base, status: 'timeout', called: false, timedOut: true, skipped: true };
    let result;
    try {
      result = spawn(cmd, args, {
        cwd,
        timeout: budget,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (monoNow() >= deadlineMono) return { ...base, status: 'timeout', called: true, timedOut: true };
      return { ...base, status: 'fail', called: true, stderr: err instanceof Error ? err.message : String(err) };
    }
    const errCode = result?.error && /** @type {{ code?: string }} */ (result.error).code;
    // A result that came back at or after the deadline is not used (D6).
    if (monoNow() >= deadlineMono || errCode === 'ETIMEDOUT') return { ...base, status: 'timeout', called: true, timedOut: true };
    const stdout = typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout ?? '');
    const stderr = typeof result?.stderr === 'string' ? result.stderr : String(result?.stderr ?? '');
    const code = typeof result?.status === 'number' ? result.status : null;
    if (result?.error) return { ...base, status: 'fail', called: true, code, stdout, stderr: `${stderr}\n${String(errCode ?? result.error)}` };
    return { ...base, status: code === 0 ? 'ok' : 'fail', called: true, code, stdout, stderr };
  };
}

/**
 * The rows of `git worktree list --porcelain`, or null when a block has no `worktree` line.
 * A detached block has `branch: null` and is not counted.
 * @param {string} text
 * @returns {WorktreeRow[] | null}
 */
export function parseWorktreePorcelain(text) {
  const rows = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
    if (lines.length === 0) continue;
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt) return null;
    const head = lines.find((l) => l.startsWith('HEAD '));
    const branch = lines.find((l) => l.startsWith('branch '));
    const ref = branch ? branch.slice('branch '.length) : null;
    rows.push({
      path: wt.slice('worktree '.length),
      branch: ref && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
      head: head ? head.slice('HEAD '.length) : null,
    });
  }
  return rows;
}

/**
 * Parses a `gh pr list --json` answer into rows, or null when the JSON or a row's shape is wrong.
 * @param {string} text
 * @param {{ open: boolean }} kind
 * @returns {PrRow[] | null}
 */
export function parsePrRows(text, { open }) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const rows = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') return null;
    const { number, headRefName, headRefOid, baseRefName, isCrossRepository } = item;
    if (!Number.isInteger(number) || typeof headRefName !== 'string' || headRefName === '') return null;
    if (typeof headRefOid !== 'string' || typeof baseRefName !== 'string' || typeof isCrossRepository !== 'boolean') return null;
    let headOwner = null;
    if (open) {
      const owner = item.headRepositoryOwner;
      if (isCrossRepository) {
        if (!owner || typeof owner.login !== 'string' || owner.login === '') return null;
        headOwner = owner.login;
      } else if (owner && typeof owner.login === 'string') {
        headOwner = owner.login;
      }
    } else if (typeof item.mergedAt !== 'string') {
      return null;
    }
    rows.push({ number, headRefName, headRefOid, baseRefName, isCrossRepository, headOwner, ...(open ? {} : { mergedAt: item.mergedAt }) });
  }
  return rows;
}

/** The key a PR's head is counted under: its name, or `<owner>:<name>` for a fork (§1). */
export function prKey(pr) {
  return pr.isCrossRepository ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName;
}

/**
 * C and its parts, from an observation (X8: the one pure count, shared with #4367).
 * @param {WipInput} input
 * @returns {WipCount}
 */
export function countWip(input) {
  const exclude = new Set(input.exclude);
  const unmerged = [];
  const unknown = [];
  const excluded = [];
  const seen = new Set();
  const openKeys = new Set(input.openPrs.map(prKey));
  const consider = (key, fromWorktree) => {
    if (seen.has(key)) return;
    seen.add(key);
    if (exclude.has(key)) {
      excluded.push(key);
      return;
    }
    if (fromWorktree && !openKeys.has(key)) {
      const state = input.merged[key] ?? 'unknown';
      if (state === 'proved') return;
      if (state === 'unknown') unknown.push(key);
    }
    unmerged.push(key);
  };
  for (const wt of input.worktrees) if (wt.branch) consider(wt.branch, true);
  for (const pr of input.openPrs) consider(prKey(pr), false);
  return { unmerged, active: null, unknown, excluded, complete: unknown.length === 0 };
}

/**
 * The verdict of `check` for a counted observation (P2). `off` is decided by the caller first.
 * @param {{ count: WipCount, total: number }} options
 */
export function decideCheck({ count, total }) {
  if (!count.complete) return { verdict: 'unknown', exit: EXIT_WIP_UNKNOWN };
  if (count.unmerged.length >= total) return { verdict: 'full', exit: EXIT_WIP_FULL };
  return { verdict: 'room', exit: 0 };
}

const iso = (wallNow) => new Date(wallNow()).toISOString();

/**
 * Reads W, P and the merge proofs (§1, §6.1). Never throws for an answer it cannot use:
 * a whole source that fails is `{ ok: false, source, reason }`; one branch that cannot be
 * proved is `unknown` in `merged`.
 * @param {string} root
 * @param {{ run: ReturnType<typeof makeRunner>, deadlineMono: number, wallNow?: () => number, repo: string, base: string, exclude: string[], observedFrom?: string }} options
 * @returns {{ ok: true, input: WipInput } | { ok: false, source: string, reason: string }}
 */
export function readWipInput(root, options) {
  const { run, deadlineMono, repo, base, exclude } = options;
  const wallNow = options.wallNow ?? Date.now;
  const observedFrom = options.observedFrom ?? iso(wallNow);
  const git = (args, cwd = root) => run('git', args, { capMs: GIT_CAP_MS, deadlineMono, cwd });
  const gh = (args) => run('gh', args, { capMs: GH_CAP_MS, deadlineMono, cwd: root });
  const fail = (source, result, fallback) => ({
    ok: /** @type {false} */ (false),
    source,
    reason: result.status === 'timeout' ? 'timeout' : result.status === 'refused' ? 'refused' : fallback ?? `exit ${result.code ?? '?'}: ${result.stderr.trim().split('\n')[0] ?? ''}`.trim(),
  });

  const listed = git(['worktree', 'list', '--porcelain']);
  if (listed.status !== 'ok') return fail('git worktree list', listed);
  const worktrees = parseWorktreePorcelain(listed.stdout);
  if (worktrees === null) return { ok: false, source: 'git worktree list', reason: 'shape' };

  const open = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--base', base, '--limit', String(OPEN_PR_LIMIT), '--json', OPEN_PR_FIELDS]);
  if (open.status !== 'ok') return fail('gh pr list --state open', open);
  const openPrs = parsePrRows(open.stdout, { open: true });
  if (openPrs === null) return { ok: false, source: 'gh pr list --state open', reason: 'shape' };
  if (openPrs.length >= OPEN_PR_LIMIT) return { ok: false, source: 'gh pr list --state open', reason: 'truncated' };
  if (openPrs.some((pr) => pr.baseRefName !== base)) return { ok: false, source: 'gh pr list --state open', reason: 'shape' };

  const excludeSet = new Set(exclude);
  const openKeys = new Set(openPrs.map(prKey));
  const toProve = worktrees.filter((wt) => wt.branch && !excludeSet.has(wt.branch) && !openKeys.has(wt.branch));
  /** @type {WipInput['merged']} */
  const merged = {};

  if (toProve.length > 0) {
    // The window is a proof of existence only: a miss falls through to the per-branch search.
    const windowAnswer = gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', base, '--limit', String(MERGED_WINDOW_LIMIT), '--json', MERGED_PR_FIELDS]);
    const windowRows = windowAnswer.status === 'ok' ? parsePrRows(windowAnswer.stdout, { open: false }) ?? [] : [];

    // The ancestor proof is used only when origin/<base> is what GitHub has now (E8〜E10).
    const remoteRef = `refs/remotes/origin/${base}`;
    let ancestorUsable = false;
    const local = git(['rev-parse', '--verify', remoteRef]);
    if (local.status === 'ok') {
      const remote = gh(['api', `repos/${repo}/branches/${base}`, '--jq', '.commit.sha']);
      const a = local.stdout.trim();
      const b = remote.status === 'ok' ? remote.stdout.trim() : '';
      ancestorUsable = SHA.test(a) && a === b;
    }

    const proves = (pr, branch, tip) => pr.headRefName === branch && pr.headRefOid === tip && pr.baseRefName === base && pr.isCrossRepository === false;

    for (const wt of toProve) {
      const branch = /** @type {string} */ (wt.branch);
      const before = git(['rev-parse', 'HEAD'], wt.path);
      const tip = before.status === 'ok' ? before.stdout.trim() : '';
      if (!SHA.test(tip)) {
        merged[branch] = 'unknown';
        continue;
      }
      let state = /** @type {'proved' | 'not-proved' | 'unknown'} */ ('not-proved');
      if (windowRows.some((pr) => proves(pr, branch, tip))) {
        state = 'proved';
      } else {
        const byBranch = gh(['pr', 'list', '--repo', repo, '--head', branch, '--base', base, '--state', 'merged', '--limit', String(MERGED_BRANCH_LIMIT), '--json', MERGED_PR_FIELDS]);
        const rows = byBranch.status === 'ok' ? parsePrRows(byBranch.stdout, { open: false }) : null;
        if (rows !== null && rows.some((pr) => proves(pr, branch, tip))) {
          state = 'proved';
        } else {
          const prUnknown = rows === null || rows.length >= MERGED_BRANCH_LIMIT;
          let ancestor = 'not-proved';
          if (ancestorUsable) {
            const answer = git(['merge-base', '--is-ancestor', tip, remoteRef]);
            ancestor = answer.status === 'ok' ? 'proved' : answer.status === 'fail' && answer.code === 1 ? 'not-proved' : 'unknown';
          }
          state = ancestor === 'proved' ? 'proved' : prUnknown || ancestor === 'unknown' ? 'unknown' : 'not-proved';
        }
      }
      // The tip read again after the proofs: a branch that moved meanwhile is not judged (E11).
      const after = git(['rev-parse', 'HEAD'], wt.path);
      if (after.status !== 'ok' || after.stdout.trim() !== tip) state = 'unknown';
      merged[branch] = state;
    }
  }

  return {
    ok: true,
    input: { repo, base, exclude: [...exclude], worktrees, openPrs, merged, observedFrom, observedTo: iso(wallNow) },
  };
}

/**
 * @param {string[]} argv
 * @returns {{ options: { command: 'count' | 'check', worktree: string | null, deadlineSec: number, json: boolean } } | { error: string }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'count' && command !== 'check') return { error: `unknown command ${command ?? '(none)'}` };
  const options = { command, worktree: /** @type {string | null} */ (null), deadlineSec: DEFAULT_DEADLINE_SEC, json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--worktree') {
      const value = rest[++i];
      if (value === undefined || value === '' || value.startsWith('--')) return { error: '--worktree needs a path' };
      options.worktree = value;
    } else if (arg === '--deadline-sec') {
      const value = rest[++i];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_DEADLINE_SEC) {
        return { error: `--deadline-sec must be an integer from 1 to ${MAX_DEADLINE_SEC}` };
      }
      options.deadlineSec = Number(value);
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  return { options };
}

function shownBranches(names) {
  const head = names.slice(0, SHOWN_BRANCHES).join(', ');
  return names.length > SHOWN_BRANCHES ? `${head}, … (${names.length - SHOWN_BRANCHES} more)` : head || '(none)';
}

/**
 * The CLI (design §5). `deps` replaces the process: `spawnSync`, `monoNow`, `wallNow`, `cwd`,
 * `env`, `fs`, `stdout`, `stderr`, and the caller's `deadlineMono` (kept when it is shorter, D7).
 * @param {string[]} argv
 * @param {Record<string, any>} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    return runMain(argv, deps, stdout, stderr);
  } catch (err) {
    stderr(`flow-wip: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function runMain(argv, deps, stdout, stderr) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    stderr(`flow-wip: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { command, json } = parsed.options;
  const monoNow = deps.monoNow ?? defaultMonoNow;
  const wallNow = deps.wallNow ?? Date.now;
  const spawn = deps.spawnSync ?? nodeSpawnSync;
  const own = monoNow() + parsed.options.deadlineSec * 1000;
  const deadlineMono = typeof deps.deadlineMono === 'number' && Number.isFinite(deps.deadlineMono) ? Math.min(own, deps.deadlineMono) : own;
  const run = makeRunner({ spawnSync: spawn, monoNow });
  const worktree = path.resolve(deps.cwd ?? process.cwd(), parsed.options.worktree ?? '.');
  const observedFrom = iso(wallNow);

  const emit = (object) => {
    if (json) stdout(JSON.stringify(object));
  };
  const cannot = (source, reason, extra = {}) => {
    stderr(`WIP could not be judged${extra.repo ? ` for ${extra.repo} (base ${extra.base})` : ''}: ${source}: ${reason}. ${ADVISORY}. Do not start a new lane; check ${source}, then run ${command} again.`);
    if (command === 'check') {
      emit({ verdict: 'unknown', advisory: true, repo: extra.repo ?? null, base: extra.base ?? null, total: extra.total ?? null, unmerged: null, unknown: null, excluded: null, complete: false, observedFrom, observedTo: iso(wallNow), source, reason });
    } else {
      emit({ ok: false, repo: extra.repo ?? null, base: extra.base ?? null, source, reason, observedFrom, observedTo: iso(wallNow) });
    }
    return EXIT_WIP_UNKNOWN;
  };
  const configError = (message) => {
    stderr(`flow-wip: settings: ${message}`);
    return EXIT_USAGE;
  };

  // Root: the main worktree of the target's repository, from its common dir (P8).
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { capMs: GIT_CAP_MS, deadlineMono, cwd: worktree });
  if (common.status === 'timeout') return cannot('git rev-parse', 'timeout');
  const commonDir = common.status === 'ok' ? common.stdout.trim() : '';
  if (commonDir === '' || path.basename(commonDir) !== '.git') return configError(`${worktree} is not inside a git repository with a main worktree`);
  const root = path.dirname(commonDir);

  const raw = readRawFlowConfig(root, { fs: deps.fs });
  if ('error' in raw) return configError(raw.error);
  if (command === 'check' && raw.wip === null) {
    // P6: off resolves nothing — no remote, no base, no GitHub.
    stderr('wip: off (no limit configured). advisory only.');
    emit({ verdict: 'off', advisory: true, repo: null, base: null, total: null, unmerged: null, unknown: null, excluded: null, complete: null, observedFrom, observedTo: iso(wallNow) });
    return 0;
  }

  const runBounded = makeRunBounded({ run: spawn, monoNow });
  const scope = readFlowConfig(root, { runBounded, env: deps.env ?? process.env, deadlineMono, fs: deps.fs });
  if ('error' in scope) {
    if (/timed out/.test(scope.error)) return cannot('identification', 'timeout');
    return configError(scope.error);
  }
  const { repo, base, exclude } = scope;
  if (!REPO_NAME.test(repo) || !isRef(base)) return configError('repo or base has an unexpected shape');
  const total = raw.wip?.total ?? null;

  const read = readWipInput(root, { run, deadlineMono, wallNow, repo, base, exclude, observedFrom });
  if (!read.ok) return cannot(read.source, read.reason, { repo, base, total });
  const count = countWip(read.input);
  const { observedTo } = read.input;
  const window = `observed ${observedFrom}–${observedTo}`;

  if (command === 'count') {
    stderr(`WIP count for ${repo} (base ${base}): ${count.unmerged.length} unmerged${count.complete ? '' : ` (upper bound; unknown: ${shownBranches(count.unknown)})`}, ${window}.`);
    emit({ ok: true, repo, base, unmerged: count.unmerged, active: null, unknown: count.unknown, excluded: count.excluded, complete: count.complete, observedFrom, observedTo });
    return 0;
  }

  const decision = decideCheck({ count, total: /** @type {number} */ (total) });
  const n = count.unmerged.length;
  if (decision.verdict === 'unknown') {
    stderr(`WIP could not be judged for ${repo} (base ${base}): merge proof: ${count.unknown.length} branch(es) unknown (${shownBranches(count.unknown)}); upper bound ${n}/${total}, ${window}. ${ADVISORY}. Do not start a new lane; check git and gh, then run check again.`);
  } else if (decision.verdict === 'full') {
    stderr(`WIP full for ${repo} (base ${base}): ${n}/${total} unmerged branches, ${window}. ${ADVISORY}. Do not start a new lane; merge existing work first. Unmerged: ${shownBranches(count.unmerged)}.`);
  } else {
    stderr(`WIP room for ${repo} (base ${base}): ${n}/${total}, ${window}. ${ADVISORY}; another lane may take it.`);
  }
  emit({
    verdict: decision.verdict,
    advisory: true,
    repo,
    base,
    total,
    unmerged: count.unmerged,
    unknown: count.unknown,
    excluded: count.excluded,
    complete: count.complete,
    observedFrom,
    observedTo,
    ...(decision.verdict === 'unknown' ? { source: 'merge proof', reason: 'unknown branches' } : {}),
  });
  return decision.exit;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
