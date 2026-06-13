/**
 * Unit tests for agent_instances DB operations (Issue #868).
 *
 * Verifies CRUD, ordering, alias fallback, and MAX_AGENT_INSTANCES cap
 * enforcement against a real (in-memory) migrated schema.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  getAgentInstances,
  getAgentInstance,
  countAgentInstances,
  setAgentInstances,
  addAgentInstance,
  removeAgentInstance,
  AgentInstanceLimitError,
  InvalidAgentInstanceError,
} from '@/lib/db/agent-instances-db';
import { MAX_AGENT_INSTANCES, type AgentInstance } from '@/lib/cli-tools/types';

const WT = 'wt-868';

function seedWorktree(db: Database.Database, id: string = WT): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, id, `/tmp/${id}`, 1700000000000);
}

function inst(overrides: Partial<AgentInstance> & Pick<AgentInstance, 'id' | 'cliTool'>): AgentInstance {
  return { alias: '', order: 0, ...overrides };
}

describe('agent-instances-db (Issue #868)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('setAgentInstances + getAgentInstances', () => {
    it('replaces the full set and reads it back ordered by sort_order', () => {
      setAgentInstances(db, WT, [
        inst({ id: 'claude', cliTool: 'claude', order: 0 }),
        inst({ id: 'claude-2', cliTool: 'claude', alias: 'Reviewer', order: 1 }),
        inst({ id: 'codex', cliTool: 'codex', order: 2 }),
      ]);

      const result = getAgentInstances(db, WT);
      expect(result.map(r => r.id)).toEqual(['claude', 'claude-2', 'codex']);
      expect(countAgentInstances(db, WT)).toBe(3);
    });

    it('falls back to the CLI tool display name when the alias is empty', () => {
      setAgentInstances(db, WT, [inst({ id: 'claude', cliTool: 'claude', order: 0 })]);
      const [primary] = getAgentInstances(db, WT);
      expect(primary.alias).toBe('Claude');
    });

    it('preserves an explicit alias', () => {
      setAgentInstances(db, WT, [
        inst({ id: 'claude-2', cliTool: 'claude', alias: 'Reviewer', order: 0 }),
      ]);
      const [a] = getAgentInstances(db, WT);
      expect(a.alias).toBe('Reviewer');
    });

    it('is a full replace (previous instances are removed)', () => {
      setAgentInstances(db, WT, [inst({ id: 'claude', cliTool: 'claude' })]);
      setAgentInstances(db, WT, [inst({ id: 'codex', cliTool: 'codex' })]);
      expect(getAgentInstances(db, WT).map(r => r.id)).toEqual(['codex']);
    });

    it('rejects a set that exceeds MAX_AGENT_INSTANCES', () => {
      const tooMany: AgentInstance[] = Array.from({ length: MAX_AGENT_INSTANCES + 1 }, (_, i) =>
        inst({ id: `claude-${i}`, cliTool: 'claude', order: i })
      );
      expect(() => setAgentInstances(db, WT, tooMany)).toThrow(AgentInstanceLimitError);
    });

    it('accepts exactly MAX_AGENT_INSTANCES', () => {
      const max: AgentInstance[] = Array.from({ length: MAX_AGENT_INSTANCES }, (_, i) =>
        inst({ id: `claude-${i}`, cliTool: 'claude', order: i })
      );
      expect(() => setAgentInstances(db, WT, max)).not.toThrow();
      expect(countAgentInstances(db, WT)).toBe(MAX_AGENT_INSTANCES);
    });

    it('rejects duplicate instance ids', () => {
      expect(() => setAgentInstances(db, WT, [
        inst({ id: 'claude', cliTool: 'claude' }),
        inst({ id: 'claude', cliTool: 'claude' }),
      ])).toThrow(InvalidAgentInstanceError);
    });

    it('rejects an invalid instance id', () => {
      expect(() => setAgentInstances(db, WT, [
        inst({ id: 'has space', cliTool: 'claude' }),
      ])).toThrow(InvalidAgentInstanceError);
    });

    it('rejects an invalid cli tool', () => {
      expect(() => setAgentInstances(db, WT, [
        inst({ id: 'nope', cliTool: 'not-a-tool' as never }),
      ])).toThrow(InvalidAgentInstanceError);
    });
  });

  describe('getAgentInstance', () => {
    it('returns a single instance by id, or null when missing', () => {
      setAgentInstances(db, WT, [inst({ id: 'claude-2', cliTool: 'claude', order: 0 })]);
      expect(getAgentInstance(db, WT, 'claude-2')?.cliTool).toBe('claude');
      expect(getAgentInstance(db, WT, 'missing')).toBeNull();
    });
  });

  describe('addAgentInstance', () => {
    it('adds a new instance', () => {
      setAgentInstances(db, WT, [inst({ id: 'claude', cliTool: 'claude', order: 0 })]);
      addAgentInstance(db, WT, inst({ id: 'claude-2', cliTool: 'claude', order: 1 }));
      expect(countAgentInstances(db, WT)).toBe(2);
    });

    it('rejects adding a duplicate id', () => {
      setAgentInstances(db, WT, [inst({ id: 'claude', cliTool: 'claude' })]);
      expect(() => addAgentInstance(db, WT, inst({ id: 'claude', cliTool: 'claude' })))
        .toThrow(InvalidAgentInstanceError);
    });

    it('rejects adding when already at the cap', () => {
      const max: AgentInstance[] = Array.from({ length: MAX_AGENT_INSTANCES }, (_, i) =>
        inst({ id: `claude-${i}`, cliTool: 'claude', order: i })
      );
      setAgentInstances(db, WT, max);
      expect(() => addAgentInstance(db, WT, inst({ id: 'one-too-many', cliTool: 'claude' })))
        .toThrow(AgentInstanceLimitError);
    });
  });

  describe('removeAgentInstance', () => {
    it('removes an instance and reports whether a row was deleted', () => {
      setAgentInstances(db, WT, [
        inst({ id: 'claude', cliTool: 'claude', order: 0 }),
        inst({ id: 'claude-2', cliTool: 'claude', order: 1 }),
      ]);
      expect(removeAgentInstance(db, WT, 'claude-2')).toBe(true);
      expect(removeAgentInstance(db, WT, 'claude-2')).toBe(false);
      expect(getAgentInstances(db, WT).map(r => r.id)).toEqual(['claude']);
    });
  });
});
