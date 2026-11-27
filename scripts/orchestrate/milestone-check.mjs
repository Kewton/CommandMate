#!/usr/bin/env node
/**
 * `node scripts/orchestrate/milestone-check.mjs check [--json] [--deadline-sec <n>]
 *        [--plan <state file>] [--no-history]`
 * `node scripts/orchestrate/milestone-check.mjs summary [--json|--md] [--deadline-sec <n>]
 *        [--plan <state file>] [--no-history]`
 * — the read-only consistency check between GitHub Milestones and the work on disk
 * (Issue #4642 PR-1, docs/design/milestone-check-4642.md §2・§3・§4・§5・§6).
 *
 * It answers one question only: where the current Milestone and the work that is actually
 * happening disagree (M1 stray work, M1b residue, M2 residue/unstarted, M3 closing forgotten,
 * M4 previous-sprint leftovers, M5 stale milestones, M6 moves with no roadmap record). It is
 * advice: it writes nothing, takes no lock, changes nothing on GitHub, and never reads a
 * running server (P1・I7).
 *
 * The current Milestone is the configured name (`milestone.current`) and is never inferred
 * (I4). A read that fails, times out, is truncated at its limit, or cannot be parsed makes the
 * whole judgement incomplete (`complete: false`) and the exit 61 — a partial answer is never
 * reported as "no drift" (I2). Worktrees and open PRs whose number cannot be read are listed in
 * `keyless` rather than dropped (I3).
 *
 * Every call the tool makes is in the table of isAllowedMilestoneCall; anything else is refused
 * without a child (I1). Identification git (repo / base) is read through config.mjs's
 * makeRunBounded, exactly as flow-wip.mjs does. The tool's own calls go through the runner
 * below, which is flow-wip's makeRunner shape against one absolute monotonic deadline (I6).
 * A result that comes back at or after the deadline is not used.
 *
 * Exit: 0 no drift / 62 drift / 61 cannot be judged / 2 usage or settings / 1 unexpected.
 * `summary` exits 0 even with drift (61 if a read is incomplete, 2 on settings).
 */
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { defaultMonoNow, makeRunBounded } from '../flow/runner.mjs';
import { readFlowConfig, readRawFlowConfig } from '../flow/config.mjs';
import { isGhRead } from './pr-common.mjs';
import { parseWorktreePorcelain } from './flow-wip.mjs';

export const EXIT_DRIFT = 62;
export const EXIT_UNKNOWN = 61;
export const EXIT_USAGE = 2;
export const DEFAULT_DEADLINE_SEC = 120;
export const MAX_DEADLINE_SEC = 3600;
export const DEFAULT_MERGED_WINDOW_DAYS = 14;
export const GIT_CAP_MS = 10_000;
export const GH_CAP_MS = 30_000;
export const MILESTONE_LIMIT = 100;
export const ISSUE_LIMIT = 1000;
export const OPEN_PR_LIMIT = 1000;
export const MERGED_PR_LIMIT = 300;
export const MAX_BUFFER = 32 * 1024 * 1024;
/** The label that says a merged Issue waits for acceptance (Q2). The tool only reads it. */
export const AWAITING_LABEL = 'merged-awaiting-accept';
/** The kind order of docs/design §3.2; rows are sorted by it after the Issue number. */
export const KIND_ORDER = [
  'M1',
  'M1b',
  'M2-residue',
  'M2-planned',
  'M2-no-evidence',
  'M3-closing-forgotten',
  'M3-awaiting-accept',
  'M4-previous-sprint',
  'M5-closed-leftover',
  'M5-empty-previous',
  'M6-unrecorded-move',
];

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SPRINT = /^Sprint (\d+)$/;
const WORKTREE_KEY = /^commandmate-issue-(\d+)/;
const BRANCH_KEY = /^[a-z]+\/(\d+)([a-z]?)((?:-\d+[a-z]?)*)-/;
const CLOSING = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi;
const REFS = /\brefs?\s+#(\d+)\b/gi;
const TITLE_KEY = /\(#(\d+)\)/g;

const USAGE = `usage: milestone-check.mjs check [--json] [--deadline-sec <n>] [--plan <state file>] [--no-history]
       milestone-check.mjs summary [--json|--md] [--deadline-sec <n>] [--plan <state file>] [--no-history]`;

/** @typedef {{ status: 'ok' | 'fail' | 'timeout' | 'refused', code: number | null, stdout: string, stderr: string, called: boolean, timedOut: boolean, skipped: boolean }} RunResult */
/** @typedef {{ title: string, state: 'open' | 'closed', openIssues: number, closedIssues: number }} MilestoneRow */
/** @typedef {{ number: number, state: 'OPEN' | 'CLOSED', title: string, labels: string[], milestone: string | null }} IssueRow */
/** @typedef {{ number: number, headRefName: string, title: string, body: string, mergedAt?: string }} PrRow */
/** @typedef {{ kind: string, severity: 'drift' | 'info', issue: number | null, detail: string }} Row */

const okArgs = (args, expected) => args.length === expected.length && expected.every((v, i) => args[i] === v);
const isRef = (value) => typeof value === 'string' && BRANCH.test(value) && !value.includes('..');
const isMilestoneTitle = (value) => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);

/**
 * The calls milestone-check may make (design §4, I1): three git reads and the reading gh reads.
 * @param {string} cmd
 * @param {string[]} args
 */
export function isAllowedMilestoneCall(cmd, args) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return false;
  if (cmd === 'git') {
    if (okArgs(args, ['worktree', 'list', '--porcelain'])) return true;
    if (okArgs(args, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return true;
    if (args.length === 3 && args[0] === 'rev-list' && args[1] === '--count') {
      const m = /^refs\/remotes\/origin\/([A-Za-z0-9._/-]+)\.\.refs\/heads\/([A-Za-z0-9._/-]+)$/.exec(args[2]);
      return m !== null && isRef(m[1]) && isRef(m[2]);
    }
    return false;
  }
  if (cmd === 'gh') {
    if (!isGhRead(args)) return false;
    if (args[0] === 'api') {
      if (args.length === 2) {
        const m = /^repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/milestones\?state=all&per_page=(\d+)$/.exec(args[1]);
        return m !== null && REPO_NAME.test(m[1]) && m[2] === String(MILESTONE_LIMIT);
      }
      if (args.length === 3 && args[1] === '--paginate') {
        const m = /^repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/timeline\?per_page=100$/.exec(args[2]);
        return m !== null && REPO_NAME.test(m[1]);
      }
      return false;
    }
    if (args.length === 12 && args[0] === 'issue' && args[1] === 'list') {
      const [, , repoFlag, repo, msFlag, title, stateFlag, state, jsonFlag, fields, limitFlag, limit] = args;
      return repoFlag === '--repo' && REPO_NAME.test(repo) && msFlag === '--milestone' && isMilestoneTitle(title)
        && stateFlag === '--state' && state === 'all' && jsonFlag === '--json'
        && fields === 'number,state,title,labels,closedAt' && limitFlag === '--limit' && limit === String(ISSUE_LIMIT);
    }
    if (args.length === 7 && args[0] === 'issue' && args[1] === 'view') {
      // Two exact field sets are read: a roadmap's comments, and one hidden key's state /
      // Milestone / labels (#4642 r1). Anything else (e.g. `--json body`) is refused.
      const [, , issue, repoFlag, repo, jsonFlag, fields] = args;
      const ok = /^\d+$/.test(issue) && repoFlag === '--repo' && REPO_NAME.test(repo) && jsonFlag === '--json';
      return ok && (fields === 'comments' || fields === 'number,state,milestone,labels');
    }
    if (args.length === 12 && args[0] === 'pr' && args[1] === 'list') {
      const [, , repoFlag, repo, stateFlag, state, baseFlag, base, limitFlag, limit, jsonFlag, fields] = args;
      return stateFlag === '--state' && state === 'open' && repoFlag === '--repo' && REPO_NAME.test(repo)
        && baseFlag === '--base' && isRef(base) && limitFlag === '--limit' && limit === String(OPEN_PR_LIMIT)
        && jsonFlag === '--json' && fields === 'number,headRefName,title,body';
    }
    if (args.length === 14 && args[0] === 'pr' && args[1] === 'list') {
      const [, , repoFlag, repo, stateFlag, state, baseFlag, base, searchFlag, search, jsonFlag, fields, limitFlag, limit] = args;
      return stateFlag === '--state' && state === 'merged' && repoFlag === '--repo' && REPO_NAME.test(repo)
        && baseFlag === '--base' && isRef(base) && searchFlag === '--search'
        && /^merged:>=\d{4}-\d{2}-\d{2}$/.test(search) && jsonFlag === '--json'
        && fields === 'number,headRefName,title,body,mergedAt' && limitFlag === '--limit' && limit === String(MERGED_PR_LIMIT);
    }
    return false;
  }
  return false;
}

/**
 * `(cmd, args, { capMs, deadlineMono, cwd }) → RunResult` over a spawnSync-shaped call, the
 * shape of flow-wip.mjs `makeRunner` (a result that comes back after the deadline is dropped).
 * @param {{ spawnSync?: Function, monoNow?: () => number }} [deps]
 */
export function makeMilestoneRunner(deps = {}) {
  const spawn = deps.spawnSync ?? nodeSpawnSync;
  const monoNow = deps.monoNow ?? defaultMonoNow;
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ capMs: number, deadlineMono: number, cwd?: string }} options
   * @returns {RunResult}
   */
  return function run(cmd, args, { capMs, deadlineMono, cwd }) {
    const base = { code: null, stdout: '', stderr: '', timedOut: false, skipped: false };
    if (!isAllowedMilestoneCall(cmd, args)) return { ...base, status: 'refused', called: false };
    const budget = Math.floor(Math.min(capMs, deadlineMono - monoNow()));
    if (!Number.isFinite(budget) || budget < 1) return { ...base, status: 'timeout', called: false, timedOut: true, skipped: true };
    let result;
    try {
      result = spawn(cmd, args, {
        cwd,
        timeout: budget,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (monoNow() >= deadlineMono) return { ...base, status: 'timeout', called: true, timedOut: true };
      return { ...base, status: 'fail', called: true, stderr: err instanceof Error ? err.message : String(err) };
    }
    const errCode = result?.error && /** @type {{ code?: string }} */ (result.error).code;
    if (monoNow() >= deadlineMono || errCode === 'ETIMEDOUT') return { ...base, status: 'timeout', called: true, timedOut: true };
    const stdout = typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout ?? '');
    const stderr = typeof result?.stderr === 'string' ? result.stderr : String(result?.stderr ?? '');
    const code = typeof result?.status === 'number' ? result.status : null;
    if (result?.error) return { ...base, status: 'fail', called: true, code, stdout, stderr: `${stderr}\n${String(errCode ?? result.error)}` };
    return { ...base, status: code === 0 ? 'ok' : 'fail', called: true, code, stdout, stderr };
  };
}

const reasonOf = (result) => (result.status === 'timeout' ? 'timeout' : result.status === 'refused' ? 'refused' : 'fail');
const uniqSorted = (values) => [...new Set(values)].sort((a, b) => a - b);

/**
 * The Issue number a worktree directory names, or null (design §2.1).
 * @param {string} dirPath
 * @returns {number | null}
 */
export function keyFromWorktreePath(dirPath) {
  const m = WORKTREE_KEY.exec(path.basename(String(dirPath)));
  return m === null ? null : Number(m[1]);
}

/**
 * Every Issue number a branch names: `<type>/<N>[a]<(-<M>[a])*>-…` (design §2.1).
 * `fix/4621-4636-lock-test-flakes` → [4621, 4636]; `docs/4432a-verify` → [4432].
 * @param {string} branch
 * @returns {number[]}
 */
export function keysFromBranch(branch) {
  const m = BRANCH_KEY.exec(String(branch));
  if (m === null) return [];
  const numbers = [Number(m[1])];
  for (const extra of m[3].matchAll(/-(\d+)[a-z]?/g)) numbers.push(Number(extra[1]));
  return uniqSorted(numbers);
}

/** The numbers a PR body closes (`Closes` / `Fixes` / `Resolves`), sorted. @param {{ body?: string }} pr */
export function closingIssuesOf(pr) {
  const numbers = [];
  for (const m of String(pr?.body ?? '').matchAll(CLOSING)) numbers.push(Number(m[1]));
  return uniqSorted(numbers);
}

/**
 * The keys a PR names: its body's closing and `Refs #N`, then its title's `(#N)`; when it names
 * none, the branch's keys (design §2.1).
 * @param {{ body?: string, title?: string, headRefName?: string }} pr
 * @returns {number[]}
 */
export function prKeys(pr) {
  const numbers = [];
  for (const m of String(pr?.body ?? '').matchAll(CLOSING)) numbers.push(Number(m[1]));
  for (const m of String(pr?.body ?? '').matchAll(REFS)) numbers.push(Number(m[1]));
  for (const m of String(pr?.title ?? '').matchAll(TITLE_KEY)) numbers.push(Number(m[1]));
  if (numbers.length > 0) return uniqSorted(numbers);
  return keysFromBranch(String(pr?.headRefName ?? ''));
}

/** The leading number of a plan item id, or null. @param {string} id */
export function keysFromPlanItem(id) {
  const m = /^(\d+)/.exec(String(id));
  return m === null ? null : Number(m[1]);
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `gh api …/milestones` rows, or null when the JSON or a row's shape is wrong. @param {string} text */
export function parseMilestones(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const rows = [];
  for (const item of data) {
    if (!isMapping(item)) return null;
    const { title, state, open_issues: openIssues, closed_issues: closedIssues } = item;
    if (!isMilestoneTitle(title) || (state !== 'open' && state !== 'closed')) return null;
    if (!Number.isInteger(openIssues) || !Number.isInteger(closedIssues)) return null;
    rows.push({ title, state, openIssues, closedIssues });
  }
  return rows;
}

/** `gh issue list --json number,state,title,labels,closedAt` rows, or null. @param {string} text */
export function parseIssueRows(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const rows = [];
  for (const item of data) {
    if (!isMapping(item)) return null;
    const { number, state, title, labels } = item;
    if (!Number.isInteger(number) || (state !== 'OPEN' && state !== 'CLOSED') || typeof title !== 'string' || !Array.isArray(labels)) return null;
    const names = [];
    for (const label of labels) {
      if (typeof label === 'string') names.push(label);
      else if (isMapping(label) && typeof label.name === 'string') names.push(label.name);
      else return null;
    }
    rows.push({ number, state, title, labels: names, milestone: null });
  }
  return rows;
}

/**
 * `gh pr list --json number,headRefName,title,body[,mergedAt]` rows, or null.
 * @param {string} text
 * @param {{ merged: boolean }} kind
 */
export function parsePrRows(text, { merged }) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const rows = [];
  for (const item of data) {
    if (!isMapping(item)) return null;
    const { number, headRefName, title, body } = item;
    if (!Number.isInteger(number) || typeof headRefName !== 'string' || headRefName === '') return null;
    if (typeof title !== 'string' || typeof body !== 'string') return null;
    if (merged) {
      if (typeof item.mergedAt !== 'string') return null;
      rows.push({ number, headRefName, title, body, mergedAt: item.mergedAt });
    } else {
      rows.push({ number, headRefName, title, body });
    }
  }
  return rows;
}

/**
 * `gh issue view --json number,state,milestone,labels` for one Issue, or null when the JSON or
 * its shape is wrong (#4642 r1). `milestone` is GitHub's object (`{ title }`) or null.
 * @param {string} text
 * @returns {{ state: 'OPEN' | 'CLOSED', milestone: string | null, labels: string[] } | null}
 */
export function parseIssueView(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isMapping(data) || (data.state !== 'OPEN' && data.state !== 'CLOSED') || !Array.isArray(data.labels)) return null;
  const labels = [];
  for (const label of data.labels) {
    if (typeof label === 'string') labels.push(label);
    else if (isMapping(label) && typeof label.name === 'string') labels.push(label.name);
    else return null;
  }
  let milestone = null;
  if (data.milestone !== null && data.milestone !== undefined) {
    if (!isMapping(data.milestone) || !isMilestoneTitle(data.milestone.title)) return null;
    milestone = data.milestone.title;
  }
  return { state: data.state, milestone, labels };
}

/**
 * `gh api --paginate` prints one JSON array per page back to back (`[…][…]`), so a page count
 * over one is not one JSON document: the arrays are read in order and joined. Any part that is
 * not an array is `null` (the read cannot be judged). A single array (one page) reads the same.
 * @param {string} text
 * @returns {unknown[] | null}
 */
export function parseJsonSequence(text) {
  const source = String(text).trim();
  if (source === '') return null;
  const items = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index++;
    if (index >= source.length) break;
    if (source[index] !== '[') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = index; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return null;
    let part;
    try {
      part = JSON.parse(source.slice(index, end + 1));
    } catch {
      return null;
    }
    if (!Array.isArray(part)) return null;
    items.push(...part);
    index = end + 1;
  }
  return items;
}

/**
 * `gh api …/timeline` rows, or null when the JSON or a row's shape is wrong. Each row keeps the
 * milestone events only: other event kinds (`labeled`, `commented`, `cross-referenced`, …) need
 * not carry `createdAt` at all — GitHub omits it on several of them — so a row whose `event` is
 * not one of the two the check reads is skipped rather than failing the whole page (#4642, the
 * real run of 2026-11-27), and a readable move without a `createdAt` is kept with `null`.
 * `--paginate` returns one array per page, joined by parseJsonSequence.
 * @param {string} text
 */
export function parseTimeline(text) {
  const data = parseJsonSequence(text);
  if (data === null) return null;
  const rows = [];
  for (const item of data) {
    if (!isMapping(item)) return null;
    const { event, createdAt, milestone } = item;
    if (typeof event !== 'string') return null;
    if (event !== 'milestoned' && event !== 'demilestoned') continue;
    if (createdAt !== null && createdAt !== undefined && typeof createdAt !== 'string') return null;
    let title = null;
    if (milestone !== null && milestone !== undefined) {
      if (!isMapping(milestone) || typeof milestone.title !== 'string') return null;
      title = milestone.title;
    }
    rows.push({ event, createdAt: typeof createdAt === 'string' ? createdAt : null, milestone: title });
  }
  return rows;
}

/** The comments' `createdAt` in order, or null. @param {string} text */
export function parseComments(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isMapping(data) || !Array.isArray(data.comments)) return null;
  const stamps = [];
  for (const comment of data.comments) {
    if (!isMapping(comment) || typeof comment.createdAt !== 'string') return null;
    stamps.push(comment.createdAt);
  }
  return stamps;
}

const sprintNumber = (title) => {
  const m = SPRINT.exec(String(title));
  return m === null ? null : Number(m[1]);
};

const iso = (wallNow) => new Date(wallNow()).toISOString();
const label = (title) => (title === null || title === undefined ? '(none)' : title);
const dayBefore = (wallMs, days) => new Date(wallMs - days * 86_400_000).toISOString().slice(0, 10);

/**
 * @param {string[]} argv
 * @returns {{ options: { command: 'check' | 'summary', json: boolean, md: boolean, deadlineSec: number, plan: string | undefined, history: boolean } } | { error: string }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check' && command !== 'summary') return { error: `unknown command ${command ?? '(none)'}` };
  const options = { command, json: false, md: false, deadlineSec: DEFAULT_DEADLINE_SEC, plan: /** @type {string | undefined} */ (undefined), history: true };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--md') {
      if (command !== 'summary') return { error: '--md is only for summary' };
      options.md = true;
    } else if (arg === '--no-history') {
      options.history = false;
    } else if (arg === '--plan') {
      const value = rest[++i];
      if (value === undefined || value === '' || value.startsWith('--')) return { error: '--plan needs a path' };
      options.plan = value;
    } else if (arg === '--deadline-sec') {
      const value = rest[++i];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_DEADLINE_SEC) {
        return { error: `--deadline-sec must be an integer from 1 to ${MAX_DEADLINE_SEC}` };
      }
      options.deadlineSec = Number(value);
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  if (options.json && options.md) return { error: 'give --json or --md, not both' };
  return { options };
}

const row = (kind, severity, issue, detail) => ({ kind, severity, issue, detail });
const kindIndex = (kind) => {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
};
const compareRows = (a, b) => {
  const an = a.issue === null ? Number.MAX_SAFE_INTEGER : a.issue;
  const bn = b.issue === null ? Number.MAX_SAFE_INTEGER : b.issue;
  if (an !== bn) return an - bn;
  return kindIndex(a.kind) - kindIndex(b.kind);
};

/**
 * The rows of one observation (design §3). Pure: every read is already in `input`.
 * @param {{ currentTitle: string, prevTitles: Set<string>, issueMap: Map<number, IssueRow>,
 *   worktreeKinds: Map<number, Set<string>>, worktreePathOf: Map<number, string>,
 *   openPrOf: Map<number, number>, planKeys: Set<number> | null, mergedClosing: Map<number, number[]>,
 *   closedWithOpen: MilestoneRow[], emptyPrev: MilestoneRow[],
 *   moves: Array<{ issue: number, event: string, milestone: string | null, createdAt: string }> }} input
 * @returns {Row[]}
 */
export function judge(input) {
  const { currentTitle, prevTitles, issueMap, worktreeKinds, worktreePathOf, openPrOf, planKeys, mergedClosing, closedWithOpen, emptyPrev, moves } = input;
  // Two questions, two answers (design §2.2・§3.2). "Started" is work already on disk (a branch
  // with or without commits, or an open PR): it moves an Issue out of M2 and into summary 進行中.
  // A plan lane is where the Issue was assigned, not work that started, so it is M1 evidence
  // (the lane exists in the wrong Milestone) and, for M2, what separates 未着手 from 残留.
  const started = (n) => {
    const kinds = worktreeKinds.get(n);
    return (kinds !== undefined && (kinds.has('unmerged-worktree') || kinds.has('fresh-worktree'))) || openPrOf.has(n);
  };
  const assigned = (n) => planKeys !== null && planKeys.has(n);
  const candidates = new Set([...issueMap.keys(), ...worktreeKinds.keys(), ...openPrOf.keys(), ...mergedClosing.keys()]);
  if (planKeys !== null) for (const key of planKeys) candidates.add(key);
  /** @type {Row[]} */
  const rows = [];
  for (const n of [...candidates].sort((a, b) => a - b)) {
    const observed = issueMap.get(n);
    // A key in none of the read lists is not observable: no allowed read says whether it is
    // open, so it is read as OPEN with no milestone (design §2.4, a documented limitation).
    const state = observed ? observed.state : 'OPEN';
    const milestone = observed ? observed.milestone : null;
    if (state !== 'OPEN') continue;
    const kinds = worktreeKinds.get(n) ?? new Set();
    const work = started(n) || assigned(n);
    const mergedWorktree = kinds.has('merged-worktree') && worktreePathOf.has(n);
    if (milestone !== currentTitle) {
      if (work) {
        const where = [];
        if (worktreePathOf.has(n) && (kinds.has('unmerged-worktree') || kinds.has('fresh-worktree'))) where.push(`worktree ${worktreePathOf.get(n)}`);
        if (openPrOf.has(n)) where.push(`PR #${openPrOf.get(n)}`);
        if (assigned(n)) where.push('plan');
        rows.push(row('M1', 'drift', n, [`Milestone ${label(milestone)}`, ...where].join('; ')));
      } else if (mergedWorktree) {
        rows.push(row('M1b', 'info', n, `Milestone ${label(milestone)}; merged worktree ${worktreePathOf.get(n)}`));
      }
    }
    if (milestone === currentTitle && !started(n)) {
      if (planKeys === null) rows.push(row('M2-no-evidence', 'info', n, `Milestone ${label(milestone)}; no evidence`));
      else if (assigned(n)) rows.push(row('M2-planned', 'info', n, `Milestone ${label(milestone)}; in the plan, not started`));
      else rows.push(row('M2-residue', 'drift', n, `Milestone ${label(milestone)}; in the plan: no`));
    }
    const closing = mergedClosing.get(n);
    if (closing !== undefined) {
      const awaiting = observed !== undefined && observed.labels.includes(AWAITING_LABEL);
      rows.push(row(awaiting ? 'M3-awaiting-accept' : 'M3-closing-forgotten', awaiting ? 'info' : 'drift', n, `merged PR #${closing.join(', #')} closes #${n}`));
    }
    if (prevTitles.has(milestone)) rows.push(row('M4-previous-sprint', 'drift', n, `Milestone ${label(milestone)}`));
  }
  for (const milestone of closedWithOpen) rows.push(row('M5-closed-leftover', 'drift', null, `${milestone.title}: ${milestone.openIssues} open issue(s)`));
  for (const milestone of emptyPrev) rows.push(row('M5-empty-previous', 'info', null, `${milestone.title}: no open issue (release pending)`));
  for (const move of moves) rows.push(row('M6-unrecorded-move', 'drift', move.issue, `${move.event} ${label(move.milestone)} @ ${move.createdAt}`));
  return rows.sort(compareRows);
}

const emptyGroups = () => ({ done: [], inProgress: [], remaining: [], deferred: [], drift: [] });

/**
 * The CLI. `deps` replaces the process: `spawnSync`, `monoNow`, `wallNow`, `cwd`, `env`, `fs`,
 * `stdout`, `stderr`, and the caller's `deadlineMono` (kept when it is shorter).
 * @param {string[]} argv
 * @param {Record<string, any>} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    return runMain(argv, deps, stdout, stderr);
  } catch (err) {
    stderr(`milestone-check: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function runMain(argv, deps, stdout, stderr) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    stderr(`milestone-check: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { command, json, history, plan: planPath } = parsed.options;
  const wantMd = command === 'summary' && !json;
  const monoNow = deps.monoNow ?? defaultMonoNow;
  const wallNow = deps.wallNow ?? Date.now;
  const spawn = deps.spawnSync ?? nodeSpawnSync;
  const fsImpl = deps.fs ?? fs;
  const own = monoNow() + parsed.options.deadlineSec * 1000;
  const deadlineMono = typeof deps.deadlineMono === 'number' && Number.isFinite(deps.deadlineMono) ? Math.min(own, deps.deadlineMono) : own;
  const cwd = deps.cwd ?? process.cwd();
  const run = makeMilestoneRunner({ spawnSync: spawn, monoNow });
  const observedFrom = iso(wallNow);

  const emit = (object) => {
    if (json) stdout(JSON.stringify(object));
  };
  const unknownExit = (source, reason, milestoneTitle) => {
    const unknown = [`${source} (${reason})`];
    stderr(`milestone-check: cannot judge ${source}: ${reason}. Do not read this as "no drift"; check ${source} and run ${command} again.`);
    if (wantMd) stdout(`> 不完全: ${unknown.join('; ')}`);
    else emit({ ok: false, complete: false, milestone: milestoneTitle === undefined ? null : { current: milestoneTitle, previous: [] }, rows: [], unknown, keyless: [], observedFrom, observedTo: iso(wallNow), ...(command === 'summary' ? { summary: emptyGroups() } : {}) });
    return EXIT_UNKNOWN;
  };
  const configError = (message) => {
    stderr(`milestone-check: settings: ${message}`);
    return EXIT_USAGE;
  };

  // Root: the main worktree of this repository (P8, as flow-wip).
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { capMs: GIT_CAP_MS, deadlineMono, cwd });
  if (common.status === 'timeout') return unknownExit('git rev-parse', 'timeout');
  const commonDir = common.status === 'ok' ? common.stdout.trim() : '';
  if (commonDir === '' || path.basename(commonDir) !== '.git') return configError(`${cwd} is not inside a git repository with a main worktree`);
  const root = path.dirname(commonDir);

  const raw = readRawFlowConfig(root, { fs: fsImpl });
  if ('error' in raw) return configError(raw.error);
  const configured = raw.settings?.milestone;
  if (configured === undefined) return configError('milestone.current is not configured (.commandmate/flow.yaml `milestone:` section)');

  const runBounded = makeRunBounded({ run: spawn, monoNow });
  const scope = readFlowConfig(root, { runBounded, env: deps.env ?? process.env, deadlineMono, fs: fsImpl });
  if ('error' in scope) {
    if (/timed out/.test(scope.error)) return unknownExit('identification', 'timeout', configured.current);
    return configError(scope.error);
  }
  const { repo, base, exclude } = scope;
  if (!REPO_NAME.test(repo) || !isRef(base)) return configError('repo or base has an unexpected shape');
  const currentTitle = configured.current;
  const roadmapIssue = Number.isInteger(configured.roadmapIssue) ? configured.roadmapIssue : null;
  const windowDays = Number.isInteger(configured.mergedWindowDays) ? configured.mergedWindowDays : DEFAULT_MERGED_WINDOW_DAYS;

  /** @type {Set<number> | null} */
  let planKeys = null;
  if (planPath !== undefined) {
    let text;
    try {
      text = fsImpl.readFileSync(planPath, 'utf8');
    } catch {
      return configError(`--plan ${planPath} cannot be read`);
    }
    let doc;
    try {
      doc = YAML.parse(text);
    } catch {
      return configError(`--plan ${planPath} is not valid YAML`);
    }
    planKeys = new Set();
    if (isMapping(doc) && Array.isArray(doc.items)) {
      for (const item of doc.items) {
        if (isMapping(item) && typeof item.id === 'string') {
          const key = keysFromPlanItem(item.id);
          if (key !== null) planKeys.add(key);
        }
      }
    }
  }

  const gh = (args) => run('gh', args, { capMs: GH_CAP_MS, deadlineMono, cwd: root });
  const git = (args) => run('git', args, { capMs: GIT_CAP_MS, deadlineMono, cwd: root });
  /** @type {string[]} */
  const unknown = [];

  const listed = git(['worktree', 'list', '--porcelain']);
  if (listed.status !== 'ok') return unknownExit('git worktree list', reasonOf(listed), currentTitle);
  const worktrees = parseWorktreePorcelain(listed.stdout);
  if (worktrees === null) return unknownExit('git worktree list', 'shape', currentTitle);

  const msAnswer = gh(['api', `repos/${repo}/milestones?state=all&per_page=${MILESTONE_LIMIT}`]);
  if (msAnswer.status !== 'ok') return unknownExit('gh api milestones', reasonOf(msAnswer), currentTitle);
  const milestones = parseMilestones(msAnswer.stdout);
  if (milestones === null) return unknownExit('gh api milestones', 'shape', currentTitle);
  if (milestones.length >= MILESTONE_LIMIT) return unknownExit('gh api milestones', 'truncated', currentTitle);
  const current = milestones.find((m) => m.title === currentTitle);
  if (current === undefined) return configError(`milestone.current "${currentTitle}" is not a milestone of ${repo}`);
  if (current.state !== 'open') return configError(`milestone.current "${currentTitle}" is closed`);

  const currentNum = sprintNumber(current.title);
  const prevSprints = currentNum === null ? [] : milestones.filter((m) => m.state === 'open' && sprintNumber(m.title) !== null && sprintNumber(m.title) < currentNum);
  const laterSprints = currentNum === null ? [] : milestones.filter((m) => m.state === 'open' && sprintNumber(m.title) !== null && sprintNumber(m.title) > currentNum);
  const closedWithOpen = milestones.filter((m) => m.state === 'closed' && m.openIssues >= 1);

  /** @type {Map<number, IssueRow>} */
  const issueMap = new Map();
  for (const milestone of [current, ...prevSprints, ...laterSprints, ...closedWithOpen]) {
    const name = `gh issue list ${milestone.title}`;
    const answer = gh(['issue', 'list', '--repo', repo, '--milestone', milestone.title, '--state', 'all', '--json', 'number,state,title,labels,closedAt', '--limit', String(ISSUE_LIMIT)]);
    if (answer.status !== 'ok') {
      unknown.push(`${name} (${reasonOf(answer)})`);
      continue;
    }
    const rows = parseIssueRows(answer.stdout);
    if (rows === null) {
      unknown.push(`${name} (shape)`);
      continue;
    }
    if (rows.length >= ISSUE_LIMIT) unknown.push(`${name} (truncated)`);
    for (const issue of rows) issueMap.set(issue.number, { ...issue, milestone: milestone.title });
  }

  const openAnswer = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--base', base, '--limit', String(OPEN_PR_LIMIT), '--json', 'number,headRefName,title,body']);
  let openPrs = [];
  if (openAnswer.status !== 'ok') unknown.push(`gh pr list --state open (${reasonOf(openAnswer)})`);
  else {
    const rows = parsePrRows(openAnswer.stdout, { merged: false });
    if (rows === null) unknown.push('gh pr list --state open (shape)');
    else {
      if (rows.length >= OPEN_PR_LIMIT) unknown.push('gh pr list --state open (truncated)');
      openPrs = rows;
    }
  }

  const mergedAnswer = gh(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', base, '--search', `merged:>=${dayBefore(wallNow(), windowDays)}`, '--json', 'number,headRefName,title,body,mergedAt', '--limit', String(MERGED_PR_LIMIT)]);
  let mergedPrs = [];
  if (mergedAnswer.status !== 'ok') unknown.push(`gh pr list --state merged (${reasonOf(mergedAnswer)})`);
  else {
    const rows = parsePrRows(mergedAnswer.stdout, { merged: true });
    if (rows === null) unknown.push('gh pr list --state merged (shape)');
    else {
      if (rows.length >= MERGED_PR_LIMIT) unknown.push('gh pr list --state merged (truncated)');
      mergedPrs = rows;
    }
  }

  // Evidence per Issue number (design §2.2). A worktree's directory and branch both count.
  const excludeSet = new Set(exclude);
  /** @type {Map<number, Set<string>>} */
  const worktreeKinds = new Map();
  /** @type {Map<number, string>} */
  const worktreePathOf = new Map();
  /** @type {Array<{ path: string | null, branch: string | null, pr: number | null }>} */
  const keyless = [];
  const addKind = (key, kind) => {
    const kinds = worktreeKinds.get(key) ?? new Set();
    kinds.add(kind);
    worktreeKinds.set(key, kinds);
  };
  const mergedHeadSet = new Set(mergedPrs.map((pr) => pr.headRefName));
  for (const wt of worktrees) {
    if (wt.path === root) continue;
    if (wt.branch === null) {
      const key = keyFromWorktreePath(wt.path);
      if (key === null) keyless.push({ path: wt.path, branch: null, pr: null });
      else {
        addKind(key, 'fresh-worktree');
        worktreePathOf.set(key, wt.path);
      }
      continue;
    }
    if (excludeSet.has(wt.branch)) continue;
    const dirKey = keyFromWorktreePath(wt.path);
    const keys = uniqSorted([...(dirKey === null ? [] : [dirKey]), ...keysFromBranch(wt.branch)]);
    if (keys.length === 0) {
      keyless.push({ path: wt.path, branch: wt.branch, pr: null });
      continue;
    }
    let kind = null;
    if (mergedHeadSet.has(wt.branch)) {
      kind = 'merged-worktree';
    } else {
      const answer = git(['rev-list', '--count', `refs/remotes/origin/${base}..refs/heads/${wt.branch}`]);
      if (answer.status !== 'ok') {
        unknown.push(`git rev-list ${wt.branch} (${reasonOf(answer)})`);
      } else {
        const count = answer.stdout.trim();
        if (!/^\d+$/.test(count)) unknown.push(`git rev-list ${wt.branch} (shape)`);
        else kind = Number(count) >= 1 ? 'unmerged-worktree' : 'fresh-worktree';
      }
    }
    for (const key of keys) {
      if (kind !== null) addKind(key, kind);
      worktreePathOf.set(key, wt.path);
    }
  }

  /** @type {Map<number, number>} */
  const openPrOf = new Map();
  for (const pr of openPrs) {
    const keys = prKeys(pr);
    if (keys.length === 0) {
      keyless.push({ path: null, branch: pr.headRefName, pr: pr.number });
      continue;
    }
    for (const key of keys) if (!openPrOf.has(key)) openPrOf.set(key, pr.number);
  }

  /** @type {Map<number, number[]>} */
  const mergedClosing = new Map();
  for (const pr of mergedPrs) {
    for (const issue of closingIssuesOf(pr)) mergedClosing.set(issue, [...(mergedClosing.get(issue) ?? []), pr.number]);
  }

  // Evidence keys no read list held (#4642 r1): one `gh issue view` each, in key order, once per
  // number. A CLOSED one is not a row; an OPEN one is judged by the Milestone the view names.
  // (`gh issue view` is a single-Issue read, so it is the one source for a key no list covers.)
  const hiddenKeys = uniqSorted([...worktreeKinds.keys(), ...openPrOf.keys(), ...mergedClosing.keys(), ...(planKeys === null ? [] : [...planKeys])])
    .filter((key) => !issueMap.has(key));
  for (const key of hiddenKeys) {
    const name = `gh issue view #${key}`;
    const answer = gh(['issue', 'view', String(key), '--repo', repo, '--json', 'number,state,milestone,labels']);
    if (answer.status !== 'ok') {
      unknown.push(`${name} (${reasonOf(answer)})`);
      continue;
    }
    const view = parseIssueView(answer.stdout);
    if (view === null) {
      unknown.push(`${name} (shape)`);
      continue;
    }
    issueMap.set(key, { number: key, state: view.state, title: `issue ${key}`, labels: view.labels, milestone: view.milestone });
  }

  // M6: moves that the roadmap Issue's last comment does not cover (design §3.6).
  /** @type {Array<{ issue: number, event: string, milestone: string | null, createdAt: string }>} */
  const moves = [];
  const prevTitles = new Set(prevSprints.map((m) => m.title));
  if (history && roadmapIssue !== null) {
    const view = gh(['issue', 'view', String(roadmapIssue), '--repo', repo, '--json', 'comments']);
    let lastCommentAt = null;
    let roadmapOk = false;
    if (view.status !== 'ok') unknown.push(`gh issue view roadmap comments (${reasonOf(view)})`);
    else {
      const comments = parseComments(view.stdout);
      if (comments === null) unknown.push('gh issue view roadmap comments (shape)');
      else {
        roadmapOk = true;
        lastCommentAt = comments.length === 0 ? null : comments[comments.length - 1];
      }
    }
    if (roadmapOk) {
      const past = lastCommentAt === null ? '' : lastCommentAt;
      for (const issue of issueMap.values()) {
        if (issue.milestone !== current.title && !prevTitles.has(issue.milestone ?? '')) continue;
        const name = `gh api timeline #${issue.number}`;
        const answer = gh(['api', '--paginate', `repos/${repo}/issues/${issue.number}/timeline?per_page=100`]);
        if (answer.status !== 'ok') {
          unknown.push(`${name} (${reasonOf(answer)})`);
          continue;
        }
        const events = parseTimeline(answer.stdout);
        if (events === null) {
          unknown.push(`${name} (shape)`);
          continue;
        }
        for (const event of events) {
          if (event.event !== 'milestoned' && event.event !== 'demilestoned') continue;
          // A move with no timestamp cannot be shown to be before the record, so it is reported.
          if (past !== '' && event.createdAt !== null && event.createdAt <= past) continue;
          moves.push({ issue: issue.number, event: event.event, milestone: event.milestone, createdAt: event.createdAt ?? '(no time)' });
        }
      }
    }
  }

  const rows = judge({ currentTitle, prevTitles, issueMap, worktreeKinds, worktreePathOf, openPrOf, planKeys, mergedClosing, closedWithOpen, emptyPrev: prevSprints.filter((m) => m.openIssues === 0), moves });
  const complete = unknown.length === 0;

  // The five groups of summary (design §5).
  const hasWork = (n) => {
    const kinds = worktreeKinds.get(n);
    return (kinds !== undefined && (kinds.has('unmerged-worktree') || kinds.has('fresh-worktree'))) || openPrOf.has(n) || (planKeys !== null && planKeys.has(n));
  };
  const whereOf = (n) => (worktreePathOf.get(n) ?? (openPrOf.has(n) ? `PR #${openPrOf.get(n)}` : planKeys !== null && planKeys.has(n) ? 'plan' : '—'));
  const itemOf = (issue) => ({ issue: issue.number, title: issue.title, where: whereOf(issue.number) });
  const currentIssues = [...issueMap.values()].filter((issue) => issue.milestone === current.title).sort((a, b) => a.number - b.number);
  const groups = {
    done: currentIssues.filter((issue) => issue.state === 'CLOSED').map(itemOf),
    inProgress: currentIssues.filter((issue) => issue.state === 'OPEN' && hasWork(issue.number)).map(itemOf),
    remaining: currentIssues.filter((issue) => issue.state === 'OPEN' && !hasWork(issue.number)).map(itemOf),
    deferred: history ? moves.filter((move) => move.event === 'demilestoned' && move.milestone === current.title).map((move) => ({ issue: move.issue, title: issueMap.get(move.issue)?.title ?? `issue ${move.issue}`, at: move.createdAt })) : [],
    drift: rows.filter((r) => r.severity === 'drift'),
  };

  const milestoneView = { current: current.title, previous: prevSprints.map((m) => m.title) };
  const baseJson = { ok: complete, complete, milestone: milestoneView, rows, unknown, keyless, observedFrom, observedTo: iso(wallNow) };

  if (command === 'summary') {
    if (wantMd) stdout(renderMd({ currentTitle: current.title, currentIssues, groups, unknown, history }));
    else emit({ ...baseJson, summary: groups });
    if (!complete) stderr(`milestone-check: incomplete: ${unknown.join('; ')}`);
    return complete ? 0 : EXIT_UNKNOWN;
  }

  const drift = rows.some((r) => r.severity === 'drift');
  const exit = !complete ? EXIT_UNKNOWN : drift ? EXIT_DRIFT : 0;
  if (json) {
    emit(baseJson);
  } else {
    for (const r of rows) stdout(formatRow(r));
    stderr(`milestone-check: ${current.title}: ${rows.length} row(s), ${groups.drift.length} drift; ${unknown.length === 0 ? 'complete' : `incomplete (${unknown.join('; ')})`}.`);
  }
  return exit;
}

function formatRow(r) {
  return r.issue === null ? `${r.severity} ${r.kind} — ${r.detail}` : `${r.severity} ${r.kind} #${r.issue} — ${r.detail}`;
}

function renderMd({ currentTitle, currentIssues, groups, unknown, history }) {
  const lines = [`## Milestone ${currentTitle}（${groups.done.length}/${currentIssues.length} 完了）`];
  if (unknown.length > 0) lines.push(`> 不完全: ${unknown.join('; ')}`);
  const section = (title, items, render) => {
    lines.push(`### ${title}（${items.length}）`);
    for (const item of items) lines.push(render(item));
  };
  section('完了', groups.done, (item) => `- #${item.issue} ${item.title} — ${item.where}`);
  section('進行中', groups.inProgress, (item) => `- #${item.issue} ${item.title} — ${item.where}`);
  section('残り', groups.remaining, (item) => `- #${item.issue} ${item.title} — ${item.where}`);
  if (history) section('先送り', groups.deferred, (item) => `- #${item.issue} ${item.title} — ${item.at}`);
  else lines.push('### 先送り（0）', '- （履歴を読んでいない）');
  section('ずれ', groups.drift, (item) => (item.issue === null ? `- ${item.severity} ${item.kind} — ${item.detail}` : `- ${item.severity} ${item.kind} #${item.issue} — ${item.detail}`));
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
