/**
 * Reading Claude Code's transcript JSONL (Issue #2121).
 *
 * The pure half. `tests/integration/claude-history-2121.test.ts` pins what
 * reaches `chat_messages`; this file pins the two things that decide whether
 * that row is right at all:
 *
 *  - **the operator's prompt never becomes the agent's reply.** The Issue
 *    measured a saved `assistant` row of 13,253 characters against a transcript
 *    of 3,669, the difference being the prompt the pane echoed back. Here that
 *    is a property of the grouping rather than of a cleaner, so it is asserted
 *    directly on a transcript that contains a prompt long enough to be
 *    unmistakable if it leaked.
 *  - **one turn is one row.** The Issue counted 98 assistant records against the
 *    single row the poller wrote; a naive reader would have produced 98.
 *
 * The record shapes are transcribed from live transcripts under
 * `~/.claude/projects` on 2026-08-31 — including the four kinds of `type: "user"`
 * record that are not prompts, which is the part a fixture invented from the
 * Issue text would have missed.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  buildClaudeTurns,
  claudeProjectSlug,
  CLAUDE_THINKING_LABEL,
  CLAUDE_TURN_TRUNCATION_MARKER,
  isClaudePromptRecord,
  MAX_CLAUDE_TURN_BODY_LENGTH,
  parseClaudeTranscript,
  readClaudeTranscriptRecord,
  renderClaudeTurn,
  type ClaudeTranscriptRecord,
} from '@/lib/hooks/sources/claude/transcript';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const SESSION = '0572eeb1-f7f8-4b39-8be5-e71ef93958ef';

/** One transcript line, in the shape Claude writes. */
function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function userRecord(
  uuid: string,
  content: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    uuid,
    sessionId: SESSION,
    cwd: '/repos/wt',
    gitBranch: 'feature/2121',
    timestamp: '2026-08-31T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  };
}

function assistantRecord(
  uuid: string,
  content: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid,
    requestId: 'req_011CeaxJfj4kTpNVS8UshdHT',
    sessionId: SESSION,
    cwd: '/repos/wt',
    timestamp: '2026-08-31T10:00:01.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content },
    ...extra,
  };
}

const PROMPT_TEXT =
  'Issue #2121 を実装する。転写ファイルから会話履歴を読み、markdown ソースとして保存すること。';

/** The six text blocks the Issue measured, plus the tool calls between them. */
const REPLY_BLOCKS = [
  "I'll start by reading the Issue and the opencode template implementation.",
  'Now implementing the transcript reader.',
  'The grouping is keyed on the prompt record.',
  'Wiring the poller so the two writers cannot both run.',
  'All gates are green.',
  'Issue #2121 は着地しました。',
] as const;

function transcriptText(): string {
  const lines: string[] = [
    line(userRecord('u-1', PROMPT_TEXT)),
    line(assistantRecord('a-1', [{ type: 'text', text: REPLY_BLOCKS[0] }])),
    line(
      assistantRecord('a-2', [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'gh issue view 2121', description: 'Read issue 2121' },
        },
      ])
    ),
    // A tool result. `type: "user"`, and not a prompt.
    line(
      userRecord('u-tool-1', [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'title: feat(history)…' },
      ])
    ),
    line(assistantRecord('a-3', [{ type: 'text', text: REPLY_BLOCKS[1] }])),
    line(assistantRecord('a-4', [{ type: 'thinking', thinking: '', signature: 'CAISoQ…' }])),
    line(assistantRecord('a-5', [{ type: 'text', text: REPLY_BLOCKS[2] }])),
    line(
      assistantRecord('a-6', [
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/repos/wt/src/a.ts' } },
      ])
    ),
    line(assistantRecord('a-7', [{ type: 'text', text: REPLY_BLOCKS[3] }])),
    line(assistantRecord('a-8', [{ type: 'text', text: REPLY_BLOCKS[4] }])),
    line(assistantRecord('a-9', [{ type: 'text', text: REPLY_BLOCKS[5] }])),
  ];
  return `${lines.join('\n')}\n`;
}

function onlyTurn(text: string) {
  const parsed = parseClaudeTranscript(text);
  const built = buildClaudeTurns(parsed.records, SESSION);
  expect(built.turns).toHaveLength(1);
  return { parsed, built, turn: built.turns[0] };
}

describe('claudeProjectSlug', () => {
  it('replaces every non-alphanumeric byte, which is what Claude does', () => {
    // Verified exhaustively on 2026-08-31: applied to the `cwd` recorded inside
    // a transcript in each of the 512 project directories on the machine that
    // had one, this rule reproduced the directory name 512 times out of 512.
    expect(claudeProjectSlug('/Users/me/share/work/github_kewton/commandmate-issue-2121')).toBe(
      '-Users-me-share-work-github-kewton-commandmate-issue-2121'
    );
  });

  it('turns a hidden directory into a double hyphen, as observed', () => {
    expect(claudeProjectSlug('/Users/me/.cm-uat-0803/root/uatrepo-a')).toBe(
      '-Users-me--cm-uat-0803-root-uatrepo-a'
    );
  });

  it('preserves case', () => {
    expect(claudeProjectSlug('/repos/BorderFreeKidsMap')).toBe('-repos-BorderFreeKidsMap');
  });
});

describe('parseClaudeTranscript', () => {
  it('reads every well-formed line', () => {
    const parsed = parseClaudeTranscript(transcriptText());
    expect(parsed.records).toHaveLength(11);
    expect(parsed.malformedLines).toBe(0);
  });

  it('drops a line truncated mid-write and keeps the rest', () => {
    // The live-append case the Issue lists as unmeasured. Claude appends while
    // CommandMate reads, so a read can land inside the newest line; the cost has
    // to be that one record, never the file.
    const whole = transcriptText().trimEnd();
    const damaged = `${whole}\n${line(assistantRecord('a-10', [{ type: 'text', text: 'half' }])).slice(0, 60)}`;

    const parsed = parseClaudeTranscript(damaged);
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.records).toHaveLength(11);
    expect(renderClaudeTurn(buildClaudeTurns(parsed.records, SESSION).turns[0]).body).toContain(
      REPLY_BLOCKS[5]
    );
  });

  it('counts a line that parses but is not a record', () => {
    const parsed = parseClaudeTranscript('[1,2,3]\n"a string"\n{"no":"type"}\n');
    expect(parsed.records).toHaveLength(0);
    expect(parsed.malformedLines).toBe(3);
  });

  it('ignores blank lines rather than counting them as damage', () => {
    const parsed = parseClaudeTranscript(`\n\n${line(userRecord('u-1', 'hi'))}\n\n`);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records).toHaveLength(1);
  });
});

describe('isClaudePromptRecord', () => {
  function record(raw: Record<string, unknown>): ClaudeTranscriptRecord {
    const parsed = readClaudeTranscriptRecord(raw);
    expect(parsed).not.toBeNull();
    return parsed as ClaudeTranscriptRecord;
  }

  it('accepts the operator’s own text', () => {
    expect(isClaudePromptRecord(record(userRecord('u-1', PROMPT_TEXT)))).toBe(true);
  });

  it('rejects a tool result, which is 18 of every 19 user records measured', () => {
    expect(
      isClaudePromptRecord(
        record(userRecord('u-2', [{ type: 'tool_result', tool_use_id: 't', content: 'out' }]))
      )
    ).toBe(false);
  });

  it('rejects a tool result even when a text block rides along with it', () => {
    // The bare shape above is already rejected for having no text at all, so it
    // cannot tell whether the `tool_result` rule is doing anything. This one
    // can: remove that rule and this record becomes a prompt, and every
    // assistant record after it is filed under a turn the operator never typed.
    expect(
      isClaudePromptRecord(
        record(
          userRecord('u-2b', [
            { type: 'tool_result', tool_use_id: 't', content: 'out' },
            { type: 'text', text: 'and here is the rest of the output' },
          ])
        )
      )
    ).toBe(false);
  });

  it('rejects an isMeta placeholder', () => {
    expect(
      isClaudePromptRecord(
        record(
          userRecord('u-3', '[Image: original 1440x2170, displayed at 1327x2000.]', { isMeta: true })
        )
      )
    ).toBe(false);
  });

  it.each([
    '<local-command-caveat>Caveat: The messages below were generated…</local-command-caveat>',
    '<command-name>/model</command-name>\n<command-message>model</command-message>',
    '<local-command-stdout>Set model to Fable 5</local-command-stdout>',
  ])('rejects slash-command bookkeeping: %s', (text) => {
    expect(isClaudePromptRecord(record(userRecord('u-4', text)))).toBe(false);
  });

  it('rejects an empty record, which cannot name a turn usefully', () => {
    expect(isClaudePromptRecord(record(userRecord('u-5', '   ')))).toBe(false);
  });

  it('rejects an assistant record however its content reads', () => {
    expect(
      isClaudePromptRecord(record(assistantRecord('a-1', [{ type: 'text', text: 'hello' }])))
    ).toBe(false);
  });
});

describe('buildClaudeTurns', () => {
  it('folds every assistant record of one prompt into one turn', () => {
    // The 98:1 ratio the Issue measured, at fixture scale: nine assistant
    // records, one turn. A reader keyed on `requestId` or on the record `uuid`
    // would answer nine here.
    const { turn } = onlyTurn(transcriptText());
    expect(turn.assistantRecords).toBe(9);
    expect(turn.promptUuid).toBe('u-1');
  });

  it('opens a second turn at the next prompt', () => {
    const text = [
      transcriptText().trimEnd(),
      line(userRecord('u-2', 'follow-up question')),
      line(assistantRecord('b-1', [{ type: 'text', text: 'follow-up answer' }])),
    ].join('\n');

    const built = buildClaudeTurns(parseClaudeTranscript(text).records, SESSION);
    expect(built.turns.map((t) => t.promptUuid)).toEqual(['u-1', 'u-2']);
    expect(renderClaudeTurn(built.turns[1]).body).toBe('follow-up answer');
    // And the first turn is not retroactively given the second one's reply.
    expect(renderClaudeTurn(built.turns[0]).body).not.toContain('follow-up answer');
  });

  it('does not let a tool result split a turn', () => {
    const { built } = onlyTurn(transcriptText());
    expect(built.turns).toHaveLength(1);
  });

  it('skips a sub-agent’s records rather than folding them into the reply', () => {
    const text = [
      transcriptText().trimEnd(),
      line(assistantRecord('s-1', [{ type: 'text', text: 'SIDECHAIN NARRATION' }], { isSidechain: true })),
    ].join('\n');

    const built = buildClaudeTurns(parseClaudeTranscript(text).records, SESSION);
    expect(built.sidechainRecords).toBe(1);
    expect(renderClaudeTurn(built.turns[0]).body).not.toContain('SIDECHAIN NARRATION');
  });

  it('counts assistant records that arrive before any prompt instead of inventing a turn', () => {
    // What a tail read that did not reach back to the prompt looks like. An
    // invented turn key would produce a row no later run could recognise as
    // already written, so the records are dropped and reported.
    const text = [
      line(assistantRecord('a-x', [{ type: 'text', text: 'headless' }])),
      line(userRecord('u-1', PROMPT_TEXT)),
      line(assistantRecord('a-1', [{ type: 'text', text: 'answer' }])),
    ].join('\n');

    const built = buildClaudeTurns(parseClaudeTranscript(text).records, SESSION);
    expect(built.orphanedAssistantRecords).toBe(1);
    expect(built.turns).toHaveLength(1);
    expect(renderClaudeTurn(built.turns[0]).body).toBe('answer');
  });

  it('dates the turn by the prompt record’s own clock', () => {
    const { turn } = onlyTurn(transcriptText());
    expect(turn.startedAt).toBe(Date.parse('2026-08-31T10:00:00.000Z'));
  });
});

describe('renderClaudeTurn', () => {
  it('reproduces every text block, in transcript order', () => {
    const { turn } = onlyTurn(transcriptText());
    const body = renderClaudeTurn(turn).body;

    for (const block of REPLY_BLOCKS) expect(body).toContain(block);
    // Order, not just presence: the last block is the answer and must be last.
    expect(body.indexOf(REPLY_BLOCKS[0])).toBeLessThan(body.indexOf(REPLY_BLOCKS[5]));
  });

  it('keeps the operator’s prompt out of the reply — the #2121 regression', () => {
    // The defect this Issue exists for. The scraped row began with the
    // operator's own words because the pane echoes them; here the prompt is on a
    // record the renderer never reads.
    const body = renderClaudeTurn(onlyTurn(transcriptText()).turn).body;
    expect(body).not.toContain(PROMPT_TEXT);
    expect(body).not.toContain('Issue #2121 を実装する');
  });

  it('keeps tool output out of the reply too', () => {
    const body = renderClaudeTurn(onlyTurn(transcriptText()).turn).body;
    expect(body).not.toContain('title: feat(history)');
  });

  it('separates the blocks so narration and answer are not one paragraph', () => {
    // The Issue's second requirement: a naive join produces "…reading the design
    // doc...Now implementing...着地しました。" as one run-on line.
    const body = renderClaudeTurn(onlyTurn(transcriptText()).turn).body;
    expect(body).toContain(`${REPLY_BLOCKS[4]}\n\n${REPLY_BLOCKS[5]}`);
    expect(body).not.toContain(`${REPLY_BLOCKS[4]}${REPLY_BLOCKS[5]}`);
  });

  it('summarises a tool call on one Markdown line', () => {
    const body = renderClaudeTurn(onlyTurn(transcriptText()).turn).body;
    expect(body).toContain('- `Bash` — gh issue view 2121');
    expect(body).toContain('- `Read` — /repos/wt/src/a.ts');
  });

  it('collapses a multi-line command so it stays one list item', () => {
    const text = [
      line(userRecord('u-1', 'run it')),
      line(
        assistantRecord('a-1', [
          {
            type: 'tool_use',
            id: 't',
            name: 'Bash',
            input: { command: 'cat <<EOF\nline one\nline two\nEOF' },
          },
        ])
      ),
    ].join('\n');
    expect(renderClaudeTurn(onlyTurn(text).turn).body).toBe(
      `> **${TURN_TOOL_LOG_LABEL} (1)**\n>\n> - \`Bash\` — cat <<EOF line one line two EOF`
    );
  });

  it('joins consecutive tool lines into one list inside the folded section', () => {
    const text = [
      line(userRecord('u-1', 'go')),
      line(assistantRecord('a-1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }])),
      line(assistantRecord('a-2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } }])),
    ].join('\n');
    // Issue #2234: still one Markdown list, still in call order — inside the
    // quote now, because a turn that only ran tools is all tool log.
    expect(renderClaudeTurn(onlyTurn(text).turn).body).toBe(
      `> **${TURN_TOOL_LOG_LABEL} (2)**\n>\n> - \`Bash\` — ls\n> - \`Bash\` — pwd`
    );
  });

  it('folds thinking behind a quote', () => {
    const text = [
      line(userRecord('u-1', 'go')),
      line(assistantRecord('a-1', [{ type: 'thinking', thinking: 'weigh the options', signature: 's' }])),
    ].join('\n');
    expect(renderClaudeTurn(onlyTurn(text).turn).body).toBe(
      `> **${CLAUDE_THINKING_LABEL}**\n>\n> weigh the options`
    );
  });

  it('skips an empty thinking block rather than drawing a blank quote', () => {
    // Measured: the block arrives with its `signature` and `thinking: ""` when
    // the text is not retained.
    const body = renderClaudeTurn(onlyTurn(transcriptText()).turn).body;
    expect(body).not.toContain(`**${CLAUDE_THINKING_LABEL}**`);
  });

  it('counts a block type it has no words for instead of guessing', () => {
    const text = [
      line(userRecord('u-1', 'go')),
      line(assistantRecord('a-1', [{ type: 'server_tool_use', id: 'x', name: 'web_search' }])),
    ].join('\n');
    const rendered = renderClaudeTurn(onlyTurn(text).turn);
    expect(rendered.unknownBlockTypes).toEqual(['server_tool_use']);
    expect(rendered.body).toBe('');
  });

  it('reports an empty body for a turn the agent has not answered yet', () => {
    // The prompt record is written before the first assistant record, so this is
    // the ordinary state of the newest turn for a moment. `./history` reads it
    // as "fall back to the scraper".
    const rendered = renderClaudeTurn(onlyTurn(line(userRecord('u-1', PROMPT_TEXT))).turn);
    expect(rendered.body).toBe('');
    expect(rendered.textBlocks).toBe(0);
  });

  it('truncates a body past the bound and says so', () => {
    const text = [
      line(userRecord('u-1', 'go')),
      line(assistantRecord('a-1', [{ type: 'text', text: 'x'.repeat(MAX_CLAUDE_TURN_BODY_LENGTH + 500) }])),
    ].join('\n');
    const body = renderClaudeTurn(onlyTurn(text).turn).body;
    expect(body).toHaveLength(MAX_CLAUDE_TURN_BODY_LENGTH);
    expect(body.endsWith(CLAUDE_TURN_TRUNCATION_MARKER)).toBe(true);
  });

  it('counts the text and tool blocks it rendered', () => {
    const rendered = renderClaudeTurn(onlyTurn(transcriptText()).turn);
    expect(rendered.textBlocks).toBe(6);
    expect(rendered.toolBlocks).toBe(2);
    expect(rendered.promptUuid).toBe('u-1');
    expect(rendered.sessionId).toBe(SESSION);
  });
});
