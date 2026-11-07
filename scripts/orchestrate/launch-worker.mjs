#!/usr/bin/env node
/**
 * `/orchestrate` 3-1 / 3-5 / 3-5b: send a worker its contract, and for Claude
 * pin the contract's model and check the model the session runs on (Issue #3883 P3).
 *
 * Claude's model is fixed when the session starts, from the worktree's
 * `.claude/settings.local.json`. The runbook's `set_claude_model` wrote
 * `"sonnet"` for sonnet and deleted the key for opus, so an opus worker ran on
 * whatever `~/.claude/settings.json` said — the operator's global default,
 * which changes (fable on 2026-10-23, summary-3749-3839). The check after the
 * send then retried a mismatch once and went on with the wrong model.
 *
 * Here the model is always written explicitly (MODEL_SETTINGS), only into a
 * settings file git ignores, and the global settings are neither read nor
 * written. The contract is not what starts the session: a short message that
 * asks for no work (INIT_MESSAGE, no Auto-Yes) starts it, and the model the
 * session reports (`capture --json`'s `model`) must match before the contract
 * and Auto-Yes go out. Unknown or another model restarts the session once
 * (stop, write again, start again); still not matching, the session is stopped
 * and the call fails (40 / 41) with the contract never sent. Every stop is
 * checked — the kill's exit code and the instance no longer running — and a
 * stop that cannot be confirmed fails the call (42) without sending anything
 * more, so a session on the old model is never handed the contract. Auto-Yes
 * is armed per worktree × instance and outlives the session (a grant left on
 * answers whatever the next session shows), so before every start it is
 * turned off and read back off from the state store (`instances --json`'s
 * `autoYes`), whether a session ran or not; unconfirmed, nothing is sent (43).
 *
 * The send's output goes to `send-<issue>[-<item>][.a<n>].out` / `.err` in the
 * run directory (the starting message's to `send-init-…`), taken exclusively
 * (execution-key.mjs), so two sends of one Issue never write to the same
 * files. stdout is the task id only.
 *
 * The starting message is also what fixes the worker's role (Issue #4115): the
 * generation and injection fingerprint `capture --json` reports after it are read
 * again right before the contract. A difference means the process was replaced or
 * another role went in, and the contract is not sent (44). A change of the settings
 * while the process stays the same is the server's to refuse (`POST /tasks`, exit
 * of the `send`), since only the server can resolve them.
 *
 * What was read goes with the contract (Issue #4116), and the server reads it again
 * right before the first key: a process replaced after that last read, even with
 * the same role, gets nothing (`send` exit 32). That too is stopped and is 44.
 * A roster that moved under it is the `send`'s own 31: no contract, and the session
 * left for the next launch to stop. Either way the `send` withdraws the Auto-Yes it
 * armed and no other, so here it is only read back. No role read off a server that does
 * have roles (it restarted, and knows nothing of this process) is not "nothing to
 * pin": stopped and 44, unlike an older server or a tool roles do not apply to.
 *
 * Command Code (Issue #4238, the easy tier) has no Claude model: `--model -` only,
 * and nothing is written to `.claude/`. Its interactive permissions are fixed
 * when the session starts, from the worktree's `.commandcode/settings.local.json`
 * (else `.commandcode/settings.json`) `permissions.defaultMode`, and `ask` stops
 * on a confirmation screen even under Auto-Yes. So before the send that mode is
 * read; `ask`, or a settings file that is not a JSON object, sends nothing (45).
 *
 * Exit code (send): 0 sent (and for Claude the model matched before the
 * contract went out); 40 the model did not match after one restart; 41 the
 * model could not be read after one restart (the session is stopped and the
 * contract not sent in both); 42 a stop could not be confirmed (nothing more
 * sent); 43 Auto-Yes could not be confirmed off before the start, which includes
 * an instance list or roles that could not be read (nothing sent); 44 the role fixed at the starting message no longer holds (stopped, not
 * sent); 45 a Command Code worktree whose permissions default is `ask`, or
 * cannot be read (nothing sent); 2 a usage error (a Claude model for Command Code too) or a settings file git does not ignore (nothing
 * sent); 1 any other failure (the session did not come back ready after the
 * starting message: stopped, contract not sent); otherwise the `send`'s own
 * exit code (99 = not sent, 3-1's cold start; 31 / 32, see
 * docs/orchestrate/workers.md "3-1 send とワーカーの起動の exit code").
 *
 * Usage:
 *   node scripts/orchestrate/launch-worker.mjs send --run-dir <dir> --issue <N> [--item <work item>]
 *        --wt <worktree-id> --worktree <path> --instance <agent> --contract <file>
 *        [--model <opus|sonnet|->] [--duration <1h..24h>] [--cli <commandmatedev>]
 *   node scripts/orchestrate/launch-worker.mjs set-model --worktree <path> --model <opus|sonnet>
 *   node scripts/orchestrate/launch-worker.mjs check-model --wt <worktree-id> --model <opus|sonnet>
 *        [--instance <id>] [--cli <commandmatedev>]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { allocateLog, itemProblem, workItemName } from './execution-key.mjs';
import { defaultRun } from './wait-verify.mjs';

/**
 * The value written for each contract model. `opus[1m]` keeps the 1M context
 * the global default used to give (`"opus"` alone drops it); `sonnet` resolves
 * to the current Sonnet (claude 2.1.284, #2955).
 */
export const MODEL_SETTINGS = { opus: 'opus[1m]', sonnet: 'sonnet' };
export const SETTINGS_FILE = path.join('.claude', 'settings.local.json');
/** Reads of `capture --json` before the model counts as unknown, and the pause between them. */
export const MODEL_READS = 3;
export const MODEL_READ_INTERVAL_SEC = 20;
/** Sessions started per send: the first and one restart. */
export const LAUNCH_ATTEMPTS = 2;
/** `send`'s exit code for a message that was not delivered (3-1's cold start). */
export const EXIT_NOT_DELIVERED = 99;
export const EXIT_MODEL_MISMATCH = 40;
export const EXIT_MODEL_UNKNOWN = 41;
export const EXIT_STOP_UNCONFIRMED = 42;
export const EXIT_AUTO_YES_UNCONFIRMED = 43;
export const EXIT_ROLE_CHANGED = 44;
/** A Command Code worktree that would stop on a confirmation screen (`permissions.defaultMode: ask`), or unreadable (#4238). */
export const EXIT_PERMISSION_ASK = 45;
/** Command Code's worktree settings, in the order they decide `permissions.defaultMode` (#4238). */
export const COMMAND_CODE_SETTINGS_FILES = [path.join('.commandcode', 'settings.local.json'), path.join('.commandcode', 'settings.json')];
/** The roster's tool id of Command Code (`command-code`, `command-code-2`, …). */
export const COMMAND_CODE_INSTANCE = 'command-code';
/** `send`'s exit code for a role condition that does not hold: nothing typed (`RoleExitCode.NOT_SENT`). */
export const EXIT_ROLE_NOT_SENT = 32;
/** `send`'s exit code for a role conflict such as a moved roster: nothing sent (`RoleExitCode.CONFLICT`). */
export const EXIT_ROLE_CONFLICT = 31;
/** `auto-yes --disable` + read-back attempts before the start, and the pause between them. */
export const DISARM_ATTEMPTS = 3;
export const DISARM_INTERVAL_SEC = 2;
/** Reads of the instance list after a kill before the stop counts as unconfirmed, and the pause between them. */
export const STOP_READS = 3;
export const STOP_READ_INTERVAL_SEC = 5;
/** `capture --json` reads of `sessionStatus: ready` in a row before the contract goes out, the most reads, and the pause. */
export const READY_STREAK = 2;
export const READY_MAX_POLLS = 30;
export const READY_POLL_SEC = 10;
/** Starts the session without handing it the contract: no work, no files, no Auto-Yes. */
export const INIT_MESSAGE =
  'セッションの起動とモデルの確認です（作業の依頼ではありません）。まだ何も実行せず、ファイルにも触らず、「OK」とだけ返してください。依頼は次のメッセージで送ります。';

/** Whether `--instance` is a Command Code instance (`command-code` or `command-code-<n>`). */
export function isCommandCodeInstance(instance) {
  return instance === COMMAND_CODE_INSTANCE || String(instance ?? '').startsWith(`${COMMAND_CODE_INSTANCE}-`);
}

/**
 * The `permissions.defaultMode` a Command Code session in `worktree` starts with
 * (#4238): the local settings' when it names one, else the shared settings'.
 * A file that is there but not a JSON object is an error: the mode cannot be
 * told, and `ask` is not ruled out.
 *
 * @returns {{ mode: string | null, file: string | null, error?: string }}
 */
export function commandCodePermissionMode(worktree) {
  for (const rel of COMMAND_CODE_SETTINGS_FILES) {
    const file = path.join(worktree, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') continue;
    let settings = null;
    try {
      settings = JSON.parse(text);
    } catch {
      settings = null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return { mode: null, file, error: `${file} is not a JSON object` };
    }
    const mode = settings.permissions?.defaultMode;
    if (typeof mode === 'string' && mode.trim() !== '') return { mode: mode.trim(), file };
  }
  return { mode: null, file: null };
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write the contract's model into `<worktree>/.claude/settings.local.json`,
 * keeping its other keys. Refuses (throws, nothing written) when git does not
 * ignore the file — it would show in the diff and the scope gate — or when the
 * file is not a JSON object.
 *
 * @returns {{ file: string, value: string }}
 */
export function setModel(run, worktree, model) {
  const value = MODEL_SETTINGS[model];
  if (!value) throw Object.assign(new Error(`--model must be one of ${Object.keys(MODEL_SETTINGS).join(' / ')} (got ${model})`), { usage: true });
  const file = path.join(worktree, SETTINGS_FILE);
  const ignored = run('git', ['-C', worktree, 'check-ignore', '-q', SETTINGS_FILE]);
  if (ignored.status !== 0) throw Object.assign(new Error(`NOT ignored by git: ${file} (not written)`), { usage: true });
  let settings = {};
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '') {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      settings = null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw Object.assign(new Error(`${file} is not a JSON object (not written)`), { usage: true });
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...settings, model: value }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return { file, value };
}

/**
 * The process's role in one `capture --json` answer (Issue #4115): its generation and
 * injection fingerprint, or null when it reports none (a server with no role layer,
 * a tool outside it). Read off the answers already being read, so a launch asks
 * `capture` no more often than it did.
 *
 * @returns {{ sessionGeneration: string, injectionFingerprint: string | null } | null}
 */
export function rolePinOf(answer) {
  const roleLaunch = answer?.roleLaunch;
  if (typeof roleLaunch?.sessionGeneration !== 'string') return null;
  // A fingerprint that is neither is not "no role".
  const { injectionFingerprint } = roleLaunch;
  return typeof injectionFingerprint === 'string' || injectionFingerprint === null ? roleLaunch : null;
}

/**
 * Whether the role read at the starting message still holds. Nothing to compare
 * (no pin was read) holds: such a server has no generation to change. A pin that
 * has gone away does not: the process it described is no longer known.
 */
export function rolePinHolds(pin, now) {
  if (pin === null) return true;
  return (
    now !== null &&
    pin.sessionGeneration === now.sessionGeneration &&
    pin.injectionFingerprint === now.injectionFingerprint
  );
}

/**
 * The `send` flags that pin a contract to the process {@link rolePinOf} read
 * (Issue #4116). None without a pin: such a server has no generation to compare.
 *
 * @returns {string[]}
 */
export function rolePinArgs(pin) {
  if (pin === null) return [];
  return [
    '--expect-role-generation',
    pin.sessionGeneration,
    ...(typeof pin.injectionFingerprint === 'string'
      ? ['--expect-role-fingerprint', pin.injectionFingerprint]
      : ['--expect-no-role']),
  ];
}

/** `ok` when the reported model is the contract's family, `unknown` when nothing is reported, else `mismatch`. */
export function classifyModel(got, want) {
  const reported = typeof got === 'string' ? got.trim().toLowerCase() : '';
  if (!reported) return 'unknown';
  return reported.includes(want) ? 'ok' : 'mismatch';
}

/**
 * The model the session reports (`capture --json`'s `model`), read up to
 * MODEL_READS times while it is empty or unreadable.
 *
 * @returns {{ verdict: 'ok' | 'unknown' | 'mismatch', got: string }}
 */
export function checkModel({ run, sleep, cli, wt, instance, want, onAnswer }) {
  let got = '';
  for (let read = 1; read <= MODEL_READS; read++) {
    const out = run(cli, ['capture', wt, '--instance', instance, '--json']);
    if (out.status === 0) {
      try {
        const answer = JSON.parse(out.stdout);
        onAnswer?.(answer);
        const model = answer?.model;
        got = typeof model === 'string' ? model.trim() : '';
      } catch {
        got = '';
      }
    }
    if (got) break;
    if (read < MODEL_READS) sleep(MODEL_READ_INTERVAL_SEC * 1000);
  }
  return { verdict: classifyModel(got, want), got };
}

/** The instance's row of `instances --json`: the row, undefined when the list has none, null when it cannot be read. */
function readRow(run, cli, wt, instance) {
  const listed = run(cli, ['instances', wt, '--json']);
  if (listed.status !== 0) return null;
  try {
    const rows = JSON.parse(listed.stdout);
    return Array.isArray(rows) ? rows.find((row) => row?.instanceId === instance) : null;
  } catch {
    return null;
  }
}

/** true / false whether the instance's session runs, null when the list cannot be read. */
function readRunning(run, cli, wt, instance) {
  const row = readRow(run, cli, wt, instance);
  return row === null ? null : Boolean(row?.running);
}

/**
 * Whether a process that reports no role has to (Issue #4116), from its row as
 * {@link readRowWithRoles} read it. `capture --json` leaves `roleLaunch` out for two
 * opposite reasons: nothing here has roles, or this server has them and does not know
 * the process. A row with `role` is a server with roles, and only a tool outside them
 * needs no pin. A row without it is an older server or CLI, neither of which can pin.
 *
 * @returns {boolean}
 */
export function roleEvidenceRequired(row) {
  return Boolean(row?.role) && row.role.effectiveNext?.source !== 'unsupported';
}

/**
 * The instance's row with its role (Issue #4116): `--require-roles` fails the list
 * rather than leave `role` out, so "could not be read" cannot pass for "none here".
 * Only an answer naming the route as missing, or a CLI not knowing the flag, is an
 * older one, and the plain list then says the rest. Same answers as {@link readRow}.
 */
function readRowWithRoles(run, cli, wt, instance) {
  const listed = run(cli, ['instances', wt, '--json', '--require-roles']);
  let answer = null;
  try {
    answer = JSON.parse(listed.stdout);
  } catch {
    answer = null;
  }
  if (listed.status === 0) return Array.isArray(answer) ? answer.find((row) => row?.instanceId === instance) : null;
  const older = answer?.error === 'role_api_unavailable' || String(listed.stderr ?? '').includes('unknown option');
  return older ? readRow(run, cli, wt, instance) : null;
}

/**
 * Turn the instance's Auto-Yes off and read it back off (#3883 N7). The grant
 * belongs to the worktree × instance, not to a session: a session that is not
 * running does not mean it is off, and the poller keeps it for the next
 * session. `instances --json` reads `autoYes` from the state store, with or
 * without a session; only a readable row with `autoYes` not true is "off".
 *
 * @returns {{ ok: boolean, detail: string, row?: object }} `row` is what read it back off
 */
export function disarmAutoYes({ run, sleep, cli, wt, instance }) {
  let detail = '';
  for (let attempt = 1; attempt <= DISARM_ATTEMPTS; attempt++) {
    const off = run(cli, ['auto-yes', wt, '--disable', '--instance', instance]);
    if (off.status !== 0) {
      detail = `auto-yes --disable exit=${off.status} ${String(off.stderr ?? '').trim().split('\n').pop() ?? ''}`.trim();
    } else {
      const row = readRowWithRoles(run, cli, wt, instance);
      if (row && row.autoYes !== true) return { ok: true, detail: 'off', row };
      detail = row === null ? 'instance list or its roles unreadable after --disable' : row === undefined ? `${instance} not in the instance list` : 'still on after --disable';
    }
    if (attempt < DISARM_ATTEMPTS) sleep(DISARM_INTERVAL_SEC * 1000);
  }
  return { ok: false, detail: `${detail} (after ${DISARM_ATTEMPTS} attempts)` };
}

/**
 * Stop the instance's session if one is running (the model is read only when a
 * session starts) and confirm it stopped: the kill exits 0 and the list then
 * reads the instance as not running. The kill API leaves the session alive and
 * answers 500 when it cannot stop it (kill-session/route.ts), so neither the
 * request alone nor an unreadable list counts as stopped.
 *
 * @returns {{ ok: boolean, killed: boolean, detail: string }}
 */
export function stopSession({ run, sleep, cli, wt, instance }) {
  const before = readRunning(run, cli, wt, instance);
  if (before === false) return { ok: true, killed: false, detail: 'not running' };
  const kill = run(cli, ['instances', wt, 'kill', instance]);
  // Unreadable before: the kill may fail only because nothing ran; the list after decides.
  if (before === true && kill.status !== 0) {
    return { ok: false, killed: true, detail: `kill exit=${kill.status} ${String(kill.stderr ?? '').trim().split('\n').pop() ?? ''}`.trim() };
  }
  let after = null;
  for (let read = 1; read <= STOP_READS; read++) {
    after = readRunning(run, cli, wt, instance);
    if (after === false) return { ok: true, killed: true, detail: `kill exit=${kill.status}` };
    if (read < STOP_READS) sleep(STOP_READ_INTERVAL_SEC * 1000);
  }
  return { ok: false, killed: true, detail: `kill exit=${kill.status}, ${after === null ? 'instance list unreadable' : 'still running'} after ${STOP_READS} reads` };
}

/** Wait until the session reads `sessionStatus: ready` READY_STREAK times in a row; false if it never does. */
export function waitReady({ run, sleep, cli, wt, instance, onAnswer }) {
  let streak = 0;
  for (let poll = 1; poll <= READY_MAX_POLLS; poll++) {
    const out = run(cli, ['capture', wt, '--instance', instance, '--json']);
    let status = null;
    try {
      const answer = out.status === 0 ? JSON.parse(out.stdout) : null;
      if (answer !== null) onAnswer?.(answer);
      status = answer?.sessionStatus ?? null;
    } catch {
      status = null;
    }
    streak = status === 'ready' ? streak + 1 : 0;
    if (streak >= READY_STREAK) return true;
    if (poll < READY_MAX_POLLS) sleep(READY_POLL_SEC * 1000);
  }
  return false;
}

/**
 * The `--duration` format the CLI accepts (Issue #3913): `1h`〜`24h`, whole
 * hours. A copy of AUTO_YES_DURATION_FLAG_PATTERN in
 * src/config/auto-yes-duration.ts (this .mjs cannot import TypeScript);
 * tests/unit/scripts/orchestrate/launch-worker-duration-3913.test.ts keeps the
 * two equal.
 */
export const DURATION_FLAG_PATTERN = /^(?:[1-9]|1[0-9]|2[0-4])h$/;

const USAGE = `Usage:
  node scripts/orchestrate/launch-worker.mjs send --run-dir <dir> --issue <N> [--item <work item>]
       --wt <worktree-id> --worktree <path> --instance <agent> --contract <file>
       [--model <opus|sonnet|->] [--duration <1h..24h>] [--cli <commandmatedev>]
  node scripts/orchestrate/launch-worker.mjs set-model --worktree <path> --model <opus|sonnet>
  node scripts/orchestrate/launch-worker.mjs check-model --wt <worktree-id> --model <opus|sonnet> [--instance <id>] [--cli <commandmatedev>]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issue': 'issue',
  '--item': 'item',
  '--wt': 'wt',
  '--worktree': 'worktree',
  '--instance': 'instance',
  '--contract': 'contract',
  '--model': 'model',
  '--duration': 'duration',
  '--cli': 'cli',
};
const REQUIRED = {
  send: ['--run-dir', '--issue', '--wt', '--worktree', '--instance', '--contract'],
  'set-model': ['--worktree', '--model'],
  'check-model': ['--wt', '--model'],
};

export function parseArgs(argv) {
  const command = argv[0];
  if (!REQUIRED[command]) return { error: `unknown command: ${command ?? '(none)'}` };
  const options = { command, cli: 'commandmatedev', duration: '3h', model: '-', instance: command === 'check-model' ? 'claude' : undefined };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of REQUIRED[command]) {
    if (!options[FLAGS[flag]] || (flag === '--model' && options.model === '-')) return { error: `${flag} is required` };
  }
  const models = command === 'send' ? ['-', ...Object.keys(MODEL_SETTINGS)] : Object.keys(MODEL_SETTINGS);
  if (!models.includes(options.model)) return { error: `--model must be one of ${models.join(' / ')} (got ${options.model})` };
  if (command === 'send') {
    if (!/^[1-9]\d*$/.test(options.issue)) return { error: `--issue must be a positive integer (got ${options.issue})` };
    if (!DURATION_FLAG_PATTERN.test(options.duration)) return { error: `--duration must be 1h..24h in whole hours (got ${options.duration})` };
    const badItem = itemProblem(options.item);
    if (badItem) return { error: badItem };
  }
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{
 *   run?: (command: string, args: string[], opts?: { cwd?: string }) => { status: number, stdout: string, stderr: string },
 *   sleep?: (ms: number) => void,
 *   out?: (line: string) => void,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { run = defaultRun, sleep = defaultSleep } = deps;
  // stdout carries the task id (send) or the model (check-model) only; everything else goes to stderr.
  const out = deps.out ?? ((line) => console.log(line));
  const log = deps.log ?? ((line) => console.error(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  try {
    if (o.command === 'set-model') {
      const { file, value } = setModel(run, o.worktree, o.model);
      log(`model ${value} -> ${file}`);
      return 0;
    }
    if (o.command === 'check-model') {
      const { verdict, got } = checkModel({ run, sleep, cli: o.cli, wt: o.wt, instance: o.instance, want: o.model });
      log(`model ${verdict === 'ok' ? 'ok' : verdict.toUpperCase()} want=${o.model} got=${got || '-'}`);
      out(got);
      return verdict === 'ok' ? 0 : verdict === 'mismatch' ? EXIT_MODEL_MISMATCH : EXIT_MODEL_UNKNOWN;
    }

    const issue = Number(o.issue);
    const workItem = workItemName(issue, o.item);
    const ctx = { run, sleep, cli: o.cli, wt: o.wt, instance: o.instance };
    /** Send and keep the output in files of this send's own; the first stdout line is the task id. */
    const sendTo = (prefix, args) => {
      const { file: outFile } = allocateLog(o.runDir, prefix, workItem, '.out');
      const sent = run(o.cli, ['send', o.wt, ...args]);
      fs.writeFileSync(outFile, sent.stdout);
      fs.writeFileSync(outFile.replace(/\.out$/, '.err'), sent.stderr);
      return { ...sent, taskId: sent.stdout.split('\n')[0].trim(), name: path.basename(outFile) };
    };
    /** Stop and confirm, or say the stop is unconfirmed (the caller then sends nothing more). */
    const stopped = (why) => {
      const stop = stopSession(ctx);
      if (stop.ok) {
        if (stop.killed) log(`stopped ${o.instance} of ${o.wt}: ${why} (${stop.detail})`);
        return true;
      }
      log(`stop UNCONFIRMED ${o.instance} of ${o.wt}: ${why} (${stop.detail}); nothing more is sent — stop it by hand`);
      return false;
    };
    const contractArgs = ['--contract', o.contract, '--instance', o.instance, '--auto-yes', '--duration', o.duration];

    if (isCommandCodeInstance(o.instance)) {
      // No Claude model for Command Code (#4238): nothing goes to .claude/, and a model given is a mistake of the caller.
      if (o.model !== '-') {
        error(`--model ${o.model} is a Claude model; ${o.instance} (Command Code) takes --model - (nothing sent)\n${USAGE}`);
        return 2;
      }
      const permission = commandCodePermissionMode(o.worktree);
      if (permission.error || permission.mode === 'ask') {
        const why = permission.error ?? `permissions.defaultMode is ask in ${permission.file}`;
        log(`permission ASK ${o.instance} of ${o.wt}: ${why}; it would stop on a confirmation screen even under Auto-Yes. nothing is sent — set another mode and send again`);
        return EXIT_PERMISSION_ASK;
      }
      log(`permission ok ${o.instance} of ${o.wt}: defaultMode=${permission.mode ?? '(not set)'} (${permission.file ?? 'no .commandcode settings'})`);
    }
    if (o.model === '-') {
      const sent = sendTo('send', contractArgs);
      log(`send exit=${sent.status} issue=${workItem} task=${sent.taskId || '-'} (${sent.name})`);
      if (sent.taskId) out(sent.taskId);
      return sent.status;
    }
    for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
      // The model is read when the session starts: stop a running one, write the model, start it without the contract.
      if (!stopped('before writing the model')) return EXIT_STOP_UNCONFIRMED;
      // A grant left on would answer the starting session's screens before its model is known.
      const disarm = disarmAutoYes(ctx);
      if (!disarm.ok) {
        log(`auto-yes UNCONFIRMED ${o.instance} of ${o.wt}: ${disarm.detail}; nothing is sent — turn it off by hand`);
        return EXIT_AUTO_YES_UNCONFIRMED;
      }
      const { value } = setModel(run, o.worktree, o.model);
      log(`model ${value} -> ${path.join(o.worktree, SETTINGS_FILE)}`);
      const init = sendTo('send-init', [INIT_MESSAGE, '--instance', o.instance]);
      log(`start exit=${init.status} issue=${workItem} (${init.name}, no contract, no Auto-Yes)`);
      // 99 = the message was not delivered (initialization timeout / prompt not ready / composer-not-empty), but the
      // session may be up: the starting message asks for no work, so a model read off the screen is as good (#3904).
      if (init.status !== 0 && init.status !== EXIT_NOT_DELIVERED) return init.status;
      // The role is what the starting message started (Issue #4115): the last answer
      // of the model check fixes it, and the last answer before the contract must agree.
      let rolePin = null;
      const { verdict, got } = checkModel({ ...ctx, want: o.model, onAnswer: (answer) => (rolePin = rolePinOf(answer)) });
      if (init.status !== 0 && got) {
        const note = `start exit=${init.status} but the prompt was reached (model read: ${got}); continuing\n`;
        fs.appendFileSync(path.join(o.runDir, `${init.name.replace(/\.out$/, '')}.err`), note);
        log(`start exit=${init.status} issue=${workItem}: ${note.trim()}`);
      }
      log(`model ${verdict === 'ok' ? 'ok' : verdict.toUpperCase()} issue=${workItem} want=${o.model} got=${got || '-'} attempt=${attempt}`);
      if (verdict !== 'ok') {
        // Not the contract's model (or not known to be): the contract does not go to this session.
        if (!stopped(`model ${verdict} on attempt ${attempt}`)) return EXIT_STOP_UNCONFIRMED;
        if (attempt === LAUNCH_ATTEMPTS) return verdict === 'mismatch' ? EXIT_MODEL_MISMATCH : EXIT_MODEL_UNKNOWN;
        continue;
      }
      let roleNow = rolePin;
      if (!waitReady({ ...ctx, onAnswer: (answer) => (roleNow = rolePinOf(answer)) })) {
        log(`not ready: ${o.instance} of ${o.wt} did not read ready ${READY_STREAK} times in a row after the starting message; contract not sent`);
        return stopped('not ready after the starting message') ? 1 : EXIT_STOP_UNCONFIRMED;
      }
      if (!rolePinHolds(rolePin, roleNow)) {
        log(`role changed: ${o.instance} of ${o.wt} is not the process the starting message started; contract not sent`);
        return stopped('role changed after the starting message') ? EXIT_ROLE_CHANGED : EXIT_STOP_UNCONFIRMED;
      }
      if (roleNow === null && roleEvidenceRequired(disarm.row)) {
        log(`role unknown: the server has no record of what ${o.instance} of ${o.wt} was started with; contract not sent`);
        return stopped('no record of the role it started with') ? EXIT_ROLE_CHANGED : EXIT_STOP_UNCONFIRMED;
      }
      const sent = sendTo('send', [...contractArgs, ...rolePinArgs(roleNow)]);
      log(`send exit=${sent.status} issue=${workItem} task=${sent.taskId || '-'} (${sent.name})`);
      if (sent.taskId) out(sent.taskId);
      if ((sent.status === EXIT_ROLE_NOT_SENT || sent.status === EXIT_ROLE_CONFLICT) && roleNow !== null) {
        // Refused with nothing typed, and the `send` withdrew the grant it armed. One still
        // on is someone else's, or could not be told apart: not this script's to cut.
        const row = readRow(run, o.cli, o.wt, o.instance);
        if (row?.autoYes !== false) {
          log(`auto-yes still on or unread: ${o.instance} of ${o.wt} (see ${sent.name.replace(/\.out$/, '.err')}); left as it is`);
        }
        if (sent.status === EXIT_ROLE_CONFLICT) {
          log(`roster changed: ${o.instance} of ${o.wt}; contract not sent`);
          return sent.status;
        }
        log(`role changed: ${o.instance} of ${o.wt} is not the process the contract was pinned to; contract not sent`);
        return stopped('the contract was pinned to another process') ? EXIT_ROLE_CHANGED : EXIT_STOP_UNCONFIRMED;
      }
      return sent.status;
    }
    return 1;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return err?.usage ? 2 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
