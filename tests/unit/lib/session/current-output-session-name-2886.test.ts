/**
 * `sessionName` reaches the `current-output` payload (Issue #2886).
 *
 * `buildCurrentOutput` is the shared producer behind `GET
 * /api/worktrees/:id/current-output` and `capture --json`, and neither route
 * used to say which tmux session the pane it describes actually lives in — a
 * reader had to reconstruct `mcbd-${cliToolId}-${worktreeId}` itself, which
 * silently stopped matching reality once a server namespace (#2866) or a
 * legacy-session adoption changed the real name. This pins the producer side:
 * the field is exactly `cliTool.getSessionName(worktreeId, instanceId)`, in
 * each of the three states `resolveSessionName` distinguishes.
 *
 * `.claude/skills/orchestrate-monitor/scripts/monitor.sh` is the consumer —
 * see `tests/unit/skills/orchestrate-monitor/monitor-session-target.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
// Routes `getSessionName` through the REAL `resolveSessionName` (imported
// actual, not re-implemented) so this suite exercises the same namespace /
// legacy-adoption logic every other CLI tool goes through, rather than a
// second copy of the rule that could drift from it.
vi.mock('@/lib/cli-tools/manager', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/cli-tools/session-name')>(
      '@/lib/cli-tools/session-name'
    );
  return {
    CLIToolManager: {
      getInstance: () => ({
        getTool: (cliToolId: CLIToolType) => ({
          isRunning: vi.fn().mockResolvedValue(false),
          getSessionName: (worktreeId: string, instanceId?: string) =>
            actual.resolveSessionName(cliToolId, worktreeId, instanceId),
        }),
      }),
    },
  };
});
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-2886:claude'),
}));

import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { setActiveSessionNamespace } from '@/lib/cli-tools/session-name';
import {
  registerLegacyAlias,
  clearLegacyAliasesForTests,
} from '@/lib/tmux/legacy-session-alias';

const WT = 'wt-2886';
const NS = '0a1b2c3d';

describe('buildCurrentOutput Issue #2886 sessionName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setActiveSessionNamespace(null);
    clearLegacyAliasesForTests();
  });

  it('publishes the legacy shape while no server namespace is set', async () => {
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.sessionName).toBe(`mcbd-claude-${WT}-2`);
  });

  it('publishes the namespaced shape once a namespace is set and nothing was adopted', async () => {
    setActiveSessionNamespace(NS);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.sessionName).toBe(`mcbd-${NS}-claude-${WT}-2`);
  });

  it('publishes the adopted legacy name while a legacy session is adopted for it', async () => {
    setActiveSessionNamespace(NS);
    registerLegacyAlias(`mcbd-${NS}-claude-${WT}-2`, `mcbd-claude-${WT}-2`);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.sessionName).toBe(`mcbd-claude-${WT}-2`);
  });
});
