#!/usr/bin/env node
/**
 * `/orchestrate` 3-3: wait for a worker, verify it, confirm the verdict belongs
 * to the finished work, turn Auto-Yes off, and record the verdict in the run
 * record (Issue #3477).
 *
 * The 2026-10-06〜07 runs rebuilt this loop in the session scratchpad. What was
 * easy to lose with it:
 *   - `--instance` and `--on-prompt human` on every wait (3-3);
 *   - the completion checks of 3-3: a worker can close a turn mid-work (an
 *     Antigravity `schedule`, #2605), `wait` reads that turn end as completion,
 *     and the verification then judges an unfinished tree. A verdict is taken
 *     only after the completion signal (`IMPL_COMPLETED`, Antigravity) is on
 *     screen, no commit landed after the verification started, and the tree is
 *     clean; a verification that saw an earlier state is redone with
 *     `verify --task`;
 *   - Auto-Yes left on after the verdict: a worker that parks `/create-pr` in
 *     its composer gets it confirmed by the next Auto-Yes Enter. It is turned
 *     off only once the verdict is confirmed (the worker may still be working
 *     before that), retried, and read back;
 *   - the verdict itself, which lived only in the wait log. It goes to the
 *     `verify` stage of `run-log.mjs`, with the HEAD the verification saw;
 *   - a second contract sent to the same worktree and instance while this
 *     waits (#3587): the worker's turn end then belongs to the new task, and
 *     verifying the old one (narrower scope) only fails and holds the gates.
 *     When the ledger shows the task this call is about, the wait runs without
 *     `--verify` and this script starts `verify --task` itself, so the moment
 *     before a verification is its own. The task list is read while waiting,
 *     right before every verification and again before the verdict is taken;
 *     a newer task ends the call without a verdict. A `--task` older than the
 *     newest TASK_LIST_LIMIT is read on its own (`task show`), and a list that
 *     fails at the start is read again before the wait begins, so the call
 *     stays tied to the task it started on (#3633);
 *   - which execution a file or a signal belongs to (#3883). The log was
 *     `wait-<issue>.log` for every PR and every attempt of an Issue, and the
 *     watched wait's `.exit` next to it, so two calls could share a log and
 *     read each other's exit status. Each call now takes a log of its own
 *     (execution-key.mjs: `wait-<issue>[-<item>][.a<n>].log`, created
 *     exclusively; an existing `--log` is refused), the `.exit` carries a
 *     token only this call knows, and the record carries the work item and
 *     the execution key. The verification is judged by the run id it printed
 *     (`Verifying: <wt> (run <id>)`, read back with `verify show`), not by the
 *     newest run of the worktree. The completion signal is taken from this
 *     task's reply (`reply --since <task start>`), or from the pane only after
 *     a turn of this task ended, and is tied to the HEAD it was seen at; for
 *     an instance that needs it, no verification starts before it. A run of
 *     the worktree that is still going (`already in progress`, a
 *     re-instruction's old run) is waited out and the verification started
 *     again, and an Auto-Yes that cannot be read back after `--disable` is
 *     `unknown`, not `off`.
 *
 * A passed verdict is never reused: it belongs to a task, a contract and an
 * env-clean baseline taken when that task started, none of which a HEAD names.
 * Every call waits and verifies.
 *
 * Exit code: the verdict (0 pass / 20 fail / 21 no work) or the wait's own
 * (10 prompt / 124 timeout …), so 3-4's table still applies. 3 means the
 * verdict could not be tied to the finished work (no completion signal, a
 * commit after the verification started without a task to re-verify, or
 * uncommitted changes behind a pass, or a newer task for the same instance).
 * 2 is a usage error or an `--instance` the server cannot resolve (nothing is
 * sent then); 1 means the verdict
 * could not be recorded.
 *
 * Usage:
 *   node scripts/orchestrate/wait-verify.mjs --run-dir <dir> --issues <range> --issue <N>
 *        --wt <worktree-id> --worktree <path> --instance <agent>
 *        [--task <id>] [--model <opus|sonnet|->] [--timeout <sec>] [--log <file>]
 *        [--after-reinstruct] [--require-signal] [--signal-timeout <sec>] [--cli <commandmatedev>] [--item <work item>]
 *   node scripts/orchestrate/wait-verify.mjs --auto-yes-off --wt <worktree-id> --instance <agent> [--cli <commandmatedev>]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord } from './run-log.mjs';
import { dirtyPaths } from './dirty-tree.mjs';
import { resolveInstanceThroughCli } from './resolve-instance.mjs';
import { allocateLog, claimLog, executionKey, itemProblem, workItemName } from './execution-key.mjs';

export const DEFAULT_TIMEOUT_SEC = 10800;
export const DEFAULT_SIGNAL_TIMEOUT_SEC = 1800;
export const SIGNAL_POLL_SEC = 30;
export const AUTO_YES_ATTEMPTS = 3;
/** How often a watched wait looks for its exit status; the task list is read every SIGNAL_POLL_SEC. */
export const EXIT_POLL_MS = 500;
/** Tasks read to find a newer one (newest first). */
export const TASK_LIST_LIMIT = 20;
/** Upper bound for a side query (task list, instance roster): past it the check is skipped. */
export const QUERY_TIMEOUT_MS = 15_000;
/**
 * Reads of the task list before the wait starts (#3633 B): `wait --verify`
 * binds its task before polling (src/cli/commands/wait.ts), and the split path
 * does the same here, so a list that fails once does not leave the
 * verification without the task the wait began on.
 */
export const START_TASK_ATTEMPTS = 3;
export const START_TASK_RETRY_MS = 5_000;
/**
 * A verification of the worktree that is still running when this call starts
 * its own (`already in progress`, 409): waited for up to this long, polled
 * every SIGNAL_POLL_SEC, and the verification started again at most
 * VERIFY_BUSY_ATTEMPTS times (#3883).
 */
export const VERIFY_BUSY_TIMEOUT_SEC = 3600;
export const VERIFY_BUSY_ATTEMPTS = 3;
/** `wait`'s "no session was ever seen" (VerifyExitCode.NOT_STARTED); `wait --verify` still verifies it. */
const NOT_STARTED_EXIT = 21;
/** Exit codes that are a verdict: the gates ran and judged the work. */
export const VERDICT_EXIT_CODES = [0, 20, 21];
/** The verdict could not be tied to the finished work. */
export const UNCONFIRMED_EXIT = 3;
/**
 * Tools whose turn end is not trusted as completion without the signal (3-3,
 * #2605). Matched against the tool the instance runs (`cliToolId`), so a second
 * instance (`antigravity-2`) and an alias of it need the signal too (#3883).
 */
export const SIGNAL_INSTANCES = ['antigravity'];

/**
 * Whether the completion signal is needed before a verdict: `--require-signal`,
 * or an instance of a SIGNAL_INSTANCES tool. The tool is the one the server
 * resolved (`o.cliToolId`); a server that does not name it leaves the instance
 * id, and an id of the form `<tool>-<n>` (the roster's ids) counts as that tool.
 */
export function needsCompletionSignal(o) {
  if (o.requireSignal) return true;
  if (o.cliToolId) return SIGNAL_INSTANCES.includes(o.cliToolId);
  return SIGNAL_INSTANCES.some((tool) => o.instance === tool || String(o.instance).startsWith(`${tool}-`));
}
const EXIT_MEANINGS = {
  0: 'passed',
  20: 'failed',
  21: 'no-work',
  10: 'prompt',
  124: 'timeout',
};

/** The exit status in `file` written with `token`, or null (absent, half-written, or another writer's). */
function readExitFile(file, token) {
  try {
    const match = /^(\S+) (\d+)$/.exec(fs.readFileSync(file, 'utf8').trim());
    return match && match[1] === token ? Number(match[2]) : null;
  } catch {
    return null;
  }
}

/** Stop a watched command: its `sh` wrapper's children first, then the wrapper. */
function stopWatched(pid) {
  spawnSync('pkill', ['-TERM', '-P', String(pid)]);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/**
 * Run a command, writing stdout and stderr to `logFile`; returns the exit status.
 *
 * With `watch`, the command runs under `sh` (which writes its exit status next
 * to the log) so this synchronous caller can look around while it runs:
 * `watch()` is asked every `pollMs`, and a truthy answer stops the command
 * (#3587). The exit status is looked for every EXIT_POLL_MS, so watching does
 * not make the wait return later. The status is written with a token of this
 * call (#3883), so an `.exit` left by another attempt, or written by another
 * process to the same name, is never read as this command's status.
 */
export function defaultSpawnToLog(command, args, { cwd, logFile, watch, pollMs = SIGNAL_POLL_SEC * 1000 }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'w');
  try {
    if (!watch) {
      const result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd] });
      if (result.error) throw result.error;
      return result.status ?? 1;
    }
    const exitFile = `${logFile}.exit`;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.rmSync(exitFile, { force: true });
    const child = spawn('sh', ['-c', '"$@"; echo "$CM_WATCHED_EXIT_TOKEN $?" > "$CM_WATCHED_EXIT_FILE"', 'sh', command, ...args], {
      cwd,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, CM_WATCHED_EXIT_FILE: exitFile, CM_WATCHED_EXIT_TOKEN: token },
    });
    child.unref();
    try {
      let sinceWatch = 0;
      for (;;) {
        const status = readExitFile(exitFile, token);
        if (status !== null) return status;
        if (sinceWatch >= pollMs) {
          sinceWatch = 0;
          if (watch()) {
            stopWatched(child.pid);
            return 143;
          }
        }
        defaultSleep(EXIT_POLL_MS);
        sinceWatch += EXIT_POLL_MS;
      }
    } catch (err) {
      // A failing watch must not leave the wait running: it could still go on to verify.
      stopWatched(child.pid);
      throw err;
    } finally {
      fs.rmSync(exitFile, { force: true });
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Run a command and collect its output; `timeoutMs` kills it and throws (ETIMEDOUT) past that bound. */
export function defaultRun(command, args, { cwd, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The verdict lines of a `wait --verify` / `verify` log, folded into one line.
 * Reads `GATE <id> <LABEL> … [contract]`, `RESULT <status>` and
 * `Completed: … (basis=…)` (src/cli/utils/verify-runner.ts, src/cli/commands/wait.ts).
 * A gate the contract defined is listed as `<id>@contract`: its command is the
 * contract's, not verify.yaml's, so nothing outside this task may lean on it.
 */
export function summarizeVerdict(log, exitCode) {
  const gates = [];
  for (const match of log.matchAll(/^GATE (\S+) ([A-Z]+)\b.*$/gm)) {
    gates.push({ id: match[1], label: match[2], contract: match[0].endsWith(' [contract]') });
  }
  const result = [...log.matchAll(/^RESULT (\S+)/gm)].pop()?.[1] ?? null;
  const basis = [...log.matchAll(/^Completed: \S+ \(basis=([^),\s]+)/gm)].pop()?.[1] ?? null;
  const name = (g) => (g.contract ? `${g.id}@contract` : g.id);
  // A gate counts as passed when it passed or was retried into a pass (FLAKY on a `passed` run).
  const isPassed = (g) => g.label === 'PASS' || (g.label === 'FLAKY' && result === 'passed');
  const passed = gates.filter(isPassed).map(name);
  const failed = gates.filter((g) => !isPassed(g)).map((g) => `${name(g)}:${g.label}`);
  const meaning = EXIT_MEANINGS[exitCode] ?? 'error';
  const line =
    `exit=${exitCode}(${meaning}) result=${result ?? '-'} basis=${basis ?? '-'} ` +
    `passed=${passed.join(',') || '-'} failed=${failed.join(',') || '-'}`;
  return { exitCode, meaning, result, basis, passed, failed, line };
}

/**
 * Whether a pane (or a reply) shows the completion signal on a line of its own
 * (3-3: the goal text also contains the word). A signal that names its HEAD
 * (`IMPL_COMPLETED head=<sha>`) counts only for that HEAD when `head` is given
 * (#3883); the bare line the goal asks for counts as before, unless
 * `requireHead` (a pane read with a task known: only a line naming its HEAD).
 *
 * @param {string} pane
 * @param {{ head?: string, requireHead?: boolean }} [options]
 */
export function hasCompletionSignal(pane, { head, requireHead = false } = {}) {
  return pane
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .some((line) => {
      const match = /^[\s]*IMPL_COMPLETED(?:[\s]+head=([0-9a-f]{7,40}))?[\s]*$/.exec(line);
      if (!match) return false;
      if (!match[1]) return !requireHead;
      return !head || head.startsWith(match[1]);
    });
}

/** The id of the last verification run a `wait --verify` / `verify` log started (`Verifying: <wt> (run <id>)`), or null. */
export function runIdOf(log) {
  return [...log.matchAll(/^Verifying: \S+ \(run (\d+)\)/gm)].pop()?.[1] ?? null;
}

/**
 * The run that kept a verification from starting (`already in progress`, the
 * verify route's 409, src/cli/utils/verify-runner.ts), as `{ runId }` (null
 * when the message does not name it), or null when the log is not that.
 */
export function busyRunOf(log) {
  const match = /A verification run is already in progress for '[^']*'(?: \(run (\d+)\))?/.exec(log);
  return match ? { runId: match[1] ?? null } : null;
}

function git(run, worktree, args) {
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${worktree}: ${stderr.trim()}`);
  return stdout;
}

function readJson(run, cli, args, cwd) {
  const out = run(cli, args, { cwd });
  if (out.status !== 0) return null;
  try {
    return JSON.parse(out.stdout);
  } catch {
    return null;
  }
}

/**
 * One verification run by the id it printed (`verify show <id> --json`), or
 * null. Not the worktree's newest run (`history --limit 1`): after this run
 * ended another may have started, and its start time is not this verdict's
 * (#3883 H-5). A run of another worktree is not this one either.
 */
function readRun(run, cli, wt, runId, cwd) {
  if (!runId) return null;
  const shown = querySafely(run, cli, ['verify', 'show', String(runId), '--json'], cwd);
  const view = shown?.run ?? shown;
  return view && String(view.id) === String(runId) && (!view.worktreeId || view.worktreeId === wt) ? view : null;
}

/** Epoch ms the verification run `runId` started, or null. */
function runStart(run, cli, wt, runId, cwd) {
  const started = Date.parse(readRun(run, cli, wt, runId, cwd)?.startedAt);
  return Number.isFinite(started) ? started : null;
}

/**
 * A side query's JSON, or null. Bounded by QUERY_TIMEOUT_MS and never throws:
 * these checks are fail-open, and neither the wait nor its timeout may hang on them.
 */
function querySafely(run, cli, args, cwd) {
  try {
    const out = run(cli, args, { cwd, timeoutMs: QUERY_TIMEOUT_MS });
    if (out.status !== 0) return null;
    return JSON.parse(out.stdout);
  } catch {
    return null;
  }
}

/**
 * The instance id the server resolves `--instance` to (#3587 review 2-3): the
 * route `wait`, `capture` and `send` resolve through (primary anchor, then
 * roster id, then alias — exact before case-insensitive, ambiguity refused).
 * No rule of its own here.
 *
 * Asked through `--cli`, the CLI every other call of this script uses
 * (#3633 A): it decides the server from `.env`, `CM_BIND` and HTTPS, and a
 * wrapper given as `--cli` may change all of that, so a fixed `dist/` with this
 * process's environment could resolve against another server than the wait.
 *
 * @param {string} wt
 * @param {string} selector
 * `withTool` also returns the tool the instance runs (`cliToolId`), which
 * decides whether the completion signal is needed (#3883).
 *
 * @param {{ cwd?: string, cli?: string, run?: typeof defaultRun, withTool?: boolean }} [options]
 * @returns {{ instanceId: string, cliToolId?: string } | { error: string }}
 */
export function defaultResolveTarget(wt, selector, { cwd, cli = 'commandmatedev', run = defaultRun, withTool = false } = {}) {
  return resolveInstanceThroughCli(run, cli, wt, selector, { cwd, timeoutMs: QUERY_TIMEOUT_MS, withTool });
}

/** The instance a task was sent to: its instance id, or the agent's primary instance. */
const taskInstance = (task) => task.instanceId ?? task.cliToolId;

/**
 * The task this call is about, as `{ id, createdAt, found }` (createdAt in epoch
 * ms): `--task` when given, otherwise the instance's newest task created by the
 * start of this call (so a list first read after the call started does not take
 * a newer contract for the old one). `found` says the ledger shows it; a task
 * missing from the list (or no task at all) is dated by the start of this call.
 */
export function baselineTask(tasks, instance, taskId, startedMs) {
  const list = Array.isArray(tasks) ? tasks : [];
  const own = taskId
    ? list.find((t) => t?.id === taskId)
    : list.find((t) => t && taskInstance(t) === instance && !(Date.parse(t.createdAt) > startedMs));
  const createdAt = own ? Date.parse(own.createdAt) : NaN;
  return {
    id: taskId ?? own?.id ?? null,
    createdAt: Number.isFinite(createdAt) ? createdAt : startedMs,
    found: Boolean(own),
  };
}

/**
 * The newest task of the same instance created after `baseline`, or null (#3587).
 * A second contract sent to the worktree is such a task: the turn end the wait
 * reads then belongs to it, not to the baseline. While the baseline is in the
 * list, the list's order (created_at, then insertion) decides, so a task created
 * in the same millisecond after it still counts; otherwise creation times do.
 */
export function newerTask(tasks, instance, baseline) {
  if (!Array.isArray(tasks)) return null;
  const at = tasks.findIndex((t) => t?.id === baseline.id);
  const sameInstance = (t) => t && t.id !== baseline.id && taskInstance(t) === instance;
  if (at >= 0) return tasks.slice(0, at).find(sameInstance) ?? null;
  for (const task of tasks) {
    if (!sameInstance(task)) continue;
    const createdAt = Date.parse(task.createdAt);
    if (Number.isFinite(createdAt) && createdAt > baseline.createdAt) return task;
  }
  return null;
}

/** The worktree's tasks, newest first, or null when they cannot be read (the check is then skipped). */
function readTasks(run, cli, wt, cwd) {
  const tasks = querySafely(run, cli, ['task', 'list', wt, '--limit', String(TASK_LIST_LIMIT), '--json'], cwd);
  return Array.isArray(tasks) ? tasks : null;
}

/** One task by id (`task show --json`), or null when it cannot be read. */
function readTask(run, cli, taskId, cwd) {
  const detail = querySafely(run, cli, ['task', 'show', taskId, '--json'], cwd);
  const task = detail?.task;
  return task && task.id === taskId ? task : null;
}

/** The reason recorded after `unconfirmed:` when a newer task took over the worktree. */
export function supersededReason(newer, baseline) {
  return `a newer task ${newer.id} was created for this instance after task ${baseline.id ?? '-'}`;
}

/**
 * Turn Auto-Yes off and read it back, retrying. Asked on every call — a failure
 * on one call is not remembered as "done" by the next.
 *
 * A read-back that fails (capture exits non-zero, or its JSON does not parse)
 * is not "off" (#3883 H-7): the disable may well have worked, but nothing
 * confirmed it. It is asked again, and `unknown` if no read ever answers.
 *
 * @returns {'off' | 'NOT-disabled' | 'unknown'}
 */
export function disableAutoYes({ run, sleep, cli, wt, instance, cwd, error }) {
  let last = '';
  let outcome = 'NOT-disabled';
  for (let attempt = 1; attempt <= AUTO_YES_ATTEMPTS; attempt++) {
    const off = run(cli, ['auto-yes', wt, '--disable', '--instance', instance], { cwd });
    if (off.status === 0) {
      const state = readJson(run, cli, ['capture', wt, '--instance', instance, '--json'], cwd);
      // `autoYes` is absent when the session is not running; only `enabled: true` is "still on".
      if (state !== null && typeof state === 'object' && state.autoYes?.enabled !== true) return 'off';
      outcome = state === null || typeof state !== 'object' ? 'unknown' : 'NOT-disabled';
      last = outcome === 'unknown' ? 'the state could not be read back after --disable' : 'still enabled after --disable';
    } else {
      outcome = 'NOT-disabled';
      last = (off.stderr || off.stdout).trim();
    }
    if (attempt < AUTO_YES_ATTEMPTS) sleep(2000);
  }
  error(
    outcome === 'unknown'
      ? `WARNING: auto-yes for ${wt} (${instance}) is unknown: ${last} (after ${AUTO_YES_ATTEMPTS} attempts)`
      : `WARNING: auto-yes --disable failed for ${wt} (${instance}): ${last} (after ${AUTO_YES_ATTEMPTS} attempts)`
  );
  return outcome;
}

/**
 * Wait until the completion signal of this task is seen (3-3, #2605), and
 * name the HEAD it was seen at (#3883 H-6). With a task to date it by
 * (`since`: the task's creation), a signal is this task's only when
 *   - it is in this task's reply (`reply --since <task start> --json`: the
 *     transcript turns of the instance from the task's creation on), or
 *   - the reply has nothing (`reply: null` — no reply yet, or none written)
 *     or cannot be read, and the pane shows `IMPL_COMPLETED head=<sha>` naming
 *     the current HEAD, committed at or after the task was created: a commit
 *     of this task that an earlier task's line cannot name.
 * A bare `IMPL_COMPLETED` on the pane is not enough with a task known: the
 * line of an earlier task stays on the screen, and a turn of this task that
 * ended mid-work (`schedule`, a stop hook) does not make it this task's.
 * Nothing that ties the line to the task is "not yet", until --signal-timeout.
 * A signal that names its HEAD must name the current one. With no task to
 * date it by (`since` null: the ledger does not show the task), the pane line
 * is taken as before and noted `signal-task=unknown`.
 *
 * @returns {{ seen: true, head: string, note: string } | { seen: false, reason: string }}
 */
export function awaitCompletionSignal({ run, sleep, now, o, cwd, since, supersededBy }) {
  const deadline = now().getTime() + Number(o.signalTimeout) * 1000;
  const sinceIso = typeof since === 'number' ? new Date(since).toISOString() : null;
  for (;;) {
    const head = git(run, o.worktree, ['rev-parse', 'HEAD']).trim();
    const replied = sinceIso
      ? querySafely(run, o.cli, ['reply', o.wt, '--instance', o.instance, '--since', sinceIso, '--json'], cwd)
      : null;
    const reply = typeof replied?.reply === 'string' ? replied.reply : null;
    if (reply !== null) {
      if (hasCompletionSignal(reply, { head })) return { seen: true, head, note: 'signal=seen(reply)' };
    } else {
      const pane = run(o.cli, ['capture', o.wt, '--instance', o.instance, '--pane', '--tail', '40'], { cwd });
      const screen = pane.status === 0 ? pane.stdout : '';
      if (!sinceIso) {
        if (hasCompletionSignal(screen, { head })) return { seen: true, head, note: 'signal=seen signal-task=unknown' };
      } else if (hasCompletionSignal(screen, { head, requireHead: true })) {
        // The line names this HEAD; it is this task's when this HEAD is a commit of this task.
        const committedAt = Date.parse(git(run, o.worktree, ['log', '-1', '--format=%cI', head]).trim());
        if (Number.isFinite(committedAt) && committedAt >= since) return { seen: true, head, note: 'signal=seen(pane,head)' };
      }
    }
    const newer = supersededBy?.();
    if (newer) return { seen: false, reason: newer };
    if (now().getTime() >= deadline) return { seen: false, reason: `no IMPL_COMPLETED line within ${o.signalTimeout}s` };
    sleep(SIGNAL_POLL_SEC * 1000);
  }
}

/**
 * Run `verify` into `logFile`, and when another run of the worktree is still
 * going (`already in progress`: a re-instruction's old run, or one a person
 * started), wait for that run to end and start again (#3883 P4) — rather than
 * taking the 409's exit 99 as the result. The verdict is the run this call
 * started (its `Verifying: … (run <id>)` line), never the run waited for.
 *
 * @returns {{ exitCode: number, log: string, notes: string[], superseded: string | null }}
 */
export function runVerify({ spawnToLog, run, sleep, now, o, cwd, supersededBy }, args, logFile) {
  const notes = [];
  for (let attempt = 1; ; attempt++) {
    const exitCode = spawnToLog(o.cli, args, { cwd, logFile });
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const busy = VERDICT_EXIT_CODES.includes(exitCode) ? null : busyRunOf(log);
    if (!busy) return { exitCode, log, notes, superseded: null };
    const waited = awaitRunEnd({ run, sleep, now, o, cwd, supersededBy }, busy.runId);
    notes.push(`waited-for=run ${busy.runId ?? '?'}${waited.ended ? '' : '(still running)'}`);
    if (waited.superseded) return { exitCode, log, notes, superseded: waited.superseded };
    if (!waited.ended || attempt >= VERIFY_BUSY_ATTEMPTS) return { exitCode, log, notes, superseded: null };
  }
}

/** Wait for the verification run `runId` to leave `running` (or, unnamed, one poll interval). */
function awaitRunEnd({ run, sleep, now, o, cwd, supersededBy }, runId) {
  const deadline = now().getTime() + VERIFY_BUSY_TIMEOUT_SEC * 1000;
  for (;;) {
    if (!runId) {
      sleep(SIGNAL_POLL_SEC * 1000);
      return { ended: true, superseded: supersededBy?.() ?? null };
    }
    const view = readRun(run, o.cli, o.wt, runId, cwd);
    if (view && view.status !== 'running') return { ended: true, superseded: supersededBy?.() ?? null };
    const newer = supersededBy?.();
    if (newer) return { ended: false, superseded: newer };
    if (now().getTime() >= deadline) return { ended: false, superseded: null };
    sleep(SIGNAL_POLL_SEC * 1000);
  }
}

/**
 * Tie a verdict to the finished work (3-3).
 *
 * `ctx.signal` is the completion signal main() already waited for before the
 * verification (#3883); without it the signal, when one is needed, is waited
 * for here, as before. The verification's start is read by the run id its log
 * printed (H-5).
 *
 * @returns {{ state: 'confirmed' | 'working' | 'dirty', exitCode: number, log: string, reason: string, reverified: boolean }}
 */
export function confirmCompletion(ctx) {
  const { run, now, o, cwd, verdict } = ctx;
  let { exitCode, log } = verdict;
  const notes = [];

  // 1. The completion signal, for instances whose turn end can come mid-work.
  let signal = ctx.signal ?? null;
  if (!signal && needsCompletionSignal(o)) {
    const seen = awaitCompletionSignal({ ...ctx, since: ctx.since ?? null });
    if (!seen.seen) return { state: 'working', exitCode, log, reason: seen.reason, reverified: false };
    signal = seen;
  }
  if (signal) notes.push(signal.note);

  // 2. Did the verification see the final state? It did not if a commit landed
  //    after it started, if the HEAD moved after the completion signal, or if
  //    it started before the last turn end and the tree has changed since
  //    (3-3 "before-signal").
  const runId = runIdOf(log);
  const started = runStart(run, o.cli, o.wt, runId, cwd);
  const state = readJson(run, o.cli, ['capture', o.wt, '--instance', o.instance, '--json'], cwd);
  const lastStop = typeof state?.lastStopEventAt === 'number' ? state.lastStopEventAt : null;
  const committedAt = Date.parse(git(run, o.worktree, ['log', '-1', '--format=%cI']).trim());
  const dirty = dirtyPaths(run, o.worktree);
  const beforeSignal = started !== null && lastStop !== null && started < lastStop;
  const committedAfter = started !== null && Number.isFinite(committedAt) && committedAt > started;
  const movedSinceSignal = signal !== null && git(run, o.worktree, ['rev-parse', 'HEAD']).trim() !== signal.head;
  if (runId) notes.push(`run=${runId}`);
  if (started === null) notes.push('run-start=unknown');
  if (lastStop === null) notes.push('last-stop=unknown');

  let reverified = false;
  if (committedAfter || movedSinceSignal || (beforeSignal && dirty.length > 0)) {
    if (!o.taskId) {
      return {
        state: 'working',
        exitCode,
        log,
        reason: 'the verification saw an earlier state and there is no --task to re-verify',
        reverified,
      };
    }
    const newer = ctx.supersededBy?.();
    if (newer) return { state: 'working', exitCode, log, reason: newer, reverified };
    const reLog = `${o.logFile.replace(/\.log$/, '')}.reverify.log`;
    const reStart = now().getTime();
    const again = runVerify(ctx, ['verify', o.wt, '--task', o.taskId, '--instance', o.instance], reLog);
    ({ exitCode, log } = again);
    reverified = true;
    notes.push('reverified=verify --task', ...again.notes);
    if (again.superseded) return { state: 'working', exitCode, log, reason: again.superseded, reverified };
    const reRun = runIdOf(log);
    if (reRun) notes.push(`run=${reRun}`);
    const recommitted = Date.parse(git(run, o.worktree, ['log', '-1', '--format=%cI']).trim());
    if (Number.isFinite(recommitted) && recommitted > reStart) {
      return { state: 'working', exitCode, log, reason: 'a commit landed during the re-verification', reverified };
    }
  } else if (beforeSignal) {
    notes.push('timing=before-signal(no change since)');
  }

  const after = dirtyPaths(run, o.worktree);
  if (after.length > 0) {
    return { state: 'dirty', exitCode, log, reason: `uncommitted changes: ${after.slice(0, 5).join(', ')}`, reverified };
  }
  return { state: 'confirmed', exitCode, log, reason: notes.join(' '), reverified };
}

const USAGE = `Usage:
  node scripts/orchestrate/wait-verify.mjs --run-dir <dir> --issues <range> --issue <N> --wt <worktree-id> --worktree <path> --instance <agent>
       [--task <id>] [--model <opus|sonnet|->] [--timeout <sec>] [--log <file>] [--after-reinstruct] [--require-signal] [--signal-timeout <sec>] [--cli <commandmatedev>]
       [--item <work item>]
  node scripts/orchestrate/wait-verify.mjs --auto-yes-off --wt <worktree-id> --instance <agent> [--cli <commandmatedev>]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--wt': 'wt',
  '--worktree': 'worktree',
  '--instance': 'instance',
  '--task': 'taskId',
  '--model': 'model',
  '--timeout': 'timeout',
  '--signal-timeout': 'signalTimeout',
  '--log': 'log',
  '--cli': 'cli',
  '--item': 'item',
};
const SWITCHES = { '--after-reinstruct': 'afterReinstruct', '--require-signal': 'requireSignal', '--auto-yes-off': 'autoYesOff' };

export function parseArgs(argv) {
  const options = {
    afterReinstruct: false,
    requireSignal: false,
    autoYesOff: false,
    timeout: String(DEFAULT_TIMEOUT_SEC),
    signalTimeout: String(DEFAULT_SIGNAL_TIMEOUT_SEC),
    cli: 'commandmatedev',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  const required = options.autoYesOff
    ? ['--wt', '--instance']
    : ['--run-dir', '--issues', '--issue', '--wt', '--worktree', '--instance'];
  for (const flag of required) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  for (const flag of ['--timeout', '--signal-timeout']) {
    if (!/^\d+$/.test(options[FLAGS[flag]])) return { error: `${flag} must be seconds (got ${options[FLAGS[flag]]})` };
  }
  // 3-4: after a re-instruction the task has ended, so `wait --verify` would judge
  // an unattached run (scope SKIP, env-clean ERROR). The task must be named.
  if (options.afterReinstruct && !options.taskId) return { error: '--after-reinstruct needs --task <id>' };
  const badItem = itemProblem(options.item);
  if (badItem) return { error: badItem };
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{
 *   spawnToLog?: typeof defaultSpawnToLog,
 *   resolveTarget?: typeof defaultResolveTarget,
 *   run?: typeof defaultRun,
 *   sleep?: (ms: number) => void,
 *   now?: () => Date,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { spawnToLog = defaultSpawnToLog, run = defaultRun, sleep = defaultSleep, now = () => new Date() } = deps;
  const resolveTarget = deps.resolveTarget ?? defaultResolveTarget;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const cwd = process.cwd();

  // One id for everything that follows — the wait, the verifications, the task
  // comparison, capture and Auto-Yes: tasks carry the resolved id, not the alias.
  // Unresolvable means nothing is sent and nothing is waited for (#3587 review 2-3).
  const target = resolveTarget(o.wt, o.instance, { cwd, cli: o.cli, run, withTool: true });
  if ('error' in target) {
    error(`cannot resolve --instance '${o.instance}' in ${o.wt}: ${target.error}`);
    return 2;
  }
  o.instance = target.instanceId;
  o.cliToolId = target.cliToolId ?? null;

  try {
    if (o.autoYesOff) {
      const autoYes = disableAutoYes({ run, sleep, cli: o.cli, wt: o.wt, instance: o.instance, cwd, error });
      log(`auto-yes ${o.wt} (${o.instance}): ${autoYes}`);
      return autoYes === 'off' ? 0 : 1;
    }

    const issue = Number(o.issue);
    // A log of this attempt's own (#3883): the work item's next free name, or `--log` if it is new.
    let claimed;
    try {
      claimed = o.log ? claimLog(o.log) : allocateLog(o.runDir, 'wait', workItemName(issue, o.item));
    } catch (err) {
      if (!err?.usage) throw err;
      error(`${err.message}\n${USAGE}`);
      return 2;
    }
    o.logFile = claimed.file;
    const started = now();
    const instance = o.instance;
    /**
     * The baseline from a readable list. `--task` beyond the TASK_LIST_LIMIT
     * newest is read on its own, so the comparison goes on (by creation time)
     * rather than stopping (#3633 B). A `--task` the server does not show
     * either is not in the ledger: unwatched, as before.
     */
    const takeBaseline = (tasks) => {
      const listed = baselineTask(tasks, instance, o.taskId, started.getTime());
      if (listed.found || !o.taskId) return listed;
      const own = readTask(run, o.cli, o.taskId, cwd);
      const createdAt = own ? Date.parse(own.createdAt) : NaN;
      return Number.isFinite(createdAt) ? { id: o.taskId, createdAt, found: true } : listed;
    };
    let startTasks = readTasks(run, o.cli, o.wt, cwd);
    for (let attempt = 1; startTasks === null && attempt < START_TASK_ATTEMPTS; attempt++) {
      sleep(START_TASK_RETRY_MS);
      startTasks = readTasks(run, o.cli, o.wt, cwd);
    }
    let baseline = startTasks === null
      ? baselineTask(null, instance, o.taskId, started.getTime())
      : takeBaseline(startTasks);
    // An unreadable list at the start is not "no task": the baseline is taken
    // when the list reads again, and the call is watched meanwhile (#3587 review 2-2).
    let baselinePending = startTasks === null;
    // Watched when the ledger shows the task, or may yet show it. A readable
    // list without it leaves nothing to compare against.
    const watching = baseline.found || baselinePending;
    /** The reason a newer task makes a verdict on `baseline` meaningless, or null (#3587). */
    const supersededBy = () => {
      if (!watching) return null;
      const tasks = readTasks(run, o.cli, o.wt, cwd);
      if (tasks === null) return null;
      if (baselinePending) {
        baselinePending = false;
        baseline = takeBaseline(tasks);
      }
      if (!baseline.found) return null;
      const newer = newerTask(tasks, instance, baseline);
      return newer ? supersededReason(newer, baseline) : null;
    };
    let superseded = null;
    const watch = () => {
      superseded = supersededBy();
      return superseded !== null;
    };
    /** This attempt's execution key (execution-key.mjs): the task is the one the call is tied to. */
    const key = () =>
      executionKey({
        issues: o.issues,
        issue,
        item: o.item,
        taskId: o.taskId ?? (baseline.found ? baseline.id : null),
        attempt: claimed.attempt,
      });
    // Watched, the wait does not verify: `wait --verify` starts the verification
    // inside the CLI, where no check can come between the turn end and the run.
    // This script starts `verify` itself, after one more check (#3587). An
    // instance whose turn end can come mid-work is split too: its verification
    // starts only after its completion signal (#3883 P4), not at the hook_stop.
    const needsSignal = needsCompletionSignal(o);
    const split = o.afterReinstruct || watching || needsSignal;
    const waitArgs = [
      'wait', o.wt, '--instance', instance, '--on-prompt', 'human',
      ...(split ? [] : ['--verify']),
      '--timeout', o.timeout,
    ];
    let exitCode = spawnToLog(o.cli, waitArgs, { cwd, logFile: o.logFile, ...(watching ? { watch } : {}) });
    let verdictLog = fs.existsSync(o.logFile) ? fs.readFileSync(o.logFile, 'utf8') : '';
    const verifyCtx = { spawnToLog, run, sleep, now, o, cwd, supersededBy };
    /** Notes about the verification (a run waited for) that go into the record. */
    const verifyNotes = [];
    let signal = null;
    let signalMissing = null;

    // `wait --verify` whose verification could not start because another run
    // of the worktree was going: that run is waited out and this call verifies.
    const busyAfterWait = !split && !VERDICT_EXIT_CODES.includes(exitCode) && busyRunOf(verdictLog) !== null;
    const verifiable = exitCode === 0 || (!o.afterReinstruct && exitCode === NOT_STARTED_EXIT);
    if (((split && verifiable) || busyAfterWait) && !superseded) {
      superseded = supersededBy();
      if (!superseded && needsSignal && !busyAfterWait) {
        const seen = awaitCompletionSignal({ ...verifyCtx, since: baseline.found ? baseline.createdAt : null });
        if (seen.seen) signal = seen;
        else if (seen.reason.startsWith('a newer task ')) superseded = seen.reason;
        else signalMissing = seen.reason;
      }
      if (!superseded && !signalMissing) {
        // 3-4: `wait` → `verify --task`. The gates are the contract's plus the builtins.
        // The instance is passed as `wait --verify` passes it: OpenCode's work
        // evidence is read per instance, so leaving it out changes the verdict.
        // No task known (the list never read) leaves the task to the server, as `wait --verify` does.
        const verifyTask = o.taskId ?? (baseline.found ? baseline.id : null);
        const verifyLog = `${o.logFile.replace(/\.log$/, '')}.verify.log`;
        const verified = runVerify(
          verifyCtx,
          ['verify', o.wt, ...(verifyTask ? ['--task', verifyTask] : []), '--instance', instance],
          verifyLog
        );
        verifyNotes.push(...verified.notes);
        superseded = verified.superseded;
        verdictLog = o.afterReinstruct ? '' : verdictLog;
        verdictLog += verified.log;
        // As `wait --verify` folds it: a green run does not turn "never started" into a pass.
        exitCode = exitCode === NOT_STARTED_EXIT && verified.exitCode === 0 ? NOT_STARTED_EXIT : verified.exitCode;
      }
    }
    // A newer task that came while the verification ran: its verdict is not the old task's.
    if (!superseded && !signalMissing && VERDICT_EXIT_CODES.includes(exitCode)) superseded = supersededBy();
    const extraNotes = () => [...verifyNotes, `key=${key()}`].join(' ');

    const record = (result, head, note) => {
      const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
      const { file } = appendRecord(
        o.runDir,
        o.issues,
        {
          issue,
          stage: 'verify',
          result,
          head,
          taskId: o.taskId,
          agent: o.instance,
          model: o.model,
          durationSec,
          note,
          item: o.item,
          key: key(),
        },
        now()
      );
      log(`verify #${workItemName(issue, o.item)} ${head.slice(0, 7)} ${result}: ${note}`);
      log(`recorded -> ${file} (log: ${o.logFile})`);
    };
    const headNow = () => git(run, o.worktree, ['rev-parse', 'HEAD']).trim();

    if (superseded) {
      // The worker is working on the newer task: Auto-Yes stays, and no verdict is taken on the old one.
      record('fail', headNow(), `unconfirmed: ${superseded}; ${summarizeVerdict(verdictLog, exitCode).line} ${extraNotes()} auto-yes=kept`);
      return UNCONFIRMED_EXIT;
    }

    if (signalMissing) {
      // No signal: the turn end was mid-work, so nothing was verified and Auto-Yes stays.
      record('fail', headNow(), `unconfirmed: ${signalMissing}; ${summarizeVerdict(verdictLog, exitCode).line} ${extraNotes()} auto-yes=kept`);
      return UNCONFIRMED_EXIT;
    }

    if (!VERDICT_EXIT_CODES.includes(exitCode)) {
      // No verdict (prompt, timeout, error): the worker may still be working, so Auto-Yes stays.
      record('fail', headNow(), `${summarizeVerdict(verdictLog, exitCode).line} ${extraNotes()} auto-yes=kept`);
      return exitCode;
    }

    const confirmed = confirmCompletion({
      ...verifyCtx, verdict: { exitCode, log: verdictLog }, signal, since: baseline.found ? baseline.createdAt : null,
    });
    const verdict = summarizeVerdict(confirmed.log, confirmed.exitCode);
    if (confirmed.state === 'working') {
      record('fail', headNow(), `unconfirmed: ${confirmed.reason}; ${verdict.line} ${extraNotes()} auto-yes=kept`);
      return UNCONFIRMED_EXIT;
    }
    // Last check before the verdict is taken and Auto-Yes goes off (a re-verification or the signal wait may have run).
    const late = supersededBy();
    if (late) {
      record('fail', headNow(), `unconfirmed: ${late}; ${verdict.line} ${extraNotes()} auto-yes=kept`);
      return UNCONFIRMED_EXIT;
    }

    // The worker's turn is over: nothing is left for Auto-Yes to answer.
    const autoYes = disableAutoYes({ run, sleep, cli: o.cli, wt: o.wt, instance: o.instance, cwd, error });
    // The tree is clean here (or the record is a fail), so this HEAD is what the verification saw.
    const head = headNow();
    if (confirmed.state === 'dirty') {
      record('fail', head, `unconfirmed: ${confirmed.reason}; ${verdict.line} ${extraNotes()} auto-yes=${autoYes}`);
      return confirmed.exitCode === 0 ? UNCONFIRMED_EXIT : confirmed.exitCode;
    }
    const extra = confirmed.reason ? ` ${confirmed.reason}` : '';
    record(confirmed.exitCode === 0 ? 'ok' : 'fail', head, `${verdict.line}${extra} ${extraNotes()} auto-yes=${autoYes}`);
    return confirmed.exitCode;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
