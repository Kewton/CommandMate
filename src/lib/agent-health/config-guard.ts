/**
 * Saving and restoring machine-singleton files byte for byte (Issue #2878).
 *
 * `prepareLaunch` of a `configScope: 'global-singleton'` source rewrites a file
 * the whole machine shares (codex's `$CODEX_HOME/hooks.json`, antigravity's
 * `~/.gemini/config/hooks.json`). The probe must leave it exactly as it found
 * it, so the bytes are saved before the launch and written back afterwards,
 * and "written back" is proved by comparing sha256 digests — not assumed.
 *
 * A file that did not exist before is restored by removing it.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import type { GlobalConfigRestoreEntry } from './types';

export interface FileSnapshot {
  path: string;
  /** null when the file did not exist. */
  content: Buffer | null;
  /** sha256 of `content`, or null when the file did not exist. */
  sha256: string | null;
  mode: number | null;
}

export function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readIfPresent(path: string): { content: Buffer; mode: number } | null {
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    return { content: fs.readFileSync(path), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function snapshotFile(path: string): FileSnapshot {
  const current = readIfPresent(path);
  return {
    path,
    content: current?.content ?? null,
    sha256: current ? sha256Of(current.content) : null,
    mode: current?.mode ?? null,
  };
}

/** The sha256 the file has now (null when absent). */
export function currentSha256(path: string): string | null {
  const current = readIfPresent(path);
  return current ? sha256Of(current.content) : null;
}

/**
 * Put `snapshot` back and prove it by digest. Writes only when the file
 * differs, so an untouched file is never rewritten (its mtime stays).
 */
export function restoreSnapshot(snapshot: FileSnapshot): GlobalConfigRestoreEntry {
  try {
    if (currentSha256(snapshot.path) !== snapshot.sha256) {
      if (snapshot.content === null) {
        fs.rmSync(snapshot.path, { force: true });
      } else {
        fs.writeFileSync(snapshot.path, snapshot.content);
        if (snapshot.mode !== null) fs.chmodSync(snapshot.path, snapshot.mode);
      }
    }
    const after = currentSha256(snapshot.path);
    const restored = after === snapshot.sha256;
    return {
      path: snapshot.path,
      restored,
      kind: 'hook-config',
      ...(restored ? {} : { detail: `sha256 が一致しない（期待 ${snapshot.sha256 ?? '不在'}、実際 ${after ?? '不在'}）` }),
    };
  } catch (error) {
    return {
      path: snapshot.path,
      restored: false,
      kind: 'hook-config',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Drop every object key, array element and string that mentions `marker`. */
export function withoutMarker(value: unknown, marker: string): unknown {
  if (typeof value === 'string') return value.includes(marker) ? undefined : value;
  if (Array.isArray(value)) {
    return value.map((item) => withoutMarker(item, marker)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(marker)) continue;
      const kept = withoutMarker(item, marker);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

function parseJson(content: Buffer | null): unknown {
  if (content === null) return null;
  return JSON.parse(content.toString('utf8'));
}

/**
 * Whether two versions of a trust-state file differ only by the run's own
 * entries (anything mentioning `marker`). Throws when a version cannot be read
 * in the file's format; `restoreTrustState` reports that as not restored.
 */
export type TrustStateComparator = (before: Buffer | null, now: Buffer | null, marker: string) => boolean;

/** JSON files (antigravity's `settings.json`, command-code's `trusted-hooks.json`). */
export const sameJsonWithoutMarker: TrustStateComparator = (before, now, marker) =>
  JSON.stringify(withoutMarker(parseJson(now), marker)) === JSON.stringify(withoutMarker(parseJson(before), marker));

/** A table or array-of-tables header line (`[a.b]`, `[[a]]`). */
const TOML_HEADER = /^\s*\[/;

/**
 * The lines of a TOML file with every table whose header mentions `marker`
 * dropped — header line through to the next header or EOF — and blank lines
 * left out, since codex writes a blank line in front of each table it adds
 * (Issue #3031). Line-based on purpose: codex records a folder's trust as a
 * whole `[projects."<dir>"]` table, so no parser is needed to take it out.
 */
export function tomlLinesWithoutMarker(content: string, marker: string): string[] {
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/)) {
    if (TOML_HEADER.test(line)) skipping = line.includes(marker);
    if (skipping || line.trim() === '') continue;
    kept.push(line);
  }
  return kept;
}

/**
 * codex's `$CODEX_HOME/config.toml` (Issue #3031). An absent file reads as
 * empty, so one codex created holding nothing but the run's table is removed.
 */
export const sameTomlWithoutMarker: TrustStateComparator = (before, now, marker) => {
  const lines = (content: Buffer | null) =>
    JSON.stringify(tomlLinesWithoutMarker(content?.toString('utf8') ?? '', marker));
  return lines(now) === lines(before);
};

/**
 * Restore a CLI's own trust-state file (e.g. antigravity's
 * `trustedWorkspaces`), but only when the run's own entries — anything that
 * mentions `marker`, the probe's temp-dir prefix — are the whole difference.
 * If something else changed too (the user trusted a folder meanwhile), the
 * file is left alone and reported as not restored: overwriting it would lose
 * the user's change, which is worse than leaving one stale temp path behind.
 * `same` reads the file's format; JSON unless the caller says otherwise.
 */
export function restoreTrustState(
  snapshot: FileSnapshot,
  marker: string,
  same: TrustStateComparator = sameJsonWithoutMarker
): GlobalConfigRestoreEntry {
  const base = { path: snapshot.path, kind: 'trust-state' as const };
  try {
    const now = readIfPresent(snapshot.path);
    const nowSha = now ? sha256Of(now.content) : null;
    if (nowSha === snapshot.sha256) return { ...base, restored: true };
    if (!same(snapshot.content, now?.content ?? null, marker)) {
      return { ...base, restored: false, detail: '実行中に別の変更が入ったため触っていない' };
    }
    return { ...restoreSnapshot(snapshot), kind: 'trust-state' };
  } catch (error) {
    return {
      ...base,
      restored: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
