/**
 * API integration tests — Skill install Git workflow (Issue #1247)
 *
 * Runs the vertical slice with real git: a real worktree, a real *local* bare
 * remote, real branch creation, staging, commit and push. Only `gh` is stubbed,
 * because opening a pull request is the one step that cannot be made local.
 *
 * The push being real is the point. A mocked `gitPush` would assert that the
 * route calls a function; a real push against a bare repository asserts that the
 * commit the route built actually lands on the remote, with the payload from
 * every install root inside it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { SkillInstallReceipt } from '@/types/skills';

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

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(), getAgentInstances: vi.fn(() => []) }));
vi.mock('@/lib/session/cli-session', () => ({ isSessionRunning: vi.fn(async () => false) }));
vi.mock('@/lib/skills/pull-request-service', () => ({
  findOpenPullRequest: vi.fn(async () => null),
  createDraftPullRequest: vi.fn(async () => ({
    ok: true,
    url: 'https://github.com/Kewton/CommandMate/pull/9999',
  })),
}));

import { POST } from '@/app/api/worktrees/[id]/skills/[skillId]/git-workflow/route';
import { getWorktreeById } from '@/lib/db';
import { isSessionRunning } from '@/lib/session/cli-session';
import { createDraftPullRequest, findOpenPullRequest } from '@/lib/skills/pull-request-service';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import { SKILL_RECEIPT_FILENAME } from '@/lib/skills/install-plan';
import { resetSkillGitWorkflowTargetsForTesting } from '@/lib/skills/git-workflow';

const WORKTREE_ID = 'wt-00000000-0000-4000-8000-000000000001';
const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const BRANCH = `skills/install-${SKILL_ID}-v${VERSION}`;
const SOURCE_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

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

const PAYLOAD = [
  { path: 'SKILL.md', content: '---\nname: Demo Skill\n---\n\nSteps.\n' },
  { path: 'commandmate.skill.yaml', content: 'schema_version: 1\nid: demo-skill\n' },
];

function makeReceipt(): SkillInstallReceipt {
  return {
    schema_version: 1,
    skill_id: SKILL_ID,
    version: VERSION,
    install_root: `${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}`,
    install_roots: [
      `${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}`,
      `${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}`,
    ],
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: 'demo-skill-v1.2.3',
      commit: SOURCE_COMMIT,
    },
    artifact: {
      asset_name: `${SKILL_ID}-${VERSION}.tar.gz`,
      sha256: createHash('sha256').update('artifact').digest('hex'),
      size: 2048,
      format: 'tar.gz',
    },
    files: PAYLOAD.map((file) => ({
      path: file.path,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      size: Buffer.byteLength(file.content),
      executable: false,
    })),
    declared_risk: 'low',
    computed_risk: 'low',
    effective_risk: 'low',
    declared_permissions: ['filesystem_read'],
    agent_compatibility: [{ agent: 'claude', support: 'native', evidence: 'docs/skills.md' }],
  };
}

let root: string;
let repo: string;
let bare: string;

/** Simulate what the install route would have written into the worktree. */
function writeInstalledPayload(): void {
  const receipt = makeReceipt();
  for (const installRoot of receipt.install_roots ?? []) {
    for (const file of PAYLOAD) {
      const target = path.join(repo, installRoot, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf-8');
    }
    writeFileSync(
      path.join(repo, installRoot, SKILL_RECEIPT_FILENAME),
      JSON.stringify(receipt, null, 2),
      'utf-8'
    );
  }
}

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(
    `http://localhost/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/git-workflow`,
    { method: 'POST', body: JSON.stringify(body) }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID, skillId: SKILL_ID }) });
}

async function prepare(
  overrides: Record<string, unknown> = {}
): Promise<{ status: number; json: { workflowToken?: string; code?: string } }> {
  const response = await post({
    phase: 'prepare',
    mode: 'dedicated_branch',
    version: VERSION,
    push: true,
    ...overrides,
  });
  return { status: response.status, json: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isSessionRunning).mockResolvedValue(false);
  vi.mocked(findOpenPullRequest).mockResolvedValue(null);
  vi.mocked(createDraftPullRequest).mockResolvedValue({
    ok: true,
    url: 'https://github.com/Kewton/CommandMate/pull/9999',
  });
  resetSkillGitWorkflowTargetsForTesting();

  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-skill-gitflow-')));
  bare = path.join(root, 'origin.git');
  repo = path.join(root, 'worktree');
  mkdirSync(bare);
  mkdirSync(repo);

  git(bare, ['init', '--bare', '-q', '-b', 'main']);
  git(repo, ['init', '-b', 'main', '-q']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'user.name', 'CommandMate Test']);
  git(repo, ['config', 'user.email', 'test@commandmate.invalid']);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf-8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);

  vi.mocked(getWorktreeById).mockReturnValue({
    id: WORKTREE_ID,
    name: 'demo',
    path: repo,
    repositoryPath: root,
    repositoryName: 'demo-repo',
  } as ReturnType<typeof getWorktreeById>);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// =============================================================================
// Happy path
// =============================================================================

describe('POST git-workflow — dedicated branch, push and PR', () => {
  it('commits the payload from both roots, pushes it and opens a draft PR', async () => {
    const prepared = await prepare();
    expect(prepared.status).toBe(200);
    expect(prepared.json.workflowToken).toMatch(/^[0-9a-f]{48}$/);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH);

    writeInstalledPayload();

    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: true,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.result.committed).toBe(true);
    expect(body.result.pushed).toBe(true);
    expect(body.result.pullRequestUrl).toBe('https://github.com/Kewton/CommandMate/pull/9999');
    expect(body.result.changedPaths).toContain(
      `${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}/SKILL.md`
    );

    // The commit really reached the bare remote, with both roots inside it.
    const remoteFiles = git(bare, ['show', '--name-only', '--format=', `${BRANCH}`])
      .split('\n')
      .filter((line) => line.length > 0);
    expect(remoteFiles).toContain(`${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_ID}/SKILL.md`);
    expect(remoteFiles).toContain(`${SKILL_CLAUDE_INSTALL_ROOT_PREFIX}/${SKILL_ID}/SKILL.md`);
    expect(remoteFiles).not.toContain('README.md');

    // The PR body reviewers see carries the provenance, not a diff hunk.
    const prArgs = vi.mocked(createDraftPullRequest).mock.calls[0][0];
    expect(prArgs.head).toBe(BRANCH);
    expect(prArgs.base).toBe('main');
    expect(prArgs.body).toContain(SOURCE_COMMIT);
    expect(prArgs.body).toContain(makeReceipt().artifact.sha256);
    expect(prArgs.body).not.toContain(repo);
  });

  it('returns the existing PR instead of opening a second one', async () => {
    vi.mocked(findOpenPullRequest).mockResolvedValue(
      'https://github.com/Kewton/CommandMate/pull/1'
    );
    const prepared = await prepare();
    writeInstalledPayload();

    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: true,
    });
    const body = await response.json();

    expect(body.result.pullRequestExisted).toBe(true);
    expect(body.result.pullRequestUrl).toBe('https://github.com/Kewton/CommandMate/pull/1');
    expect(createDraftPullRequest).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Failure separation
// =============================================================================

describe('POST git-workflow — failures stay distinguishable', () => {
  it('reports a push failure after the commit is already local', async () => {
    const prepared = await prepare();
    writeInstalledPayload();
    // The remote disappears between prepare and apply.
    rmSync(bare, { recursive: true, force: true });

    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: true,
    });
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('SKILL_GIT_PUSH_FAILED');

    // The commit is on the branch: "installed and committed, not pushed".
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain(`install ${SKILL_ID}`);
    expect(createDraftPullRequest).not.toHaveBeenCalled();
  });

  it('reports a PR failure after the push succeeded', async () => {
    vi.mocked(createDraftPullRequest).mockResolvedValue({
      ok: false,
      reason: 'failed',
      detail: 'GraphQL: pull request already exists',
    });
    const prepared = await prepare();
    writeInstalledPayload();

    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: true,
    });
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('SKILL_GIT_PR_FAILED');
    // Pushed anyway: the branch exists on the remote and can be retried.
    expect(git(bare, ['rev-parse', '--verify', `refs/heads/${BRANCH}`])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a missing gh separately from a failed one', async () => {
    vi.mocked(createDraftPullRequest).mockResolvedValue({
      ok: false,
      reason: 'tool_missing',
      detail: 'gh is not installed',
    });
    const prepared = await prepare();
    writeInstalledPayload();

    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: true,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_GIT_PR_TOOL_MISSING');
  });

  it('recovers on retry: the second apply pushes without re-committing', async () => {
    const prepared = await prepare();
    writeInstalledPayload();
    rmSync(bare, { recursive: true, force: true });
    await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: false,
    });

    // The remote comes back and the same token is applied again.
    mkdirSync(bare);
    git(bare, ['init', '--bare', '-q', '-b', 'main']);
    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: true,
      createPullRequest: false,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.committed).toBe(false);
    expect(body.result.pushed).toBe(true);
    expect(git(repo, ['rev-list', '--count', BRANCH])).toBe('2');
  });
});

// =============================================================================
// Preconditions and input policy
// =============================================================================

describe('POST git-workflow — preconditions', () => {
  it('refuses to start with an unrelated staged change', async () => {
    writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=abc\n', 'utf-8');
    git(repo, ['add', 'secret.env']);

    const prepared = await prepare();
    expect(prepared.status).toBe(409);
    expect(prepared.json.code).toBe('SKILL_GIT_INDEX_NOT_CLEAN');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('refuses to push the default branch in current_branch mode', async () => {
    const prepared = await prepare({ mode: 'current_branch' });
    expect(prepared.status).toBe(409);
    expect(prepared.json.code).toBe('SKILL_GIT_PROTECTED_BRANCH');
  });

  it('refuses to switch branches under a live Agent session', async () => {
    vi.mocked(isSessionRunning).mockResolvedValue(true);
    const { getAgentInstances } = await import('@/lib/db');
    vi.mocked(getAgentInstances).mockReturnValue([
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    ]);

    const prepared = await prepare();
    expect(prepared.status).toBe(409);
    expect(prepared.json.code).toBe('SKILL_GIT_ACTIVE_SESSION');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('rejects a client-supplied branch or pathspec outright', async () => {
    for (const field of ['branch', 'paths', 'commitMessage', 'force']) {
      const response = await post({
        phase: 'prepare',
        mode: 'dedicated_branch',
        version: VERSION,
        push: false,
        [field]: 'main',
      });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('SKILL_GIT_INPUT_REJECTED');
    }
  });

  it('rejects an apply that names an unknown target', async () => {
    const response = await post({
      phase: 'apply',
      workflowToken: 'f'.repeat(48),
      push: false,
      createPullRequest: false,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_GIT_TARGET_DRIFTED');
  });

  it('rejects a pull request without a push', async () => {
    const prepared = await prepare({ push: false });
    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: false,
      createPullRequest: true,
    });
    expect(response.status).toBe(400);
  });

  it('refuses to commit when the install left no receipt', async () => {
    const prepared = await prepare({ push: false });
    const response = await post({
      phase: 'apply',
      workflowToken: prepared.json.workflowToken,
      push: false,
      createPullRequest: false,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_GIT_RECEIPT_UNREADABLE');
  });
});
