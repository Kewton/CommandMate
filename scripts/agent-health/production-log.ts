/**
 * Watching the production server's log for hooks that went astray (Issue #2878).
 *
 * The probe's hooks must reach the script's own listener and nothing else. If
 * one reached the production server instead, the probe's worktree id shows up
 * in `logs/server.log`. The watcher remembers the log's size before a tool
 * runs and counts, afterwards, the appended lines that name the probe.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Where the production server writes (`scripts/start.sh` → `logs/server.log`
 * under the checkout that serves). From a git worktree that checkout is the
 * main worktree, which `--git-common-dir` points at.
 */
export function locateServerLog(repoRoot: string, explicit: string | null): string | null {
  if (explicit !== null) return path.resolve(explicit);
  const candidates: string[] = [];
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (commonDir) candidates.push(path.join(path.dirname(commonDir), 'logs', 'server.log'));
  } catch {
    // Not a git checkout — fall through to the repository root.
  }
  candidates.push(path.join(repoRoot, 'logs', 'server.log'));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Lines of `text` that contain `needle`. */
export function linesContaining(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

export class ServerLogWatch {
  private offset: number;

  constructor(readonly file: string | null) {
    this.offset = file ? sizeOf(file) : 0;
  }

  /** Line count of the log right now (for the record; the scan works on bytes). */
  lineCount(): number | null {
    if (!this.file) return null;
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').length - 1;
    } catch {
      return null;
    }
  }

  /**
   * Lines appended since the last call that contain `needle`. A log that
   * shrank was rotated; it is then read from its start.
   */
  takeLinesContaining(needle: string): string[] {
    if (!this.file) return [];
    const size = sizeOf(this.file);
    const from = size < this.offset ? 0 : this.offset;
    this.offset = size;
    if (size === from) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      return linesContaining(buffer.toString('utf8'), needle);
    } finally {
      fs.closeSync(fd);
    }
  }
}
