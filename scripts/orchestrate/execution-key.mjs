/**
 * The execution key of one `/orchestrate` attempt (Issue #3883).
 *
 * An Issue is the logical parent of its work, not one execution of it: one
 * Issue can carry several PRs (`PR 1a`, `PR 2`), each PR several tasks (a
 * re-instruction is a new task), and each task several attempts (a call that
 * is waited for again). Until this file the wait log was `wait-<issue>.log`,
 * the watched child's exit status `wait-<issue>.log.exit`, and the run record
 * grouped by Issue only, so two PRs of one Issue — or two attempts — shared a
 * log, could read each other's exit status, and shared one resume point.
 *
 * The key is made of:
 *   - the run: the run record's Issue range (`--issues`, run-log.mjs);
 *   - the work item: the Issue, plus `--item <name>` when the Issue has more
 *     than one PR (`3883-d1`). Without `--item` the work item is the Issue, as
 *     before;
 *   - the task: the ledger's task id (`-` when none is known);
 *   - the attempt: the n-th log of the work item in the run directory, taken
 *     exclusively (allocateLog), so two calls never get the same one.
 *
 * The files of an attempt are named after it: `wait-<work item>.log` for the
 * first attempt (the name it always had), `wait-<work item>.a<n>.log` after
 * that, and `.verify.log` / `.reverify.log` / `.exit` derived from that name.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A work item name: a short label, no dots or slashes (it becomes part of a file name). */
export const ITEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** Attempts tried before allocateLog gives up (a run directory never gets near it). */
export const MAX_ATTEMPTS = 999;

/** Why `item` is not a work item name, or null (absent is fine: the Issue is the work item). */
export function itemProblem(item) {
  if (item === undefined || item === null || item === '') return null;
  return ITEM_PATTERN.test(String(item)) ? null : `--item must match ${ITEM_PATTERN} (got ${item})`;
}

/** `3883` or `3883-d1`: the part of a file name and of the key that names the work item. */
export function workItemName(issue, item) {
  return item ? `${issue}-${item}` : String(issue);
}

/** `<issues>:<work item>:<task|->:a<attempt>` — one string for logs, records and messages. */
export function executionKey({ issues, issue, item, taskId, attempt }) {
  return `${issues}:${workItemName(issue, item)}:${taskId || '-'}:a${attempt}`;
}

/**
 * Take the log of a new attempt: the first `<prefix>-<work item>[.a<n>].log`
 * in `dir` that does not exist yet, created with `wx` so a concurrent call
 * cannot take the same one. Returns `{ file, attempt }`.
 */
export function allocateLog(dir, prefix, workItem) {
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const file = path.join(dir, `${prefix}-${workItem}${attempt === 1 ? '' : `.a${attempt}`}.log`);
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return { file, attempt };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`more than ${MAX_ATTEMPTS} ${prefix} logs of ${workItem} in ${dir}`);
}

/**
 * Take a log named by the caller (`--log`). A name that already exists belongs
 * to another attempt — its log, its `.exit` — so it is refused, not reused.
 */
export function claimLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.closeSync(fs.openSync(file, 'wx'));
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw Object.assign(new Error(`--log ${file} already exists (another attempt's log): name a new file, or leave --log out`), {
        usage: true,
      });
    }
    throw err;
  }
  return { file, attempt: 1 };
}
