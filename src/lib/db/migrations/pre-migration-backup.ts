/**
 * Pre-migration backup (Issue #3985).
 *
 * An older build refuses a database whose schema is newer than it knows
 * (runner.ts, Issue #1353), so rolling back the executable alone never
 * recovers from a bad migration — the database from before the migration is
 * needed too. This module takes that copy, right before the first pending
 * migration runs.
 *
 * The copy is made with `VACUUM INTO`, not by copying files: the connection is
 * in WAL mode, so committed updates may still live in `-wal` only, and copying
 * the main file (or the main file and `-wal` separately) gives no single point
 * in time. `VACUUM INTO` reads inside one read transaction and writes a
 * self-contained rollback-journal database. `db.backup()` is async and cannot
 * run inside the synchronous startup path.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Directory (next to the database file) that holds the copies. */
export const MIGRATION_BACKUP_DIR_NAME = 'db-backups';

/** Completed copies kept per database file. */
export const MIGRATION_BACKUP_GENERATIONS = 3;

/** Set to `1` to start without the copy (e.g. not enough free disk space). */
export const SKIP_MIGRATION_BACKUP_ENV = 'CM_DB_SKIP_MIGRATION_BACKUP';

const TEMP_SUFFIX = '.partial';

export interface PreMigrationBackupResult {
  /** Path of the verified copy */
  path: string;
  /** Completed copies removed by the generation limit */
  removed: string[];
}

/** True when the operator asked to start without the pre-migration copy. */
export function isMigrationBackupSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SKIP_MIGRATION_BACKUP_ENV] ?? '').trim() === '1';
}

/**
 * Whether there is anything worth copying.
 *
 * An in-memory database has no file to restore into. A brand-new database
 * (version 0 and no table besides `schema_version`, which the runner has just
 * created) has nothing to lose, and is what every test database looks like.
 */
export function needsPreMigrationBackup(db: Database.Database, currentVersion: number): boolean {
  // `typeof` covers adapters without a file name (scripts/spike's node:sqlite wrapper).
  if (db.memory || typeof db.name !== 'string' || db.name === '' || db.name === ':memory:') return false;
  if (currentVersion > 0) return true;
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version'
  `).get() as { count: number };
  return row.count > 0;
}

function utcStamp(date: Date): string {
  // 2026-10-29T01:02:03.456Z -> 20261029T010203456Z (sortable, filename-safe)
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Completed copies of `dbFileName` in `dir`, oldest first. */
export function listMigrationBackups(dir: string, dbFileName: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const pattern = new RegExp(
    `^${escapeRegExp(dbFileName)}\\.v\\d+-to-v\\d+\\.(\\d{8}T\\d{9}Z)\\.[0-9a-f]+\\.sqlite$`
  );
  return entries
    .map((name) => ({ name, stamp: pattern.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; stamp: string } => entry.stamp !== undefined)
    .sort((a, b) => (a.stamp === b.stamp ? a.name.localeCompare(b.name) : a.stamp.localeCompare(b.stamp)))
    .map((entry) => path.join(dir, entry.name));
}

function parseVersions(copyPath: string): { from: number; to: number } | null {
  const match = /\.v(\d+)-to-v(\d+)\.\d{8}T\d{9}Z\.[0-9a-f]+\.sqlite$/.exec(path.basename(copyPath));
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}

/**
 * Completed copies to delete, given all of them oldest first.
 *
 * Keeps the newest {@link MIGRATION_BACKUP_GENERATIONS}, except that the
 * original restore point of the current upgrade always survives: among the
 * copies whose target is `toVersion`, the one with the lowest source version
 * (the newest of those on a tie). A migration that half-succeeds (v59 -> v60
 * applied, v61 fails) leaves the next attempt starting from v60; retrying it
 * three times must not push out the v59 copy, which is the only one an older
 * build can open. That copy then takes one of the slots, so the total stays at
 * the limit.
 */
export function selectBackupsToPrune(completed: string[], toVersion: number): string[] {
  let original: string | undefined;
  let originalFrom = Infinity;
  for (const copy of completed) {
    const versions = parseVersions(copy);
    if (versions && versions.to === toVersion && versions.from <= originalFrom) {
      original = copy;
      originalFrom = versions.from;
    }
  }
  const newest = completed.slice(-MIGRATION_BACKUP_GENERATIONS);
  const keep = original === undefined || newest.includes(original)
    ? newest
    : [original, ...completed.slice(-(MIGRATION_BACKUP_GENERATIONS - 1))];
  return completed.filter((copy) => !keep.includes(copy));
}

function verifyCopy(copyPath: string, expectedVersion: number): void {
  const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`integrity_check returned ${String(integrity)}`);
    }
    let version = 0;
    try {
      const row = copy.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
        | { version: number | null }
        | undefined;
      version = row?.version ?? 0;
    } catch {
      version = 0;
    }
    if (version !== expectedVersion) {
      // Another process migrated between our version read and the copy (#1360).
      throw new Error(`copy is at schema v${version}, expected v${expectedVersion}`);
    }
  } finally {
    copy.close();
  }
}

/**
 * Take and verify the pre-migration copy, then prune old generations.
 *
 * @throws Error when the copy cannot be made or verified. The caller must not
 *   start migrating then; the message names the directory, the reason and the
 *   `CM_DB_SKIP_MIGRATION_BACKUP=1` escape hatch.
 */
export function createPreMigrationBackup(
  db: Database.Database,
  fromVersion: number,
  toVersion: number,
  now: Date = new Date()
): PreMigrationBackupResult {
  const dbPath = path.resolve(db.name);
  const dir = path.join(path.dirname(dbPath), MIGRATION_BACKUP_DIR_NAME);
  const dbFileName = path.basename(dbPath);
  const id = crypto.randomBytes(4).toString('hex');
  const finalPath = path.join(
    dir,
    `${dbFileName}.v${fromVersion}-to-v${toVersion}.${utcStamp(now)}.${id}.sqlite`
  );
  const tempPath = `${finalPath}${TEMP_SUFFIX}`;

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    // VACUUM INTO accepts an empty existing file; creating it first fixes the mode.
    fs.closeSync(fs.openSync(tempPath, 'wx', 0o600));
    db.prepare('VACUUM INTO ?').run(tempPath);
    fs.chmodSync(tempPath, 0o600);
    verifyCopy(tempPath, fromVersion);
    fs.renameSync(tempPath, finalPath);
  } catch (error: unknown) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort: a leftover *.partial is never counted as a completed copy
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not back up the database before migrating it (v${fromVersion} -> v${toVersion}). ` +
      `No migration was run. Backup directory: ${dir}. Reason: ${reason}. ` +
      `To start without the backup (e.g. when disk space is short), set ${SKIP_MIGRATION_BACKUP_ENV}=1.`
    );
  }

  // Prune only after the new copy is verified and in place.
  const removed: string[] = [];
  const completed = listMigrationBackups(dir, dbFileName);
  for (const old of selectBackupsToPrune(completed, toVersion)) {
    try {
      fs.rmSync(old, { force: true });
      removed.push(old);
    } catch {
      // a copy we could not delete is extra disk use, not a reason to stop startup
    }
  }

  return { path: finalPath, removed };
}
