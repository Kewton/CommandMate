/**
 * Issue #4534: the fence's own rules — the ticket, the gates, the batch, the
 * retraction and the detector — on the real `tmux.ts`, input lock, launch keys
 * and claude launch, with only the process boundary faked
 * (`tests/unit/guards/send-fence-process`).
 *
 * - T11 (R8): a refused ticket closes like any other; a poller its launch armed
 *   is held inside the scope and types after it; the innermost ticket wins.
 * - T12 (R3, run time): a batch is good only for the creation that opened it.
 * - T13 (R7): a retraction passes keys and a kill, nothing else, and ends with
 *   its function.
 * - T-D (B1 (b)): the detector, per session and per layer; the counts come back
 *   on every way out; a session name that moves inside one scope (#2866).
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => (await import('@tests/unit/guards/send-fence-process')).fakeChildProcess());
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal),
);
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  access: vi.fn().mockResolvedValue(undefined),
}));

import { addPane, changes, gateObserver, resetWorld, ungated, world } from '@tests/unit/guards/send-fence-process';
import {
  asRetraction,
  fenceBatchEnd,
  fenceBatchOpen,
  fenceBatchStep,
  fenceConfirm,
  fenceGate,
  FenceMisuseError,
  isFenceRefusal,
  openSendCount,
  openSendTicket,
  readOwnFenceRefusal,
  resetFenceForTests,
  runWithSendTicket,
  SendTargetChangedError,
  setFenceObserver,
  type FenceBatch,
  type FenceRefusalReason,
  type SendTicketInit,
} from '@/lib/session/terminal-fence';
import { sendTargetNames } from '@/lib/session/send-target-names';
import { clearInputLine, createSession, hasSession, killSession, reconcileSessionGeometry, sendKeys } from '@/lib/tmux/tmux';
import { onTmuxSessionCreated } from '@/lib/tmux/session-created-signal';
import { typeLaunchLines } from '@/lib/cli-tools/launch-keys';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { resolveNamespacedSessionName, resolveSessionName, setActiveSessionNamespace } from '@/lib/cli-tools/session-name';
import { clearLegacyAliasesForTests, registerLegacyAlias } from '@/lib/tmux/legacy-session-alias';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerIsolatedAgentHooksDir('fence4534-unit');
let home = '';
const previousHome = process.env.HOME;
beforeAll(() => {
  // The claude launches below must not reach the developer's own home.
  home = mkdtempSync(join(tmpdir(), 'fence4534-unit-home-'));
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const S = 'mcbd-claude-wt-fence-unit';
const init = (confirm: () => FenceRefusalReason | null, names: readonly string[] = [S]): SendTicketInit => ({
  target: { worktreeId: 'wt-fence-unit', instanceId: 'claude', cliToolId: 'claude' },
  resolvedBy: 'roster',
  kind: 'resolved',
  confirm,
  names,
});
const settle = <T>(p: Promise<T>): Promise<T | Error> => p.then((v) => v, (e: unknown) => e as Error);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const thrown = (fn: () => void): { code?: string; reason?: string } | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as { code?: string; reason?: string };
  }
};

beforeEach(() => {
  resetWorld();
  resetFenceForTests();
  resetInstanceInputLocks();
  setFenceObserver(gateObserver);
});
afterEach(() => {
  setFenceObserver(null);
});

describe('the ticket and the single gate', () => {
  it('no ticket: a gate does nothing, the change goes out as today', async () => {
    addPane(S, 'shell');
    await sendKeys(S, 'echo bare', true);
    expect(changes()).toEqual([`send-keys -t =${S}: echo bare C-m`]);
    expect(world.out.find((o) => o.cls === 'change')?.permit).toBe('bare');
  });

  it('a refusal is kept on the ticket: every later gate in the scope refuses without asking again', async () => {
    addPane(S, 'shell');
    const confirm = vi.fn((): FenceRefusalReason | null => 'tool-changed');
    const seen: Array<string | undefined> = [];
    await runWithSendTicket(init(confirm), async () => {
      seen.push(((await settle(sendKeys(S, 'a', false))) as { code?: string }).code);
      seen.push(((await settle(clearInputLine(S))) as { code?: string }).code);
      seen.push(thrown(() => fenceConfirm())?.code);
      expect(readOwnFenceRefusal()?.refusal.reason).toBe('tool-changed');
    });
    expect(seen).toEqual(['SEND_TARGET_CHANGED', 'SEND_TARGET_CHANGED', 'SEND_TARGET_CHANGED']);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(changes()).toEqual([]);
  });

  it('a check that throws is unreadable, with the cause kept', async () => {
    addPane(S, 'shell');
    const outcome = await settle(
      runWithSendTicket(init(() => {
        throw new Error('db gone');
      }), () => sendKeys(S, 'a', false)),
    );
    expect(outcome).toBeInstanceOf(SendTargetChangedError);
    expect(outcome).toMatchObject({ reason: 'unreadable', delivery: 'not-started' });
    expect(((outcome as Error).cause as Error).message).toBe('db gone');
    expect(isFenceRefusal(outcome)).toBe(true);
  });

  it('a ticket with no name is never opened', () => {
    expect(() => openSendTicket(init(() => null, []))).toThrow(FenceMisuseError);
    expect(() => openSendTicket(init(() => null, ['']))).toThrow(/no-name/);
  });
});

describe('T11 (R8): closed is read first', () => {
  it('[T11] a poller armed by the refused send’s launch is held inside the scope and types after it', async () => {
    const typed: string[] = [];
    const errors: string[] = [];
    let gone = false;
    onTmuxSessionCreated(S, () => {
      // What Auto-Yes does: its next ticks are timers made in the send's context.
      for (const at of [5, 80]) {
        setTimeout(() => {
          void sendKeys(S, `y@${at}`, false).then(() => typed.push(`y@${at}`), (e: unknown) => errors.push(`${at}:${(e as Error).name}`));
        }, at);
      }
    });
    const outcome = await settle(
      runWithSendTicket(init(() => (gone ? 'target-gone' : null)), async () => {
        await createSession({ sessionName: S, workingDirectory: '/tmp' });
        gone = true;
        const refused = await settle(typeLaunchLines(S, ['claude']));
        await wait(30);
        throw refused;
      }),
    );
    expect(outcome).toMatchObject({ code: 'SEND_TARGET_CHANGED' });
    await wait(150);
    expect(errors).toEqual(['5:SendTargetChangedError']);
    expect(typed).toEqual(['y@80']);
    expect(changes().filter((l) => l.includes('y@'))).toEqual([`send-keys -t =${S}: y@80`]);
  });

  it('[T11] negative: the same poller with nothing moved types both ticks', async () => {
    const typed: string[] = [];
    onTmuxSessionCreated(S, () => {
      for (const at of [5, 80]) setTimeout(() => void sendKeys(S, `y@${at}`, false).then(() => typed.push(`y@${at}`)), at);
    });
    await runWithSendTicket(init(() => null), async () => {
      await createSession({ sessionName: S, workingDirectory: '/tmp' });
      await wait(30);
    });
    await wait(150);
    expect(typed).toEqual(['y@5', 'y@80']);
  });

  it('[T11] nested: the inner ticket is the one asked', async () => {
    addPane(S, 'shell');
    const outer = vi.fn((): FenceRefusalReason | null => 'target-gone');
    const inner = vi.fn((): FenceRefusalReason | null => null);
    await runWithSendTicket(init(outer), () => runWithSendTicket(init(inner), () => sendKeys(S, 'inner', false)));
    expect(outer).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(changes()).toEqual([`send-keys -t =${S}: inner`]);
  });
});

describe('T12 (R3, run time): a batch is good for its own creation only', () => {
  it('[T12] [fence-d] what a single gate returned, kept and handed on after the ticket was refused, opens nothing', async () => {
    addPane(S, 'shell');
    const pane = world.panes.get(S);
    if (pane) Object.assign(pane, { manual: false, sized: false });
    let gone = false;
    const seen: Array<string | undefined> = [];
    await runWithSendTicket(init(() => (gone ? 'target-gone' : null)), async () => {
      const kept = fenceGate('key') as unknown as FenceBatch;
      gone = true;
      await settle(sendKeys(S, 'x', false));
      const viaOptions = await settle(reconcileSessionGeometry(S, { fenceBatch: kept } as never));
      seen.push((viaOptions as { code?: string }).code);
      seen.push(thrown(() => fenceBatchStep(kept))?.reason);
      const lookalike = { active: true, ticket: null, kind: 'create' } as unknown as FenceBatch;
      seen.push(thrown(() => fenceBatchStep(lookalike))?.reason);
    });
    expect(seen).toEqual(['SEND_TARGET_CHANGED', 'not-a-batch', 'not-a-batch']);
    expect(changes()).toEqual([]);
  });

  it('[T12] [fence-e] a batch used after its creation ended is refused; under another send’s ticket too', async () => {
    let gone = false;
    const seen: Array<string | undefined> = [];
    let leaked!: FenceBatch;
    await runWithSendTicket(init(() => (gone ? 'target-gone' : null)), async () => {
      leaked = fenceBatchOpen('create');
      expect(thrown(() => fenceBatchStep(leaked))).toBeNull();
      fenceBatchEnd(leaked);
      seen.push(thrown(() => fenceBatchStep(leaked))?.reason);
      gone = true;
      await settle(sendKeys(S, 'x', false));
      seen.push(thrown(() => fenceBatchStep(leaked))?.reason);
    });
    const other = fenceBatchOpen('create');
    await runWithSendTicket(init(() => null), async () => {
      seen.push(thrown(() => fenceBatchStep(other))?.reason);
    });
    expect(seen).toEqual(['batch-ended', 'batch-ended', 'batch-of-another-send']);
  });

  it('[T12] negative: createSession is one change — its head gated, its steps one to one, its batch over when it returns', async () => {
    await runWithSendTicket(init(() => null), () => createSession({ sessionName: S, workingDirectory: '/tmp' }));
    expect(world.out.filter((o) => o.cls === 'change').map((o) => `${o.permit}:${o.line.split(' ')[0]}`)).toEqual([
      'ticketed:new-session',
      'batch:set-option',
      'batch:new-window',
      'batch:set-window-option',
      'batch:resize-window',
    ]);
    expect(ungated()).toEqual([]);
  });

  it('[T12] negative: reconcileSessionGeometry on its own confirms each change', async () => {
    addPane(S, 'shell');
    const pane = world.panes.get(S);
    if (pane) Object.assign(pane, { manual: false, sized: false });
    await runWithSendTicket(init(() => null), () => reconcileSessionGeometry(S));
    expect(world.out.filter((o) => o.cls === 'change').map((o) => `${o.permit}:${o.line.split(' ')[0]}`)).toEqual([
      'ticketed:set-window-option',
      'ticketed:resize-window',
    ]);
  });
});

describe('T13 (R7): a retraction passes keys and a kill, nothing else, and ends with its function', () => {
  it('[T13] a timer booked inside a retraction is refused once the retraction has returned', async () => {
    addPane(S, 'shell');
    const late: string[] = [];
    await runWithSendTicket(init(() => 'target-gone'), async () => {
      await settle(sendKeys(S, 'x', false));
      await asRetraction('withdraw', async () => {
        await clearInputLine(S);
        setTimeout(() => void sendKeys(S, 'NOT A RETRACTION', false).catch((e: unknown) => late.push((e as Error).name)), 5);
      });
      await wait(30);
    });
    expect(changes()).toEqual([`send-keys -t =${S}: C-u`]);
    expect(late).toEqual(['SendTargetChangedError']);
  });

  it('[T13] inside a retraction: keys and kill-session go out; creating a session does not', async () => {
    addPane(S, 'shell');
    const refused: string[] = [];
    await runWithSendTicket(init(() => 'target-gone'), async () => {
      await settle(sendKeys(S, 'x', false));
      await asRetraction('role-kill', async () => {
        await sendKeys(S, '/exit', true);
        await killSession(S);
        await createSession({ sessionName: `${S}-other`, workingDirectory: '/tmp' }).catch((e: unknown) =>
          refused.push((e as { code?: string }).code ?? (e as Error).name),
        );
      });
    });
    expect(changes()).toEqual([`send-keys -t =${S}: /exit C-m`, `kill-session -t =${S}:`]);
    expect(refused).toEqual(['SEND_TARGET_CHANGED']);
    expect(ungated()).toEqual([]);
  });

  it('[T13] the withdraw of a refused body is a retraction: its clear goes out after the refusal', async () => {
    addPane(S, 'claude');
    let refuse = false;
    world.onCall = (o) => {
      if (o.line.startsWith('send-keys') && o.line.includes('-l --')) refuse = true;
    };
    await settle(
      runWithSendTicket(init(() => (refuse ? 'tool-changed' : null)), () =>
        sendMessageWithSubmitVerification({
          sessionName: S,
          message: 'withdrawn body',
          cliToolId: 'claude',
          textInputWaitMs: 1,
          interEnterWaitMs: 1,
          verifyAttempts: 1,
          verifyDelayMs: 1,
          pasteLandedAttempts: 1,
        }),
      ),
    );
    const after = world.out.filter((o) => o.cls === 'change').slice(1);
    expect(after.every((o) => o.permit === 'retraction')).toBe(true);
    expect(after.some((o) => /Enter$/.test(o.line))).toBe(false);
  });
});

describe('T-D (B1 (b)): the detector', () => {
  it('[T-D] no send open → as today; open → unticketed (not-started); another session is not affected; the count comes back', async () => {
    addPane(S, 'shell');
    addPane('mcbd-codex-wt-other', 'shell');
    await typeLaunchLines(S, ['direct']);
    const handle = openSendTicket(init(() => null));
    await expect(typeLaunchLines(S, ['lost'])).rejects.toMatchObject({ code: 'SEND_FENCE_MISUSE', reason: 'unticketed', delivery: 'not-started' });
    await typeLaunchLines('mcbd-codex-wt-other', ['other']);
    handle.close();
    handle.close();
    await typeLaunchLines(S, ['after']);
    expect(changes().map((l) => l.split(' ').slice(3).join(' '))).toEqual(['direct C-m', 'other C-m', 'after C-m']);
    expect(openSendCount(S)).toBe(0);
  });

  it('[T-D] per layer: the shared sender and the claude launch are send-only layers too', async () => {
    addPane(S, 'claude');
    const handle = openSendTicket(init(() => null));
    try {
      await expect(
        sendMessageWithSubmitVerification({ sessionName: S, message: 'lost', cliToolId: 'claude', textInputWaitMs: 1 }),
      ).rejects.toMatchObject({ reason: 'unticketed' });
      const { startClaudeSession } = await import('@/lib/session/claude-session');
      const name = resolveSessionName('claude', 'wt-td');
      const other = openSendTicket(init(() => null, [name]));
      await expect(startClaudeSession({ worktreeId: 'wt-td', worktreePath: '/tmp' })).rejects.toMatchObject({ reason: 'unticketed' });
      other.close();
    } finally {
      handle.close();
    }
    expect(changes()).toEqual([]);
  });

  it('[T-D] the count comes back after a rejection, a synchronous throw and an early return', async () => {
    await settle(runWithSendTicket(init(() => null), async () => {
      throw new Error('boom');
    }));
    expect(() => runWithSendTicket(init(() => null), (() => {
      throw new Error('sync');
    }) as never)).toThrow('sync');
    await runWithSendTicket(init(() => null), async () => undefined);
    expect(openSendCount(S)).toBe(0);
  });

  it('[T-D] a closed ticket in the context: unticketed while another send to the session is open, as today when none is', async () => {
    addPane(S, 'shell');
    const outcomes: string[] = [];
    const later = (at: number): void => {
      setTimeout(
        () =>
          void typeLaunchLines(S, [`late@${at}`]).then(
            () => outcomes.push(`typed@${at}`),
            (e: unknown) => outcomes.push(`${(e as { code?: string }).code}@${at}`),
          ),
        at,
      );
    };
    await runWithSendTicket(init(() => null), async () => {
      later(10);
      later(80);
    });
    const another = openSendTicket(init(() => null));
    await wait(40);
    another.close();
    await wait(80);
    expect(outcomes).toEqual(['SEND_FENCE_MISUSE@10', 'typed@80']);
  });

  it('[T-D] #2866: a launch after the legacy alias dropped is not refused, and the count is kept under both names', async () => {
    try {
      setActiveSessionNamespace('0a1b2c3d');
      const legacy = resolveNamespacedSessionName(null, 'claude', 'wt-alias');
      const fresh = resolveNamespacedSessionName('0a1b2c3d', 'claude', 'wt-alias');
      registerLegacyAlias(fresh, legacy);
      const names = sendTargetNames('claude', 'wt-alias');
      expect(names).toEqual([legacy]);
      const handle = openSendTicket(init(() => null, names));
      try {
        expect(await handle.run(() => hasSession(legacy))).toBe(false);
        const now = resolveSessionName('claude', 'wt-alias');
        expect(now).toBe(fresh);
        const { startClaudeSession } = await import('@/lib/session/claude-session');
        await handle.run(() => startClaudeSession({ worktreeId: 'wt-alias', worktreePath: '/tmp' }));
        expect(changes().filter((l) => l.startsWith('send-keys')).every((l) => l.startsWith(`send-keys -t =${fresh}:`))).toBe(true);
        expect(changes().some((l) => l.startsWith(`new-session -d -s ${fresh}`))).toBe(true);
        expect(ungated()).toEqual([]);
        expect([openSendCount(legacy), openSendCount(fresh)]).toEqual([1, 1]);
        await expect(typeLaunchLines(now, ['again'])).rejects.toMatchObject({ code: 'SEND_FENCE_MISUSE' });
      } finally {
        handle.close();
      }
      expect([openSendCount(legacy), openSendCount(fresh)]).toEqual([0, 0]);
    } finally {
      setActiveSessionNamespace(null);
      clearLegacyAliasesForTests();
    }
  });
});
