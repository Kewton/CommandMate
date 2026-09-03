/**
 * Rebuilding an opencode reply from its parts (Issue #2041).
 *
 * The two fixtures this file reads were captured from opencode **1.18.22** in
 * the isolated `HOME` the design document's §4 describes, three turns, and they
 * are the specification here for the same reason `tests/fixtures/hooks/opencode`
 * has always been: the server's own OpenAPI is wrong about at least one frame
 * that arrives every ten seconds (#1758 D5).
 *
 *  - `history-turns-1-18-22.json` — the 142 `message.*` / `session.idle` frames
 *    from the live SSE tap, in arrival order.
 *  - `session-messages-1-18-22.json` — what `GET /session/:id/message` answered
 *    for the same session afterwards.
 *
 * That pairing is what makes the Issue's acceptance condition — "the saved body
 * equals the server's own text" — a property rather than a claim: the two
 * fixtures are two views of the same three turns, so the renderer can be run
 * over both and the results compared.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  addOpencodePart,
  buildOpencodeTurnsFromMessages,
  claimOpencodeMessage,
  createOpencodeTurn,
  ownsOpencodeMessage,
  MAX_OPENCODE_TURN_BODY_LENGTH,
  MAX_OPENCODE_TURN_PARTS,
  OPENCODE_REASONING_LABEL,
  OPENCODE_TURN_TRUNCATION_MARKER,
  readOpencodePart,
  renderOpencodeTurn,
  type OpencodeTurnAccumulator,
} from '@/lib/hooks/sources/opencode/transcript';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

interface Frame {
  type: string;
  properties: Record<string, unknown>;
}

const FRAMES: Frame[] = JSON.parse(
  readFileSync(join(FIXTURES, 'history-turns-1-18-22.json'), 'utf-8')
) as Frame[];

const MESSAGES: unknown = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-1-18-22.json'), 'utf-8')
);

const SESSION = 'ses_0000000000000000000000000';

/**
 * Replay the captured stream exactly as `./history` does.
 *
 * Kept in this file rather than imported so the test states the reading rule
 * itself: `message.updated(assistant)` opens a turn keyed on `parentID`,
 * `message.part.updated` fills a slot, and `message.part.delta` — 95 of the 142
 * frames — is read by nothing.
 */
function replay(frames: readonly Frame[]): Map<string, OpencodeTurnAccumulator> {
  const open = new Map<string, OpencodeTurnAccumulator>();
  const done = new Map<string, OpencodeTurnAccumulator>();

  for (const frame of frames) {
    const sessionId = frame.properties.sessionID as string;
    if (frame.type === 'message.updated') {
      const info = frame.properties.info as Record<string, unknown> | undefined;
      if (!info || info.role !== 'assistant') continue;
      const parent = info.parentID as string | undefined;
      if (!parent) continue;
      const existing = open.get(sessionId);
      const turn =
        existing?.userMessageId === parent ? existing : createOpencodeTurn(sessionId, parent, 0);
      if (turn !== existing) open.set(sessionId, turn);
      claimOpencodeMessage(turn, info.id as string);
      continue;
    }
    if (frame.type === 'message.part.updated') {
      const part = readOpencodePart(frame.properties.part);
      const turn = open.get(sessionId);
      // The ownership check the writer applies: a part may only join a turn that
      // has claimed its message. Without it the operator's own prompt — which
      // travels on this same stream as a text part — could join the reply.
      if (part && turn && ownsOpencodeMessage(turn, part.messageId)) addOpencodePart(turn, part);
      continue;
    }
    if (frame.type === 'session.idle') {
      const turn = open.get(sessionId);
      if (turn) {
        done.set(turn.userMessageId, turn);
        open.delete(sessionId);
      }
    }
  }
  return done;
}

/** The assistant text `GET /session/:id/message` reports for one turn. */
function serverTextFor(userMessageId: string): string[] {
  const out: string[] = [];
  for (const entry of MESSAGES as Record<string, unknown>[]) {
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

describe('replaying the captured 1.18.22 stream', () => {
  it('produces exactly the three turns the session ran', () => {
    const turns = replay(FRAMES);
    expect([...turns.keys()]).toEqual([
      'msg_user0000000000000000001',
      'msg_user0000000000000000002',
      'msg_user0000000000000000003',
    ]);
  });

  it('keeps the whole Markdown of a turn that used no tools', () => {
    const turn = replay(FRAMES).get('msg_user0000000000000000001');
    // Verbatim, newlines and all. The pane this arrived on was 200 columns and
    // the TUI drew it with a `┃ ` gutter; none of that is here.
    expect(renderOpencodeTurn(turn!).body).toBe(
      '## Heading A\n\n- item one\n- item two\n\n**bold** and `code`'
    );
  });

  it('keeps a 967-character single-line paragraph on one line', () => {
    // The acceptance condition's "200 桁超の段落". The scraper's copy of this is
    // hard-wrapped at the pane width, so no cleaner can recover the original
    // line structure; the server's copy never lost it.
    const turn = replay(FRAMES).get('msg_user0000000000000000003');
    const body = renderOpencodeTurn(turn!).body;
    expect(body.split('\n')).toHaveLength(1);
    expect(body.length).toBeGreaterThan(900);
  });

  it('folds a tool call into one summary line and keeps the sentence about it', () => {
    // Measured: this ONE turn produced TWO assistant messages — `finish:
    // "tool-calls"` for the `bash` call and `finish: "stop"` for the sentence —
    // and they are one reply because they share a `parentID`.
    //
    // Issue #2234: the sentence now LEADS and the call is in the section at the
    // end. This is real 1.18.22 data and it is the shape the Issue is about —
    // before the change this body opened with `- \`bash\` — echo …`.
    const turn = replay(FRAMES).get('msg_user0000000000000000002');
    expect(renderOpencodeTurn(turn!).body).toBe(
      [
        'It printed `CMATE-2041-TOOL-MARKER`.',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `bash` — echo CMATE-2041-TOOL-MARKER',
      ].join('\n')
    );
  });

  it('reads the reply out of message.part.updated alone, never the deltas', () => {
    // 95 of the 142 captured frames are `message.part.delta`. Dropping every one
    // of them must change nothing, because the closing `message.part.updated`
    // carries the complete part text — which is what makes a re-sent boundary
    // frame harmless without a dedup set.
    const withoutDeltas = FRAMES.filter((frame) => frame.type !== 'message.part.delta');
    const full = replay(FRAMES);
    const trimmed = replay(withoutDeltas);
    for (const [key, turn] of full) {
      expect(renderOpencodeTurn(trimmed.get(key)!).body).toBe(renderOpencodeTurn(turn).body);
    }
  });
});

describe('the operator’s own prompt', () => {
  it('never joins the reply that answers it', () => {
    // Measured: the user's text part arrives BEFORE the assistant
    // `message.updated` opens the turn, so it lands on no accumulator. The
    // ownership check makes that outcome a property of the data rather than of
    // the ordering — this is the same three turns with the user parts moved to
    // the very end, which is the order that would break a timing-dependent
    // reader.
    const userParts = FRAMES.filter(
      (frame) =>
        frame.type === 'message.part.updated' &&
        String(
          (frame.properties.part as Record<string, unknown>).messageID
        ).startsWith('msg_user')
    );
    expect(userParts.length).toBe(3); // non-vacuity: the prompts really are on the stream

    const reordered = [
      ...FRAMES.filter((frame) => !userParts.includes(frame)).filter(
        (frame) => frame.type !== 'session.idle'
      ),
      ...userParts,
      ...FRAMES.filter((frame) => frame.type === 'session.idle'),
    ];
    for (const turn of replay(reordered).values()) {
      expect(renderOpencodeTurn(turn).body).not.toContain('Do not use any tools.');
      expect(renderOpencodeTurn(turn).body).not.toContain('Run the bash command');
    }
  });

  it('is refused even when it names the turn’s own session', () => {
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    claimOpencodeMessage(turn, 'msg_assistant1');
    expect(ownsOpencodeMessage(turn, 'msg_user1')).toBe(false);
    expect(ownsOpencodeMessage(turn, 'msg_assistant1')).toBe(true);
  });
});

describe('the saved body against GET /session/:id/message', () => {
  it.each([
    'msg_user0000000000000000001',
    'msg_user0000000000000000002',
    'msg_user0000000000000000003',
  ])('%s contains the server text verbatim', (userMessageId) => {
    const body = renderOpencodeTurn(replay(FRAMES).get(userMessageId)!).body;
    const texts = serverTextFor(userMessageId);
    // Asserted first, and not decoration: a `serverTextFor` that answered `[]`
    // would make the loop below pass without comparing anything at all.
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join('').length).toBeGreaterThan(30);
    for (const text of texts) {
      expect(body).toContain(text);
    }
  });

  it('rebuilds the same three bodies from the REST document alone', () => {
    // The restart path: a fresh subscription to `/event` replays nothing, so a
    // turn that ran while CommandMate was down exists only here. The two routes
    // must agree, or a backfill would write a second, differently-worded copy of
    // a turn the stream already saved.
    const fromStream = replay(FRAMES);
    const fromRest = buildOpencodeTurnsFromMessages(MESSAGES, SESSION);

    expect(fromRest).toHaveLength(3);
    for (const turn of fromRest) {
      const streamed = fromStream.get(turn.userMessageId);
      expect(streamed, turn.userMessageId).toBeDefined();
      expect(renderOpencodeTurn(turn).body).toBe(renderOpencodeTurn(streamed!).body);
    }
  });

  it('dates each rebuilt turn by the agent’s own clock', () => {
    const turns = buildOpencodeTurnsFromMessages(MESSAGES, SESSION);
    const times = turns.map((turn) => turn.startedAt);
    expect(times.every((value) => value > 0)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('idempotency', () => {
  it('is unchanged by the whole stream arriving twice', () => {
    // The `#1763 / #1899` case the Issue names: a reconnect re-delivers frames,
    // byte for byte. Last-write-wins on the part id makes the repeat a no-op by
    // construction rather than by a remembered set that could be evicted.
    const once = renderOpencodeTurn(replay(FRAMES).get('msg_user0000000000000000002')!);
    const twice = renderOpencodeTurn(replay([...FRAMES, ...FRAMES]).get('msg_user0000000000000000002')!);
    expect(twice.body).toBe(once.body);
    expect(twice.toolParts).toBe(once.toolParts);
    expect(twice.textParts).toBe(once.textParts);
  });

  it('is unchanged by one part frame being re-sent on its own', () => {
    const repeated = FRAMES.flatMap((frame) =>
      frame.type === 'message.part.updated' ? [frame, frame, frame] : [frame]
    );
    expect(renderOpencodeTurn(replay(repeated).get('msg_user0000000000000000001')!).body).toBe(
      '## Heading A\n\n- item one\n- item two\n\n**bold** and `code`'
    );
  });

  it('lets the closing frame replace the empty one that opened the part', () => {
    // Measured: a text part is announced with `text: ""` and closed with the
    // whole body. If the first write won, every reply would be empty.
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    addOpencodePart(turn, {
      id: 'prt_1',
      messageId: 'msg_a',
      type: 'text',
      text: '',
      tool: null,
      status: null,
      title: null,
      error: null,
    });
    addOpencodePart(turn, {
      id: 'prt_1',
      messageId: 'msg_a',
      type: 'text',
      text: 'the answer',
      tool: null,
      status: null,
      title: null,
      error: null,
    });
    expect(renderOpencodeTurn(turn).body).toBe('the answer');
    expect(turn.parts.size).toBe(1);
  });
});

describe('the parts that are not prose', () => {
  function turnWith(...parts: Record<string, unknown>[]): OpencodeTurnAccumulator {
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    for (const raw of parts) {
      const part = readOpencodePart({ messageID: 'msg_a', ...raw });
      if (part) addOpencodePart(turn, part);
    }
    return turn;
  }

  it('folds reasoning behind a blockquote instead of a raw-HTML details', () => {
    // [#2272] The quote is still a quote and still labelled `Thinking` — what
    // changed is that it sits BEHIND the answer and carries its own count, so
    // the bubble opens with the reply rather than with the deliberation.
    const rendered = renderOpencodeTurn(
      turnWith(
        { id: 'p1', type: 'reasoning', text: 'first\n\nsecond' },
        { id: 'p2', type: 'text', text: 'The answer.' }
      )
    );
    expect(rendered.body).toBe(
      `The answer.\n\n> **${OPENCODE_REASONING_LABEL} (1)**\n>\n> first\n>\n> second`
    );
    expect(rendered.reasoningParts).toBe(1);
  });

  it('puts every reasoning block under ONE heading, in the order it was thought', () => {
    // [#2272] The shape the Issue reports: opencode emits a `reasoning` part in
    // front of every text part, so a long reply carried four separate
    // `> **Thinking**` quotes interleaved through the prose.
    const rendered = renderOpencodeTurn(
      turnWith(
        { id: 'p1', type: 'reasoning', text: 'weigh it' },
        { id: 'p2', type: 'text', text: 'First paragraph.' },
        { id: 'p3', type: 'reasoning', text: 'weigh it again' },
        { id: 'p4', type: 'text', text: 'Second paragraph.' }
      )
    );
    expect(rendered.body).toBe(
      [
        'First paragraph.',
        '',
        'Second paragraph.',
        '',
        `> **${OPENCODE_REASONING_LABEL} (2)**`,
        '>',
        '> weigh it',
        '>',
        '> weigh it again',
      ].join('\n')
    );
    expect(rendered.reasoningParts).toBe(2);
    expect(rendered.textParts).toBe(2);
  });

  it('keeps the reasoning in front of the tool log', () => {
    // [#2272] Two folded sections, and the tool log stays last: #2234 put it
    // there and History's rows are matched on `request_id`, never rewritten.
    const rendered = renderOpencodeTurn(
      turnWith(
        { id: 'p1', type: 'reasoning', text: 'plan the patch' },
        { id: 'p2', type: 'text', text: 'Wrote the file.' },
        {
          id: 'p3',
          type: 'tool',
          tool: 'apply_patch',
          state: { status: 'completed', title: 'probe.txt' },
        }
      )
    );
    expect(rendered.body).toBe(
      [
        'Wrote the file.',
        '',
        `> **${OPENCODE_REASONING_LABEL} (1)**`,
        '>',
        '> plan the patch',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `apply_patch` — probe.txt',
      ].join('\n')
    );
  });

  it('says nothing at all when the turn only reasoned', () => {
    // A section on its own is still a section: there is no prose to lead with,
    // so the heading is the first line and the count is still there.
    const rendered = renderOpencodeTurn(turnWith({ id: 'p1', type: 'reasoning', text: 'hmm' }));
    expect(rendered.body).toBe(`> **${OPENCODE_REASONING_LABEL} (1)**\n>\n> hmm`);
    expect(rendered.textParts).toBe(0);
  });

  it('says nothing at all about step-start / step-finish / snapshot / patch', () => {
    const rendered = renderOpencodeTurn(
      turnWith(
        { id: 'p1', type: 'step-start', snapshot: 'abc' },
        { id: 'p2', type: 'text', text: 'Done.' },
        { id: 'p3', type: 'step-finish', reason: 'stop' },
        { id: 'p4', type: 'snapshot' },
        { id: 'p5', type: 'patch', hash: 'deadbeef' }
      )
    );
    expect(rendered.body).toBe('Done.');
    // Silent, not unknown: they are on the deny list, so they do not raise the
    // "this opencode has a part we have no words for" signal.
    expect(rendered.unknownPartTypes).toEqual([]);
  });

  it('counts a part variant it has no words for rather than guessing', () => {
    // C8's rule applied to parts. `subtask` is real — 1.18.22's own `GET /doc`
    // declares it — and this reader has never seen one arrive.
    const rendered = renderOpencodeTurn(
      turnWith({ id: 'p1', type: 'subtask', agent: 'general' }, { id: 'p2', type: 'text', text: 'x' })
    );
    expect(rendered.unknownPartTypes).toEqual(['subtask']);
  });

  it('keeps a pending tool call out and lets the settled one speak', () => {
    const rendered = renderOpencodeTurn(
      turnWith({
        id: 'p1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'pending', title: 'ls -l' },
      })
    );
    expect(rendered.body).toBe('');
    expect(rendered.toolParts).toBe(0);
  });

  it('marks a failed tool call and quotes what failed', () => {
    const rendered = renderOpencodeTurn(
      turnWith({
        id: 'p1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', title: 'rm -rf /', error: 'rejected by the operator' },
      })
    );
    expect(rendered.body).toBe(
      `> **${TURN_TOOL_LOG_LABEL} (1)**\n>\n> - \`bash\` — rm -rf / _(error: rejected by the operator)_`
    );
  });

  it('flattens a multi-line tool title so it stays one list item', () => {
    // A `bash` title is the command, and a heredoc puts newlines in it. Left
    // alone the rest of the command would break out of the list.
    const rendered = renderOpencodeTurn(
      turnWith({
        id: 'p1',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', title: "cat <<'EOF'\nhello\nEOF" },
      })
    );
    expect(rendered.body).toBe(
      `> **${TURN_TOOL_LOG_LABEL} (1)**\n>\n> - \`bash\` — cat <<'EOF' hello EOF`
    );
  });

  it('runs consecutive tool calls together as one Markdown list', () => {
    const rendered = renderOpencodeTurn(
      turnWith(
        { id: 'p1', type: 'tool', tool: 'read', state: { status: 'completed', title: 'a.ts' } },
        { id: 'p2', type: 'tool', tool: 'read', state: { status: 'completed', title: 'b.ts' } },
        { id: 'p3', type: 'text', text: 'Both files look fine.' }
      )
    );
    // Issue #2234: one list still, in call order, but behind the prose.
    expect(rendered.body).toBe(
      [
        'Both files look fine.',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (2)**`,
        '>',
        '> - `read` — a.ts',
        '> - `read` — b.ts',
      ].join('\n')
    );
  });
});

describe('bounds', () => {
  it('drops parts past the cap and says so', () => {
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    for (let i = 0; i < MAX_OPENCODE_TURN_PARTS + 5; i += 1) {
      addOpencodePart(turn, {
        id: `prt_${i}`,
        messageId: 'msg_a',
        type: 'text',
        text: `x${i}`,
        tool: null,
        status: null,
        title: null,
        error: null,
      });
    }
    expect(turn.parts.size).toBe(MAX_OPENCODE_TURN_PARTS);
    expect(turn.overflowed).toBe(true);
  });

  it('still overwrites a known part once the cap is reached', () => {
    // The cap bounds distinct parts, not writes. A turn at the limit whose last
    // text part then closes must still receive its text.
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    for (let i = 0; i < MAX_OPENCODE_TURN_PARTS; i += 1) {
      addOpencodePart(turn, {
        id: `prt_${i}`,
        messageId: 'msg_a',
        type: 'step-start',
        text: null,
        tool: null,
        status: null,
        title: null,
        error: null,
      });
    }
    expect(
      addOpencodePart(turn, {
        id: 'prt_0',
        messageId: 'msg_a',
        type: 'text',
        text: 'the answer',
        tool: null,
        status: null,
        title: null,
        error: null,
      })
    ).toBe(true);
    expect(renderOpencodeTurn(turn).body).toBe('the answer');
  });

  it('truncates a body past the cap and marks it', () => {
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    addOpencodePart(turn, {
      id: 'prt_1',
      messageId: 'msg_a',
      type: 'text',
      text: 'x'.repeat(MAX_OPENCODE_TURN_BODY_LENGTH + 1_000),
      tool: null,
      status: null,
      title: null,
      error: null,
    });
    const body = renderOpencodeTurn(turn).body;
    expect(body).toHaveLength(MAX_OPENCODE_TURN_BODY_LENGTH);
    expect(body.endsWith(OPENCODE_TURN_TRUNCATION_MARKER)).toBe(true);
  });

  it('spends the cap on the answer before it spends it on the reasoning', () => {
    // [#2272] The cap still counts the whole body — that did not change. What
    // changed is what falls off the end: the reasoning now sits behind the
    // prose, so an over-long turn loses the tail of its thinking and keeps the
    // reply. Before this Issue the same turn kept the deliberation and cut the
    // answer off mid-sentence.
    const turn = createOpencodeTurn(SESSION, 'msg_user1', 0);
    const part = (id: string, type: string, text: string) =>
      addOpencodePart(turn, {
        id,
        messageId: 'msg_a',
        type,
        text,
        tool: null,
        status: null,
        title: null,
        error: null,
      });
    part('prt_1', 'reasoning', 'r'.repeat(MAX_OPENCODE_TURN_BODY_LENGTH));
    part('prt_2', 'text', 'THE ANSWER SURVIVES.');

    const body = renderOpencodeTurn(turn).body;
    expect(body).toHaveLength(MAX_OPENCODE_TURN_BODY_LENGTH);
    expect(body.startsWith('THE ANSWER SURVIVES.\n\n')).toBe(true);
    expect(body.endsWith(OPENCODE_TURN_TRUNCATION_MARKER)).toBe(true);
    // The marker lands inside the reasoning quote, which is the half that was
    // over budget — not in the middle of the sentence the operator asked for.
    expect(body).toContain(`> **${OPENCODE_REASONING_LABEL} (1)**`);
  });
});

describe('readOpencodePart', () => {
  it('refuses a part with no id or no messageID', () => {
    expect(readOpencodePart({ type: 'text', text: 'x', messageID: 'msg_a' })).toBeNull();
    expect(readOpencodePart({ type: 'text', text: 'x', id: 'prt_1' })).toBeNull();
    expect(readOpencodePart(null)).toBeNull();
    expect(readOpencodePart('text')).toBeNull();
  });

  it('reads a nested error message as well as a bare string', () => {
    const nested = readOpencodePart({
      id: 'prt_1',
      messageID: 'msg_a',
      type: 'tool',
      tool: 'bash',
      state: { status: 'error', error: { message: 'boom' } },
    });
    expect(nested?.error).toBe('boom');
  });
});

describe('buildOpencodeTurnsFromMessages', () => {
  it('skips a message with no parentID rather than inventing a turn key', () => {
    // A row written under an invented key can never be matched again, so the
    // next backfill would write it a second time.
    expect(
      buildOpencodeTurnsFromMessages(
        [{ info: { id: 'msg_a', role: 'assistant' }, parts: [{ id: 'p', messageID: 'msg_a', type: 'text', text: 'hi' }] }],
        SESSION
      )
    ).toEqual([]);
  });

  it('ignores the user’s own messages', () => {
    const turns = buildOpencodeTurnsFromMessages(MESSAGES, SESSION);
    expect(turns.map((turn) => turn.userMessageId)).toEqual([
      'msg_user0000000000000000001',
      'msg_user0000000000000000002',
      'msg_user0000000000000000003',
    ]);
  });

  it('answers empty for a body that is not an array', () => {
    expect(buildOpencodeTurnsFromMessages(null, SESSION)).toEqual([]);
    expect(buildOpencodeTurnsFromMessages({ error: 'nope' }, SESSION)).toEqual([]);
  });
});
