/**
 * The two kinds of row `findUnkeyedUserMessages` can be asked for (Issue #2392).
 *
 * #2196 gave the lookup one job: the `/send` row, which carries no `request_id`
 * and may therefore be *claimed* by whichever producer finds its own text on it.
 * That definition is what let the relay duplication through. `relay-delivery`
 * writes the answer it types into the requesting session's composer as a `relay`
 * user row keyed `relay:<ledgerId>`, and being keyed put it outside this query —
 * so the session's own transcript reader, finding nothing, inserted the same
 * body a second time.
 *
 * `includeRelayDelivered` is the opt-in that puts that row in the answer.
 * Everything below is about the two properties that make it safe:
 *
 *  - **it widens and never replaces** — the default answer is #2196's, row for
 *    row, so no existing caller can start seeing a row whose key another reader
 *    depends on;
 *  - **it admits exactly the delivery** — a `relay` row with no key at all is a
 *    relay *prompt* and stays an ordinary unkeyed candidate; `relay-sys:`
 *    furniture, a bare `relay:`, a transcript key and an assistant row are all
 *    refused.
 *
 * A relay row that does come back carries its `requestId`, which is how the
 * caller knows not to claim it; `user-turn-recorder-2392` states that half.
 *
 * @vitest-environment node
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/db-migrations';
import {
  createMessage,
  findUnkeyedUserMessages,
  relayRequestId,
  RELAY_SYSTEM_REQUEST_ID_PREFIX,
  USER_TURN_CANDIDATE_LIMIT,
  type UserTurnCandidateQuery,
} from '@/lib/db/chat-db';
import { upsertWorktree } from '@/lib/db';
import type { ChatMessage, MessageType, Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-2392-db';
const RELAY_ID = 'c12d462f-8e1a-4f77-9c50-2b6d3ea9f014';
const BODY = '【Codex 2 (agents-repo) からの返答】\n\n調査は完了しました。';
const AT = Date.parse('2026-09-07T04:31:43.099Z');

const WINDOW: UserTurnCandidateQuery = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'claude',
  instanceId: 'claude',
  fromMs: AT - 120_000,
  toMs: AT + 120_000,
};

/** The window as #2392's caller asks for it. */
const WIDENED: UserTurnCandidateQuery = { ...WINDOW, includeRelayDelivered: true };

let db: Database.Database;

interface RowSpec {
  content?: string;
  role?: 'user' | 'assistant';
  messageType?: MessageType;
  requestId?: string;
  at?: number;
  instanceId?: string;
}

function row(spec: RowSpec = {}): ChatMessage {
  return createMessage(db, {
    worktreeId: WORKTREE_ID,
    role: spec.role ?? 'user',
    content: spec.content ?? BODY,
    messageType: spec.messageType ?? 'normal',
    timestamp: new Date(spec.at ?? AT),
    cliToolId: 'claude',
    instanceId: spec.instanceId ?? 'claude',
    requestId: spec.requestId,
  });
}

/** The row `relay-delivery` writes for a reply. */
function delivery(spec: RowSpec = {}): ChatMessage {
  return row({ ...spec, messageType: 'relay', requestId: relayRequestId(RELAY_ID) });
}

function ids(query: UserTurnCandidateQuery): string[] {
  return findUnkeyedUserMessages(db, query).map((message) => message.id);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-2392',
    path: '/repos/commandmate-issue-2392',
    repositoryPath: '/repos',
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);
});

afterEach(() => {
  db.close();
});

describe('the default answer is #2196’s, unchanged', () => {
  it('still returns the `/send` row', () => {
    const sent = row();

    expect(ids(WINDOW)).toEqual([sent.id]);
  });

  it('still refuses every keyed row, the relay delivery included', () => {
    delivery();
    row({ requestId: 'claude-prompt:29a5b0d1-7e64-4a2f-9f3c-0d8a1b6c4e21' });

    expect(ids(WINDOW)).toEqual([]);
  });
});

describe('includeRelayDelivered', () => {
  it('adds the delivery row the default answer cannot see', () => {
    const delivered = delivery();

    expect(ids(WINDOW)).toEqual([]);
    expect(ids(WIDENED)).toEqual([delivered.id]);
  });

  it('hands it back with its key on it, which is how the caller knows not to claim it', () => {
    delivery();

    const [found] = findUnkeyedUserMessages(db, WIDENED);
    expect(found.requestId).toBe(relayRequestId(RELAY_ID));
    expect(found.messageType).toBe('relay');
  });

  it('widens rather than replaces — the `/send` row is still there', () => {
    const sent = row({ at: AT - 5_000 });
    const delivered = delivery();

    expect(ids(WIDENED)).toEqual([delivered.id, sent.id]);
  });

  it('answers newest first, so the caller can break a tie on the clock', () => {
    const older = delivery({ at: AT - 30_000 });
    const newer = delivery({ at: AT - 1_000 });

    expect(ids(WIDENED)).toEqual([newer.id, older.id]);
  });

  it('leaves a relay row that carries no key an ordinary unkeyed candidate', () => {
    // A relay *prompt* delivery is `message_type = 'relay'` with no
    // `request_id`. It was claimable before this Issue and stays claimable.
    const prompt = row({ messageType: 'relay' });

    expect(ids(WINDOW)).toEqual([prompt.id]);
    expect(ids(WIDENED)).toEqual([prompt.id]);
  });

  it('refuses a bare `relay:` that names no ledger entry', () => {
    row({ messageType: 'relay', requestId: 'relay:' });

    expect(ids(WIDENED)).toEqual([]);
  });

  it('refuses the relay SYSTEM line, which is furniture and not the delivery', () => {
    row({ messageType: 'relay', requestId: `${RELAY_SYSTEM_REQUEST_ID_PREFIX}${RELAY_ID}:replied` });

    expect(ids(WIDENED)).toEqual([]);
  });

  it('refuses a `relay:` key on a row that is not a relay row', () => {
    row({ requestId: relayRequestId(RELAY_ID) });

    expect(ids(WIDENED)).toEqual([]);
  });

  it('refuses a transcript reader’s own key', () => {
    row({ requestId: 'claude-prompt:29a5b0d1-7e64-4a2f-9f3c-0d8a1b6c4e21' });

    expect(ids(WIDENED)).toEqual([]);
  });

  it('refuses an assistant row however it is keyed', () => {
    row({ role: 'assistant', messageType: 'relay', requestId: relayRequestId(RELAY_ID) });

    expect(ids(WIDENED)).toEqual([]);
  });

  it('scopes to the instance, not merely the tool', () => {
    const mine = delivery();
    delivery({ instanceId: 'claude-2' });

    expect(ids(WIDENED)).toEqual([mine.id]);
  });

  it('reads a pre-#868 row as the primary instance’s, as the unkeyed rows are', () => {
    const delivered = delivery();
    db.prepare('UPDATE chat_messages SET instance_id = NULL WHERE id = ?').run(delivered.id);

    expect(ids(WIDENED)).toEqual([delivered.id]);
  });

  it('bounds by the window at both ends', () => {
    delivery({ at: AT - 120_001 });
    delivery({ at: AT + 120_001 });
    const inside = delivery({ at: AT });

    expect(ids(WIDENED)).toEqual([inside.id]);
  });

  it('skips an archived row, which is no longer in History to be seen twice', () => {
    const delivered = delivery();
    db.prepare('UPDATE chat_messages SET archived = 1 WHERE id = ?').run(delivered.id);

    expect(ids(WIDENED)).toEqual([]);
  });

  it('caps its answer at the shared candidate limit', () => {
    for (let i = 0; i <= USER_TURN_CANDIDATE_LIMIT; i += 1) {
      delivery({ at: AT - i * 1_000 });
    }

    expect(ids(WIDENED)).toHaveLength(USER_TURN_CANDIDATE_LIMIT);
    expect(ids({ ...WIDENED, limit: 3 })).toHaveLength(3);
  });

  it('does not compare content — that rule lives in the recorder', () => {
    const other = delivery({ content: 'まったく別の本文' });

    expect(ids(WIDENED)).toEqual([other.id]);
  });
});
