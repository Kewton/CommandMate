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
 * written. After the send the model the session reports (`capture --json`'s
 * `model`) must match: unknown or another model restarts the session once
 * (kill, write again, send again); still not matching, the session is
 * stopped so the task does not go on, and the call fails (40 / 41).
 *
 * The send's output goes to `send-<issue>[-<item>][.a<n>].out` / `.err` in the
 * run directory, taken exclusively (execution-key.mjs), so two sends of one
 * Issue never write to the same files. stdout is the task id only.
 *
 * Exit code (send): 0 sent (and for Claude the model matched); 40 the model
 * did not match after one restart; 41 the model could not be read after one
 * restart (the session is stopped in both); 2 a usage error or a settings file
 * git does not ignore (nothing sent); 1 any other failure; otherwise the
 * `send`'s own exit code (99 = not sent, 3-1's cold start).
 *
 * Usage:
 *   node scripts/orchestrate/launch-worker.mjs send --run-dir <dir> --issue <N> [--item <work item>]
 *        --wt <worktree-id> --worktree <path> --instance <agent> --contract <file>
 *        [--model <opus|sonnet|->] [--duration <1h|3h|8h>] [--cli <commandmatedev>]
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
export const EXIT_MODEL_MISMATCH = 40;
export const EXIT_MODEL_UNKNOWN = 41;

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
export function checkModel({ run, sleep, cli, wt, instance, want }) {
  let got = '';
  for (let read = 1; read <= MODEL_READS; read++) {
    const out = run(cli, ['capture', wt, '--instance', instance, '--json']);
    if (out.status === 0) {
      try {
        const model = JSON.parse(out.stdout)?.model;
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

/** Stop the instance's session if one is running (the model is read only when a session starts). */
function stopSession(run, cli, wt, instance) {
  const listed = run(cli, ['instances', wt, '--json']);
  let running = true; // unreadable: stop it anyway, a stop of a stopped session is harmless
  if (listed.status === 0) {
    try {
      const rows = JSON.parse(listed.stdout);
      running = Array.isArray(rows) && rows.some((row) => row?.instanceId === instance && row?.running);
    } catch {
      running = true;
    }
  }
  if (running) run(cli, ['instances', wt, 'kill', instance]);
  return running;
}

const USAGE = `Usage:
  node scripts/orchestrate/launch-worker.mjs send --run-dir <dir> --issue <N> [--item <work item>]
       --wt <worktree-id> --worktree <path> --instance <agent> --contract <file>
       [--model <opus|sonnet|->] [--duration <1h|3h|8h>] [--cli <commandmatedev>]
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
    if (!['1h', '3h', '8h'].includes(options.duration)) return { error: `--duration must be 1h, 3h or 8h (got ${options.duration})` };
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
    const pinned = o.model !== '-';
    let taskId = '';
    for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
      if (pinned) {
        // The model is read when the session starts: stop a running one, then write the model, then send.
        if (stopSession(run, o.cli, o.wt, o.instance)) log(`stopped the running ${o.instance} session of ${o.wt}`);
        const { value } = setModel(run, o.worktree, o.model);
        log(`model ${value} -> ${path.join(o.worktree, SETTINGS_FILE)}`);
      }
      const { file: outFile } = allocateLog(o.runDir, 'send', workItem, '.out');
      const errFile = outFile.replace(/\.out$/, '.err');
      const sent = run(o.cli, [
        'send', o.wt, '--contract', o.contract, '--instance', o.instance, '--auto-yes', '--duration', o.duration,
      ]);
      fs.writeFileSync(outFile, sent.stdout);
      fs.writeFileSync(errFile, sent.stderr);
      taskId = sent.stdout.split('\n')[0].trim();
      log(`send exit=${sent.status} issue=${workItem} task=${taskId || '-'} (${path.basename(outFile)})`);
      if (sent.status !== 0 || !pinned) {
        if (taskId) out(taskId);
        return sent.status;
      }
      const { verdict, got } = checkModel({ run, sleep, cli: o.cli, wt: o.wt, instance: o.instance, want: o.model });
      log(`model ${verdict === 'ok' ? 'ok' : verdict.toUpperCase()} issue=${workItem} want=${o.model} got=${got || '-'} attempt=${attempt}`);
      if (verdict === 'ok') {
        out(taskId);
        return 0;
      }
      // Not the contract's model (or not known to be): the task must not go on in this session.
      run(o.cli, ['instances', o.wt, 'kill', o.instance]);
      log(`stopped ${o.instance} of ${o.wt}: model ${verdict} on attempt ${attempt}`);
      if (attempt === LAUNCH_ATTEMPTS) {
        if (taskId) out(taskId);
        return verdict === 'mismatch' ? EXIT_MODEL_MISMATCH : EXIT_MODEL_UNKNOWN;
      }
    }
    return 1;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return err?.usage ? 2 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
