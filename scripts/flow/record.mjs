/**
 * The flow record (Issue #4367 PR1a, docs/design/flow-metrics-4367.md §2.1・§2.4, invariant V2).
 *
 *   <flowDir>/<repo-slug>/<YYYY-MM-DD>.jsonl   one `kind: "tick"` line per observation
 *
 * The line boundary is the newline, for the writer and the reader alike:
 * - the writer appends one line only when the file is absent, empty or ends in `\n`; any
 *   other tail is left byte for byte, nothing is appended, and the caller exits 1. No repair,
 *   no rename, no recovery (H8: a person fixes the file);
 * - the reader reads only lines that end in `\n`. A tail without one is unfinished, even when
 *   it parses as JSON, and is reported as such — never read as a record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseIsoTime, zonedDate } from './aggregate.mjs';

export { repoSlug } from './config.mjs';

export const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86_400_000;

/** `CM_FLOW_DIR`, or `<home>/.commandmate/flow`. */
export function flowDirOf(env, home) {
  const override = env?.CM_FLOW_DIR;
  return override && override.trim() !== '' ? override : path.join(home, '.commandmate', 'flow');
}

/**
 * Appends one tick line to `<dir>/<tz date of tick.at>.jsonl` (§2.4).
 * @param {string} dir   `<flowDir>/<repo-slug>`
 * @param {object & { at: string }} tick
 * @param {{ tz: string }} options
 * @returns {{ ok: true, file: string } | { ok: false, file: string, reason: 'unfinished-tail' | 'write-failed', code?: string }}
 */
export function appendTick(dir, tick, { tz }) {
  const file = path.join(dir, `${zonedDate(Date.parse(tick.at), tz)}.jsonl`);
  const line = `${JSON.stringify(tick)}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, file, reason: 'write-failed', code: /** @type {{ code?: string }} */ (err).code ?? String(err) };
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err).code;
    if (code !== 'ENOENT') return { ok: false, file, reason: 'write-failed', code: code ?? String(err) };
  }
  if (fd !== undefined) {
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        const read = fs.readSync(fd, last, 0, 1, size - 1);
        if (read !== 1 || last[0] !== 0x0a) return { ok: false, file, reason: 'unfinished-tail' };
      }
    } catch (err) {
      return { ok: false, file, reason: 'write-failed', code: /** @type {{ code?: string }} */ (err).code ?? String(err) };
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (err) {
    // A partial prefix may be on disk: it has no newline, so the next reader treats it as
    // unfinished and the next writer refuses to append (L8b). Nothing is repaired here.
    return { ok: false, file, reason: 'write-failed', code: /** @type {{ code?: string }} */ (err).code ?? String(err) };
  }
  return { ok: true, file };
}

function isTick(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (rec.v !== 1 || rec.kind !== 'tick') return false;
  if (typeof rec.tickId !== 'string' || rec.tickId === '') return false;
  if (parseIsoTime(rec.at) === null) return false;
  if (typeof rec.repo !== 'string' || typeof rec.base !== 'string') return false;
  const w = rec.window;
  if (w === null || typeof w !== 'object' || parseIsoTime(w.from) === null || parseIsoTime(w.to) === null) return false;
  return rec.metrics !== null && typeof rec.metrics === 'object' && !Array.isArray(rec.metrics);
}

/**
 * Reads the ticks of one scope (§2.4). Creates nothing.
 * `from`/`to` (epoch ms) narrow to ticks whose `at` is in `[from, to)`; without them every file is read.
 * Files are read newest first; a file over `maxFileBytes`, or past `maxTotalBytes` in all, is
 * skipped and listed in `truncatedFiles` (its values are not shown).
 * @param {string} dir   `<flowDir>/<repo-slug>`
 * @param {{ repo: string, base: string }} scope
 * @param {{ from?: number, to?: number, maxFileBytes?: number, maxTotalBytes?: number }} [options]
 */
export function readTicks(dir, scope, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const result = {
    exists: false,
    ticks: /** @type {any[]} */ ([]),
    corruptLines: 0,
    unfinishedFiles: /** @type {string[]} */ ([]),
    truncatedFiles: /** @type {string[]} */ ([]),
    unreadable: /** @type {{ file: string, code: string }[]}*/ ([]),
    filesRead: /** @type {string[]} */ ([]),
  };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err).code;
    if (code === 'ENOENT') return result;
    result.exists = true;
    result.unreadable.push({ file: dir, code: code ?? String(err) });
    return result;
  }
  result.exists = true;
  const hasRange = Number.isFinite(options.from) && Number.isFinite(options.to);
  // A file is named by the writer's tz date of `at`; zones are within ±14 h, so a day either side covers it.
  const lo = hasRange ? new Date(/** @type {number} */ (options.from) - DAY_MS).toISOString().slice(0, 10) : null;
  const hi = hasRange ? new Date(/** @type {number} */ (options.to) + DAY_MS).toISOString().slice(0, 10) : null;
  const files = names
    .map((name) => ({ name, m: FILE_PATTERN.exec(name) }))
    .filter(({ m }) => m && (!hasRange || (m[1] >= /** @type {string} */ (lo) && m[1] <= /** @type {string} */ (hi))))
    .map(({ name }) => name)
    .sort()
    .reverse();
  let total = 0;
  for (const name of files) {
    const file = path.join(dir, name);
    let buf;
    try {
      const size = fs.statSync(file).size;
      if (size > maxFileBytes || total + size > maxTotalBytes) {
        result.truncatedFiles.push(file);
        continue;
      }
      buf = fs.readFileSync(file);
      total += buf.length;
    } catch (err) {
      result.unreadable.push({ file, code: /** @type {{ code?: string }} */ (err).code ?? String(err) });
      continue;
    }
    result.filesRead.push(file);
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline !== text.length - 1) result.unfinishedFiles.push(file);
    if (lastNewline < 0) continue;
    for (const line of text.slice(0, lastNewline).split('\n')) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        result.corruptLines += 1;
        continue;
      }
      if (!isTick(rec)) {
        result.corruptLines += 1;
        continue;
      }
      if (rec.repo !== scope.repo || rec.base !== scope.base) continue;
      const at = /** @type {number} */ (parseIsoTime(rec.at));
      if (hasRange && (at < /** @type {number} */ (options.from) || at >= /** @type {number} */ (options.to))) continue;
      result.ticks.push(rec);
    }
  }
  result.ticks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return result;
}
