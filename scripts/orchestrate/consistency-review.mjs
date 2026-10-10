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
 * `> **Thinking (<n>)**`; only that line ends the answer (extractReplyBody).
 *
 * One call does what the hand-written script and docs/orchestrate/trials.md
 * did by hand:
 *   1. takes the Codex lock (`workspace/proposals/<date>/.lock`, mkdir), which
 *      every Codex ask of the day shares — the session is used one ask at a time;
 *   2. waits until `capture --instance codex --json` reads `ready` three times
 *      in a row;
 *   3. sends the brief built from templates/consistency-review.md (or
 *      consistency-review-rereview.md with the previous answer) with
 *      `ask <wt> <brief> --instance codex --timeout 2400 --json`;
 *   4. writes `review-<N>[b|c…].{prompt.txt,json,err,md}` to the run directory,
 *      the `.md` being the answer without the thinking;
 *   5. on an answer with a `DONE:` line appends one row to
 *      `consistency-review.md` and records `review=ok`; anything else records
 *      `review=fail` (run-log.mjs).
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
 *        [--worktree <path>] [--wt <reviewer worktree-id>] [--lock <dir>] [--cli <commandmatedev>]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, runLogPath } from './run-log.mjs';

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
/** A lock older than every ask plus its wait is treated as left behind, not waited on forever. */
export const LOCK_MAX_WAIT_SEC = 3 * 3600;

/** The header of `consistency-review.md` (docs/orchestrate/trials.md#5-2b-整合性レビューの進め方と記録). */
export const TABLE_HEADER = [
  '| # | Issue | 担当 | 依頼した HEAD | 時間（待ちを含む） | 指摘 | 独自の発見（重複・既報を除く） | 種類（動作／説明／テスト） | 新規／既存 | 再判定 | 処置 | 事前レビューの有無 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
];

/**
 * The line that opens the thinking section of an `ask --json` reply. Only a
 * line that starts with it ends the answer: the answer may quote
 * `> **Thinking**` (the hand-written split on `> **Thinking` lost findings and
 * the `DONE:` line that way).
 */
export const THINKING_START = /\n> \*\*Thinking \(/;

/** The answer of a reply: everything before the first thinking section. */
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

/**
 * The brief sent to Codex. `previous` (the earlier answer) makes it a
 * re-review: the previous findings are judged first, then the review as usual.
 *
 * @param {{ issue: number, head: string, worktree: string, branch: string, brief: string, previous?: string }} input
 * @param {{ initial?: string, rereview?: string }} [templates]
 */
export function buildPrompt({ issue, head, worktree, branch, brief, previous }, templates = {}) {
  const initial = templates.initial ?? fs.readFileSync(INITIAL_TEMPLATE, 'utf8');
  const body = renderTemplate(initial, {
    ISSUE: issue,
    HEAD: head,
    WORKTREE: worktree,
    BRANCH: branch,
    BRIEF: String(brief).trimEnd(),
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

/** `review-<N>`, then `review-<N>b`, `review-<N>c` … — the first name no earlier review of the run used. */
export function nextReviewLabel(runDir, issue) {
  for (const suffix of ['', ...'bcdefghijklmnopqrstuvwxyz']) {
    const label = `review-${issue}${suffix}`;
    if (!['.md', '.json', '.prompt.txt'].some((ext) => fs.existsSync(path.join(runDir, `${label}${ext}`)))) return label;
  }
  throw new Error(`too many reviews of #${issue} in ${runDir}`);
}

/** Append one row to `consistency-review.md` (created with its header if absent); returns the row. */
export function appendReviewRow(file, { issue, rereview, head, durationSec, doneLine }) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const numbers = [...existing.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  const count = findingCount(doneLine);
  const cells = [
    String(next),
    `#${issue}${rereview ? ' 再レビュー' : ''}`,
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

function defaultRun(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
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

/** Take the lock directory, waiting while another ask holds it. */
function acquireLock(lock, { sleep, now }) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = now().getTime();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    if (now().getTime() - started > LOCK_MAX_WAIT_SEC * 1000) {
      throw new Error(`lock ${lock} still held after ${LOCK_MAX_WAIT_SEC}s (remove it if no Codex ask is running)`);
    }
    sleep(LOCK_POLL_SEC * 1000);
  }
}

/** Wait until the reviewer reads `ready` READY_STREAK times in a row; false if it never does. */
function waitReady({ run, sleep, cli, wt, cwd }) {
  let streak = 0;
  for (let i = 0; i < READY_MAX_POLLS; i++) {
    const out = run(cli, ['capture', wt, '--instance', REVIEWER_INSTANCE, '--json'], { cwd });
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

const USAGE = `Usage:
  node scripts/orchestrate/consistency-review.mjs --run-dir <dir> --issues <range> --issue <N> --head <sha> --brief <file>
       [--rereview --previous <review md>] [--worktree <path>] [--wt <reviewer worktree-id>] [--lock <dir>] [--cli <commandmatedev>]`;

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
};
const SWITCHES = { '--rereview': 'rereview' };

export function parseArgs(argv) {
  const options = { rereview: false, wt: DEFAULT_REVIEWER_WT, cli: 'commandmatedev' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
  if (!/^[1-9]\d*$/.test(options.issue)) return { error: `--issue must be a positive integer (got ${options.issue})` };
  if (!/^[0-9a-f]{7,40}$/.test(options.head)) return { error: `--head must be a commit sha (got ${options.head})` };
  if (options.rereview && !options.previous) return { error: '--rereview needs --previous <review md>' };
  if (!options.rereview && options.previous) return { error: '--previous is only for --rereview' };
  if (!fs.existsSync(options.brief)) return { error: `--brief: no such file ${options.brief}` };
  if (options.previous && !fs.existsSync(options.previous)) return { error: `--previous: no such file ${options.previous}` };
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
  const issue = Number(o.issue);
  const worktree = path.resolve(cwd, o.worktree ?? path.join('..', `commandmate-issue-${issue}`));
  const lock = path.resolve(cwd, o.lock ?? path.join('workspace', 'proposals', localDate(now()), '.lock'));
  const started = now();
  let head = o.head;
  let label = null;

  const record = (result, note) => {
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
    const { file } = appendRecord(
      o.runDir,
      o.issues,
      { issue, stage: 'review', result, head, agent: REVIEWER_INSTANCE, durationSec, note },
      now()
    );
    log(`review #${issue} ${head.slice(0, 7)} ${result}: ${note}`);
    log(`recorded -> ${file}`);
    return durationSec;
  };

  let locked = false;
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
    label = nextReviewLabel(o.runDir, issue);
    const prompt = buildPrompt({
      issue,
      head: full,
      worktree,
      branch,
      brief: fs.readFileSync(o.brief, 'utf8'),
      previous: o.rereview ? fs.readFileSync(o.previous, 'utf8') : undefined,
    });
    const file = (ext) => path.join(o.runDir, `${label}${ext}`);
    fs.writeFileSync(file('.prompt.txt'), prompt);

    acquireLock(lock, { sleep, now });
    locked = true;
    if (!waitReady({ run, sleep, cli: o.cli, wt: o.wt, cwd })) {
      record('fail', `${label}: ${REVIEWER_INSTANCE} not ready ${READY_STREAK} times in a row within ${READY_MAX_POLLS} polls; not sent`);
      return 1;
    }
    const asked = now();
    const ask = run(
      o.cli,
      ['ask', o.wt, prompt, '--instance', REVIEWER_INSTANCE, '--timeout', String(ASK_TIMEOUT_SEC), '--json'],
      { cwd }
    );
    fs.writeFileSync(file('.json'), ask.stdout);
    fs.writeFileSync(file('.err'), ask.stderr);
    const askSec = Math.round((now().getTime() - asked.getTime()) / 1000);
    log(`${label}: ask exit=${ask.status} (${askSec}s)`);
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
      record('fail', `${label ?? `review-${issue}`}: ${message}`);
    } catch (recordErr) {
      error(recordErr instanceof Error ? recordErr.message : String(recordErr));
    }
    return 1;
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lock);
      } catch (err) {
        error(`could not release ${lock}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
