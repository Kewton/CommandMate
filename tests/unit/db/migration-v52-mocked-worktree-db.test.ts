/**
 * Regression guard for the dependency direction between migrations and
 * `worktree-db.ts` (Issue #1621).
 *
 * Migration v52 sweeps orphaned child rows using the same schema introspection
 * the runtime uses. Sourcing that introspection from `worktree-db.ts` made every
 * `vi.mock('@/lib/db/worktree-db')` in the suite break `runMigrations` — a
 * partial mock omits whatever the migration imports, and the migration runner
 * turns that into `Migration 52 ... failed`. It cost 5 unrelated tests in
 * `daily-summary-metrics.test.ts` before the introspection moved under
 * `migrations/`.
 *
 * This file keeps its own mock so the failure mode is reproduced, not described.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';

// A deliberately partial mock, exactly like the suites that broke.
vi.mock('@/lib/db/worktree-db', () => ({
  getWorktrees: vi.fn(() => []),
}));

describe('migrations under a mocked worktree-db (Issue #1621)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => db.close());

  it('runs to the current version without importing worktree-db', () => {
    expect(() => runMigrations(db)).not.toThrow();

    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
