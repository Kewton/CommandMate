/**
 * Assistant context builder unit tests
 * Issue #649: Test buildGlobalContext and getEnabledRepositories
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Repository } from '@/lib/db/db-repository';

// Mock getAllRepositories
const mockGetAllRepositories = vi.fn();
vi.mock('@/lib/db/db-repository', () => ({
  getAllRepositories: (...args: unknown[]) => mockGetAllRepositories(...args),
}));

// Mock getWorktrees (context builder reports worktree counts and an active snapshot)
const mockGetWorktrees = vi.fn();
vi.mock('@/lib/db/worktree-db', () => ({
  getWorktrees: (...args: unknown[]) => mockGetWorktrees(...args),
}));

import { buildGlobalContext, getEnabledRepositories } from '@/lib/assistant/context-builder';

// Create a mock DB instance
const mockDb = {} as Parameters<typeof buildGlobalContext>[1];

function createMockRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'test-id',
    name: 'test-repo',
    path: '/path/to/repo',
    enabled: true,
    visible: true,
    cloneSource: 'local' as const,
    isEnvManaged: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('buildGlobalContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorktrees.mockReturnValue([]);
  });

  it('should include the CLI tool display name', () => {
    mockGetAllRepositories.mockReturnValue([]);

    const context = buildGlobalContext('claude', mockDb);

    expect(context).toContain('Claude');
  });

  it('should include repository information when repos exist', () => {
    mockGetAllRepositories.mockReturnValue([
      createMockRepository({ name: 'my-project', path: '/home/user/my-project' }),
    ]);

    const context = buildGlobalContext('claude', mockDb);

    expect(context).toContain('Registered Repositories');
    expect(context).toContain('my-project');
    expect(context).toContain('/home/user/my-project');
  });

  it('should show displayName when available', () => {
    mockGetAllRepositories.mockReturnValue([
      createMockRepository({
        name: 'my-project',
        displayName: 'My Awesome Project',
        path: '/home/user/my-project',
      }),
    ]);

    const context = buildGlobalContext('claude', mockDb);

    expect(context).toContain('My Awesome Project');
  });

  it('should indicate disabled repositories', () => {
    mockGetAllRepositories.mockReturnValue([
      createMockRepository({
        name: 'disabled-repo',
        path: '/home/user/disabled-repo',
        enabled: false,
      }),
    ]);

    const context = buildGlobalContext('claude', mockDb);

    expect(context).toContain('disabled-repo');
    // Repositories table now uses an Enabled column with yes/no
    expect(context).toMatch(/disabled-repo.*\|.*no/);
  });

  it('should show message when no repositories exist', () => {
    mockGetAllRepositories.mockReturnValue([]);

    const context = buildGlobalContext('claude', mockDb);

    expect(context).toContain('No repositories are currently registered');
  });

  it('should work with different CLI tool types', () => {
    mockGetAllRepositories.mockReturnValue([]);

    const claudeContext = buildGlobalContext('claude', mockDb);
    const codexContext = buildGlobalContext('codex', mockDb);
    const geminiContext = buildGlobalContext('gemini', mockDb);

    expect(claudeContext).toContain('Claude');
    expect(codexContext).toContain('Codex');
    expect(geminiContext).toContain('Gemini');
  });

  it('should list multiple repositories', () => {
    mockGetAllRepositories.mockReturnValue([
      createMockRepository({ name: 'repo-a', path: '/path/a' }),
      createMockRepository({ name: 'repo-b', path: '/path/b' }),
      createMockRepository({ name: 'repo-c', path: '/path/c' }),
    ]);

    const context = buildGlobalContext('claude', mockDb);

    expect(context).toContain('repo-a');
    expect(context).toContain('repo-b');
    expect(context).toContain('repo-c');
    expect(context).toContain('/path/a');
    expect(context).toContain('/path/b');
    expect(context).toContain('/path/c');
  });
});

describe('getEnabledRepositories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return only enabled repositories', () => {
    mockGetAllRepositories.mockReturnValue([
      createMockRepository({ name: 'enabled', enabled: true }),
      createMockRepository({ name: 'disabled', enabled: false }),
      createMockRepository({ name: 'also-enabled', enabled: true }),
    ]);

    const result = getEnabledRepositories(mockDb);

    expect(result.length).toBe(2);
    expect(result.map(r => r.name)).toEqual(['enabled', 'also-enabled']);
  });

  it('should return empty array when no repos are enabled', () => {
    mockGetAllRepositories.mockReturnValue([
      createMockRepository({ enabled: false }),
    ]);

    const result = getEnabledRepositories(mockDb);

    expect(result.length).toBe(0);
  });

  it('should return empty array when no repos exist', () => {
    mockGetAllRepositories.mockReturnValue([]);

    const result = getEnabledRepositories(mockDb);

    expect(result.length).toBe(0);
  });
});
/**
 * Issue #1914: the CLI reference handed to an assistant session was stale.
 *
 * It described `--agent NAME` as the way to name a target — the secondary form
 * since Issue #1638 — and omitted `instances`, `verify`, `sync` and
 * `send --contract` entirely. An assistant driving a worktree from that text
 * writes `wait --agent codex`, a flag `wait` does not have.
 *
 * These are presence assertions over generated prose, so each one names a
 * string that must appear; deleting the corresponding line from
 * `buildCommandMateCliReference` turns the case red.
 */
describe('CommandMate CLI reference (Issue #1914)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllRepositories.mockReturnValue([]);
    mockGetWorktrees.mockReturnValue([]);
  });

  function reference(): string {
    return buildGlobalContext('claude', mockDb);
  }

  it.each([
    ['instances', 'instances <worktree-id> [list|add|remove|alias|kill]'],
    ['verify', 'verify <worktree-id> [--gates a,b]'],
    ['sync', 'sync [--json]`'],
    ['send --contract', '--contract <path>'],
  ])('documents the %s surface', (_name, needle) => {
    expect(reference()).toContain(needle);
  });

  it('presents --instance as the way to name a target', () => {
    const text = reference();
    expect(text).toContain('`--instance <id>`');
    expect(text).toContain('send`');
    // The flag is on the commands that accept it, not only in the prose.
    expect(text).toContain('wait <worktree-id>... [--timeout N] [--stall-timeout N] [--on-prompt agent|human] [--instance ID]');
  });

  it('marks --agent as the ad-hoc form and records that wait has none', () => {
    const text = reference();
    expect(text).toContain('Issue #1638');
    expect(text).toContain('ad-hoc');
    expect(text).toContain('`wait` has no `--agent` at all');
  });

  it('does not advertise --agent on the targeting commands', () => {
    const text = reference();
    // The pre-#1914 spellings, one per command line.
    for (const stale of [
      'send <worktree-id> "message" [--agent NAME]',
      'respond <worktree-id> "answer" [--agent NAME]',
      'capture <worktree-id> [--json] [--agent NAME]',
    ]) {
      expect(text).not.toContain(stale);
    }
  });

  it('lists all seven CLI tools', () => {
    const text = reference();
    for (const tool of [
      'claude',
      'codex',
      'gemini',
      'vibe-local',
      'opencode',
      'copilot',
      'antigravity',
    ]) {
      expect(text).toContain(`\`${tool}\``);
    }
  });
});
