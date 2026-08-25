/**
 * The opencode history writer against a real database (Issue #2041).
 *
 * `tests/unit/hooks/sources/opencode-transcript-2041.test.ts` pins the
 * *rendering*; this file pins what reaches `chat_messages`, which is where the
 * Issue's two hard requirements live:
 *
 *  - the saved body equals what `GET /session/:id/message` reports, and
 *  - a re-sent `message.part.updated` — or a whole backfill run over turns the
 *    stream already saved — does not write a second row.
 *
 * Both fixtures come from one live capture against opencode **1.18.22** in the
 * isolated `HOME` of the design document's §4; see §13 for the run.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb?.close();
      mockDb = null;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: vi.fn(),
}));

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>()),
  fetchOpencodeSessionMessages: vi.fn(),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { getMessages, upsertWorktree } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import { fetchOpencodeSessionMessages } from '@/lib/hooks/sources/opencode/client';
import {
  backfillOpencodeHistory,
  flushOpencodeTurn,
  forgetOpencodeTranscripts,
  peekOpencodeTurn,
  recordOpencodeTranscriptFrame,
  resetOpencodeTranscripts,
} from '@/lib/hooks/sources/opencode/history';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import type { Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

interface Frame {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

const FRAMES: Frame[] = JSON.parse(
  readFileSync(join(FIXTURES, 'history-turns-1-18-22.json'), 'utf-8')
) as Frame[];
const MESSAGES: Record<string, unknown>[] = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-1-18-22.json'), 'utf-8')
) as Record<string, unknown>[];

const SESSION = 'ses_0000000000000000000000000';
const PORT = 4881;
const TARGET = { worktreeId: 'wt-2041', cliToolId: 'opencode', instanceId: 'opencode' } as const;

const TURNS = [
  'msg_user0000000000000000001',
  'msg_user0000000000000000002',
  'msg_user0000000000000000003',
] as const;

let db: Database.Database;

/** Feed the captured stream in, flushing at every `session.idle`. */
async function playStream(frames: readonly Frame[]): Promise<void> {
  for (const frame of frames) {
    recordOpencodeTranscriptFrame(TARGET, frame as unknown as Record<string, unknown>, 1_787_648_517_229);
    if (frame.type === 'session.idle') {
      await flushOpencodeTurn(TARGET, frame.properties.sessionID as string);
    }
  }
}

/** The assistant rows this worktree has, oldest first. */
function savedAssistantRows() {
  return getMessages(db, TARGET.worktreeId, { limit: 100 })
    .filter((message) => message.role === 'assistant')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/** The text `GET /session/:id/message` reports for one turn. */
function serverTextFor(userMessageId: string): string[] {
  const out: string[] = [];
  for (const entry of MESSAGES) {
    const info = entry.info as Record<string, unknown>;
    if (info.role !== 'assistant' || info.parentID !== userMessageId) continue;
    for (const part of entry.parts as Record<string, unknown>[]) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        out.push(part.text);
      }
    }
  }
  return out;
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetOpencodeTranscripts();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database) => void;
  };
  setMockDb(db);

  const worktree: Worktree = {
    id: TARGET.worktreeId,
    name: 'issue-2041',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  resetOpencodeTranscripts();
  const { closeDbInstance } = (await import('@/lib/db/db-instance')) as unknown as {
    closeDbInstance: () => void;
  };
  closeDbInstance();
});

describe('the three measured turns, written from the stream', () => {
  it('saves one row per turn', async () => {
    await playStream(FRAMES);

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.requestId)).toEqual(TURNS.map(opencodeTurnRequestId));
    // Every row is tagged as the agent's own Markdown, which is what tells the
    // card it may parse it. A row missing this reads as a terminal scrape.
    expect(rows.every((row) => row.cliToolId === 'opencode')).toBe(true);
  });

  it('saves the body the server reports, verbatim', async () => {
    await playStream(FRAMES);
    const rows = savedAssistantRows();

    for (const [index, userMessageId] of TURNS.entries()) {
      const texts = serverTextFor(userMessageId);
      // Non-vacuity: an empty `texts` would make the loop below assert nothing.
      expect(texts.length, userMessageId).toBeGreaterThan(0);
      for (const text of texts) {
        expect(rows[index].content, userMessageId).toContain(text);
      }
    }
  });

  it('keeps the 967-character paragraph on the one line the agent wrote it on', async () => {
    await playStream(FRAMES);
    const paragraph = savedAssistantRows()[2].content;
    expect(paragraph.split('\n')).toHaveLength(1);
    expect(paragraph.length).toBeGreaterThan(900);
  });

  it('summarises the tool call and keeps the reply about it in the same row', async () => {
    await playStream(FRAMES);
    expect(savedAssistantRows()[1].content).toBe(
      '- `bash` — echo CMATE-2041-TOOL-MARKER\n\nIt printed `CMATE-2041-TOOL-MARKER`.'
    );
  });

  it('broadcasts each saved row so an open History pane sees it', async () => {
    await playStream(FRAMES);
    expect(vi.mocked(broadcastMessage)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(broadcastMessage).mock.calls[0][0]).toBe('message');
  });
});

describe('idempotency', () => {
  it('writes nothing extra when every frame arrives twice', async () => {
    await playStream(FRAMES);
    await playStream(FRAMES);
    expect(savedAssistantRows()).toHaveLength(3);
  });

  it('writes nothing extra when only the part frames are re-sent', async () => {
    // The shape the Issue names (#1763 / #1899): a reconnect re-delivers the
    // boundary frames byte-identically.
    const repeated = FRAMES.flatMap((frame) =>
      frame.type === 'message.part.updated' ? [frame, frame] : [frame]
    );
    await playStream(repeated);

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(3);
    expect(rows[0].content).toBe('## Heading A\n\n- item one\n- item two\n\n**bold** and `code`');
  });

  it('writes nothing extra when a second session.idle arrives for one turn', async () => {
    // An abort emits `session.idle` twice, 19-23 ms apart (#1758 §5.3.2). The
    // accumulator is taken by the first, so the second finds nothing.
    const doubled = FRAMES.flatMap((frame) =>
      frame.type === 'session.idle' ? [frame, frame] : [frame]
    );
    await playStream(doubled);
    expect(savedAssistantRows()).toHaveLength(3);
  });
});

describe('the GET /session/:id/message backfill', () => {
  it('writes every turn when history is empty', async () => {
    vi.mocked(fetchOpencodeSessionMessages).mockResolvedValue(MESSAGES);

    const written = await backfillOpencodeHistory(TARGET, PORT, SESSION);

    expect(written).toBe(3);
    const rows = savedAssistantRows();
    expect(rows.map((row) => row.requestId)).toEqual(TURNS.map(opencodeTurnRequestId));
  });

  it('writes nothing when the stream already saved the same turns', async () => {
    await playStream(FRAMES);
    vi.mocked(fetchOpencodeSessionMessages).mockResolvedValue(MESSAGES);

    expect(await backfillOpencodeHistory(TARGET, PORT, SESSION)).toBe(0);
    expect(savedAssistantRows()).toHaveLength(3);
  });

  it('produces the same bodies as the stream did', async () => {
    // If these differed, running both paths — which every reconnect does —
    // would leave History with two differently-worded copies of one reply, and
    // the `request_id` check would not catch it because the ids would match.
    vi.mocked(fetchOpencodeSessionMessages).mockResolvedValue(MESSAGES);
    await backfillOpencodeHistory(TARGET, PORT, SESSION);
    const fromRest = savedAssistantRows().map((row) => row.content);

    db.prepare('DELETE FROM chat_messages').run();
    resetOpencodeTranscripts();
    await playStream(FRAMES);

    expect(savedAssistantRows().map((row) => row.content)).toEqual(fromRest);
  });

  it('recovers exactly the turn the stream missed', async () => {
    // The real restart shape: CommandMate was down for turn 2 and came back for
    // turn 3. Only turn 2 is missing, and only turn 2 is written.
    const turn2Idle = FRAMES.findIndex(
      (frame, index) =>
        frame.type === 'session.idle' &&
        FRAMES.slice(0, index).filter((each) => each.type === 'session.idle').length === 1
    );
    const turn1Idle = FRAMES.findIndex((frame) => frame.type === 'session.idle');
    await playStream([...FRAMES.slice(0, turn1Idle + 1), ...FRAMES.slice(turn2Idle + 1)]);
    expect(savedAssistantRows()).toHaveLength(2);

    vi.mocked(fetchOpencodeSessionMessages).mockResolvedValue(MESSAGES);
    expect(await backfillOpencodeHistory(TARGET, PORT, SESSION)).toBe(1);

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.requestId).sort()).toEqual(
      TURNS.map(opencodeTurnRequestId).sort()
    );
  });

  it('answers zero and writes nothing when the server cannot be asked', async () => {
    vi.mocked(fetchOpencodeSessionMessages).mockResolvedValue(null);
    expect(await backfillOpencodeHistory(TARGET, PORT, SESSION)).toBe(0);
    expect(savedAssistantRows()).toHaveLength(0);
  });

  it('does not take the caller down when the fetch throws', async () => {
    vi.mocked(fetchOpencodeSessionMessages).mockRejectedValue(new Error('ECONNRESET'));
    await expect(backfillOpencodeHistory(TARGET, PORT, SESSION)).resolves.toBe(0);
  });
});

describe('what is never written', () => {
  it('saves nothing for a turn that produced only bookkeeping parts', async () => {
    // An abort before the first token. A row here would show as a blank reply
    // in History forever.
    recordOpencodeTranscriptFrame(
      TARGET,
      {
        type: 'message.updated',
        properties: {
          sessionID: SESSION,
          info: { id: 'msg_a', role: 'assistant', parentID: 'msg_user_x' },
        },
      },
      1,
    );
    recordOpencodeTranscriptFrame(
      TARGET,
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: { id: 'prt_1', messageID: 'msg_a', type: 'step-start' },
        },
      },
      2,
    );

    expect(await flushOpencodeTurn(TARGET, SESSION)).toBe(false);
    expect(savedAssistantRows()).toHaveLength(0);
  });

  it('ignores the user’s own message, whose text send already saved', async () => {
    recordOpencodeTranscriptFrame(
      TARGET,
      {
        type: 'message.updated',
        properties: { sessionID: SESSION, info: { id: 'msg_u', role: 'user' } },
      },
      1,
    );
    expect(peekOpencodeTurn(TARGET, SESSION)).toBeNull();
  });

  it('does not merge an unfinished turn into the next prompt’s reply', async () => {
    // The `session.idle` for turn 1 never arrived — the stream dropped mid-turn,
    // or the flush lost a race with the next prompt. Turn 1's text must not be
    // prepended to turn 2's reply, which is what the operator would read as the
    // agent answering a question with the previous answer.
    const assistant = (id: string, parent: string) => ({
      type: 'message.updated',
      properties: { sessionID: SESSION, info: { id, role: 'assistant', parentID: parent } },
    });
    const text = (partId: string, messageId: string, body: string) => ({
      type: 'message.part.updated',
      properties: {
        sessionID: SESSION,
        part: { id: partId, messageID: messageId, type: 'text', text: body },
      },
    });

    recordOpencodeTranscriptFrame(TARGET, assistant('msg_a1', 'msg_u1'), 1);
    recordOpencodeTranscriptFrame(TARGET, text('prt_1', 'msg_a1', 'ANSWER TO THE FIRST'), 2);
    // No `session.idle`. The next prompt's assistant message arrives instead.
    recordOpencodeTranscriptFrame(TARGET, assistant('msg_a2', 'msg_u2'), 3);
    recordOpencodeTranscriptFrame(TARGET, text('prt_2', 'msg_a2', 'ANSWER TO THE SECOND'), 4);

    expect(await flushOpencodeTurn(TARGET, SESSION)).toBe(true);

    const rows = savedAssistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe(opencodeTurnRequestId('msg_u2'));
    expect(rows[0].content).toBe('ANSWER TO THE SECOND');
    expect(rows[0].content).not.toContain('ANSWER TO THE FIRST');
  });

  it('drops a part that belongs to no open turn instead of inventing one', async () => {
    // A stream that opened mid-turn. The backfill is what recovers this.
    recordOpencodeTranscriptFrame(
      TARGET,
      {
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: { id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'orphan' },
        },
      },
      1,
    );
    expect(await flushOpencodeTurn(TARGET, SESSION)).toBe(false);
    expect(savedAssistantRows()).toHaveLength(0);
  });
});

describe('lifetime', () => {
  it('forgets an unfinished turn when the subscription closes', async () => {
    recordOpencodeTranscriptFrame(
      TARGET,
      {
        type: 'message.updated',
        properties: {
          sessionID: SESSION,
          info: { id: 'msg_a', role: 'assistant', parentID: 'msg_user_x' },
        },
      },
      1,
    );
    expect(peekOpencodeTurn(TARGET, SESSION)).not.toBeNull();

    forgetOpencodeTranscripts(TARGET);

    expect(peekOpencodeTurn(TARGET, SESSION)).toBeNull();
    expect(await flushOpencodeTurn(TARGET, SESSION)).toBe(false);
  });

  it('keeps one instance’s turn out of another’s', async () => {
    const other = { worktreeId: TARGET.worktreeId, cliToolId: 'opencode', instanceId: 'opencode-2' } as const;
    recordOpencodeTranscriptFrame(
      TARGET,
      {
        type: 'message.updated',
        properties: {
          sessionID: SESSION,
          info: { id: 'msg_a', role: 'assistant', parentID: 'msg_user_x' },
        },
      },
      1,
    );
    expect(peekOpencodeTurn(other, SESSION)).toBeNull();
    expect(peekOpencodeTurn(TARGET, SESSION)).not.toBeNull();
  });
});
