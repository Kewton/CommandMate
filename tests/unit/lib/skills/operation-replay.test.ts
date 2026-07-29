/**
 * Issue #1552: a recorded outcome may only be replayed while it is still true.
 *
 * The derived idempotency key is a function of the binding alone, so the install
 * that follows an uninstall arrives under the key of the install before it.
 * These cases pin the precondition that tells the two apart.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SKILL_RECEIPT_FILENAME } from '@/lib/skills/install-plan';
import {
  mayReplaySkillInstall,
  mayReplaySkillUninstall,
  readInstalledSkillReceiptDigest,
} from '@/lib/skills/operation-replay';
import type {
  SkillOperationJournalEntry,
  SkillOperationState,
} from '@/lib/skills/operation-journal';

const SKILL_ID = 'demo-skill';
const RECEIPT_BYTES = '{"schema_version":1,"skill_id":"demo-skill"}\n';
const RECEIPT_DIGEST = createHash('sha256').update(RECEIPT_BYTES).digest('hex');

let worktreeDir: string;

function writeReceipt(bytes = RECEIPT_BYTES): void {
  const root = join(worktreeDir, '.agents', 'skills', SKILL_ID);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, SKILL_RECEIPT_FILENAME), bytes);
}

function makeEntry(
  overrides: Partial<SkillOperationJournalEntry> & { state: SkillOperationState }
): SkillOperationJournalEntry {
  return {
    schemaVersion: 1,
    operationId: 'op-1',
    idempotencyKey: 'k'.repeat(64),
    bindingHash: 'b'.repeat(64),
    operation: 'install',
    actor: { type: 'cli', id: null },
    target: { worktreeId: 'wt-1', skillId: SKILL_ID, version: '1.2.3' },
    source: null,
    lockKey: 'lock-key',
    createdAt: 1,
    updatedAt: 2,
    fsCommittedAt: 2,
    receiptDigest: RECEIPT_DIGEST,
    error: null,
    history: [],
    ...overrides,
  };
}

beforeEach(() => {
  worktreeDir = mkdtempSync(join(tmpdir(), 'cm-replay-wt-'));
});

afterEach(() => {
  rmSync(worktreeDir, { recursive: true, force: true });
});

describe('readInstalledSkillReceiptDigest', () => {
  it('digests the receipt at the primary install root', () => {
    writeReceipt();

    expect(readInstalledSkillReceiptDigest(worktreeDir, SKILL_ID)).toBe(RECEIPT_DIGEST);
  });

  it('answers null when there is no receipt to read', () => {
    expect(readInstalledSkillReceiptDigest(worktreeDir, SKILL_ID)).toBeNull();
  });

  it('answers null for a Skill ID that does not resolve inside the worktree', () => {
    writeReceipt();

    expect(readInstalledSkillReceiptDigest(worktreeDir, '../../etc')).toBeNull();
  });
});

describe('mayReplaySkillInstall', () => {
  it('replays a committed install whose receipt is still on disk', () => {
    writeReceipt();

    expect(mayReplaySkillInstall(makeEntry({ state: 'SUCCEEDED' }), worktreeDir, SKILL_ID)).toBe(
      true
    );
  });

  it('refuses to replay a committed install whose payload was uninstalled', () => {
    expect(mayReplaySkillInstall(makeEntry({ state: 'SUCCEEDED' }), worktreeDir, SKILL_ID)).toBe(
      false
    );
  });

  it('refuses to replay when the receipt on disk is not the one recorded', () => {
    writeReceipt('{"schema_version":1,"skill_id":"demo-skill","version":"9.9.9"}\n');

    expect(mayReplaySkillInstall(makeEntry({ state: 'SUCCEEDED' }), worktreeDir, SKILL_ID)).toBe(
      false
    );
  });

  it('falls back to existence for an entry that recorded no receipt digest', () => {
    writeReceipt();

    expect(
      mayReplaySkillInstall(
        makeEntry({ state: 'SUCCEEDED', receiptDigest: null }),
        worktreeDir,
        SKILL_ID
      )
    ).toBe(true);
  });

  it('still refuses a committed reconciling install once its payload is gone', () => {
    // The payload-on-disk claim is what is being checked, not the final state.
    expect(
      mayReplaySkillInstall(
        makeEntry({ state: 'FAILED_RECONCILABLE' }),
        worktreeDir,
        SKILL_ID
      )
    ).toBe(false);
  });

  it('leaves an operation that never committed to answer for itself', () => {
    // PREPARING and a rolled-back failure have no on-disk claim to check; they
    // are answered as in-progress / failed exactly as before.
    for (const state of ['PREPARING', 'FAILED_RECONCILABLE'] as const) {
      expect(
        mayReplaySkillInstall(makeEntry({ state, fsCommittedAt: null }), worktreeDir, SKILL_ID)
      ).toBe(true);
    }
  });
});

describe('mayReplaySkillUninstall', () => {
  it('replays a committed uninstall while the payload is still gone', () => {
    expect(
      mayReplaySkillUninstall(
        makeEntry({ state: 'SUCCEEDED', operation: 'uninstall' }),
        worktreeDir,
        SKILL_ID
      )
    ).toBe(true);
  });

  it('refuses to replay once the Skill has been installed again', () => {
    writeReceipt();

    expect(
      mayReplaySkillUninstall(
        makeEntry({ state: 'SUCCEEDED', operation: 'uninstall' }),
        worktreeDir,
        SKILL_ID
      )
    ).toBe(false);
  });

  it('leaves an operation that never committed to answer for itself', () => {
    writeReceipt();

    expect(
      mayReplaySkillUninstall(
        makeEntry({ state: 'PREPARING', operation: 'uninstall', fsCommittedAt: null }),
        worktreeDir,
        SKILL_ID
      )
    ).toBe(true);
  });
});
