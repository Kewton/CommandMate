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
