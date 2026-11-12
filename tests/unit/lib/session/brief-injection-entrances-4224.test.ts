/**
 * The invariants every way D2 (Issue #4224) reads or writes keeps, fixed by a table (PM's
 * decision for #4224; design `docs/design/brief-injection-d2-4224.md` §9.2).
 *
 * The ways in are enumerated from the writers' side: the ledger's writes
 * (`session-brief-db.ts`), #4222's reservation and receipt (`reserveMemNotices`,
 * `settleMemNoticeAttempt`), the worktree incarnation D2 makes (`getOrCreateWorktreeIncarnation`
 * in `session-brief.ts`) and the history's claim of a row (`recordUserTurn`) — each must be
 * reached by a row of {@link ENTRANCES} or be a named exception. Every send entrance is
 * then run, with C's real provider on the #4274 world, through the same invariants:
 *
 *  (a) the worktree deleted and made again under the same id and path after the entrance:
 *      the old request attaches nothing and writes nothing on the new one (J5);
 *  (b) mode off: nothing attached, mem not written (J4);
 *  (c) one brief per boundary through simultaneous first sends, a refused send, an unknown
 *      outcome and a restart (J2);
 *  (d) the empty provider: the typed text, the record and the rows are a never send's (J4);
 *  (e) the operator's body is never cut — ending the typed text byte for byte — and a body
 *      near #2464's verified size goes alone (J1, J6);
 *  (f) an unknown delivery is no receipt (J3).
 *
 * Each has a positive control (the scenario with its break: a re-creation, a second send,
 * a failure) and a negative one (left alone, it attaches once).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const hooks = vi.hoisted(() => ({ onOwnership: null as null | (() => void), events: [] as string[] }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    const info = (event: string) => void hooks.events.push(event);
    return { info, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info, warn: quiet, error: quiet, debug: quiet }) };
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

import { WT, bindWorld, closeWorld, failNextSend, launch, makeWorld, rows, setMem, typed, type World } from './session-brief-4274-harness';
import { entrance, memFingerprint, noticeForClaude, noticeState, realPort, recreateWorktree, sendPinned } from './brief-d2-4224-harness';
import { EMPTY_BRIEF_PROVIDER, setBriefProviderForTest } from '@/lib/session/brief-provider';
import { resetLiveBriefClaimsForTest } from '@/lib/session/session-brief';
import { getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { SEND_VERIFIED_MAX_BYTES } from '@/config/send-verified-limits';
import { createMessage } from '@/lib/db';

let world: World;
const ROOT = process.cwd();
const BRIEF = /^<<<cmate-brief:[0-9a-f]{8}\n/;
const briefedCount = () => typed(world, 'claude').filter((text) => BRIEF.test(text)).length;

type Mode = 'auto' | 'force';

interface Entrance {
  /** What it writes, by the writer's name (enumerated below). */
  writes: string[];
  /** A send entrance runs the invariants; any other names the tests that hold it. */
  send?: Mode;
  heldBy?: string;
}

/** Every way D2 reads or writes. */
const ENTRANCES: Record<string, Entrance> = {
  'send route, auto (screen, `send`, `ask`, `send --contract`)': {
    writes: ['openBoundary', 'claimBoundary', 'settleBoundaryClaim', 'skipBoundary', 'fillBoundaryIncarnation', 'copyDeliveryToRelaunchBoundaries', 'settleStaleClaim', 'getOrCreateWorktreeIncarnation', 'reserveMemNotices', 'settleMemNoticeAttempt'],
    send: 'auto',
  },
  'send route, force (`--with-brief`)': { writes: ['openBoundary', 'claimBoundary', 'settleBoundaryClaim', 'getOrCreateWorktreeIncarnation'], send: 'force' },
  // Issue #4227 (S-B): the screen's G-3 "don't read" — the shown row reserved, then used up as declined.
  'send route, decline (screen G-3 "don\u2019t read")': {
    writes: ['claimBoundary', 'settleDeclinedClaim', 'settleBoundaryClaim', 'getOrCreateWorktreeIncarnation'],
    heldBy: 'session-brief-entrances-4274 (the decline row) and session-brief-choice-4227 (H21)',
  },
  'send route, skip (`--no-brief`)': { writes: [], heldBy: 'session-brief-boundaries-4274 (`--no-brief` once); this file (c) through auto after it' },
  'Timer and relay delivery (never)': { writes: [], heldBy: 'brief-call-chain-forms-4224 R6 (no brief named) and session-brief-entrances-4274 (d)' },
  'commandmate brief / --session-start (route GET)': { writes: [], heldBy: 'brief-session-start-4224 K5 (no ledger, no reservation) and brief-retry-paths-4223' },
  'the transcript read back into the history (recordUserTurn)': { writes: ['setMessageRequestId'], heldBy: 'user-turn-recorder-brief-4224 H-a〜H-f' },
};

/** Writers no row reaches, with the reason. */
const NOT_AN_ENTRANCE: Record<string, string> = {
  bindBoundaryConversation: 'a hook observation (D1): D2 reads the row it binds, writes nothing there',
  adoptBoundaryAsSendReset: 'the reset a send typed, D1’s; D2 adds only W6 before it (T0e)',
};

// --- the writers, read off their sources ----------------------------------

function storeWriters(): string[] {
  const source = readFileSync(path.join(ROOT, 'src/lib/db/session-brief-db.ts'), 'utf8');
  const starts = [...source.matchAll(/^(export )?(?:async )?function (\w+)/gm)];
  return starts
    .map((match, i) => ({ name: match[2], exported: Boolean(match[1]), body: source.slice(match.index, starts[i + 1]?.index ?? source.length) }))
    .filter((chunk) => chunk.exported && /\b(INSERT|UPDATE|DELETE)\b/.test(chunk.body))
    .map((chunk) => chunk.name);
}

/** The writers of mem and the history D2 reaches, by name, where src calls them. */
function otherWriters(): string[] {
  const called = (name: string, where: string) =>
    execFileSync('git', ['grep', '-l', `${name}(`, '--', where], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  return [
    ...(called('reserveMemNotices', 'src/lib/brief') ? ['reserveMemNotices'] : []),
    ...(called('settleMemNoticeAttempt', 'src/lib/brief') ? ['settleMemNoticeAttempt'] : []),
    ...(called('getOrCreateWorktreeIncarnation', 'src/lib/session/session-brief.ts') ? ['getOrCreateWorktreeIncarnation'] : []),
    ...(called('setMessageRequestId', 'src/lib/history/user-turn-recorder.ts') ? ['setMessageRequestId'] : []),
  ];
}

const covered = () => [...new Set([...Object.values(ENTRANCES).flatMap((entry) => entry.writes), ...Object.keys(NOT_AN_ENTRANCE)])].sort();

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  hooks.onOwnership = null;
});
afterEach(() => {
  hooks.onOwnership = null;
  closeWorld(world);
});

describe('the table names every writer D2 reaches', () => {
  it('each writer is a row’s or a named exception', () => {
    const writers = [...new Set([...storeWriters(), ...otherWriters()])].sort();
    expect(writers.filter((name) => !covered().includes(name))).toEqual([]);
    expect(covered().filter((name) => !writers.includes(name))).toEqual([]);
  });

  it('positive control: a writer added to the store without a row is found', () => {
    const covers = covered();
    expect(['openBoundary', 'someNewWrite'].filter((name) => !covers.includes(name))).toEqual(['someNewWrite']);
  });
});

const SENDS = Object.entries(ENTRANCES).filter(([, entry]) => entry.send) as Array<[string, Entrance & { send: Mode }]>;

describe.each(SENDS)('%s', (_name, entry) => {
  const mode = entry.send;
  /** auto needs a boundary; force makes its own. */
  const boundary = () => (mode === 'auto' ? launch('claude') : undefined);

  it('(a) J5 made again after the entrance: nothing attached, nothing written on the new worktree', async () => {
    realPort(world);
    boundary();
    const pin = entrance(world, 'claude');
    hooks.onOwnership = () => recreateWorktree(world);
    await sendPinned(world, 'claude', 'body', pin, mode);
    expect(typed(world, 'claude')).toEqual(['body']);
    expect(rows(world, 'claude')).toEqual([]);
    expect(memFingerprint(world.db).counts.mem_worktree_incarnations).toBe(0);
  });

  it('(a) negative: left alone, attached once', async () => {
    realPort(world);
    boundary();
    await sendPinned(world, 'claude', 'body', entrance(world, 'claude'), mode);
    expect(briefedCount()).toBe(1);
  });

  it('(b) J4 mode off: nothing attached, the mem tables unchanged', async () => {
    setMem(world, 'off', true);
    realPort(world);
    boundary();
    const before = memFingerprint(world.db);
    await sendPinned(world, 'claude', 'body', entrance(world, 'claude'), mode);
    expect(typed(world, 'claude')).toEqual(['body']);
    expect(memFingerprint(world.db)).toEqual(before);
  });

  it('(c) J2 simultaneous first sends, then a refused one, an unknown one and a restart: one brief per boundary', async () => {
    realPort(world);
    boundary();
    await Promise.all([sendPinned(world, 'claude', 'a', entrance(world, 'claude'), 'auto'), sendPinned(world, 'claude', 'b', entrance(world, 'claude'), 'auto')]);
    const first = mode === 'auto' ? 1 : 0;
    expect(briefedCount()).toBe(first);
    // A refused send (nothing typed) leaves the next boundary for the one after.
    launch('claude');
    failNextSend(world, 'claude', 'not-sent');
    await sendPinned(world, 'claude', 'c', entrance(world, 'claude'), mode);
    await sendPinned(world, 'claude', 'd', entrance(world, 'claude'), mode);
    // An unknown outcome is never briefed again.
    launch('claude');
    failNextSend(world, 'claude', 'indeterminate');
    await sendPinned(world, 'claude', 'e', entrance(world, 'claude'), 'auto');
    await sendPinned(world, 'claude', 'f', entrance(world, 'claude'), 'auto');
    // A restart (the claims of this process forgotten) does not brief the same row twice.
    resetLiveBriefClaimsForTest();
    await sendPinned(world, 'claude', 'g', entrance(world, 'claude'), 'auto');
    const texts = typed(world, 'claude');
    const briefedOf = (body: string) => texts.filter((text) => text === body || text.endsWith(`\n\n${body}`)).map((text) => BRIEF.test(text));
    expect([...briefedOf('a'), ...briefedOf('b')].filter(Boolean)).toHaveLength(first);
    expect(briefedOf('c')).toEqual([true]); // typed with the brief, refused before any key
    expect(briefedOf('d')).toEqual([true]); // the boundary stayed for the next send
    expect(briefedOf('e')).toEqual([true]);
    expect(briefedOf('f')).toEqual([false]); // unknown: not briefed again
    expect(briefedOf('g')).toEqual([false]); // after a restart: not again
    expect(rows(world, 'claude').filter((row) => row.state === 'sent').every((row) => row.briefBytes !== null)).toBe(true);
  });

  it('(d) J4 the empty provider: what is typed and recorded is a never send’s', async () => {
    setBriefProviderForTest(EMPTY_BRIEF_PROVIDER);
    boundary();
    await sendPinned(world, 'claude', 'body', entrance(world, 'claude'), mode);
    const withPin = { typed: typed(world, 'claude'), digest: getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' })?.typedDigest };
    world.tools.claude.sendMessage.mockClear();
    await sendUserMessage(world.db, { worktreeId: WT, content: 'body', cliToolId: 'claude' });
    const never = { typed: typed(world, 'claude'), digest: getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' })?.typedDigest };
    expect(withPin).toEqual(never);
  });

  it('(e) J1 / J6 the body ends the typed text byte for byte; one near the verified size goes alone', async () => {
    realPort(world);
    boundary();
    const body = '日本語 🍣 é\nsecond line';
    await sendPinned(world, 'claude', body, entrance(world, 'claude'), mode);
    const first = typed(world, 'claude')[0];
    expect(BRIEF.test(first)).toBe(true);
    expect(first.endsWith(`\n\n${body}`)).toBe(true);
    launch('claude');
    const big = 'x'.repeat(SEND_VERIFIED_MAX_BYTES - 64);
    await sendPinned(world, 'claude', big, entrance(world, 'claude'), mode);
    expect(typed(world, 'claude')[1]).toBe(big);
  });

  it('(f) J3 an unknown delivery is no receipt; a sent one is', async () => {
    realPort(world);
    const notice = await noticeForClaude(world);
    boundary();
    failNextSend(world, 'claude', 'indeterminate');
    await sendPinned(world, 'claude', 'a', entrance(world, 'claude'), mode);
    expect(noticeState(world, notice)).not.toBe('acknowledged');
    const second = await noticeForClaude(world, 'another');
    launch('claude');
    await sendPinned(world, 'claude', 'b', entrance(world, 'claude'), 'auto');
    expect(noticeState(world, second)).toBe('acknowledged');
  });
});

describe('X-h / X-i the line after an unplanned end, with a relaunch inside the send (D2 design §7.2)', () => {
  const LEAD = '終わる前の更新を確認できない（';
  const earlier = () =>
    createMessage(world.db, { worktreeId: WT, role: 'user', content: 'earlier', messageType: 'normal', timestamp: new Date(Date.now() - 3_600_000), cliToolId: 'claude', instanceId: 'claude' });
  /** The tool relaunches the agent inside this delivery (the process had exited). */
  const relaunchInside = () =>
    world.tools.claude.sendMessage.mockImplementationOnce(async () => {
      launch('claude');
    });

  it('X-h R-a: the launch row was pending; the brief planned for it — with the line — reaches the relaunched process once, both rows sent', async () => {
    realPort(world);
    earlier();
    launch('claude');
    relaunchInside();
    await sendPinned(world, 'claude', 'go', entrance(world, 'claude'));
    const text = typed(world, 'claude')[0];
    expect(text.split('\n')[4].startsWith(LEAD)).toBe(true);
    expect(rows(world, 'claude').map((row) => row.state)).toEqual(['sent', 'sent']);
    await sendPinned(world, 'claude', 'next', entrance(world, 'claude'));
    expect(typed(world, 'claude')[1]).toBe('next');
  });

  it('X-h R-d negative: a send to a running process opens no row and adds no line', async () => {
    realPort(world);
    earlier();
    await sendPinned(world, 'claude', 'go', entrance(world, 'claude'));
    expect(typed(world, 'claude')).toEqual(['go']);
  });

  it('X-i R-b: sent once, then the process exited — that send is the body, the next is briefed with the line', async () => {
    realPort(world);
    earlier();
    launch('claude');
    await sendPinned(world, 'claude', 'first', entrance(world, 'claude'));
    relaunchInside();
    await sendPinned(world, 'claude', 'second', entrance(world, 'claude'));
    expect(typed(world, 'claude')[1]).toBe('second');
    await sendPinned(world, 'claude', 'third', entrance(world, 'claude'));
    const third = typed(world, 'claude')[2];
    expect(third.split('\n')[4].startsWith(LEAD)).toBe(true);
  });

  it('X-i R-c (a kept risk): a pending reset row and a relaunch inside — briefed once without the line, and logged', async () => {
    realPort(world);
    earlier();
    launch('claude');
    await sendPinned(world, 'claude', 'first', entrance(world, 'claude'));
    await sendPinned(world, 'claude', '/clear', entrance(world, 'claude'));
    hooks.events.length = 0;
    relaunchInside();
    await sendPinned(world, 'claude', 'after', entrance(world, 'claude'));
    const after = typed(world, 'claude').at(-1)!;
    expect(BRIEF.test(after)).toBe(true);
    expect(after).not.toContain(LEAD);
    expect(hooks.events).toContain('brief-previous-end-not-delivered');
    await sendPinned(world, 'claude', 'again', entrance(world, 'claude'));
    expect(typed(world, 'claude').at(-1)).toBe('again');
  });
});
