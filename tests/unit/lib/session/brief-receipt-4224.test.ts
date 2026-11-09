/**
 * #4222's receipt through the connected port (Issue #4224, D2 design §5.2 N1〜N7, J3).
 *
 * `sent` acknowledges only the notices in the text actually typed; `not_sent` and
 * `discarded` put them back to `pending`; `unknown` is #4222's "unconfirmed" and never an
 * acknowledgement. Run with C's real provider and #4222's real reservation and receipt
 * (`reserveMemNotices` / `settleMemNoticeAttempt`), on the #4274 world.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

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

import { WT, bindWorld, closeWorld, failNextSend, launch, makeWorld, rows, typed, type World } from './session-brief-4274-harness';
import { entrance, noticeForClaude, noticeState, realPort, sendPinned } from './brief-d2-4224-harness';
import { SendBrief } from '@/lib/session/session-brief';
import { acknowledgeMemNoticeByHuman } from '@/lib/mem/notices';

let world: World;

const noticeIn = (text: string, id: string) => text.includes(`src=notice id=${id}`);
const uncertain = (id: string) => (world.db.prepare('SELECT uncertain_count n FROM mem_notices WHERE id = ?').get(id) as { n: number }).n;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
});
afterEach(() => closeWorld(world));

describe('N1 / J3 sent acknowledges what was typed, and only that', () => {
  it('two notices built; one taken by another boundary before the claim → the text has one, sent acknowledges one', async () => {
    const { port } = realPort(world);
    const n1 = await noticeForClaude(world, 'first');
    const n2 = await noticeForClaude(world, 'second');
    launch('claude');
    const brief = new SendBrief({ db: world.db, worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', mode: 'auto', content: 'go', typedBody: (t) => t, pin: entrance(world, 'claude') });
    await brief.plan();
    // n2 is taken elsewhere between the build and this claim (a person acknowledges it).
    const version = (world.db.prepare('SELECT version FROM mem_notices WHERE id = ?').get(n2) as { version: number }).version;
    acknowledgeMemNoticeByHuman(world.db, n2, version);
    const text = await brief.claim();
    expect(noticeIn(text, n1)).toBe(true);
    expect(noticeIn(text, n2)).toBe(false);
    brief.settleInLock('sent', Date.now());
    await brief.afterLock();
    expect(noticeState(world, n1)).toBe('acknowledged');
    expect(world.db.prepare('SELECT acknowledged_by FROM mem_notices WHERE id = ?').get(n2)).toEqual({ acknowledged_by: 'human' }); // not this send's
    expect(port.settle).toBeDefined();
  });
});

describe('N2 / N3 not sent and unknown are no receipt', () => {
  it('N2 not-sent: the notice is pending again and the next send carries it, then sent', async () => {
    realPort(world);
    const n1 = await noticeForClaude(world);
    launch('claude');
    failNextSend(world, 'claude', 'not-sent');
    await sendPinned(world, 'claude', 'a', entrance(world, 'claude'));
    expect(noticeState(world, n1)).toBe('pending');
    await sendPinned(world, 'claude', 'b', entrance(world, 'claude'));
    expect(noticeIn(typed(world, 'claude')[1], n1)).toBe(true);
    expect(noticeState(world, n1)).toBe('acknowledged');
  });

  it('N3 indeterminate: the ledger is unknown, the notice is not acknowledged (unconfirmed), and the next send does not brief the row again', async () => {
    realPort(world);
    const n1 = await noticeForClaude(world);
    launch('claude');
    failNextSend(world, 'claude', 'indeterminate');
    await sendPinned(world, 'claude', 'a', entrance(world, 'claude'));
    expect(rows(world, 'claude')[0].state).toBe('unknown');
    expect(noticeState(world, n1)).not.toBe('acknowledged');
    expect(uncertain(n1)).toBeGreaterThanOrEqual(1);
    await sendPinned(world, 'claude', 'b', entrance(world, 'claude'));
    expect(typed(world, 'claude')[1]).toBe('b');
  });
});

describe('N4 the receipt is written in one place', () => {
  it('settleMemNoticeAttempt and reserveMemNotices are called in src only by C’s provider', () => {
    const grep = (name: string) =>
      execFileSync('git', ['grep', '-n', `${name}(`, '--', 'src'], { cwd: process.cwd(), encoding: 'utf8' })
        .split('\n')
        .filter((line) => line && !/export function/.test(line))
        .map((line) => line.split(':')[0]);
    expect([...new Set(grep('settleMemNoticeAttempt'))]).toEqual(['src/lib/brief/provider.ts']);
    expect([...new Set(grep('reserveMemNotices'))]).toEqual(['src/lib/brief/provider.ts']);
    // The CLI's brief and --session-start only list (no reservation, no receipt).
    const service = readFileSync(path.join(process.cwd(), 'src/lib/brief/service.ts'), 'utf8');
    expect(service).not.toMatch(/reserveMemNotices|settleMemNoticeAttempt|settleBriefAttempt/);
  });
});

describe('N6 / N7 two sends, one typed text', () => {
  it('N6 two concurrent first sends build twice; the one that typed is the one acknowledged, once', async () => {
    realPort(world);
    const n1 = await noticeForClaude(world);
    launch('claude');
    await Promise.all([sendPinned(world, 'claude', 'a', entrance(world, 'claude')), sendPinned(world, 'claude', 'b', entrance(world, 'claude'))]);
    const briefed = typed(world, 'claude').filter((text) => noticeIn(text, n1));
    expect(briefed).toHaveLength(1);
    expect(noticeState(world, n1)).toBe('acknowledged');
  });

  it('N7 reserved then not claimed (a newer boundary): discarded puts it back; the next brief carries it and sent acknowledges', async () => {
    realPort(world);
    const n1 = await noticeForClaude(world);
    launch('claude');
    const first = new SendBrief({ db: world.db, worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', mode: 'auto', content: 'a', typedBody: (t) => t, pin: entrance(world, 'claude') });
    await first.plan();
    launch('claude'); // a newer boundary before the claim: the first is superseded
    expect(await first.claim()).toBe('a');
    first.abandonInLock();
    await first.afterLock();
    expect(noticeState(world, n1)).toBe('pending');
    await sendPinned(world, 'claude', 'b', entrance(world, 'claude'));
    expect(noticeIn(typed(world, 'claude')[0], n1)).toBe(true);
    expect(noticeState(world, n1)).toBe('acknowledged');
  });
});
