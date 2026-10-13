/**
 * A `GET /api/worktrees` payload for the New task suites (Issue #3511).
 *
 * Shaped like the route's rows: `agentInstances`, `sessionStatusByInstance`
 * and `autoYesByInstance` filled in per instance, `repositories` alongside.
 */

import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

export const AUTO_YES_EXPIRES_AT = Date.now() + 42 * 60 * 1000;

const idle = { isWaitingForResponse: false, isProcessing: false };

export function buildWorktrees(): Worktree[] {
  return [
    {
      id: 'wt-a-main',
      name: 'main',
      path: '/repo/alpha',
      repositoryPath: '/repo/alpha',
      repositoryName: 'alpha',
      cliToolId: 'claude',
      agentInstances: [
        { id: 'codex-2', cliTool: 'codex', alias: 'Reviewer', order: 1 },
        { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      ],
      sessionStatusByInstance: {
        claude: { isRunning: true, ...idle },
        'codex-2': { isRunning: false, ...idle },
      },
      autoYesByInstance: { claude: { enabled: true, expiresAt: AUTO_YES_EXPIRES_AT } },
    },
    {
      id: 'wt-a-feat',
      name: 'feature/x',
      path: '/repo/alpha-x',
      repositoryPath: '/repo/alpha',
      repositoryName: 'alpha',
      cliToolId: 'claude',
      agentInstances: [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }],
      sessionStatusByInstance: {},
      autoYesByInstance: {},
    },
    {
      id: 'wt-b-main',
      name: 'main',
      path: '/repo/beta',
      repositoryPath: '/repo/beta',
      repositoryName: 'beta',
      cliToolId: 'copilot',
      agentInstances: [
        { id: 'copilot', cliTool: 'copilot', alias: '', order: 0 },
        { id: 'antigravity', cliTool: 'antigravity', alias: '', order: 1 },
        { id: 'gemini', cliTool: 'gemini', alias: '', order: 2 },
      ],
      sessionStatusByInstance: {
        copilot: { isRunning: true, ...idle },
        antigravity: { isRunning: true, ...idle, startingSince: Date.now() - 1000 },
      },
      autoYesByInstance: {},
    },
  ];
}

export function buildRepositories(): RepositorySummary[] {
  return [
    { path: '/repo/alpha', name: 'alpha', displayName: 'Alpha', worktreeCount: 2, visible: true, enabled: true },
    { path: '/repo/beta', name: 'beta', worktreeCount: 1, visible: true, enabled: true },
  ];
}

/** A JSON response the way `fetchApi` / `fetchApiResponse` read one. */
export function jsonResponse(body: unknown, status = 200, url = 'http://localhost/api'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}
