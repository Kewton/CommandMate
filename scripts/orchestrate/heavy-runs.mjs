#!/usr/bin/env node
/**
 * The heavy runs on this machine, and a wait until there are none (Issue #4631).
 *
 * The one line the PM copied into every request (v4) is kept here and fixed by a test:
 *
 *   until [ -z "$(ps -axo comm=,args= | awk '($1 ~ /(^|\/)node$/ && /vitest|next build|precheck\.mjs/) || ($1 ~ /(^|\/)bash$/ && /verify-run\.sh/)')" ]; do sleep 15; done;
 *
 * The set of heavy runs is the same set as v4 (I1), but the role is read from the position of the script,
 * not from a word anywhere in the args (#4651). v4 looked at the whole args, so a request body or an option
 * value that named `vitest` / `next build` / `precheck.mjs` / `verify-run.sh` counted — a `commandmate send`
 * with a request in its body, `verify --gates vitest` — and every wait on the machine stopped. Here the
 * words after `node` are read left to right (the args split on whitespace; a path with a space is read by
 * its words, the same miss v4 has), node's own options and the value of those that take one are skipped,
 * and the first word left is the script. A `node` row counts when that script is
 *   - `vitest` / `vitest.mjs`, or a path holding `/vitest/` (a worker's `…/vitest/dist/workers/forks.js`),
 *   - `next` with `build` next,
 *   - `precheck.mjs` (a precheck's own wait reads it only through its children, `precheckPeers: false`),
 *   - `npx` / `npx-cli.js` with `vitest` next, or `npm` / `npm-cli.js` with `exec vitest` next: v4 counted
 *     this parent too, and counting it starts the wait before the child exists (the child counts as well);
 *   with `-e` / `--eval` / `-p` / `--print` there is no script, so nothing is counted.
 * A `bash` row counts when its script, after its options, is `verify-run.sh`; a `-c` string is not a script.
 * Not counted (I2): the shell running a wait (its comm is zsh / bash / sh,
 * and only bash with `verify-run.sh` is a run), `wait-verify.mjs` (it waits for a reply; nothing heavy),
 * the queue table's text (this script never reads it), and this process and every ancestor of it
 * (a `node precheck.mjs` does not wait for itself, nor merge-pr's inner process for its outer one).
 * A precheck's own wait (before each of its vitest / next build steps) also leaves out the other
 * `precheck.mjs` processes themselves and counts only their vitest / next build children
 * (`precheckPeers: false`): two prechecks waiting between their steps would otherwise wait for each other
 * for ever. Waiting before every heavy step, not only the first, closes the gap a step change leaves (one
 * precheck between two steps runs nothing counted, and the other's vitest could start there).
 *
 * The wait is not a lock (I3): two waiters that both read zero both start, as with v4. The machine
 * lock `cpu.heavy` (resource-sem, precheck's heavy steps) is unchanged.
 *
 * `comm` is the first word after the ppid, as v4's `$1`: a command whose path holds a space is read
 * by its first word, and so is never `node` / `bash` — the same miss v4 has.
 *
 * Usage:
 *   node scripts/orchestrate/heavy-runs.mjs count   # one `<pid> <args>` line per heavy run; exit 0 none, 1 some
 *   node scripts/orchestrate/heavy-runs.mjs wait    # every 15 s until none; what it waits for on stderr every 5 min
 *
 * The tools that start a heavy run inside (wait-verify, precheck, merge-pr, merge-train) wait with
 * {@link heavyWaiter}, given to their `main` only from their own `isMain` entry (I6): a `main` called
 * without it (a test) neither reads `ps` nor waits.
 */

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** How often `wait` reads the process table (v4's `sleep 15`). */
export const POLL_MS = 15_000;
/** How often `wait` says on stderr what it is waiting for. */
export const NOTICE_MS = 5 * 60_000;
/** The columns the entry reads. */
export const PS_ARGS = ['-axo', 'pid=,ppid=,comm=,args='];

/** node's options that take their value in the next word (`--x=y` is already one word). */
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions']);
/** node's options that run a string instead of a script: there is no script to read after them. */
const NODE_EVAL_OPTIONS = /^(?:--eval|--print)(?:=|$)|^-[ep]$/;

/**
 * The rows of `ps -axo pid=,ppid=,comm=,args=`. A line that does not start with two numbers is skipped.
 *
 * @param {string} text
 * @returns {{ pid: number, ppid: number, comm: string, args: string }[]}
 */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3], args: m[4].trimEnd() });
  }
  return rows;
}

/** The basename of a path (a `comm`, or a script in the args): `/usr/local/bin/node` → `node`. */
function baseName(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * The index in the args words of the script node runs: the words after argv0, with node's own options and
 * the value of those that take one skipped. -1 when there is no script (`-e` / `--eval` / `-p` / `--print`).
 */
function scriptIndex(words) {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--') return i + 1 < words.length ? i + 1 : -1;
    if (!word.startsWith('-')) return i;
    if (NODE_EVAL_OPTIONS.test(word)) return -1;
    if (NODE_VALUE_OPTIONS.has(word)) i += 1;
  }
  return -1;
}

/** A `vitest` script by name (the path holding `/vitest/` is checked by {@link isHeavyScript}). */
const isVitestName = (word) => word !== undefined && (baseName(word) === 'vitest' || baseName(word) === 'vitest.mjs');

/**
 * Whether the script at `at` in the args words of a `node` row is a heavy run: the script's position decides,
 * so a request body or an option value that names a heavy word is not a run (#4651).
 */
function isHeavyScript(words, at, precheckPeers) {
  const script = words[at];
  if (script === undefined) return false;
  if (script.includes('/vitest/') || isVitestName(script)) return true;
  const name = baseName(script);
  if (name === 'next') return words[at + 1] === 'build';
  if (name === 'precheck.mjs') return precheckPeers;
  if (name === 'npx' || name === 'npx-cli.js') return isVitestName(words[at + 1]);
  if (name === 'npm' || name === 'npm-cli.js') return words[at + 1] === 'exec' && isVitestName(words[at + 2]);
  return false;
}

/** Whether a `bash` row's script, after its options, is `verify-run.sh`; `-c` runs a string, not a script. */
function isHeavyBash(words) {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--') return i + 1 < words.length && baseName(words[i + 1]) === 'verify-run.sh';
    if (!word.startsWith('-')) return baseName(word) === 'verify-run.sh';
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) return false;
  }
  return false;
}

/**
 * Whether a row is a heavy run by itself (I1), before the own process and its ancestors are left out.
 * The role is the script the row runs, read from its position in the args, not a word anywhere in them:
 * a `commandmate send` whose body holds a request, or `verify --gates vitest`, is not a run (#4651).
 * `precheckPeers: false` (a precheck's own wait): a `node … precheck.mjs` row counts only through what it
 * runs (its vitest / next build child). Two prechecks waiting before a heavy step would otherwise each
 * count the other's process and wait for ever; this way both read zero and start, the window of I3.
 *
 * @param {{ comm: string, args: string }} row
 * @param {{ precheckPeers?: boolean }} [options]
 */
export function isHeavyRow({ comm, args }, { precheckPeers = true } = {}) {
  const text = String(args).trim();
  const words = text === '' ? [] : text.split(/\s+/);
  const name = baseName(comm);
  if (name === 'node') {
    const at = scriptIndex(words);
    return at >= 0 && isHeavyScript(words, at, precheckPeers);
  }
  if (name === 'bash') return isHeavyBash(words);
  return false;
}

/**
 * `selfPid` and every ancestor of it the table shows (the ppid chain).
 *
 * @param {{ pid: number, ppid: number }[]} rows
 * @param {number | null | undefined} selfPid
 * @returns {Set<number>}
 */
export function lineageOf(rows, selfPid) {
  const out = new Set();
  if (!Number.isInteger(selfPid)) return out;
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  let pid = selfPid;
  while (Number.isInteger(pid) && pid > 0 && !out.has(pid)) {
    out.add(pid);
    pid = parent.get(pid);
  }
  return out;
}

/**
 * The heavy runs in a `ps -axo pid=,ppid=,comm=,args=` text, without `selfPid` and its ancestors (I2).
 *
 * @param {string} psText
 * @param {{ selfPid?: number | null, precheckPeers?: boolean }} [options]
 * @returns {{ pid: number, args: string }[]}
 */
export function heavyRuns(psText, { selfPid = null, precheckPeers = true } = {}) {
  const rows = parsePs(psText);
  const own = lineageOf(rows, selfPid);
  return rows.filter((r) => !own.has(r.pid) && isHeavyRow(r, { precheckPeers })).map((r) => ({ pid: r.pid, args: r.args }));
}

/** One line per run, as `count` prints it. */
export function formatRun(run) {
  return `${run.pid} ${run.args}`;
}

/**
 * Wait until no heavy run is left: read, and while some are left sleep `pollMs` and read again.
 * What it waits for goes to `error` at the first read that finds some and every `noticeMs` after.
 * A table that cannot be read ends the wait (`unreadable`): it is not a lock, and must not hang a tool.
 *
 * @param {{
 *   readPs: () => { ok: boolean, text: string, detail?: string },
 *   sleep: (ms: number) => void,
 *   now: () => number,
 *   error: (line: string) => void,
 *   selfPid?: number | null,
 *   pollMs?: number,
 *   noticeMs?: number,
 *   label?: string,
 *   precheckPeers?: boolean,
 * }} deps
 * @returns {{ waitedMs: number, reads: number, unreadable: string | null }}
 */
export function waitForNoHeavy({ readPs, sleep, now, error, selfPid = null, pollMs = POLL_MS, noticeMs = NOTICE_MS, label = 'heavy-runs', precheckPeers = true }) {
  const started = now();
  let lastNotice = null;
  for (let reads = 1; ; reads++) {
    const table = readPs();
    if (!table.ok) {
      error(`${label}: the process table could not be read (${table.detail ?? 'ps failed'}) — not waiting`);
      return { waitedMs: now() - started, reads, unreadable: table.detail ?? 'ps failed' };
    }
    const runs = heavyRuns(table.text, { selfPid, precheckPeers });
    if (runs.length === 0) return { waitedMs: now() - started, reads, unreadable: null };
    const at = now();
    if (lastNotice === null || at - lastNotice >= noticeMs) {
      lastNotice = at;
      const waited = Math.round((at - started) / 1000);
      error(`${label}: waiting ${waited}s for ${runs.length} heavy run(s): ${runs.map(formatRun).join(' | ')}`);
    }
    sleep(pollMs);
  }
}

/** The real `ps` read. */
export function readPsReal() {
  const out = spawnSync('ps', PS_ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.error || out.status !== 0) return { ok: false, text: '', detail: out.error ? out.error.message : `exit ${out.status}: ${(out.stderr ?? '').trim()}` };
  return { ok: true, text: out.stdout };
}

function sleepReal(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The wait a tool's `isMain` entry gives its `main` as `deps.waitHeavy` (I6): real `ps`, real sleep,
 * this process and its ancestors left out.
 *
 * @param {{ label?: string, error?: (line: string) => void, precheckPeers?: boolean }} [options]
 * @returns {() => { waitedMs: number, reads: number, unreadable: string | null }}
 */
export function heavyWaiter({ label = 'heavy-runs', error = (line) => console.error(line), precheckPeers = true } = {}) {
  return () => waitForNoHeavy({ readPs: readPsReal, sleep: sleepReal, now: () => Date.now(), error, selfPid: process.pid, label, precheckPeers });
}

const USAGE = 'usage: node scripts/orchestrate/heavy-runs.mjs <count|wait>';

/**
 * @param {string[]} argv
 * @param {{
 *   readPs?: () => { ok: boolean, text: string, detail?: string },
 *   sleep?: (ms: number) => void,
 *   now?: () => number,
 *   selfPid?: number | null,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps] the real ones only from the entry below; without `readPs` (and, for wait, `sleep`) nothing is read (exit 2)
 * @returns {number} exit code: count 0 none / 1 some; wait 0; 2 usage or no reader / unreadable table
 */
export function main(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  const [command, ...rest] = argv;
  if ((command !== 'count' && command !== 'wait') || rest.length > 0) {
    error(USAGE);
    return 2;
  }
  if (!deps.readPs || (command === 'wait' && !deps.sleep)) {
    error('heavy-runs: no process reader / sleep was given');
    return 2;
  }
  const selfPid = deps.selfPid ?? null;
  if (command === 'count') {
    const table = deps.readPs();
    if (!table.ok) {
      error(`heavy-runs: the process table could not be read (${table.detail ?? 'ps failed'})`);
      return 2;
    }
    const runs = heavyRuns(table.text, { selfPid });
    for (const run of runs) log(formatRun(run));
    return runs.length === 0 ? 0 : 1;
  }
  const waited = waitForNoHeavy({
    readPs: deps.readPs,
    sleep: deps.sleep,
    now: deps.now ?? (() => Date.now()),
    error,
    selfPid,
  });
  return waited.unreadable === null ? 0 : 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2), { readPs: readPsReal, sleep: sleepReal, now: () => Date.now(), selfPid: process.pid }));
}
