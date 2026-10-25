#!/usr/bin/env node
/**
 * `/orchestrate` 5-2b: ask Codex for the consistency review of one Issue's
 * HEAD, keep its answer, and record it (Issue #3528).
 *
 * Until this file each run copied a hand-written `review-<N>.sh`. What one
 * copy got wrong: it cut the reply at the first `> **Thinking`, and a review
 * that quoted `> **Thinking**` in a finding lost the rest of its findings and
 * its `DONE:` line. The reply (`ask --json`'s `reply`) is the answer followed
 * by the thinking section, which starts on a line of its own with
 * `> **Thinking (<n>)**`, and/or the tool-call section `> **Tool calls (<n>)**`
 * (a reply may carry only the latter); only the earlier of those lines ends
 * the answer (extractReplyBody, Issue #3539).
 *
 * One call does what the hand-written script and docs/orchestrate/trials.md
 * did by hand:
 *   0. with `--instance <id|alias>` (default codex, no lookup), resolves it to the
 *      real instance id with the server's resolve-target, asked through `--cli`
 *      like capture and ask (resolve-instance.mjs; failure = exit 2, nothing sent);
 *   1. takes the reviewer's lock (`workspace/proposals/<date>/.lock` for codex,
 *      `.lock-<instance id>` for another), which every ask of that session
 *      shares — a session is used one ask at a time. The lock holds its
 *      owner's pid and start time; a lock whose owner is gone (a review that
 *      was killed) is taken over, and a live one is waited for with a
 *      `lock held by pid …` line on stderr every minute (#3633);
 *   2. waits until `capture --instance <id> --json` reads `ready` three times
 *      in a row;
 *   3. sends the brief built from templates/consistency-review.md (or
 *      consistency-review-rereview.md with the previous answer; `--routes`
 *      adds the plan's interrupt order and readers, plan-check.mjs routes, #3884) with
 *      `ask <wt> <brief> --instance <resolved id> --timeout 2400 --json`;
 *   4. writes `review-<N>[-<item>][b|c…].{prompt.txt,json,err,md}` to the run
 *      directory, the `.md` being the answer without the thinking. The
 *      `.prompt.txt` is created exclusively, so two reviews of one Issue never
 *      take the same name; `--item` names the work item of the review (one PR
 *      of an Issue with several, execution-key.mjs) and goes to the record (#3883);
 *   5. on an answer with a `DONE:` line appends one row to
 *      `consistency-review.md` and records `review=ok`; anything else records
 *      `review=fail` (run-log.mjs);
 *   6. reads the dependency links of the reviewed worktree and of every
 *      worktree of its repository (`git worktree list`) before the ask and
 *      after it: a link under `node_modules` that leads out of its worktree
 *      and appeared during the review (dependency-links.mjs) means the
 *      reviewer wrote into a dependency tree. The answer is kept but is not a
 *      verdict: `review=fail` with the links, exit 1 (#3883 P6).
 *
 * The columns a person judges (unique findings, kind, new/existing,
 * re-judgement, action, pre-review) are written as `未` for the orchestrator to
 * fill in.
 *
 * Exit code: 0 the answer has a `DONE:` line; 1 the review failed (lock, Codex
 * not ready, ask failed, no `DONE:` line) and was recorded as `fail`; 2 is a
 * usage error (nothing is sent or recorded).
 *
 * Usage:
 *   node scripts/orchestrate/consistency-review.mjs --run-dir <dir> --issues <range> --issue <N>
 *        --head <sha> --brief <file> [--rereview --previous <review md>]
 *        [--worktree <path>] [--wt <reviewer worktree-id>] [--lock <dir>] [--cli <commandmatedev>] [--instance <id|alias>]
 *        [--item <work item>] [--routes <plan-check.mjs routes output>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, runLogPath } from './run-log.mjs';
import { isInstanceSelector, resolveInstanceThroughCli } from './resolve-instance.mjs';
import { itemProblem, workItemName } from './execution-key.mjs';
import { addedLinks, parseWorktreeList, snapshotForeignLinks } from './dependency-links.mjs';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');
export const INITIAL_TEMPLATE = path.join(TEMPLATE_DIR, 'consistency-review.md');
export const REREVIEW_TEMPLATE = path.join(TEMPLATE_DIR, 'consistency-review-rereview.md');

export const REVIEWER_INSTANCE = 'codex';
export const DEFAULT_REVIEWER_WT = 'mycodebranchdesk';
export const ASK_TIMEOUT_SEC = 2400;
export const READY_STREAK = 3;
export const READY_POLL_SEC = 10;
export const READY_MAX_POLLS = 180;
export const LOCK_POLL_SEC = 15;
/**
 * How long a live owner's lock is waited for: one ask plus a margin (#3633).
 * A killed owner's lock is not waited on at all (see acquireLock).
 */
export const LOCK_MAX_WAIT_SEC = ASK_TIMEOUT_SEC + 600;
/** How often the wait for a held lock says so on stderr. */
export const LOCK_NOTICE_SEC = 60;
/** The file in the lock directory that names its owner. */
export const LOCK_OWNER_FILE = 'owner.json';
/** Upper bound of the instance lookup; past it the review is not sent. */
export const RESOLVE_TIMEOUT_MS = 30_000;

/** The header of `consistency-review.md` (docs/orchestrate/trials.md#5-2b-整合性レビューの進め方と記録). */
export const TABLE_HEADER = [
  '| # | Issue | 担当 | 依頼した HEAD | 時間（待ちを含む） | 指摘 | 独自の発見（重複・既報を除く） | 種類（動作／説明／テスト） | 新規／既存 | 再判定 | 処置 | 事前レビューの有無 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
];

/**
 * The line that opens the thinking or tool-call section of an `ask --json`
 * reply. Only a line that starts with it ends the answer: the answer may quote
 * `> **Thinking**` / `> **Tool calls**` (the hand-written split on
 * `> **Thinking` lost findings and the `DONE:` line that way).
 */
export const THINKING_START = /\n> \*\*(?:Thinking|Tool calls) \(/;

/** The answer of a reply: everything before the first thinking / tool-call section. */
export function extractReplyBody(reply) {
  const text = String(reply ?? '');
  const match = THINKING_START.exec(text);
  return (match ? text.slice(0, match.index) : text).trimEnd();
}

/** The last `DONE:` line of the answer, or null. */
export function findDoneLine(body) {
  const lines = String(body)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('DONE:'));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** The finding count a `DONE:` line states (`指摘なし` → 0, `指摘 2 件` → 2), or null. */
export function findingCount(doneLine) {
  if (!doneLine) return null;
  const counted = /指摘\s*(\d+)\s*件/.exec(doneLine);
  if (counted) return Number(counted[1]);
  return /指摘なし/.test(doneLine) ? 0 : null;
}

/**
 * Fill `{{NAME}}` placeholders. A placeholder without a value, or a `{{` that
 * is not a placeholder (`{{ ISSUE }}`, `{{issue}}`), is an error: a brief that
 * still says `{{HEAD}}` would ask about nothing. Values are not scanned, so a
 * previous answer that contains `{{` is sent as it is.
 */
export function renderTemplate(template, values) {
  const missing = [];
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => {
    if (values[name] === undefined || values[name] === null) {
      missing.push(name);
      return whole;
    }
    return String(values[name]);
  });
  if (missing.length > 0) throw new Error(`template placeholder(s) without a value: ${[...new Set(missing)].join(', ')}`);
  if (template.replace(/\{\{([A-Z_]+)\}\}/g, '').includes('{{')) {
    throw new Error('template has a "{{" that is not a {{NAME}} placeholder');
  }
  return rendered;
}

/** What the brief says in place of the routes table when the run has none (#3884). */
export const NO_ROUTES =
  '（渡されていない。plan に共有状態の表が無い run。差分から、変えた共有状態・関数・定数を読む経路を自分で探す）';

/**
 * The brief sent to Codex. `previous` (the earlier answer) makes it a
 * re-review: the previous findings are judged first, then the review as usual.
 *
 * `routes` (plan-check.mjs routes) is the interrupt order and the readers of
 * the shared states the change writes; without it the brief says there is none.
 *
 * @param {{ issue: number, head: string, worktree: string, branch: string, brief: string, previous?: string, routes?: string }} input
 * @param {{ initial?: string, rereview?: string }} [templates]
 */
export function buildPrompt({ issue, head, worktree, branch, brief, previous, routes }, templates = {}) {
  const initial = templates.initial ?? fs.readFileSync(INITIAL_TEMPLATE, 'utf8');
  const body = renderTemplate(initial, {
    ISSUE: issue,
    HEAD: head,
    WORKTREE: worktree,
    BRANCH: branch,
    BRIEF: String(brief).trimEnd(),
    ROUTES: routes === undefined || routes === null || String(routes).trim() === '' ? NO_ROUTES : String(routes).trimEnd(),
  }).trimEnd();
  if (previous === undefined || previous === null) return `${body}\n`;
  const rereview = templates.rereview ?? fs.readFileSync(REREVIEW_TEMPLATE, 'utf8');
  return `${renderTemplate(rereview, {
    ISSUE: issue,
    HEAD: head,
    WORKTREE: worktree,
    PREVIOUS: extractReplyBody(previous),
    REVIEW_BODY: body,
  }).trimEnd()}\n`;
}

const REVIEW_SUFFIXES = ['', ...'bcdefghijklmnopqrstuvwxyz'];
const usedLabel = (runDir, label) => ['.md', '.json', '.prompt.txt'].some((ext) => fs.existsSync(path.join(runDir, `${label}${ext}`)));

/**
 * `review-<N>`, then `review-<N>b`, `review-<N>c` … — the first name no earlier
 * review of the run used. With `item` (#3883) the work item is in the name:
 * `review-<N>-<item>`.
 */
export function nextReviewLabel(runDir, issue, item) {
  for (const suffix of REVIEW_SUFFIXES) {
    const label = `review-${workItemName(issue, item)}${suffix}`;
    if (!usedLabel(runDir, label)) return label;
  }
  throw new Error(`too many reviews of #${workItemName(issue, item)} in ${runDir}`);
}

/**
 * Take the next label and write its `.prompt.txt` in one step (`wx`): a
 * review started at the same time takes the next name instead of writing
 * over this one's files (#3883). Returns the label.
 */
export function claimReviewLabel(runDir, issue, item, prompt) {
  for (const suffix of REVIEW_SUFFIXES) {
    const label = `review-${workItemName(issue, item)}${suffix}`;
    if (usedLabel(runDir, label)) continue;
    try {
      fs.writeFileSync(path.join(runDir, `${label}.prompt.txt`), prompt, { flag: 'wx' });
      return label;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`too many reviews of #${workItemName(issue, item)} in ${runDir}`);
}

/** Append one row to `consistency-review.md` (created with its header if absent); returns the row. */
export function appendReviewRow(file, { issue, item, rereview, head, durationSec, doneLine }) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const numbers = [...existing.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  const count = findingCount(doneLine);
  const cells = [
    String(next),
    `#${issue}${item ? `/${item}` : ''}${rereview ? ' 再レビュー' : ''}`,
    'Codex',
    head.slice(0, 7),
    `${durationSec} 秒`,
    count === null ? `?（${doneLine}）` : `${count}（${doneLine}）`,
    '未',
    '未',
    '未',
    '未',
    '未',
    '未',
  ];
  const row = `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`;
  let prefix = existing === '' ? `${TABLE_HEADER.join('\n')}\n` : '';
  if (existing !== '' && !existing.endsWith('\n')) prefix = '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${prefix}${row}\n`);
  return row;
}

function defaultRun(command, args, { cwd, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The owner a lock directory names, or null (no owner file yet, or a lock from before #3633). */
export function readLockOwner(lock) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, LOCK_OWNER_FILE), 'utf8'));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

/**
 * Whether the owner of a lock is gone. Only a process on this host that no
 * longer exists is gone: another host's pid, or one this process may not
 * signal (EPERM), is alive as far as this can tell.
 */
export function lockOwnerGone(owner) {
  if (!owner || owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return Boolean(err && err.code === 'ESRCH');
  }
}

const describeOwner = (owner) =>
  owner ? `pid ${owner.pid} (since ${owner.startedAt ?? '?'})` : 'an unknown owner (no owner file)';
const sameOwner = (a, b) => Boolean(a && b && a.pid === b.pid && a.startedAt === b.startedAt && a.host === b.host);

/** The directory a waiter holds while it removes a dead owner's lock (one reclaimer at a time). */
export const reclaimDirOf = (lock) => `${lock}.reclaim`;

/**
 * Remove `lock` if it still names `deadOwner`, holding the reclaim directory
 * while doing so (#3633). Two waiters can see the same dead owner; without the
 * reclaim directory one could check the owner, the other remove the lock and
 * take a new one, and the first then move that new, live lock aside. The
 * reclaim directory is taken with mkdir (atomic), so the owner is re-read and
 * the lock moved by one waiter at a time; a lock taken by anyone else in
 * between names another owner and is left as it is. Nobody but a reclaimer
 * removes a lock whose owner is dead, so it cannot change between the re-read
 * and the rename.
 *
 * `between` runs after the re-read and before the rename (tests only).
 *
 * @returns {'reclaimed' | 'changed' | 'busy'} removed / the lock names
 *   someone else now (or is gone) / another waiter is reclaiming
 */
export function reclaimStaleLock(lock, deadOwner, { now, error, between = () => {} }) {
  const reclaim = reclaimDirOf(lock);
  try {
    fs.mkdirSync(reclaim);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
    const holder = readLockOwner(reclaim);
    if (lockOwnerGone(holder)) {
      // Killed in the few calls between taking and removing it: removing it here
      // could let two waiters reclaim at once, so a person decides.
      throw new Error(`${reclaim} is left by ${describeOwner(holder)}, which is gone — remove it if no review is waiting on ${lock}`);
    }
    return 'busy';
  }
  const me = { pid: process.pid, host: os.hostname(), startedAt: now().toISOString() };
  try {
    fs.writeFileSync(path.join(reclaim, LOCK_OWNER_FILE), `${JSON.stringify(me)}\n`);
    if (!sameOwner(readLockOwner(lock), deadOwner)) return 'changed';
    between();
    const aside = `${lock}.stale-${process.pid}-${now().getTime()}`;
    fs.renameSync(lock, aside);
    fs.rmSync(aside, { recursive: true, force: true });
    error(`lock ${lock}: owner ${describeOwner(deadOwner)} is gone; taking it over`);
    return 'reclaimed';
  } finally {
    fs.rmSync(reclaim, { recursive: true, force: true });
  }
}

/**
 * Take the lock directory, waiting while another ask holds it (#3633).
 *
 * The directory is the lock (mkdir is atomic); the owner file in it names the
 * pid, host and start time. A lock whose owner is gone — the review was
 * killed, so its finally never ran — is removed by reclaimStaleLock and taken.
 * A lock without an owner file (being created right now, or left by a script
 * from before the owner file) cannot be judged and is waited for like a live one.
 *
 * @param {string} lock
 * @param {{ sleep: (ms: number) => void, now: () => Date, error: (line: string) => void, between?: () => void }} deps
 *   `between` is passed to reclaimStaleLock (tests only)
 * @returns the owner written into the lock
 */
export function acquireLock(lock, { sleep, now, error, between }) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = now().getTime();
  let lastNotice = null;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      const owner = { pid: process.pid, host: os.hostname(), startedAt: now().toISOString() };
      fs.writeFileSync(path.join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
      return owner;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    const owner = readLockOwner(lock);
    // Another waiter reclaiming the same lock ('busy') finishes in a few calls: ask again after a poll.
    if (lockOwnerGone(owner) && reclaimStaleLock(lock, owner, { now, error, between }) !== 'busy') continue;
    const waited = now().getTime() - started;
    if (waited > LOCK_MAX_WAIT_SEC * 1000) {
      throw new Error(
        `lock ${lock} still held by ${describeOwner(owner)} after ${LOCK_MAX_WAIT_SEC}s (remove it if no Codex ask is running)`
      );
    }
    if (lastNotice === null || now().getTime() - lastNotice >= LOCK_NOTICE_SEC * 1000) {
      lastNotice = now().getTime();
      error(`lock ${lock} held by ${describeOwner(owner)}; waiting (${Math.round(waited / 1000)}s of ${LOCK_MAX_WAIT_SEC}s)`);
    }
    sleep(LOCK_POLL_SEC * 1000);
  }
}

/** Release the lock, unless it no longer names this owner (it was taken over). */
function releaseLock(lock, owner) {
  if (!sameOwner(readLockOwner(lock), owner)) {
    throw new Error(`${lock} is no longer held by this review (pid ${owner.pid}); left as it is`);
  }
  fs.rmSync(lock, { recursive: true, force: true });
}

/** Wait until the reviewer reads `ready` READY_STREAK times in a row; false if it never does. */
function waitReady({ run, sleep, cli, wt, cwd, instance }) {
  let streak = 0;
  for (let i = 0; i < READY_MAX_POLLS; i++) {
    const out = run(cli, ['capture', wt, '--instance', instance, '--json'], { cwd });
    let status = null;
    try {
      status = out.status === 0 ? JSON.parse(out.stdout).sessionStatus : null;
    } catch {
      status = null;
    }
    streak = status === 'ready' ? streak + 1 : 0;
    if (streak >= READY_STREAK) return true;
    sleep(READY_POLL_SEC * 1000);
  }
  return false;
}

/**
 * `--instance` may be an id or an alias; the lock, ask and record need the real
 * instance id. The server is the one authority for that (resolve-target:
 * primary first, case-folded alias, an ambiguous alias refused), asked through
 * the same `--cli` as capture and ask so it reaches the same server with the
 * same token (#3633: the CLI reads `.env`, `CM_BIND` and HTTPS, which a URL
 * built from `process.env` did not).
 */
function resolveInstance(run, o, cwd) {
  const resolved = resolveInstanceThroughCli(run, o.cli, o.wt, o.instance, { cwd, timeoutMs: RESOLVE_TIMEOUT_MS });
  if ('error' in resolved) return { error: `--instance ${o.instance}: could not resolve in ${o.wt} (${resolved.error})` };
  return { id: resolved.instanceId };
}

const USAGE = `Usage:
  node scripts/orchestrate/consistency-review.mjs --run-dir <dir> --issues <range> --issue <N> --head <sha> --brief <file>
       [--rereview --previous <review md>] [--worktree <path>] [--wt <reviewer worktree-id>] [--lock <dir>] [--cli <commandmatedev>] [--instance <id|alias>] [--item <work item>]
       [--routes <plan-check.mjs routes output>]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--head': 'head',
  '--brief': 'brief',
  '--previous': 'previous',
  '--worktree': 'worktree',
  '--wt': 'wt',
  '--lock': 'lock',
  '--cli': 'cli',
  '--instance': 'instance',
  '--item': 'item',
  '--routes': 'routes',
};
const SWITCHES = { '--rereview': 'rereview' };

export function parseArgs(argv) {
  const options = { rereview: false, wt: DEFAULT_REVIEWER_WT, cli: 'commandmatedev', instance: REVIEWER_INSTANCE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--instance') options.instanceGiven = true;
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of ['--run-dir', '--issues', '--issue', '--head', '--brief']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  try {
    runLogPath(options.runDir, options.issues);
  } catch (err) {
    return { error: err.message };
  }
  if (!isInstanceSelector(options.instance)) return { error: `--instance must be an instance id or alias (got ${options.instance})` };
  if (!/^[1-9]\d*$/.test(options.issue)) return { error: `--issue must be a positive integer (got ${options.issue})` };
  if (itemProblem(options.item)) return { error: itemProblem(options.item) };
  if (!/^[0-9a-f]{7,40}$/.test(options.head)) return { error: `--head must be a commit sha (got ${options.head})` };
  if (options.rereview && !options.previous) return { error: '--rereview needs --previous <review md>' };
  if (!options.rereview && options.previous) return { error: '--previous is only for --rereview' };
  if (!fs.existsSync(options.brief)) return { error: `--brief: no such file ${options.brief}` };
  if (options.previous && !fs.existsSync(options.previous)) return { error: `--previous: no such file ${options.previous}` };
  if (options.routes && !fs.existsSync(options.routes)) return { error: `--routes: no such file ${options.routes}` };
  return { options };
}

/**
 * @param {string[]} argv
 * @param {{
 *   run?: typeof defaultRun,
 *   sleep?: (ms: number) => void,
 *   now?: () => Date,
 *   cwd?: string,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { run = defaultRun, sleep = defaultSleep, now = () => new Date(), cwd = process.cwd() } = deps;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  if (o.instanceGiven) {
    const resolved = resolveInstance(run, o, cwd);
    if (resolved.error) {
      error(`${resolved.error}\n${USAGE}`);
      return 2;
    }
    o.instance = resolved.id;
  }
  const issue = Number(o.issue);
  // The default worktree is the work item's (`../commandmate-issue-3883-d1` with `--item d1`, #3883), not
  // the Issue's: another PR's worktree would be reviewed when its HEAD happened to match.
  const worktree = path.resolve(cwd, o.worktree ?? path.join('..', `commandmate-issue-${workItemName(issue, o.item)}`));
  const lock = path.resolve(cwd, o.lock ?? path.join('workspace', 'proposals', localDate(now()), o.instance === REVIEWER_INSTANCE ? '.lock' : `.lock-${o.instance}`));
  const started = now();
  let head = o.head;
  let label = null;

  const record = (result, note) => {
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
    const { file } = appendRecord(
      o.runDir,
      o.issues,
      { issue, stage: 'review', result, head, agent: o.instance, durationSec, note, item: o.item },
      now()
    );
    log(`review #${issue} ${head.slice(0, 7)} ${result}: ${note}`);
    log(`recorded -> ${file}`);
    return durationSec;
  };

  let lockOwner = null;
  try {
    // The review is of the HEAD that was asked for, recorded in full so the run record matches other stages.
    const rev = run('git', ['-C', worktree, 'rev-parse', 'HEAD'], { cwd });
    const full = rev.stdout.trim();
    if (rev.status !== 0 || !full) throw new Error(`git rev-parse HEAD failed in ${worktree}: ${rev.stderr.trim()}`);
    if (!full.startsWith(o.head)) throw new Error(`${worktree} is at ${full.slice(0, 7)}, not --head ${o.head}`);
    head = full;
    const branchOut = run('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = branchOut.status === 0 ? branchOut.stdout.trim() : '-';

    fs.mkdirSync(o.runDir, { recursive: true });
    const prompt = buildPrompt({
      issue,
      head: full,
      worktree,
      branch,
      brief: fs.readFileSync(o.brief, 'utf8'),
      previous: o.rereview ? fs.readFileSync(o.previous, 'utf8') : undefined,
      routes: o.routes ? fs.readFileSync(o.routes, 'utf8') : undefined,
    });
    label = claimReviewLabel(o.runDir, issue, o.item, prompt);
    const file = (ext) => path.join(o.runDir, `${label}${ext}`);

    lockOwner = acquireLock(lock, { sleep, now, error });
    if (!waitReady({ run, sleep, cli: o.cli, wt: o.wt, cwd, instance: o.instance })) {
      record('fail', `${label}: ${o.instance} not ready ${READY_STREAK} times in a row within ${READY_MAX_POLLS} polls; not sent`);
      return 1;
    }
    // The dependency trees the review must not write into (#3883 P6): this worktree's and its siblings'.
    const listed = run('git', ['-C', worktree, 'worktree', 'list', '--porcelain'], { cwd });
    const watched = [worktree, ...(listed.status === 0 ? parseWorktreeList(listed.stdout) : [])];
    const linksBefore = snapshotForeignLinks(watched);
    const asked = now();
    const ask = run(
      o.cli,
      ['ask', o.wt, prompt, '--instance', o.instance, '--timeout', String(ASK_TIMEOUT_SEC), '--json'],
      { cwd }
    );
    fs.writeFileSync(file('.json'), ask.stdout);
    fs.writeFileSync(file('.err'), ask.stderr);
    const askSec = Math.round((now().getTime() - asked.getTime()) / 1000);
    log(`${label}: ask exit=${ask.status} (${askSec}s)`);
    const appeared = addedLinks(linksBefore, snapshotForeignLinks(watched));
    if (appeared.length > 0) {
      const listing = appeared.map(({ link, target }) => `${link} -> ${target}`);
      for (const line of listing) error(`dependency link outside its worktree appeared during the review: ${line}`);
      record(
        'fail',
        `${label}: not a verdict — ${appeared.length} dependency link(s) outside their worktree appeared during the review: ${listing.slice(0, 3).join('; ')}${appeared.length > 3 ? '; …' : ''}`
      );
      return 1;
    }
    if (ask.status !== 0) {
      record('fail', `${label}: ask exit=${ask.status} (see ${label}.err)`);
      return 1;
    }
    let reply;
    try {
      reply = JSON.parse(ask.stdout).reply;
    } catch {
      reply = undefined;
    }
    if (typeof reply !== 'string') {
      record('fail', `${label}: ask --json gave no reply string`);
      return 1;
    }
    const body = extractReplyBody(reply);
    fs.writeFileSync(file('.md'), `${body}\n`);
    const doneLine = findDoneLine(body);
    if (!doneLine) {
      record('fail', `${label}: no DONE: line in the answer`);
      return 1;
    }
    const durationSec = record('ok', `${label}: ${doneLine}`);
    const row = appendReviewRow(path.join(o.runDir, 'consistency-review.md'), {
      issue,
      item: o.item,
      rereview: o.rereview,
      head: full,
      durationSec,
      doneLine,
    });
    log(`consistency-review.md += ${row}`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    try {
      record('fail', `${label ?? `review-${workItemName(issue, o.item)}`}: ${message}`);
    } catch (recordErr) {
      error(recordErr instanceof Error ? recordErr.message : String(recordErr));
    }
    return 1;
  } finally {
    if (lockOwner) {
      try {
        releaseLock(lock, lockOwner);
      } catch (err) {
        error(`could not release ${lock}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
