/**
 * Issue #4274 (D1 of #4224): a session brief is put in front of the first send after
 * each conversation boundary, once — the acceptance criteria and the design's
 * contrasts (`docs/design/session-boundary-brief-4274.md` §9, and §12.2 for the
 * second pre-review's A〜E).
 *
 * Real: the migrated DB (in a `mkdtemp` sandbox), the launch (`beginAgentSession`),
 * the hook intake fed the committed fixtures of Claude Code, Codex and Command
 * Code, `withMemTarget`, the input lock and the send service. Faked: the tool's
 * `sendMessage` (records what would be typed), git's answer, the pane, the provider.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
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

import {
  BOUNDARY_TOOL_IDS,
  FAKE_BRIEF,
  WT,
  briefCount,
  briefed,
  closeWorld,
  failNextSend,
  fakeProvider,
  hook,
  launch,
  makeWorld,
  rows,
  send,
  setMem,
  typed,
  bindWorld,
  type BoundaryTool,
  type World,
} from './session-brief-4274-harness';
import { isPromptWaiting } from '@/lib/session/prompt-waiting-guard';
import { resetLiveBriefClaimsForTest } from '@/lib/session/session-brief';
import { addAgentInstance, removeAgentInstance, setAgentInstances } from '@/lib/db/agent-instances-db';
import { startInstanceIncarnation } from '@/lib/mem/incarnation';
import { getMemSettings } from '@/lib/db/mem-db';
import { SEND_VERIFIED_MAX_BYTES } from '@/config/send-verified-limits';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { withInstanceInputLock } from '@/lib/session/instance-input-lock';
import type { BriefRequest } from '@/lib/session/brief-provider';

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
});

afterEach(() => {
  closeWorld(world);
});

const RESET: Record<BoundaryTool, string> = { claude: '/clear', codex: '/new', 'command-code': '/clear' };

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

describe('each kind of boundary carries the fake brief once', () => {
  it.each(BOUNDARY_TOOL_IDS)('%s: launch → the first send carries it, the second does not', async (tool) => {
    fakeProvider();
    launch(tool);
    await send(tool, 'first');
    await send(tool, 'second');
    expect(typed(world, tool)).toEqual([`${FAKE_BRIEF}\n\nfirst`, 'second']);
    expect(rows(world, tool)[0]).toMatchObject({ kind: 'launch', state: 'sent', lastOutcome: 'sent', includedIds: ['n1'] });
  });

  it.each(BOUNDARY_TOOL_IDS)('%s: launch → send → typed reset → send carries it again (the reset itself never)', async (tool) => {
    fakeProvider();
    launch(tool);
    await send(tool, 'first');
    await send(tool, RESET[tool]);
    await send(tool, 'after reset');
    await send(tool, 'and again');
    expect(typed(world, tool)).toEqual([`${FAKE_BRIEF}\n\nfirst`, RESET[tool], `${FAKE_BRIEF}\n\nafter reset`, 'and again']);
  });

  it.each(BOUNDARY_TOOL_IDS)('%s: a relaunch (the process exited, started again) is a boundary', async (tool) => {
    fakeProvider();
    launch(tool);
    await send(tool, 'one');
    launch(tool);
    await send(tool, 'two');
    expect(briefCount(world, tool)).toBe(2);
  });

  it.each(BOUNDARY_TOOL_IDS)('%s (control): an instance with no boundary row is sent the body alone', async (tool) => {
    const provider = fakeProvider();
    await send(tool, 'plain');
    expect(typed(world, tool)).toEqual(['plain']);
    expect(provider.build).not.toHaveBeenCalled();
  });

  it('a tool outside the table (copilot) gets nothing and opens nothing', async () => {
    fakeProvider();
    launch('copilot' as BoundaryTool);
    await send('copilot', 'hi');
    expect(typed(world, 'copilot')).toEqual(['hi']);
    expect(rows(world, 'copilot')).toEqual([]);
  });
});

describe('hooks (committed fixtures through the intake)', () => {
  it('Claude: the reset hook and the typed /clear, in either order, open one boundary and brief once', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start.json', { sessionId: 'conv-1' });
    await send('claude', 'first');
    // send first, hook after
    await send('claude', '/clear');
    hook(world, 'claude', 'session-start-clear.json', { sessionId: 'conv-2' });
    await send('claude', 'second');
    // hook first (while the send that typed it is still finishing), send after
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      hook(world, 'claude', 'session-end-clear.json', { sessionId: 'conv-2' });
      hook(world, 'claude', 'session-start-clear.json', { sessionId: 'conv-3' });
    });
    await send('claude', '/clear');
    await send('claude', 'third');
    await send('claude', 'fourth');
    expect(typed(world, 'claude')).toEqual([
      `${FAKE_BRIEF}\n\nfirst`,
      '/clear',
      `${FAKE_BRIEF}\n\nsecond`,
      '/clear',
      `${FAKE_BRIEF}\n\nthird`,
      'fourth',
    ]);
    const resets = rows(world, 'claude').filter((row) => row.kind === 'reset');
    expect(resets).toHaveLength(2);
    expect(resets.map((row) => row.conversationId).sort()).toEqual(['conv-2', 'conv-3']);
  });

  it('a redelivered clear (same session id) after a "restart" (claims forgotten, DB kept) adds nothing', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start-clear.json', { sessionId: 'conv-9' });
    await send('claude', 'one');
    resetLiveBriefClaimsForTest();
    hook(world, 'claude', 'session-start-clear.json', { sessionId: 'conv-9' });
    await send('claude', 'two');
    expect(briefCount(world, 'claude')).toBe(1);
  });

  it('a reset typed in the terminal (hook only) briefs the next send once', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start.json', { sessionId: 'conv-1' });
    await send('claude', 'one');
    hook(world, 'claude', 'session-start-clear.json', { sessionId: 'conv-2' });
    await send('claude', 'two');
    await send('claude', 'three');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\none`, `${FAKE_BRIEF}\n\ntwo`, 'three']);
  });

  it.each(['codex', 'command-code'] as BoundaryTool[])('%s: the startup SessionStart binds the launch row (no second brief)', async (tool) => {
    fakeProvider();
    launch(tool);
    hook(world, tool, 'session-start.json', { sessionId: `${tool}-conv` });
    await send(tool, 'one');
    await send(tool, 'two');
    expect(briefCount(world, tool)).toBe(1);
    expect(rows(world, tool)).toHaveLength(1);
    expect(rows(world, tool)[0].conversationId).toBe(`${tool}-conv`);
  });

  it('a reconnect with no reset (no launch, no hook) does not brief; neither does compact', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start.json', { sessionId: 'conv-1' });
    await send('claude', 'one');
    hook(world, 'claude', 'session-start.json', { sessionId: 'conv-1', source: 'compact' });
    await send('claude', 'two');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\none`, 'two']);
  });

  it('resume to another conversation briefs; a resume to the same conversation does not', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start.json', { sessionId: 'A' });
    await send('claude', 'one');
    hook(world, 'claude', 'session-start.json', { sessionId: 'A', source: 'resume' });
    await send('claude', 'same');
    hook(world, 'claude', 'session-start.json', { sessionId: 'B', source: 'resume' });
    await send('claude', 'other');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\none`, 'same', `${FAKE_BRIEF}\n\nother`]);
  });

  it('[2nd review E] resume A → B → A → B briefs each change once; a redelivery of the current one adds nothing', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start.json', { sessionId: 'A' });
    await send('claude', 'start');
    for (const id of ['B', 'A', 'B']) {
      hook(world, 'claude', 'session-start.json', { sessionId: id, source: 'resume' });
      hook(world, 'claude', 'session-start.json', { sessionId: id, source: 'resume' });
      await send('claude', `to ${id}`);
    }
    expect(typed(world, 'claude')).toEqual([
      `${FAKE_BRIEF}\n\nstart`,
      `${FAKE_BRIEF}\n\nto B`,
      `${FAKE_BRIEF}\n\nto A`,
      `${FAKE_BRIEF}\n\nto B`,
    ]);
  });

  it('[review ②] a headless run’s hooks (no instance, resolved from cwd) open and bind nothing', async () => {
    fakeProvider();
    launch('codex');
    hook(world, 'codex', 'session-start.json', { sessionId: 'interactive' });
    await send('codex', 'one');
    hook(world, 'codex', 'session-start.json', { sessionId: 'headless', identified: false });
    hook(world, 'codex', 'stop.json', { sessionId: 'headless', identified: false });
    await send('codex', 'two');
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\none`, 'two']);
    expect(rows(world, 'codex')).toHaveLength(1);
    // (control) the pane's own identified clear does open one.
    hook(world, 'codex', 'session-start.json', { sessionId: 'interactive-2', source: 'clear' });
    await send('codex', 'three');
    expect(briefCount(world, 'codex')).toBe(2);
  });

  it('a turn of a conversation the ledger has not seen (a reset while the server was down) is a late boundary', async () => {
    fakeProvider();
    launch('claude');
    hook(world, 'claude', 'session-start.json', { sessionId: 'old' });
    await send('claude', 'one');
    hook(world, 'claude', 'stop.json', { sessionId: 'new' });
    await send('claude', 'two');
    // (control) a late event of the earlier conversation is not a boundary.
    hook(world, 'claude', 'stop.json', { sessionId: 'old' });
    await send('claude', 'three');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\none`, `${FAKE_BRIEF}\n\ntwo`, 'three']);
    expect(rows(world, 'claude')[0]).toMatchObject({ kind: 'reset', late: true, conversationId: 'new' });
  });
});

describe('the "once" holds through concurrency, refusals, unknown outcomes and restarts', () => {
  it.each(BOUNDARY_TOOL_IDS)('%s: two first sends at once → one brief, on the body typed first', async (tool) => {
    fakeProvider();
    launch(tool);
    await Promise.all([send(tool, 'a'), send(tool, 'b')]);
    const bodies = typed(world, tool);
    expect(bodies.filter((text) => text.startsWith(FAKE_BRIEF))).toHaveLength(1);
    expect(bodies[0].startsWith(FAKE_BRIEF)).toBe(true);
  });

  it('(control) with no boundary, command-code is not wrapped in the outer lock (path as before)', async () => {
    fakeProvider();
    const session = resolveSessionName('command-code', WT, undefined);
    let release!: () => void;
    const held = withInstanceInputLock(session, () => new Promise<void>((resolve) => (release = resolve)));
    const outcome = await send('command-code', 'unlocked');
    expect(outcome.result.ok).toBe(true);
    release();
    await held;
  });

  it.each(BOUNDARY_TOOL_IDS)('%s [review ⑥]: A claims then is not-sent; B waiting on the lock gets it', async (tool) => {
    fakeProvider();
    launch(tool);
    failNextSend(world, tool, 'not-sent');
    const [a, b] = await Promise.all([send(tool, 'a'), send(tool, 'b')]);
    expect(a.result.ok).toBe(false);
    expect(b.result.ok).toBe(true);
    expect(typed(world, tool)).toEqual([`${FAKE_BRIEF}\n\na`, `${FAKE_BRIEF}\n\nb`]);
    expect(rows(world, tool)[0]).toMatchObject({ state: 'sent', attempts: 1 });
  });

  it.each(BOUNDARY_TOOL_IDS)('%s (control): A sent / unknown → B waiting gets nothing', async (tool) => {
    fakeProvider();
    launch(tool);
    failNextSend(world, tool, 'indeterminate');
    await Promise.all([send(tool, 'a'), send(tool, 'b')]);
    expect(briefCount(world, tool)).toBe(1);
    expect(rows(world, tool)[0]).toMatchObject({ state: 'unknown', lastOutcome: 'unknown' });
  });

  it('a refused send (prompt waiting) leaves the boundary pending; the next send carries it', async () => {
    fakeProvider();
    launch('claude');
    vi.mocked(isPromptWaiting).mockResolvedValueOnce({ waiting: true, reason: 'scraper', blockedBy: 'scraper' } as never);
    const refused = await send('claude', 'refused');
    expect(refused.result.ok).toBe(false);
    expect(typed(world, 'claude')).toEqual([]);
    expect(rows(world, 'claude')[0].state).toBe('pending');
    await send('claude', 'next');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nnext`]);
  });

  it('a not-sent delivery puts the boundary back; the next send carries it', async () => {
    fakeProvider();
    launch('codex');
    failNextSend(world, 'codex', 'not-sent');
    await send('codex', 'lost');
    await send('codex', 'next');
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\nlost`, `${FAKE_BRIEF}\n\nnext`]);
    expect(rows(world, 'codex')[0]).toMatchObject({ state: 'sent', attempts: 1 });
  });

  it('an unknown delivery is not briefed again — except when the operator forces it', async () => {
    fakeProvider();
    launch('claude');
    failNextSend(world, 'claude', 'indeterminate');
    const first = await send('claude', 'maybe');
    expect(first.report).toMatchObject({ state: 'unknown' });
    await send('claude', 'auto');
    const forced = await send('claude', 'forced', { brief: 'force' });
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nmaybe`, 'auto', `${FAKE_BRIEF}\n\nforced`]);
    expect(forced.report).toMatchObject({ state: 'attached' });
  });

  it('a server restart (claims forgotten, DB kept): a reconnect gets nothing; a claim left behind reads unknown', async () => {
    fakeProvider();
    launch('claude');
    await send('claude', 'before');
    resetLiveBriefClaimsForTest();
    await send('claude', 'reconnect');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nbefore`, 'reconnect']);
    // A claim of a process that is gone.
    launch('claude');
    world.db.prepare("UPDATE session_brief_boundaries SET state = 'claimed', claim_token = 'gone:x' WHERE state = 'pending'").run();
    await send('claude', 'after crash');
    expect(typed(world, 'claude')[2]).toBe('after crash');
    expect(rows(world, 'claude')[0].state).toBe('unknown');
    // (control) a dead process started again by a launch is a new boundary.
    launch('claude');
    await send('claude', 'relaunched');
    expect(typed(world, 'claude')[3]).toBe(`${FAKE_BRIEF}\n\nrelaunched`);
  });

  it('[review ⑤] a relaunch inside the send that carried the brief is not briefed again; a reset opened meanwhile is', async () => {
    fakeProvider();
    launch('claude');
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      launch('claude'); // relaunchIfToolExited inside sendMessage
    });
    await send('claude', 'one');
    await send('claude', 'two');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\none`, 'two']);
    expect(rows(world, 'claude')[0]).toMatchObject({ kind: 'auto_restart', state: 'sent' });

    launch('claude');
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      launch('claude');
      hook(world, 'claude', 'session-start-clear.json', { sessionId: 'later-reset' });
    });
    await send('claude', 'three');
    await send('claude', 'four');
    expect(typed(world, 'claude').slice(2)).toEqual([`${FAKE_BRIEF}\n\nthree`, `${FAKE_BRIEF}\n\nfour`]);
  });
});

describe('mode, --no-brief and the budget', () => {
  it.each([
    ['mode off', () => setMem(world, 'off', true), 'off'],
    ['injectOnStart false', () => setMem(world, 'on', false), 'disabled'],
  ])('%s: nothing is attached, the provider is not asked, the boundary is used up', async (_name, configure, reason) => {
    const provider = fakeProvider();
    configure();
    launch('claude');
    await send('claude', 'one');
    setMem(world, 'on', true);
    await send('claude', 'two');
    expect(typed(world, 'claude')).toEqual(['one', 'two']);
    expect(provider.build).not.toHaveBeenCalled();
    expect(rows(world, 'claude')[0]).toMatchObject({ state: 'skipped', skipReason: reason, includedIds: null, briefBytes: null });
  });

  it('--no-brief skips this one send; the next carries it; settings unchanged', async () => {
    fakeProvider();
    launch('claude');
    const before = getMemSettings(world.db, world.repoId);
    const skipped = await send('claude', 'skip me', { brief: 'skip' });
    await send('claude', 'next');
    expect(typed(world, 'claude')).toEqual(['skip me', `${FAKE_BRIEF}\n\nnext`]);
    expect(skipped.report).toEqual({ state: 'skipped', reason: 'no_brief' });
    expect(getMemSettings(world.db, world.repoId)).toEqual(before);
  });

  it('--with-brief attaches with no boundary detected (an explicit row), every time it is asked', async () => {
    fakeProvider();
    await send('codex', 'x', { brief: 'force' });
    await send('codex', 'y', { brief: 'force' });
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\nx`, `${FAKE_BRIEF}\n\ny`]);
    expect(rows(world, 'codex').map((row) => row.kind)).toEqual(['explicit', 'explicit']);
  });

  it('a slash command is never briefed and leaves the boundary for the next send', async () => {
    fakeProvider();
    launch('claude');
    await send('claude', '/model');
    await send('claude', 'hello');
    expect(typed(world, 'claude')).toEqual(['/model', `${FAKE_BRIEF}\n\nhello`]);
  });

  /** A body whose budget left (bytes) is `room` once the separator is counted. */
  const bodyLeaving = (room: number): string => 'x'.repeat(SEND_VERIFIED_MAX_BYTES - 2 - room);

  it('room of minBytes − 1: provider not asked, body byte-identical, row over_limit', async () => {
    const provider = fakeProvider();
    launch('claude');
    const body = bodyLeaving(15);
    await send('claude', body);
    expect(provider.build).not.toHaveBeenCalled();
    expect(typed(world, 'claude')).toEqual([body]);
    expect(rows(world, 'claude')[0]).toMatchObject({ state: 'skipped', skipReason: 'over_limit' });
  });

  it('a body alone over the verified size (49 KiB) is sent whole, unbriefed', async () => {
    fakeProvider();
    launch('claude');
    const body = 'あ'.repeat(Math.ceil((49 * 1024) / 3));
    await send('claude', body);
    expect(typed(world, 'claude')).toEqual([body]);
  });

  it('(control) room exactly minBytes: the provider gets maxBytes = minBytes and the brief is attached', async () => {
    const provider = fakeProvider();
    launch('claude');
    const body = bodyLeaving(16);
    await send('claude', body);
    expect((provider.build.mock.calls[0][0] as BriefRequest).budget.maxBytes).toBe(16);
    expect(briefed(typed(world, 'claude')[0], body)).toBe(true);
  });

  it('(control) a Japanese / emoji body keeps its bytes', async () => {
    fakeProvider();
    launch('codex');
    const body = '日本語の本文 🚀 と絵文字';
    await send('codex', body);
    expect(Buffer.from(typed(world, 'codex')[0]).subarray(-Buffer.byteLength(body)).toString()).toBe(body);
  });

  it('[review ⑧] lines with an image: the image line lowers maxLines; an over-long brief is left off', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
    const provider = fakeProvider({
      minBytes: 1,
      build: vi.fn((request: BriefRequest) => ({ body: lines(238), includedNoticeIds: [], mode: request.membership.mode })),
    });
    launch('claude');
    await send('claude', 'one line', { absoluteImagePath: '/tmp/image.png' });
    expect((provider.build.mock.calls[0][0] as BriefRequest).budget.maxLines).toBe(237);
    expect(typed(world, 'claude')).toEqual(['one line\n![](/tmp/image.png)']);
    expect(rows(world, 'claude')[0]).toMatchObject({ state: 'skipped', skipReason: 'over_limit' });
  });

  it('(control) no image, the final text exactly 240 lines: attached, body whole', async () => {
    const brief = Array.from({ length: 238 }, (_, i) => `l${i}`).join('\n');
    fakeProvider({ minBytes: 1, build: vi.fn((request: BriefRequest) => ({ body: brief, includedNoticeIds: [], mode: request.membership.mode })) });
    launch('claude');
    await send('claude', 'one line');
    expect(typed(world, 'claude')).toEqual([`${brief}\n\none line`]);
  });

  it('a provider that throws, answers another mode, or answers over budget: no brief, body sent', async () => {
    for (const build of [
      () => {
        throw new Error('boom');
      },
      () => ({ body: FAKE_BRIEF, includedNoticeIds: [], mode: 'derived' as const }),
      () => ({ body: 'y'.repeat(5000), includedNoticeIds: [], mode: 'on' as const }),
    ]) {
      fakeProvider({ build: vi.fn(build) });
      launch('claude');
      await send('claude', 'body');
    }
    expect(typed(world, 'claude')).toEqual(['body', 'body', 'body']);
    expect(rows(world, 'claude').slice(0, 3).map((row) => row.skipReason)).toEqual(['over_limit', 'provider_failed', 'provider_failed']);
  });
});

describe('settings and the instance’s lifetime between the plan and the claim', () => {
  it.each([
    ['mode off', () => setMem(world, 'off', true)],
    ['derived', () => setMem(world, 'derived', true)],
    ['injectOnStart false', () => setMem(world, 'on', false)],
  ])('[review ③] %s while the provider waits: brief removed, body sent', async (_name, change) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = fakeProvider({
      build: vi.fn(async (request: BriefRequest) => {
        await gate;
        return { body: FAKE_BRIEF, includedNoticeIds: [], mode: request.membership.mode };
      }),
    });
    launch('claude');
    const pending = send('claude', 'body');
    await until(() => provider.build.mock.calls.length === 1);
    change();
    release();
    const outcome = await pending;
    expect(typed(world, 'claude')).toEqual(['body']);
    expect(outcome.report).toBeNull();
  });

  it('[2nd review B] the branch moves from an on branch to an off one while the lock is held: brief removed', async () => {
    const provider = fakeProvider();
    setMem(world, 'on', true, [
      { match: 'glob', pattern: 'feature/a', mode: 'on' },
      { match: 'glob', pattern: '**', mode: 'off' },
    ]);
    launch('claude');
    const session = resolveSessionName('claude', WT, undefined);
    let releaseLock!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = withInstanceInputLock(session, () => {
      locked();
      return new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await isLocked;
    const pending = send('claude', 'body');
    await until(() => provider.build.mock.calls.length === 1);
    world.branch = 'feature/b';
    releaseLock();
    await holder;
    await pending;
    expect(typed(world, 'claude')).toEqual(['body']);
  });

  it('(control) the branch unchanged while the lock is held: attached', async () => {
    const provider = fakeProvider();
    launch('claude');
    const session = resolveSessionName('claude', WT, undefined);
    let releaseLock!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = withInstanceInputLock(session, () => {
      locked();
      return new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await isLocked;
    const pending = send('claude', 'body');
    await until(() => provider.build.mock.calls.length === 1);
    releaseLock();
    await holder;
    await pending;
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nbody`]);
  });

  async function withProviderWait(during: () => void): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = fakeProvider({
      build: vi.fn(async (request: BriefRequest) => {
        await gate;
        return { body: FAKE_BRIEF, includedNoticeIds: [], mode: request.membership.mode };
      }),
    });
    const pending = send('codex', 'body', { instanceId: 'codex-2' });
    await until(() => provider.build.mock.calls.length === 1);
    during();
    release();
    await pending;
  }

  it('[review ④] the instance deleted and added again (new incarnation) while the provider waits: not briefed', async () => {
    addAgentInstance(world.db, WT, { id: 'codex-2', cliTool: 'codex' } as never);
    launch('codex', 'codex-2');
    await withProviderWait(() => {
      removeAgentInstance(world.db, WT, 'codex-2');
      addAgentInstance(world.db, WT, { id: 'codex-2', cliTool: 'codex' } as never);
    });
    expect(typed(world, 'codex')).toEqual(['body']);
    expect(rows(world, 'codex-2')[0]).toMatchObject({ state: 'skipped', skipReason: 'incarnation_changed' });
  });

  const PRE_V66_ROW =
    "INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, 'codex-2', 'codex', '', 0, 1)";

  it('[2nd review C] a roster row with no incarnation (pre-v66), deleted and added again: not briefed', async () => {
    world.db.prepare(PRE_V66_ROW).run(WT);
    launch('codex', 'codex-2');
    expect(rows(world, 'codex-2')[0]).toMatchObject({ instanceIncarnation: null, onRoster: true });
    await withProviderWait(() => {
      removeAgentInstance(world.db, WT, 'codex-2');
      addAgentInstance(world.db, WT, { id: 'codex-2', cliTool: 'codex' } as never);
    });
    expect(typed(world, 'codex')).toEqual(['body']);
    expect(rows(world, 'codex-2')[0]).toMatchObject({ state: 'skipped', skipReason: 'incarnation_changed' });
  });

  it('[review 2b ②] a pre-v66 roster row given its incarnation late by mem (issued_by lazy): briefed, row filled in', async () => {
    world.db.prepare(PRE_V66_ROW).run(WT);
    launch('codex', 'codex-2');
    let incarnation = '';
    await withProviderWait(() => {
      incarnation = startInstanceIncarnation(world.db, WT, 'codex-2', 'codex', Date.now(), 'lazy');
    });
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\nbody`]);
    expect(rows(world, 'codex-2')[0]).toMatchObject({ state: 'sent', instanceIncarnation: incarnation });
  });

  it('[review 2b ①] a pre-v66 roster row (no incarnation) deleted while the provider waits: not briefed', async () => {
    world.db.prepare(PRE_V66_ROW).run(WT);
    launch('codex', 'codex-2');
    await withProviderWait(() => {
      removeAgentInstance(world.db, WT, 'codex-2');
    });
    expect(typed(world, 'codex')).toEqual(['body']);
    expect(rows(world, 'codex-2')[0]).toMatchObject({ state: 'skipped', skipReason: 'incarnation_changed' });
  });

  it('[review 2b ①] (control) a pre-v66 roster row left as it is: briefed', async () => {
    world.db.prepare(PRE_V66_ROW).run(WT);
    launch('codex', 'codex-2');
    await withProviderWait(() => {});
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\nbody`]);
  });

  it('(control) a primary off the roster, incarnation issued late by the first mem write: briefed, row filled in', async () => {
    launch('codex', 'codex-2');
    expect(rows(world, 'codex-2')[0]).toMatchObject({ instanceIncarnation: null, onRoster: false });
    let incarnation = '';
    await withProviderWait(() => {
      incarnation = startInstanceIncarnation(world.db, WT, 'codex-2', 'codex');
    });
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\nbody`]);
    expect(rows(world, 'codex-2')[0]).toMatchObject({ state: 'sent', instanceIncarnation: incarnation });
  });

  // The roster's full replace (`setAgentInstances`, what the API calls for a reorder or
  // an alias edit) deletes and re-inserts every row with a new `created_at`.
  const fullReplace = (alias: string) =>
    setAgentInstances(world.db, WT, [
      { id: 'codex-3', cliTool: 'codex' } as never,
      { id: 'codex-2', cliTool: 'codex', alias } as never,
    ]);

  it.each([
    ['with an incarnation', () => addAgentInstance(world.db, WT, { id: 'codex-2', cliTool: 'codex' } as never)],
    ['pre-v66, no incarnation', () => void world.db.prepare(PRE_V66_ROW).run(WT)],
  ])('[consistency review 2] (control) the full replace (reorder, alias) keeps the lifetime, %s: briefed', async (_name, seed) => {
    seed();
    launch('codex', 'codex-2');
    await withProviderWait(() => fullReplace('Codex Two'));
    expect(typed(world, 'codex')).toEqual([`${FAKE_BRIEF}\n\nbody`]);
    expect(rows(world, 'codex-2')[0].state).toBe('sent');
  });

  it('[consistency review 2] delete and re-add of the same id through the full replace: not briefed', async () => {
    addAgentInstance(world.db, WT, { id: 'codex-2', cliTool: 'codex' } as never);
    launch('codex', 'codex-2');
    await withProviderWait(() => {
      setAgentInstances(world.db, WT, [{ id: 'codex-3', cliTool: 'codex' } as never]);
      fullReplace('back again');
    });
    expect(typed(world, 'codex')).toEqual(['body']);
    expect(rows(world, 'codex-2')[0]).toMatchObject({ state: 'skipped', skipReason: 'incarnation_changed' });
  });
});

describe('[consistency review 1] an older boundary is not claimed once a newer one opened', () => {
  it('A claims X and relaunches (Y) but does not send; B planned X meanwhile: B is not briefed, Y gets one brief', async () => {
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    const provider = fakeProvider({
      build: vi.fn(async (request: BriefRequest) => {
        if (provider.build.mock.calls.length === 2) await gateB;
        return { body: FAKE_BRIEF, includedNoticeIds: ['n1'], mode: request.membership.mode };
      }),
    });
    launch('claude');
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      await until(() => provider.build.mock.calls.length === 2); // B has planned X
      launch('claude'); // relaunchIfToolExited inside A's send: Y
      const error = new Error('load-buffer failed') as Error & { code?: string };
      error.code = 'PASTE_NOT_STARTED';
      throw error;
    });
    const a = send('claude', 'a');
    await until(() => provider.build.mock.calls.length === 1);
    const b = send('claude', 'b');
    await a;
    releaseB();
    const sentB = await b;
    await send('claude', 'c');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\na`, 'b', `${FAKE_BRIEF}\n\nc`]);
    expect(sentB.report).toBeNull(); // `auto` reports only what was attached
    expect(rows(world, 'claude').map((row) => [row.kind, row.state])).toEqual([
      ['auto_restart', 'sent'],
      ['launch', 'superseded'],
    ]);
  });

  it('(control) the same boundary, not sent then sent again with nothing newer: briefed once, on the retry', async () => {
    fakeProvider();
    launch('claude');
    failNextSend(world, 'claude', 'not-sent');
    await send('claude', 'a');
    await send('claude', 'a');
    await send('claude', 'b');
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\na`, `${FAKE_BRIEF}\n\na`, 'b']);
    expect(rows(world, 'claude')).toHaveLength(1);
    expect(rows(world, 'claude')[0]).toMatchObject({ state: 'sent', attempts: 1 });
  });
});

describe('[2nd review A] a reset’s row is open before the lock is released', () => {
  it('/clear holding the lock, a plain send queued behind (no hooks): the new conversation gets one brief', async () => {
    const provider = fakeProvider();
    launch('command-code');
    let releaseClear!: () => void;
    world.tools['command-code'].sendMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseClear = resolve))
    );
    const clear = send('command-code', '/clear');
    await until(() => typed(world, 'command-code').length === 1);
    const plain = send('command-code', 'plain');
    await until(() => provider.build.mock.calls.length === 1);
    releaseClear();
    await clear;
    await plain;
    await send('command-code', 'next');
    const afterReset = typed(world, 'command-code').slice(1);
    expect(afterReset.filter((text) => text.startsWith(FAKE_BRIEF))).toHaveLength(1);
    expect(typed(world, 'command-code')).toEqual(['/clear', 'plain', `${FAKE_BRIEF}\n\nnext`]);
  });

  it.each(BOUNDARY_TOOL_IDS)('%s: the next holder of the input lock already sees the reset’s row', async (tool) => {
    fakeProvider();
    launch(tool);
    let releaseClear!: () => void;
    world.tools[tool].sendMessage.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseClear = resolve)));
    const clear = send(tool, RESET[tool]);
    await until(() => typed(world, tool).length === 1);
    let seen: string[] = [];
    const next = withInstanceInputLock(resolveSessionName(tool, WT, undefined), async () => {
      seen = rows(world, tool).map((row) => `${row.kind}:${row.state}`);
    });
    releaseClear();
    await Promise.all([clear, next]);
    expect(seen).toEqual(['reset:pending', 'launch:superseded']);
  });

  it('(control) sequential sends keep the order of the table', async () => {
    fakeProvider();
    launch('command-code');
    await send('command-code', '/clear');
    await send('command-code', 'plain');
    expect(typed(world, 'command-code')).toEqual(['/clear', `${FAKE_BRIEF}\n\nplain`]);
  });
});

describe('[2nd review D / review ⑦] the provider’s reservation and settle', () => {
  function reservingProvider(notice: (instance: string) => string) {
    const taken = new Set<string>();
    return fakeProvider({
      build: vi.fn((request: BriefRequest) => ({
        body: `[[brief:${notice(request.target.instanceId)}]]`,
        includedNoticeIds: [notice(request.target.instanceId)],
        mode: request.membership.mode,
      })),
      reserve: ({ includedNoticeIds }) => {
        const free = includedNoticeIds.filter((id) => !taken.has(id));
        if (free.length === 0) return null;
        free.forEach((id) => taken.add(id));
        return { body: `[[brief:${free.join(',')}]]`, includedNoticeIds: free };
      },
    });
  }

  it('two boundaries of two instances pick the same notice: it is in one body only', async () => {
    reservingProvider(() => 'shared');
    launch('codex');
    launch('codex', 'codex-2');
    await Promise.all([send('codex', 'a'), send('codex', 'b', { instanceId: 'codex-2' })]);
    expect(typed(world, 'codex').filter((text) => text.includes('[[brief:shared]]'))).toHaveLength(1);
  });

  it('(control) different notices: both bodies carry theirs', async () => {
    reservingProvider((instance) => `n-${instance}`);
    launch('codex');
    launch('codex', 'codex-2');
    await Promise.all([send('codex', 'a'), send('codex', 'b', { instanceId: 'codex-2' })]);
    expect(typed(world, 'codex').filter((text) => text.startsWith('[[brief:n-'))).toHaveLength(2);
  });

  it('settle(sent) once with the ids actually typed, even when two sends built', async () => {
    const provider = fakeProvider();
    launch('claude');
    await Promise.all([send('claude', 'a'), send('claude', 'b')]);
    const sent = provider.settle.mock.calls.filter((call) => call[0].outcome === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0][0].includedNoticeIds).toEqual(['n1']);
  });

  it('(control) not-sent and over-budget never settle as sent; preview (build only) settles nothing', async () => {
    const provider = fakeProvider();
    launch('claude');
    failNextSend(world, 'claude', 'not-sent');
    await send('claude', 'lost');
    expect(provider.settle.mock.calls.map((call) => call[0].outcome)).toEqual(['not_sent']);
    provider.build({ target: {}, membership: { mode: 'on' } } as never);
    expect(provider.settle).toHaveBeenCalledTimes(1);
  });
});
