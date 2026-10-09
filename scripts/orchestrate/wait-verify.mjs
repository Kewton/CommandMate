#!/usr/bin/env node
/**
 * `/orchestrate` 3-3: wait for a worker, verify it, turn Auto-Yes off, and
 * record the verdict in the run record (Issue #3477).
 *
 * The 2026-10-06〜07 runs rebuilt this loop in the session scratchpad. Three
 * things were easy to lose with it:
 *   - `--instance` and `--on-prompt human` on every wait (3-3);
 *   - Auto-Yes left on after the verdict: a worker that parks `/create-pr` in
 *     its composer gets it confirmed by the next Auto-Yes Enter;
 *   - the verdict itself, which lived only in the wait log. It now goes to the
 *     `verify` stage of `run-log.mjs`, bound to the HEAD it judged, so a resumed
 *     run does not wait on (and re-verify) a worker that already passed.
 *
 * Exit code: the wait's own (0 pass / 20 fail / 21 no work / 10 prompt /
 * 124 timeout …), so 3-4's table still applies. 2 is a usage error; 1 means the
 * verdict could not be recorded.
 *
 * Usage:
 *   node scripts/orchestrate/wait-verify.mjs --run-dir <dir> --issues <range> --issue <N>
 *        --wt <worktree-id> --worktree <path> --instance <agent>
 *        [--task <id>] [--model <opus|sonnet|->] [--timeout <sec>] [--log <file>]
 *        [--after-reinstruct] [--force] [--cli <commandmatedev>]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, findLatest, readRecords } from './run-log.mjs';

export const DEFAULT_TIMEOUT_SEC = 10800;
/** Exit codes that are a verdict: the worker's turn is over, so Auto-Yes has nothing left to answer. */
export const VERDICT_EXIT_CODES = [0, 20, 21];
const EXIT_MEANINGS = {
  0: 'passed',
  20: 'failed',
  21: 'no-work',
  10: 'prompt',
  124: 'timeout',
};

/** Run a command, writing stdout and stderr to `logFile`; returns the exit status. */
function defaultSpawnToLog(command, args, { cwd, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'w');
  try {
    const result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd] });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    fs.closeSync(fd);
  }
}

function defaultRun(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The verdict lines of a `wait --verify` / `verify` log, folded into one line.
 * Reads `GATE <id> <LABEL>`, `RESULT <status>` and `Completed: … (basis=…)`
 * (src/cli/utils/verify-runner.ts, src/cli/commands/wait.ts).
 */
export function summarizeVerdict(log, exitCode) {
  const gates = [];
  for (const match of log.matchAll(/^GATE (\S+) ([A-Z]+)\b/gm)) gates.push({ id: match[1], label: match[2] });
  const result = [...log.matchAll(/^RESULT (\S+)/gm)].pop()?.[1] ?? null;
  const basis = [...log.matchAll(/^Completed: \S+ \(basis=([^),\s]+)/gm)].pop()?.[1] ?? null;
  // A gate counts as passed when it passed or was retried into a pass (FLAKY on a `passed` run).
  const passed = gates.filter((g) => g.label === 'PASS' || (g.label === 'FLAKY' && result === 'passed')).map((g) => g.id);
  const failed = gates.filter((g) => !passed.includes(g.id)).map((g) => `${g.id}:${g.label}`);
  const meaning = EXIT_MEANINGS[exitCode] ?? 'error';
  const line =
    `exit=${exitCode}(${meaning}) result=${result ?? '-'} basis=${basis ?? '-'} ` +
    `passed=${passed.join(',') || '-'} failed=${failed.join(',') || '-'}`;
  return { exitCode, meaning, result, basis, passed, failed, line };
}

function headOf(run, worktree) {
  const { status, stdout, stderr } = run('git', ['-C', worktree, 'rev-parse', 'HEAD']);
  if (status !== 0) throw new Error(`git rev-parse HEAD failed in ${worktree}: ${stderr.trim()}`);
  return stdout.trim();
}

const USAGE = `Usage:
  node scripts/orchestrate/wait-verify.mjs --run-dir <dir> --issues <range> --issue <N> --wt <worktree-id> --worktree <path> --instance <agent>
       [--task <id>] [--model <opus|sonnet|->] [--timeout <sec>] [--log <file>] [--after-reinstruct] [--force] [--cli <commandmatedev>]`;

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
  '--log': 'log',
  '--cli': 'cli',
};
const SWITCHES = { '--after-reinstruct': 'afterReinstruct', '--force': 'force' };

export function parseArgs(argv) {
  const options = { afterReinstruct: false, force: false, timeout: String(DEFAULT_TIMEOUT_SEC), cli: 'commandmatedev' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of ['--run-dir', '--issues', '--issue', '--wt', '--worktree', '--instance']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  if (!/^\d+$/.test(options.timeout)) return { error: `--timeout must be seconds (got ${options.timeout})` };
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
 *   now?: () => Date,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { spawnToLog = defaultSpawnToLog, run = defaultRun, now = () => new Date() } = deps;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const issue = Number(o.issue);
  const cwd = process.cwd();

  try {
    // A resumed run: this HEAD already passed, so waiting again would only re-verify
    // a finished task (and an unattached re-verify is exit 20 by construction, #3118).
    if (!o.force) {
      const head = headOf(run, o.worktree);
      const { records } = readRecords(o.runDir, o.issues);
      const done = findLatest(records, { issue, stage: 'verify', head });
      if (done && done.result === 'ok') {
        log(`verify #${issue} reused: ok at ${head.slice(0, 7)} (${done.at}) — pass --force to wait again`);
        return 0;
      }
    }

    const logFile = o.log ?? path.join(o.runDir, `wait-${issue}.log`);
    const started = now();
    const waitArgs = [
      'wait', o.wt, '--instance', o.instance, '--on-prompt', 'human',
      ...(o.afterReinstruct ? [] : ['--verify']),
      '--timeout', o.timeout,
    ];
    let exitCode = spawnToLog(o.cli, waitArgs, { cwd, logFile });
    let verdictLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

    if (o.afterReinstruct && exitCode === 0) {
      // 3-4: `wait` → `verify --task`. The gates are the contract's plus the builtins.
      const verifyLog = logFile.replace(/(\.log)?$/, '.verify.log');
      exitCode = spawnToLog(o.cli, ['verify', o.wt, '--task', o.taskId], { cwd, logFile: verifyLog });
      verdictLog = fs.existsSync(verifyLog) ? fs.readFileSync(verifyLog, 'utf8') : '';
    }
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);

    const verdict = summarizeVerdict(verdictLog, exitCode);
    let autoYes = 'kept';
    if (VERDICT_EXIT_CODES.includes(exitCode)) {
      const off = run(o.cli, ['auto-yes', o.wt, '--disable', '--instance', o.instance], { cwd });
      autoYes = off.status === 0 ? 'off' : 'NOT-disabled';
      if (off.status !== 0) {
        error(`WARNING: auto-yes --disable failed for ${o.wt} (${o.instance}): ${(off.stderr || off.stdout).trim()}`);
      }
    }

    const head = headOf(run, o.worktree);
    const note = `${verdict.line} auto-yes=${autoYes}`;
    const { file } = appendRecord(
      o.runDir,
      o.issues,
      {
        issue,
        stage: 'verify',
        result: exitCode === 0 ? 'ok' : 'fail',
        head,
        taskId: o.taskId,
        agent: o.instance,
        model: o.model,
        durationSec,
        note,
      },
      now()
    );
    log(`verify #${issue} ${head.slice(0, 7)} ${note}`);
    log(`recorded -> ${file} (log: ${logFile})`);
    return exitCode;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
