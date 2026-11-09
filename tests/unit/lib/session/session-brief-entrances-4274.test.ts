/**
 * The invariants every way into the session-brief ledger keeps (Issue #4274, PM's
 * decision: fixed by a table from the first commit, in the shape of
 * `tests/unit/lib/mem/write-entrances-recreate-4221.test.ts`).
 *
 * The entrances are enumerated from the store's side: the exported functions of
 * `src/lib/db/session-brief-db.ts` that INSERT / UPDATE / DELETE. Each must be
 * written by a row of the table, or be a named exception — so a new write fails the
 * first test until it has a row. Each row is one way in (an observation of a
 * boundary, a claim, a settlement, a delivery record), driven through the real
 * launch, hook intake and send service, and four invariants are run over it:
 *
 *  (a) the instance deleted and made again under the same id while the request waits:
 *      the old request's brief is refused (or the exception says why there is no wait);
 *  (b) mode `off`: nothing is attached and no brief is recorded (the boundary rows
 *      themselves are boundary facts, written whatever the mode — none carries a brief);
 *  (c) one brief per boundary, through simultaneous first sends, a refused send, an
 *      unknown outcome and a server restart;
 *  (d) the empty provider: what is typed, recorded and stored is byte for byte what a
 *      send that never asks for a brief produces.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

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
  FAKE_BRIEF,
  WT,
  closeWorld,
  delivered,
  failNextSend,
  fakeProvider,
  hook,
  launch,
  makeWorld,
  overrideBriefMode,
  rows,
  send,
  setMem,
  typed,
  bindWorld,
  type World,
} from './session-brief-4274-harness';
import { addAgentInstance, removeAgentInstance } from '@/lib/db/agent-instances-db';
import { startInstanceIncarnation } from '@/lib/mem/incarnation';
import { resetLiveBriefClaimsForTest } from '@/lib/session/session-brief';
import { EMPTY_BRIEF_PROVIDER, setBriefProviderForTest, type BriefRequest } from '@/lib/session/brief-provider';
import { getLastSendAttempt, sendMessageDigest } from '@/lib/session/send-attempt-state';

const STORE = path.join(process.cwd(), 'src/lib/db/session-brief-db.ts');

let world: World;

/** The primary is on the roster (so it has a lifetime to re-create) unless a row says otherwise. */
function onRoster(): void {
  addAgentInstance(world.db, WT, { id: 'claude', cliTool: 'claude', alias: '', order: 0 });
}

interface Entrance {
  /** The ledger writes of `session-brief-db.ts` this way in reaches. */
  writes: string[];
  /** Before the entrance: the roster and anything the way in needs. Defaults to {@link onRoster}. */
  arrange?: () => void;
  /** The way in, and the sends that make up its scenario. */
  run: () => Promise<void>;
  /** Briefs that reach the agent over `run` and the follow-up sends of (c), with mode `on`. */
  briefs: number;
  /**
   * (a): the request a re-creation of the instance can overtake — started, held at its
   * provider (or its tool), the instance deleted and added again, released. Or the
   * reason the way in has no such wait.
   */
  stale: { request: () => Promise<void>; hold: 'provider' | 'tool'; landed: () => boolean } | string;
}

const briefsIn = (texts: string[]) => texts.filter((text) => text.startsWith(FAKE_BRIEF)).length;

const ENTRANCES: Record<string, Entrance> = {
  'launch (beginAgentSession)': {
    writes: ['openBoundary'],
    run: async () => launch('claude'),
    briefs: 1,
    stale: 'synchronous: the row is opened in the stretch that read the lifetime it stores, with no await a re-creation could enter',
  },
  'hook startup binds the launch row': {
    writes: ['bindBoundaryConversation'],
    run: async () => {
      launch('claude');
      hook(world, 'claude', 'session-start.json', { sessionId: 'c1' });
    },
    briefs: 1,
    stale: 'synchronous, and a hook names no incarnation: an event of the deleted process arriving after the re-creation cannot be told from one of the new (design §3.7)',
  },
  'hook clear opens a reset': {
    writes: ['openBoundary'],
    run: async () => {
      launch('claude');
      hook(world, 'claude', 'session-start.json', { sessionId: 'c1' });
      await send('claude', 'before');
      hook(world, 'claude', 'session-start-clear.json', { sessionId: 'c2' });
    },
    briefs: 2,
    stale: 'synchronous, and a hook names no incarnation (as above)',
  },
  'hook resume opens a resume': {
    writes: ['openBoundary'],
    run: async () => {
      launch('claude');
      hook(world, 'claude', 'session-start.json', { sessionId: 'A' });
      await send('claude', 'before');
      hook(world, 'claude', 'session-start.json', { sessionId: 'B', source: 'resume' });
    },
    briefs: 2,
    stale: 'synchronous, and a hook names no incarnation (as above)',
  },
  'hook of an unseen conversation opens a late reset': {
    writes: ['openBoundary'],
    run: async () => {
      launch('claude');
      hook(world, 'claude', 'session-start.json', { sessionId: 'A' });
      await send('claude', 'before');
      hook(world, 'claude', 'stop.json', { sessionId: 'B' });
    },
    briefs: 2,
    stale: 'synchronous, and a hook names no incarnation (as above)',
  },
  'typed reset opens its row': {
    writes: ['openBoundary'],
    run: async () => {
      launch('claude');
      await send('claude', 'before');
      await send('claude', '/clear');
    },
    briefs: 2,
    stale: {
      request: () => send('claude', '/clear').then(() => undefined),
      hold: 'tool',
      landed: () => rows(world, 'claude').some((row) => row.evidence === 'send_command'),
    },
  },
  'typed reset adopts the hook’s row': {
    writes: ['adoptBoundaryAsSendReset'],
    run: async () => {
      launch('claude');
      await send('claude', 'before');
      world.tools.claude.sendMessage.mockImplementationOnce(async () => {
        hook(world, 'claude', 'session-start-clear.json', { sessionId: 'c2' });
      });
      await send('claude', '/clear');
    },
    briefs: 2,
    stale: 'reaches the adoption only after the typed-reset row above: its stale request is that row’s',
  },
  'send claims and settles sent': {
    writes: ['claimBoundary', 'settleBoundaryClaim'],
    run: async () => {
      launch('claude');
      await send('claude', 'x');
    },
    briefs: 1,
    stale: { request: () => send('claude', 'x').then(() => undefined), hold: 'provider', landed: () => briefsIn(typed(world, 'claude')) > 0 },
  },
  'send claims and settles not-sent': {
    writes: ['claimBoundary', 'settleBoundaryClaim'],
    run: async () => {
      launch('claude');
      failNextSend(world, 'claude', 'not-sent');
      await send('claude', 'x');
    },
    briefs: 1,
    stale: { request: () => send('claude', 'x').then(() => undefined), hold: 'provider', landed: () => briefsIn(typed(world, 'claude')) > 0 },
  },
  'send claims and settles unknown': {
    writes: ['claimBoundary', 'settleBoundaryClaim'],
    run: async () => {
      launch('claude');
      failNextSend(world, 'claude', 'indeterminate');
      await send('claude', 'x');
    },
    briefs: 1,
    stale: { request: () => send('claude', 'x').then(() => undefined), hold: 'provider', landed: () => briefsIn(typed(world, 'claude')) > 0 },
  },
  'send not sent after its relaunch opened a newer row: the older one is superseded': {
    writes: ['openBoundary', 'claimBoundary', 'settleBoundaryClaim'],
    run: async () => {
      launch('claude');
      world.tools.claude.sendMessage.mockImplementationOnce(async () => {
        launch('claude');
        const error = new Error('load-buffer failed') as Error & { code?: string };
        error.code = 'PASTE_NOT_STARTED';
        throw error;
      });
      await send('claude', 'x');
    },
    briefs: 1,
    stale: 'reaches the claim of “send claims and settles not-sent”: its stale request is that row’s (consistency review 1)',
  },
  'send --with-brief opens an explicit row': {
    writes: ['openBoundary', 'claimBoundary', 'settleBoundaryClaim'],
    run: async () => {
      await send('claude', 'x', { brief: 'force' });
    },
    briefs: 1,
    stale: {
      request: () => send('claude', 'x', { brief: 'force' }).then(() => undefined),
      hold: 'provider',
      landed: () => briefsIn(typed(world, 'claude')) > 0,
    },
  },
  'send skips (unresolved, off, disabled, empty, over budget…)': {
    writes: ['skipBoundary'],
    arrange: () => {
      onRoster();
      fakeProvider({ build: vi.fn(() => ({ body: '', includedNoticeIds: [], mode: 'on' as const })) });
    },
    run: async () => {
      launch('claude');
      await send('claude', 'x');
    },
    briefs: 0,
    stale: 'the skip is written before the plan’s first await or from the provider’s answer, and attaches nothing either way',
  },
  'send fills a late-issued incarnation': {
    writes: ['fillBoundaryIncarnation'],
    // A roster row older than v66 (no incarnation) beside another member: mem's first
    // write issues it `lazy` (review 2b ②), and a delete and re-add is a `roster` issue,
    // another lifetime. (Alone on the roster, a re-add of a primary id is `lazy` too:
    // #4222 counts it as the primary copied into the first save.)
    arrange: () => {
      addAgentInstance(world.db, WT, { id: 'codex-9', cliTool: 'codex', alias: '', order: 0 });
      world.db
        .prepare("INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, 'claude', 'claude', '', 1, 1)")
        .run(WT);
    },
    run: async () => {
      launch('claude');
      startInstanceIncarnation(world.db, WT, 'claude', 'claude', Date.now(), 'lazy');
      await send('claude', 'x');
    },
    briefs: 1,
    stale: { request: () => send('claude', 'x').then(() => undefined), hold: 'provider', landed: () => briefsIn(typed(world, 'claude')) > 0 },
  },
  'send reads a claim of a gone process as unknown': {
    writes: ['settleStaleClaim'],
    run: async () => {
      launch('claude');
      world.db.prepare("UPDATE session_brief_boundaries SET state = 'claimed', claim_token = 'gone:x' WHERE state = 'pending'").run();
      await send('claude', 'x');
    },
    briefs: 0,
    stale: 'synchronous in the plan, before its first await; it attaches nothing',
  },
  'send that relaunched inside copies its delivery': {
    writes: ['copyDeliveryToRelaunchBoundaries'],
    run: async () => {
      launch('claude');
      world.tools.claude.sendMessage.mockImplementationOnce(async () => launch('claude'));
      await send('claude', 'x');
    },
    briefs: 1,
    stale: { request: () => send('claude', 'x').then(() => undefined), hold: 'provider', landed: () => briefsIn(typed(world, 'claude')) > 0 },
  },
};

/** Writes of the store no row reaches, each with its reason. */
const NOT_AN_ENTRANCE: Record<string, string> = {
  // None.
};

// --- the store's writes, read off its source (as #4221's table does) ---------

interface Chunk {
  name: string;
  exported: boolean;
  body: string;
}

function chunksOf(source: string): Chunk[] {
  const starts = [...source.matchAll(/^(export )?(?:async )?(?:function\*? (\w+)|const (\w+)\b[^=\n]*=)/gm)];
  return starts.map((match, i) => ({
    name: match[2] ?? match[3],
    exported: Boolean(match[1]),
    body: source.slice(match.index, starts[i + 1]?.index ?? source.length),
  }));
}

function storeWriters(source: string): Set<string> {
  const chunks = chunksOf(source);
  const writes = new Set(chunks.filter((chunk) => /\b(INSERT|UPDATE|DELETE)\b/.test(chunk.body)).map((chunk) => chunk.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const chunk of chunks) {
      if (!writes.has(chunk.name) && [...writes].some((name) => new RegExp(`\\b${name}\\(`).test(chunk.body.slice(chunk.body.indexOf('{'))))) {
        writes.add(chunk.name);
        grew = true;
      }
    }
  }
  return new Set(chunks.filter((chunk) => chunk.exported && writes.has(chunk.name)).map((chunk) => chunk.name));
}

const covered = () => [...new Set([...Object.values(ENTRANCES).flatMap((entry) => entry.writes), ...Object.keys(NOT_AN_ENTRANCE)])].sort();

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
});

afterEach(() => {
  closeWorld(world);
});

function arrange(entry: Entrance): void {
  (entry.arrange ?? onRoster)();
}

/** The follow-up sends of (c): two first sends at once, a refused one, a "restart", one more. */
async function followUps(): Promise<void> {
  await Promise.all([send('claude', 'p'), send('claude', 'q')]);
  failNextSend(world, 'claude', 'not-sent');
  await send('claude', 'refused');
  resetLiveBriefClaimsForTest();
  await send('claude', 'after restart');
  await send('claude', 'last');
}

describe('every way into the session-brief ledger keeps the invariants', () => {
  it('the table names every write of the store (a new one fails here until it has a row)', () => {
    const writers = storeWriters(readFileSync(STORE, 'utf8'));
    for (const known of ['openBoundary', 'claimBoundary', 'settleBoundaryClaim', 'skipBoundary']) expect(writers.has(known)).toBe(true);
    expect([...writers].sort()).toEqual(covered());
    const inTable = new Set(Object.values(ENTRANCES).flatMap((entry) => entry.writes));
    expect(Object.keys(NOT_AN_ENTRANCE).filter((name) => inTable.has(name))).toEqual([]);
  });

  it('the check catches a new write (and leaves a new read alone)', () => {
    const source = readFileSync(STORE, 'utf8');
    const added = `${source}\nexport function eraseBoundaries(db: Database.Database): void {\n  db.prepare('DELETE FROM session_brief_boundaries').run();\n}\n`;
    expect(storeWriters(added).has('eraseBoundaries')).toBe(true);
    const viaHelper = `${source}\nexport function reopen(db: Database.Database): void {\n  openBoundary(db, {} as never);\n}\n`;
    expect(storeWriters(viaHelper).has('reopen')).toBe(true);
    const reader = `${source}\nexport function peek(db: Database.Database): unknown {\n  return db.prepare('SELECT 1').get();\n}\n`;
    expect(storeWriters(reader).has('peek')).toBe(false);
  });

  it.each(Object.keys(ENTRANCES))('(c) %s: one brief per boundary through concurrency, refusal, unknown and restart', async (key) => {
    const entry = ENTRANCES[key];
    fakeProvider();
    arrange(entry);
    await entry.run();
    await followUps();
    expect(briefsIn(delivered(world, 'claude'))).toBe(entry.briefs);
  });

  it.each(Object.keys(ENTRANCES))('(b) %s: mode off attaches nothing and records no brief', async (key) => {
    const entry = ENTRANCES[key];
    arrange(entry);
    const provider = fakeProvider();
    setMem(world, 'off', true);
    await entry.run();
    await followUps();
    expect(briefsIn(typed(world, 'claude'))).toBe(0);
    expect(provider.build).not.toHaveBeenCalled();
    for (const row of rows(world, 'claude')) {
      expect(row.includedIds).toBeNull();
      expect(row.briefBytes).toBeNull();
      expect(row.state === 'sent' || row.state === 'claimed').toBe(false);
    }
  });

  it.each(Object.keys(ENTRANCES))('(d) %s: the empty provider types, records and stores what a never-brief send does', async (key) => {
    const entry = ENTRANCES[key];
    const observe = async (mode: 'auto' | 'never') => {
      const local = makeWorld();
      const previous = world;
      world = local;
      bindWorld(local);
      try {
        arrange(entry);
        // Issue #4224 (D2 design §10 T-1b): null is the default, now C's provider; the empty one is named.
        setBriefProviderForTest(EMPTY_BRIEF_PROVIDER);
        overrideBriefMode(mode === 'never' ? 'never' : null);
        await entry.run();
        await send('claude', '## contract preamble\n\ngoal: do it');
        await send('claude', 'with image', { absoluteImagePath: '/tmp/x.png' });
        const attempt = getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
        return {
          typed: local.tools.claude.sendMessage.mock.calls.map((call) => call.slice(0, 3)),
          images: local.tools.claude.sendMessageWithImage.mock.calls.map((call) => call.slice(0, 4)),
          attempt: attempt && { state: attempt.state, reason: attempt.reason, messageDigest: attempt.messageDigest, typedDigest: attempt.typedDigest },
          history: local.db.prepare('SELECT role, content, message_type FROM chat_messages ORDER BY timestamp, rowid').all(),
        };
      } finally {
        overrideBriefMode(null);
        closeWorld(local);
        world = previous;
        bindWorld(previous);
      }
    };
    const asBefore = await observe('never');
    const empty = await observe('auto');
    expect(empty).toEqual(asBefore);
    // The image send's record keeps the typed body it has today (#4048).
    expect(asBefore.attempt?.typedDigest).toBe(sendMessageDigest('with image\n![](/tmp/x.png)'));
    // (control) the comparison can fail: one byte more is seen.
    expect({ ...empty, typed: [...empty.typed, ['x']] }).not.toEqual(asBefore);
  });

  const staleKeys = Object.keys(ENTRANCES).filter((key) => typeof ENTRANCES[key].stale !== 'string');

  async function overtaken(entry: Entrance, recreate: boolean): Promise<boolean> {
    const stale = entry.stale as Exclude<Entrance['stale'], string>;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = fakeProvider({
      build: vi.fn(async (request: BriefRequest) => {
        if (stale.hold === 'provider') await gate;
        return { body: FAKE_BRIEF, includedNoticeIds: [], mode: request.membership.mode };
      }),
    });
    arrange(entry);
    if (entry.arrange) fakeProvider({ build: provider.build });
    if (key0(entry) !== 'send --with-brief opens an explicit row') launch('claude');
    world.tools.claude.sendMessage.mockClear();
    if (stale.hold === 'tool') world.tools.claude.sendMessage.mockImplementationOnce(() => gate);
    const pending = stale.request();
    for (let i = 0; i < 200; i++) {
      const waiting = stale.hold === 'provider' ? provider.build.mock.calls.length > 0 : world.tools.claude.sendMessage.mock.calls.length > 0;
      if (waiting) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (recreate) {
      removeAgentInstance(world.db, WT, 'claude');
      addAgentInstance(world.db, WT, { id: 'claude', cliTool: 'claude', alias: '', order: 0 });
    }
    release();
    await pending;
    return stale.landed();
  }

  const key0 = (entry: Entrance) => Object.keys(ENTRANCES).find((key) => ENTRANCES[key] === entry);

  it('(a) every entrance either has a stale request to refuse or says why it has none', () => {
    for (const [key, entry] of Object.entries(ENTRANCES)) {
      if (typeof entry.stale === 'string') expect(entry.stale.length, key).toBeGreaterThan(20);
    }
    expect(staleKeys.length).toBeGreaterThan(0);
  });

  it.each(staleKeys)('(a) %s: the instance deleted and made again under the same id while it waits → refused', async (key) => {
    expect(await overtaken(ENTRANCES[key], true)).toBe(false);
  });

  it.each(staleKeys)('(a) %s (control): the instance left as it was → it lands', async (key) => {
    expect(await overtaken(ENTRANCES[key], false)).toBe(true);
  });
});
