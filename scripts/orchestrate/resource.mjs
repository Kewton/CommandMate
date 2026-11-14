#!/usr/bin/env node
/**
 * `resource.mjs status [--json]` — what the machine semaphore looks like now (Issue #4370 PR1a,
 * docs/design/resource-4370.md §2.3.3).
 *
 * Read only: it creates no directory, takes no lock, writes / removes / marks no record, reclaims
 * nothing, repairs no `state.json` and writes no event. A missing `<root>/cpu.sem/` is "no
 * participants" (not created); a listing that fails is "unknown" (exit 3), never "empty". What it shows
 * is a snapshot from another moment, not a permission to start. `run` (taking a slot) is PR1b.
 *
 * Exit: 0 shown / 2 the config is wrong (`resource: refused …`) / 3 a listing is unknown.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeObserver, processStartMs } from './machine-lock-sync.mjs';
import { loadResourceConfig } from './resource-config.mjs';
import {
  admissible,
  effectiveCapacity,
  gateNext,
  heldWeight,
  holderRetirable,
  isParticipantName,
  orderWaiters,
  waiterRetirable,
} from './resource-sem.mjs';

export const SEM_DIR_NAME = 'cpu.sem';

/** `CM_VERIFY_LOCK_ROOT`, else `~/.commandmate/locks` (the machine-lock root, machine-lock.ts). */
export function resourceRoot(env = process.env) {
  const override = env.CM_VERIFY_LOCK_ROOT;
  return override && override.trim() !== '' ? override : path.join(os.homedir(), '.commandmate', 'locks');
}

const errCode = (err) => (typeof err?.code === 'string' && err.code ? err.code : 'EUNKNOWN');
const tri = (answer) => (answer === true || answer === 'alive' ? 'alive' : answer === false || answer === 'gone' ? 'gone' : 'unknown');

/**
 * List one record directory. ENOENT is an empty, complete listing; any other failure is unknown.
 * A name outside the pattern is not a participant: a `.`-name is a tmp (warned), anything else is
 * named as a stray file. A record gone between the listing and the read (ENOENT) has left.
 */
function readRecords(dir, kind, io, warnings) {
  let names;
  try {
    names = io.readdir(dir);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { complete: true, entries: [] };
    return { complete: false, entries: [], unknown: { point: `list-${kind}`, path: dir, code: errCode(err) } };
  }
  const entries = [];
  for (const name of [...names].sort()) {
    if (!isParticipantName(kind, name)) {
      warnings.push(name.startsWith('.') ? `tmp left in ${kind}/: ${name} (not a participant)` : `stray file in ${kind}/: ${name} (not a participant)`);
      continue;
    }
    let text;
    try {
      text = io.readFile(path.join(dir, name));
    } catch (err) {
      if (errCode(err) === 'ENOENT') continue;
      entries.push({ name, record: null, why: errCode(err) });
      continue;
    }
    let record = null;
    try {
      const parsed = JSON.parse(text);
      record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      record = null;
    }
    entries.push(record ? { name, record } : { name, record: null, why: 'corrupt' });
  }
  return { complete: true, entries };
}

function readState(file, io) {
  try {
    const parsed = JSON.parse(io.readFile(file));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Collect the status. `hooks` replace the observations (tests): `readdir`, `readFile`, `pidAlive`,
 * `groupAlive` (alive / gone / unknown, or a boolean), `startOf`, `loadavg`, `now`, `host`,
 * `availableParallelism`.
 *
 * @returns {{ exit: 0 | 2 | 3, error?: string, status?: any }}
 */
export function collectStatus({ env = process.env, hooks = {} } = {}) {
  const config = loadResourceConfig({ env, availableParallelism: hooks.availableParallelism });
  if ('error' in config) return { exit: 2, error: config.error };

  const io = {
    readdir: hooks.readdir ?? ((dir) => fs.readdirSync(dir)),
    readFile: hooks.readFile ?? ((file) => fs.readFileSync(file, 'utf8')),
  };
  const obs = makeObserver();
  const pidState = (pid) => tri(hooks.pidAlive ? hooks.pidAlive(pid) : obs.pid('pid', pid).state);
  const groupStateOf = (pgid) => tri(hooks.groupAlive ? hooks.groupAlive(pgid) : obs.group('group', pgid).state);
  const startOf = hooks.startOf ?? ((pid) => processStartMs(pid));
  const host = hooks.host ?? os.hostname();
  const now = (hooks.now ?? Date.now)();

  const root = resourceRoot(env);
  const semDir = path.join(root, SEM_DIR_NAME);
  const warnings = [...config.warnings];

  let semExists = true;
  let unknown = null;
  try {
    io.readdir(semDir);
  } catch (err) {
    if (errCode(err) === 'ENOENT') semExists = false;
    else unknown = { point: 'list-sem', path: semDir, code: errCode(err) };
  }

  let holders = { complete: true, entries: [] };
  let waiters = { complete: true, entries: [] };
  if (semExists && !unknown) {
    holders = readRecords(path.join(semDir, 'holders'), 'holders', io, warnings);
    waiters = readRecords(path.join(semDir, 'waiters'), 'waiters', io, warnings);
    unknown = holders.unknown ?? waiters.unknown ?? null;
  }
  const complete = !unknown && holders.complete && waiters.complete;

  // Holders: who would be reclaimed, and what the rest look like.
  const holderEnv = { host, groupAlive: groupStateOf, startOf };
  const holderRows = holders.entries.map((entry) => {
    const r = entry.record;
    const row = { name: entry.name, corrupt: r === null, record: r, retirable: r ? holderRetirable(r, holderEnv) : null };
    if (r === null) {
      warnings.push(`corrupt holder record holders/${entry.name} (${entry.why}); the capacity is unknown until a person removes it`);
      return row;
    }
    if (r.host !== host) warnings.push(`holder ${entry.name} is from another host (${r.host}); never reclaimed here`);
    else {
      if (r.leaderStart === null) warnings.push(`holder ${entry.name} has leaderStart: null (its group number cannot be checked for reuse)`);
      if (!row.retirable && typeof r.pid === 'number' && Number.isInteger(r.pgid)) {
        const group = groupStateOf(r.pgid);
        if (group === 'unknown') warnings.push(`holder ${entry.name}: its group ${r.pgid} cannot be observed (counted as alive)`);
        else if (group === 'alive' && pidState(r.pid) === 'gone') {
          warnings.push(`holder ${entry.name}: pid ${r.pid} is dead but its group ${r.pgid} lives (the slot returns when the group ends)`);
        }
      }
    }
    return row;
  });
  const liveHolders = holderRows.filter((row) => !row.retirable).map((row) => ({ name: row.name, record: row.record }));

  // Waiters: retirable by the ticket's rule, used, or already admitted.
  const heldTokens = new Set(liveHolders.filter((h) => h.record).map((h) => h.record.token));
  const waiterEnv = { host, now, pidAlive: (pid) => pidState(pid) !== 'gone', groupAlive: (pgid) => groupStateOf(pgid) !== 'gone', startOf };
  const waiterRows = waiters.entries.map((entry) => {
    const r = entry.record;
    let retirable = null;
    if (r === null) warnings.push(`corrupt waiter record waiters/${entry.name} (${entry.why}); the capacity is unknown until a person removes it`);
    else if (r.done === true) retirable = 'done';
    else if (typeof r.token === 'string' && heldTokens.has(r.token)) retirable = 'admitted';
    else {
      retirable = waiterRetirable(r, waiterEnv);
      if (r.host !== host && !retirable) warnings.push(`waiter ${entry.name} is from another host (${r.host})`);
    }
    return { name: entry.name, corrupt: r === null, record: r, retirable };
  });
  const liveWaiters = waiterRows.filter((row) => !row.retirable).map((row) => ({ name: row.name, record: row.record }));

  const participants = [...liveHolders, ...liveWaiters];
  const effectiveC = complete ? effectiveCapacity({ own: config.C, participants, complete: true }) : { state: 'unknown', point: unknown.point };
  // Prereview 3, P3-1: the participants' own minimum, without this process's config.
  let participantsMin;
  if (!complete) participantsMin = { state: 'unknown', point: unknown.point };
  else if (participants.length === 0) participantsMin = { state: 'ok', capacity: null };
  else participantsMin = effectiveCapacity({ own: Number.MAX_SAFE_INTEGER, participants, complete: true });

  const state = semExists && !unknown ? readState(path.join(semDir, 'state.json'), io) : null;
  const gateSaved = state && (state.gate === 'open' || state.gate === 'closed') ? state.gate : null;
  const copyCapacity = state && state.copy && typeof state.copy === 'object' ? state.copy.capacity ?? null : null;
  const load = (hooks.loadavg ?? os.loadavg)();
  const gate = gateNext({ prev: gateSaved, load, ncpu: config.ncpu, ceiling: config.loadCeiling, resume: config.loadResume });

  const used = effectiveC.state === 'ok' ? heldWeight({ capacity: effectiveC.capacity, holders: liveHolders }) : liveHolders.every((h) => h.record && Number.isInteger(h.record.weight)) ? heldWeight({ capacity: 0, holders: liveHolders }) : null;

  const ordered = orderWaiters({ waiters: liveWaiters, holders: liveHolders });
  const head = ordered[0] ?? null;
  let next = null;
  if (head) {
    const ok = effectiveC.state === 'ok' && !head.corrupt && admissible({
      capacity: effectiveC.capacity,
      holders: liveHolders,
      waiter: { priority: head.record.priority, weight: head.record.weight },
      gate,
    });
    next = { name: head.name, admissible: ok };
  }

  if (effectiveC.state === 'unknown' && complete) warnings.push(`the effective capacity is unknown (${effectiveC.point}${effectiveC.name ? ` ${effectiveC.name}` : ''}); admission stops`);
  if (copyCapacity !== null && effectiveC.state === 'ok' && copyCapacity !== effectiveC.capacity) {
    warnings.push(`state.json copy.capacity=${copyCapacity} differs from the observed effective capacity ${effectiveC.capacity} (the copy is not used)`);
  }

  const status = {
    root,
    present: semExists,
    S: config.S,
    ownC: config.C,
    effectiveC,
    participantsMin,
    gateSaved,
    gateNext: gate,
    load1: Array.isArray(load) ? load[0] : null,
    used,
    copyCapacity,
    holders: holderRows.map(({ name, corrupt, record, retirable }) => ({ name, corrupt, retirable, ...(record ? pick(record) : {}) })),
    waiters: waiterRows.map(({ name, corrupt, record, retirable }) => ({ name, corrupt, retirable, ...(record ? pick(record) : {}) })),
    order: ordered.map((w) => w.name),
    next,
    unknown,
    warnings,
  };
  return { exit: unknown ? 3 : 0, status };
}

function pick(record) {
  const out = {};
  for (const key of ['token', 'pid', 'host', 'pgid', 'leaderStart', 'priority', 'weight', 'ownCapacity', 'admittedCapacity', 'reason', 'repo', 'createdAt', 'deadline', 'done']) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

const capText = (c) => (c.state === 'ok' ? String(c.capacity ?? '-') : `不明 (${c.point}${c.name ? ` ${c.name}` : ''})`);

function formatText(s) {
  const lines = [];
  lines.push(`root: ${s.root}`);
  lines.push(`S=${s.S} own C=${s.ownC} effective C=${capText(s.effectiveC)} participants min=${capText(s.participantsMin)}`);
  lines.push(`gate: saved=${s.gateSaved ?? '読めない(closed とみなす)'} next=${s.gateNext} load1=${s.load1 ?? '-'}`);
  if (s.unknown) {
    lines.push(`参加者: 不明 (${s.unknown.point} ${s.unknown.path} ${s.unknown.code})`);
  } else if (!s.present || (s.holders.length === 0 && s.waiters.length === 0)) {
    lines.push('参加者なし');
  } else {
    lines.push(`used=${s.used ?? '不明'}`);
    for (const h of s.holders) {
      lines.push(`holder ${h.name} ${h.corrupt ? '壊れた記録' : `${h.priority} weight=${h.weight} own=${h.ownCapacity} pid=${h.pid} pgid=${h.pgid}`}${h.retirable ? ` 回収の候補(${h.retirable})` : ''}`);
    }
    for (const w of s.waiters) {
      lines.push(`waiter ${w.name} ${w.corrupt ? '壊れた記録' : `${w.priority} weight=${w.weight} own=${w.ownCapacity} pid=${w.pid}`}${w.retirable ? ` 回収の候補(${w.retirable})` : ''}`);
    }
    lines.push(`order: ${s.order.join(' ') || '-'}`);
    if (s.next) lines.push(`next: ${s.next.name} ${s.next.admissible ? '入れる' : '入れない'}`);
  }
  for (const w of s.warnings) lines.push(`warn: ${w}`);
  lines.push('(別の時点の写し。取得の許可ではない)');
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage: resource.mjs status [--json]';

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, hooks?: any, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const [command, ...rest] = argv;
  if (command !== 'status' || rest.some((a) => a !== '--json')) {
    err(`resource: refused ${command === undefined ? 'no command' : `unknown arguments ${argv.join(' ')}`}\n${USAGE}\n`);
    return 2;
  }
  const json = rest.includes('--json');
  const result = collectStatus({ env: io.env ?? process.env, hooks: io.hooks ?? {} });
  if (result.exit === 2) {
    err(`resource: refused ${result.error}\n`);
    return 2;
  }
  out(json ? `${JSON.stringify(result.status, null, 2)}\n` : formatText(result.status));
  if (result.exit === 3) err(`resource: unknown point=${result.status.unknown.point} path=${result.status.unknown.path} errno=${result.status.unknown.code}\n`);
  return result.exit;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
