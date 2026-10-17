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
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => logger,
}));
vi.mock('@/lib/session/agent-event-state', () => ({
  getAgentEventGenerationStartedAt: vi.fn(() => 1_800_000_000_000),
}));
vi.mock('@/lib/prompt-observation/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/prompt-observation/session')>();
  return { ...original, observeSession: vi.fn(original.observeSession) };
});
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
import { observeSession } from '@/lib/prompt-observation/session';
import { getAgentEventGenerationStartedAt } from '@/lib/session/agent-event-state';

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
    expect(body.promptObservation.screen.tokenWithheld).toBeNull();
  });

  it('issues no token for a session this server did not create (no generation)', async () => {
    vi.mocked(getAgentEventGenerationStartedAt).mockReturnValueOnce(null);
    const body = await (await GET(request('?observe=1'), params)).json();
    expect(body.promptObservation.screen.kind).toBe('antigravity-trust');
    expect(body.promptObservation.screen.token).toBeNull();
    expect(body.promptObservation.screen.tokenWithheld).toBe('no-session-generation');
  });

  it('negative: an observation that throws leaves the field off, not the payload', async () => {
    vi.mocked(observeSession).mockImplementationOnce(() => {
      throw new Error('reader failed');
    });
    const response = await GET(request('?observe=1'), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect('promptObservation' in body).toBe(false);
    expect(body.sessionStatus).toBe('waiting');
    expect(body.fullOutput).toBe(TRUST);
    expect(logger.warn).toHaveBeenCalledWith('prompt-observation-failed:', {
      worktreeId: 'wt-1',
      error: 'reader failed',
    });
    // The frame is not logged.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('trust');
  });
});
