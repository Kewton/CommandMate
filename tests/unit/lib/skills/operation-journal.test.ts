/**
 * Issue #1234: operation journal, state machine and idempotency binding.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SkillOperationTransitionError,
  beginSkillOperation,
  computeSkillOperationBindingHash,
  deleteSkillOperationJournal,
  deriveSkillOperationIdempotencyKey,
  hasSkillFilesystemCommit,
  isSkillOperationTerminal,
  listSkillOperationJournal,
  pruneExpiredSkillOperationJournal,
  readSkillOperationJournal,
  transitionSkillOperation,
  type SkillOperationBinding,
} from '@/lib/skills/operation-journal';
import { SKILL_JOURNAL_DIRNAME } from '@/lib/skills/operation-store';

let root: string;
const T0 = 1_800_000_000_000;

const BINDING: SkillOperationBinding = {
  actor: { type: 'user', id: 'user-1' },
  operation: 'install',
  target: { worktreeId: 'wt-1', skillId: 'demo-skill', version: '1.2.3' },
  planHash: 'a'.repeat(64),
};

const SOURCE = {
  origin: 'github-release',
  repository: 'Kewton/commandmate-skills',
  ref: 'demo-skill-v1.2.3',
  commit: 'b'.repeat(40),
  artifactSha256: 'c'.repeat(64),
};

function begin(overrides: Partial<Parameters<typeof beginSkillOperation>[0]> = {}) {
  return beginSkillOperation(
    { binding: BINDING, lockKey: 'lock-key', source: SOURCE, ...overrides },
    { root, now: T0 }
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-skill-journal-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('idempotency binding', () => {
  it('binds the key to actor, operation, target and plan', () => {
    const base = computeSkillOperationBindingHash(BINDING);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeSkillOperationBindingHash({ ...BINDING, actor: { type: 'user', id: 'user-2' } })
    ).not.toBe(base);
    expect(computeSkillOperationBindingHash({ ...BINDING, planHash: 'd'.repeat(64) })).not.toBe(
      base
    );
    expect(
      computeSkillOperationBindingHash({
        ...BINDING,
        target: { ...BINDING.target, version: '1.2.4' },
      })
    ).not.toBe(base);
  });

  it('is insensitive to key order in the binding object', () => {
    const reordered: SkillOperationBinding = {
      planHash: BINDING.planHash,
      target: {
        version: BINDING.target.version,
        skillId: BINDING.target.skillId,
        worktreeId: BINDING.target.worktreeId,
      },
      operation: BINDING.operation,
      actor: { id: BINDING.actor.id, type: BINDING.actor.type },
    };
    expect(computeSkillOperationBindingHash(reordered)).toBe(
      computeSkillOperationBindingHash(BINDING)
    );
  });

  it('derives a key that collapses identical requests onto one operation', () => {
    const key = deriveSkillOperationIdempotencyKey(BINDING);
    const first = begin({ idempotencyKey: key });
    const second = begin({ idempotencyKey: key });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.entry.operationId).toBe(first.entry.operationId);
  });
});

describe('beginSkillOperation', () => {
  it('opens a PREPARING entry', () => {
    const result = begin();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replayed).toBe(false);
    expect(result.entry.state).toBe('PREPARING');
    expect(result.entry.fsCommittedAt).toBeNull();
    expect(result.entry.history).toEqual([{ state: 'PREPARING', at: T0 }]);
  });

  it('replays instead of starting a second operation for the same key', () => {
    const first = begin({ idempotencyKey: 'client-key-1' });
    const replay = begin({ idempotencyKey: 'client-key-1' });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    expect(replay.replayed).toBe(true);
    expect(listSkillOperationJournal({ root })).toHaveLength(1);
  });

  it('replays a finished operation with its recorded outcome', () => {
    const first = begin({ idempotencyKey: 'client-key-1' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let entry = transitionSkillOperation(first.entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 + 2 });
    transitionSkillOperation(entry, 'SUCCEEDED', {}, { root, now: T0 + 3 });

    const replay = begin({ idempotencyKey: 'client-key-1' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.entry.state).toBe('SUCCEEDED');
  });

  it('rejects the same key bound to a different plan', () => {
    begin({ idempotencyKey: 'client-key-1' });
    const conflicting = beginSkillOperation(
      {
        idempotencyKey: 'client-key-1',
        binding: { ...BINDING, planHash: 'e'.repeat(64) },
        lockKey: 'lock-key',
      },
      { root, now: T0 + 5 }
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.reason).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('rejects the same key replayed by a different actor', () => {
    begin({ idempotencyKey: 'client-key-1' });
    const other = beginSkillOperation(
      {
        idempotencyKey: 'client-key-1',
        binding: { ...BINDING, actor: { type: 'user', id: 'someone-else' } },
        lockKey: 'lock-key',
      },
      { root, now: T0 + 5 }
    );
    expect(other.ok).toBe(false);
  });

  it('hashes the idempotency key into the filename', () => {
    begin({ idempotencyKey: '../../escape attempt' });
    const files = readdirSync(join(root, SKILL_JOURNAL_DIRNAME));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });
});

describe('state machine', () => {
  it('follows the happy path', () => {
    const started = begin();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let entry = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: T0 + 10 });
    expect(entry.fsCommittedAt).toBe(T0 + 10);
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 + 20 });
    entry = transitionSkillOperation(entry, 'SUCCEEDED', {}, { root, now: T0 + 30 });

    expect(entry.state).toBe('SUCCEEDED');
    expect(entry.history.map((h) => h.state)).toEqual([
      'PREPARING',
      'FS_COMMITTED',
      'INDEXED',
      'SUCCEEDED',
    ]);
    expect(readSkillOperationJournal(entry.idempotencyKey, { root })?.state).toBe('SUCCEEDED');
  });

  it('refuses an undefined edge', () => {
    const started = begin();
    if (!started.ok) return;
    expect(() => transitionSkillOperation(started.entry, 'INDEXED', {}, { root })).toThrow(
      SkillOperationTransitionError
    );
  });

  it('refuses to leave a terminal SUCCEEDED', () => {
    const started = begin();
    if (!started.ok) return;
    let entry = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 + 2 });
    entry = transitionSkillOperation(entry, 'SUCCEEDED', {}, { root, now: T0 + 3 });
    expect(() =>
      transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {}, { root, now: T0 + 4 })
    ).toThrow(SkillOperationTransitionError);
  });

  it('never reports success for an operation that has no commit point', () => {
    // A pre-commit failure was genuinely rolled back; converging it to
    // SUCCEEDED would claim an install that does not exist on disk.
    const started = begin();
    if (!started.ok) return;
    const failed = transitionSkillOperation(
      started.entry,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_DOWNLOAD_FAILED', message: 'connection reset' } },
      { root, now: T0 + 5 }
    );
    expect(hasSkillFilesystemCommit(failed)).toBe(false);
    expect(isSkillOperationTerminal(failed)).toBe(true);
    expect(() => transitionSkillOperation(failed, 'SUCCEEDED', {}, { root })).toThrow(
      /no filesystem commit point/
    );
  });

  it('allows forward recovery once the commit point was recorded', () => {
    const started = begin();
    if (!started.ok) return;
    let entry = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    entry = transitionSkillOperation(
      entry,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_INDEX_FAILED', message: 'database is locked' } },
      { root, now: T0 + 2 }
    );
    expect(isSkillOperationTerminal(entry)).toBe(false);

    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 + 3 });
    entry = transitionSkillOperation(entry, 'SUCCEEDED', { error: null }, { root, now: T0 + 4 });
    expect(entry.state).toBe('SUCCEEDED');
    expect(entry.error).toBeNull();
    expect(entry.fsCommittedAt).toBe(T0 + 1);
  });

  it('preserves the original commit timestamp across a re-commit', () => {
    const started = begin();
    if (!started.ok) return;
    let entry = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    entry = transitionSkillOperation(entry, 'FAILED_RECONCILABLE', {}, { root, now: T0 + 2 });
    expect(entry.fsCommittedAt).toBe(T0 + 1);
  });
});

describe('journal content is safe to persist', () => {
  it('redacts error messages on the way in', () => {
    const started = begin();
    if (!started.ok) return;
    const failed = transitionSkillOperation(
      started.entry,
      'FAILED_RECONCILABLE',
      {
        error: {
          code: 'SKILL_DOWNLOAD_FAILED',
          message: 'GET https://objects.example.com/a.tar.gz?token=super-secret failed',
        },
      },
      { root, now: T0 + 1 }
    );
    expect(failed.error?.message).not.toContain('super-secret');

    const raw = readFileSync(
      join(root, SKILL_JOURNAL_DIRNAME, readdirSync(join(root, SKILL_JOURNAL_DIRNAME))[0]),
      'utf-8'
    );
    expect(raw).not.toContain('super-secret');
  });

  it('lists entries oldest first and collects them on request', () => {
    begin({ idempotencyKey: 'k1' });
    beginSkillOperation(
      { binding: { ...BINDING, planHash: 'f'.repeat(64) }, lockKey: 'lock-key' },
      { root, now: T0 + 100 }
    );
    expect(listSkillOperationJournal({ root }).map((e) => e.createdAt)).toEqual([T0, T0 + 100]);

    deleteSkillOperationJournal('k1', { root });
    expect(listSkillOperationJournal({ root })).toHaveLength(1);
  });

  it('ignores unparseable journal files rather than failing the scan', () => {
    begin({ idempotencyKey: 'k1' });
    writeFileSync(join(root, SKILL_JOURNAL_DIRNAME, 'garbage.json'), 'not json');
    expect(listSkillOperationJournal({ root })).toHaveLength(1);
  });
});

describe('retention', () => {
  function succeed(key: string, at: number): void {
    const started = begin({ idempotencyKey: key });
    if (!started.ok) throw new Error('seed failed');
    let entry = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: at });
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: at });
    transitionSkillOperation(entry, 'SUCCEEDED', {}, { root, now: at });
  }

  it('collects terminal entries past the window and returns their keys', () => {
    succeed('old', T0);
    const pruned = pruneExpiredSkillOperationJournal({ root, now: T0 + 1_001, retentionMs: 1_000 });
    expect(pruned).toEqual(['old']);
    expect(readSkillOperationJournal('old', { root })).toBeNull();
  });

  it('keeps a terminal entry that is still inside the window', () => {
    succeed('recent', T0);
    const pruned = pruneExpiredSkillOperationJournal({ root, now: T0 + 999, retentionMs: 1_000 });
    expect(pruned).toEqual([]);
    expect(readSkillOperationJournal('recent', { root })?.state).toBe('SUCCEEDED');
  });

  it('never collects a FAILED_RECONCILABLE that still owes an index write', () => {
    // Committed to the filesystem, then the DB write failed: non-terminal, the
    // reconciler must still converge it, so retention must not delete it however
    // old it is.
    const started = begin({ idempotencyKey: 'committed-failure' });
    if (!started.ok) throw new Error('seed failed');
    const committed = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: T0 });
    const stalled = transitionSkillOperation(
      committed,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_INDEX_FAILED', message: 'locked' } },
      { root, now: T0 }
    );
    expect(isSkillOperationTerminal(stalled)).toBe(false);

    const pruned = pruneExpiredSkillOperationJournal({ root, now: T0 + 10_000_000, retentionMs: 1_000 });
    expect(pruned).toEqual([]);
    expect(readSkillOperationJournal('committed-failure', { root })?.state).toBe('FAILED_RECONCILABLE');
  });

  it('collects a pre-commit rollback once it is past the window', () => {
    const started = begin({ idempotencyKey: 'rolled-back' });
    if (!started.ok) throw new Error('seed failed');
    const failed = transitionSkillOperation(
      started.entry,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_DOWNLOAD_FAILED', message: 'reset' } },
      { root, now: T0 }
    );
    expect(isSkillOperationTerminal(failed)).toBe(true);

    const pruned = pruneExpiredSkillOperationJournal({ root, now: T0 + 2_000, retentionMs: 1_000 });
    expect(pruned).toEqual(['rolled-back']);
  });
});
