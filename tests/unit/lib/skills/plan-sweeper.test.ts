/**
 * Background plan/snapshot sweeper (Issue #1429)
 *
 * The property under test is the one the plan cache could not previously
 * offer: a plan that is built and never applied must stop pinning its artifact
 * snapshot on its own schedule, without a second plan ever being created. These
 * tests therefore run the real snapshot store against the real plan cache —
 * mocking the store would prove only that a mock was called.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

vi.mock('@/lib/git/git-exec', () => ({
  execGitCommand: vi.fn(),
  execFileAsync: vi.fn(),
}));

import {
  SKILL_PLAN_SWEEP_INTERVAL_MS,
  SKILL_SNAPSHOT_TTL_MS,
} from '@/config/skill-security-config';
import {
  SKILL_PLAN_TTL_MS,
  createSkillInstallPlan,
  getSkillInstallPlan,
  getSkillInstallPlanCount,
  resetSkillInstallPlanCacheForTesting,
} from '@/lib/skills/install-plan';
import {
  createSkillSnapshot,
  getSkillSnapshotUsage,
  initSkillSnapshotStore,
  resetSkillSnapshotStoreForTesting,
  sweepSkillSnapshots,
} from '@/lib/skills/snapshot-store';
import {
  ensureSkillPlanSweeper,
  getSkillPlanSweeperTimerForTesting,
  runSkillPlanSweep,
  stopSkillPlanSweeperForTesting,
} from '@/lib/skills/plan-sweeper';
import { execFileAsync, execGitCommand } from '@/lib/git/git-exec';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import type { SkillCommandMateCompatibility } from '@/lib/skills/compatibility';
import type { SkillManifest } from '@/types/skills';
import { makeCatalogVersion } from './fixtures';

const execGitCommandMock = vi.mocked(execGitCommand);
const execFileAsyncMock = vi.mocked(execFileAsync) as unknown as ReturnType<typeof vi.fn>;

/** The store refuses system directories, and os.tmpdir() is under /var on macOS. */
const TEST_ROOT_PARENT = path.join(process.cwd(), 'temp');

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const HEAD = 'f'.repeat(40);
const T0 = Date.parse('2026-07-20T00:00:00Z');
const ARTIFACT = Buffer.from('demo-skill artifact payload bytes for the sweeper test');

const COMPATIBLE: SkillCommandMateCompatibility = {
  status: 'compatible',
  requiredRange: '>=0.11.0',
  currentVersion: '0.11.4',
  reasonCode: 'SKILL_COMPAT_SATISFIED',
  messageKey: 'skills.compatibility.reason.satisfied',
  message: 'CommandMate 0.11.4 satisfies >=0.11.0.',
};

let rootDir: string;
let worktreeDir: string;

function makePackageSnapshot(): SkillPackageSnapshot {
  const bytes = Buffer.from('# demo\n', 'utf-8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest: SkillManifest = {
    schema_version: 1,
    id: SKILL_ID,
    name: SKILL_ID,
    version: VERSION,
    summary: 'Draft release notes.',
    description: 'A demo Skill used by the sweeper tests.',
    capabilities: ['Draft release notes from merged pull requests.'],
    expected_outcomes: ['A reviewable draft in under a minute.'],
    provider: { name: 'CommandMate', url: 'https://example.invalid' },
    license: 'MIT',
    compatibility: { commandmate: '>=0.11.0', agents: [] },
    requirements: { commands: [], network_hosts: [] },
    declared_permissions: ['filesystem_read'],
    declared_risk: 'low',
    risk_rationale: 'Reads the repository only.',
    files: [
      {
        path: 'SKILL.md',
        sha256,
        size: bytes.byteLength,
        kind: 'skill_md',
        executable: false,
        script: false,
      },
    ],
  };

  return {
    skillId: SKILL_ID,
    version: VERSION,
    manifest,
    files: [{ path: 'SKILL.md', sha256, size: bytes.byteLength, executable: false }],
    directories: [],
    inspection: {
      executable_paths: [],
      script_paths: [],
      network_hosts: [],
      declared_permissions: ['filesystem_read'],
    },
    declaredRisk: 'low',
    computedRisk: 'low',
    effectiveRisk: 'low',
    readFile: () => new Uint8Array(bytes),
  };
}

/** Snapshot the artifact, then pin it with an install plan. Mirrors the plan route. */
async function pinSnapshotWithPlan(): Promise<{ snapshotId: string; token: string }> {
  const handle = createSkillSnapshot({
    skillId: SKILL_ID,
    version: VERSION,
    commit: 'a'.repeat(40),
    sha256: createHash('sha256').update(ARTIFACT).digest('hex'),
    bytes: ARTIFACT,
  });

  const record = await createSkillInstallPlan({
    actor: { type: 'user', id: null },
    worktree: {
      id: 'demo-wt',
      name: 'feature/demo',
      path: worktreeDir,
      repositoryName: 'CommandMate',
      syncedBranch: 'feature/demo',
    },
    snapshot: makePackageSnapshot(),
    version: makeCatalogVersion({ version: VERSION }),
    snapshotId: handle.snapshotId,
    compatibility: COMPATIBLE,
    now: T0,
  });

  return { snapshotId: handle.snapshotId, token: record.token };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);

  fs.mkdirSync(TEST_ROOT_PARENT, { recursive: true });
  rootDir = fs.mkdtempSync(path.join(TEST_ROOT_PARENT, 'skill-sweeper-'));
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sweeper-wt-'));
  initSkillSnapshotStore({ rootDir });
  resetSkillInstallPlanCacheForTesting();

  execGitCommandMock.mockReset();
  execFileAsyncMock.mockReset();
  execGitCommandMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') return 'feature/demo';
    if (args[0] === 'rev-parse') return HEAD;
    if (args[0] === 'status') return '';
    return null;
  });
  execFileAsyncMock.mockRejectedValue(Object.assign(new Error('exit 1'), { stdout: '' }));
});

afterEach(() => {
  stopSkillPlanSweeperForTesting();
  resetSkillInstallPlanCacheForTesting();
  resetSkillSnapshotStoreForTesting();
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('an abandoned plan', () => {
  it('pins its snapshot past both TTLs while nothing sweeps the plan cache', async () => {
    await pinSnapshotWithPlan();

    // Long past the snapshot TTL, but the plan still holds the reference.
    expect(sweepSkillSnapshots({ now: T0 + SKILL_SNAPSHOT_TTL_MS + 1 })).toBe(0);
    expect(getSkillSnapshotUsage().count).toBe(1);
  });

  it('releases its snapshot on the sweeper without a second plan being created', async () => {
    await pinSnapshotWithPlan();
    expect(getSkillInstallPlanCount()).toBe(1);

    const planExpired = runSkillPlanSweep({ now: T0 + SKILL_PLAN_TTL_MS + 1 });
    expect(planExpired.installPlans).toBe(1);
    expect(getSkillInstallPlanCount()).toBe(0);
    // Reference dropped, but the bytes stay until their own TTL elapses.
    expect(planExpired.snapshots).toBe(0);
    expect(getSkillSnapshotUsage().count).toBe(1);

    const snapshotExpired = runSkillPlanSweep({ now: T0 + SKILL_SNAPSHOT_TTL_MS + 1 });
    expect(snapshotExpired.snapshots).toBe(1);
    expect(getSkillSnapshotUsage()).toEqual({ totalBytes: 0, count: 0 });
  });

  it('is reclaimed by an unrelated token lookup, not only by the timer', async () => {
    const { token } = await pinSnapshotWithPlan();

    expect(() =>
      getSkillInstallPlan('0'.repeat(48), { now: T0 + SKILL_PLAN_TTL_MS + 1 })
    ).toThrowError(/SKILL_PLAN_NOT_FOUND/);

    expect(getSkillInstallPlanCount()).toBe(0);
    expect(sweepSkillSnapshots({ now: T0 + SKILL_SNAPSHOT_TTL_MS + 1 })).toBe(1);
    // The plan is gone, so its own token now reads as absent rather than expired.
    expect(() => getSkillInstallPlan(token, { now: T0 })).toThrowError(/SKILL_PLAN_NOT_FOUND/);
  });

  it('still answers EXPIRED for its own token rather than NOT_FOUND', async () => {
    const { token } = await pinSnapshotWithPlan();

    expect(() =>
      getSkillInstallPlan(token, { now: T0 + SKILL_PLAN_TTL_MS + 1 })
    ).toThrowError(/SKILL_PLAN_EXPIRED/);
  });
});

describe('runSkillPlanSweep', () => {
  it('skips snapshots when no artifact has been downloaded yet', () => {
    resetSkillSnapshotStoreForTesting();

    expect(runSkillPlanSweep({ now: T0 })).toEqual({
      installPlans: 0,
      uninstallPlans: 0,
      snapshots: 0,
    });
  });
});

describe('ensureSkillPlanSweeper', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('runs one timer no matter how many requests start it', () => {
    ensureSkillPlanSweeper();
    const first = getSkillPlanSweeperTimerForTesting();
    ensureSkillPlanSweeper();

    expect(first).not.toBeNull();
    expect(getSkillPlanSweeperTimerForTesting()).toBe(first);
  });

  it('does not hold the event loop open', () => {
    ensureSkillPlanSweeper();

    expect(getSkillPlanSweeperTimerForTesting()?.hasRef()).toBe(false);
  });

  it('sweeps on the configured interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    ensureSkillPlanSweeper();

    vi.advanceTimersByTime(SKILL_PLAN_SWEEP_INTERVAL_MS * 2);

    // Nothing to reclaim, but the interval must have fired without throwing.
    expect(getSkillInstallPlanCount()).toBe(0);
  });
});
