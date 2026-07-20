/**
 * Issue #1235: the installed-Skill index and the exclusive-write guard.
 *
 * The index is written after the commit point, so the property that matters is
 * that writing it twice is indistinguishable from writing it once —
 * reconciliation replays it without knowing whether an earlier attempt got that
 * far.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  deleteSkillInstallation,
  getSkillInstallation,
  listSkillInstallations,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import {
  SKILL_INSTALL_EXECUTABLE_MODE,
  SKILL_INSTALL_FILE_MODE,
  SkillInstallErrorCode,
  isSkillInstallError,
  writeSkillPayloadFile,
} from '@/lib/skills/install-apply';
import type { SkillInstallReceipt } from '@/types/skills';

let db: Database.Database;
let dir: string;

const T0 = 1_800_000_000_000;

function makeReceipt(overrides: Partial<SkillInstallReceipt> = {}): SkillInstallReceipt {
  return {
    schema_version: 1,
    skill_id: 'demo-skill',
    version: '1.2.3',
    install_root: '.agents/skills/demo-skill',
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: 'demo-skill-v1.2.3',
      commit: 'b'.repeat(40),
    },
    artifact: {
      asset_name: 'demo-skill-1.2.3.tar.gz',
      sha256: 'c'.repeat(64),
      size: 2048,
      format: 'tar.gz',
    },
    files: [],
    declared_risk: 'low',
    computed_risk: 'low',
    effective_risk: 'low',
    declared_permissions: [],
    agent_compatibility: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  dir = mkdtempSync(path.join(tmpdir(), 'cm-installed-state-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('skill_installations index', () => {
  it('records the install the receipt describes', () => {
    const record = upsertSkillInstallation(db, {
      worktreeId: 'wt-1',
      receipt: makeReceipt(),
      receiptSha256: 'd'.repeat(64),
      operationId: 'op-1',
      installedAt: T0,
    });

    expect(record).toMatchObject({
      worktreeId: 'wt-1',
      skillId: 'demo-skill',
      version: '1.2.3',
      installRoot: '.agents/skills/demo-skill',
      receiptSha256: 'd'.repeat(64),
      sourceCommit: 'b'.repeat(40),
      effectiveRisk: 'low',
      installedAt: T0,
    });
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).toEqual(record);
  });

  it('is idempotent, so reconciliation may replay it', () => {
    const input = {
      worktreeId: 'wt-1',
      receipt: makeReceipt(),
      receiptSha256: 'd'.repeat(64),
      operationId: 'op-1',
      installedAt: T0,
    };

    const first = upsertSkillInstallation(db, input);
    const second = upsertSkillInstallation(db, { ...input, installedAt: T0 + 60_000 });

    expect(listSkillInstallations(db, 'wt-1')).toHaveLength(1);
    expect(second.id).toBe(first.id);
    // The original commit time survives a later convergence.
    expect(second.installedAt).toBe(T0);
    expect(second.updatedAt).toBe(T0 + 60_000);
  });

  it('keeps one row per (worktree, skill) pair', () => {
    upsertSkillInstallation(db, {
      worktreeId: 'wt-1',
      receipt: makeReceipt(),
      receiptSha256: 'd'.repeat(64),
      operationId: 'op-1',
      installedAt: T0,
    });
    upsertSkillInstallation(db, {
      worktreeId: 'wt-2',
      receipt: makeReceipt(),
      receiptSha256: 'd'.repeat(64),
      operationId: 'op-2',
      installedAt: T0,
    });
    upsertSkillInstallation(db, {
      worktreeId: 'wt-1',
      receipt: makeReceipt({ skill_id: 'other-skill' }),
      receiptSha256: 'e'.repeat(64),
      operationId: 'op-3',
      installedAt: T0,
    });

    expect(listSkillInstallations(db, 'wt-1').map((row) => row.skillId)).toEqual([
      'demo-skill',
      'other-skill',
    ]);
    expect(listSkillInstallations(db, 'wt-2')).toHaveLength(1);
  });

  it('removes only the row it was asked to remove', () => {
    upsertSkillInstallation(db, {
      worktreeId: 'wt-1',
      receipt: makeReceipt(),
      receiptSha256: 'd'.repeat(64),
      operationId: 'op-1',
      installedAt: T0,
    });

    expect(deleteSkillInstallation(db, 'wt-1', 'demo-skill')).toBe(true);
    expect(deleteSkillInstallation(db, 'wt-1', 'demo-skill')).toBe(false);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).toBeNull();
  });
});

describe('writeSkillPayloadFile', () => {
  function expectRejection(run: () => unknown, code: string): void {
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    expect(isSkillInstallError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(code);
  }

  it('creates the file itself and verifies mode and digest afterwards', () => {
    const target = path.join(dir, 'payload.md');

    writeSkillPayloadFile(target, Buffer.from('hello\n'), false);

    expect(readFileSync(target).toString()).toBe('hello\n');
    expect(lstatSync(target).mode & 0o777).toBe(SKILL_INSTALL_FILE_MODE);
  });

  it('adds the owner execute bit only for a declared executable', () => {
    const target = path.join(dir, 'run.sh');

    writeSkillPayloadFile(target, Buffer.from('#!/bin/sh\n'), true);

    expect(lstatSync(target).mode & 0o777).toBe(SKILL_INSTALL_EXECUTABLE_MODE);
  });

  it('refuses to write over an existing file', () => {
    const target = path.join(dir, 'payload.md');
    writeFileSync(target, 'already here\n');

    expectRejection(
      () => writeSkillPayloadFile(target, Buffer.from('replacement\n'), false),
      SkillInstallErrorCode.STAGING_IO
    );
    expect(readFileSync(target).toString()).toBe('already here\n');
  });

  it('refuses to write through a symlink instead of following it', () => {
    const outside = path.join(dir, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    const target = path.join(dir, 'payload.md');
    symlinkSync(outside, target);

    expectRejection(
      () => writeSkillPayloadFile(target, Buffer.from('payload\n'), false),
      SkillInstallErrorCode.STAGING_IO
    );
    expect(readFileSync(outside).toString()).toBe('untouched\n');
  });

  it('refuses to write through a symlink that points outside the directory tree', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'cm-installed-outside-'));
    try {
      const outside = path.join(outsideDir, 'escape.txt');
      writeFileSync(outside, 'untouched\n');
      const target = path.join(dir, 'SKILL.md');
      symlinkSync(outside, target);

      expectRejection(
        () => writeSkillPayloadFile(target, Buffer.from('payload\n'), false),
        SkillInstallErrorCode.STAGING_IO
      );
      expect(readFileSync(outside).toString()).toBe('untouched\n');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
