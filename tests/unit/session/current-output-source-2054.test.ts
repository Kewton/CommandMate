/**
 * `structuredEvents.source`, extended without breaking what #1924 put there
 * (Issue #2054).
 *
 * Two things are being defended at once and they pull in opposite directions:
 *
 *  1. The block has to grow — `capture --json` is the only place the operator
 *     can see that opencode's stream is gone, because the terminal frame looks
 *     the same either way.
 *  2. The two fields #1924 published must be byte-identical, and every push
 *     tool's block must gain nothing but the one field that is always
 *     derivable. A `liveness: 'stale'` on claude would be a warning about an
 *     unmeasurable, on every pane in the app.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...args: unknown[]) => isRunning(...args) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:opencode'),
}));

vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>();
  return {
    ...actual,
    getOpencodeLiveness: vi.fn(() => ({ state: 'unknown' })),
    getOpencodeProbedActivity: vi.fn(() => null),
  };
});

import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  getOpencodeLiveness,
  getOpencodeProbedActivity,
} from '@/lib/hooks/sources/opencode/subscription';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const db = {} as Database.Database;
const FRAME = 'a line of prose that matches nothing in particular';

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(FRAME);
  vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'unknown' });
  vi.mocked(getOpencodeProbedActivity).mockReturnValue(null);
});

describe('[#2054] the two fields #1924 published are untouched', () => {
  it('still carries the source’s own id and its declared block, for every tool', async () => {
    for (const cliToolId of CLI_TOOL_IDS) {
      const payload = await buildCurrentOutput(db, 'wt-1', cliToolId, cliToolId);
      expect(payload.structuredEvents.source.cliToolId).toBe(cliToolId);
      expect(payload.structuredEvents.source.capabilities).toEqual(
        getAgentEventSource(cliToolId).capabilities
      );
    }
  });

  it('does not change a single declared capability value', async () => {
    // #2053 owns the 6x5 capability pin. This Issue must not move a row of it.
    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    expect(payload.structuredEvents.source.capabilities.resync).toBe('session-status-poll');
    expect(payload.structuredEvents.source.capabilities.eventIdentity).toBe('permission-id');
    expect(payload.structuredEvents.source.capabilities.permissionReplyReleasesPrompt).toBe(true);
  });
});

describe('[#2054] the new fields', () => {
  it('gives a push tool a kind and nothing that implies it was measured', async () => {
    for (const cliToolId of ['claude', 'codex', 'gemini', 'copilot', 'antigravity'] as const) {
      const payload = await buildCurrentOutput(db, 'wt-1', cliToolId, cliToolId);
      expect(payload.structuredEvents.source.kind).toBe('hooks');
      expect(payload.structuredEvents.source.liveness).toBeUndefined();
      expect(payload.structuredEvents.source.degradedReason).toBeUndefined();
      expect(payload.structuredEvents.source.probedActivity).toBeNull();
    }
  });

  it('calls a tool with no source of its own a scraper', async () => {
    const payload = await buildCurrentOutput(db, 'wt-1', 'vibe-local', 'vibe-local');
    expect(payload.structuredEvents.source.kind).toBe('scraper');
    // Still nothing that reads as a measurement: nobody asked this tool anything.
    expect(payload.structuredEvents.source.liveness).toBeUndefined();
    expect(payload.structuredEvents.source.degradedReason).toBeUndefined();
  });

  it('reports a live opencode stream as sse', async () => {
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'live',
      lastHeartbeatAt: Date.now(),
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    expect(payload.structuredEvents.source.kind).toBe('sse');
    expect(payload.structuredEvents.source.liveness).toBe('live');
    expect(payload.structuredEvents.source.degradedReason).toBeUndefined();
  });

  it('reports a stolen port as scraper, naming the reason the transport recorded', async () => {
    // The measured state: opencode 1.18.22 on an isolated HOME, its port handed
    // to a second process answering a different `version`. See §25.
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'lost',
      since: Date.now(),
      reason: 'port_identity_changed',
    });

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    expect(payload.structuredEvents.source.kind).toBe('scraper');
    expect(payload.structuredEvents.source.liveness).toBe('stale');
    expect(payload.structuredEvents.source.degradedReason).toBe('port_identity_changed');
  });

  it('asks liveness about the instance it was asked about, not about the tool', async () => {
    // An alias instance has its own stream. Reading the primary’s would report
    // one pane’s disconnection against another’s.
    await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode-2');

    expect(vi.mocked(getOpencodeLiveness)).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      cliToolId: 'opencode',
      instanceId: 'opencode-2',
    });
  });

  it('publishes the post-attach probe, with the instant it was taken', async () => {
    vi.mocked(getOpencodeProbedActivity).mockReturnValue({ activity: 'busy', at: 1_700_000_000_000 });

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    expect(payload.structuredEvents.source.probedActivity).toEqual({
      activity: 'busy',
      at: 1_700_000_000_000,
    });
  });

  it('is present on the payload of a session that is not running', async () => {
    // The stopped-session early return builds the payload separately, and a
    // field missing there reads as `undefined` exactly when an operator is
    // asking why nothing was recorded.
    isRunning.mockResolvedValue(false);

    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');

    expect(payload.isRunning).toBe(false);
    expect(payload.structuredEvents.source.kind).toBe('scraper');
    expect(payload.structuredEvents.source.degradedReason).toBe('not_subscribed');
  });
});
