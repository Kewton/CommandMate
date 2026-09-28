/**
 * Why an OpenCode 1.x launch never started its server, when opencode's own log
 * says (Issue #2939, D2).
 *
 * OpenCode 1.x and OpenCode V2 share `~/.local/share/opencode/opencode.db`. V2
 * rebuilt the `workspace` table without the `project_id` column 1.x still
 * writes, and a 1.x launch that reached that code died with
 * `SQLiteError: no such column: project_id` (measured 2026-09-28, 17 lines in
 * opencode's log). CommandMate only saw `opencode-server-not-reachable`, and
 * the operator was left with a pane that never came up and no reason.
 *
 * This reads the log opencode writes — `<XDG_DATA_HOME or ~/.local/share>/
 * opencode/log/opencode.log`, one `timestamp=<ISO> level=… ` record per line —
 * and reports a `no such column` error from a line stamped at or after the
 * launch. Read-only, bounded to the last {@link OPENCODE_LOG_TAIL_BYTES} of the
 * file, and every failure (no file, unreadable, nothing matching) is null,
 * which leaves the launch reported exactly as before.
 *
 * CommandMate cannot repair the database: two incompatible opencode releases
 * sharing one data directory is opencode's problem. What it can do is name it.
 *
 * @module lib/hooks/sources/opencode/log-diagnosis
 */

import { open } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/** How much of the end of the log is read. The file is multi-megabyte. */
export const OPENCODE_LOG_TAIL_BYTES = 256 * 1024;

/**
 * Lines stamped this long before the launch still count. The TUI writes its
 * first line within milliseconds of the keystroke; the slack only absorbs the
 * gap between `Date.now()` here and the pane's process starting.
 */
const LAUNCH_CLOCK_SLACK_MS = 1000;

const TIMESTAMP_FIELD = /^timestamp=(\S+)/;
const NO_SUCH_COLUMN = /no such column: ?[A-Za-z0-9_.]*/;

/** Where opencode writes its log, honouring `XDG_DATA_HOME` as opencode does. */
export function resolveOpencodeLogPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'log', 'opencode.log');
}

/** The last `maxBytes` of `path`, or null when it cannot be read. */
async function readTail(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    // A read that starts mid-file starts mid-line; that fragment has no stamp.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The `no such column` error opencode logged since `since`, or null.
 *
 * @param since - Epoch ms the launch keystroke was sent
 * @param logPath - Defaults to {@link resolveOpencodeLogPath}
 * @returns The matched fragment, e.g. `no such column: project_id`
 */
export async function findOpencodeSharedDataConflict(
  since: number,
  logPath: string = resolveOpencodeLogPath()
): Promise<string | null> {
  const text = await readTail(logPath, OPENCODE_LOG_TAIL_BYTES);
  if (text === null) return null;
  const threshold = since - LAUNCH_CLOCK_SLACK_MS;
  for (const line of text.split('\n')) {
    const stamp = TIMESTAMP_FIELD.exec(line);
    if (!stamp) continue;
    const at = Date.parse(stamp[1]);
    if (Number.isNaN(at) || at < threshold) continue;
    const match = NO_SUCH_COLUMN.exec(line);
    if (match) return match[0];
  }
  return null;
}

/**
 * The start error an operator sees for {@link findOpencodeSharedDataConflict}'s
 * finding.
 */
export function buildOpencodeSharedDataConflictMessage(finding: string): string {
  return (
    `OpenCode 1.x could not open its data (opencode log: "${finding}"). ` +
    'OpenCode 1.x and OpenCode V2 share ~/.local/share/opencode/opencode.db, and V2 ' +
    'has changed tables 1.x still uses. Use only OpenCode V2, or give OpenCode 1.x a ' +
    'data directory of its own (docs/user-guide/cli-setup-guide.md, "OpenCode (1.x) and OpenCode V2").'
  );
}
