/**
 * `?observe=1` on GET /api/worktrees/[id]/current-output (Issue #3755).
 *
 * Opt-in: without the parameter the response is exactly what it was (this is
 * every pane's 5-second poll), and with it the same payload carries one prompt
 * observation read off the same capture.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => ({ id: 'wt-1', path: '/work/wt-1' })) }));
vi.mock('@/lib/security/path-validator', () => ({ isValidWorktreeId: vi.fn(() => true) }));
vi.mock('@/lib/git/git-route-worktree', () => ({ canonicalWorktreeId: (id: string) => id }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'own' })),
  foreignSessionErrorBody: vi.fn(),
}));
vi.mock('@/lib/session/resolve-session-target', () => ({
  resolveSessionTarget: vi.fn(() => ({
    cliToolId: 'antigravity',
    instanceId: undefined,
    resolvedBy: 'worktree-default',
    conflict: null,
  })),
}));
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicyEntry: vi.fn(() => ({ policy: null, taskId: null })),
}));
vi.mock('@/lib/detection/version-probes', () => ({
  getDetectorStalenessSnapshot: () => undefined,
}));

const TRUST = readFileSync(
  path.resolve(__dirname, '../../../fixtures/prompt-observation-3755/antigravity-trust.txt'),
  'utf8',
);

vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => ({
    isRunning: true,
    cliToolId: 'antigravity',
    sessionName: 'mcbd-antigravity-wt-1',
    sessionStatus: 'waiting',
    sessionStatusReason: 'antigravity_selection_list',
    content: '',
    fullOutput: TRUST,
    isPromptWaiting: false,
    promptData: null,
    isSelectionListActive: true,
    autoYes: { enabled: false, expiresAt: null, lastSuppression: null, lastEnterFallback: null },
    serverPollerActive: false,
  })),
}));

import { GET } from '@/app/api/worktrees/[id]/current-output/route';

const params = { params: Promise.resolve({ id: 'wt-1' }) };
const request = (query = '') =>
  new NextRequest(`http://localhost:3000/api/worktrees/wt-1/current-output${query}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#3755] GET /current-output?observe=1', () => {
  it('publishes no observation unless asked', async () => {
    const body = await (await GET(request(), params)).json();
    expect('promptObservation' in body).toBe(false);
    expect(body.sessionStatus).toBe('waiting');
  });

  it('adds the observation of the same capture when asked', async () => {
    const body = await (await GET(request('?observe=1'), params)).json();
    expect(body.sessionStatus).toBe('waiting');
    expect(body.promptObservation).toMatchObject({
      schemaVersion: 1,
      status: 'observed',
      target: {
        worktreeId: 'wt-1',
        cliToolId: 'antigravity',
        instanceId: 'antigravity',
        sessionName: 'mcbd-antigravity-wt-1',
        resolvedBy: 'worktree-default',
      },
      screen: { kind: 'antigravity-trust', selectedPosition: 1 },
      autoYes: { enabled: false, pollerActive: false, pollerRecord: null },
    });
    expect(body.promptObservation.screen.token).toMatch(/^po1\./);
  });
});
