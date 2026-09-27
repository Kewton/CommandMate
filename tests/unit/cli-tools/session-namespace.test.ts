/**
 * Issue #2866: the server's tmux session-name namespace, against a real
 * migrated schema (`app_settings`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { getTmuxSessionNamespace, setTmuxSessionNamespace } from '@/lib/db/app-settings-db';
import {
  getSessionNamespace,
  initSessionNamespace,
  resetSessionNamespaceForTests,
} from '@/lib/cli-tools/session-namespace';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

const NS_PATTERN = /^[0-9a-f]{8}$/;

describe('session namespace (Issue #2866)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    resetSessionNamespaceForTests();
  });

  afterEach(() => {
    resetSessionNamespaceForTests();
    db.close();
  });

  it('is null before init', () => {
    expect(getSessionNamespace()).toBeNull();
    expect(resolveSessionName('claude', 'wt-1')).toBe('mcbd-claude-wt-1');
  });

  it('mints, saves and activates a namespace when none is stored', () => {
    expect(getTmuxSessionNamespace(db)).toBeNull();

    const ns = initSessionNamespace(db);

    expect(ns).toMatch(NS_PATTERN);
    expect(getTmuxSessionNamespace(db)).toBe(ns);
    expect(getSessionNamespace()).toBe(ns);
    expect(resolveSessionName('claude', 'wt-1')).toBe(`mcbd-${ns}-claude-wt-1`);
  });

  it('returns the stored namespace unchanged', () => {
    setTmuxSessionNamespace(db, '0a1b2c3d');

    expect(initSessionNamespace(db)).toBe('0a1b2c3d');
    expect(getTmuxSessionNamespace(db)).toBe('0a1b2c3d');
    expect(getSessionNamespace()).toBe('0a1b2c3d');
  });

  it('is stable across restarts (a second init reads what the first saved)', () => {
    const first = initSessionNamespace(db);
    resetSessionNamespaceForTests();
    expect(initSessionNamespace(db)).toBe(first);
  });

  it.each(['', 'ABCDEF01', '0a1b2c3', '0a1b2c3d4', 'zzzzzzzz', 'claude'])(
    'replaces an ill-formed stored value %j',
    (bad) => {
      setTmuxSessionNamespace(db, bad);

      const ns = initSessionNamespace(db);

      expect(ns).toMatch(NS_PATTERN);
      expect(ns).not.toBe(bad);
      expect(getTmuxSessionNamespace(db)).toBe(ns);
      expect(getSessionNamespace()).toBe(ns);
    }
  );
});
