/**
 * Issue #4418: a send PM makes through its one entry (scripts/orchestrate/pm-send-main.ts)
 * comes back to PM's composer when the target's turn ends — even when the
 * target never sends anything back itself.
 *
 * The entry's argv is taken as it is (commandmate is a recording stub), its
 * `--reply-to self` is read as the CLI reads it (the sender's own session), and
 * the relay that argv asks for is opened bound, the way `send --reply-to`
 * opens it against a current server. The rest is the real relay: the binding
 * (`reserveRelaySend` → the boundary hook → `finish`), the target's finished
 * turn as the transcript reader writes it, and `notifyRelayTurnCompleted`.
 * In-memory SQLite; the transport into PM's composer (`sendUserMessage`) and
 * the readiness check are stubbed. No server, tmux, ~/.commandmate or real DB.
 * The harness follows tests/unit/lib/relay/relay-bound-delivery-3957.test.ts.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage } from '@/lib/db/chat-db';
import { getRelayById } from '@/lib/db/relay-db';
import { codexTurnRequestId } from '@/types/agent-transcript';
import { reserveRelaySend } from '@/lib/relay/relay-bind';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { openRelay } from '@/lib/relay/relay-service';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';
import { main as pmSend } from '../../scripts/orchestrate/pm-send-main';

const NOW = 1_800_000_000_000;
/** PM: the session running pm-send (`whoami`), which `--reply-to self` names. */
const PM = { worktreeId: 'wt-pm', instanceId: 'claude' };
const TARGET_WT = 'wt-target';

let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));

const { evaluateRelayAfterSend, notifyRelayTurnCompleted, pumpRelayDeliveries, resetRelayDeliveryState } = await import(
  '@/lib/relay/relay-delivery'
);

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    id,
    `/tmp/${id}`,
    cliToolId,
    NOW
  );
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await pumpRelayDeliveries();
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree(PM.worktreeId, 'claude');
  insertWorktree(TARGET_WT, 'codex');
  resetRelayDeliveryState();
  resetRelayServerBootId();
  clearWaitingEpisodes();
  clearAgentStopEvents();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm-relay' } });
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
});

afterEach(() => {
  clearWaitingEpisodes();
  clearAgentStopEvents();
  db.close();
});

describe('pm-send → relay → PM\'s composer (Issue #4418)', () => {
  it('the target ends its turn without sending back, and the answer still reaches PM', async () => {
    // 1. PM's entry: what it would run.
    const spawned: string[][] = [];
    const code = await pmSend([TARGET_WT, '--instance', 'codex', '--note', 'レビューの DONE:', 'レビューして。最後の行は DONE: / WAIT: / STOP:'], {
      exec: () => ({ status: null, stdout: '' }),
      spawn: (_command, args) => {
        spawned.push([...args]);
        return { status: 0 };
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    const argv = spawned[0];
    expect(flag(argv, '--reply-to')).toBe('self');
    expect(flag(argv, '--note')).toBe('レビューの DONE:');

    // 2. The relay that argv asks for: from PM (self) to the send's target, bound to the send.
    const target = { worktreeId: argv[1], instanceId: flag(argv, '--instance') as string };
    expect(target).toEqual({ worktreeId: TARGET_WT, instanceId: 'codex' });
    const opened = openRelay(db, { from: PM, to: target, bind: true, now: NOW });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const relayId = opened.relay.id;

    // 3. The send of the body (argv[2]) under the binding, confirmed.
    const reserved = reserveRelaySend(
      db,
      {
        relayId,
        worktreeId: target.worktreeId,
        cliToolId: 'codex',
        instanceId: target.instanceId,
        hooksReportTurns: true,
        readTurn: () => ({ open: false, generation: null }),
      },
      NOW + 10
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const binding = reserved.binding;
    binding.begin(null);
    binding.hooks().beforeInput(new Date(NOW + 100), 'input_start');
    const own = createMessage(db, {
      worktreeId: TARGET_WT,
      role: 'user',
      content: argv[2],
      messageType: 'normal',
      timestamp: new Date(NOW + 100),
      cliToolId: 'codex',
      instanceId: 'codex',
    }).id;
    expect(binding.finish({ kind: 'sent', messageId: own, generationAfter: null })).toBe('sent');
    evaluateRelayAfterSend(relayId);
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();

    // 4. The target finishes its turn: an answer in its own pane, nothing sent to PM.
    createMessage(db, {
      worktreeId: TARGET_WT,
      role: 'assistant',
      content: '指摘は 2 件。\nWAIT: 方針の判断待ち',
      messageType: 'normal',
      timestamp: new Date(NOW + 5_000),
      requestId: codexTurnRequestId('turn-4418'),
      cliToolId: 'codex',
      instanceId: 'codex',
    });
    await notifyRelayTurnCompleted({ worktreeId: TARGET_WT, cliToolId: 'codex', instanceId: 'codex' }, { settled: true });
    await settle();

    // 5. It is in PM's composer, and the relay is closed.
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const [, params] = sendUserMessage.mock.calls[0] as [unknown, { worktreeId?: string; content: string; instanceId?: string }];
    expect(params.content).toContain('WAIT: 方針の判断待ち');
    expect(JSON.stringify(params)).toContain(PM.worktreeId);
    expect(getRelayById(db, relayId)?.state).toBe('delivered');
  });
});
