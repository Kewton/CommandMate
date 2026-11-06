/**
 * The recovery read of OpenCode V2's history (Issue #4187, §5.2 H1〜H6, C6・C7).
 *
 * The ordinary read on a turn's end (`syncOpencodeV2History`) reads newest-first
 * pages and stops at the first page with any `user` message, so a turn that
 * closed while the stream was down and sits a page further back is never read.
 * The recovery read goes back the whole `MAX_OPENCODE_V2_HISTORY_PAGES` (or to
 * the document's end) without stopping at a turn History already has — no
 * saved turn marks the gap's edge for sure, whatever order rows were written in
 * and whatever the clocks say — warns only when turns History lacks may lie
 * beyond the cap, and tells "could not read" from "nothing to write" so the
 * subscription can retry.
 *
 * Documents are the measured 2.0.18 turn (`tests/fixtures/opencode-v2-history-2940`)
 * cloned under new ids and times and served one turn per page by a loopback
 * server with the real Basic auth.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rows = new Map<string, Record<string, unknown>>();
const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `row-${rows.size + 1}`, ...message };
  rows.set(String(message.requestId), saved);
  return saved;
});
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (_db: unknown, _worktreeId: string, requestId: string) =>
    rows.get(requestId) ?? null,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({ createLogger: vi.fn(() => mockLogger) }));

import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import {
  MAX_OPENCODE_V2_HISTORY_PAGES,
  recoverOpencodeV2History,
  resetOpencodeV2HistoryQueue,
  syncOpencodeV2History,
} from '@/lib/hooks/sources/opencode-v2/history';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import { opencodeTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-history-2940');
const DOCUMENT = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-two-turns-2.0.18.json'), 'utf8')
) as { data: Record<string, unknown>[] };
/** The measured first turn, oldest first: user, assistant, idle. */
const [IDLE, ASSISTANT, USER] = DOCUMENT.data.slice(4) as Record<string, unknown>[];

const SESSION = 'ses_4187recoveryAAAAAAAAAAAA';
const BASE = 1_790_000_000_000;

const target: AgentInstanceRef = {
  worktreeId: 'wt-4187-history',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

/** Turn `n`'s user message id. */
const userId = (n: number): string => `msg_4187u${String(n).padStart(4, '0')}`;
/** When turn `n` started. */
const startOf = (n: number): number => BASE + n * 10_000;

/** The measured turn as turn `n`, newest first; `closed: false` drops its idle. */
function turn(n: number, closed = true, at = startOf(n)): Record<string, unknown>[] {
  const content = (ASSISTANT.content as Record<string, unknown>[])
    .filter((item) => item.type !== 'reasoning')
    .map((item) => (item.type === 'text' ? { ...item, text: `TURN-${n}` } : item));
  const messages = [
    { ...USER, id: userId(n), time: { created: at }, text: `turn ${n}` },
    {
      ...ASSISTANT,
      id: `msg_4187a${String(n).padStart(4, '0')}`,
      time: { created: at + 100, completed: at + 2_000 },
      content,
    },
    ...(closed ? [{ ...IDLE, id: `msg_4187i${String(n).padStart(4, '0')}`, time: { created: at + 2_001 } }] : []),
  ];
  return messages.reverse();
}

let dir: string;
let server: Server | null;
let port: number;
/** Newest-first pages; page k answers `cursor=p<k>`. */
let pages: Record<string, unknown>[][];
let messagesStatus: number;
/** A page index that answers 500 (`null`: none). */
let failPage: number | null;
let pagesRead: number[];

async function startServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === `/api/session/${SESSION}/message`) {
      if (messagesStatus !== 200) {
        res.writeHead(messagesStatus);
        res.end();
        return;
      }
      const cursor = url.searchParams.get('cursor');
      const index = cursor === null ? 0 : Number(cursor.slice(1));
      pagesRead.push(index);
      if (index === failPage) {
        res.writeHead(500);
        res.end();
        return;
      }
      const next = index + 1 < pages.length ? `p${index + 1}` : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: pages[index] ?? [], cursor: { previous: 'x', next } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

function markSaved(n: number): void {
  rows.set(opencodeTurnRequestId(userId(n)), { requestId: opencodeTurnRequestId(userId(n)), role: 'assistant' });
}

function writtenTurns(): string[] {
  return createMessage.mock.calls.map(([, m]) => String(m.content).split('\n')[0]);
}

function warned(event: string): unknown[][] {
  return mockLogger.warn.mock.calls.filter(([name]) => name === event);
}

beforeEach(async () => {
  dir = makeTempDir('cm-4187-history-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  rows.clear();
  createMessage.mockClear();
  mockLogger.warn.mockClear();
  messagesStatus = 200;
  failPage = null;
  pagesRead = [];
  pages = [];
  server = null;
  await startServer();
});

afterEach(async () => {
  resetOpencodeV2HistoryQueue();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('recoverOpencodeV2History (Issue #4187)', () => {
  it('H1: reaches an unsaved turn a page back, which the ordinary read never does', async () => {
    // Turn 1 closed while the stream was down; turn 2 is newer, on page 1.
    pages = [turn(2), turn(1)];

    // The ordinary read stops at page 1 (it saw a user message): turn 1 is lost.
    expect(await syncOpencodeV2History(target, port, SESSION)).toBe(1);
    expect(writtenTurns()).toEqual(['TURN-2']);
    expect(pagesRead).toEqual([0]);

    // Turn 2 is saved, which does not stop the recovery read: it goes on to page 2.
    pagesRead = [];
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 1,
      unreadable: false,
    });
    expect(writtenTurns()).toEqual(['TURN-2', 'TURN-1']);
    expect(pagesRead).toEqual([0, 1]);
  });

  it('H2: three unsaved turns are all written, oldest first', async () => {
    pages = [turn(4), turn(3), turn(2), turn(1)];
    markSaved(1);
    const result = await recoverOpencodeV2History(target, port, SESSION);
    expect(result).toEqual({ written: 3, unreadable: false });
    expect(writtenTurns()).toEqual(['TURN-2', 'TURN-3', 'TURN-4']);
    expect(createMessage.mock.calls.map(([, m]) => m.requestId)).toEqual([
      opencodeTurnRequestId(userId(2)),
      opencodeTurnRequestId(userId(3)),
      opencodeTurnRequestId(userId(4)),
    ]);
  });

  it('H3: reads past the turns already saved, and does not double them', async () => {
    pages = [turn(4), turn(3), turn(2), turn(1)];
    markSaved(3);
    markSaved(2);
    markSaved(1);
    const result = await recoverOpencodeV2History(target, port, SESSION);
    expect(result).toEqual({ written: 1, unreadable: false });
    expect(pagesRead).toEqual([0, 1, 2, 3]);
    expect(writtenTurns()).toEqual(['TURN-4']);
    expect(warned('opencode-v2-history-recovery-truncated')).toEqual([]);
  });

  it('H4: never meeting a saved turn, it stops at the page cap and says so', async () => {
    pages = Array.from({ length: MAX_OPENCODE_V2_HISTORY_PAGES + 2 }, (_v, i) => turn(100 - i));
    const result = await recoverOpencodeV2History(target, port, SESSION);
    expect(pagesRead).toHaveLength(MAX_OPENCODE_V2_HISTORY_PAGES);
    expect(result.unreadable).toBe(false);
    expect(result.written).toBe(MAX_OPENCODE_V2_HISTORY_PAGES);
    const truncated = warned('opencode-v2-history-recovery-truncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0][1]).toMatchObject({ sessionId: SESSION, pages: MAX_OPENCODE_V2_HISTORY_PAGES });
  });

  it('H5: the newest turn, still open, is not written', async () => {
    pages = [turn(3, false), turn(2), turn(1)];
    markSaved(1);
    const result = await recoverOpencodeV2History(target, port, SESSION);
    expect(result).toEqual({ written: 1, unreadable: false });
    expect(writtenTurns()).toEqual(['TURN-2']);
  });

  it('C7: an unreadable document is told from a document with nothing to write', async () => {
    messagesStatus = 500;
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 0,
      unreadable: true,
    });
    messagesStatus = 200;
    pages = [turn(1)];
    markSaved(1);
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 0,
      unreadable: false,
    });
    expect(warned('opencode-v2-history-recovery-truncated')).toEqual([]);
  });

  it('H7: a newer turn the ordinary sync wrote before the loss was noticed does not hide an older one', async () => {
    // Turn 2 closed unseen; turn 3's end was still delivered and its ordinary
    // sync finished; only then did the watchdog notice the loss.
    pages = [turn(3), turn(2), turn(1)];
    markSaved(1);
    expect(await syncOpencodeV2History(target, port, SESSION)).toBe(1);
    pagesRead = [];
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 1,
      unreadable: false,
    });
    expect(writtenTurns()).toEqual(['TURN-3', 'TURN-2']);
    expect(pagesRead).toEqual([0, 1, 2]);
  });

  it('H8: a clock that moved makes no difference', async () => {
    // V2's clock went back: turn 3 says it began long before turns 1 and 2.
    pages = [turn(3, true, BASE - 3_600_000), turn(2), turn(1)];
    markSaved(1);
    expect(await syncOpencodeV2History(target, port, SESSION)).toBe(1);
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 1,
      unreadable: false,
    });
    expect(writtenTurns()).toEqual(['TURN-3', 'TURN-2']);
  });

  it('H9: read again, it writes nothing and reads no further than the cap', async () => {
    pages = Array.from({ length: MAX_OPENCODE_V2_HISTORY_PAGES + 2 }, (_v, i) => turn(100 - i));
    await recoverOpencodeV2History(target, port, SESSION);
    const rowsAfterFirst = createMessage.mock.calls.length;
    mockLogger.warn.mockClear();
    pagesRead = [];
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 0,
      unreadable: false,
    });
    expect(createMessage.mock.calls.length).toBe(rowsAfterFirst);
    expect(pagesRead).toHaveLength(MAX_OPENCODE_V2_HISTORY_PAGES);
    // The oldest page read is saved now: nothing says turns are missing.
    expect(warned('opencode-v2-history-recovery-truncated')).toEqual([]);
  });

  it('H10: a partial recovery that saved the newest turn, then another loss, still writes the older one', async () => {
    // A long gap: page 2 cannot be read the first time, so only turn 3 is saved.
    pages = [turn(3), turn(2), turn(1)];
    markSaved(1);
    failPage = 1;
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 1,
      unreadable: true,
    });
    expect(writtenTurns()).toEqual(['TURN-3']);
    // Whatever was written in between, the next recovery is not stopped by turn 3.
    failPage = null;
    pagesRead = [];
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 1,
      unreadable: false,
    });
    expect(writtenTurns()).toEqual(['TURN-3', 'TURN-2']);
    expect(pagesRead).toEqual([0, 1, 2]);
  });

  it('H11: a long document all saved gives no warn and no row', async () => {
    pages = Array.from({ length: MAX_OPENCODE_V2_HISTORY_PAGES + 2 }, (_v, i) => turn(100 - i));
    for (let i = 0; i < pages.length; i += 1) markSaved(100 - i);
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 0,
      unreadable: false,
    });
    expect(pagesRead).toHaveLength(MAX_OPENCODE_V2_HISTORY_PAGES);
    expect(warned('opencode-v2-history-recovery-truncated')).toEqual([]);
  });

  it('H12: at the cap, it warns only when the oldest page read holds an unsaved turn', async () => {
    // Unsaved turns on newer pages only: they are written, and nothing beyond is suspected.
    pages = Array.from({ length: MAX_OPENCODE_V2_HISTORY_PAGES + 2 }, (_v, i) => turn(100 - i));
    for (let i = 2; i < pages.length; i += 1) markSaved(100 - i);
    expect(await recoverOpencodeV2History(target, port, SESSION)).toEqual({
      written: 2,
      unreadable: false,
    });
    expect(warned('opencode-v2-history-recovery-truncated')).toEqual([]);
  });

  it('H6: the public syncOpencodeV2History still answers the number of rows written', async () => {
    pages = [turn(1)];
    const first = await syncOpencodeV2History(target, port, SESSION);
    const again = await syncOpencodeV2History(target, port, SESSION);
    expect([typeof first, first, again]).toEqual(['number', 1, 0]);
    messagesStatus = 500;
    await expect(syncOpencodeV2History(target, port, SESSION)).resolves.toBe(0);
  });
});
