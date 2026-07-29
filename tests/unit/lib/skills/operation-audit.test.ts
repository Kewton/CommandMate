/**
 * Issue #1248: querying the append-only Skill operation log.
 *
 * The log is written once and read many ways, so the properties under test are
 * about reading: that every filter actually narrows, that the cursor walks the
 * feed without skipping or repeating a row when timestamps tie, and that the
 * version transition and redaction recorded at write time survive the round
 * trip.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  SKILL_AUDIT_MAX_LIMIT,
  buildSkillOperationAuditInput,
  getSkillOperationAuditByOperationId,
  listSkillOperationAudit,
  querySkillOperationAudit,
  recordSkillOperationAudit,
  type SkillOperationAuditInput,
  type SkillOperationAuditResult,
} from '@/lib/skills/operation-audit';
import type {
  SkillOperationJournalEntry,
  SkillOperationKind,
} from '@/lib/skills/operation-journal';

let db: Database.Database;

const T0 = 1_800_000_000_000;

function insertWorktree(id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, '/tmp/cm-1248/repo', 'repo')`
  ).run(id, id, `/tmp/cm-1248/repo/${id}`);
}

function auditInput(overrides: Partial<SkillOperationAuditInput> = {}): SkillOperationAuditInput {
  return {
    operationId: 'op-1',
    idempotencyKey: 'key-1',
    bindingHash: 'bind-1',
    operation: 'install',
    state: 'SUCCEEDED',
    result: 'succeeded',
    actorType: 'user',
    actorId: 'user-1',
    worktreeId: 'wt-1',
    skillId: 'demo-skill',
    skillVersion: '1.2.3',
    fromVersion: null,
    toVersion: '1.2.3',
    sourceOrigin: 'github-release',
    sourceRepository: 'Kewton/commandmate-skills',
    sourceRef: 'demo-skill-v1.2.3',
    sourceCommit: 'b'.repeat(40),
    artifactSha256: 'c'.repeat(64),
    errorCode: null,
    errorMessage: null,
    recordedAt: T0,
    ...overrides,
  };
}

function journalEntry(
  operation: SkillOperationKind,
  version: string | null
): SkillOperationJournalEntry {
  return {
    schemaVersion: 1,
    operationId: `op-${operation}`,
    idempotencyKey: `key-${operation}`,
    bindingHash: 'bind-1',
    operation,
    state: 'SUCCEEDED',
    actor: { type: 'cli', id: null },
    target: { worktreeId: 'wt-1', skillId: 'demo-skill', version },
    source: {
      origin: 'github-release',
      repository: 'Kewton/commandmate-skills',
      ref: 'demo-skill-v1.2.3',
      commit: 'b'.repeat(40),
      artifactSha256: 'c'.repeat(64),
    },
    lockKey: 'wt-1/demo-skill',
    createdAt: T0,
    updatedAt: T0,
    fsCommittedAt: T0,
    receiptDigest: 'd'.repeat(64),
    error: null,
  } as SkillOperationJournalEntry;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  insertWorktree('wt-1');
  insertWorktree('wt-2');
});

afterEach(() => {
  db.close();
});

describe('recording an audit event', () => {
  it('round-trips the source coordinates the dashboard traces an operation by', () => {
    const record = recordSkillOperationAudit(db, auditInput());
    const [stored] = getSkillOperationAuditByOperationId(db, 'op-1');

    expect(stored).toMatchObject({
      id: record.id,
      sourceOrigin: 'github-release',
      sourceRepository: 'Kewton/commandmate-skills',
      sourceRef: 'demo-skill-v1.2.3',
      sourceCommit: 'b'.repeat(40),
      artifactSha256: 'c'.repeat(64),
      result: 'succeeded',
    });
  });

  it('redacts on the way in, so a signed URL never reaches the table', () => {
    recordSkillOperationAudit(
      db,
      auditInput({
        result: 'failed',
        errorCode: 'SKILL_DOWNLOAD_FAILED',
        errorMessage:
          'GET https://example.com/a.tar.gz?X-Amz-Signature=deadbeef failed for /Users/someone/repo',
      })
    );

    const [stored] = getSkillOperationAuditByOperationId(db, 'op-1');
    const raw = db.prepare('SELECT error_message FROM skill_operations').get() as {
      error_message: string;
    };

    expect(stored.errorMessage).not.toContain('X-Amz-Signature');
    expect(stored.errorMessage).not.toContain('/Users/someone');
    expect(raw.error_message).not.toContain('X-Amz-Signature');
    expect(raw.error_message).not.toContain('/Users/someone');
    expect(stored.errorCode).toBe('SKILL_DOWNLOAD_FAILED');
  });

  it('derives the version transition from the journal for an install', () => {
    const input = buildSkillOperationAuditInput(journalEntry('install', '1.2.3'), 'succeeded', T0);
    expect(input.fromVersion).toBeNull();
    expect(input.toVersion).toBe('1.2.3');
  });

  it('derives the version transition from the journal for an uninstall', () => {
    const input = buildSkillOperationAuditInput(journalEntry('uninstall', '1.2.3'), 'succeeded', T0);
    expect(input.fromVersion).toBe('1.2.3');
    expect(input.toVersion).toBeNull();
  });
});

describe('querying the log', () => {
  beforeEach(() => {
    const rows: Array<Partial<SkillOperationAuditInput>> = [
      { operationId: 'op-a', worktreeId: 'wt-1', skillId: 'alpha', recordedAt: T0 + 1 },
      {
        operationId: 'op-b',
        worktreeId: 'wt-1',
        skillId: 'beta',
        operation: 'uninstall',
        fromVersion: '1.2.3',
        toVersion: null,
        recordedAt: T0 + 2,
      },
      {
        operationId: 'op-c',
        worktreeId: 'wt-2',
        skillId: 'alpha',
        result: 'failed',
        errorCode: 'SKILL_INSTALL_CONFLICT',
        errorMessage: 'destination exists',
        recordedAt: T0 + 3,
      },
      {
        operationId: 'op-d',
        worktreeId: 'wt-2',
        skillId: 'gamma',
        result: 'reconciled',
        recordedAt: T0 + 4,
      },
    ];
    for (const row of rows) recordSkillOperationAudit(db, auditInput(row));
  });

  it('reads across every worktree when none is named', () => {
    const page = querySkillOperationAudit(db);
    expect(page.records.map((r) => r.operationId)).toEqual(['op-d', 'op-c', 'op-b', 'op-a']);
  });

  it('narrows by worktree', () => {
    const page = querySkillOperationAudit(db, { worktreeId: 'wt-1' });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-b', 'op-a']);
  });

  it('narrows by skill', () => {
    const page = querySkillOperationAudit(db, { skillId: 'alpha' });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-c', 'op-a']);
  });

  it('narrows by operation kind', () => {
    const page = querySkillOperationAudit(db, { operation: 'uninstall' });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-b']);
  });

  it('narrows by result, which is how the dashboard surfaces errors', () => {
    const page = querySkillOperationAudit(db, { result: 'failed' });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-c']);
    expect(page.records[0].errorCode).toBe('SKILL_INSTALL_CONFLICT');
  });

  it('narrows by time window, with since inclusive and until exclusive', () => {
    const page = querySkillOperationAudit(db, { since: T0 + 2, until: T0 + 4 });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-c', 'op-b']);
  });

  it('combines filters conjunctively', () => {
    const page = querySkillOperationAudit(db, { worktreeId: 'wt-2', skillId: 'alpha' });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-c']);
  });

  it('reports hasMore and a cursor when the page is full', () => {
    const page = querySkillOperationAudit(db, { limit: 2 });
    expect(page.records.map((r) => r.operationId)).toEqual(['op-d', 'op-c']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ recordedAt: T0 + 3, id: page.records[1].id });
  });

  it('walks to the end without skipping or repeating a row', () => {
    const seen: string[] = [];
    let cursor = querySkillOperationAudit(db, { limit: 2 });
    seen.push(...cursor.records.map((r) => r.operationId));
    while (cursor.nextCursor) {
      cursor = querySkillOperationAudit(db, { limit: 2, after: cursor.nextCursor });
      seen.push(...cursor.records.map((r) => r.operationId));
    }
    expect(seen).toEqual(['op-d', 'op-c', 'op-b', 'op-a']);
    expect(cursor.hasMore).toBe(false);
    expect(cursor.nextCursor).toBeNull();
  });

  it('clamps an oversized limit instead of serving the whole log', () => {
    const page = querySkillOperationAudit(db, { limit: 10_000 });
    expect(page.records).toHaveLength(4);
    expect(SKILL_AUDIT_MAX_LIMIT).toBeLessThan(10_000);
  });
});

describe('cursor paging over tied timestamps', () => {
  it('does not skip or repeat rows recorded in the same millisecond', () => {
    for (let i = 0; i < 6; i += 1) {
      recordSkillOperationAudit(db, auditInput({ operationId: `op-${i}`, recordedAt: T0 }));
    }

    const seen: string[] = [];
    let page = querySkillOperationAudit(db, { limit: 2 });
    seen.push(...page.records.map((r) => r.id));
    while (page.nextCursor) {
      page = querySkillOperationAudit(db, { limit: 2, after: page.nextCursor });
      seen.push(...page.records.map((r) => r.id));
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });
});

describe('listSkillOperationAudit compatibility', () => {
  it('still reads one worktree newest-first', () => {
    recordSkillOperationAudit(db, auditInput({ operationId: 'op-old', recordedAt: T0 }));
    recordSkillOperationAudit(db, auditInput({ operationId: 'op-new', recordedAt: T0 + 5 }));
    recordSkillOperationAudit(
      db,
      auditInput({ operationId: 'op-other', worktreeId: 'wt-2', recordedAt: T0 + 9 })
    );

    const records = listSkillOperationAudit(db, { worktreeId: 'wt-1' });
    expect(records.map((r) => r.operationId)).toEqual(['op-new', 'op-old']);
  });

  it('honours its skill filter and limit', () => {
    const results: SkillOperationAuditResult[] = ['succeeded', 'failed', 'reconciled'];
    results.forEach((result, i) => {
      recordSkillOperationAudit(
        db,
        auditInput({ operationId: `op-${i}`, result, recordedAt: T0 + i })
      );
    });

    expect(listSkillOperationAudit(db, { worktreeId: 'wt-1', limit: 2 })).toHaveLength(2);
    expect(listSkillOperationAudit(db, { worktreeId: 'wt-1', skillId: 'nope' })).toHaveLength(0);
  });
});
