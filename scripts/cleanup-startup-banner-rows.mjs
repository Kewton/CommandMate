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
 * Every `assistant` row of `codex` or `vibe-local` whose text holds the startup
 * screen's own words — `>_ OpenAI Codex (v` for codex, `O F F L I N E  A I  C O D I N G`
 * or `vibe-local (vibe-coder)` for vibe-local — is looked at. It is a candidate
 * only when all of these hold, checked in this order (the first that fails is
 * the reason it is left):
 *
 *  1. `keyed-row`: it has no `request_id`. The transcript writers (codex's
 *     `codex-turn:<id>` rows) key every row they write, and they also date a
 *     reply 1 ms before the next message; the screen reads never key a codex or
 *     vibe-local row;
 *  2. `holds-echo`: it holds no echoed user message. A row that does is a turn
 *     glued under the banner, and deleting it would delete the reply too;
 *  3. `has-body`: it is the startup screen and nothing else — every non-empty
 *     row is one the startup screen draws (see {@link isStartupScreenOnly}).
 *     A reply that quotes the banner has rows of its own and is never a candidate;
 *  4. `no-path-match`: it matches one of the two paths that saved it:
 *     - path A (the poller): the content keeps its colour escapes (`ESC[`);
 *     - path B (the pre-send flush): no colour escapes, and the next `user` row
 *       of the same worktree and instance is exactly 1 ms later.
 *
 * The rows are matched as the saving code left them, not as the pane drew
 * them: both paths drop the rows the tool's skip patterns name
 * (`lib/detection/cli-patterns.ts`), which for vibe-local include the
 * `🤖 vibe-local (vibe-coder)` row itself.
 *
 * Rows that are left are listed with their ids and reason, for a person to look
 * at. They are never deleted.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

/** The startup screens' own words, per tool: a row holding one is looked at. */
export const BANNER_MARKERS = Object.freeze({
  codex: [/>_ OpenAI Codex \(v\d/],
  'vibe-local': [/O F F L I N E\s+A I\s+C O D I N G/, /vibe-local \(vibe-coder\)/],
});

/** An echoed user message: codex `› <text>`, vibe-local `ctx:N% ❯ <text>`. */
const ECHO_PATTERNS = Object.freeze({
  codex: /^›\s+\S/,
  'vibe-local': /^ctx:\d+%\s*[>❯]\s*\S/,
});

/** A row of drawing only: box drawing, block elements, braille (the logos and rules). */
const ART_ROW = /^[\s\u2500-\u259F\u2800-\u28FF]+$/u;

/** codex 0.160.0's banner row, the first row of its startup screen. */
const CODEX_BANNER_ROW = /^>_ OpenAI Codex \(v[\d.]+[^)]*\)$/;

/** codex's second banner row: the working directory. */
const CODEX_CWD_ROW = /^[~/]/;

/** The longest one-line tagline codex draws under the cwd (measured ones are ~50 characters). */
const CODEX_TAGLINE_MAX = 120;

/**
 * The rows vibe-local's startup screen draws that survive the saving code's
 * filter (measured on 1.3.3, `tests/fixtures/startup-screen-3293/`).
 */
const VIBE_LOCAL_STARTUP_ROWS = Object.freeze([
  ART_ROW,
  /^=+$/,
  /^(Model|Ollama|Engine|Sidecar):\s/,
  /O F F L I N E\s+A I\s+C O D I N G/,
  /^v\d+\.\d+\.\d+\s+\/\//,
  /^\S+\s+(Model|Sidecar|Mode|Engine|RAM|CWD)\s/,
  /vibe-local|vibe-coder/,
  /^\/help\s/,
  /^IME/,
  /^First time\? Try typing:/,
  /^Type \/help for commands/,
]);

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
 * @property {string | null} request_id
 * @property {string} content
 * @property {number} timestamp
 */

/** @param {MessageRow} row */
function instanceOf(row) {
  return row.instance_id ?? row.cli_tool_id ?? '';
}

/**
 * The row's non-empty rows, colour escapes off and trimmed.
 *
 * @param {MessageRow} row
 * @returns {string[]}
 */
function nonEmptyRows(row) {
  return stripAnsi(row.content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Does the row hold its tool's startup-screen words anywhere? (Rows that do are
 * looked at; whether they are candidates is decided by {@link planCleanup}.)
 *
 * @param {MessageRow} row
 * @returns {boolean}
 */
export function hasBannerText(row) {
  const markers = BANNER_MARKERS[/** @type {keyof typeof BANNER_MARKERS} */ (row.cli_tool_id)];
  if (!markers) return false;
  const text = stripAnsi(row.content);
  return markers.some((marker) => marker.test(text));
}

/**
 * codex 0.160.0: the banner row first, then the cwd, at most one tagline row,
 * and the logo — nothing else.
 *
 * @param {string[]} rows - non-empty rows
 * @returns {boolean}
 */
function isCodexStartupScreenOnly(rows) {
  if (rows.length === 0 || !CODEX_BANNER_ROW.test(rows[0])) return false;
  let index = 1;
  if (index < rows.length && CODEX_CWD_ROW.test(rows[index])) index += 1;
  if (index < rows.length && !ART_ROW.test(rows[index])) {
    if (rows[index].length > CODEX_TAGLINE_MAX) return false;
    index += 1;
  }
  return rows.slice(index).every((line) => ART_ROW.test(line));
}

/**
 * Is every non-empty row of the saved content one the startup screen draws?
 *
 * @param {MessageRow} row
 * @returns {boolean}
 */
export function isStartupScreenOnly(row) {
  const rows = nonEmptyRows(row);
  if (row.cli_tool_id === 'codex') return isCodexStartupScreenOnly(rows);
  if (row.cli_tool_id === 'vibe-local') {
    return (
      rows.length > 0 &&
      hasBannerText(row) &&
      rows.every((line) => VIBE_LOCAL_STARTUP_ROWS.some((pattern) => pattern.test(line)))
    );
  }
  return false;
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
 * @typedef {'keyed-row' | 'holds-echo' | 'has-body' | 'no-path-match'} LeftReason
 * @typedef {object} CleanupPlan
 * @property {{ id: string; path: 'A' | 'B' }[]} candidates
 * @property {{ id: string; reason: LeftReason }[]} left
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
    .filter((row) => row.role === 'assistant' && hasBannerText(row))
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const row of assistants) {
    /** @type {LeftReason | null} */
    let reason = null;
    if (row.request_id !== null && row.request_id !== undefined && row.request_id !== '') reason = 'keyed-row';
    else if (holdsEcho(row)) reason = 'holds-echo';
    else if (!isStartupScreenOnly(row)) reason = 'has-body';
    if (reason !== null) {
      plan.left.push({ id: row.id, reason });
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
        `SELECT id, worktree_id, role, cli_tool_id, instance_id, request_id, content, timestamp
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
