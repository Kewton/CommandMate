/**
 * The worktree's lifetime on the provider's path (Issue #4224, D2 design §2, T0a〜T7 and the
 * 2nd review ①).
 *
 * A send request is for one worktree lifetime and one instance lifetime, fixed at its
 * entrance (`pinBriefWorktree` where the route reads the worktree, `pinBriefRequest` where
 * it resolves the instance) and never read again. A worktree deleted and made again under
 * the same id and path while the request waits — for its body, the ownership check, the
 * prompt guard, a launch, the provider or the lock — gets nothing of the old request: no
 * brief, no evaluation's close, no reservation, no ledger write, no reset row.
 *
 * Driven through the real send service and C's real provider on the #4274 world. The
 * positive controls are the re-creations; the "pin read again" control shows the same
 * scenario attaching when the entrance's pin is replaced by one read after the wait.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hooks = vi.hoisted(() => ({ onOwnership: null as null | (() => void), onPromptGuard: null as null | (() => void) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => {
    const once = hooks.onOwnership;
    hooks.onOwnership = null;
    once?.();
    return { verdict: 'owned', sessionPath: null };
  }),
}));
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => {
    const once = hooks.onPromptGuard;
    hooks.onPromptGuard = null;
    once?.();
    return { waiting: false };
  }),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => globalThis.__briefTools?.[id] }) },
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  isSessionRunning: vi.fn(async () => true),
}));
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: vi.fn(() => ({ text: '', state: 'empty' })),
}));

import { WT, bindWorld, closeWorld, launch, makeWorld, rows, setMem, typed, type World } from './session-brief-4274-harness';
import { entrance, memFingerprint, realPort, recreateWorktree, sendPinned } from './brief-d2-4224-harness';
import { BriefMembershipChangedError, buildBrief, PROVIDER_TIME_BUDGET } from '@/lib/brief/build';
import { getWorktreeIncarnation } from '@/lib/mem/incarnation';
import { migrateWorktreeIdPreservingChildren } from '@/lib/db/worktree-db';
import { briefMayAttach, pinBriefRequest, pinBriefWorktree, SendBrief } from '@/lib/session/session-brief';
import type { BriefRequest } from '@/lib/session/brief-provider';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { addAgentInstance, removeAgentInstance } from '@/lib/db/agent-instances-db';

let world: World;

const BRIEF = /^<<<cmate-brief:[0-9a-f]{8}\n/;
const briefedCount = (tool = 'claude') => typed(world, tool).filter((text) => BRIEF.test(text)).length;
const closeRecords = () => (world.db.prepare('SELECT COUNT(*) n FROM mem_close_records').get() as { n: number }).n;
const incarnationRows = () => (world.db.prepare('SELECT COUNT(*) n FROM mem_worktree_incarnations').get() as { n: number }).n;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  hooks.onOwnership = null;
  hooks.onPromptGuard = null;
});
afterEach(() => {
  hooks.onOwnership = null;
  hooks.onPromptGuard = null;
  closeWorld(world);
});

describe('T0 every wait after the entrance (review P1)', () => {
  const waits: Record<string, (recreate: () => void) => void> = {
    'T0a the body being parsed (between the two pins of the route)': () => undefined, // handled in the test body
    'T0b the service’s ownership check': (recreate) => (hooks.onOwnership = recreate),
    'T0c the prompt guard': (recreate) => (hooks.onPromptGuard = recreate),
  };

  it.each(Object.keys(waits))('%s: a worktree made again gets no brief, no build, no ledger write', async (name) => {
    const port = realPort(world);
    launch('claude');
    const doRecreate = () => recreateWorktree(world);
    let pin;
    if (name.startsWith('T0a')) {
      const worktreePin = pinBriefWorktree(world.db, WT);
      doRecreate(); // the body's await
      pin = pinBriefRequest(world.db, worktreePin, 'claude');
    } else {
      pin = entrance(world, 'claude');
      waits[name](doRecreate);
    }
    const buildSpy = vi.spyOn(port.port, 'build');
    const sent = await sendPinned(world, 'claude', 'hello', pin);
    expect(sent.result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual(['hello']);
    expect(buildSpy).not.toHaveBeenCalled();
    expect(rows(world, 'claude')).toEqual([]); // nothing written for the new worktree
    expect(incarnationRows()).toBe(0); // and no incarnation made for it
    expect(closeRecords()).toBe(0);
  });

  it('negative: no re-creation — the same send attaches once and the row is sent', async () => {
    realPort(world);
    launch('claude');
    const sent = await sendPinned(world, 'claude', 'hello', entrance(world, 'claude'));
    expect(sent.result.ok).toBe(true);
    expect(briefedCount()).toBe(1);
    expect(typed(world, 'claude')[0].endsWith('\n\nhello')).toBe(true);
    expect(rows(world, 'claude')[0].state).toBe('sent');
  });

  it('self-control: a pin read again after the wait (no entrance pin) would attach to the new worktree', async () => {
    realPort(world);
    launch('claude');
    recreateWorktree(world);
    launch('claude'); // the new worktree's own launch
    await sendPinned(world, 'claude', 'hello', entrance(world, 'claude'));
    expect(briefedCount()).toBe(1); // what a pin read late would have done for the old request
  });

  it('T0d a launch during the wait: the old request types the body only, the new launch row stays pending for the next request', async () => {
    realPort(world);
    const pin = entrance(world, 'claude'); // the entrance of a first send: no row yet, the launch comes after
    recreateWorktree(world);
    launch('claude');
    await sendPinned(world, 'claude', 'old request', pin);
    expect(typed(world, 'claude')).toEqual(['old request']);
    expect(rows(world, 'claude')[0].state).toBe('pending');
    await sendPinned(world, 'claude', 'next request', entrance(world, 'claude'));
    expect(briefedCount()).toBe(1);
    expect(typed(world, 'claude')[1].endsWith('\n\nnext request')).toBe(true);
    expect(rows(world, 'claude')[0].state).toBe('sent');
  });

  it('T0e a reset this send types opens no row on a worktree made again meanwhile (W6)', async () => {
    realPort(world);
    launch('claude');
    hooks.onOwnership = () => recreateWorktree(world);
    await sendPinned(world, 'claude', '/clear', entrance(world, 'claude'));
    expect(typed(world, 'claude')).toEqual(['/clear']);
    expect(rows(world, 'claude')).toEqual([]);
  });

  it('T0e negative: not made again — the reset opens its row (D1)', async () => {
    realPort(world);
    launch('claude');
    await sendPinned(world, 'claude', '/clear', entrance(world, 'claude'));
    expect(rows(world, 'claude')[0]).toMatchObject({ kind: 'reset', state: 'pending' });
  });
});

describe('T0f a reset with a pin that holds no evidence (Codex 5-2b P2)', () => {
  const kinds = () => rows(world, 'claude').map((row) => row.kind);

  it('(control) mem off, no row and no incarnation at the entrance, made again while the body is parsed: the old /clear opens no reset row on the new worktree', async () => {
    setMem(world, 'off', true);
    realPort(world);
    const worktreePin = pinBriefWorktree(world.db, WT);
    expect(worktreePin).toMatchObject({ worktreeIncarnation: null, anchorBoundaryId: null });
    recreateWorktree(world); // the body's await
    launch('claude'); // the new worktree's own session
    const pin = pinBriefRequest(world.db, worktreePin, 'claude');
    await sendPinned(world, 'claude', '/clear', pin);
    expect(typed(world, 'claude')).toEqual(['/clear']);
    expect(kinds()).not.toContain('reset');
  });

  it('negative: mem off with a row at the entrance (evidence, `same`) — the reset opens its row as D1 does', async () => {
    setMem(world, 'off', true);
    realPort(world);
    launch('claude');
    await sendPinned(world, 'claude', '/clear', entrance(world, 'claude'));
    expect(kinds()).toContain('reset');
  });
});

describe('T0g the instance made again after the entrance: the old request leaves the new launch row alone (PM review P3-1)', () => {
  const ID = 'codex-2';
  const sendAs = (pin: ReturnType<typeof entrance>, content: string) =>
    sendUserMessage(world.db, { worktreeId: WT, content, cliToolId: 'codex', instanceId: ID, brief: 'auto', briefPin: pin });
  const remake = () => {
    removeAgentInstance(world.db, WT, ID);
    addAgentInstance(world.db, WT, { id: ID, cliTool: 'codex' } as never);
  };

  it('(control) re-made and relaunched after the entrance: body only, the new launch row stays pending, the next request is briefed on it', async () => {
    realPort(world);
    addAgentInstance(world.db, WT, { id: ID, cliTool: 'codex' } as never);
    launch('codex', ID);
    const oldPin = entrance(world, ID);
    remake();
    launch('codex', ID); // the new instance's own launch row
    const fresh = rows(world, ID).find((row) => row.state === 'pending' && row.instanceIncarnation !== oldPin.instance.incarnation);
    expect(fresh).toBeDefined();
    await sendAs(oldPin, 'old request');
    expect(typed(world, 'codex')).toEqual(['old request']);
    expect(rows(world, ID).find((row) => row.id === fresh!.id)?.state).toBe('pending');
    await sendAs(entrance(world, ID), 'next request');
    expect(typed(world, 'codex')[1]).toMatch(BRIEF);
    expect(rows(world, ID).find((row) => row.id === fresh!.id)?.state).toBe('sent');
  });

  it('negative: not re-made — the pinned request is briefed on its launch row', async () => {
    realPort(world);
    addAgentInstance(world.db, WT, { id: ID, cliTool: 'codex' } as never);
    launch('codex', ID);
    await sendAs(entrance(world, ID), 'hello');
    expect(typed(world, 'codex')[0]).toMatch(BRIEF);
  });
});

describe('T1〜T4 between the plan, the build and the claim (§2.2 P1〜P4)', () => {
  it('T1 force: made again at the start of the build — body only, no explicit row, nothing closed', async () => {
    realPort(world, { beforeBuild: (call) => call === 1 && recreateWorktree(world) });
    const sent = await sendPinned(world, 'claude', 'forced', entrance(world, 'claude'), 'force');
    expect(typed(world, 'claude')).toEqual(['forced']);
    expect(sent.report).toMatchObject({ state: 'skipped', reason: 'worktree_changed' });
    expect(rows(world, 'claude')).toEqual([]);
    expect(closeRecords()).toBe(0);
    expect(incarnationRows()).toBe(0);
  });

  it('T1 negative: force without a re-creation attaches and opens its explicit row', async () => {
    realPort(world);
    const sent = await sendPinned(world, 'claude', 'forced', entrance(world, 'claude'), 'force');
    expect(sent.report).toMatchObject({ state: 'attached' });
    expect(rows(world, 'claude')[0]).toMatchObject({ kind: 'explicit', state: 'sent' });
  });

  it('T2 an existing row: made again before the build — the build is refused before it evaluates anything', async () => {
    const { state } = realPort(world, { beforeBuild: (call) => call === 1 && recreateWorktree(world) });
    launch('claude');
    await sendPinned(world, 'claude', 'hi', entrance(world, 'claude'));
    expect(typed(world, 'claude')).toEqual(['hi']);
    expect(closeRecords()).toBe(0);
    expect(state.memoCount()).toBe(0);
  });

  it('T3 made again after the build, while the claim waits: body only, no reservation', async () => {
    const { port } = realPort(world, {
      beforeBuild: () => {
        // Hold the claim's git answer; make the worktree again while it waits.
        world.observeHold = { wait: new Promise<void>((resolve) => setTimeout(() => (recreateWorktree(world), resolve()), 0)), armed: false };
      },
    });
    const reserve = vi.spyOn(port, 'reserve');
    launch('claude');
    const pin = entrance(world, 'claude');
    // Arm the hold for the claim's observe only: the plan's has run when the build starts.
    const build = port.build;
    port.build = async (request) => {
      const answer = await build(request);
      world.observeHold!.armed = true;
      return answer;
    };
    const sent = await sendPinned(world, 'claude', 'late', pin, 'force');
    expect(typed(world, 'claude')).toEqual(['late']);
    expect(sent.report).toMatchObject({ state: 'skipped', reason: 'worktree_changed' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('T4 renamed after the plan: not claimed under the old id; the moved row is briefed by a request to the new id', async () => {
    realPort(world);
    launch('claude');
    const renamed = `${WT}-renamed`;
    const brief = new SendBrief({ db: world.db, worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', mode: 'auto', content: 'x', typedBody: (t) => t, pin: entrance(world, 'claude') });
    await brief.plan();
    world.db.transaction(() => migrateWorktreeIdPreservingChildren(world.db, WT, renamed))();
    expect(await brief.claim()).toBe('x');
    expect(brief.reportForResponse()).toBeNull(); // auto: a skip is not reported
    expect(world.db.prepare('SELECT state FROM session_brief_boundaries WHERE worktree_id = ?').get(renamed)).toEqual({ state: 'pending' });
    const next = new SendBrief({
      db: world.db,
      worktreeId: renamed,
      cliToolId: 'claude',
      instanceId: 'claude',
      mode: 'force',
      content: 'y',
      typedBody: (t) => t,
      pin: pinBriefRequest(world.db, pinBriefWorktree(world.db, renamed), 'claude'),
    });
    await next.plan();
    const typedText = await next.claim();
    expect(BRIEF.test(typedText)).toBe(true);
    next.settleInLock('sent', Date.now());
    expect(world.db.prepare('SELECT state FROM session_brief_boundaries WHERE worktree_id = ?').get(renamed)).toEqual({ state: 'sent' });
  });

  it('T4 negative: not renamed — the same plan is claimed', async () => {
    realPort(world);
    launch('claude');
    const brief = new SendBrief({ db: world.db, worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', mode: 'auto', content: 'x', typedBody: (t) => t, pin: entrance(world, 'claude') });
    await brief.plan();
    expect(BRIEF.test(await brief.claim())).toBe(true);
    brief.abandonInLock();
  });
});

describe('T5 off / disabled write nothing to mem (W5, review P2-1)', () => {
  it.each([
    ['mode off', () => setMem(world, 'off', true)],
    ['injectOnStart false', () => setMem(world, 'on', false)],
  ] as const)('%s: force and auto — the mem tables are byte for byte as before, no incarnation made', async (_name, arrange) => {
    arrange();
    realPort(world);
    launch('claude');
    const before = memFingerprint(world.db);
    expect(before.counts.mem_worktree_incarnations).toBe(0);
    await sendPinned(world, 'claude', 'a', entrance(world, 'claude'), 'force');
    await sendPinned(world, 'claude', 'b', entrance(world, 'claude'), 'auto');
    expect(memFingerprint(world.db)).toEqual(before);
    expect(typed(world, 'claude')).toEqual(['a', 'b']);
  });
});

describe('T5b the first send to a worktree with no incarnation and no row (2nd review ①)', () => {
  it('enabled: the entrance makes the incarnation, and the first auto send — whose launch comes after the entrance — is briefed', async () => {
    realPort(world);
    expect(incarnationRows()).toBe(0);
    expect(briefMayAttach(world.db, WT)).toBe(true);
    const pin = entrance(world, 'claude');
    expect(pin.worktreeIncarnation).not.toBeNull();
    expect(pin.anchorBoundaryId).toBeNull();
    launch('claude'); // the route starts the session after the entrance
    await sendPinned(world, 'claude', 'first', pin);
    expect(briefedCount()).toBe(1);
    expect(rows(world, 'claude')[0].state).toBe('sent');
  });

  it('negative: stored settings disabled at the entrance, enabled by the plan: lifetime_unpinned once, then briefed', async () => {
    setMem(world, 'on', false);
    realPort(world);
    const pin = entrance(world, 'claude');
    expect(pin.worktreeIncarnation).toBeNull();
    setMem(world, 'on', true);
    const sent = await sendPinned(world, 'claude', 'a', pin, 'force');
    expect(sent.report).toMatchObject({ state: 'skipped', reason: 'lifetime_unpinned' });
    expect(typed(world, 'claude')).toEqual(['a']);
    const again = await sendPinned(world, 'claude', 'b', entrance(world, 'claude'), 'force');
    expect(again.report).toMatchObject({ state: 'attached' });
  });
});

describe('T6 / T7 the rules that hold the pin in place', () => {
  it('T6 buildBrief with a request and no pinned lifetimes throws (worktree_lifetime)', async () => {
    const request = { target: { worktreeId: WT, instanceId: 'claude' } } as unknown as BriefRequest;
    await expect(buildBrief(world.db, { worktreeId: WT, instanceId: 'claude', time: PROVIDER_TIME_BUDGET, request, onMembershipTimeout: 'throw' })).rejects.toBeInstanceOf(
      BriefMembershipChangedError
    );
  });

  it('T6 negative: the CLI route’s build (no request) is unchanged — it needs no pin', async () => {
    const outcome = await buildBrief(world.db, { worktreeId: WT, instanceId: 'claude', time: PROVIDER_TIME_BUDGET, onMembershipTimeout: 'ambiguous' }, { target: { observe: async () => ({ branch: 'feature/a', detached: false, head: null, commonDir: null, known: true }), resolveCommonDir: async () => null, pathExists: () => true } });
    expect(outcome.kind).not.toBe('refused');
  });

  it('T7 the type requires a pin for auto / force (the line under @ts-expect-error would not compile without it)', async () => {
    const call = () =>
      // @ts-expect-error — brief 'auto' without briefPin is a compile error (D2 design §2.4).
      sendUserMessage(world.db, { worktreeId: WT, content: 'x', cliToolId: 'claude', brief: 'auto' });
    expect(typeof call).toBe('function');
    // A caller that says nothing (relay delivery) compiles: the default is never.
    const never = () => sendUserMessage(world.db, { worktreeId: WT, content: 'x', cliToolId: 'claude' });
    expect(typeof never).toBe('function');
  });

  it('plan() a second time on the same SendBrief does nothing (D2 design §3.3 (c))', async () => {
    const { port } = realPort(world);
    const build = vi.spyOn(port, 'build');
    launch('claude');
    const brief = new SendBrief({ db: world.db, worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', mode: 'auto', content: 'x', typedBody: (t) => t, pin: entrance(world, 'claude') });
    await brief.plan();
    await brief.plan();
    expect(build).toHaveBeenCalledTimes(1);
    expect(getWorktreeIncarnation(world.db, WT)).not.toBeNull();
  });
});
