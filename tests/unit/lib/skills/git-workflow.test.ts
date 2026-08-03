/**
 * Skill install Git workflow (Issue #1247)
 *
 * Real git repositories, not a mocked `execGitCommand`. What this module has to
 * get right — that a commit contains the Skill payload from *every* install root
 * and nothing else, that a pre-existing staged change stops the run, that a
 * retry does not duplicate work — are all properties of git's index, and a
 * canned mock would only assert the test's idea of how staging behaves.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  SkillGitWorkflowErrorCode,
  applySkillGitWorkflow,
  buildSkillInstallBranchName,
  buildSkillInstallCommitMessage,
  buildSkillInstallPullRequestBody,
  buildSkillInstallPullRequestTitle,
  consumeSkillGitWorkflowTarget,
  isSkillGitWorkflowError,
  issueSkillGitWorkflowToken,
  prepareSkillGitWorkflow,
  readInstalledSkillArtifacts,
  resetSkillGitWorkflowTargetsForTesting,
  resolveSkillOwnedPaths,
  type SkillGitWorkflowTarget,
} from '@/lib/skills/git-workflow';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import { SKILL_RECEIPT_FILENAME } from '@/lib/skills/install-plan';
import type { SkillInstallReceipt } from '@/types/skills';
import { removeTempDir } from '@tests/helpers/temp-dir';

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const SOURCE_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const ARTIFACT_SHA = createHash('sha256').update('artifact').digest('hex');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'CommandMate Test',
  GIT_AUTHOR_EMAIL: 'test@commandmate.invalid',
  GIT_COMMITTER_NAME: 'CommandMate Test',
  GIT_COMMITTER_EMAIL: 'test@commandmate.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
}

const roots = [SKILL_INSTALL_ROOT_PREFIX, SKILL_CLAUDE_INSTALL_ROOT_PREFIX];

const PAYLOAD: Array<{ path: string; content: string; executable: boolean }> = [
  { path: 'SKILL.md', content: '---\nname: Demo Skill\n---\n\nSteps.\n', executable: false },
  {
    path: 'commandmate.skill.yaml',
    content: 'schema_version: 1\nid: demo-skill\n',
    executable: false,
  },
  { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', executable: true },
];

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeReceipt(overrides: Partial<SkillInstallReceipt> = {}): SkillInstallReceipt {
  return {
    schema_version: 1,
    skill_id: SKILL_ID,
    version: VERSION,
    install_root: `${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}`,
    install_roots: roots.map((root) => `${root}/${SKILL_ID}`),
    source: { repository: 'Kewton/commandmate-skills', ref: 'demo-skill-v1.2.3', commit: SOURCE_COMMIT },
    artifact: {
      asset_name: `${SKILL_ID}-${VERSION}.tar.gz`,
      sha256: ARTIFACT_SHA,
      size: 2048,
      format: 'tar.gz',
    },
    files: PAYLOAD.map((file) => ({
      path: file.path,
      sha256: digest(file.content),
      size: Buffer.byteLength(file.content),
      executable: file.executable,
    })),
    declared_risk: 'low',
    computed_risk: 'moderate',
    effective_risk: 'moderate',
    declared_permissions: ['filesystem_read', 'process_execution'],
    agent_compatibility: [{ agent: 'claude', support: 'native', evidence: 'docs/skills.md' }],
    ...overrides,
  };
}

let repo: string;

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-skill-git-')));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'user.name', 'CommandMate Test']);
  git(dir, ['config', 'user.email', 'test@commandmate.invalid']);
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf-8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

/** Write the payload the install would have left, into every recorded root. */
function writeInstalledPayload(dir: string, receipt: SkillInstallReceipt): void {
  for (const root of receipt.install_roots ?? [receipt.install_root]) {
    for (const file of PAYLOAD) {
      const target = path.join(dir, root, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf-8');
    }
    writeFileSync(
      path.join(dir, root, SKILL_RECEIPT_FILENAME),
      JSON.stringify(receipt, null, 2),
      'utf-8'
    );
  }
}

async function prepareOn(
  dir: string,
  overrides: Partial<Parameters<typeof prepareSkillGitWorkflow>[0]> = {}
): Promise<SkillGitWorkflowTarget> {
  return prepareSkillGitWorkflow({
    worktreePath: dir,
    skillId: SKILL_ID,
    version: VERSION,
    mode: 'dedicated_branch',
    activeSessions: [],
    push: false,
    ...overrides,
  });
}

function codeOf(error: unknown): string {
  return isSkillGitWorkflowError(error) ? error.code : `not-a-workflow-error: ${String(error)}`;
}

/** Assert a rejection carries exactly the expected refusal code. */
async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(codeOf(error)).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

function expectSyncRefusal(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(codeOf(error)).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

beforeEach(() => {
  repo = makeRepo();
  resetSkillGitWorkflowTargetsForTesting();
});

afterEach(() => {
  removeTempDir(repo);
});

// =============================================================================
// Naming and owned paths
// =============================================================================

describe('buildSkillInstallBranchName', () => {
  it('namespaces the branch and reduces the version to a ref-safe alphabet', () => {
    expect(buildSkillInstallBranchName('demo-skill', '1.2.3')).toBe(
      'skills/install-demo-skill-v1.2.3'
    );
    expect(buildSkillInstallBranchName('demo-skill', '1.0.0-rc.1+build.5')).toBe(
      'skills/install-demo-skill-v1.0.0-rc.1-build.5'
    );
  });

  it('never produces a name git would refuse', () => {
    const name = buildSkillInstallBranchName('demo-skill', '..1.0..');
    expect(name).not.toContain('..');
    expect(name.endsWith('.')).toBe(false);
    // The strongest available check: git itself.
    expect(() => git(repo, ['check-ref-format', '--branch', name])).not.toThrow();
  });
});

describe('resolveSkillOwnedPaths', () => {
  it('covers every install root the receipt records', () => {
    const owned = resolveSkillOwnedPaths(makeReceipt());
    expect(owned.roots).toEqual([
      `${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}`,
      `${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}`,
    ]);
    expect(owned.files).toContain(`${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}/SKILL.md`);
    expect(owned.files).toContain(`${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}/SKILL.md`);
    expect(owned.files).toContain(
      `${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}/${SKILL_RECEIPT_FILENAME}`
    );
  });

  it('reads a pre-#1460 receipt as its single root', () => {
    const legacy = makeReceipt();
    delete legacy.install_roots;
    const owned = resolveSkillOwnedPaths(legacy);
    expect(owned.roots).toEqual([`${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}`]);
    expect(owned.files.some((file) => file.startsWith(SKILL_CLAUDE_INSTALL_ROOT_PREFIX))).toBe(
      false
    );
  });
});

// =============================================================================
// Prepare
// =============================================================================

describe('prepareSkillGitWorkflow', () => {
  it('creates and checks out the dedicated branch from the current HEAD', async () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const target = await prepareOn(repo);

    expect(target.branch).toBe(`skills/install-${SKILL_ID}-v${VERSION}`);
    expect(target.baseBranch).toBe('main');
    expect(target.branchCreated).toBe(true);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(target.branch);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('switches to the dedicated branch even when unrelated work is unstaged', async () => {
    writeFileSync(path.join(repo, 'README.md'), '# edited in progress\n', 'utf-8');
    writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n', 'utf-8');

    const target = await prepareOn(repo);

    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(target.branch);
    // The in-progress edit is still there: branching from HEAD touches no file.
    expect(git(repo, ['status', '--porcelain'])).toContain('README.md');
  });

  it('refuses to start when something is already staged', async () => {
    writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=abc\n', 'utf-8');
    git(repo, ['add', 'secret.env']);

    await expectRefusal(prepareOn(repo), SkillGitWorkflowErrorCode.INDEX_NOT_CLEAN);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('refuses a detached HEAD', async () => {
    git(repo, ['checkout', '-q', '--detach']);
    await expectRefusal(prepareOn(repo), SkillGitWorkflowErrorCode.HEAD_UNSUPPORTED);
  });

  it('refuses when the dedicated branch already exists', async () => {
    git(repo, ['branch', `skills/install-${SKILL_ID}-v${VERSION}`]);
    await expectRefusal(prepareOn(repo), SkillGitWorkflowErrorCode.BRANCH_EXISTS);
  });

  it('refuses to switch branches under a live Agent session', async () => {
    await expectRefusal(prepareOn(repo, { activeSessions: ['claude'] }), SkillGitWorkflowErrorCode.ACTIVE_SESSION);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('leaves the branch alone in current_branch mode, and tolerates a live session', async () => {
    const target = await prepareOn(repo, {
      mode: 'current_branch',
      activeSessions: ['claude'],
    });
    expect(target.branch).toBe('main');
    expect(target.branchCreated).toBe(false);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('refuses to plan a push when the remote is not configured', async () => {
    await expectRefusal(prepareOn(repo, { push: true }), SkillGitWorkflowErrorCode.REMOTE_MISSING);
  });
});

// =============================================================================
// Apply
// =============================================================================

describe('applySkillGitWorkflow', () => {
  it('commits every install root and nothing else', async () => {
    // Unrelated work that must not be swept into the commit.
    writeFileSync(path.join(repo, 'README.md'), '# edited in progress\n', 'utf-8');
    writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=abc\n', 'utf-8');

    const receipt = makeReceipt();
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, receipt);

    const outcome = await applySkillGitWorkflow({
      worktreePath: repo,
      target,
      receipt,
      manifest: null,
      push: false,
      createPullRequest: false,
    });

    expect(outcome.committed).toBe(true);
    const committed = git(repo, ['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .filter((line) => line.length > 0)
      .sort();
    expect(committed).toEqual(resolveSkillOwnedPaths(receipt).files.sort());
    expect(committed).not.toContain('README.md');
    expect(committed).not.toContain('secret.env');
    // Both roots really are in the tree, not just the primary one.
    expect(committed.filter((file) => file.startsWith(SKILL_CLAUDE_INSTALL_ROOT_PREFIX))).toHaveLength(
      PAYLOAD.length + 1
    );
    // The unrelated edits survive untouched in the working tree.
    expect(git(repo, ['status', '--porcelain'])).toContain('secret.env');
  });

  it('records the Skill, version and source SHA in the commit message', async () => {
    const receipt = makeReceipt();
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, receipt);
    await applySkillGitWorkflow({
      worktreePath: repo,
      target,
      receipt,
      manifest: null,
      push: false,
      createPullRequest: false,
    });

    const message = git(repo, ['log', '-1', '--format=%B']);
    expect(message).toContain(`install ${SKILL_ID} v${VERSION}`);
    expect(message).toContain(SOURCE_COMMIT);
    expect(message).toContain(ARTIFACT_SHA);
    expect(message).toContain(`${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}`);
  });

  it('refuses when an unrelated path is already staged', async () => {
    const receipt = makeReceipt();
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, receipt);
    writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=abc\n', 'utf-8');
    git(repo, ['add', 'secret.env']);

    await expectRefusal(applySkillGitWorkflow({
        worktreePath: repo,
        target,
        receipt,
        manifest: null,
        push: false,
        createPullRequest: false,
      }), SkillGitWorkflowErrorCode.INDEX_NOT_CLEAN);
    expect(git(repo, ['log', '--oneline'])).not.toContain('install');
  });

  it('refuses a file inside an owned root that the receipt does not account for', async () => {
    const receipt = makeReceipt();
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, receipt);
    writeFileSync(
      path.join(repo, `${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}/smuggled.txt`),
      'not in the receipt\n',
      'utf-8'
    );

    await expectRefusal(applySkillGitWorkflow({
        worktreePath: repo,
        target,
        receipt,
        manifest: null,
        push: false,
        createPullRequest: false,
      }), SkillGitWorkflowErrorCode.UNOWNED_STAGED_PATH);
  });

  it('is a no-op on retry once the payload is committed', async () => {
    const receipt = makeReceipt();
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, receipt);
    const first = await applySkillGitWorkflow({
      worktreePath: repo,
      target,
      receipt,
      manifest: null,
      push: false,
      createPullRequest: false,
    });

    const second = await applySkillGitWorkflow({
      worktreePath: repo,
      target,
      receipt,
      manifest: null,
      push: false,
      createPullRequest: false,
    });

    expect(second.committed).toBe(false);
    expect(second.commitSha).toBe(first.commitSha);
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('refuses to commit onto a branch the user did not approve', async () => {
    const receipt = makeReceipt();
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, receipt);
    git(repo, ['switch', '-q', 'main']);

    await expectRefusal(applySkillGitWorkflow({
        worktreePath: repo,
        target,
        receipt,
        manifest: null,
        push: false,
        createPullRequest: false,
      }), SkillGitWorkflowErrorCode.TARGET_DRIFTED);
  });

  it('commits a pre-#1460 single-root install without touching the Claude root', async () => {
    const legacy = makeReceipt();
    delete legacy.install_roots;
    const target = await prepareOn(repo);
    writeInstalledPayload(repo, legacy);

    const outcome = await applySkillGitWorkflow({
      worktreePath: repo,
      target,
      receipt: legacy,
      manifest: null,
      push: false,
      createPullRequest: false,
    });

    expect(outcome.committed).toBe(true);
    expect(
      outcome.changedPaths.every((file) => file.startsWith(SKILL_INSTALL_ROOT_PREFIX))
    ).toBe(true);
  });
});

// =============================================================================
// Receipt reading
// =============================================================================

describe('readInstalledSkillArtifacts', () => {
  it('reads the receipt the install wrote', () => {
    const receipt = makeReceipt();
    writeInstalledPayload(repo, receipt);
    const artifacts = readInstalledSkillArtifacts(repo, SKILL_ID);
    expect(artifacts.receipt.skill_id).toBe(SKILL_ID);
    expect(artifacts.receipt.install_roots).toHaveLength(2);
  });

  it('refuses when no receipt is present', () => {
    expectSyncRefusal(
      () => readInstalledSkillArtifacts(repo, SKILL_ID),
      SkillGitWorkflowErrorCode.RECEIPT_UNREADABLE
    );
  });

  it('refuses a receipt that no longer validates', () => {
    const receipt = makeReceipt();
    writeInstalledPayload(repo, receipt);
    writeFileSync(
      path.join(repo, receipt.install_root, SKILL_RECEIPT_FILENAME),
      '{"schema_version": 1}',
      'utf-8'
    );
    expectSyncRefusal(
      () => readInstalledSkillArtifacts(repo, SKILL_ID),
      SkillGitWorkflowErrorCode.RECEIPT_UNREADABLE
    );
  });
});

// =============================================================================
// Prepared-target store
// =============================================================================

describe('prepared-target store', () => {
  const target: SkillGitWorkflowTarget = {
    mode: 'dedicated_branch',
    branch: 'skills/install-demo-skill-v1.2.3',
    baseBranch: 'main',
    headCommit: SOURCE_COMMIT,
    branchCreated: true,
    remote: 'origin',
  };

  it('returns the stored target for the worktree and Skill it was issued for', () => {
    const token = issueSkillGitWorkflowToken('wt-1', SKILL_ID, target);
    expect(consumeSkillGitWorkflowTarget(token, { worktreeId: 'wt-1', skillId: SKILL_ID })).toEqual(
      target
    );
  });

  it('stays usable across retries', () => {
    const token = issueSkillGitWorkflowToken('wt-1', SKILL_ID, target);
    consumeSkillGitWorkflowTarget(token, { worktreeId: 'wt-1', skillId: SKILL_ID });
    expect(() =>
      consumeSkillGitWorkflowTarget(token, { worktreeId: 'wt-1', skillId: SKILL_ID })
    ).not.toThrow();
  });

  it('refuses a token issued for a different worktree or Skill', () => {
    const token = issueSkillGitWorkflowToken('wt-1', SKILL_ID, target);
    expectSyncRefusal(
      () => consumeSkillGitWorkflowTarget(token, { worktreeId: 'wt-2', skillId: SKILL_ID }),
      SkillGitWorkflowErrorCode.TARGET_DRIFTED
    );
    const other = issueSkillGitWorkflowToken('wt-1', SKILL_ID, target);
    expectSyncRefusal(
      () => consumeSkillGitWorkflowTarget(other, { worktreeId: 'wt-1', skillId: 'other-skill' }),
      SkillGitWorkflowErrorCode.TARGET_DRIFTED
    );
  });

  it('refuses a malformed token without consulting the store', () => {
    expectSyncRefusal(
      () => consumeSkillGitWorkflowTarget('not-a-token', { worktreeId: 'wt-1', skillId: SKILL_ID }),
      SkillGitWorkflowErrorCode.TARGET_DRIFTED
    );
  });
});

// =============================================================================
// Pull request text
// =============================================================================

describe('pull request text', () => {
  const target: SkillGitWorkflowTarget = {
    mode: 'dedicated_branch',
    branch: 'skills/install-demo-skill-v1.2.3',
    baseBranch: 'develop',
    headCommit: SOURCE_COMMIT,
    branchCreated: true,
    remote: 'origin',
  };

  it('carries source SHA, checksum, risk and validation', () => {
    const receipt = makeReceipt();
    const body = buildSkillInstallPullRequestBody({
      receipt,
      manifest: null,
      target,
      changedPaths: resolveSkillOwnedPaths(receipt).files,
      validations: [{ label: 'npm run test:unit', outcome: 'passed' }],
    });

    expect(body).toContain(SOURCE_COMMIT);
    expect(body).toContain(ARTIFACT_SHA);
    expect(body).toContain('Kewton/commandmate-skills');
    expect(body).toContain('moderate');
    expect(body).toContain('npm run test:unit: passed');
    expect(body).toContain('process_execution');
    expect(body).toContain('scripts/run.sh');
    expect(body).toContain('skills/install-demo-skill-v1.2.3');
  });

  it('names no machine-absolute path', () => {
    const receipt = makeReceipt();
    const body = buildSkillInstallPullRequestBody({
      receipt,
      manifest: null,
      target,
      changedPaths: [...resolveSkillOwnedPaths(receipt).files, '/Users/someone/secret/notes.md'],
    });
    expect(body).not.toContain('/Users/someone');
  });

  it('titles the PR under the repository convention', () => {
    expect(buildSkillInstallPullRequestTitle(makeReceipt())).toBe(
      `feat: install Skill ${SKILL_ID} v${VERSION}`
    );
  });

  it('degrades to receipt-only facts when the manifest is unreadable', () => {
    const body = buildSkillInstallPullRequestBody({
      receipt: makeReceipt(),
      manifest: null,
      target,
      changedPaths: [],
    });
    expect(body).toContain(SKILL_ID);
    expect(body).toContain('## できるようになること');
  });
});

describe('buildSkillInstallCommitMessage', () => {
  it('lists every root a dual-root install landed in', () => {
    const message = buildSkillInstallCommitMessage(makeReceipt());
    expect(message).toContain(`${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}`);
    expect(message).toContain(`${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}`);
  });

  it('lists only the single root of a legacy install', () => {
    const legacy = makeReceipt();
    delete legacy.install_roots;
    const message = buildSkillInstallCommitMessage(legacy);
    expect(message).not.toContain(SKILL_CLAUDE_INSTALL_ROOT_PREFIX);
  });
});
