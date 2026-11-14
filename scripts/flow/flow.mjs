#!/usr/bin/env node
/**
 * `node scripts/flow/flow.mjs <tick|reconstruct|report|status> …` — the team's flow, PR1a
 * (Issue #4367, docs/design/flow-metrics-4367.md §2・§3・§6).
 *
 * PR1a measures two things only: how many PRs the GitHub search returned as created and as
 * merged in `[from, to)` for one repo + base (`coverage: "search-observed"`: the count the
 * search showed, not the proven population — `complete` is never true here). No CI, ledger,
 * alert, notification or resource is read or written.
 *
 * Exit: 0 done (or a tick skipped because another holds the lock) / 1 not written, unfinished
 * tail, lock not observable, release failed, unexpected / 2 arguments, settings, identification.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireMachineLockSync } from '../orchestrate/machine-lock-sync.mjs';
import { machineLockRoot } from '../orchestrate/precheck.mjs';
import { defaultMonoNow, defaultRun, makeRunBounded } from './runner.mjs';
import { isValidTimeZone, readFlowConfig } from './config.mjs';
import { appendTick, flowDirOf, readTicks } from './record.mjs';
import { readPrCounts } from './sources.mjs';
import { MAX_WINDOW_MS, dayWindow, hourlyPrCounts, parseIsoTime, tickWindow, zonedParts } from './aggregate.mjs';

export const IDENTIFY_BUDGET_MS = 30_000;
export const FETCH_BUDGET_MS = 200_000;
export const METRICS = ['prCreated', 'prMerged'];
/** What PR1a does not record; shown as unsupported, never as 0 (P-3, T-P P16). */
export const UNSUPPORTED = ['openPrs', 'ciQueue', 'ledgerWip', 'leadTime', 'resources', 'alerts'];
const LABEL = { prCreated: 'PR created', prMerged: 'PR merged' };
const COUNT_NOTE = '観測した件数（検索） — 母集団の完全な数ではない (observed by search, not proven complete)';

const USAGE = `usage: flow.mjs tick [--repo-root <dir>] [--tz <IANA>]
       flow.mjs reconstruct (--date <YYYY-MM-DD> | --from <ISO> --to <ISO>) [--repo-root <dir>] [--tz <IANA>] [--json]
       flow.mjs report --from <ISO> --to <ISO> [--repo-root <dir>] [--tz <IANA>] [--json]
       flow.mjs status [--repo-root <dir>] [--tz <IANA>] [--json]`;

const OPTIONS = {
  tick: ['--repo-root', '--tz'],
  reconstruct: ['--repo-root', '--tz', '--date', '--from', '--to', '--json'],
  report: ['--repo-root', '--tz', '--from', '--to', '--json'],
  status: ['--repo-root', '--tz', '--json'],
};
const FLAGS = new Set(['--json']);

/**
 * @returns {{ cmd: string, opts: Record<string, string | true> } | { error: string }}
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !Object.prototype.hasOwnProperty.call(OPTIONS, cmd)) return { error: `unknown command "${cmd ?? ''}"` };
  /** @type {Record<string, string | true>} */
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!OPTIONS[cmd].includes(arg)) return { error: `${cmd} does not take ${arg}` };
    if (arg in opts) return { error: `${arg} given twice` };
    if (FLAGS.has(arg)) {
      opts[arg] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    opts[arg] = value;
    i += 1;
  }
  if (opts['--tz'] !== undefined && !isValidTimeZone(opts['--tz'])) return { error: `--tz "${opts['--tz']}" is not a time zone` };
  if (cmd === 'reconstruct') {
    if (opts['--date'] !== undefined && (opts['--from'] !== undefined || opts['--to'] !== undefined)) {
      return { error: '--date cannot be used with --from/--to' };
    }
    if (opts['--date'] === undefined && (opts['--from'] === undefined || opts['--to'] === undefined)) {
      return { error: 'reconstruct needs --date, or --from and --to' };
    }
  }
  if (cmd === 'report' && (opts['--from'] === undefined || opts['--to'] === undefined)) return { error: 'report needs --from and --to' };
  if (opts['--from'] !== undefined || opts['--to'] !== undefined) {
    const range = parseRange(opts['--from'], opts['--to']);
    if ('error' in range) return range;
  }
  if (opts['--date'] !== undefined && dayWindow(String(opts['--date']), 'UTC') === null) {
    return { error: `--date "${opts['--date']}" is not a calendar date (YYYY-MM-DD)` };
  }
  return { cmd, opts };
}

function parseRange(fromText, toText) {
  if (fromText === undefined || toText === undefined) return { error: '--from and --to go together' };
  const from = parseIsoTime(fromText);
  const to = parseIsoTime(toText);
  if (from === null || to === null) return { error: '--from/--to must be ISO times with a zone (e.g. 2026-11-13T00:00:00+09:00)' };
  if (!(from < to)) return { error: '--from must be before --to' };
  if (to - from > MAX_WINDOW_MS) return { error: 'the window is over 31 days' };
  return { from, to };
}

const iso = (ms) => new Date(ms).toISOString();

function describeValue(metric) {
  if (!metric || typeof metric !== 'object') return 'unsupported';
  if (metric.value === null || metric.value === undefined) return `unknown (${metric.why ?? 'no reason'})`;
  return `${metric.value}（観測した件数・検索）`;
}

function hourLabel(key, tz) {
  const ms = Date.parse(`${key.slice(0, 13)}:00:00${key.slice(13)}`);
  const p = zonedParts(ms, tz);
  return `${p.date} ${p.hour}:00 ${p.offset}`;
}

/**
 * @param {string[]} argv
 * @param {{ run?: Function, monoNow?: () => number, now?: () => number, env?: Record<string, string | undefined>, home?: string, cwd?: string, lock?: Function, stdout?: (line: string) => void, stderr?: (line: string) => void, uuid?: () => string }} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const monoNow = deps.monoNow ?? defaultMonoNow;
  const now = deps.now ?? (() => Date.now());
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const lock = deps.lock ?? acquireMachineLockSync;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const runBounded = makeRunBounded({ run: deps.run ?? defaultRun, monoNow });
  const started = monoNow();

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    err(`flow: ${parsed.error}`);
    err(USAGE);
    return 2;
  }
  const { cmd, opts } = parsed;
  const repoRoot = path.resolve(deps.cwd ?? process.cwd(), String(opts['--repo-root'] ?? '.'));
  const config = readFlowConfig(repoRoot, {
    runBounded,
    env,
    deadlineMono: started + IDENTIFY_BUDGET_MS,
    tz: /** @type {string | undefined} */ (opts['--tz']),
  });
  if ('error' in config) {
    err(`flow: ${config.error}`);
    return 2;
  }
  const scope = { repo: config.repo, base: config.base };
  const recordDir = path.join(flowDirOf(env, home), config.slug);
  const json = opts['--json'] === true;

  if (cmd === 'tick') return tick({ config, scope, recordDir, env, home, lock, runBounded, monoNow, now, uuid, out, err });
  if (cmd === 'reconstruct') return reconstruct({ config, scope, opts, runBounded, monoNow, now, json, out });
  if (cmd === 'report') return report({ config, scope, opts, recordDir, json, out, err });
  return status({ config, scope, recordDir, json, out, err });
}

function tick({ config, scope, recordDir, env, home, lock, runBounded, monoNow, now, uuid, out, err }) {
  let held;
  try {
    held = lock(`flow.${config.slug}`, { root: machineLockRoot(home, env), timeoutMs: 0, warn: (line) => err(`flow: ${line}`) });
  } catch (e) {
    err(`flow: lock failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!held || !held.acquired) {
    if (held?.unknown) {
      err(`flow: lock not observable (${held.unknown.point} ${held.unknown.code}); not measuring`);
      return 1;
    }
    err(`flow: tick skipped: held by ${held?.heldBy ?? 'another tick'}`);
    return 0;
  }
  // Stage 4-8 (§3.3): one try/finally, one release, one exit decision.
  let exit = 1;
  let summary = null;
  try {
    const t0 = monoNow();
    const atMs = now();
    const window = tickWindow(atMs);
    const counts = readPrCounts(runBounded, { ...scope, window, deadlineMono: t0 + FETCH_BUDGET_MS, now });
    const tickRecord = {
      v: 1,
      kind: 'tick',
      tickId: uuid(),
      at: iso(atMs),
      repo: scope.repo,
      base: scope.base,
      window: { from: iso(window.from), to: iso(window.to) },
      metrics: { prCreated: counts.prCreated, prMerged: counts.prMerged },
      durationMs: Math.max(0, Math.round(monoNow() - t0)),
    };
    const written = appendTick(recordDir, tickRecord, { tz: config.tz });
    if (!written.ok) {
      if (written.reason === 'unfinished-tail') err(`flow: unfinished tail in ${written.file}; not appending`);
      else err(`flow: cannot write ${written.file} (${written.code})`);
    } else {
      exit = 0;
      summary = `flow: tick ${tickRecord.tickId} ${scope.repo}@${scope.base} [${tickRecord.window.from}, ${tickRecord.window.to}) prCreated=${describeValue(counts.prCreated)} prMerged=${describeValue(counts.prMerged)} -> ${written.file}`;
    }
  } catch (e) {
    exit = 1;
    summary = null;
    err(`flow: tick failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    let released;
    try {
      released = held.release();
    } catch (e) {
      released = null;
      err(`flow: lock release failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (released !== 'released') {
      if (released !== null) err(`flow: lock release answered ${released}`);
      exit = 1;
      summary = null;
    }
  }
  if (exit === 0 && summary) out(summary);
  return exit;
}

function reconstruct({ config, scope, opts, runBounded, monoNow, now, json, out }) {
  const window = opts['--date'] !== undefined ? dayWindow(String(opts['--date']), config.tz) : parseRange(opts['--from'], opts['--to']);
  if (!window || 'error' in window) return 2;
  // The fetch deadline starts after identification, as tick's starts after the lock (§3.2).
  const deadlineMono = monoNow() + FETCH_BUDGET_MS;
  const counts = readPrCounts(runBounded, { ...scope, window, deadlineMono, now });
  const table = hourlyPrCounts(counts.events, { ...window, tz: config.tz });
  const result = {
    repo: scope.repo,
    base: scope.base,
    tz: config.tz,
    window: { from: iso(window.from), to: iso(window.to) },
    coverage: 'search-observed',
    metrics: { prCreated: counts.prCreated, prMerged: counts.prMerged },
    hours: table.hours,
    totals: table.totals,
  };
  if (json) {
    out(JSON.stringify(result));
    return 0;
  }
  out(`${scope.repo}@${scope.base} [${result.window.from}, ${result.window.to}) tz=${config.tz} — ${COUNT_NOTE}`);
  for (const name of METRICS) out(`${LABEL[name]}: ${describeValue(result.metrics[name])}`);
  out('hour\tcreated\tmerged');
  for (const row of table.hours) out(`${hourLabel(row.hour, config.tz)}\t${row.prCreated ?? 'unknown'}\t${row.prMerged ?? 'unknown'}`);
  out(`total\t${table.totals.prCreated ?? 'unknown'}\t${table.totals.prMerged ?? 'unknown'}`);
  return 0;
}

function readMeta(read) {
  return {
    recordsExist: read.exists,
    corruptLines: read.corruptLines,
    unfinishedTail: read.unfinishedFiles.length > 0,
    unfinishedFiles: read.unfinishedFiles,
    truncated: read.truncatedFiles.length > 0,
    truncatedFiles: read.truncatedFiles,
    unreadable: read.unreadable,
  };
}

function printMeta(meta, out) {
  if (meta.unfinishedTail) out(`unfinished tail (not a record; a person fixes it): ${meta.unfinishedFiles.join(', ')}`);
  if (meta.corruptLines > 0) out(`corrupt lines skipped: ${meta.corruptLines}`);
  if (meta.truncated) out(`not read (over the size limit; no values shown for them): ${meta.truncatedFiles.join(', ')}`);
  out(`unsupported (not recorded by this version): ${UNSUPPORTED.join(', ')}`);
}

function observation(rec) {
  const metrics = {};
  for (const name of METRICS) metrics[name] = rec.metrics?.[name] ?? null;
  return { tickId: rec.tickId, at: rec.at, window: rec.window, metrics };
}

function report({ scope, opts, recordDir, json, out, err }) {
  const range = parseRange(opts['--from'], opts['--to']);
  if ('error' in range) return 2;
  const read = readTicks(recordDir, scope, { from: range.from, to: range.to });
  if (read.unreadable.length > 0) {
    err(`flow: cannot read the record: ${read.unreadable.map((u) => `${u.file} (${u.code})`).join(', ')}`);
    return 1;
  }
  const meta = readMeta(read);
  const observations = read.ticks.map(observation);
  if (json) {
    out(JSON.stringify({ ...scope, from: iso(range.from), to: iso(range.to), coverage: 'search-observed', observations, unsupported: UNSUPPORTED, ...meta }));
    return 0;
  }
  out(`${scope.repo}@${scope.base} observations with at in [${iso(range.from)}, ${iso(range.to)}) — ${COUNT_NOTE}; windows are not summed`);
  if (observations.length === 0) out(read.exists ? 'no observations in the range' : 'no records');
  for (const o of observations) {
    out(`${o.at} window [${o.window.from}, ${o.window.to}) ${METRICS.map((n) => `${LABEL[n]}=${describeValue(o.metrics[n])}`).join(' ')}`);
  }
  printMeta(meta, out);
  return 0;
}

function status({ scope, recordDir, json, out, err }) {
  const read = readTicks(recordDir, scope);
  if (read.unreadable.length > 0) {
    err(`flow: cannot read the record: ${read.unreadable.map((u) => `${u.file} (${u.code})`).join(', ')}`);
    return 1;
  }
  const meta = readMeta(read);
  let latest = read.ticks.length > 0 ? read.ticks[read.ticks.length - 1] : null;
  // A newer file that was not read may hold a later observation: do not call an older one the latest.
  const newestRead = read.filesRead.length > 0 ? path.basename(read.filesRead[0]) : '';
  if (latest && read.truncatedFiles.some((file) => path.basename(file) > newestRead)) latest = null;
  const state = latest ? 'observed' : meta.unfinishedTail ? 'unfinished-only' : meta.truncated ? 'truncated' : 'no-records';
  if (json) {
    out(JSON.stringify({ ...scope, state, coverage: 'search-observed', latest: latest ? observation(latest) : null, unsupported: UNSUPPORTED, ...meta }));
    return 0;
  }
  out(`${scope.repo}@${scope.base}`);
  if (latest) {
    const o = observation(latest);
    out(`latest observation ${o.at} window [${o.window.from}, ${o.window.to}) — ${COUNT_NOTE}`);
    for (const name of METRICS) out(`  ${LABEL[name]}: ${describeValue(o.metrics[name])}`);
  } else if (state === 'unfinished-only') {
    out('no finished record (only an unfinished tail)');
  } else if (state === 'truncated') {
    out('latest observation not shown (a record file is over the size limit)');
  } else {
    out('no records');
  }
  printMeta(meta, out);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
