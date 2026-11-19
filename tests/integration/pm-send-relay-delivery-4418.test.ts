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
import { createMessage, relayRequestId } from '@/lib/db/chat-db';
import { getRelayById } from '@/lib/db/relay-db';
import { codexTurnRequestId } from '@/types/agent-transcript';
import { reserveRelaySend } from '@/lib/relay/relay-bind';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { openRelay } from '@/lib/relay/relay-service';
import { MAX_RELAY_ROUNDS, RELAY_ROUNDS_WINDOW_MS } from '@/lib/relay/relay-policy';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';
import { RELAY_ROUNDS_REFUSED_NOTICE, main as pmSend } from '../../scripts/orchestrate/pm-send-main';

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
      resolveWorktree: async (id) => id,
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

/**
 * Codex P1 on e7ca98ac9, after #4420 (docs/design/pm-send-relay-4418.md
 * §「返事を受けた後の再依頼」). PM reads the answer the relay put in its composer
 * and asks again through pm-send, with no flag: a reply to PM's own relay is not
 * a chain parent any more. What stops PM is the pace: MAX_RELAY_ROUNDS replies
 * within RELAY_ROUNDS_WINDOW_MS, refused RELAY_HOPS_EXCEEDED — and pm-send then
 * sends nothing plain.
 *
 * Each send goes through the entry; its `commandmate send` is a stub that does
 * what the CLI does with that argv: `--reply-to self` opens a bound relay from PM
 * (`--allow-relay-chain` only if the argv has it), a refusal is `Error: <message>`
 * on stderr and exit 2 (`registerRelay`), and otherwise the body is sent under the
 * binding. Date is faked so the ledger's `delivered_at` sits on the test's clock.
 */
describe('PM asks again after a relayed answer (Codex P1, after #4420)', () => {
  /** Every argv pm-send ran, and the bodies that reached the target. */
  let spawned: string[][];
  let delivered: string[];
  let pmErr: string[];

  /** `commandmate send` for one argv, as the CLI runs it (see above). */
  async function commandmateSend(argv: readonly string[], t: number): Promise<{ status: number; stderr?: string; relayId?: string }> {
    expect(flag(argv, '--reply-to')).toBe('self');
    const opened = openRelay(db, {
      from: PM,
      to: { worktreeId: argv[1], instanceId: flag(argv, '--instance') as string },
      bind: true,
      allowRelayChain: argv.includes('--allow-relay-chain'),
      now: t,
    });
    if (!opened.ok) return { status: 2, stderr: `Error: ${opened.refusal.message}\n` };
    const reserved = reserveRelaySend(
      db,
      {
        relayId: opened.relay.id,
        worktreeId: argv[1],
        cliToolId: 'codex',
        instanceId: flag(argv, '--instance') as string,
        hooksReportTurns: true,
        readTurn: () => ({ open: false, generation: null }),
      },
      t + 10
    );
    if (!reserved.ok) throw new Error('reserve');
    reserved.binding.begin(null);
    reserved.binding.hooks().beforeInput(new Date(t + 100), 'input_start');
    const own = createMessage(db, {
      worktreeId: argv[1], role: 'user', content: argv[2], messageType: 'normal',
      timestamp: new Date(t + 100), cliToolId: 'codex', instanceId: 'codex',
    }).id;
    reserved.binding.finish({ kind: 'sent', messageId: own, generationAfter: null });
    delivered.push(argv[2]);
    evaluateRelayAfterSend(opened.relay.id);
    return { status: 0, stderr: `Relay registered: ${opened.relay.id}\n`, relayId: opened.relay.id };
  }

  /** PM sends round `round` through pm-send; the target answers when it went through. */
  async function ask(round: number): Promise<{ code: number; relayId?: string }> {
    const t = NOW + round * 100_000;
    vi.setSystemTime(t);
    let relayId: string | undefined;
    const code = await pmSend([TARGET_WT, '--instance', 'codex', '--note', `返事 ${round}`, `依頼 ${round}`], {
      exec: () => ({ status: null, stdout: '' }),
      resolveWorktree: async (id) => id,
      spawn: async (_command, args) => {
        spawned.push([...args]);
        const result = await commandmateSend(args, t);
        relayId = result.relayId;
        return result;
      },
      stderr: (line) => pmErr.push(line),
    });
    if (relayId === undefined) return { code };
    await settle();
    vi.setSystemTime(t + 5_000);
    createMessage(db, {
      worktreeId: TARGET_WT, role: 'assistant', content: `WAIT: 判断待ち ${round}`, messageType: 'normal',
      timestamp: new Date(t + 5_000), requestId: codexTurnRequestId(`turn-p1-${round}`), cliToolId: 'codex', instanceId: 'codex',
    });
    await notifyRelayTurnCompleted({ worktreeId: TARGET_WT, cliToolId: 'codex', instanceId: 'codex' }, { settled: true });
    vi.setSystemTime(t + 6_000);
    await settle();
    expect(getRelayById(db, relayId)?.state).toBe('delivered');
    return { code, relayId };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    spawned = [];
    delivered = [];
    pmErr = [];
    // The delivery writes the answer into PM's history the way sendUserMessage does: a `relay` user row.
    sendUserMessage.mockImplementation(async (_db: unknown, p: { worktreeId: string; content: string; instanceId?: string; requestId?: string }) => {
      const row = createMessage(db, {
        worktreeId: p.worktreeId, role: 'user', content: p.content, messageType: 'relay', requestId: p.requestId,
        timestamp: new Date(Date.now()), cliToolId: 'claude', instanceId: p.instanceId ?? 'claude',
      });
      return { ok: true, message: { id: row.id } };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) send → answer → send again goes through with no flag, every round at hop 1 (red before #4420: RELAY_CHAIN_BLOCKED)', async () => {
    for (let round = 1; round <= 3; round += 1) {
      const sent = await ask(round);
      expect(sent.code).toBe(0);
      expect(getRelayById(db, sent.relayId as string)?.hops).toBe(1);
    }
    expect(spawned.every((argv) => !argv.includes('--allow-relay-chain'))).toBe(true);
    expect(delivered).toEqual(['依頼 1', '依頼 2', '依頼 3']);
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
  });

  it('(b) after MAX_RELAY_ROUNDS answers in the window, pm-send exits with the refusal and nothing is sent plainly', async () => {
    expect(MAX_RELAY_ROUNDS).toBe(10);
    expect(RELAY_ROUNDS_WINDOW_MS).toBe(30 * 60_000);
    for (let round = 1; round <= MAX_RELAY_ROUNDS; round += 1) {
      expect((await ask(round)).code).toBe(0);
    }
    // All ten answers fall inside the window of the next send.
    expect((MAX_RELAY_ROUNDS + 1) * 100_000 - 100_000).toBeLessThan(RELAY_ROUNDS_WINDOW_MS);
    const before = { spawned: spawned.length, delivered: delivered.length };
    const over = await ask(MAX_RELAY_ROUNDS + 1);
    expect(over.code).toBe(2);
    expect(over.relayId).toBeUndefined();
    // One run, with the relay; no second (plain) send, and the body never reached the target.
    expect(spawned.length - before.spawned).toBe(1);
    expect(flag(spawned[spawned.length - 1], '--reply-to')).toBe('self');
    expect(delivered.length).toBe(before.delivered);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE worktree_id = ? AND role = 'user'`).get(TARGET_WT)
    ).toEqual({ n: MAX_RELAY_ROUNDS });
    expect(pmErr).toContain(RELAY_ROUNDS_REFUSED_NOTICE);
  });

  it('a line a person types into PM ends the chain: the next request is hop 1 again', async () => {
    await ask(1);
    createMessage(db, {
      worktreeId: PM.worktreeId, role: 'user', content: '次へ進めて', messageType: 'normal',
      timestamp: new Date(NOW + 150_000), cliToolId: 'claude', instanceId: 'claude',
    });
    const next = await ask(2);
    expect(next.code).toBe(0);
    expect(getRelayById(db, next.relayId as string)?.hops).toBe(1);
  });

  it('the answer PM was handed names the relay it closed (the guard reads that row)', async () => {
    const first = await ask(1);
    if (first.relayId === undefined) throw new Error('setup');
    const [, params] = sendUserMessage.mock.calls[0] as [unknown, { requestId?: string }];
    expect(params.requestId).toBe(relayRequestId(first.relayId));
  });
});
