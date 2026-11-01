/**
 * Issue #4063 (part A): the `respond` a structured prompt's question names is
 * the same on every path that builds it.
 *
 * Before #4063 the HTTP `/current-output` passed the resolved instance
 * (`--instance codex` for the codex primary), while the WS push, the poller,
 * the fresh push after an Auto-Yes answer and the prompt history row passed the
 * caller's raw `instanceId` — undefined for the primary — and wrote a bare
 * `commandmate respond <id> <number>`, which the CLI sends to the worktree
 * default (claude), not to the waiting codex.
 *
 * Decision A: `buildCurrentOutput` names the resolved instance on every path
 * (the primary's id is the tool name, `resolveSessionTarget`'s rule).
 *
 * Positive: with no instance (the WS-push shape) the question equals the
 * HTTP shape's, and the fresh push and the history row carry it too; the
 * named instance resolves, through `resolveSessionTarget` on a worktree whose
 * default is claude, to the codex primary's session.
 * Negative: the default tool's primary gets `--instance claude` too (the
 * decision fixed here), and a named `codex-2` keeps `--instance codex-2`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const createMessage = vi.fn((_db: unknown, row: Record<string, unknown>) => ({ id: 'msg-1', ...row }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  getSessionState: vi.fn(() => null),
  createMessage: (db: unknown, row: Record<string, unknown>) => createMessage(db, row),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        id,
        getSessionName: (wt: string, instance?: string) => `mcbd-${id}-${wt}${instance && instance !== id ? `-${instance}` : ''}`,
        isRunning: vi.fn().mockResolvedValue(true),
      }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-4063:codex'),
}));
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  hasRoomSubscribers: vi.fn(() => true),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { broadcast } from '@/lib/ws-server';
import {
  __resetTerminalBroadcastState,
  broadcastTerminalSnapshotAfterInteraction,
} from '@/lib/realtime/terminal-broadcast';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import type { StructuredPromptWaitingData } from '@/lib/session/structured-prompt';
import { buildStructuredPromptHistoryRecord, buildStructuredPromptQuestion } from '@/lib/session/structured-prompt';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const WT = 'wt-4063';
const payloadDb = {} as Database.Database;
/** A frame the scraper reads as busy — it contributes no prompt of its own. */
const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

function openDialog(cliToolId: CLIToolType, instanceId: string = cliToolId): void {
  recordAgentEvent(WT, cliToolId, instanceId, {
    event: 'notification',
    at: Date.now() - 1_000,
    detail: 'permission_prompt',
    sessionId: 'ses-1',
    message: 'touch /tmp/marker.txt',
  });
}

async function questionOf(cliToolId: CLIToolType, instanceId?: string): Promise<string> {
  const payload = await buildCurrentOutput(payloadDb, WT, cliToolId, instanceId);
  expect(payload.isPromptWaiting).toBe(true);
  const promptData = payload.promptData as StructuredPromptWaitingData;
  expect(promptData.options).toEqual([]);
  return promptData.question;
}

/** The `--instance` / `--agent` flags of the first `commandmate respond` the text names. */
function respondFlags(text: string): { instanceId?: string; requestedCliTool?: CLIToolType } {
  const match = /`commandmate respond \S+ <number>((?: --(?:instance|agent) \S+)?)`/.exec(text);
  expect(match).not.toBeNull();
  const flags = match![1];
  const instance = / --instance (\S+)/.exec(flags)?.[1];
  const agent = / --agent (\S+)/.exec(flags)?.[1] as CLIToolType | undefined;
  return { ...(instance ? { instanceId: instance } : {}), ...(agent ? { requestedCliTool: agent } : {}) };
}

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: WT,
    path: `/repo/${WT}`,
    repositoryPath: '/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
});

afterEach(() => {
  db.close();
  clearAgentStopEvents();
});

describe('[#4063] the codex primary on a claude worktree', () => {
  it('positive: no instance (the WS push shape) names what the HTTP shape names', async () => {
    openDialog('codex');
    const push = await questionOf('codex', undefined);
    clearAgentStopEvents();
    openDialog('codex');
    const http = await questionOf('codex', 'codex');

    expect(push).toBe(http);
    expect(push).toContain(`\`commandmate respond ${WT} <number> --instance codex\``);
  });

  it('positive: the history row written from the WS push shape names the same target', async () => {
    openDialog('codex');
    const push = await questionOf('codex', undefined);

    const rows = createMessage.mock.calls.map(([, row]) => row).filter((row) => row.messageType === 'prompt');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(push);
    expect((rows[0].promptData as { question: string }).question).toBe(push);
  });

  it('positive: the fresh push after an interaction (Auto-Yes) names the same target', async () => {
    __resetTerminalBroadcastState();
    openDialog('codex');
    const http = await questionOf('codex', 'codex');
    clearAgentStopEvents();
    openDialog('codex');
    vi.mocked(broadcast).mockClear();

    await broadcastTerminalSnapshotAfterInteraction(WT, 'codex', undefined, []);

    const snapshots = vi
      .mocked(broadcast)
      .mock.calls.map(([, message]) => message as { type?: string; promptData?: { question?: string } })
      .filter((message) => message.type === 'terminal_snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].promptData?.question).toBe(http);
  });

  it('the guidance resolves to the waiting codex primary, not the worktree default', async () => {
    openDialog('codex');
    const push = await questionOf('codex', undefined);

    const target = resolveSessionTarget(db, WT, respondFlags(push));
    expect(target).toMatchObject({ cliToolId: 'codex', instanceId: 'codex' });
    // A bare respond — what the push wrote before #4063 — reaches claude.
    expect(resolveSessionTarget(db, WT, {})).toMatchObject({ cliToolId: 'claude' });
  });

  it('the row the history builder writes for the primary matches the live question', () => {
    const facts = { source: 'notification' as const, message: 'touch /tmp/marker.txt', toolName: 'bash' };
    expect(buildStructuredPromptHistoryRecord(WT, facts, 'codex').question).toBe(
      buildStructuredPromptQuestion(WT, facts, 'codex'),
    );
  });
});

describe('[#4063] negative controls', () => {
  it('the default tool (claude) primary also names `--instance claude` (decision A)', async () => {
    openDialog('claude');
    const question = await questionOf('claude', undefined);
    expect(question).toContain(`\`commandmate respond ${WT} <number> --instance claude\``);
    expect(resolveSessionTarget(db, WT, respondFlags(question))).toMatchObject({
      cliToolId: 'claude',
      instanceId: 'claude',
    });
  });

  it('a named instance keeps its own `--instance`', async () => {
    openDialog('codex', 'codex-2');
    const question = await questionOf('codex', 'codex-2');
    expect(question).toContain(`\`commandmate respond ${WT} <number> --instance codex-2\``);
  });
});
