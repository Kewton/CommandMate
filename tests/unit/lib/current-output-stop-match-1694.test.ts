/** @vitest-environment node */

/**
 * Issue #1694: the stop-pattern excerpt has to reach `capture --json`.
 *
 * Storing it in `auto-yes-state` is not the deliverable — an operator triaging
 * a false positive reads `autoYes` off the capture payload, so these tests run
 * the real state module through `buildCurrentOutput` rather than stubbing the
 * state the builder reads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
// The poller half of the barrel drags tmux in; the state half is the point, so
// it is wired through for real.
vi.mock('@/lib/polling/auto-yes-manager', async () => {
  const state = await import('@/lib/auto-yes-state');
  return {
    getAutoYesState: state.getAutoYesState,
    buildCompositeKey: state.buildCompositeKey,
    getLastServerResponseTimestamp: vi.fn(() => null),
    isPollerActive: vi.fn(() => false),
  };
});

import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  buildCompositeKey,
  checkStopCondition,
  clearAllAutoYesStates,
  setAutoYesEnabled,
  STOP_MATCH_EXCERPT_MAX_BYTES,
  STOP_MATCH_EXCERPT_TRUNCATION_MARKER,
} from '@/lib/auto-yes-state';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const capture = () => buildCurrentOutput({} as Database.Database, 'wt-1', 'claude');

describe('capture payload exposes the stop-pattern excerpt (Issue #1694)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllAutoYesStates();
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  it('publishes what matched once the stop pattern fired', async () => {
    setAutoYesEnabled('wt-1', 'claude', true, undefined, 'rm -rf');
    checkStopCondition(
      buildCompositeKey('wt-1', 'claude'),
      ['$ npm run build', '  cleaning: rm -rf dist', '  done'].join('\n')
    );

    const payload = await capture();

    expect(payload.autoYes?.stopReason).toBe('stop_pattern_matched');
    expect(payload.autoYes?.stopMatchedText).toContain('rm -rf dist');
    // The context is what separates a build log from the agent's own output.
    expect(payload.autoYes?.stopMatchedText).toContain('npm run build');
  });

  it('publishes a bounded, explicitly marked excerpt for an oversized match', async () => {
    setAutoYesEnabled('wt-1', 'claude', true, undefined, 'BOOM[\\s\\S]*');
    checkStopCondition(buildCompositeKey('wt-1', 'claude'), `BOOM${'y'.repeat(9000)}`);

    const payload = await capture();
    const excerpt = payload.autoYes?.stopMatchedText ?? '';

    expect(utf8Bytes(excerpt)).toBeLessThanOrEqual(STOP_MATCH_EXCERPT_MAX_BYTES);
    expect(excerpt.endsWith(STOP_MATCH_EXCERPT_TRUNCATION_MARKER)).toBe(true);
  });

  it('omits the field entirely from the JSON when the pattern never fired', async () => {
    setAutoYesEnabled('wt-1', 'claude', true, undefined, 'rm -rf');
    checkStopCondition(buildCompositeKey('wt-1', 'claude'), 'nothing alarming here');

    const payload = await capture();

    expect(payload.autoYes?.stopMatchedText).toBeUndefined();
    const serialized = JSON.parse(JSON.stringify(payload)) as {
      autoYes: Record<string, unknown>;
    };
    expect('stopMatchedText' in serialized.autoYes).toBe(false);
  });

  it('omits the field when auto-yes was never enabled at all', async () => {
    const payload = await capture();

    expect(payload.autoYes?.enabled).toBe(false);
    expect(payload.autoYes?.stopMatchedText).toBeUndefined();
  });
});
