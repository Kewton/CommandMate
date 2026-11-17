/**
 * Issue #4436 I1b: an antigravity Auto-Yes grant is not used to answer without
 * a usage declaration, however it came to be on.
 *
 * The enable API refuses antigravity (I1), but a grant can be on without passing
 * through it: kept on `globalThis` across a Hot Reload, or armed by an older
 * build. Here the grant is put into the state directly (`setAutoYesEnabled`,
 * never the route), then the two answering paths are driven:
 *
 *  - the poller (`startAutoYesPolling` → the real timer tick, transport mocked):
 *    no capture, no key, and the poller stops;
 *  - the `PermissionRequest` hook (`decidePermissionRequest`): no `allow`.
 *
 * Controls: `CM_ANTIGRAVITY_USAGE=api-key` answers as before; claude without a
 * declaration answers as before. No `agy` runs (the tmux layer is mocked).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: async () => ({ verdict: 'owned', sessionPath: null }),
}));

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));
vi.mock('@/lib/tmux/tmux', () => ({ sendSpecialKeys: vi.fn(async () => {}) }));

/** What the pane shows, per CLI tool. */
const screens = vi.hoisted(() => ({ byTool: {} as Record<string, string> }));
const captureSessionOutput = vi.hoisted(() =>
  vi.fn(async (_worktreeId: string, cliToolId: string) => screens.byTool[cliToolId] ?? '')
);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput,
  captureSessionOutputFresh: captureSessionOutput,
  getSessionPresence: vi.fn(async () => 'present'),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? id}`,
      }),
    }),
  },
}));

import { USAGE_DECLARATION_ENV } from '@/lib/tool-policy/policy';
import {
  clearAllPollerStates,
  isPollerActive,
  startAutoYesPolling,
  stopAllAutoYesPolling,
} from '@/lib/auto-yes-poller';
import { buildCompositeKey, clearAllAutoYesStates, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { recordAntigravityPermissionReceipt, resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import { decidePermissionRequest, type PermissionRequestSession } from '@/lib/hooks/permission-decision-service';
import { parsePermissionRequestPayload, type PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-4436-i1b';
const ONE_HOUR = 3_600_000 as const;
const AGY_DIALOG = readFileSync(
  path.resolve(__dirname, '../../fixtures/antigravity-live-2364/dialog-bash-wrapped.txt'),
  'utf8'
);
const CLAUDE_PERMISSION = 'Select an option:\n❯ 1. Yes\n  2. No';

const savedDeclaration = process.env[USAGE_DECLARATION_ENV];
function declare(value: string | undefined): void {
  if (value === undefined) delete process.env[USAGE_DECLARATION_ENV];
  else process.env[USAGE_DECLARATION_ENV] = value;
}

/** A grant put into the state directly — the enable API is never called. */
function grantDirectly(tool: CLIToolType): void {
  setAutoYesEnabled(WT, tool, true, ONE_HOUR, undefined, tool);
}

/** Start the real poller for `tool` and let its timer tick a few times. */
async function pollFor(tool: CLIToolType, ticks = 4): Promise<void> {
  expect(startAutoYesPolling(WT, tool, tool).started).toBe(true);
  for (let i = 0; i < ticks; i++) {
    if (tool === 'antigravity') {
      // agy asked CommandMate about the call (the hook receipt the screen answer pairs with).
      recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', Date.now());
    }
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 1);
  }
}

function bash(command: string): PermissionRequestPayload {
  const parsed = parsePermissionRequestPayload({
    session_id: 's-4436',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command, description: 'run a command' },
  });
  if (!parsed) throw new Error('payload failed to parse');
  return parsed;
}

const session = (tool: CLIToolType): PermissionRequestSession => ({ worktreeId: WT, cliToolId: tool, instanceId: tool });
/** No contract governs the instance (the DB is not consulted). */
const NO_CONTRACT = { readPolicy: () => null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_800_000_000_000);
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  screens.byTool = { antigravity: AGY_DIALOG, claude: CLAUDE_PERMISSION };
  declare(undefined);
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAntigravityPermissionReceiptsForTests();
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
  declare(savedDeclaration);
  db.close();
  vi.useRealTimers();
});

describe('Issue #4436 I1b: the poller does not answer with an antigravity grant that skipped the enable API', () => {
  it('4436 I1b: no declaration → 0 answers, the pane is not even read, the poller stops', async () => {
    grantDirectly('antigravity');
    await pollFor('antigravity');

    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(captureSessionOutput).not.toHaveBeenCalled();
    expect(isPollerActive(buildCompositeKey(WT, 'antigravity', 'antigravity'))).toBe(false);
  });

  it('4436 I1b (control): with CM_ANTIGRAVITY_USAGE=api-key the same grant answers as before', async () => {
    declare('api-key');
    grantDirectly('antigravity');
    await pollFor('antigravity');

    expect(captureSessionOutput).toHaveBeenCalled();
    expect(sendPromptAnswer).toHaveBeenCalled();
    expect(isPollerActive(buildCompositeKey(WT, 'antigravity', 'antigravity'))).toBe(true);
  });

  it('4436 I1b (control): claude without a declaration answers as before', async () => {
    grantDirectly('claude');
    await pollFor('claude');

    expect(sendPromptAnswer).toHaveBeenCalled();
    expect(isPollerActive(buildCompositeKey(WT, 'claude', 'claude'))).toBe(true);
  });
});

describe('Issue #4436 I1b: the PermissionRequest hook does not allow with such a grant', () => {
  it('4436 I1b: no declaration → no allow (the dialog is left to a human)', () => {
    grantDirectly('antigravity');
    const decision = decidePermissionRequest(session('antigravity'), bash('git status'), NO_CONTRACT);
    expect(decision.behavior).toBeNull();
    expect(decision.reason).not.toBe('auto-yes');
  });

  it('4436 I1b (control): with CM_ANTIGRAVITY_USAGE=api-key the same grant allows as before', () => {
    declare('api-key');
    grantDirectly('antigravity');
    expect(decidePermissionRequest(session('antigravity'), bash('git status'), NO_CONTRACT)).toMatchObject({
      behavior: 'allow',
      reason: 'auto-yes',
    });
  });

  it('4436 I1b (control): claude without a declaration allows as before', () => {
    grantDirectly('claude');
    expect(decidePermissionRequest(session('claude'), bash('git status'), NO_CONTRACT)).toMatchObject({
      behavior: 'allow',
      reason: 'auto-yes',
    });
  });
});
