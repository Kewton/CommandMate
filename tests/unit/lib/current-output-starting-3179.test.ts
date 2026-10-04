/**
 * Issue #3179 — `buildCurrentOutput` while an agent is launching, for every tool.
 *
 * The frame under a launch is a shell prompt and the launch line, or a trust
 * dialog the launch answers by itself. Before this Issue the first fell to the
 * detector's floor and raised `isUnclassifiedActive` (the Navigate pad), and the
 * second raised the prompt / selection-list flags (the answer sheet, the
 * selection buttons). While the launch is recorded, none of them may be raised.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-3179:any'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import {
  clearSessionStarting,
  markSessionStarting,
  resetSessionStartingState,
} from '@/lib/session/session-starting-state';
import {
  SESSION_STARTING_PROMPT_GRACE_MS,
  getSessionStartingMaxMs,
} from '@/config/session-starting-config';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-3179';
const T0 = Date.UTC(2026, 9, 4, 1, 0, 0);

/** The eight tools the Issue's acceptance criterion names. */
const TOOLS: readonly CLIToolType[] = [
  'claude',
  'codex',
  'antigravity',
  'gemini',
  'copilot',
  'opencode',
  'opencode-v2',
  'command-code',
];

/** A pane that has only the launch line on it (the reported frame). */
const LAUNCH_LINE = [
  'user@host wt-3179 % CM_HOOK_URL=\'http://127.0.0.1:3000/api/hooks\' CM_PORT=\'3000\' \'agy\'',
  '',
].join('\n');

/** A numbered dialog — the trust screen the launch answers itself. */
const TRUST_DIALOG = [
  'Do you trust the files in this folder?',
  '',
  '❯ 1. Yes, proceed',
  '  2. No, exit',
  '',
  'Enter to confirm · Esc to exit',
  '',
].join('\n');

async function payloadFor(tool: CLIToolType, frame: string) {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  return buildCurrentOutput({} as Database.Database, WT, tool, tool);
}

function expectNeutral(payload: Awaited<ReturnType<typeof payloadFor>>) {
  expect(payload.startingSince).toBe(T0);
  expect(payload.sessionStatus).toBe('running');
  expect(payload.sessionStatusReason).toBe(STATUS_REASON.STARTING);
  expect(payload.isUnclassifiedActive).toBe(false);
  expect(payload.isSelectionListActive).toBe(false);
  expect(payload.isPagerActive).toBe(false);
  expect(payload.isDismissablePanelActive).toBe(false);
  expect(payload.isPromptWaiting).toBe(false);
  expect(payload.promptData).toBeNull();
  expect(payload.thinking).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetSessionStartingState();
  isRunning.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[#3179] buildCurrentOutput while the agent is launching', () => {
  it.each(TOOLS)('%s: the launch-line frame raises no pad, list or prompt flag', async (tool) => {
    markSessionStarting(WT, tool, undefined, T0);
    vi.setSystemTime(T0 + 1000);
    expectNeutral(await payloadFor(tool, LAUNCH_LINE));
  });

  it.each(TOOLS)('%s: a trust dialog the launch is answering raises none either', async (tool) => {
    markSessionStarting(WT, tool, undefined, T0);
    vi.setSystemTime(T0 + 1000);
    expectNeutral(await payloadFor(tool, TRUST_DIALOG));
  });

  it.each(TOOLS)('%s: publishes startingSince null when no launch is recorded', async (tool) => {
    const payload = await payloadFor(tool, LAUNCH_LINE);
    expect(payload.startingSince).toBeNull();
    expect(payload.sessionStatusReason).not.toBe(STATUS_REASON.STARTING);
  });

  it('is not vacuous: without a launch record the trust dialog IS a dialog', async () => {
    const payload = await payloadFor('claude', TRUST_DIALOG);
    expect(payload.isPromptWaiting || payload.isSelectionListActive).toBe(true);
  });

  it('is not vacuous: without a launch record the launch line is the unclassified floor', async () => {
    const payload = await payloadFor('antigravity', LAUNCH_LINE);
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('publishes the launch even before the tmux session exists', async () => {
    isRunning.mockResolvedValue(false);
    markSessionStarting(WT, 'antigravity', undefined, T0);
    const payload = await payloadFor('antigravity', '');
    expect(payload.isRunning).toBe(false);
    expect(payload.startingSince).toBe(T0);
  });

  it('ends when the launch returns or throws (the record is cleared)', async () => {
    markSessionStarting(WT, 'claude', undefined, T0);
    expect((await payloadFor('claude', LAUNCH_LINE)).startingSince).toBe(T0);
    clearSessionStarting(WT, 'claude');
    expect((await payloadFor('claude', LAUNCH_LINE)).startingSince).toBeNull();
  });

  it('ends past the tool\'s readiness wait, even if the launch never reports', async () => {
    markSessionStarting(WT, 'antigravity', undefined, T0);
    vi.setSystemTime(T0 + getSessionStartingMaxMs('antigravity') + 1);
    const payload = await payloadFor('antigravity', LAUNCH_LINE);
    expect(payload.startingSince).toBeNull();
  });

  it('ends when a dialog stays up longer than the launch takes to answer one', async () => {
    markSessionStarting(WT, 'claude', undefined, T0);
    expectNeutral(await payloadFor('claude', TRUST_DIALOG));
    vi.setSystemTime(T0 + SESSION_STARTING_PROMPT_GRACE_MS);
    const payload = await payloadFor('claude', TRUST_DIALOG);
    expect(payload.startingSince).toBeNull();
    expect(payload.isPromptWaiting || payload.isSelectionListActive).toBe(true);
  });
});
