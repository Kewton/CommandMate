/**
 * Integration tests for worktree-specific slash commands API (Issue #56)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Mock the database functions
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

describe('GET /api/worktrees/[id]/slash-commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return 404 when worktree is not found', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue(null);

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/non-existent/slash-commands');
    const response = await GET(request, { params: Promise.resolve({ id: 'non-existent' }) });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 400 for invalid worktree path', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: 'test-id',
      name: 'test',
      path: '../../../etc/passwd', // Invalid path
      repositoryPath: '/test',
      repositoryName: 'test',
      cliToolId: 'claude',
    });

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/test-id/slash-commands');
    const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree configuration');
  });

  it('should return merged command groups for valid worktree', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: 'test-id',
      name: 'test',
      path: '/Users/test/projects/my-project',
      repositoryPath: '/Users/test/projects/my-project',
      repositoryName: 'my-project',
      cliToolId: 'claude',
    });

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/test-id/slash-commands');
    const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('groups');
    expect(data).toHaveProperty('sources');
    expect(Array.isArray(data.groups)).toBe(true);
    // Should include standard commands even if no worktree-specific commands
    expect(data.sources.standard).toBeGreaterThan(0);
    // Issue #343: sources should include skill property
    expect(data.sources).toHaveProperty('skill');
    expect(typeof data.sources.skill).toBe('number');
  });

  it('should return Codex shared commands when cliTool=codex', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: 'test-id',
      name: 'test',
      path: '/Users/test/projects/my-project',
      repositoryPath: '/Users/test/projects/my-project',
      repositoryName: 'my-project',
      cliToolId: 'codex',
    });

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/test-id/slash-commands?cliTool=codex');
    const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    const allNames = data.groups.flatMap((group: { commands: Array<{ name: string }> }) =>
      group.commands.map((command) => command.name)
    );

    expect(allNames).toContain('clear');
    expect(allNames).toContain('model');
    expect(allNames).toContain('status');
    expect(allNames).toContain('review');
    expect(allNames).not.toContain('context');
  });

  it('should return Gemini builtins and gemini-tagged worktree commands when cliTool=gemini', async () => {
    const testDir = path.resolve(__dirname, '../fixtures/test-gemini-worktree-slash-commands');
    const commandsDir = path.join(testDir, '.claude', 'commands');

    try {
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(
        path.join(commandsDir, 'gemini-shared.md'),
        [
          '---',
          'description: Shared with Gemini',
          'cliTools:',
          '  - gemini',
          '---',
          'Content',
        ].join('\n')
      );

      const { getWorktreeById } = await import('@/lib/db');
      vi.mocked(getWorktreeById).mockReturnValue({
        id: 'test-id',
        name: 'test',
        path: testDir,
        repositoryPath: testDir,
        repositoryName: 'my-project',
        cliToolId: 'gemini',
      });

      const { GET } = await import(
        '@/app/api/worktrees/[id]/slash-commands/route'
      );

      const request = new NextRequest('http://localhost:3000/api/worktrees/test-id/slash-commands?cliTool=gemini');
      const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });

      expect(response.status).toBe(200);
      const data = await response.json();
      const allNames = data.groups.flatMap((group: { commands: Array<{ name: string }> }) =>
        group.commands.map((command) => command.name)
      );

      expect(allNames).toContain('model');
      expect(allNames).toContain('help');
      expect(allNames).toContain('quit');
      expect(allNames).toContain('commands reload');
      expect(allNames).toContain('memory reload');
      expect(allNames).toContain('gemini-shared');
      expect(allNames).not.toContain('context');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
