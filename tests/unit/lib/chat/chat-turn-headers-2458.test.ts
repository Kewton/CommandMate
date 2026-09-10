/**
 * Turn boundaries between consecutive saved assistant rows (Issue #2458).
 *
 * ## The defect
 *
 * `recordClaudeUserTurn` does not write a user row for a turn the operator did
 * not type, and a `task-notification` reply is exactly that: the agent answers,
 * the poller saves an assistant row, and nothing marks where the previous
 * answer stopped. Four such rows render under ONE "Assistant 18:33" header, so
 * the reader cannot tell what finished when — which is the whole complaint.
 *
 * The rows themselves are not touched. `resolveAssistantTimestampMs` still
 * dates a reply at its turn's END, the DB order is unchanged, and no new column
 * is written. What changes is that the display layer reads the turn key the row
 * already carries and cuts the run on it.
 *
 * ## Two rules, and the difference between them
 *
 *  - **the boundary** is drawn for every tool: the key changed, so the turn
 *    changed, and the reader is told so with a clock.
 *  - **the start-side time** is shown only when a saved user row in the same
 *    segment provably opened the same turn. claude, antigravity and Command
 *    Code key both halves of a turn on one id; codex and opencode do not, so
 *    they get the boundary and no range. Nothing is ever borrowed from "the
 *    user message above" or from `groupMessagesIntoPairs`.
 *
 * ## What makes this suite non-vacuous
 *
 * Almost every assertion has its opposite stated beside it, because a builder
 * that emitted no headers at all would satisfy the negative half on its own:
 *
 *  - `A → A` and `A → unknown → A` are asserted to draw NO divider while
 *    `A → unknown → B` and `A → prompt → B` are asserted to draw one, off the
 *    same helper and the same shapes;
 *  - every refusal of a start time is paired with the accepted case it was
 *    derived from — the same two rows, one field changed;
 *  - `18:18` is asserted ABSENT from rows 3–5, which is the specific wrong
 *    answer the Issue names ("do not reuse the first prompt's clock");
 *  - the #2245 role-label counts and the #2273 ordering are re-asserted here,
 *    since this Issue rewrites the loop that produces both.
 *
 * ## Why the `agent-transcript` helpers are asserted from here
 *
 * `resolveAgentTurnKey` and `correlatedPromptRequestId` live in
 * `src/types/agent-transcript.ts` and have no suite of their own in
 * `tests/unit/types/`. They exist for this Issue and are meaningless without
 * the rule below, so they are pinned in the file that uses them rather than in
 * a new file that would restate the same fixtures.
 */

import { describe, expect, it } from 'vitest';
import {
  buildChatTranscriptRows,
  type ChatRowHeader,
  type ChatTranscriptRow,
} from '@/lib/chat/chat-transcript-view';
import {
  correlatedPromptRequestId,
  resolveAgentTurnKey,
} from '@/types/agent-transcript';
import type { ChatMessage } from '@/types/models';
import { turnHeaderMessages } from '@tests/fixtures/chat-turn-headers-2458';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const WORKTREE_ID = 'wt-2458';

/** A local wall-clock instant, so `HH:mm` is the same string in every timezone. */
function at(hour: number, minute: number, day = 7): Date {
  return new Date(2026, 8, day, hour, minute, 0);
}

function message(
  id: string,
  role: ChatMessage['role'],
  timestamp: Date,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `body ${id}`,
    timestamp,
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    instanceId: 'claude',
    ...extra,
  };
}

const user = (id: string, timestamp: Date, requestId?: string) =>
  message(id, 'user', timestamp, requestId ? { requestId } : {});

const assistant = (id: string, timestamp: Date, requestId?: string) =>
  message(id, 'assistant', timestamp, requestId ? { requestId } : {});

/** An approval dialog row: folded into a chip group, never a turn boundary. */
const approval = (id: string, timestamp: Date) =>
  message(id, 'assistant', timestamp, {
    messageType: 'prompt',
    promptData: {
      type: 'multiple_choice',
      question: `Approve ${id}?`,
      options: [],
      status: 'answered',
      answeredBy: 'terminal',
    } as unknown as ChatMessage['promptData'],
  });

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

type MessageRow = Extract<ChatTranscriptRow, { kind: 'message' }>;

function messageRows(rows: ChatTranscriptRow[]): MessageRow[] {
  return rows.filter((row): row is MessageRow => row.kind === 'message');
}

function headerOf(rows: ChatTranscriptRow[], messageId: string): ChatRowHeader {
  const row = messageRows(rows).find((candidate) => candidate.message.id === messageId);
  if (!row) throw new Error(`no row for ${messageId}`);
  return row.header;
}

function variants(messages: ChatMessage[]): string[] {
  return messageRows(buildChatTranscriptRows(messages)).map((row) => row.header.variant);
}

// ===========================================================================
// The turn key itself
// ===========================================================================

describe('[#2458] resolveAgentTurnKey', () => {
  it('answers the WHOLE request_id for each of the five turn prefixes', () => {
    expect(resolveAgentTurnKey('claude-turn:abc')).toBe('claude-turn:abc');
    expect(resolveAgentTurnKey('codex-turn:t_1')).toBe('codex-turn:t_1');
    expect(resolveAgentTurnKey('antigravity-turn:conv#3')).toBe('antigravity-turn:conv#3');
    expect(resolveAgentTurnKey('command-code-turn:cb06ab09')).toBe('command-code-turn:cb06ab09');
    expect(resolveAgentTurnKey('oc-turn:msg_1')).toBe('oc-turn:msg_1');
  });

  it('keeps the prefix in the key, so two tools that shared a suffix are two turns', () => {
    // The mutation this catches is `requestId.slice(prefix.length)`: agy's
    // `conv#0` and Command Code's are both plausible ids, and comparing
    // suffixes alone would read a switch of tools as a continuation.
    expect(resolveAgentTurnKey('claude-turn:x')).not.toBe(resolveAgentTurnKey('codex-turn:x'));
  });

  it('refuses everything that is not a turn key', () => {
    expect(resolveAgentTurnKey('req_0123456789')).toBeNull();     // the scraper's id
    expect(resolveAgentTurnKey('claude-prompt:abc')).toBeNull();  // the USER half
    expect(resolveAgentTurnKey(undefined)).toBeNull();
    expect(resolveAgentTurnKey(null)).toBeNull();
    expect(resolveAgentTurnKey(42)).toBeNull();
    expect(resolveAgentTurnKey({ requestId: 'claude-turn:abc' })).toBeNull();
  });

  it('refuses an empty or whitespace-only suffix', () => {
    // `claude-turn:` names no turn. Accepting it would make every such row read
    // as the SAME turn as every other such row, which is worse than unknown.
    expect(resolveAgentTurnKey('claude-turn:')).toBeNull();
    expect(resolveAgentTurnKey('claude-turn:   ')).toBeNull();
    expect(resolveAgentTurnKey('oc-turn:\t')).toBeNull();
  });
});

describe('[#2458] correlatedPromptRequestId', () => {
  it('renames a turn key to its prompt id for the three tools that share one', () => {
    expect(correlatedPromptRequestId('claude-turn:u1')).toBe('claude-prompt:u1');
    expect(correlatedPromptRequestId('antigravity-turn:conv#4')).toBe('antigravity-prompt:conv#4');
    expect(correlatedPromptRequestId('command-code-turn:cb06ab09')).toBe(
      'command-code-prompt:cb06ab09',
    );
  });

  it('refuses codex and opencode, whose two halves carry different ids', () => {
    // codex keys the reply on `turn_id` and the prompt on the UserMessage
    // item's own id (#2197); opencode writes no `oc-prompt:` row at all. A
    // string produced here would find whatever row happened to hold that id.
    expect(correlatedPromptRequestId('codex-turn:t_1')).toBeNull();
    expect(correlatedPromptRequestId('oc-turn:msg_1')).toBeNull();
  });

  it('refuses anything that is not a turn key', () => {
    expect(correlatedPromptRequestId('req_1')).toBeNull();
    expect(correlatedPromptRequestId('claude-prompt:u1')).toBeNull();
    expect(correlatedPromptRequestId('claude-turn:')).toBeNull();
  });
});

// ===========================================================================
// The fixture column
// ===========================================================================

describe('[#2458] the six-row column from tests/fixtures/chat-turn-headers-2458', () => {
  it('is the shape the Issue describes: four replies, one question between them', () => {
    // Non-vacuity for everything below: without this, the assertions would be
    // describing a fixture that had already been split by user rows.
    const messages = turnHeaderMessages();
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
      'assistant',
      'user',
    ]);
    const keys = messages.slice(1, 5).map((m) => resolveAgentTurnKey(m.requestId));
    expect(new Set(keys).size).toBe(4);
    expect(keys.every((key) => key !== null)).toBe(true);
  });

  it('gives row 2 a role header carrying 18:18 → 18:33', () => {
    const rows = buildChatTranscriptRows(turnHeaderMessages());
    const header = headerOf(rows, '2458-row-2');
    expect(header.variant).toBe('role');
    expect(header.startedAtMs).toBe(at(18, 18).getTime());
    expect(
      messageRows(rows).find((row) => row.message.id === '2458-row-2')?.showHeader,
    ).toBe(true);
  });

  it('gives rows 3, 4 and 5 a time-only boundary and no role label', () => {
    const rows = buildChatTranscriptRows(turnHeaderMessages());
    for (const id of ['2458-row-3', '2458-row-4', '2458-row-5']) {
      const row = messageRows(rows).find((candidate) => candidate.message.id === id);
      expect(row?.header.variant, id).toBe('time');
      expect(row?.showHeader, id).toBe(false);
    }
  });

  it('never reuses 18:18 as the start of a later turn', () => {
    // The specific wrong answer: the first prompt is the only user row in the
    // column, so a builder that fell back to "the last user message" would put
    // 18:18 on all four replies.
    const rows = buildChatTranscriptRows(turnHeaderMessages());
    for (const id of ['2458-row-3', '2458-row-4', '2458-row-5']) {
      expect(headerOf(rows, id).startedAtMs, id).toBeNull();
    }
  });

  it('gives row 6 the role header back, because the operator is speaking again', () => {
    const rows = buildChatTranscriptRows(turnHeaderMessages());
    const header = headerOf(rows, '2458-row-6');
    expect(header.variant).toBe('role');
    // A prompt has no duration to report.
    expect(header.startedAtMs).toBeNull();
  });

  it('renders one row per message, keyed by message id', () => {
    const rows = buildChatTranscriptRows(turnHeaderMessages());
    expect(rows.map((row) => row.key)).toEqual([
      '2458-row-1',
      '2458-row-2',
      '2458-row-3',
      '2458-row-4',
      '2458-row-5',
      '2458-row-6',
    ]);
  });
});

// ===========================================================================
// When a boundary is drawn
// ===========================================================================

describe('[#2458] the boundary is the turn key changing, and nothing else', () => {
  const A = 'claude-turn:A';
  const B = 'claude-turn:B';

  it('draws nothing between two rows of the SAME turn', () => {
    expect(
      variants([
        assistant('a1', at(18, 33), A),
        assistant('a2', at(18, 40), A),
      ]),
    ).toEqual(['role', 'none']);
  });

  it('draws a boundary between two rows of DIFFERENT turns', () => {
    expect(
      variants([
        assistant('a1', at(18, 33), A),
        assistant('a2', at(18, 59), B),
      ]),
    ).toEqual(['role', 'time']);
  });

  it('carries the last known key across an unknown row: A → unknown → A is one turn', () => {
    expect(
      variants([
        assistant('a1', at(18, 33), A),
        assistant('scrape', at(18, 40), 'req_9'),
        assistant('a2', at(18, 45), A),
      ]),
    ).toEqual(['role', 'none', 'none']);
  });

  it('still sees the change across an unknown row: A → unknown → B is two turns', () => {
    expect(
      variants([
        assistant('a1', at(18, 33), A),
        assistant('scrape', at(18, 40), 'req_9'),
        assistant('a2', at(18, 59), B),
      ]),
    ).toEqual(['role', 'none', 'time']);
  });

  it('draws nothing at all when no row names a turn', () => {
    expect(
      variants([
        assistant('a1', at(18, 33), 'req_1'),
        assistant('a2', at(18, 40)),
        assistant('a3', at(18, 45), 'req_2'),
      ]),
    ).toEqual(['role', 'none', 'none']);
  });

  it('sees through an approval row: A → prompt → B is two turns', () => {
    const rows = buildChatTranscriptRows([
      assistant('a1', at(18, 33), A),
      approval('p1', at(18, 50)),
      assistant('a2', at(18, 59), B),
    ]);
    // #2273 lifts the chip group to the head of the turn; the boundary is
    // decided against the rows that SPEAK, so the move cannot create or
    // suppress one.
    expect(rows.map((row) => row.kind)).toEqual(['approvals', 'message', 'message']);
    expect(messageRows(rows).map((row) => row.header.variant)).toEqual(['role', 'time']);
  });

  it('does not let an approval row end a run: A → prompt → A is still one turn', () => {
    const rows = buildChatTranscriptRows([
      assistant('a1', at(18, 33), A),
      approval('p1', at(18, 50)),
      assistant('a2', at(18, 59), A),
    ]);
    expect(messageRows(rows).map((row) => row.header.variant)).toEqual(['role', 'none']);
  });

  it('resets the memory at a user row, so the reply after it wears the role label', () => {
    expect(
      variants([
        assistant('a1', at(18, 33), A),
        user('u1', at(18, 50)),
        assistant('a2', at(18, 59), A),
      ]),
    ).toEqual(['role', 'role', 'role']);
  });

  it('resets the memory when the scope changes, because two agents are not one run', () => {
    const rows = buildChatTranscriptRows([
      assistant('a1', at(18, 33), A),
      message('a2', 'assistant', at(18, 59), { requestId: B, instanceId: 'claude-2' }),
      message('a3', 'assistant', at(19, 5), { requestId: A, instanceId: 'claude-2' }),
    ]);
    // `a2` opens a run of its own rather than reading as a boundary inside
    // `a1`'s, and `a3` — whose key equals `a1`'s — is a boundary inside `a2`'s.
    expect(messageRows(rows).map((row) => row.header.variant)).toEqual([
      'role',
      'none',
      'time',
    ]);
  });

  it('keeps showHeader === (variant === "role") on every row', () => {
    // The invariant `ChatMessageBubble` relies on to keep the two props from
    // disagreeing about whether a role label is drawn.
    const lists: ChatMessage[][] = [
      turnHeaderMessages(),
      [assistant('a1', at(18, 33), A), assistant('a2', at(18, 59), B)],
      [user('u1', at(18, 18)), approval('p1', at(18, 20)), assistant('a1', at(18, 33), A)],
    ];
    for (const messages of lists) {
      for (const row of messageRows(buildChatTranscriptRows(messages))) {
        expect(row.showHeader, row.key).toBe(row.header.variant === 'role');
      }
    }
  });
});

// ===========================================================================
// The start-side clock
// ===========================================================================

describe('[#2458] the start time comes from a saved user row or from nowhere', () => {
  const TURN = 'claude-turn:u1';
  const PROMPT = 'claude-prompt:u1';

  /** The accepted shape every refusal below is derived from. */
  function pair(promptOverrides: Partial<ChatMessage> = {}): ChatMessage[] {
    return [
      message('u1', 'user', at(18, 18), { requestId: PROMPT, ...promptOverrides }),
      assistant('a1', at(18, 33), TURN),
    ];
  }

  it('accepts the correlated prompt', () => {
    expect(headerOf(buildChatTranscriptRows(pair()), 'a1').startedAtMs).toBe(
      at(18, 18).getTime(),
    );
  });

  it('accepts it for antigravity and Command Code too', () => {
    const agy = [
      message('u1', 'user', at(18, 18), {
        requestId: 'antigravity-prompt:conv#0',
        cliToolId: 'antigravity',
        instanceId: 'antigravity',
      }),
      message('a1', 'assistant', at(18, 33), {
        requestId: 'antigravity-turn:conv#0',
        cliToolId: 'antigravity',
        instanceId: 'antigravity',
      }),
    ];
    expect(headerOf(buildChatTranscriptRows(agy), 'a1').startedAtMs).toBe(at(18, 18).getTime());

    const cc = [
      message('u1', 'user', at(18, 18), {
        requestId: 'command-code-prompt:cb06ab09',
        cliToolId: 'command-code',
        instanceId: 'command-code',
      }),
      message('a1', 'assistant', at(18, 33), {
        requestId: 'command-code-turn:cb06ab09',
        cliToolId: 'command-code',
        instanceId: 'command-code',
      }),
    ];
    expect(headerOf(buildChatTranscriptRows(cc), 'a1').startedAtMs).toBe(at(18, 18).getTime());
  });

  it('refuses when no user row carries the id', () => {
    const rows = buildChatTranscriptRows(pair({ requestId: 'claude-prompt:someone-else' }));
    expect(headerOf(rows, 'a1').startedAtMs).toBeNull();
    // The boundary is still drawn: the reply is still the head of its run.
    expect(headerOf(rows, 'a1').variant).toBe('role');
  });

  it('refuses an archived user row, which belongs to a previous session', () => {
    expect(
      headerOf(buildChatTranscriptRows(pair({ archived: true })), 'a1').startedAtMs,
    ).toBeNull();
  });

  it('refuses an optimistic user row, whose clock is the browser guessing', () => {
    expect(
      headerOf(buildChatTranscriptRows(pair({ optimisticState: 'sending' })), 'a1').startedAtMs,
    ).toBeNull();
    expect(
      headerOf(buildChatTranscriptRows(pair({ optimisticState: 'error' })), 'a1').startedAtMs,
    ).toBeNull();
  });

  it('refuses a user row from another instance', () => {
    expect(
      headerOf(buildChatTranscriptRows(pair({ instanceId: 'claude-2' })), 'a1').startedAtMs,
    ).toBeNull();
  });

  it('refuses a user row from another tool', () => {
    expect(
      headerOf(buildChatTranscriptRows(pair({ cliToolId: 'codex' })), 'a1').startedAtMs,
    ).toBeNull();
  });

  it('refuses when two user rows carry the same id', () => {
    const ambiguous = [
      message('u1', 'user', at(18, 18), { requestId: PROMPT }),
      message('u1-again', 'user', at(18, 20), { requestId: PROMPT }),
      assistant('a1', at(18, 33), TURN),
    ];
    expect(headerOf(buildChatTranscriptRows(ambiguous), 'a1').startedAtMs).toBeNull();
  });

  it('refuses a user row saved AFTER the reply', () => {
    const reversed = [
      message('u1', 'user', at(19, 0), { requestId: PROMPT }),
      assistant('a1', at(18, 33), TURN),
    ];
    expect(headerOf(buildChatTranscriptRows(reversed), 'a1').startedAtMs).toBeNull();
  });

  it('refuses an unusable clock on either side', () => {
    expect(
      headerOf(
        buildChatTranscriptRows(pair({ timestamp: new Date('nonsense') })),
        'a1',
      ).startedAtMs,
    ).toBeNull();

    const badReply = [
      message('u1', 'user', at(18, 18), { requestId: PROMPT }),
      message('a1', 'assistant', new Date('nonsense'), { requestId: TURN }),
    ];
    expect(headerOf(buildChatTranscriptRows(badReply), 'a1').startedAtMs).toBeNull();
  });

  it('accepts a prompt saved in the same MINUTE as its reply', () => {
    // Refusing this would be an off-by-one in the ordering check. The header
    // collapses the identical stamps itself (`formatChatTurnTime`); the builder
    // is not the layer that decides how it reads.
    const sameMinute = [
      message('u1', 'user', at(18, 33), { requestId: PROMPT }),
      assistant('a1', at(18, 33), TURN),
    ];
    expect(headerOf(buildChatTranscriptRows(sameMinute), 'a1').startedAtMs).toBe(
      at(18, 33).getTime(),
    );
  });

  it('accepts a prompt from the previous day', () => {
    const overnight = [
      message('u1', 'user', at(23, 58, 6), { requestId: PROMPT }),
      assistant('a1', at(0, 4, 7), TURN),
    ];
    expect(headerOf(buildChatTranscriptRows(overnight), 'a1').startedAtMs).toBe(
      at(23, 58, 6).getTime(),
    );
  });

  it('does not fall back to the user row directly above the reply', () => {
    // The defect this Issue refuses to reintroduce. `u2` is the nearest user
    // row and carries an unrelated turn's prompt id, so the reply's start is
    // unknown — not 18:50.
    const nearMiss = [
      message('u1', 'user', at(18, 18), { requestId: PROMPT }),
      assistant('a0', at(18, 33), TURN),
      message('u2', 'user', at(18, 50), { requestId: 'claude-prompt:other' }),
      assistant('a1', at(18, 59), 'claude-turn:orphan'),
    ];
    const rows = buildChatTranscriptRows(nearMiss);
    expect(headerOf(rows, 'a0').startedAtMs).toBe(at(18, 18).getTime());
    expect(headerOf(rows, 'a1').startedAtMs).toBeNull();
  });

  it('gives codex a boundary and no start time', () => {
    const codex = [
      message('u1', 'user', at(18, 18), {
        requestId: 'codex-prompt:item_1',
        cliToolId: 'codex',
        instanceId: 'codex',
      }),
      message('a1', 'assistant', at(18, 33), {
        requestId: 'codex-turn:t_1',
        cliToolId: 'codex',
        instanceId: 'codex',
      }),
      message('a2', 'assistant', at(18, 59), {
        requestId: 'codex-turn:t_2',
        cliToolId: 'codex',
        instanceId: 'codex',
      }),
    ];
    const rows = buildChatTranscriptRows(codex);
    expect(headerOf(rows, 'a1').variant).toBe('role');
    expect(headerOf(rows, 'a1').startedAtMs).toBeNull();
    expect(headerOf(rows, 'a2').variant).toBe('time');
    expect(headerOf(rows, 'a2').startedAtMs).toBeNull();
  });

  it('gives opencode a boundary and no start time', () => {
    const oc = [
      message('u1', 'user', at(18, 18), {
        requestId: 'oc-prompt:msg_1',
        cliToolId: 'opencode',
        instanceId: 'opencode',
      }),
      message('a1', 'assistant', at(18, 33), {
        requestId: 'oc-turn:msg_1',
        cliToolId: 'opencode',
        instanceId: 'opencode',
      }),
      message('a2', 'assistant', at(18, 59), {
        requestId: 'oc-turn:msg_2',
        cliToolId: 'opencode',
        instanceId: 'opencode',
      }),
    ];
    const rows = buildChatTranscriptRows(oc);
    expect(headerOf(rows, 'a1').startedAtMs).toBeNull();
    expect(headerOf(rows, 'a2').variant).toBe('time');
    expect(headerOf(rows, 'a2').startedAtMs).toBeNull();
  });
});

// ===========================================================================
// What must not have moved
// ===========================================================================

describe('[#2458] the invariants this Issue rewrites the loop under', () => {
  it('[#2245] [user, prompt, prompt, assistant] still draws exactly one assistant label', () => {
    const rows = buildChatTranscriptRows([
      user('u1', at(18, 18)),
      approval('p1', at(18, 20)),
      approval('p2', at(18, 21)),
      assistant('a1', at(18, 33), 'claude-turn:A'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['message', 'approvals', 'message']);
    expect(
      messageRows(rows).filter((row) => row.showHeader && row.message.role === 'assistant').length,
    ).toBe(1);
  });

  it('[#2245] [assistant, prompt, assistant] still draws exactly one assistant label', () => {
    const rows = buildChatTranscriptRows([
      assistant('a1', at(18, 33), 'claude-turn:A'),
      approval('p1', at(18, 50)),
      assistant('a2', at(18, 59), 'claude-turn:B'),
    ]);
    expect(
      messageRows(rows).filter((row) => row.showHeader && row.message.role === 'assistant').length,
    ).toBe(1);
    // …and the second reply is a boundary rather than a second label.
    expect(headerOf(rows, 'a2').variant).toBe('time');
  });

  it('[#2273] the chip group still sits between the question and the answer', () => {
    const rows = buildChatTranscriptRows([
      user('u1', at(18, 18)),
      assistant('a1', at(18, 18), 'claude-turn:A'),
      approval('p1', at(18, 19)),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['message', 'approvals', 'message']);
  });
});
