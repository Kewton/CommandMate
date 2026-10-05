#!/usr/bin/env node
/**
 * One-off cleanup for Issue #3335: assistant rows that hold codex's or
 * vibe-local's startup screen (the banner) instead of a reply.
 *
 * Before #3293 both screen-reading paths saved the startup screen as the agent's
 * first reply. #3293 stopped new ones; this finds the rows already saved.
 *
 * Usage (from a clone of the repository, with the server stopped):
 *   node scripts/cleanup-startup-banner-rows.mjs --db <path>            # dry run (default)
 *   node scripts/cleanup-startup-banner-rows.mjs --db <path> --apply    # delete the candidates
 *
 * `--db` has no default on purpose: the command never opens a database it was
 * not pointed at. The dry run opens the file read-only and prints the number of
 * candidates and their ids; nothing is written without `--apply`.
 *
 * ## How a row is told apart (the "経路の見分け方" of #3293, plus the banner text)
 *
 * A candidate is an `assistant` row of `codex` or `vibe-local` that
 *
 *  1. carries the startup screen's own text near its top — `>_ OpenAI Codex (v`
 *     for codex, `vibe-local (vibe-coder)` or `O F F L I N E  A I  C O D I N G`
 *     for vibe-local — on one of its first {@link BANNER_HEAD_ROWS} non-empty rows;
 *  2. holds no echoed user message (a row that does is a turn glued under the
 *     banner, and deleting it would delete the reply too);
 *  3. matches one of the two paths that saved it:
 *     - path A (the poller): the content keeps its colour escapes (`ESC[`);
 *     - path B (the pre-send flush): no colour escapes, and the next `user` row
 *       of the same worktree and instance is exactly 1 ms later.
 *
 * Rows that pass (1) but not (2) or (3) are reported as "left" with their ids,
 * for a person to look at. They are never deleted.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

/** How many non-empty rows from the top the banner text is looked for in. */
export const BANNER_HEAD_ROWS = 5;

/** The startup screens' own text, per tool. */
export const BANNER_MARKERS = Object.freeze({
  codex: [/>_ OpenAI Codex \(v\d/],
  'vibe-local': [/vibe-local \(vibe-coder\)/, /O F F L I N E\s+A I\s+C O D I N G/],
});

/** An echoed user message: codex `› <text>`, vibe-local `ctx:N% ❯ <text>`. */
const ECHO_PATTERNS = Object.freeze({
  codex: /^›\s+\S/,
  'vibe-local': /^ctx:\d+%\s*[>❯]\s*\S/,
});

/** The offset the pre-send flush stamps its row with (ASSISTANT_TIMESTAMP_OFFSET_MS). */
const FLUSH_OFFSET_MS = 1;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** @param {string} text */
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/** @param {string} text */
function hasColourEscapes(text) {
  return text.includes('\x1b[');
}

/**
 * @typedef {object} MessageRow
 * @property {string} id
 * @property {string} worktree_id
 * @property {string} role
 * @property {string | null} cli_tool_id
 * @property {string | null} instance_id
 * @property {string} content
 * @property {number} timestamp
 */

/** @param {MessageRow} row */
function instanceOf(row) {
  return row.instance_id ?? row.cli_tool_id ?? '';
}

/**
 * Does the row carry its tool's startup screen near its top?
 *
 * @param {MessageRow} row
 * @returns {boolean}
 */
export function hasStartupBanner(row) {
  const markers = BANNER_MARKERS[/** @type {keyof typeof BANNER_MARKERS} */ (row.cli_tool_id)];
  if (!markers) return false;
  const head = stripAnsi(row.content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, BANNER_HEAD_ROWS);
  return head.some((line) => markers.some((marker) => marker.test(line)));
}

/**
 * @param {MessageRow} row
 * @returns {boolean}
 */
function holdsEcho(row) {
  const echo = ECHO_PATTERNS[/** @type {keyof typeof ECHO_PATTERNS} */ (row.cli_tool_id)];
  return stripAnsi(row.content)
    .split('\n')
    .some((line) => echo.test(line.trimStart()));
}

/**
 * Which path saved the row, or null when it matches neither.
 *
 * @param {MessageRow} row - an assistant row
 * @param {readonly MessageRow[]} userRows - the user rows of the same worktree and instance, oldest first
 * @returns {'A' | 'B' | null}
 */
export function savedBy(row, userRows) {
  if (hasColourEscapes(row.content)) return 'A';
  const next = userRows.find((user) => user.timestamp > row.timestamp);
  return next && next.timestamp - row.timestamp === FLUSH_OFFSET_MS ? 'B' : null;
}

/**
 * @typedef {object} CleanupPlan
 * @property {{ id: string; path: 'A' | 'B' }[]} candidates
 * @property {{ id: string; reason: 'holds-echo' | 'no-path-match' }[]} left
 */

/**
 * Decide which rows are startup screens. Pure: reads nothing but `rows`.
 *
 * @param {readonly MessageRow[]} rows - every chat_messages row of the tools concerned
 * @returns {CleanupPlan}
 */
export function planCleanup(rows) {
  /** @type {Map<string, MessageRow[]>} */
  const usersByInstance = new Map();
  for (const row of rows) {
    if (row.role !== 'user') continue;
    const key = `${row.worktree_id}\u0000${instanceOf(row)}`;
    const list = usersByInstance.get(key) ?? [];
    list.push(row);
    usersByInstance.set(key, list);
  }
  for (const list of usersByInstance.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  /** @type {CleanupPlan} */
  const plan = { candidates: [], left: [] };
  const assistants = rows
    .filter((row) => row.role === 'assistant' && hasStartupBanner(row))
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const row of assistants) {
    if (holdsEcho(row)) {
      plan.left.push({ id: row.id, reason: 'holds-echo' });
      continue;
    }
    const users = usersByInstance.get(`${row.worktree_id}\u0000${instanceOf(row)}`) ?? [];
    const route = savedBy(row, users);
    if (route === null) plan.left.push({ id: row.id, reason: 'no-path-match' });
    else plan.candidates.push({ id: row.id, path: route });
  }
  return plan;
}

/**
 * The rows the plan looks at: both roles of codex and vibe-local. `SELECT` only.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {MessageRow[]}
 */
export function loadRows(db) {
  return /** @type {MessageRow[]} */ (
    db
      .prepare(
        `SELECT id, worktree_id, role, cli_tool_id, instance_id, content, timestamp
         FROM chat_messages WHERE cli_tool_id IN ('codex', 'vibe-local')`
      )
      .all()
  );
}

/**
 * Delete the candidates in one transaction. Throws (and deletes nothing) if a
 * row is gone or is no longer an assistant row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {CleanupPlan} plan
 * @returns {number} rows deleted
 */
export function applyCleanup(db, plan) {
  const remove = db.prepare(`DELETE FROM chat_messages WHERE id = ? AND role = 'assistant'`);
  db.transaction(() => {
    for (const { id } of plan.candidates) {
      if (remove.run(id).changes !== 1) {
        throw new Error(`row ${id} disappeared before it could be deleted`);
      }
    }
  })();
  return plan.candidates.length;
}

/**
 * @param {readonly string[]} argv
 * @returns {{ dbPath: string; apply: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let dbPath = null;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--db') {
      const value = argv[i + 1];
      if (!value) throw new Error('--db needs a path');
      dbPath = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (dbPath === null) throw new Error('--db <path> is required (there is no default database)');
  return { dbPath, apply };
}

/**
 * Open the DB (read-only for a dry run), plan, and delete only with `--apply`.
 *
 * @param {readonly string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {CleanupPlan}
 */
export function run(argv, log = (line) => process.stdout.write(`${line}\n`)) {
  const args = parseArgs(argv);
  const db = new Database(args.dbPath, { fileMustExist: true, readonly: !args.apply });
  try {
    const plan = planCleanup(loadRows(db));
    log(`${args.apply ? 'apply' : 'dry-run'}: ${args.dbPath}`);
    log(`  candidates (startup screen rows): ${plan.candidates.length}`);
    for (const { id, path: route } of plan.candidates) log(`    ${id}  path ${route}`);
    log(`  left (banner text, but not deleted): ${plan.left.length}`);
    for (const { id, reason } of plan.left) log(`    ${id}  ${reason}`);
    if (args.apply) log(`  deleted: ${applyCleanup(db, plan)}`);
    else log('  (dry run: nothing changed; pass --apply to delete the candidates)');
    return plan;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
