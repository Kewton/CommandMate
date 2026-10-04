/**
 * Issue #3195 — a launch's `finally` clears its own "starting" record and
 * never that of a later launch of the same instance; kill-session clears it
 * regardless; codex's `relaunchIntoSamePane` (a second `beginAgentSession`
 * inside the same launch) leaves nothing behind.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn().mockResolvedValue(''),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/tmp/wt-3195'),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/cli-tools/start-availability', () => ({
  reportSessionStartFailure: vi.fn(),
  reportStaleHookUrl: vi.fn(),
}));

import { BaseCLITool } from '@/lib/cli-tools/base';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  clearSessionStarting,
  getSessionStartingSince,
  issueSessionStartingToken,
  markSessionStarting,
  resetSessionStartingState,
  runWithSessionStartingToken,
} from '@/lib/session/session-starting-state';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';

const WT = 'wt-3195';

/** A launch that waits on a gate, standing in for a tool's readiness wait. */
class GatedProbeTool extends BaseCLITool {
  readonly id: CLIToolType = 'codex';
  readonly name = 'Probe';
  readonly command = 'probe';
  /** Launches to hold open, consumed in order; a launch with none returns at once. */
  gates: Array<Promise<void>> = [];
  /** Re-run `beginAgentSession` mid-launch, as codex's `relaunchIntoSamePane` does. */
  relaunchMidway = false;
  failWith: Error | null = null;

  async isRunning(): Promise<boolean> {
    return true;
  }

  protected async launchSession(worktreeId: string, _path: string, instanceId?: string): Promise<void> {
    const gate = this.gates.shift();
    beginAgentSession({ worktreeId, cliToolId: this.id, instanceId });
    if (gate) await gate;
    if (this.relaunchMidway) beginAgentSession({ worktreeId, cliToolId: this.id, instanceId });
    if (this.failWith) throw this.failWith;
  }

  async sendMessage(): Promise<void> {}

  async killSession(): Promise<void> {}

  protected async isToolLive(): Promise<boolean> {
    return false;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('[#3195] startSession clears only its own starting record', () => {
  beforeEach(() => resetSessionStartingState());

  it("keeps launch B's record when killed launch A's finally runs after B began", async () => {
    const tool = new GatedProbeTool();
    const gateA = deferred();
    const gateB = deferred();
    tool.gates = [gateA.promise, gateB.promise];

    const launchA = tool.startSession(WT, '/tmp/wt-3195');
    await Promise.resolve();
    expect(getSessionStartingSince(WT, 'codex')).not.toBeNull();

    // kill-session: drops the record whoever wrote it.
    clearSessionStarting(WT, 'codex');
    expect(getSessionStartingSince(WT, 'codex')).toBeNull();

    const launchB = tool.startSession(WT, '/tmp/wt-3195');
    await Promise.resolve();
    const sinceB = getSessionStartingSince(WT, 'codex');
    expect(sinceB).not.toBeNull();

    gateA.resolve();
    await launchA;
    expect(getSessionStartingSince(WT, 'codex')).toBe(sinceB);

    gateB.resolve();
    await launchB;
    expect(getSessionStartingSince(WT, 'codex')).toBeNull();
  });

  it('clears its own record when the launch returns', async () => {
    const tool = new GatedProbeTool();
    await tool.startSession(WT, '/tmp/wt-3195', 'codex-2');
    expect(getSessionStartingSince(WT, 'codex', 'codex-2')).toBeNull();
  });

  it('clears its own record when the launch throws', async () => {
    const tool = new GatedProbeTool();
    const boom = new Error('launch failed');
    tool.failWith = boom;
    await expect(tool.startSession(WT, '/tmp/wt-3195', 'codex-2')).rejects.toBe(boom);
    expect(getSessionStartingSince(WT, 'codex', 'codex-2')).toBeNull();
  });

  it('a second beginAgentSession in the same launch (relaunchIntoSamePane) is still cleared', async () => {
    const tool = new GatedProbeTool();
    tool.relaunchMidway = true;
    await tool.startSession(WT, '/tmp/wt-3195');
    expect(getSessionStartingSince(WT, 'codex')).toBeNull();
  });

  it('a superseded launch re-marking mid-way does not take the key from its successor', async () => {
    const tool = new GatedProbeTool();
    tool.relaunchMidway = true;
    const gateA = deferred();
    const gateB = deferred();
    tool.gates = [gateA.promise, gateB.promise];

    const launchA = tool.startSession(WT, '/tmp/wt-3195');
    await Promise.resolve();
    clearSessionStarting(WT, 'codex');
    const launchB = tool.startSession(WT, '/tmp/wt-3195');
    await Promise.resolve();
    const sinceB = getSessionStartingSince(WT, 'codex');
    expect(sinceB).not.toBeNull();

    gateA.resolve();
    await launchA;
    expect(getSessionStartingSince(WT, 'codex')).toBe(sinceB);

    gateB.resolve();
    await launchB;
    expect(getSessionStartingSince(WT, 'codex')).toBeNull();
  });
});

describe('[#3195] session-starting-state tokens', () => {
  beforeEach(() => resetSessionStartingState());

  it('clearSessionStarting with a different token leaves the record alone', () => {
    const tokenA = issueSessionStartingToken();
    const tokenB = issueSessionStartingToken();
    runWithSessionStartingToken(tokenB, () => markSessionStarting(WT, 'antigravity', undefined, 1_000));
    clearSessionStarting(WT, 'antigravity', undefined, tokenA);
    expect(getSessionStartingSince(WT, 'antigravity', undefined, 2_000)).toBe(1_000);
    clearSessionStarting(WT, 'antigravity', undefined, tokenB);
    expect(getSessionStartingSince(WT, 'antigravity', undefined, 2_000)).toBeNull();
  });

  it('clearSessionStarting without a token drops any launch’s record', () => {
    const token = issueSessionStartingToken();
    runWithSessionStartingToken(token, () => markSessionStarting(WT, 'antigravity', undefined, 1_000));
    clearSessionStarting(WT, 'antigravity');
    expect(getSessionStartingSince(WT, 'antigravity', undefined, 2_000)).toBeNull();
  });

  it('an older token does not overwrite a newer launch’s record', () => {
    const older = issueSessionStartingToken();
    const newer = issueSessionStartingToken();
    expect(runWithSessionStartingToken(newer, () => markSessionStarting(WT, 'antigravity', undefined, 2_000))).toBe(newer);
    expect(runWithSessionStartingToken(older, () => markSessionStarting(WT, 'antigravity', undefined, 3_000))).toBeNull();
    expect(getSessionStartingSince(WT, 'antigravity', undefined, 4_000)).toBe(2_000);
  });

  it('a mark outside any launch scope gets a fresh token', () => {
    const issued = issueSessionStartingToken();
    const token = markSessionStarting(WT, 'antigravity', undefined, 1_000);
    expect(token).toBeGreaterThan(issued);
  });
});
