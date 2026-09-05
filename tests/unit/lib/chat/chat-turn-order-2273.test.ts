/**
 * The chip group sits between the question and the answer (Issue #2273).
 *
 * ## The defect
 *
 * A turn really goes **question → approval → answer**, and the chat surface drew
 * it as question → answer → `Tool approvals · 1`. The measured antigravity turn:
 * prompt `04:49:50.989Z`, reply `04:49:54.000Z`, approval dialog `04:49:57.513Z`
 * — the transcript reader dated the reply at the instant the TURN OPENED, so it
 * sorted three seconds before an approval the agent had asked for on the way to
 * writing it.
 *
 * The readers now date a reply at its turn's end (`turn-timestamp-2273`), which
 * fixes every row written from here on. It fixes nothing already in the
 * database — a row's timestamp is never rewritten — so `buildChatTranscriptRows`
 * carries the same rule at the display layer, where it also absorbs the
 * *producers* that are still late: the Auto-Yes duplicate lands 1–2 seconds
 * after the sweep's row (measured, #2245), so an approval arriving after a
 * correctly dated reply is a shape that still occurs.
 *
 * ## What is asserted
 *
 * The acceptance criterion verbatim — `[user, assistant(ts = user+1),
 * prompt(ts = user+7s)]` renders as `[user, approvals, assistant]` — plus the
 * bounds that keep the rule from doing damage: nothing crosses a turn boundary,
 * the `showHeader` invariant #2245 established is untouched, and a list with
 * nothing to move comes back as the identical array.
 *
 * ## Non-vacuity
 *
 * `the pre-#2273 ordering is what the fixture holds` asserts that the INPUT is
 * in the broken order, so `[user, approvals, assistant]` is a rearrangement
 * rather than a description of what was passed in. Without it every case below
 * would pass against a `buildChatTranscriptRows` that did nothing at all.
 */

import { describe, expect, it } from 'vitest';
import {
  buildChatTranscriptRows,
  hoistTurnApprovals,
  type ChatTranscriptRow,
} from '@/lib/chat/chat-transcript-view';
import { isToolApprovalMessage } from '@/lib/chat/chat-tool-approvals';
import type { ChatMessage } from '@/types/models';

/** The turn the Issue measured, on its own clock. */
const USER_AT = Date.parse('2026-09-03T04:49:50.989Z');
/** What the reader wrote before this Issue: the turn's start, plus a tick. */
const REPLY_AT = USER_AT + 1;
/** The approval dialog, seven seconds into the turn. */
const APPROVAL_AT = USER_AT + 7_000;

function message(
  id: string,
  role: ChatMessage['role'],
  at: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: 'wt-2273',
    role,
    content: `body ${id}`,
    timestamp: new Date(at),
    messageType: 'normal',
    archived: false,
    cliToolId: 'antigravity',
    ...extra,
  };
}

const user = (id: string, at: number) => message(id, 'user', at);
const assistant = (id: string, at: number) => message(id, 'assistant', at);
const approval = (id: string, at: number, question = `Approve ${id}?`) =>
  message(id, 'assistant', at, {
    messageType: 'prompt',
    promptData: {
      type: 'multiple_choice',
      question,
      options: [],
      status: 'answered',
      answeredBy: 'terminal',
    } as unknown as ChatMessage['promptData'],
  });

/** The list as the API hands it over: sorted by timestamp and nothing else. */
function byTimestamp(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function kinds(rows: ChatTranscriptRow[]): string[] {
  return rows.map((row) => row.kind);
}

/** The measured turn, with the reply carrying the timestamp the old rule gave it. */
function measuredTurn(): ChatMessage[] {
  return byTimestamp([
    user('u1', USER_AT),
    assistant('a1', REPLY_AT),
    approval('p1', APPROVAL_AT),
  ]);
}

describe('[#2273] the measured turn', () => {
  it('the pre-#2273 ordering is what the fixture holds', () => {
    // Non-vacuity for everything below: the input really is in the broken order,
    // so the expected output is a rearrangement and not a restatement.
    expect(measuredTurn().map((m) => m.id)).toEqual(['u1', 'a1', 'p1']);
  });

  it('renders as question, chips, answer', () => {
    const rows = buildChatTranscriptRows(measuredTurn());

    expect(kinds(rows)).toEqual(['message', 'approvals', 'message']);
    expect(rows[0].kind === 'message' && rows[0].message.id).toBe('u1');
    expect(rows[2].kind === 'message' && rows[2].message.id).toBe('a1');
  });

  it('still labels the reply as the assistant’s', () => {
    // #2245's invariant, unchanged: a chip group is not an assistant turn, so
    // moving one must not add or remove a header.
    const rows = buildChatTranscriptRows(measuredTurn());
    const reply = rows[2];

    expect(reply.kind === 'message' && reply.showHeader).toBe(true);
    expect(
      buildChatTranscriptRows([user('u1', USER_AT), assistant('a1', REPLY_AT)]).filter(
        (row) => row.kind === 'message' && row.showHeader,
      ),
    ).toHaveLength(2);
  });

  it('is unchanged once the reader dates the reply at the turn’s end', () => {
    // The other half of the fix. A row written after this Issue already sorts
    // correctly, and the display rule must be a no-op on it rather than a second
    // rearrangement.
    const fixed = byTimestamp([
      user('u1', USER_AT),
      approval('p1', APPROVAL_AT),
      assistant('a1', APPROVAL_AT + 3_000),
    ]);

    expect(hoistTurnApprovals(fixed)).toBe(fixed);
    expect(kinds(buildChatTranscriptRows(fixed))).toEqual(['message', 'approvals', 'message']);
  });
});

describe('[#2273] the turn boundary', () => {
  it('never lifts an approval onto the previous question', () => {
    const rows = buildChatTranscriptRows(
      byTimestamp([
        user('u1', USER_AT),
        assistant('a1', USER_AT + 1),
        user('u2', USER_AT + 60_000),
        assistant('a2', USER_AT + 60_001),
        approval('p2', USER_AT + 67_000),
      ]),
    );

    expect(kinds(rows)).toEqual(['message', 'message', 'message', 'approvals', 'message']);
    const order = rows.flatMap((row) =>
      row.kind === 'message' ? [row.message.id] : row.entries.map((entry) => entry.id),
    );
    expect(order).toEqual(['u1', 'a1', 'u2', 'p2', 'a2']);
  });

  it('folds every approval of one turn into a single group', () => {
    // The trade this rule makes, stated as an assertion: the interleaving of
    // chips and replies INSIDE one turn is given up, and a turn's chips become
    // one line under its question. Across turns nothing merges.
    const rows = buildChatTranscriptRows(
      byTimestamp([
        user('u1', USER_AT),
        approval('p1', USER_AT + 1_000),
        assistant('a1', USER_AT + 2_000),
        approval('p2', USER_AT + 3_000),
        assistant('a2', USER_AT + 4_000),
      ]),
    );

    expect(kinds(rows)).toEqual(['message', 'approvals', 'message', 'message']);
    const group = rows[1];
    expect(group.kind === 'approvals' && group.entries.map((entry) => entry.id)).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('leaves approvals that arrived before any question where they are', () => {
    // The head of the window can land mid-turn: rows with no `user` row in front
    // of them are their own segment and must not be pushed anywhere.
    const messages = byTimestamp([
      approval('p0', USER_AT - 5_000),
      user('u1', USER_AT),
      assistant('a1', REPLY_AT),
    ]);

    expect(kinds(buildChatTranscriptRows(messages))).toEqual([
      'approvals',
      'message',
      'message',
    ]);
  });
});

describe('[#2273] hoistTurnApprovals', () => {
  it('returns the argument itself when nothing has to move', () => {
    const untouched = [user('u1', USER_AT), assistant('a1', REPLY_AT)];
    expect(hoistTurnApprovals(untouched)).toBe(untouched);
    expect(hoistTurnApprovals([])).toEqual([]);
  });

  it('keeps every message exactly once', () => {
    const messages = measuredTurn();
    const moved = hoistTurnApprovals(messages);

    expect(moved).toHaveLength(messages.length);
    expect(new Set(moved.map((m) => m.id))).toEqual(new Set(messages.map((m) => m.id)));
  });

  it('preserves the order of the approvals and of the replies separately', () => {
    const messages = byTimestamp([
      user('u1', USER_AT),
      approval('p1', USER_AT + 1_000),
      assistant('a1', USER_AT + 2_000),
      approval('p2', USER_AT + 3_000),
      assistant('a2', USER_AT + 4_000),
      approval('p3', USER_AT + 5_000),
    ]);
    const moved = hoistTurnApprovals(messages);

    expect(moved.map((m) => m.id)).toEqual(['u1', 'p1', 'p2', 'p3', 'a1', 'a2']);
    expect(moved.filter(isToolApprovalMessage).map((m) => m.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('does not mutate the list it was given', () => {
    const messages = measuredTurn();
    const before = messages.map((m) => m.id);

    hoistTurnApprovals(messages);

    expect(messages.map((m) => m.id)).toEqual(before);
  });
});
