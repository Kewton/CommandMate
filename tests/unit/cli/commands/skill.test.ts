/**
 * skill Command Tests
 * Issue #1237
 *
 * Every test drives the command through mocked fetch. Nothing here contacts a
 * real server: the official Skill repository is private and the Catalog is not
 * published, so a network-dependent test would be untrustworthy by construction.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

/** Answer the next stderr confirmation prompt with this string. */
let promptAnswer = 'n';

vi.mock('readline', () => ({
  createInterface: () => ({
    question: (_query: string, callback: (answer: string) => void) => callback(promptAnswer),
    close: () => {},
  }),
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  promptAnswer = 'n';
  process.stdin.isTTY = undefined as unknown as boolean;
});

afterEach(() => {
  restoreFetch();
  process.stdin.isTTY = originalIsTTY;
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

async function loadCommand() {
  const { createSkillCommand } = await import('../../../../src/cli/commands/skill');
  return createSkillCommand();
}

function run(argv: string[]): Promise<unknown> {
  return loadCommand().then((cmd) => cmd.parseAsync(['node', 'skill', ...argv]));
}

// =============================================================================
// Fixtures
// =============================================================================

const catalogMeta = {
  stale: false,
  offline: false,
  state: 'fresh',
  staleReason: null,
  fetchedAt: '2026-07-20T00:00:00Z',
  revalidatedAt: '2026-07-20T00:00:00Z',
  source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: 'abc' },
};

const catalogSkill = {
  id: 'cmate-repository-analysis',
  name: 'Repository Analysis',
  summary: 'Analyze a repository.',
  provider: { name: 'CommandMate' },
  license: 'MIT',
  homepage: null,
  latest: '1.2.0',
  recommendedVersion: '1.2.0',
  recommendedReason: 'SKILL_RECOMMENDATION_LATEST_COMPATIBLE',
  compatibility: { status: 'compatible', message: 'ok', requiredRange: '>=1.0.0' },
  versions: [
    {
      version: '1.2.0',
      declaredRisk: 'low',
      prerelease: false,
      publishedAt: '2026-07-01T00:00:00Z',
      compatibility: { commandmate: { status: 'compatible', message: 'ok', requiredRange: '>=1.0.0' } },
    },
  ],
};

function installPlan(overrides: Record<string, unknown> = {}) {
  return {
    plan: {
      token: 'a'.repeat(48),
      expiresAt: '2026-07-20T00:10:00Z',
      installable: true,
      requiresRiskAcknowledgement: false,
      riskAcknowledged: false,
      blockers: [],
      warnings: [],
      target: {
        worktreeId: 'anvil-develop',
        worktreeName: 'develop',
        repositoryName: 'anvil',
        branch: 'develop',
        headState: 'attached',
        workingTreeDirty: false,
        installRoot: '.agents/skills/cmate-repository-analysis',
        existingInstall: null,
      },
      skill: {
        id: 'cmate-repository-analysis',
        name: 'Repository Analysis',
        version: '1.2.0',
        summary: 'Analyze a repository.',
        license: 'MIT',
        declaredPermissions: ['filesystem_read'],
        effectiveRisk: 'low',
        riskRationale: 'read-only',
        scriptPaths: [],
        executablePaths: [],
        requirements: { commands: [], networkHosts: [] },
        compatibility: {
          commandmate: { status: 'compatible', message: 'ok', requiredRange: '>=1.0.0' },
          agents: [],
        },
      },
      stats: { added: 3, modified: 0, unchanged: 0, conflicted: 0, unmanaged: 0 },
      ...overrides,
    },
  };
}

function highRiskPlan() {
  const base = installPlan();
  base.plan.requiresRiskAcknowledgement = true;
  base.plan.skill.effectiveRisk = 'high';
  return base;
}

const installResult = {
  operation: {
    operationId: 'op-1',
    state: 'SUCCEEDED',
    result: 'succeeded',
    committed: true,
    reconcilePending: false,
    nextActionKey: 'skills.install.succeeded',
    replayed: false,
  },
  install: {
    skillId: 'cmate-repository-analysis',
    version: '1.2.0',
    installRoot: '.agents/skills/cmate-repository-analysis',
    files: [{ path: '.agents/skills/cmate-repository-analysis/SKILL.md' }],
  },
};

function uninstallPlan(overrides: Record<string, unknown> = {}) {
  return {
    plan: {
      token: 'b'.repeat(48),
      expiresAt: '2026-07-20T00:10:00Z',
      removable: true,
      blockers: [],
      nextActionKey: 'skills.uninstall.removable',
      target: {
        worktreeId: 'anvil-develop',
        worktreeName: 'develop',
        repositoryName: 'anvil',
        branch: 'develop',
        workingTreeDirty: false,
        installRoot: '.agents/skills/cmate-repository-analysis',
      },
      skill: { id: 'cmate-repository-analysis', version: '1.2.0', effectiveRisk: 'low' },
      removals: [{ path: '.agents/skills/cmate-repository-analysis/SKILL.md' }],
      retained: [],
      stats: { removable: 2, modified: 0, missing: 0, unknown: 0, irregular: 0 },
      ...overrides,
    },
  };
}

const uninstallResult = {
  operation: {
    operationId: 'op-2',
    state: 'SUCCEEDED',
    result: 'succeeded',
    committed: true,
    reconcilePending: false,
    nextActionKey: 'skills.uninstall.succeeded',
    replayed: false,
  },
  uninstall: {
    skillId: 'cmate-repository-analysis',
    version: '1.2.0',
    installRoot: '.agents/skills/cmate-repository-analysis',
    removedFiles: [],
    retained: [],
    fullyRemoved: true,
  },
};

/** Body of the nth fetch call, parsed. */
function requestBody(index: number): Record<string, unknown> {
  const call = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[index];
  const init = call[1] as { body?: string };
  return init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
}

// =============================================================================
// Wiring
// =============================================================================

describe('createSkillCommand', () => {
  it('creates a Command named "skill" with every documented subcommand', async () => {
    const cmd = await loadCommand();
    expect(cmd.name()).toBe('skill');
    expect(cmd.commands.map((c) => c.name()).sort()).toEqual([
      'info',
      'install',
      'list',
      'plan',
      'status',
      'uninstall',
    ]);
  });

  it('spells out the confirmation contract and exit codes in `skill --help`', async () => {
    const cmd = await loadCommand();
    let out = '';
    cmd.configureOutput({ writeOut: (chunk) => { out += chunk; } });
    cmd.outputHelp();

    expect(out).toContain('--dry-run stops at the plan and writes nothing');
    expect(out).toContain('12  the write was never confirmed');
  });

  it('documents --ack-risk, --dry-run and --yes in `install --help`', async () => {
    const cmd = await loadCommand();
    const install = cmd.commands.find((c) => c.name() === 'install');
    const help = install?.helpInformation() ?? '';

    expect(help).toContain('--ack-risk');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--yes');
  });
});

// =============================================================================
// list / info
// =============================================================================

describe('skill list', () => {
  it('renders the Catalog as a table', async () => {
    mockFetchResponse({ catalog: catalogMeta, skills: [catalogSkill] });
    await run(['list']);

    const output = mockConsoleLog.mock.calls[0][0] as string;
    expect(output).toContain('SKILL_ID');
    expect(output).toContain('cmate-repository-analysis');
    expect(output).toContain('compatible');
  });

  it('prints the API response verbatim with --json', async () => {
    const body = { catalog: catalogMeta, skills: [catalogSkill] };
    mockFetchResponse(body);
    await run(['list', '--json']);

    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toEqual(body);
  });

  it('warns on stderr when the served Catalog is stale, keeping stdout pure JSON', async () => {
    const body = {
      catalog: { ...catalogMeta, stale: true, staleReason: 'SKILL_CATALOG_FETCH_FAILED' },
      skills: [catalogSkill],
    };
    mockFetchResponse(body);
    await run(['list', '--json']);

    expect(mockConsoleError.mock.calls[0][0]).toContain('SKILL_CATALOG_FETCH_FAILED');
    expect(() => JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).not.toThrow();
  });

  it('opts into prereleases only when --prerelease is passed', async () => {
    mockFetchResponse({ catalog: catalogMeta, skills: [] });
    await run(['list', '--prerelease']);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/skills?prerelease=true'),
      expect.anything()
    );
  });

  it('maps an unreachable Catalog to the dependency exit code', async () => {
    mockFetchResponse({ error: 'offline', code: 'SKILL_CATALOG_FETCH_FAILED' }, 503);
    await run(['list']);

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });
});

describe('skill info', () => {
  it('shows provider, versions and compatibility', async () => {
    mockFetchResponse({ catalog: catalogMeta, skill: catalogSkill });
    await run(['info', 'cmate-repository-analysis']);

    const output = mockConsoleLog.mock.calls[0][0] as string;
    expect(output).toContain('Repository Analysis');
    expect(output).toContain('1.2.0');
    expect(output).toContain('VERSION');
  });

  it('rejects a malformed Skill ID without contacting the server', async () => {
    mockFetchResponse({ catalog: catalogMeta, skill: catalogSkill });
    await run(['info', '../etc/passwd']);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// plan
// =============================================================================

describe('skill plan', () => {
  it('asks the server for a plan and prints the summary', async () => {
    mockFetchResponse(installPlan());
    await run(['plan', 'cmate-repository-analysis', '--worktree', 'anvil-develop', '--version', '1.2.0']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/api/worktrees/anvil-develop/skills/cmate-repository-analysis/plan'
      ),
      expect.objectContaining({ method: 'POST' })
    );
    expect(mockConsoleLog.mock.calls[0][0]).toContain('Install plan');
  });

  it('sends only what to install — never a path, URL, file list or checksum', async () => {
    mockFetchResponse(installPlan());
    await run(['plan', 'cmate-repository-analysis', '--worktree', 'anvil-develop', '--version', '1.2.0']);

    expect(requestBody(0)).toEqual({ version: '1.2.0' });
  });

  it('exits blocked when the plan reports it is not installable', async () => {
    mockFetchResponse(
      installPlan({ installable: false, blockers: [{ code: 'SKILL_DIFF_UNMANAGED_SKILL', path: 'a/b' }] })
    );
    await run(['plan', 'cmate-repository-analysis', '--worktree', 'anvil-develop']);

    expect(mockExit).toHaveBeenCalledWith(11);
  });

  it('requires --worktree', async () => {
    mockFetchResponse(installPlan());
    await run(['plan', 'cmate-repository-analysis']);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// install: the confirmation contract
// =============================================================================

describe('skill install: confirmation contract', () => {
  it('refuses to write from a non-TTY without --yes, after building the plan', async () => {
    mockFetchResponse(installPlan());
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0',
    ]);

    expect(mockExit).toHaveBeenCalledWith(12);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toContain('/plan');
  });

  it('installs from a non-TTY when --yes is given', async () => {
    mockFetchSequence([{ data: installPlan() }, { data: installResult }]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toContain('/install');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('presents the server-issued plan token unchanged and reconstructs nothing', async () => {
    mockFetchSequence([{ data: installPlan() }, { data: installResult }]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
    ]);

    expect(requestBody(1)).toEqual({
      planToken: 'a'.repeat(48),
      version: '1.2.0',
      acknowledgeRisk: false,
    });
  });

  it('prompts in a TTY and installs when the user accepts', async () => {
    process.stdin.isTTY = true;
    promptAnswer = 'y';
    mockFetchSequence([{ data: installPlan() }, { data: installResult }]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when the TTY prompt is declined', async () => {
    process.stdin.isTTY = true;
    promptAnswer = 'n';
    mockFetchResponse(installPlan());
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(12);
  });

  it('stops at the plan with --dry-run even when --yes is given', async () => {
    mockFetchResponse(installPlan());
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes', '--dry-run',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockConsoleLog.mock.calls[0][0]).toContain('Install plan');
  });

  it('requires an exact --version', async () => {
    mockFetchResponse(installPlan());
    await run(['install', 'cmate-repository-analysis', '--worktree', 'anvil-develop']);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the plan is not installable, before any confirmation', async () => {
    mockFetchResponse(
      installPlan({ installable: false, blockers: [{ code: 'SKILL_DIFF_UNMANAGED_SKILL', path: 'x' }] })
    );
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
    ]);

    expect(mockExit).toHaveBeenCalledWith(11);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('skill install: high-risk acknowledgement', () => {
  it('refuses a high-risk install carried by --yes alone', async () => {
    mockFetchResponse(highRiskPlan());
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
    ]);

    expect(mockExit).toHaveBeenCalledWith(12);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a high-risk install when --ack-risk names another version', async () => {
    mockFetchResponse(highRiskPlan());
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
      '--ack-risk', 'cmate-repository-analysis@1.1.0',
    ]);

    expect(mockExit).toHaveBeenCalledWith(12);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a high-risk install in a TTY even when the prompt is accepted', async () => {
    process.stdin.isTTY = true;
    promptAnswer = 'y';
    mockFetchResponse(highRiskPlan());
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0',
    ]);

    expect(mockExit).toHaveBeenCalledWith(12);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('installs a high-risk Skill when --ack-risk names it exactly', async () => {
    mockFetchSequence([{ data: highRiskPlan() }, { data: installResult }]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
      '--ack-risk', 'cmate-repository-analysis@1.2.0',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(1)).toMatchObject({ acknowledgeRisk: true });
  });
});

describe('skill install: outcomes', () => {
  it('reports a committed-but-reconciling install without calling it a failure', async () => {
    mockFetchSequence([
      { data: installPlan() },
      {
        data: {
          ...installResult,
          operation: {
            ...installResult.operation,
            state: 'FAILED_RECONCILABLE',
            result: 'committed_reconciling',
            reconcilePending: true,
            nextActionKey: 'skills.install.committedReconciling',
          },
        },
      },
    ]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
    ]);

    expect(mockConsoleLog.mock.calls[0][0]).toContain('Installed');
    expect(mockExit).toHaveBeenCalledWith(13);
  });

  it('maps a destination held by an unmanaged file to the blocked exit code', async () => {
    mockFetchSequence([
      { data: installPlan() },
      {
        data: { error: 'refused', code: 'SKILL_INSTALL_DESTINATION_UNMANAGED' },
        status: 409,
      },
    ]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes',
    ]);

    expect(mockExit).toHaveBeenLastCalledWith(11);
  });

  it('leaves stdout empty when a --json install fails', async () => {
    mockFetchSequence([
      { data: installPlan() },
      { data: { error: 'drifted', code: 'SKILL_PLAN_STALE' }, status: 409 },
    ]);
    await run([
      'install', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--version', '1.2.0', '--yes', '--json',
    ]);

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError.mock.calls.some((call) => String(call[0]).includes('SKILL_PLAN_STALE'))).toBe(true);
    expect(mockExit).toHaveBeenLastCalledWith(11);
  });
});

// =============================================================================
// uninstall
// =============================================================================

describe('skill uninstall', () => {
  it('refuses to delete from a non-TTY without --yes', async () => {
    mockFetchResponse(uninstallPlan());
    await run(['uninstall', 'cmate-repository-analysis', '--worktree', 'anvil-develop']);

    expect(mockExit).toHaveBeenCalledWith(12);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing but the plan token', async () => {
    mockFetchSequence([{ data: uninstallPlan() }, { data: uninstallResult }]);
    await run(['uninstall', 'cmate-repository-analysis', '--worktree', 'anvil-develop', '--yes']);

    expect(requestBody(0)).toEqual({});
    expect(requestBody(1)).toEqual({ planToken: 'b'.repeat(48) });
  });

  it('refuses a blocked uninstall and deletes nothing', async () => {
    mockFetchResponse(
      uninstallPlan({
        removable: false,
        blockers: [{ code: 'SKILL_UNINSTALL_LOCAL_MODIFICATION', path: 'a/SKILL.md' }],
        nextActionKey: 'skills.uninstall.blocked',
      })
    );
    await run(['uninstall', 'cmate-repository-analysis', '--worktree', 'anvil-develop', '--yes']);

    expect(mockExit).toHaveBeenCalledWith(11);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops at the plan with --dry-run', async () => {
    mockFetchResponse(uninstallPlan());
    await run([
      'uninstall', 'cmate-repository-analysis',
      '--worktree', 'anvil-develop', '--yes', '--dry-run',
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog.mock.calls[0][0]).toContain('Uninstall plan');
  });
});

// =============================================================================
// status
// =============================================================================

describe('skill status', () => {
  it('reports an installed Skill with its version and removability', async () => {
    mockFetchResponse(uninstallPlan());
    await run(['status', 'cmate-repository-analysis', '--worktree', 'anvil-develop']);

    const output = mockConsoleLog.mock.calls[0][0] as string;
    expect(output).toContain('1.2.0');
    expect(output).toContain('Removable:    yes');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('treats "not installed" as an answer, not a failure', async () => {
    mockFetchResponse(
      { error: 'nothing installed', code: 'SKILL_UNINSTALL_NOT_INSTALLED' },
      404
    );
    await run(['status', 'cmate-repository-analysis', '--worktree', 'anvil-develop', '--json']);

    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toEqual({
      skillId: 'cmate-repository-analysis',
      worktreeId: 'anvil-develop',
      installed: false,
    });
    expect(mockExit).not.toHaveBeenCalled();
  });
});
