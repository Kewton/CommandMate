/**
 * Storing what each opencode instance launches with (Issue #2048).
 *
 * The table exists as its own table for one reason and this file is where that
 * reason is a test rather than a comment: `PATCH /api/worktrees/:id` sends the
 * **whole roster** and `setAgentInstances` implements that as a delete-and-
 * reinsert. A `model` column on `agent_instances` would therefore be wiped every
 * time somebody renamed an instance or dragged one up the list. The rename case
 * below is the guard.
 *
 * The other half is the opposite: an instance that genuinely leaves the roster
 * must NOT leave its settings behind, or the next instance to claim that id
 * inherits a model nobody chose for it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  getAgentInstances,
  getOpencodeInstanceSettings,
  getOpencodeInstanceSettingsByWorktree,
  removeAgentInstance,
  setAgentInstances,
  setOpencodeInstanceSettings,
  InvalidAgentInstanceError,
} from '@/lib/db/agent-instances-db';
import { EMPTY_OPENCODE_INSTANCE_SETTINGS } from '@/types/opencode-instance-settings';
import type { AgentInstance } from '@/lib/cli-tools/types';

const WT = 'wt-2048';

const FULL = {
  agent: 'plan',
  providerId: 'github-copilot',
  modelId: 'claude-sonnet-4.6',
  variant: 'high',
};

function seedWorktree(db: Database.Database, id: string = WT): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)
  `).run(id, id, `/tmp/${id}`, 1700000000000);
}

function inst(id: string, cliTool: AgentInstance['cliTool'], order: number, alias = ''): AgentInstance {
  return { id, cliTool, alias, order };
}

describe('opencode instance settings (Issue #2048)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(db);
    setAgentInstances(db, WT, [
      inst('opencode', 'opencode', 0),
      inst('opencode-2', 'opencode', 1),
      inst('claude', 'claude', 2),
    ]);
  });

  afterEach(() => {
    db.close();
  });

  it('answers all-unset for an instance nobody configured', () => {
    expect(getOpencodeInstanceSettings(db, WT, 'opencode')).toEqual(
      EMPTY_OPENCODE_INSTANCE_SETTINGS
    );
  });

  it('round-trips a full setting', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
    expect(getOpencodeInstanceSettings(db, WT, 'opencode')).toEqual(FULL);
  });

  it('keeps two instances of the same tool apart', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
    setOpencodeInstanceSettings(db, WT, 'opencode-2', {
      ...EMPTY_OPENCODE_INSTANCE_SETTINGS,
      agent: 'build',
    });
    expect(getOpencodeInstanceSettingsByWorktree(db, WT)).toEqual({
      opencode: FULL,
      'opencode-2': { ...EMPTY_OPENCODE_INSTANCE_SETTINGS, agent: 'build' },
    });
  });

  it('overwrites rather than duplicating on a second write', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
    setOpencodeInstanceSettings(db, WT, 'opencode', { ...FULL, variant: 'max' });
    expect(getOpencodeInstanceSettings(db, WT, 'opencode').variant).toBe('max');
    expect(Object.keys(getOpencodeInstanceSettingsByWorktree(db, WT))).toEqual(['opencode']);
  });

  it('deletes the row when everything is unset, instead of storing four nulls', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
    setOpencodeInstanceSettings(db, WT, 'opencode', EMPTY_OPENCODE_INSTANCE_SETTINGS);
    expect(getOpencodeInstanceSettingsByWorktree(db, WT)).toEqual({});
  });

  it('validates on the way in — an unusable value is stored as null', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode', {
      ...FULL,
      agent: '$(touch /tmp/pwned-2048)',
    });
    expect(getOpencodeInstanceSettings(db, WT, 'opencode').agent).toBeNull();
  });

  it('re-validates on the way out, so a row written by a looser build cannot escape', () => {
    db.prepare(`
      INSERT INTO opencode_instance_settings
        (worktree_id, instance_id, agent, provider_id, model_id, variant, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(WT, 'opencode', 'plan; rm -rf /', 'github-copilot', 'claude-sonnet-4.6', 'high', 1);
    expect(getOpencodeInstanceSettings(db, WT, 'opencode')).toEqual({
      agent: null,
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: 'high',
    });
  });

  it('refuses an instance id the roster could never hold', () => {
    expect(() => setOpencodeInstanceSettings(db, WT, '../etc/passwd', FULL)).toThrow(
      InvalidAgentInstanceError
    );
  });

  describe('the roster replace', () => {
    it('SURVIVES a rename / reorder — the whole reason this is a separate table', () => {
      setOpencodeInstanceSettings(db, WT, 'opencode', FULL);

      // Exactly what AgentInstancesPane sends when an alias is edited.
      setAgentInstances(db, WT, [
        inst('claude', 'claude', 0),
        inst('opencode', 'opencode', 1, 'Reviewer'),
        inst('opencode-2', 'opencode', 2),
      ]);

      expect(getAgentInstances(db, WT).map((i) => i.id)).toEqual([
        'claude',
        'opencode',
        'opencode-2',
      ]);
      expect(getOpencodeInstanceSettings(db, WT, 'opencode')).toEqual(FULL);
    });

    it('drops the settings of an instance that left the roster', () => {
      setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
      setOpencodeInstanceSettings(db, WT, 'opencode-2', {
        ...EMPTY_OPENCODE_INSTANCE_SETTINGS,
        agent: 'build',
      });

      setAgentInstances(db, WT, [inst('opencode', 'opencode', 0), inst('claude', 'claude', 1)]);

      expect(getOpencodeInstanceSettings(db, WT, 'opencode')).toEqual(FULL);
      expect(getOpencodeInstanceSettings(db, WT, 'opencode-2')).toEqual(
        EMPTY_OPENCODE_INSTANCE_SETTINGS
      );
    });
  });

  it('drops the settings when the instance is removed one at a time', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode-2', FULL);
    expect(removeAgentInstance(db, WT, 'opencode-2')).toBe(true);
    expect(getOpencodeInstanceSettings(db, WT, 'opencode-2')).toEqual(
      EMPTY_OPENCODE_INSTANCE_SETTINGS
    );
  });

  it('is swept with the worktree it belongs to', () => {
    setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(WT);
    expect(getOpencodeInstanceSettingsByWorktree(db, WT)).toEqual({});
  });

  it('keeps two worktrees apart', () => {
    seedWorktree(db, 'wt-other');
    setOpencodeInstanceSettings(db, WT, 'opencode', FULL);
    expect(getOpencodeInstanceSettingsByWorktree(db, 'wt-other')).toEqual({});
  });
});
