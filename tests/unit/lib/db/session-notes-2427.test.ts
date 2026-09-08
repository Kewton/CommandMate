/**
 * The per-session note and the table it lives in (Issue #2427).
 *
 * The note is a memo an operator rewrites every time they hand a session a new
 * instruction — so the two things it has to survive are the two things that
 * happen most often around it: the roster REPLACE that renaming an alias or
 * reordering the list performs (`setAgentInstances` deletes every row and
 * re-inserts), and the removal of a neighbouring instance.
 *
 * ## The mutation this file is written against
 *
 * Delete the `pruneSessionNotes(...)` call from `setAgentInstances` and
 * "a removed instance's note does not come back with a re-used id" turns red,
 * while every other test here stays green. That is the pair the Issue asks for:
 * the prune must remove exactly the ids that LEFT and nothing else, so a test
 * that only proved survival would pass with the prune deleted, and a test that
 * only proved pruning would pass with the whole replace deleted.
 *
 * `getWorktreeChildTables` is exercised rather than described, because the
 * table's participation in a worktree id rename (v54/v55) and in the delete
 * sweep is a consequence of how the FK is spelled, not of anything a reader can
 * see in the CREATE TABLE.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { upsertWorktree } from '@/lib/db';
import {
  MAX_SESSION_NOTE_LENGTH,
  SessionNoteTooLongError,
  InvalidAgentInstanceError,
  addAgentInstance,
  getAllSessionNotes,
  getSessionNote,
  getSessionNotesByWorktree,
  normalizeSessionNoteText,
  pruneSessionNotes,
  removeAgentInstance,
  setAgentInstances,
  setSessionNote,
  sessionNoteLength,
} from '@/lib/db/agent-instances-db';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const WT = 'wt-2427-notes';
const OTHER_WT = 'wt-2427-other';

/** The roster this file starts from: a primary claude and two codex aliases. */
function roster(): AgentInstance[] {
  return [
    { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
    { id: 'codex-2', cliTool: 'codex', alias: 'レビュー担当', order: 1 },
    { id: 'codex-3', cliTool: 'codex', alias: '調査担当', order: 2 },
  ];
}

function worktree(id: string): Worktree {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  };
}

describe('session notes (Issue #2427)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    upsertWorktree(db, worktree(WT));
    upsertWorktree(db, worktree(OTHER_WT));
    setAgentInstances(db, WT, roster());
  });

  afterEach(() => db.close());

  // ==========================================================================
  // Migration v61
  // ==========================================================================

  describe('migration v61', () => {
    it('applies as part of the ordinary run and lands on the current version', () => {
      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(61);
    });

    it('keys a note on (worktree_id, instance_id), the roster identity', () => {
      const pk = (
        db.prepare('PRAGMA table_info("session_notes")').all() as Array<{
          name: string;
          pk: number;
          notnull: number;
        }>
      );
      const keyed = pk.filter((column) => column.pk > 0).map((column) => column.name).sort();
      expect(keyed).toEqual(['instance_id', 'worktree_id']);

      // The two columns a reader is displayed are both required: a row means a
      // note exists, and the Issue puts the time on screen beside it.
      const required = pk.filter((column) => column.notnull === 1).map((column) => column.name);
      expect(required).toContain('note');
      expect(required).toContain('updated_at');
    });

    it('is found by getWorktreeChildTables, so it follows renames and deletes', () => {
      const children = getWorktreeChildTables(db).map(({ table, column }) => `${table}.${column}`);
      expect(children).toContain('session_notes.worktree_id');
    });

    it('is swept when the worktree is deleted (ON DELETE CASCADE)', () => {
      setSessionNote(db, WT, 'claude', 'DB 層の実装');
      db.prepare('DELETE FROM worktrees WHERE id = ?').run(WT);

      const rows = db
        .prepare('SELECT COUNT(*) AS count FROM session_notes WHERE worktree_id = ?')
        .get(WT) as { count: number };
      expect(rows.count).toBe(0);
    });

    it('rolls back by dropping the table and nothing else', () => {
      const fresh = new Database(':memory:');
      runMigrations(fresh);
      expect(
        fresh
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_notes'")
          .get()
      ).toBeTruthy();
      fresh.close();
    });
  });

  // ==========================================================================
  // Reading and writing
  // ==========================================================================

  describe('setSessionNote / getSessionNote', () => {
    it('stores a note with the instant it was written', () => {
      const at = Date.UTC(2026, 8, 8, 5, 32);
      const stored = setSessionNote(db, WT, 'codex-2', '#2427 の DB 層', at);

      expect(stored).toEqual({ text: '#2427 の DB 層', updatedAt: at });
      expect(getSessionNote(db, WT, 'codex-2')).toEqual({ text: '#2427 の DB 層', updatedAt: at });
    });

    it('answers null for a session nobody annotated', () => {
      expect(getSessionNote(db, WT, 'claude')).toBeNull();
    });

    it('overwrites in place and moves the timestamp forward', () => {
      setSessionNote(db, WT, 'claude', 'first', 1_000);
      setSessionNote(db, WT, 'claude', 'second', 2_000);

      expect(getSessionNote(db, WT, 'claude')).toEqual({ text: 'second', updatedAt: 2_000 });
      const rows = db
        .prepare('SELECT COUNT(*) AS count FROM session_notes WHERE worktree_id = ?')
        .get(WT) as { count: number };
      expect(rows.count).toBe(1);
    });

    it('DELETES the row when cleared rather than storing an empty string', () => {
      setSessionNote(db, WT, 'claude', 'temporary');
      expect(setSessionNote(db, WT, 'claude', '')).toBeNull();

      expect(getSessionNote(db, WT, 'claude')).toBeNull();
      const rows = db
        .prepare('SELECT COUNT(*) AS count FROM session_notes WHERE worktree_id = ?')
        .get(WT) as { count: number };
      expect(rows.count).toBe(0);
    });

    it('treats whitespace-only input as a clear', () => {
      setSessionNote(db, WT, 'claude', 'temporary');
      expect(setSessionNote(db, WT, 'claude', '   ')).toBeNull();
      expect(getSessionNote(db, WT, 'claude')).toBeNull();
    });

    it('refuses an instance id that is not a valid one', () => {
      expect(() => setSessionNote(db, WT, '../etc/passwd', 'x')).toThrow(InvalidAgentInstanceError);
    });

    it('scopes a note to its worktree', () => {
      setSessionNote(db, WT, 'claude', 'this worktree');
      expect(getSessionNote(db, OTHER_WT, 'claude')).toBeNull();
    });
  });

  describe('normalizeSessionNoteText', () => {
    it('folds a pasted newline into a space rather than refusing the paste', () => {
      expect(normalizeSessionNoteText('fix the poller\nthen re-run verify')).toBe(
        'fix the poller then re-run verify'
      );
    });

    it('collapses runs of whitespace and trims the ends', () => {
      expect(normalizeSessionNoteText('  a \t\t b  ')).toBe('a b');
    });

    it('answers the empty string for a non-string', () => {
      expect(normalizeSessionNoteText(undefined)).toBe('');
      expect(normalizeSessionNoteText(42)).toBe('');
    });

    it('is what the stored value goes through', () => {
      setSessionNote(db, WT, 'claude', '  レビュー\n待ち  ');
      expect(getSessionNote(db, WT, 'claude')?.text).toBe('レビュー 待ち');
    });
  });

  describe(`the ${MAX_SESSION_NOTE_LENGTH}-character limit`, () => {
    it('accepts a note of exactly the limit', () => {
      const text = 'a'.repeat(MAX_SESSION_NOTE_LENGTH);
      expect(setSessionNote(db, WT, 'claude', text)?.text).toBe(text);
    });

    it('refuses one character more, and stores nothing', () => {
      const text = 'a'.repeat(MAX_SESSION_NOTE_LENGTH + 1);
      expect(() => setSessionNote(db, WT, 'claude', text)).toThrow(SessionNoteTooLongError);
      expect(getSessionNote(db, WT, 'claude')).toBeNull();
    });

    it('counts an emoji as one character, not two', () => {
      // 100 code points, 200 UTF-16 units. A limit measured in `.length` would
      // reject this, and the operator who typed 100 characters would be told
      // they typed 200.
      const text = '\u{1f642}'.repeat(MAX_SESSION_NOTE_LENGTH);
      expect(text.length).toBe(MAX_SESSION_NOTE_LENGTH * 2);
      expect(sessionNoteLength(text)).toBe(MAX_SESSION_NOTE_LENGTH);
      expect(setSessionNote(db, WT, 'claude', text)?.text).toBe(text);
    });

    it('measures the NORMALIZED text, so padding cannot be smuggled past it', () => {
      const padded = `   ${'a'.repeat(MAX_SESSION_NOTE_LENGTH)}   `;
      expect(padded.length).toBeGreaterThan(MAX_SESSION_NOTE_LENGTH);
      expect(setSessionNote(db, WT, 'claude', padded)?.text).toBe(
        'a'.repeat(MAX_SESSION_NOTE_LENGTH)
      );
    });
  });

  describe('bulk reads', () => {
    it('keys a worktree read by instance id and omits the un-annotated', () => {
      setSessionNote(db, WT, 'claude', 'A', 10);
      setSessionNote(db, WT, 'codex-3', 'B', 20);

      expect(getSessionNotesByWorktree(db, WT)).toEqual({
        claude: { text: 'A', updatedAt: 10 },
        'codex-3': { text: 'B', updatedAt: 20 },
      });
    });

    it('groups the whole server by worktree, which is what the list route reads', () => {
      setSessionNote(db, WT, 'claude', 'A', 10);
      setSessionNote(db, OTHER_WT, 'claude', 'B', 20);

      expect(getAllSessionNotes(db)).toEqual({
        [WT]: { claude: { text: 'A', updatedAt: 10 } },
        [OTHER_WT]: { claude: { text: 'B', updatedAt: 20 } },
      });
    });

    it('answers an empty object when nothing is annotated', () => {
      expect(getAllSessionNotes(db)).toEqual({});
      expect(getSessionNotesByWorktree(db, WT)).toEqual({});
    });
  });

  // ==========================================================================
  // Surviving the roster replace — the reason for a table of its own
  // ==========================================================================

  describe('the roster replace (setAgentInstances)', () => {
    it('keeps every note when an alias is edited', () => {
      setSessionNote(db, WT, 'claude', 'DB 層', 10);
      setSessionNote(db, WT, 'codex-2', 'レビュー中', 20);

      // What the alias editor posts: the same three ids, one new alias.
      setAgentInstances(db, WT, [
        { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
        { id: 'codex-2', cliTool: 'codex', alias: '別名にした', order: 1 },
        { id: 'codex-3', cliTool: 'codex', alias: '調査担当', order: 2 },
      ]);

      expect(getSessionNotesByWorktree(db, WT)).toEqual({
        claude: { text: 'DB 層', updatedAt: 10 },
        'codex-2': { text: 'レビュー中', updatedAt: 20 },
      });
    });

    it('keeps the surviving notes when the list is reordered', () => {
      setSessionNote(db, WT, 'codex-3', '調査ログを読む', 30);

      setAgentInstances(db, WT, [
        { id: 'codex-3', cliTool: 'codex', alias: '調査担当', order: 0 },
        { id: 'claude', cliTool: 'claude', alias: '', order: 1 },
        { id: 'codex-2', cliTool: 'codex', alias: 'レビュー担当', order: 2 },
      ]);

      expect(getSessionNote(db, WT, 'codex-3')).toEqual({ text: '調査ログを読む', updatedAt: 30 });
    });

    it('keeps the surviving notes when an instance is added', () => {
      setSessionNote(db, WT, 'claude', 'DB 層', 10);

      setAgentInstances(db, WT, [
        ...roster(),
        { id: 'codex-4', cliTool: 'codex', alias: '', order: 3 },
      ]);

      expect(getSessionNote(db, WT, 'claude')).toEqual({ text: 'DB 層', updatedAt: 10 });
    });

    it('keeps the surviving notes when a NEIGHBOUR is removed', () => {
      setSessionNote(db, WT, 'claude', 'DB 層', 10);
      setSessionNote(db, WT, 'codex-2', 'レビュー中', 20);

      setAgentInstances(db, WT, [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);

      expect(getSessionNote(db, WT, 'claude')).toEqual({ text: 'DB 層', updatedAt: 10 });
    });

    /**
     * THE mutation guard. Remove `pruneSessionNotes(...)` from
     * `setAgentInstances` and this is the assertion that fails: the row for
     * `codex-2` survives a roster that no longer contains it, and the next
     * instance to claim that id inherits a memo about work it never did.
     */
    it('does not let a removed instance’s note come back with a re-used id', () => {
      setSessionNote(db, WT, 'codex-2', '前の担当のメモ', 20);

      // codex-2 leaves the roster...
      setAgentInstances(db, WT, [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
      expect(getSessionNote(db, WT, 'codex-2')).toBeNull();

      // ...and a NEW instance claims the same id.
      setAgentInstances(db, WT, [
        { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
        { id: 'codex-2', cliTool: 'codex', alias: '新しい担当', order: 1 },
      ]);
      expect(getSessionNote(db, WT, 'codex-2')).toBeNull();
    });

    it('prunes every note when the roster is emptied', () => {
      setSessionNote(db, WT, 'claude', 'A');
      setSessionNote(db, WT, 'codex-2', 'B');

      setAgentInstances(db, WT, []);

      expect(getSessionNotesByWorktree(db, WT)).toEqual({});
    });

    it('never prunes another worktree’s notes', () => {
      setSessionNote(db, OTHER_WT, 'claude', 'untouched', 99);

      setAgentInstances(db, WT, []);

      expect(getSessionNote(db, OTHER_WT, 'claude')).toEqual({ text: 'untouched', updatedAt: 99 });
    });
  });

  describe('single-instance removal', () => {
    it('takes the note with the instance', () => {
      setSessionNote(db, WT, 'codex-2', 'レビュー中');
      setSessionNote(db, WT, 'codex-3', '調査中');

      expect(removeAgentInstance(db, WT, 'codex-2')).toBe(true);

      expect(getSessionNote(db, WT, 'codex-2')).toBeNull();
      expect(getSessionNote(db, WT, 'codex-3')).not.toBeNull();
    });

    it('leaves nothing behind for a re-added id', () => {
      setSessionNote(db, WT, 'codex-2', 'レビュー中');
      removeAgentInstance(db, WT, 'codex-2');
      addAgentInstance(db, WT, { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 });

      expect(getSessionNote(db, WT, 'codex-2')).toBeNull();
    });
  });

  describe('pruneSessionNotes', () => {
    it('reports how many rows it removed', () => {
      setSessionNote(db, WT, 'claude', 'A');
      setSessionNote(db, WT, 'codex-2', 'B');
      setSessionNote(db, WT, 'codex-3', 'C');

      expect(pruneSessionNotes(db, WT, ['claude'])).toBe(2);
      expect(pruneSessionNotes(db, WT, ['claude'])).toBe(0);
    });
  });
});
