/**
 * Issue #1460: placing a Skill into both discovery roots.
 *
 * An official install now lands in `.agents/skills/<id>` (Codex) *and*
 * `.claude/skills/<id>` (Claude). These tests pin the properties the feature
 * rests on: the payload written to each root is byte-identical, the receipt
 * records the full root set while a single-root install stays byte-identical to
 * a pre-#1460 one, uninstall removes every recorded root, and a partial install
 * (primary only) converges the secondary forward from the primary.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIXES,
} from '@/lib/skills/constants';
import {
  applySkillInstall,
  completeSecondarySkillInstallRoots,
  isSkillInstallError,
} from '@/lib/skills/install-apply';
import {
  SKILL_RECEIPT_FILENAME,
  buildSkillInstallReceipt,
  receiptInstallRoots,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import {
  computeSkillTreeHash,
  resolveSkillInstallRootFor,
} from '@/lib/skills/preview-diff';
import { assessSkillUninstall } from '@/lib/skills/uninstall-plan';
import { applySkillUninstall } from '@/lib/skills/uninstall-apply';
import { validateSkillInstallReceipt } from '@/lib/skills/schema';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import { buildPackage } from '../../../fixtures/skills/malicious-packages/package';
import { makeCatalogVersion } from './fixtures';

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const OPERATION_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const BOTH_ROOTS = [...SKILL_INSTALL_ROOT_PREFIXES];

let worktree: string;

function makeSnapshot(): SkillPackageSnapshot {
  return inspectSkillPackage(buildPackage({}).bytes, { skillId: SKILL_ID, version: VERSION });
}

/** Build apply input targeting the given roots, with a matching receipt + tree hash. */
function makeInput(rootPrefixes: readonly string[]) {
  const snapshot = makeSnapshot();
  const receipt = buildSkillInstallReceipt({ snapshot, version: makeCatalogVersion(), rootPrefixes });
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
    input: {
      worktreePath: worktree,
      worktreeRealPath: realpathSync(worktree),
      skillId: SKILL_ID,
      operationId: OPERATION_ID,
      snapshot,
      receiptBytes,
      plannedTreeHash,
      rootPrefixes,
    },
    receipt,
    receiptBytes,
  };
}

function rootAbs(prefix: string): string {
  return path.join(worktree, ...prefix.split('/'), SKILL_ID);
}

/** Every repository-relative file under one install root, sorted. */
function treeUnder(prefix: string): string[] {
  const base = rootAbs(prefix);
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1
    )) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else out.push(childRel);
    }
  };
  if (existsSync(base)) walk(base, '');
  return out.sort();
}

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'cm-skill-multiroot-'));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe('dual-root install (#1460)', () => {
  it('writes the package byte-identically into both discovery roots', () => {
    const { input } = makeInput(BOTH_ROOTS);
    const result = applySkillInstall(input);

    expect(result.committedRoots).toEqual([
      `.agents/skills/${SKILL_ID}`,
      `.claude/skills/${SKILL_ID}`,
    ]);
    expect(result.reconciling).toBe(false);
    expect(result.pendingRoots).toEqual([]);

    // Same relative file set under each root.
    const agentsTree = treeUnder(SKILL_INSTALL_ROOT_PREFIX);
    const claudeTree = treeUnder(SKILL_CLAUDE_INSTALL_ROOT_PREFIX);
    expect(claudeTree).toEqual(agentsTree);
    expect(agentsTree).toContain('SKILL.md');
    expect(agentsTree).toContain(SKILL_RECEIPT_FILENAME);

    // Byte-for-byte identical content across roots.
    for (const rel of agentsTree) {
      const a = readFileSync(path.join(rootAbs(SKILL_INSTALL_ROOT_PREFIX), rel));
      const c = readFileSync(path.join(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX), rel));
      expect(c.equals(a)).toBe(true);
    }
  });

  it('records the root set in each root’s receipt', () => {
    const { input } = makeInput(BOTH_ROOTS);
    applySkillInstall(input);

    for (const prefix of BOTH_ROOTS) {
      const bytes = readFileSync(path.join(rootAbs(prefix), SKILL_RECEIPT_FILENAME));
      const receipt = JSON.parse(bytes.toString('utf-8'));
      expect(receipt.install_root).toBe(`.agents/skills/${SKILL_ID}`);
      expect(receipt.install_roots).toEqual([
        `.agents/skills/${SKILL_ID}`,
        `.claude/skills/${SKILL_ID}`,
      ]);
    }
  });

  it('leaves a single-root install byte-identical to a pre-#1460 one', () => {
    // No install_roots field, and only the primary root is written.
    const legacy = buildSkillInstallReceipt({ snapshot: makeSnapshot(), version: makeCatalogVersion() });
    expect(legacy.install_roots).toBeUndefined();

    const single = makeInput([SKILL_INSTALL_ROOT_PREFIX]);
    const result = applySkillInstall(single.input);
    expect(result.installRoots).toEqual([`.agents/skills/${SKILL_ID}`]);
    expect(existsSync(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX))).toBe(false);
    const onDisk = JSON.parse(
      readFileSync(path.join(rootAbs(SKILL_INSTALL_ROOT_PREFIX), SKILL_RECEIPT_FILENAME), 'utf-8')
    );
    expect(onDisk.install_roots).toBeUndefined();
  });

  it('reads roots from a receipt, defaulting a legacy receipt to its single root', () => {
    const multi = buildSkillInstallReceipt({
      snapshot: makeSnapshot(),
      version: makeCatalogVersion(),
      rootPrefixes: BOTH_ROOTS,
    });
    expect(receiptInstallRoots(multi)).toEqual([
      `.agents/skills/${SKILL_ID}`,
      `.claude/skills/${SKILL_ID}`,
    ]);

    const legacy = buildSkillInstallReceipt({ snapshot: makeSnapshot(), version: makeCatalogVersion() });
    expect(receiptInstallRoots(legacy)).toEqual([`.agents/skills/${SKILL_ID}`]);
  });

  it('rejects a Skill ID that escapes the Claude root', () => {
    expect(() =>
      resolveSkillInstallRootFor(worktree, SKILL_CLAUDE_INSTALL_ROOT_PREFIX, '../evil')
    ).toThrow();
  });

  it('refuses to write a root whose destination is already occupied', () => {
    // Install into both, then attempt a fresh install: both destinations exist.
    applySkillInstall(makeInput(BOTH_ROOTS).input);
    let thrown: unknown;
    try {
      applySkillInstall(makeInput(BOTH_ROOTS).input);
    } catch (error) {
      thrown = error;
    }
    expect(isSkillInstallError(thrown)).toBe(true);
  });
});

describe('receipt schema for install_roots (#1460)', () => {
  function plainReceipt(rootPrefixes?: readonly string[]): Record<string, unknown> {
    const receipt = buildSkillInstallReceipt({
      snapshot: makeSnapshot(),
      version: makeCatalogVersion(),
      ...(rootPrefixes ? { rootPrefixes } : {}),
    });
    return JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
  }

  it('accepts a well-formed multi-root receipt', () => {
    const result = validateSkillInstallReceipt(plainReceipt(BOTH_ROOTS));
    expect(result.ok).toBe(true);
  });

  it('accepts a legacy single-root receipt with no install_roots', () => {
    const receipt = plainReceipt();
    expect(receipt.install_roots).toBeUndefined();
    expect(validateSkillInstallReceipt(receipt).ok).toBe(true);
  });

  it('rejects install_roots whose first entry is not the primary install_root', () => {
    const receipt = plainReceipt(BOTH_ROOTS);
    receipt.install_roots = [
      `.claude/skills/${SKILL_ID}`,
      `.agents/skills/${SKILL_ID}`,
    ];
    expect(validateSkillInstallReceipt(receipt).ok).toBe(false);
  });

  it('rejects an install_roots entry that is not a known discovery root', () => {
    const receipt = plainReceipt(BOTH_ROOTS);
    receipt.install_roots = [`.agents/skills/${SKILL_ID}`, `.evil/skills/${SKILL_ID}`];
    expect(validateSkillInstallReceipt(receipt).ok).toBe(false);
  });

  it('rejects a repeated root', () => {
    const receipt = plainReceipt(BOTH_ROOTS);
    receipt.install_roots = [`.agents/skills/${SKILL_ID}`, `.agents/skills/${SKILL_ID}`];
    expect(validateSkillInstallReceipt(receipt).ok).toBe(false);
  });
});

describe('secondary-root convergence (#1460)', () => {
  it('rewrites a missing secondary root from the committed primary', () => {
    applySkillInstall(makeInput(BOTH_ROOTS).input);

    // Simulate a crash that landed only the primary root.
    rmSync(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX), { recursive: true });
    expect(existsSync(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX))).toBe(false);

    const { completed } = completeSecondarySkillInstallRoots(
      worktree,
      realpathSync(worktree),
      SKILL_ID
    );
    expect(completed).toEqual([`.claude/skills/${SKILL_ID}`]);

    // The rebuilt root matches the primary byte-for-byte.
    for (const rel of treeUnder(SKILL_INSTALL_ROOT_PREFIX)) {
      const a = readFileSync(path.join(rootAbs(SKILL_INSTALL_ROOT_PREFIX), rel));
      const c = readFileSync(path.join(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX), rel));
      expect(c.equals(a)).toBe(true);
    }
  });

  it('is a no-op when every recorded root is already present', () => {
    applySkillInstall(makeInput(BOTH_ROOTS).input);
    const { completed } = completeSecondarySkillInstallRoots(
      worktree,
      realpathSync(worktree),
      SKILL_ID
    );
    expect(completed).toEqual([]);
  });
});

describe('dual-root uninstall (#1460)', () => {
  it('removes the skill from every recorded root', () => {
    applySkillInstall(makeInput(BOTH_ROOTS).input);
    expect(existsSync(rootAbs(SKILL_INSTALL_ROOT_PREFIX))).toBe(true);
    expect(existsSync(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX))).toBe(true);

    const assessment = assessSkillUninstall(rootAbs(SKILL_INSTALL_ROOT_PREFIX), SKILL_ID);
    const result = applySkillUninstall({
      worktreePath: worktree,
      worktreeRealPath: realpathSync(worktree),
      skillId: SKILL_ID,
      expectedReceiptDigest: assessment.receiptDigest as string,
      expectedTreeHash: assessment.currentTreeHash,
    });

    expect(result.installRoots).toEqual([
      `.agents/skills/${SKILL_ID}`,
      `.claude/skills/${SKILL_ID}`,
    ]);
    expect(result.fullyRemoved).toBe(true);
    expect(existsSync(rootAbs(SKILL_INSTALL_ROOT_PREFIX))).toBe(false);
    expect(existsSync(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX))).toBe(false);
  });

  it('blocks and deletes nothing when a secondary root has a local modification', () => {
    applySkillInstall(makeInput(BOTH_ROOTS).input);

    // Tamper with a file in the Claude root only.
    const victim = path.join(rootAbs(SKILL_CLAUDE_INSTALL_ROOT_PREFIX), 'SKILL.md');
    // 0600 payload: put the write bit back, then prove digest drift blocks all.
    chmodSync(victim, 0o600);
    writeFileSync(victim, 'tampered\n');

    const assessment = assessSkillUninstall(rootAbs(SKILL_INSTALL_ROOT_PREFIX), SKILL_ID);
    let thrown: unknown;
    try {
      applySkillUninstall({
        worktreePath: worktree,
        worktreeRealPath: realpathSync(worktree),
        skillId: SKILL_ID,
        expectedReceiptDigest: assessment.receiptDigest as string,
        expectedTreeHash: assessment.currentTreeHash,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // Zero-delete across roots: the primary is untouched because the secondary blocked.
    expect(existsSync(path.join(rootAbs(SKILL_INSTALL_ROOT_PREFIX), 'SKILL.md'))).toBe(true);
    expect(statSync(victim).size).toBeGreaterThan(0);
  });
});
