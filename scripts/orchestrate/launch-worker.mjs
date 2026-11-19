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
 * A starting message that was not confirmed (exit 99, #3904) may sit unsent in the
 * composer — drawn late, its Enter lost — and the contract's `send` would refuse
 * `composer-not-empty` (#1880) on every try (Issue #4476). So before the contract the
 * last `capture --json` read's `composerState` decides: `empty` / `ghost` go on. The
 * starting message as far as it was drawn (a beginning of 20 characters or more, I6) gets
 * one clear through the server's existing clear-composer route, called with the CLI's own
 * HTTP client — only when `--cli` is that package's own bin, so the clear goes where the
 * reads went (I7; otherwise no clear, and the output says so); anything else in the
 * composer is not this script's and is left alone (1, the session left running).
 * A composer that cannot be read (`no_composer`, an unknown state) is read again. The
 * contract then goes only after two clean reads in a row, else the session is stopped
 * (1); a process replaced since the model check gets no clear (44). A server that
 * reports no `composerState` goes on as before. The starting message is never
 * submitted again: it may have gone.
 *
 * Command Code (Issue #4238, the easy tier) has no Claude model: `--model -` only,
 * and nothing is written to `.claude/`. Its interactive permissions are fixed
 * when the session starts, from the worktree's `.commandcode/settings.local.json`
 * (else `.commandcode/settings.json`) `permissions.defaultMode`, and `ask` stops
 * on a confirmation screen even under Auto-Yes. So before the send that mode is
 * read; `ask`, or a settings file that is not a JSON object, sends nothing (45).
 * Otherwise a running session is stopped (and the stop confirmed, else 42) before
 * the send, as for Claude: one started under `ask` would keep it after the
 * settings were fixed, and the send would reuse it. Command Code is told by the
 * tool the server resolves `--instance` to (`cliToolId`), so an alias of it is
 * checked the same way; the id the server answers is the one every call uses.
 * An `--instance` the server cannot resolve sends nothing (2).
 *
 * Exit code (send): 0 sent (and for Claude the model matched before the
 * contract went out); 40 the model did not match after one restart; 41 the
 * model could not be read after one restart (the session is stopped and the
 * contract not sent in both); 42 a stop could not be confirmed (nothing more
 * sent); 43 Auto-Yes could not be confirmed off before the start, which includes
 * an instance list or roles that could not be read (nothing sent); 44 the role fixed at the starting message no longer holds (stopped, not
 * sent); 45 a Command Code worktree whose permissions default is `ask`, or
 * cannot be read (nothing sent); 2 a usage error (a Claude model for Command Code too), an `--instance` that cannot be resolved, or a settings file git does not ignore (nothing
 * sent); 1 any other failure (the session did not come back ready after the
 * starting message, or — Issue #4476 — the composer did not read clean twice in a row
 * after a starting message that was not confirmed: stopped, contract not sent; or it
 * held text that is not the starting message: not cleared, not stopped, not sent); otherwise the `send`'s own
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
import { QUERY_TIMEOUT_MS, defaultRun } from './wait-verify.mjs';
import { resolveInstanceThroughCli } from './resolve-instance.mjs';

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
/**
 * Issue #4476: reads of the composer after one clear of a starting message left in it,
 * the pause before each, and the clean reads in a row (`empty` / `ghost`) the contract waits for.
 */
export const COMPOSER_SETTLE_READS = 6;
export const COMPOSER_SETTLE_INTERVAL_SEC = 5;
export const COMPOSER_CLEAN_STREAK = 2;
/** `composerState` values that hold no text a person (or a lost send) typed (#1879). */
const COMPOSER_CLEAN_STATES = new Set(['empty', 'ghost']);
/** Starts the session without handing it the contract: no work, no files, no Auto-Yes. */
export const INIT_MESSAGE =
  'セッションの起動とモデルの確認です（作業の依頼ではありません）。まだ何も実行せず、ファイルにも触らず、「OK」とだけ返してください。依頼は次のメッセージで送ります。';

/** Whether an instance id is a Command Code instance's (`command-code` or `command-code-<n>`). */
export function isCommandCodeInstance(instance) {
  return instance === COMMAND_CODE_INSTANCE || String(instance ?? '').startsWith(`${COMMAND_CODE_INSTANCE}-`);
}

/**
 * Whether the resolved target runs Command Code: the tool the server named
 * (`cliToolId`), as wait-verify's needsCompletionSignal reads it, so an alias
 * (`cc`) is Command Code too; a server that names no tool leaves the id's form.
 *
 * @param {{ instanceId: string, cliToolId?: string }} target
 */
export function isCommandCodeTarget({ instanceId, cliToolId }) {
  return cliToolId ? cliToolId === COMMAND_CODE_INSTANCE : isCommandCodeInstance(instanceId);
}

/** `--instance` (an id or an alias) resolved by the server, through the CLI the script was given (resolve-instance.mjs). */
export function defaultResolveTarget(run, cli, wt, selector) {
  return resolveInstanceThroughCli(run, cli, wt, selector, { timeoutMs: QUERY_TIMEOUT_MS, withTool: true });
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

/** Bound on the clear's child: the route waits up to 60 s for the instance's input lock (`INSTANCE_INPUT_LOCK_WAIT_MS`). */
export const CLEAR_COMPOSER_TIMEOUT_MS = 75_000;

/**
 * The clear's child (`node -e`, argv: `<cli> <route> <body JSON>`). It finds the CLI's own
 * package — `<cli>` on PATH (or the path given), symlinks followed — and goes on only when that
 * file IS the package's `bin/commandmate.js` in a `package.json` named `commandmate` (I7: a
 * wrapper, another package or another script is refused, since what it runs — and where it
 * connects — cannot be confirmed). It posts with that package's `ApiClient` (`dist/cli/utils/api-client.js`),
 * so the server, token, `.env`, `CM_BIND` / HTTPS and UAT-isolation rules are the CLI's own
 * (`resolveServerEndpoint(loadClientEnv())`, src/cli/utils/server-url.ts) and nothing is
 * re-derived here. Needs no CommandMate session (`whoami` does). Prints one JSON line:
 * `{ stage: 'resolve', error }` when no request was made (exit 2), else
 * `{ stage: 'post', serverUrl, ok, error? }` (exit 0 on a 2xx, 1 otherwise).
 */
export const CLEAR_COMPOSER_SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const [cli, route, body] = process.argv.slice(1);
const say = (o, code) => { process.stdout.write(JSON.stringify(o)); process.exit(code); };
const reason = (e) => String(e && e.message ? e.message : e);
const onPath = (name) => {
  if (name.includes('/')) return path.resolve(name);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
};
let root = null;
try {
  const bin = onPath(cli);
  if (bin === null) say({ stage: 'resolve', error: cli + ' is not on PATH' }, 2);
  // I7: the CLI that runs is the package's own bin, nothing in front of it (a wrapper may change
  // CM_PORT or the package). Only then is this package's ApiClient the CLI's own connection.
  const real = fs.realpathSync(bin);
  const candidate = path.dirname(path.dirname(real));
  let name = null;
  try { name = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).name; } catch {}
  let canonical = null;
  try { canonical = fs.realpathSync(path.join(candidate, 'bin', 'commandmate.js')); } catch {}
  if (name !== 'commandmate' || canonical !== real) {
    say({ stage: 'resolve', error: real + ' is not the bin/commandmate.js of a commandmate package (a wrapper or another script)' }, 2);
  }
  root = candidate;
} catch (e) { say({ stage: 'resolve', error: reason(e) }, 2); }
let client;
try {
  const { ApiClient } = require(path.join(root, 'dist', 'cli', 'utils', 'api-client.js'));
  client = new ApiClient({ onWarning: () => {} });
  if (typeof client.post !== 'function') throw new Error('the ApiClient of ' + root + ' has no post');
} catch (e) { say({ stage: 'resolve', error: reason(e) }, 2); }
client.post(route, JSON.parse(body)).then(
  () => say({ stage: 'post', serverUrl: client.serverUrl, ok: true }, 0),
  (e) => say({ stage: 'post', serverUrl: client.serverUrl, ok: false, error: reason(e) }, 1)
);
`;

/**
 * Empty the instance's composer through the server's existing clear-composer route
 * (Issue #4476; the route is #1879's [Clear], which loops `C-e`+`C-u` under the input lock
 * and reads back). The CLI has no command for it, so the route is called with the CLI's own
 * HTTP client ({@link CLEAR_COMPOSER_SCRIPT}): the same server every other call of this
 * script reaches, from a terminal as from a session. A server it cannot resolve is not
 * guessed: no request, `attempted: false`.
 *
 * @returns {{ attempted: boolean, ok: boolean, detail: string }} `ok` only for a 2xx answer;
 *   the caller decides on the composer read back, whatever this says
 */
export function defaultClearComposer({ run, cli, wt, instance, cliToolId }) {
  const route = `/api/worktrees/${encodeURIComponent(wt)}/clear-composer`;
  let posted;
  try {
    posted = run(process.execPath, ['-e', CLEAR_COMPOSER_SCRIPT, cli, route, JSON.stringify({ cliToolId, instanceId: instance })], {
      timeoutMs: CLEAR_COMPOSER_TIMEOUT_MS,
    });
  } catch (err) {
    // A child killed on the timeout may have posted already.
    return { attempted: true, ok: false, detail: `POST ${route} unconfirmed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let answer = null;
  try {
    answer = JSON.parse(String(posted.stdout ?? '').trim());
  } catch {
    answer = null;
  }
  if (answer?.stage === 'resolve') {
    return { attempted: false, ok: false, detail: `clear not done — 消去は未実施: 接続先を確かめられない (${answer.error ?? 'unknown'})` };
  }
  if (answer?.stage !== 'post') {
    return { attempted: true, ok: false, detail: `POST ${route} unconfirmed: exit=${posted.status} ${String(posted.stderr ?? '').trim().split('\n').pop() ?? ''}`.trim() };
  }
  const where = `${answer.serverUrl ?? ''}${route}`;
  return answer.ok === true && posted.status === 0
    ? { attempted: true, ok: true, detail: `POST ${where} ok` }
    : { attempted: true, ok: false, detail: `POST ${where} failed: ${answer.error ?? `exit=${posted.status}`}` };
}

/**
 * One `capture --json` answer's composer, as the leftover check reads it (Issue #4476).
 * Only `empty` / `ghost` are clean. A key that is not there at all is an older server
 * (`legacy`); anything else that is not `content` — `no_composer`, `unsupported_tool`, a
 * state this script does not know, a value of the wrong type, no answer — says nothing
 * about the composer (`unreadable`).
 *
 * @returns {{ kind: 'clean' | 'content' | 'legacy' | 'unreadable', state: string, text: string }}
 */
export function composerReading(answer) {
  if (answer === null || typeof answer !== 'object') return { kind: 'unreadable', state: 'unreadable', text: '' };
  if (!('composerState' in answer)) return { kind: 'legacy', state: '-', text: '' };
  const state = answer.composerState;
  if (typeof state !== 'string') return { kind: 'unreadable', state: `invalid:${typeof state}`, text: '' };
  if (COMPOSER_CLEAN_STATES.has(state)) return { kind: 'clean', state, text: '' };
  if (state === 'content') return { kind: 'content', state, text: typeof answer.composerText === 'string' ? answer.composerText : '' };
  return { kind: 'unreadable', state, text: '' };
}

/** The text with ANSI sequences and every whitespace character taken out: wrapping and indent proof. */
function squashComposerText(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '');
}

/**
 * I6 (Issue #4476): the shortest beginning of the starting message that may be cleared, in
 * characters after {@link squashComposerText}. Shorter text — `OK`, one character — is what a
 * person may type on their own, so it cannot be told to be this script's.
 */
export const STARTING_MESSAGE_MIN_CHARS = 20;

/**
 * Whether composer text is the starting message as far as it was drawn (Issue #4476, I6): with
 * ANSI and whitespace taken out, a BEGINNING of it of {@link STARTING_MESSAGE_MIN_CHARS}
 * characters or more (the whole of a message shorter than that). A piece from inside it, a
 * short match, or anything else cannot be told from a person's typing, and is left alone.
 */
export function isStartingMessageText(text, message = INIT_MESSAGE) {
  const shown = squashComposerText(text);
  const whole = squashComposerText(message);
  if (shown === '') return false;
  if ([...whole].length < STARTING_MESSAGE_MIN_CHARS) return shown === whole;
  return [...shown].length >= STARTING_MESSAGE_MIN_CHARS && whole.startsWith(shown);
}

/**
 * What the composer holds right before the contract, after a starting message that was not
 * confirmed (Issue #4476). That message may sit unsent in the composer — claude drew it late
 * and its Enter did nothing — and the contract's `send` would then refuse `composer-not-empty`
 * (#1880) on every try. It is never submitted again here: it may have gone (I2).
 *
 * `answer` (the last ready read) is the first reading; anything but clean is read again up to
 * {@link COMPOSER_SETTLE_READS} times, {@link COMPOSER_SETTLE_INTERVAL_SEC} apart, and only
 * {@link COMPOSER_CLEAN_STREAK} clean reads in a row let the contract go.
 *
 *   - `clean`: the first reading is `empty` / `ghost`;
 *   - `unknown`: the first answer has no `composerState` (a server older than #1879) — the
 *     caller goes on as before;
 *   - `cleared` / `settled`: clean reads in a row, after the one clear or with none;
 *   - `foreign`: the composer holds text that is not the starting message — not cleared;
 *   - `replaced`: `holds()` says the process is no longer the one the starting message
 *     started (#4115) — checked before every reading is acted on, so before the clear;
 *   - `left`: no clean streak within the reads.
 *
 * The clear goes out at most once, and only for the starting message's text.
 *
 * @returns {{ verdict: 'clean' | 'unknown' | 'cleared' | 'settled' | 'foreign' | 'replaced' | 'left',
 *   state: string, text: string, clear: { attempted: boolean, ok: boolean, detail: string } | null }}
 */
export function settleLeftoverComposer({ run, sleep, cli, wt, instance, cliToolId, answer, clear, holds = () => true, onAnswer, message = INIT_MESSAGE }) {
  let reading = composerReading(answer);
  if (reading.kind === 'legacy') return { verdict: 'unknown', state: reading.state, text: '', clear: null };
  if (reading.kind === 'clean') return { verdict: 'clean', state: reading.state, text: '', clear: null };
  let cleared = null;
  let text = '';
  let streak = 0;
  for (let read = 0; read <= COMPOSER_SETTLE_READS; read++) {
    if (read > 0) {
      sleep(COMPOSER_SETTLE_INTERVAL_SEC * 1000);
      const out = run(cli, ['capture', wt, '--instance', instance, '--json']);
      let now = null;
      try {
        now = out.status === 0 ? JSON.parse(out.stdout) : null;
      } catch {
        now = null;
      }
      if (now !== null && typeof now === 'object') onAnswer?.(now);
      reading = composerReading(now);
      // A key that went missing after the first answer is not "an older server".
      if (reading.kind === 'legacy') reading = { kind: 'unreadable', state: 'missing', text: '' };
    }
    if (!holds()) return { verdict: 'replaced', state: reading.state, text, clear: cleared };
    if (reading.kind === 'clean') {
      streak += 1;
      if (streak >= COMPOSER_CLEAN_STREAK) return { verdict: cleared ? 'cleared' : 'settled', state: reading.state, text, clear: cleared };
      continue;
    }
    streak = 0;
    if (reading.kind !== 'content') continue;
    text = reading.text;
    if (!isStartingMessageText(text, message)) return { verdict: 'foreign', state: reading.state, text, clear: cleared };
    if (cleared === null) cleared = clear({ run, cli, wt, instance, cliToolId });
  }
  return { verdict: 'left', state: reading.state, text, clear: cleared };
}

/** The first characters of a composer's text, on one line, for a log. */
function composerHead(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
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
 *   run?: (command: string, args: string[], opts?: { cwd?: string, timeoutMs?: number }) => { status: number, stdout: string, stderr: string },
 *   resolveTarget?: typeof defaultResolveTarget,
 *   sleep?: (ms: number) => void,
 *   clearComposer?: typeof defaultClearComposer,
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

    // One id for everything that follows (the stop, Auto-Yes, the sends), and the tool behind it:
    // an alias of a Command Code instance gets the Command Code checks (#4238 review). Unresolvable, nothing is sent.
    const target = (deps.resolveTarget ?? defaultResolveTarget)(run, o.cli, o.wt, o.instance);
    if ('error' in target) {
      error(`cannot resolve --instance '${o.instance}' in ${o.wt}: ${target.error} (nothing sent)`);
      return 2;
    }
    const given = o.instance;
    o.instance = target.instanceId;
    if (given !== o.instance) log(`instance ${given} -> ${o.instance}${target.cliToolId ? ` (${target.cliToolId})` : ''}`);
    const commandCode = isCommandCodeTarget(target);

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

    if (commandCode) {
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
      // The mode is read when the session starts: a session started under `ask` keeps it after the
      // settings are fixed, and the send would reuse it. Stopped first, so the send starts one on the mode read above.
      if (!stopped('Command Code reads its permissions when the session starts')) return EXIT_STOP_UNCONFIRMED;
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
      let lastAnswer = null;
      const readAnswer = (answer) => {
        lastAnswer = answer;
        roleNow = rolePinOf(answer);
      };
      if (!waitReady({ ...ctx, onAnswer: readAnswer })) {
        log(`not ready: ${o.instance} of ${o.wt} did not read ready ${READY_STREAK} times in a row after the starting message; contract not sent`);
        return stopped('not ready after the starting message') ? 1 : EXIT_STOP_UNCONFIRMED;
      }
      if (init.status !== 0) {
        // Issue #4476: the starting message that was not confirmed may sit unsent in the composer,
        // and the contract's send would refuse it (#1880) on every try. Read off the last ready
        // answer; it is never submitted again (it may have gone). The model path is Claude's.
        const leftover = settleLeftoverComposer({
          ...ctx,
          cliToolId: target.cliToolId ?? 'claude',
          answer: lastAnswer,
          clear: deps.clearComposer ?? defaultClearComposer,
          // A process replaced since the model check gets no clear (#4115): the role check below stops it.
          holds: () => rolePinHolds(rolePin, roleNow),
          onAnswer: readAnswer,
        });
        const errFile = path.join(o.runDir, `${init.name.replace(/\.out$/, '')}.err`);
        const record = (line) => {
          fs.appendFileSync(errFile, `${line}\n`);
          log(line);
        };
        // opus r2 P3-3: a `content` reading whose text came empty or not as a string.
        const held = leftover.text ? `it held "${composerHead(leftover.text)}"` : 'its text was not reported (composerText empty or not a string)';
        const clearNote = leftover.clear === null ? 'no clear' : leftover.clear.attempted ? `one clear (${leftover.clear.detail})` : `clear not done (${leftover.clear.detail})`;
        if (leftover.verdict === 'unknown') {
          log(`composer UNKNOWN ${o.instance} of ${o.wt}: the server reports no composerState; contract sent as before`);
        } else if (leftover.verdict === 'cleared' || leftover.verdict === 'settled') {
          record(`composer ${leftover.verdict === 'cleared' ? 'CLEARED' : 'SETTLED'} ${o.instance} of ${o.wt} after start exit=${init.status}: ${leftover.text ? `${held}; ` : ''}${clearNote}, then ${COMPOSER_CLEAN_STREAK} clean reads (${leftover.state})`);
        } else if (leftover.verdict === 'foreign') {
          // Not the starting message: maybe a person's. Neither cleared nor stopped (a stop would lose it too).
          record(`composer FOREIGN ${o.instance} of ${o.wt}: ${held}, which cannot be told to be the starting message (I6: its beginning, ${STARTING_MESSAGE_MIN_CHARS} characters or more); not cleared, session left running; contract not sent — check the composer by hand, then launch again`);
          return 1;
        } else if (leftover.verdict === 'left') {
          const next = leftover.clear !== null && !leftover.clear.attempted ? '; 次の手: 人が入力欄を確かめてから起動し直す' : '';
          record(`composer NOT CLEARED ${o.instance} of ${o.wt}: ${clearNote}; last read ${leftover.state}${leftover.text ? `; ${held}` : ''}; contract not sent${next}`);
          return stopped('the composer did not read clean after the starting message') ? 1 : EXIT_STOP_UNCONFIRMED;
        }
        // `replaced` falls to the role check below, which stops the session.
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
