/**
 * H21: the screen's choice for the boundary its preview showed (Issue #4227, design
 * `docs/design/mem-ui-4227.md` §3.2 S-B).
 *
 * `full` (with `auto`) and `decline` act on the shown boundary only while it is the
 * instance's current `pending` row. Otherwise — a newer row, another send's claim, the
 * provider failing, the brief over its budget, the claim's stretch throwing — the send
 * stops before any key: `stage: 'brief_choice'`, nothing typed, the boundary as it was.
 * `auto` (the short brief) keeps D1's behaviour in each of those cases.
 *
 * Driven through the real send service (`sendUserMessage`) with the 4274 world (fake
 * tools, a temporary DB under `os.tmpdir()`).
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

import { FAKE_BRIEF, WT, bindWorld, closeWorld, failNextSend, fakeProvider, launch, makeWorld, send, typed, type World } from './session-brief-4274-harness';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { getBoundaryById, getCurrentBoundary } from '@/lib/db/session-brief-db';
import { BriefChoiceAbortedError, setBriefMemTargetDepsForTest } from '@/lib/session/session-brief';
import { getLastSendAttempt } from '@/lib/session/send-attempt-state';
import type { BriefRequest } from '@/lib/session/brief-provider';

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  addAgentInstance(world.db, WT, { id: 'claude', cliTool: 'claude', alias: '', order: 0 });
});
afterEach(() => closeWorld(world));

/** The current row's id after a launch (the boundary a preview would show). */
function shown(): string {
  const row = getCurrentBoundary(world.db, WT, 'claude');
  if (!row) throw new Error('no boundary');
  return row.id;
}
const stateOf = (id: string) => getBoundaryById(world.db, id)?.state;
const skipReasonOf = (id: string) => getBoundaryById(world.db, id)?.skipReason;

type Choice = { brief: 'decline' } | { briefDetail: 'full' };
const CHOICES: Array<[string, Choice]> = [
  ['decline', { brief: 'decline' }],
  ['full', { briefDetail: 'full' }],
];

function expectAborted(result: Awaited<ReturnType<typeof send>>['result'], reason: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.stage).toBe('brief_choice');
  if (result.stage !== 'brief_choice') return;
  expect(result.code).toBe('boundary_changed');
  expect(result.reason).toBe(reason);
}

describe('H21 (c) nothing changed: as chosen', () => {
  it('decline: the body alone, the shown row skipped(declined), reported', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    const { result, report } = await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual(['x']);
    expect(stateOf(a)).toBe('skipped');
    expect(skipReasonOf(a)).toBe('declined');
    expect(report).toEqual({ state: 'skipped', reason: 'declined', boundaryId: a });
    // The next send carries nothing: "don't read" is not "this send only".
    await send('claude', 'y');
    expect(typed(world, 'claude')).toEqual(['x', 'y']);
  });

  it('full: the brief in front, the provider asked `detail: full` with C’s text maximum within #2464', async () => {
    const provider = fakeProvider();
    launch('claude');
    const a = shown();
    const { result, report } = await send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nx`]);
    const asked = provider.build.mock.calls[0][0] as BriefRequest;
    expect(asked.detail).toBe('full');
    expect(asked.budget.maxBytes).toBeGreaterThan(4096);
    expect(stateOf(a)).toBe('sent');
    expect(report).toEqual({ state: 'attached', boundaryId: a });
  });

  it('negative: auto (short) asks no detail and the default budget, as before', async () => {
    const provider = fakeProvider();
    launch('claude');
    await send('claude', 'x');
    const asked = provider.build.mock.calls[0][0] as BriefRequest;
    expect('detail' in asked).toBe(false);
    expect(asked.budget.maxBytes).toBe(4096);
  });
});

describe('H21 (a) the shown row was replaced (A → B): full and decline stop before any key', () => {
  it.each(CHOICES)('%s: 409 superseded, nothing typed, B still pending', async (_name, choice) => {
    fakeProvider();
    launch('claude');
    const a = shown();
    launch('claude');
    const b = shown();
    expect(b).not.toBe(a);
    const { result } = await send('claude', 'x', { ...choice, briefBoundary: a });
    expectAborted(result, 'superseded');
    expect(typed(world, 'claude')).toEqual([]);
    expect(stateOf(b)).toBe('pending');
  });

  it('negative: auto goes on as before (B carries the brief)', async () => {
    fakeProvider();
    launch('claude');
    launch('claude');
    const { result } = await send('claude', 'x');
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nx`]);
  });
});

describe('H21 (b) the shown row was used up by another send: the body alone', () => {
  it.each(CHOICES)('%s: typed once, reported consumed, nothing more written', async (_name, choice) => {
    fakeProvider();
    launch('claude');
    const a = shown();
    await send('claude', 'first');
    expect(stateOf(a)).toBe('sent');
    const { result, report } = await send('claude', 'x', { ...choice, briefBoundary: a });
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude').at(-1)).toBe('x');
    expect(report).toEqual({ state: 'consumed', boundaryId: a });
    expect(stateOf(a)).toBe('sent');
  });
});

describe('H21 (e) a change after the plan, before the claim (the claim’s stretch is the one that counts)', () => {
  it('full: A → B while the provider builds → 409, no key, A and B not used up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = fakeProvider({
      build: vi.fn(async (request: BriefRequest) => {
        await gate;
        return { body: FAKE_BRIEF, includedNoticeIds: [], mode: request.membership.mode };
      }),
    });
    launch('claude');
    const a = shown();
    const pending = send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    for (let i = 0; i < 200 && provider.build.mock.calls.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    launch('claude');
    const b = shown();
    release();
    const { result } = await pending;
    expectAborted(result, 'superseded');
    expect(world.tools.claude.sendMessage).not.toHaveBeenCalled();
    expect(stateOf(b)).toBe('pending');
    expect(['pending', 'superseded']).toContain(stateOf(a));
  });

  it('negative: auto in the same race types the body (D1’s superseded, no brief)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = fakeProvider({
      build: vi.fn(async (request: BriefRequest) => {
        await gate;
        return { body: FAKE_BRIEF, includedNoticeIds: [], mode: request.membership.mode };
      }),
    });
    launch('claude');
    const pending = send('claude', 'x');
    for (let i = 0; i < 200 && provider.build.mock.calls.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    launch('claude');
    release();
    const { result } = await pending;
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual(['x']);
  });
});

describe('H21 (f) another send holds the claim; (g) a decline whose body never went in', () => {
  it('(f) decline while another send’s claim is live → 409 claimed; that send fails unsent → A pending → decline again → declined', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      await gate;
      const error = new Error('load-buffer failed') as Error & { code?: string };
      error.code = 'PASTE_NOT_STARTED';
      throw error;
    });
    const other = send('claude', 'other');
    for (let i = 0; i < 200 && world.tools.claude.sendMessage.mock.calls.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(stateOf(a)).toBe('claimed');
    const declining = send('claude', 'x', { brief: 'decline', briefBoundary: a });
    release();
    await other;
    const { result } = await declining;
    expectAborted(result, 'claimed');
    // Only the other send's body was asked to be typed.
    expect(typed(world, 'claude')).toEqual([`${FAKE_BRIEF}\n\nother`]);
    expect(stateOf(a)).toBe('pending');
    const again = await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    expect(again.result.ok).toBe(true);
    expect(skipReasonOf(a)).toBe('declined');
  });

  it('(g) decline whose body was not typed (not-sent) → A back to pending', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    failNextSend(world, 'claude', 'not-sent');
    const { result, report } = await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('send');
    expect(stateOf(a)).toBe('pending');
    expect(report).toEqual({ state: 'not_sent', boundaryId: a });
  });

  it('(g) control: a body that may have gone in (indeterminate) uses the row up as declined', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    failNextSend(world, 'claude', 'indeterminate');
    await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    expect(stateOf(a)).toBe('skipped');
    expect(skipReasonOf(a)).toBe('declined');
  });
});

describe('H21 (i) full’s failures reach the send service as an abort', () => {
  it('(i-1) the provider throws → provider_failed, no key, A pending', async () => {
    fakeProvider({ build: vi.fn(() => { throw new Error('boom'); }) });
    launch('claude');
    const a = shown();
    const { result } = await send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    expectAborted(result, 'provider_failed');
    expect(world.tools.claude.sendMessage).not.toHaveBeenCalled();
    expect(stateOf(a)).toBe('pending');
  });

  it.each([
    ['bytes', (maxBytes: number) => 'b'.repeat(maxBytes + 1)],
    ['lines', () => Array.from({ length: 2000 }, () => 'l').join('\n')],
  ] as const)('(i-2) the provider’s body is over the budget (%s) → over_limit, no key, A pending', async (_kind, body) => {
    fakeProvider({ build: vi.fn((request: BriefRequest) => ({ body: body(request.budget.maxBytes), includedNoticeIds: [], mode: request.membership.mode })) });
    launch('claude');
    const a = shown();
    const { result } = await send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    expectAborted(result, 'over_limit');
    expect(world.tools.claude.sendMessage).not.toHaveBeenCalled();
    expect(stateOf(a)).toBe('pending');
  });

  it('(i-2) the provider says its required line does not fit → over_limit, no key', async () => {
    fakeProvider({ build: vi.fn((request: BriefRequest) => ({ body: '', includedNoticeIds: [], mode: request.membership.mode, skipReason: 'over_limit' as const })) });
    launch('claude');
    const a = shown();
    const { result } = await send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    expectAborted(result, 'over_limit');
    expect(stateOf(a)).toBe('pending');
  });

  it('(i-3) the claim’s withMemTarget throws → claim_failed, no key, A pending', async () => {
    const provider = fakeProvider();
    launch('claude');
    const a = shown();
    setBriefMemTargetDepsForTest({
      resolveCommonDir: async () => '/common/.git',
      pathExists: () => true,
      observe: async () => {
        // The plan's read is before the build; the claim's (under the input lock) is after it.
        if (provider.build.mock.calls.length > 0) throw new Error('git went away');
        return { branch: world.branch, detached: false, head: 'a'.repeat(40), commonDir: '/common/.git', known: true };
      },
    });
    const { result } = await send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    expectAborted(result, 'claim_failed');
    expect(world.tools.claude.sendMessage).not.toHaveBeenCalled();
    expect(stateOf(a)).toBe('pending');
  });

  it('(i) the empty brief in full: the body alone, the row used up, reported empty', async () => {
    fakeProvider({ build: vi.fn((request: BriefRequest) => ({ body: '', includedNoticeIds: [], mode: request.membership.mode })) });
    launch('claude');
    const a = shown();
    const { result, report } = await send('claude', 'x', { briefDetail: 'full', briefBoundary: a });
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual(['x']);
    expect(report).toEqual({ state: 'skipped', reason: 'empty', boundaryId: a });
  });

  it('negative: auto with the same failures types the body alone and records D1’s skip', async () => {
    fakeProvider({ build: vi.fn(() => { throw new Error('boom'); }) });
    launch('claude');
    const a = shown();
    const { result } = await send('claude', 'x');
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude')).toEqual(['x']);
    expect(stateOf(a)).toBe('skipped');
    expect(skipReasonOf(a)).toBe('provider_failed');
  });
});

describe('H21 (j) the abort is read by its type, never by its words', () => {
  it('auto, a body quoting the abort’s message, tmux fails quoting it → send-error (indeterminate), not brief_choice', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    const words = new BriefChoiceAbortedError('superseded', null).message;
    const body = `please read: ${words}`;
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      throw new Error(`Command failed: tmux send-keys -t mcbd-claude-${WT} -l -- ${body}`);
    });
    const { result } = await send('claude', body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('send');
    const attempt = getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
    expect(attempt?.state).toBe('indeterminate');
    expect(attempt?.reason).toBe('send-error');
    // A P3-5: the boundary's claim settles `unknown` as D1 does (not put back to `not_sent`).
    expect(stateOf(a)).toBe('unknown');
  });

  it('the abort records no send attempt (nothing was typed)', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    launch('claude');
    await send('claude', 'x', { brief: 'decline', briefBoundary: a });
    expect(getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' })).toBeNull();
  });
});

/**
 * pr3c (codex P2-1, PM return 2): the plan saw the shown row A used up (body only), and while
 * the send waited for the input lock, the send holding it typed a reset that opened B. The final
 * stretch (under the lock) is the one that counts (design §3.2): a `full` / `decline` body is not
 * typed into B's new conversation.
 */
describe('H21 (b2) used up at the plan, A → B while waiting for the input lock', () => {
  /** A send holding the input lock while its tool types `body` (a `/clear` opens B when it lands). */
  async function holdTheLock(body: string): Promise<{ release: () => void; holder: Promise<unknown> }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      await gate;
    });
    const before = world.tools.claude.sendMessage.mock.calls.length;
    const holder = send('claude', body);
    for (let i = 0; i < 200 && world.tools.claude.sendMessage.mock.calls.length === before; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(world.tools.claude.sendMessage.mock.calls.length).toBe(before + 1);
    return { release, holder };
  }

  it.each(CHOICES)('%s: 409 superseded under the lock, the body not typed, B pending', async (_name, choice) => {
    fakeProvider();
    launch('claude');
    const a = shown();
    await send('claude', 'first');
    expect(stateOf(a)).toBe('sent');
    const { release, holder } = await holdTheLock('/clear');
    const choosing = send('claude', 'x', { ...choice, briefBoundary: a });
    // The choosing send plans (it reads A used up, the current row) and queues behind the lock.
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(shown()).toBe(a);
    release();
    await holder;
    const b = shown();
    expect(b).not.toBe(a);
    const { result } = await choosing;
    expectAborted(result, 'superseded');
    expect(typed(world, 'claude')).not.toContain('x');
    expect(stateOf(b)).toBe('pending');
  });

  it.each(CHOICES)('negative %s: A still the current row under the lock → the body alone, reported consumed', async (_name, choice) => {
    fakeProvider();
    launch('claude');
    const a = shown();
    await send('claude', 'first');
    const { release, holder } = await holdTheLock('hold');
    const choosing = send('claude', 'x', { ...choice, briefBoundary: a });
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
    release();
    await holder;
    const { result, report } = await choosing;
    expect(result.ok).toBe(true);
    expect(typed(world, 'claude').at(-1)).toBe('x');
    expect(report).toEqual({ state: 'consumed', boundaryId: a });
    expect(stateOf(a)).toBe('sent');
  });

  it('(A P3-1) both planned A pending, the other send used it up first in the lock → 409 claimed, the body not typed (design §11.22)', async () => {
    fakeProvider();
    launch('claude');
    const a = shown();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      await gate;
    });
    // The lock's holder takes no brief: A stays pending for both sends planned behind it.
    const holder = send('claude', 'hold', { brief: 'skip' });
    for (let i = 0; i < 200 && world.tools.claude.sendMessage.mock.calls.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    const first = send('claude', 'first');
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
    const declining = send('claude', 'x', { brief: 'decline', briefBoundary: a });
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(stateOf(a)).toBe('pending');
    release();
    await holder;
    await first;
    expect(stateOf(a)).toBe('sent');
    const { result } = await declining;
    expectAborted(result, 'claimed');
    expect(typed(world, 'claude')).not.toContain('x');
    expect(stateOf(a)).toBe('sent');
  });
});
