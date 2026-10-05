/**
 * @vitest-environment node
 *
 * Issue #3365: the list's `isProcessing` reads the same hook-turn rule as
 * `capture --json` (#3337). `steer-queued-running.txt` is a running codex turn
 * whose frame alone reads `ready`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentInstance } from '@/lib/cli-tools/types';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string) => `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return { ...original, CLI_TOOL_IDS: ['claude', 'codex', 'vibe-local'] as never };
});

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
import { clearLastKnownStatuses } from '@/lib/session/status-evidence';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const frame = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const MID_TURN_READ_READY = frame('codex-live-2310/steer-queued-running.txt');
const INTERRUPTED = frame('codex-mid-turn-3337/codex-0.160.0-interrupted-idle.txt');

const WT = 'wt-3365';
const db = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;

function post(tool: 'codex' | 'claude', event: 'user_prompt_submit' | 'stop', at = Date.now()): void {
  recordAgentEvent(WT, tool, tool, { event, at, detail: null, sessionId: 'ses_3365' });
}

async function processing(tool: 'codex' | 'claude'): Promise<boolean> {
  const status = await detectWorktreeSessionStatus(
    WT,
    new Set([`${tool}-${WT}`]),
    db,
    vi.fn().mockReturnValue([]),
    vi.fn(),
    vi.fn(() => [] as AgentInstance[]),
  );
  return status.sessionStatusByCli[tool]?.isProcessing === true;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  clearLastKnownStatuses();
  vi.mocked(captureSessionOutput).mockResolvedValue(MID_TURN_READ_READY);
});

describe('[#3365] list isProcessing follows the hook turn', () => {
  it('premise: the frame alone reads ready', () => {
    expect(detectSessionStatus(MID_TURN_READ_READY, 'codex').status).toBe('ready');
  });

  it('codex with an open hook turn and a ready-looking frame is processing', async () => {
    post('codex', 'user_prompt_submit');
    expect(await processing('codex')).toBe(true);
  });

  it('is not processing after Stop', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 1_000);
    post('codex', 'stop');
    expect(await processing('codex')).toBe(false);
  });

  it('is not processing when the frame shows the turn was interrupted', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(INTERRUPTED);
    post('codex', 'user_prompt_submit');
    expect(await processing('codex')).toBe(false);
  });

  it('is not processing once the open turn is stale', async () => {
    post('codex', 'user_prompt_submit', Date.now() - TURN_STALE_AFTER_MS - 1_000);
    expect(await processing('codex')).toBe(false);
  });

  it('is not processing with no hook turn (screen only)', async () => {
    expect(await processing('codex')).toBe(false);
  });

  it('claude with an open hook turn and a ready frame is unchanged', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue('> \n');
    post('claude', 'user_prompt_submit');
    expect(await processing('claude')).toBe(false);
  });
});
