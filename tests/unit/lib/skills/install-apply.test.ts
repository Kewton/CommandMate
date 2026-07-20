/**
 * Issue #1235: atomic commit of a planned Skill install.
 *
 * The behaviour under test is almost entirely what the module *refuses* to do.
 * Every case below either proves the destination is untouched after a rejection,
 * or proves that what landed is byte-for-byte what the plan fixed — because the
 * two failure modes that matter are "wrote somewhere else" and "wrote something
 * else", and both look like success from the caller's side.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  SKILL_INSTALL_EXECUTABLE_MODE,
  SKILL_INSTALL_FILE_MODE,
  SkillInstallErrorCode,
  applySkillInstall,
  buildSkillReloadGuidance,
  cleanupSkillInstallStaging,
  hasCommittedSkillPayload,
  inspectSkillDestination,
  isSkillInstallError,
  resolveSkillInstallTarget,
  type SkillInstallApplyInput,
} from '@/lib/skills/install-apply';
import {
  SKILL_RECEIPT_FILENAME,
  buildSkillInstallReceipt,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSkillTreeHash } from '@/lib/skills/preview-diff';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import {
  SKILL_INSTALL_STAGING_REL_PATH,
  getSkillInstallStagingRoot,
  isSkillInstallStagingPath,
} from '@/lib/skills/operation-store';
import { buildPackage } from '../../../fixtures/skills/malicious-packages/package';
import type { PackageFileSpec } from '../../../fixtures/skills/malicious-packages/package';
import { makeCatalogVersion } from './fixtures';

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const OPERATION_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

let worktree: string;

/** A real package, read and reconciled the same way the plan route reads it. */
function makeSnapshot(files?: PackageFileSpec[]): SkillPackageSnapshot {
  const built = buildPackage(files ? { files } : {});
  return inspectSkillPackage(built.bytes, { skillId: SKILL_ID, version: VERSION });
}

/**
 * Build the inputs a plan would hand to apply.
 *
 * The tree hash is derived exactly as `createSkillInstallPlan` derives it — the
 * package inventory plus the generated receipt — so a drift between the two
 * shows up here rather than in production.
 */
function makeInput(
  snapshot: SkillPackageSnapshot,
  overrides: Partial<SkillInstallApplyInput> = {}
): SkillInstallApplyInput {
  const receipt = buildSkillInstallReceipt({ snapshot, version: makeCatalogVersion() });
  const receiptBytes = serializeSkillInstallReceipt(receipt);
  const plannedTreeHash = computeSkillTreeHash([
    ...snapshot.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      executable: file.executable,
    })),
    {
      path: SKILL_RECEIPT_FILENAME,
      sha256: createHash('sha256').update(receiptBytes).digest('hex'),
      executable: false,
    },
  ]);

  return {
    worktreePath: worktree,
    worktreeRealPath: realpathSync(worktree),
    skillId: SKILL_ID,
    operationId: OPERATION_ID,
    snapshot,
    receiptBytes,
    plannedTreeHash,
    ...overrides,
  };
}

function installRoot(): string {
  return path.join(worktree, '.agents', 'skills', SKILL_ID);
}

/** Assert a rejection carries the expected code and left nothing behind. */
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

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'cm-skill-install-'));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe('applySkillInstall — the committed payload', () => {
  it('writes exactly the files the plan fixed, receipt included', () => {
    const snapshot = makeSnapshot();
    const input = makeInput(snapshot);

    const result = applySkillInstall(input);

    expect(result.installRoot).toBe(`.agents/skills/${SKILL_ID}`);
    for (const file of snapshot.files) {
      const bytes = readFileSync(path.join(installRoot(), file.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    const receiptOnDisk = readFileSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME));
    expect(Buffer.from(receiptOnDisk).equals(Buffer.from(input.receiptBytes))).toBe(true);
    expect(result.receiptSha256).toBe(
      createHash('sha256').update(input.receiptBytes).digest('hex')
    );
  });

  it('writes the receipt bytes the plan fixed rather than rebuilding them', () => {
    const snapshot = makeSnapshot();
    // A receipt the caller fixed; apply must not regenerate its own.
    const receiptBytes = Buffer.from('{"schema_version":1,"skill_id":"demo-skill"}', 'utf-8');
    const input = makeInput(snapshot, { receiptBytes });
    const plannedTreeHash = computeSkillTreeHash([
      ...snapshot.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        executable: file.executable,
      })),
      {
        path: SKILL_RECEIPT_FILENAME,
        sha256: createHash('sha256').update(receiptBytes).digest('hex'),
        executable: false,
      },
    ]);

    applySkillInstall({ ...input, plannedTreeHash });

    expect(readFileSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME)).toString()).toBe(
      receiptBytes.toString()
    );
  });

  it('gives only declared executables an execute bit', () => {
    const snapshot = makeSnapshot([
      { path: 'reference/notes.md', content: '# Notes\n' },
      { path: 'scripts/run.sh', content: '#!/bin/sh\nexit 0\n', mode: 0o755, kind: 'script', script: true },
    ]);

    applySkillInstall(makeInput(snapshot));

    const script = lstatSync(path.join(installRoot(), 'scripts/run.sh'));
    const notes = lstatSync(path.join(installRoot(), 'reference/notes.md'));
    expect(script.mode & 0o777).toBe(SKILL_INSTALL_EXECUTABLE_MODE);
    expect(notes.mode & 0o777).toBe(SKILL_INSTALL_FILE_MODE);
  });

  it('never executes a script it installs', () => {
    const sentinel = path.join(worktree, 'script-was-executed');
    const snapshot = makeSnapshot([
      { path: 'reference/notes.md', content: '# Notes\n' },
      {
        path: 'scripts/install.sh',
        content: `#!/bin/sh\ntouch ${sentinel}\n`,
        mode: 0o755,
        kind: 'script',
        script: true,
      },
    ]);

    applySkillInstall(makeInput(snapshot));

    expect(existsSync(path.join(installRoot(), 'scripts/install.sh'))).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('leaves no staging directory behind after a successful commit', () => {
    applySkillInstall(makeInput(makeSnapshot()));

    expect(existsSync(getSkillInstallStagingRoot(worktree))).toBe(false);
  });
});

describe('applySkillInstall — where it refuses to write', () => {
  it('rejects a Skill ID that would walk out of the Skills directory', () => {
    // `path.join` normalizes `..` away, so a containment check alone would let
    // this through: the grammar has to be re-checked first.
    expectRejection(
      () => resolveSkillInstallTarget(worktree, `..${path.sep}evil`),
      SkillInstallErrorCode.TARGET_UNSAFE
    );
    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot(), { skillId: '../evil' })),
      SkillInstallErrorCode.TARGET_UNSAFE
    );
    expect(existsSync(path.join(worktree, '.agents', 'evil'))).toBe(false);
  });

  it('refuses when an ancestor of the install root is a symlink', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'cm-skill-outside-'));
    try {
      mkdirSync(path.join(worktree, '.agents'));
      symlinkSync(outside, path.join(worktree, '.agents', 'skills'));

      expectRejection(
        () => applySkillInstall(makeInput(makeSnapshot())),
        SkillInstallErrorCode.ANCESTOR_UNSAFE
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses when the worktree path no longer resolves to the identity it was locked under', () => {
    expectRejection(
      () =>
        applySkillInstall(
          makeInput(makeSnapshot(), { worktreeRealPath: path.join(tmpdir(), 'some-other-worktree') })
        ),
      SkillInstallErrorCode.ANCESTOR_UNSAFE
    );
    expect(existsSync(installRoot())).toBe(false);
  });

  it('does not overwrite a CommandMate-managed install', () => {
    mkdirSync(installRoot(), { recursive: true });
    writeFileSync(
      path.join(installRoot(), SKILL_RECEIPT_FILENAME),
      JSON.stringify({ schema_version: 1, skill_id: SKILL_ID, version: '1.0.0', files: [] })
    );

    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot())),
      SkillInstallErrorCode.DESTINATION_EXISTS
    );
    expect(readdirSync(installRoot())).toEqual([SKILL_RECEIPT_FILENAME]);
  });

  it('does not overwrite a directory CommandMate does not manage', () => {
    mkdirSync(installRoot(), { recursive: true });
    writeFileSync(path.join(installRoot(), 'SKILL.md'), 'hand-written\n');

    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot())),
      SkillInstallErrorCode.DESTINATION_UNMANAGED
    );
    expect(readFileSync(path.join(installRoot(), 'SKILL.md')).toString()).toBe('hand-written\n');
  });

  it('does not overwrite an empty directory that is already at the install root', () => {
    // rename(2) silently replaces an empty destination directory, so absence has
    // to be proven rather than delegated to the syscall.
    mkdirSync(installRoot(), { recursive: true });

    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot())),
      SkillInstallErrorCode.DESTINATION_UNMANAGED
    );
    expect(readdirSync(installRoot())).toEqual([]);
  });

  it('treats a symlink at the install root as an occupant, not a path to follow', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'cm-skill-outside-'));
    try {
      mkdirSync(path.join(worktree, '.agents', 'skills'), { recursive: true });
      symlinkSync(outside, installRoot());

      expect(inspectSkillDestination(installRoot())).toEqual({
        present: true,
        managed: false,
        version: null,
      });
      expectRejection(
        () => applySkillInstall(makeInput(makeSnapshot())),
        SkillInstallErrorCode.DESTINATION_UNMANAGED
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('applySkillInstall — verification before the commit point', () => {
  it('refuses to publish a tree that does not hash to what the plan fixed', () => {
    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot(), { plannedTreeHash: 'f'.repeat(64) })),
      SkillInstallErrorCode.PAYLOAD_MISMATCH
    );
    expect(existsSync(installRoot())).toBe(false);
    expect(existsSync(getSkillInstallStagingRoot(worktree))).toBe(false);
  });

  it('never adopts a staging directory that already exists', () => {
    // Adopting one would mean two operations writing into a single commit, and
    // whatever a previous run left there would be published as ours.
    const outside = path.join(worktree, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    const stagingDir = path.join(getSkillInstallStagingRoot(worktree), OPERATION_ID);
    mkdirSync(stagingDir, { recursive: true });
    symlinkSync(outside, path.join(stagingDir, 'SKILL.md'));

    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot())),
      SkillInstallErrorCode.STAGING_IO
    );
    expect(readFileSync(outside).toString()).toBe('untouched\n');
    expect(existsSync(installRoot())).toBe(false);
  });

  it('rejects an operation ID that is not a safe path segment', () => {
    expectRejection(
      () => applySkillInstall(makeInput(makeSnapshot(), { operationId: '../escape' })),
      SkillInstallErrorCode.STAGING_IO
    );
  });

  it('stages inside the destination parent, so the commit rename cannot cross a filesystem', () => {
    const stagingRoot = getSkillInstallStagingRoot(worktree);
    expect(path.dirname(stagingRoot)).toBe(path.dirname(installRoot()));
  });
});

describe('staging namespace', () => {
  it('is excluded from Skill discovery and payload diffs', () => {
    expect(isSkillInstallStagingPath(`${SKILL_INSTALL_STAGING_REL_PATH}/${OPERATION_ID}`)).toBe(
      true
    );
    expect(isSkillInstallStagingPath(`.agents/skills/${SKILL_ID}/SKILL.md`)).toBe(false);
  });

  it('is cleaned up after a crash left a staging directory behind', () => {
    const stagingDir = path.join(getSkillInstallStagingRoot(worktree), OPERATION_ID);
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(path.join(stagingDir, 'partial.md'), 'half a package\n');
    mkdirSync(path.join(getSkillInstallStagingRoot(worktree), 'not-ours!'), { recursive: true });

    expect(cleanupSkillInstallStaging(worktree)).toBe(1);
    expect(existsSync(stagingDir)).toBe(false);
    // An entry outside the grammar is left alone rather than destroyed.
    expect(existsSync(path.join(getSkillInstallStagingRoot(worktree), 'not-ours!'))).toBe(true);
  });
});

describe('hasCommittedSkillPayload', () => {
  it('recognises the payload the operation committed', () => {
    const input = makeInput(makeSnapshot());
    const result = applySkillInstall(input);

    expect(hasCommittedSkillPayload(worktree, SKILL_ID, result.receiptSha256)).toBe(true);
  });

  it('rejects a receipt belonging to a different install', () => {
    applySkillInstall(makeInput(makeSnapshot()));

    expect(hasCommittedSkillPayload(worktree, SKILL_ID, 'a'.repeat(64))).toBe(false);
  });

  it('reports no payload when nothing was committed', () => {
    expect(hasCommittedSkillPayload(worktree, SKILL_ID, null)).toBe(false);
  });
});

describe('buildSkillReloadGuidance', () => {
  it('names one reload instruction per agent, for the version that landed', () => {
    const snapshot = makeSnapshot();
    const receipt = buildSkillInstallReceipt({ snapshot, version: makeCatalogVersion() });

    const guidance = buildSkillReloadGuidance(receipt);

    expect(guidance).toMatchObject({ skillId: SKILL_ID, version: VERSION });
    expect(guidance.installRoot).toBe(`.agents/skills/${SKILL_ID}`);
    expect(guidance.agents.every((agent) => agent.messageKey.startsWith('skills.install.reload.')))
      .toBe(true);
  });
});
