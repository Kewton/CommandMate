/**
 * The turn a slash command opens (Issue #2265).
 *
 * `/orchestrate` and `/release` are typed by a person, answered at length by the
 * agent, and — until this Issue — were the one prompt shape the transcript
 * reader refused to open a turn on. The cost was not a missing *row*; it was a
 * missing reply. The unopened turn's assistant records were folded into the turn
 * before it, which was already saved, so `selectUnwrittenClaudeTurns` answered
 * "nothing pending", and that answer is also what tells the poller not to fall
 * back to the pane. The Issue measured a `/release v0.30.1` turn of 7 text
 * blocks and an `/orchestrate` turn of 8 that reached History by no path at all.
 *
 * The rule the fix rests on is a census, not a preference: Claude writes the
 * `<command-…>` trio in one order for a project command and the other order for
 * a built-in, and the 222 records under `~/.claude/projects` on 2026-09-03 split
 * on it without a single exception. See
 * `tests/fixtures/claude-transcript-2265/README.md`.
 *
 * This file is the pure half — what `claudeSlashCommandPrompt`,
 * `isClaudePromptRecord` and `buildClaudeTurns` do with the real records.
 * `tests/integration/claude-slash-turn-2265.test.ts` pins what lands in
 * `chat_messages`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeTurns,
  claudeSlashCommandPrompt,
  isClaudeOperatorPromptRecord,
  isClaudePromptRecord,
  parseClaudeTranscript,
  renderClaudeTurn,
  type ClaudeTranscriptRecord,
} from '@/lib/hooks/sources/claude/transcript';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/claude-transcript-2265');
const SESSION = '7c4a9e20-2265-4b00-9000-0000000000aa';

/** Turn keys, from the fixture README. */
const A = '00000000-0000-4000-8000-000000000003';
const SLASH = '00000000-0000-4000-8000-000000000012';
const C = '00000000-0000-4000-8000-000000000024';

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function recordsOf(name: string): readonly ClaudeTranscriptRecord[] {
  const parsed = parseClaudeTranscript(fixture(name));
  expect(parsed.malformedLines).toBe(0);
  return parsed.records;
}

/** The one record in the file whose text starts with `prefix`. */
function recordStartingWith(
  records: readonly ClaudeTranscriptRecord[],
  prefix: string
): ClaudeTranscriptRecord {
  const found = records.filter((record) => record.text.trimStart().startsWith(prefix));
  expect(found).toHaveLength(1);
  return found[0];
}

describe('claudeSlashCommandPrompt', () => {
  it('rebuilds the line the operator typed, verbatim from the real record', () => {
    // The record text is byte-for-byte the one the incident session wrote at
    // 2026-09-02T23:20:35.205Z; see the fixture README.
    const record = recordStartingWith(recordsOf('release-slash-turn.jsonl'), '<command-message>');

    expect(record.text).toBe(
      '<command-message>release</command-message>\n' +
        '<command-name>/release</command-name>\n' +
        '<command-args>v0.30.1</command-args>'
    );
    expect(claudeSlashCommandPrompt(record.text)).toBe('/release v0.30.1');
  });

  it('keeps arguments that run over more than one line', () => {
    // Captured shape: the operator typed `/orchestrate 2245 2246 2247 2248`,
    // pressed the newline key and added a sentence. `recordUserTurn` compares on
    // normalised content and interior newlines are significant there, so
    // flattening this would stop the `/send` row being adopted.
    expect(
      claudeSlashCommandPrompt(
        '<command-message>orchestrate</command-message>\n' +
          '<command-name>/orchestrate</command-name>\n' +
          '<command-args>2245 2246 2247 2248\nを再開して</command-args>'
      )
    ).toBe('/orchestrate 2245 2246 2247 2248\nを再開して');
  });

  it.each([
    ['no <command-args> tag at all', ''],
    ['an empty <command-args>', '\n<command-args></command-args>'],
    ['a whitespace-only <command-args>', '\n<command-args>   </command-args>'],
  ])('reads a bare invocation as the command name alone — %s', (_label, tail) => {
    // Synthetic, and labelled as such: all 118 `<command-message>` records in
    // the census carried a non-empty `<command-args>`, so there was no honest
    // way to capture a bare one. A command typed with no arguments is still a
    // thing a person can do, and a trailing space would stop the `/send` row
    // being adopted.
    const text =
      '<command-message>release</command-message>\n<command-name>/release</command-name>' + tail;

    expect(claudeSlashCommandPrompt(text)).toBe('/release');
  });

  it.each([
    [
      'a built-in command, which is <command-name> first',
      '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
    ],
    ['a built-in command’s output', '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>'],
    ['the caveat in front of one', '<local-command-caveat>Caveat: The messages below…</local-command-caveat>'],
    ['ordinary prose', 'リリース作業を進めてください。'],
  ])('answers null for %s', (_label, text) => {
    expect(claudeSlashCommandPrompt(text)).toBeNull();
  });

  it('answers null when the command cannot be read out of the record', () => {
    // Never observed, and deliberately not guessed at: a record this reader
    // could not name would otherwise reach History as its own XML.
    expect(
      claudeSlashCommandPrompt('<command-message>release</command-message>\n<command-args>v1</command-args>')
    ).toBeNull();
    expect(
      claudeSlashCommandPrompt('<command-message>release</command-message>\n<command-name></command-name>')
    ).toBeNull();
  });
});

describe('isClaudePromptRecord, on the real records', () => {
  it('opens a turn on the slash command the operator typed', () => {
    const record = recordStartingWith(recordsOf('release-slash-turn.jsonl'), '<command-message>');

    expect(isClaudePromptRecord(record)).toBe(true);
    // The Issue's own trap: these records are not `isMeta`, so a rule that
    // expected `isMeta` to filter them would have filtered nothing.
    expect(record.isMeta).toBe(false);
    // And the marker `isClaudeOperatorPromptRecord` needs is on them, on every
    // Claude Code from 2.1.238 — which is what makes the `user` row possible.
    expect(record.originKind).toBe('human');
    expect(record.promptSource).toBeNull();
    expect(isClaudeOperatorPromptRecord(record)).toBe(true);
  });

  it('does not open a turn on the skill body the command expands to', () => {
    // 18 KB of instructions on its own `isMeta` record, immediately behind the
    // command. The single most damaging thing here to mistake for a prompt.
    const records = recordsOf('release-slash-turn.jsonl');
    const expansion = recordStartingWith(records, 'Base directory for this skill:');

    expect(expansion.isMeta).toBe(true);
    expect(isClaudePromptRecord(expansion)).toBe(false);
  });

  it.each([
    ['<command-name>', 'the built-in command itself'],
    ['<local-command-stdout>', 'its output'],
    ['<local-command-caveat>', 'the caveat in front of it'],
  ])('leaves %s excluded — %s', (prefix) => {
    const record = recordStartingWith(recordsOf('local-command-turn.jsonl'), prefix);

    expect(isClaudePromptRecord(record)).toBe(false);
  });
});

describe('buildClaudeTurns, on the measured incident', () => {
  const built = () => buildClaudeTurns(recordsOf('release-slash-turn.jsonl'), SESSION);

  it('opens the slash turn between the two ordinary ones', () => {
    expect(built().turns.map((turn) => turn.promptUuid)).toEqual([A, SLASH, C]);
  });

  it('puts the typed line on the turn, not the XML', () => {
    const turn = built().turns[1];

    expect(turn.promptText).toBe('/release v0.30.1');
    expect(turn.promptIsOperatorInput).toBe(true);
    expect(turn.promptText).not.toContain('<command-');
  });

  it('carries the reply the incident lost', () => {
    const turn = built().turns[1];
    const rendered = renderClaudeTurn(turn);

    expect(turn.assistantRecords).toBe(4);
    expect(rendered.body).toContain('`/release 0.30.1` を実行します。');
    expect(rendered.body).toContain('Phase 1・2 の進捗を報告します');
    expect(rendered.body).toContain(TURN_TOOL_LOG_LABEL);
    expect(rendered.textBlocks).toBe(2);
    expect(rendered.toolBlocks).toBe(1);
  });

  it('keeps the command’s own bookkeeping out of the body', () => {
    const rendered = renderClaudeTurn(built().turns[1]);

    expect(rendered.body).not.toContain('<command-message>');
    expect(rendered.body).not.toContain('<command-name>');
    expect(rendered.body).not.toContain('Base directory for this skill');
  });

  it('is writable — closed by the agent and superseded by the next prompt', () => {
    // #2264's gate, unchanged. Stated here because a turn this reader newly
    // opens has to pass it before a row is written at all.
    const turn = built().turns[1];

    expect(turn.closed).toBe(true);
    expect(turn.superseded).toBe(true);
    expect(turn.stopReasonObserved).toBe(true);
  });

  it('leaves the ordinary turns exactly as they were', () => {
    const turns = built().turns;

    expect(turns[0].promptText).toBe('対応済のissueはクローズ済ですか？');
    expect(turns[2].promptText).toBe('現在の状況を教えて');
    expect(renderClaudeTurn(turns[0]).body).toContain('4件すべてクローズ済み');
    expect(renderClaudeTurn(turns[2]).body).toContain('v0.30.1 のリリースは完了しています');
  });
});

describe('buildClaudeTurns, on a built-in command', () => {
  it('opens one turn, not two', () => {
    // `/model` writes three records and the agent answers none of them. A
    // second turn here would be a permanently blank row keyed on a `uuid` no
    // later read can distinguish from a real one.
    const built = buildClaudeTurns(recordsOf('local-command-turn.jsonl'), SESSION);

    expect(built.turns.map((turn) => turn.promptUuid)).toEqual([A]);
    expect(built.orphanedAssistantRecords).toBe(0);
  });

  it('does not open on a <command-message> that is not the leading tag', () => {
    // The built-in record has one on its *second* line. The rule is the leading
    // tag, and this is the record that makes that necessary.
    const record = recordStartingWith(recordsOf('local-command-turn.jsonl'), '<command-name>');

    expect(record.text).toContain('<command-message>model</command-message>');
    expect(isClaudePromptRecord(record)).toBe(false);
  });
});

describe('the window head', () => {
  it('does not open a slash turn whose own record fell outside the window', () => {
    // #2246's discipline, and it has to hold for this shape too: a turn opened
    // from its middle would be keyed on a `uuid` that is not the prompt's, and
    // an invented key is a row no later run recognises as already written.
    const lines = fixture('release-slash-turn.jsonl').trimEnd().split('\n');
    const slashIndex = lines.findIndex((line) => line.includes('<command-message>release'));
    expect(slashIndex).toBeGreaterThan(0);

    const cut = `${lines.slice(slashIndex + 1).join('\n')}\n`;
    const built = buildClaudeTurns(parseClaudeTranscript(cut).records, SESSION);

    expect(built.turns.map((turn) => turn.promptUuid)).toEqual([C]);
    expect(built.orphanedAssistantRecords).toBe(4);
  });
});
