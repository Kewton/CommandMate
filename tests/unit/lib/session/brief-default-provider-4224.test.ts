/**
 * The connection (Issue #4224, D2 design §4, E1〜E4): `getBriefProvider()` answers C's
 * provider with #4222's receipt as its `settle`. Nothing is handed in here: the default
 * itself briefs (E1), and with mode `off` or `injectOnStart` false it changes no byte of
 * what a send types, records and stores (E2). The empty provider, named, still changes
 * nothing (E3), and the comparison sees one byte (E4).
 *
 * The database the default provider opens (`getDbInstance`) is the world's, and git's
 * answer for the worktree's HEAD is the world's branch.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hooks = vi.hoisted(() => ({ db: null as unknown, branch: 'feature/a' }));
vi.mock('@/lib/db/db-instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/db-instance')>()),
  getDbInstance: () => hooks.db,
}));
vi.mock('@/lib/mem/git-observe', () => ({
  observeWorktreeHead: async () => ({ branch: hooks.branch, detached: false, head: '0123456789abcdef0123456789abcdef01234567', commonDir: null, known: true }),
}));
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

import { WT, bindWorld, closeWorld, launch, makeWorld, overrideBriefMode, send, setMem, type World } from './session-brief-4274-harness';
import { memFingerprint } from './brief-d2-4224-harness';
import { EMPTY_BRIEF_PROVIDER, getBriefProvider, setBriefProviderForTest, type BriefProvider } from '@/lib/session/brief-provider';
import { MEM_BRIEF_PORT, resetMemBriefPortForTest } from '@/lib/brief/provider';
import { getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { getMessages } from '@/lib/db';

let world: World;

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  hooks.db = world.db;
  resetMemBriefPortForTest();
});
afterEach(() => {
  closeWorld(world);
  resetMemBriefPortForTest();
});

describe('E1 the default briefs', () => {
  it('no provider handed in: an on / injectOnStart send after a launch starts with C’s fences, the body byte for byte after it', async () => {
    setBriefProviderForTest(null);
    expect(getBriefProvider()).toBe(MEM_BRIEF_PORT);
    launch('claude');
    const body = '日本語の本文 🍣\nline 2';
    await send('claude', body);
    const typedText = String(world.tools.claude.sendMessage.mock.calls[0][1]);
    expect(typedText).toMatch(/^<<<cmate-brief:[0-9a-f]{8}\n/);
    expect(typedText.endsWith(`\n\n${body}`)).toBe(true);
  });

  it('positive control: with the empty provider in its place nothing is attached', async () => {
    setBriefProviderForTest(EMPTY_BRIEF_PROVIDER);
    launch('claude');
    await send('claude', 'x');
    expect(world.tools.claude.sendMessage.mock.calls[0][1]).toBe('x');
  });
});

interface Observed {
  typed: unknown[][];
  images: unknown[][];
  attempt: unknown;
  messages: Array<{ role: string; content: string }>;
  /** The mem tables' rows counted, and whether the sends changed any row (ids differ between worlds). */
  mem: { counts: Record<string, number>; changed: boolean };
}

/** One world's sends, as (d) of #4274 observes them. */
async function observe(mode: 'auto' | 'never', arrange: () => void, provider: BriefProvider | null, built: { count: number }): Promise<Observed> {
  const local = makeWorld();
  const previous = world;
  world = local;
  bindWorld(local);
  hooks.db = local.db;
  try {
    arrange();
    const memBefore = memFingerprint(local.db);
    setBriefProviderForTest(provider);
    if (provider === null) {
      const real = getBriefProvider();
      const spy = vi.spyOn(real, 'build');
      spy.mockClear();
      overrideBriefMode(mode === 'never' ? 'never' : null);
      launch('claude');
      await send('claude', '## contract preamble\n\ngoal: do it');
      await send('claude', 'with image', { absoluteImagePath: '/tmp/x.png' });
      built.count += spy.mock.calls.length;
      spy.mockRestore();
    } else {
      overrideBriefMode(mode === 'never' ? 'never' : null);
      launch('claude');
      await send('claude', '## contract preamble\n\ngoal: do it');
      await send('claude', 'with image', { absoluteImagePath: '/tmp/x.png' });
    }
    const attempt = getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
    return {
      typed: local.tools.claude.sendMessage.mock.calls.map((call) => call.slice(0, 3)),
      images: local.tools.claude.sendMessageWithImage.mock.calls.map((call) => call.slice(0, 4)),
      attempt: attempt && { state: attempt.state, reason: attempt.reason, messageDigest: attempt.messageDigest, typedDigest: attempt.typedDigest },
      // Two sends can share a millisecond: the rows are compared as a set.
      messages: getMessages(local.db, WT, { limit: 50 })
        .map((m) => ({ role: m.role, content: m.content }))
        .sort((a, b) => (a.content < b.content ? -1 : a.content > b.content ? 1 : 0)),
      mem: { counts: memFingerprint(local.db).counts, changed: memFingerprint(local.db).hash !== memBefore.hash },
    };
  } finally {
    overrideBriefMode(null);
    world = previous;
    bindWorld(previous);
    hooks.db = previous.db;
    closeWorld(local);
  }
}

describe('E2 / E3 / E4 nothing changes where nothing is to be attached', () => {
  it.each([
    ['mode off', (w: () => World) => setMem(w(), 'off', true)],
    ['injectOnStart false', (w: () => World) => setMem(w(), 'on', false)],
  ] as const)('E2 %s, the default provider: typed, recorded, stored and mem as a never send; the provider never builds', async (_name, arrange) => {
    const built = { count: 0 };
    const auto = await observe('auto', () => arrange(() => world), null, built);
    const never = await observe('never', () => arrange(() => world), null, built);
    expect(auto).toEqual(never);
    expect(auto.mem.changed).toBe(false);
    expect(built.count).toBe(0);
  });

  it('E3 the empty provider named, mode on: byte for byte a never send', async () => {
    const built = { count: 0 };
    const auto = await observe('auto', () => undefined, EMPTY_BRIEF_PROVIDER, built);
    const never = await observe('never', () => undefined, EMPTY_BRIEF_PROVIDER, built);
    expect({ ...auto, mem: null }).toEqual({ ...never, mem: null });
  });

  it('E4 the comparison sees one byte', async () => {
    const built = { count: 0 };
    const auto = await observe('auto', () => setMem(world, 'off', true), null, built);
    const changed = JSON.parse(JSON.stringify(auto)) as Observed;
    (changed.typed[0] as string[])[1] += ' ';
    expect(changed).not.toEqual(auto);
  });
});
