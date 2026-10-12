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
 *     The task list is read while waiting and right before every verification;
 *     a newer task ends the call without a verdict.
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
 * 2 is a usage error; 1 means the verdict
 * could not be recorded.
 *
 * Usage:
 *   node scripts/orchestrate/wait-verify.mjs --run-dir <dir> --issues <range> --issue <N>
 *        --wt <worktree-id> --worktree <path> --instance <agent>
 *        [--task <id>] [--model <opus|sonnet|->] [--timeout <sec>] [--log <file>]
 *        [--after-reinstruct] [--require-signal] [--signal-timeout <sec>] [--cli <commandmatedev>]
 *   node scripts/orchestrate/wait-verify.mjs --auto-yes-off --wt <worktree-id> --instance <agent> [--cli <commandmatedev>]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord } from './run-log.mjs';
import { dirtyPaths } from './dirty-tree.mjs';

export const DEFAULT_TIMEOUT_SEC = 10800;
export const DEFAULT_SIGNAL_TIMEOUT_SEC = 1800;
export const SIGNAL_POLL_SEC = 30;
export const AUTO_YES_ATTEMPTS = 3;
/** How often a watched wait looks for its exit status; the task list is read every SIGNAL_POLL_SEC. */
export const EXIT_POLL_MS = 500;
/** Tasks read to find a newer one (newest first). */
export const TASK_LIST_LIMIT = 20;
/** Exit codes that are a verdict: the gates ran and judged the work. */
export const VERDICT_EXIT_CODES = [0, 20, 21];
/** The verdict could not be tied to the finished work. */
export const UNCONFIRMED_EXIT = 3;
/** Instances whose turn end is not trusted as completion without the signal (3-3, #2605). */
export const SIGNAL_INSTANCES = ['antigravity'];
const EXIT_MEANINGS = {
  0: 'passed',
  20: 'failed',
  21: 'no-work',
  10: 'prompt',
  124: 'timeout',
};

function readExitFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
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
 * not make the wait return later.
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
    fs.rmSync(exitFile, { force: true });
    const child = spawn('sh', ['-c', '"$@"; echo $? > "$CM_WATCHED_EXIT_FILE"', 'sh', command, ...args], {
      cwd,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, CM_WATCHED_EXIT_FILE: exitFile },
    });
    child.unref();
    try {
      let sinceWatch = 0;
      for (;;) {
        const status = readExitFile(exitFile);
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
    } finally {
      fs.rmSync(exitFile, { force: true });
    }
  } finally {
    fs.closeSync(fd);
  }
}

function defaultRun(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

/** Whether a pane shows the completion signal on a line of its own (3-3: the goal text also contains the word). */
export function hasCompletionSignal(pane) {
  return pane
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .some((line) => /^[\s]*IMPL_COMPLETED[\s]*$/.test(line));
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

/** Epoch ms the newest verification run of the worktree started, or null. */
function latestRunStart(run, cli, wt, cwd) {
  const runs = readJson(run, cli, ['verify', 'history', '--worktree', wt, '--limit', '1', '--json'], cwd);
  const started = Array.isArray(runs) && runs[0] ? Date.parse(runs[0].startedAt) : NaN;
  return Number.isFinite(started) ? started : null;
}

/** The instance a task was sent to: its instance id, or the agent's primary instance. */
const taskInstance = (task) => task.instanceId ?? task.cliToolId;

/**
 * The task this call is about, as `{ id, createdAt }` (epoch ms), taken before
 * the wait: `--task` when given, otherwise the instance's newest task. A task
 * missing from the list (or no task at all) is dated by the start of this call.
 */
export function baselineTask(tasks, instance, taskId, startedMs) {
  const list = Array.isArray(tasks) ? tasks : [];
  const own = taskId ? list.find((t) => t?.id === taskId) : list.find((t) => t && taskInstance(t) === instance);
  const createdAt = own ? Date.parse(own.createdAt) : NaN;
  return { id: taskId ?? own?.id ?? null, createdAt: Number.isFinite(createdAt) ? createdAt : startedMs };
}

/**
 * The newest task of the same instance created after `baseline`, or null (#3587).
 * A second contract sent to the worktree is such a task: the turn end the wait
 * reads then belongs to it, not to the baseline.
 */
export function newerTask(tasks, instance, baseline) {
  if (!Array.isArray(tasks)) return null;
  for (const task of tasks) {
    if (!task || task.id === baseline.id || taskInstance(task) !== instance) continue;
    const createdAt = Date.parse(task.createdAt);
    if (Number.isFinite(createdAt) && createdAt > baseline.createdAt) return task;
  }
  return null;
}

/** The worktree's tasks, newest first, or null when they cannot be read (the check is then skipped). */
function readTasks(run, cli, wt, cwd) {
  const tasks = readJson(run, cli, ['task', 'list', wt, '--limit', String(TASK_LIST_LIMIT), '--json'], cwd);
  return Array.isArray(tasks) ? tasks : null;
}

/** The reason recorded after `unconfirmed:` when a newer task took over the worktree. */
export function supersededReason(newer, baseline) {
  return `a newer task ${newer.id} was created for this instance after task ${baseline.id ?? '-'}`;
}

/**
 * Turn Auto-Yes off and read it back, retrying. Asked on every call — a failure
 * on one call is not remembered as "done" by the next.
 *
 * @returns {'off' | 'NOT-disabled'}
 */
export function disableAutoYes({ run, sleep, cli, wt, instance, cwd, error }) {
  let last = '';
  for (let attempt = 1; attempt <= AUTO_YES_ATTEMPTS; attempt++) {
    const off = run(cli, ['auto-yes', wt, '--disable', '--instance', instance], { cwd });
    if (off.status === 0) {
      // `autoYes` is absent when the session is not running; only `enabled: true` is "still on".
      const state = readJson(run, cli, ['capture', wt, '--instance', instance, '--json'], cwd);
      if (state?.autoYes?.enabled !== true) return 'off';
      last = 'still enabled after --disable';
    } else {
      last = (off.stderr || off.stdout).trim();
    }
    if (attempt < AUTO_YES_ATTEMPTS) sleep(2000);
  }
  error(`WARNING: auto-yes --disable failed for ${wt} (${instance}): ${last} (after ${AUTO_YES_ATTEMPTS} attempts)`);
  return 'NOT-disabled';
}

/**
 * Tie a verdict to the finished work (3-3).
 *
 * @returns {{ state: 'confirmed' | 'working' | 'dirty', exitCode: number, log: string, reason: string, reverified: boolean }}
 */
export function confirmCompletion(ctx) {
  const { run, sleep, now, o, cwd, verdict } = ctx;
  let { exitCode, log } = verdict;
  const notes = [];

  // 1. The completion signal, for instances whose turn end can come mid-work.
  if (o.requireSignal || SIGNAL_INSTANCES.includes(o.instance)) {
    const deadline = now().getTime() + Number(o.signalTimeout) * 1000;
    for (;;) {
      const pane = run(o.cli, ['capture', o.wt, '--instance', o.instance, '--pane', '--tail', '40'], { cwd });
      if (pane.status === 0 && hasCompletionSignal(pane.stdout)) break;
      const newer = ctx.supersededBy?.();
      if (newer) return { state: 'working', exitCode, log, reason: newer, reverified: false };
      if (now().getTime() >= deadline) {
        return { state: 'working', exitCode, log, reason: `no IMPL_COMPLETED line within ${o.signalTimeout}s`, reverified: false };
      }
      sleep(SIGNAL_POLL_SEC * 1000);
    }
    notes.push('signal=seen');
  }

  // 2. Did the verification see the final state? It did not if a commit landed
  //    after it started, or if it started before the last turn end and the tree
  //    has changed since (3-3 "before-signal").
  const started = latestRunStart(run, o.cli, o.wt, cwd);
  const state = readJson(run, o.cli, ['capture', o.wt, '--instance', o.instance, '--json'], cwd);
  const lastStop = typeof state?.lastStopEventAt === 'number' ? state.lastStopEventAt : null;
  const committedAt = Date.parse(git(run, o.worktree, ['log', '-1', '--format=%cI']).trim());
  const dirty = dirtyPaths(run, o.worktree);
  const beforeSignal = started !== null && lastStop !== null && started < lastStop;
  const committedAfter = started !== null && Number.isFinite(committedAt) && committedAt > started;
  if (started === null) notes.push('run-start=unknown');
  if (lastStop === null) notes.push('last-stop=unknown');

  let reverified = false;
  if (committedAfter || (beforeSignal && dirty.length > 0)) {
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
    exitCode = ctx.spawnToLog(o.cli, ['verify', o.wt, '--task', o.taskId], { cwd, logFile: reLog });
    log = fs.existsSync(reLog) ? fs.readFileSync(reLog, 'utf8') : '';
    reverified = true;
    notes.push('reverified=verify --task');
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
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{
 *   spawnToLog?: typeof defaultSpawnToLog,
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
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const cwd = process.cwd();

  try {
    if (o.autoYesOff) {
      const autoYes = disableAutoYes({ run, sleep, cli: o.cli, wt: o.wt, instance: o.instance, cwd, error });
      log(`auto-yes ${o.wt} (${o.instance}): ${autoYes}`);
      return autoYes === 'off' ? 0 : 1;
    }

    const issue = Number(o.issue);
    o.logFile = o.log ?? path.join(o.runDir, `wait-${issue}.log`);
    const started = now();
    const baseline = baselineTask(readTasks(run, o.cli, o.wt, cwd), o.instance, o.taskId, started.getTime());
    /** The reason a newer task makes a verdict on `baseline` meaningless, or null (#3587). */
    const supersededBy = () => {
      const newer = newerTask(readTasks(run, o.cli, o.wt, cwd), o.instance, baseline);
      return newer ? supersededReason(newer, baseline) : null;
    };
    let superseded = null;
    // Asked while the wait runs. Once the wait has started verifying, stopping
    // it would not stop the server's run; the check after the wait handles that.
    const watch = () => {
      const sofar = fs.existsSync(o.logFile) ? fs.readFileSync(o.logFile, 'utf8') : '';
      if (/^Verifying:/m.test(sofar)) return false;
      superseded = supersededBy();
      return superseded !== null;
    };
    const waitArgs = [
      'wait', o.wt, '--instance', o.instance, '--on-prompt', 'human',
      ...(o.afterReinstruct ? [] : ['--verify']),
      '--timeout', o.timeout,
    ];
    let exitCode = spawnToLog(o.cli, waitArgs, { cwd, logFile: o.logFile, watch });
    let verdictLog = fs.existsSync(o.logFile) ? fs.readFileSync(o.logFile, 'utf8') : '';
    // The wait returned (or verified) on the newer task's turn end.
    if (!superseded && VERDICT_EXIT_CODES.includes(exitCode)) superseded = supersededBy();

    if (o.afterReinstruct && exitCode === 0 && !superseded) {
      // 3-4: `wait` → `verify --task`. The gates are the contract's plus the builtins.
      const verifyLog = `${o.logFile.replace(/\.log$/, '')}.verify.log`;
      exitCode = spawnToLog(o.cli, ['verify', o.wt, '--task', o.taskId], { cwd, logFile: verifyLog });
      verdictLog = fs.existsSync(verifyLog) ? fs.readFileSync(verifyLog, 'utf8') : '';
    }

    const record = (result, head, note) => {
      const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
      const { file } = appendRecord(
        o.runDir,
        o.issues,
        { issue, stage: 'verify', result, head, taskId: o.taskId, agent: o.instance, model: o.model, durationSec, note },
        now()
      );
      log(`verify #${issue} ${head.slice(0, 7)} ${result}: ${note}`);
      log(`recorded -> ${file} (log: ${o.logFile})`);
    };
    const headNow = () => git(run, o.worktree, ['rev-parse', 'HEAD']).trim();

    if (superseded) {
      // The worker is working on the newer task: Auto-Yes stays, and no verdict is taken on the old one.
      record('fail', headNow(), `unconfirmed: ${superseded}; ${summarizeVerdict(verdictLog, exitCode).line} auto-yes=kept`);
      return UNCONFIRMED_EXIT;
    }

    if (!VERDICT_EXIT_CODES.includes(exitCode)) {
      // No verdict (prompt, timeout, error): the worker may still be working, so Auto-Yes stays.
      record('fail', headNow(), `${summarizeVerdict(verdictLog, exitCode).line} auto-yes=kept`);
      return exitCode;
    }

    const confirmed = confirmCompletion({
      run, sleep, now, spawnToLog, o, cwd, verdict: { exitCode, log: verdictLog }, supersededBy,
    });
    const verdict = summarizeVerdict(confirmed.log, confirmed.exitCode);
    if (confirmed.state === 'working') {
      record('fail', headNow(), `unconfirmed: ${confirmed.reason}; ${verdict.line} auto-yes=kept`);
      return UNCONFIRMED_EXIT;
    }

    // The worker's turn is over: nothing is left for Auto-Yes to answer.
    const autoYes = disableAutoYes({ run, sleep, cli: o.cli, wt: o.wt, instance: o.instance, cwd, error });
    // The tree is clean here (or the record is a fail), so this HEAD is what the verification saw.
    const head = headNow();
    if (confirmed.state === 'dirty') {
      record('fail', head, `unconfirmed: ${confirmed.reason}; ${verdict.line} auto-yes=${autoYes}`);
      return confirmed.exitCode === 0 ? UNCONFIRMED_EXIT : confirmed.exitCode;
    }
    const extra = confirmed.reason ? ` ${confirmed.reason}` : '';
    record(confirmed.exitCode === 0 ? 'ok' : 'fail', head, `${verdict.line}${extra} auto-yes=${autoYes}`);
    return confirmed.exitCode;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
