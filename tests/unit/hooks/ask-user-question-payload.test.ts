/**
 * Reading an `AskUserQuestion` tool call (Issue #1726).
 *
 * The positive cases are asserted against the payloads the Issue #1721 spike
 * captured from a live v2.1.223 session, not against bodies written to match the
 * parser. That is the whole point of keeping fixtures: an injected `type:
 * "http"` hook posts the agent's payload verbatim, so those files *are* the wire
 * format, and a Claude-side shape change has to fail here rather than silently
 * empty the options in production.
 *
 * The negative cases carry as much weight. Every rejection degrades to "no
 * structured options", which leaves the scraper's parse alone — so a parser that
 * accepted rubbish would put invented options in front of `respond`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MAX_ASK_USER_QUESTION_OPTIONS,
  MAX_ASK_USER_QUESTIONS,
  parseAskUserQuestionPayload,
  parseAskUserQuestionToolInput,
} from '@/lib/hooks/ask-user-question-payload';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('the captured payloads (Issue #1726)', () => {
  it('reads both questions, their options and their descriptions off PreToolUse', () => {
    const spec = parseAskUserQuestionPayload(fixture('pre-tool-use-ask-user-question.json'));

    expect(spec).not.toBeNull();
    expect(spec!.questions).toHaveLength(2);
    expect(spec!.questions[0]).toMatchObject({
      question: 'What is your favorite color?',
      header: 'Color',
      multiSelect: false,
    });
    expect(spec!.questions[0].choices.map((c) => c.label)).toEqual(['Blue', 'Green', 'Red']);
    expect(spec!.questions[0].choices[0].description).toContain('Cool, calm');
    expect(spec!.questions[1].choices.map((c) => c.label)).toEqual(['VS Code', 'Vim / Neovim']);
  });

  it('reads the same call off the PermissionRequest AskUserQuestion also raises', () => {
    // §5.6: `AskUserQuestion` raises a `PermissionRequest` carrying a
    // byte-identical `tool_input`. It is the only source on a session started
    // before PreToolUse injection existed, so it has to parse identically.
    const fromPreToolUse = parseAskUserQuestionPayload(
      fixture('pre-tool-use-ask-user-question.json'),
    );
    const fromPermission = parseAskUserQuestionPayload(
      fixture('permission-request-ask-user-question.json'),
    );

    expect(fromPermission?.questions).toEqual(fromPreToolUse?.questions);
  });

  it('keeps prompt_id, which is the only key the two payloads share', () => {
    // `tool_use_id` is on PreToolUse and absent from PermissionRequest (D2), so
    // nothing may correlate on it.
    expect(parseAskUserQuestionPayload(fixture('pre-tool-use-ask-user-question.json'))?.promptId)
      .toBe('11111111-1111-4111-8111-111111111111');
    expect(fixture('permission-request-ask-user-question.json').tool_use_id).toBeUndefined();
  });

  it('refuses a PreToolUse for any other tool', () => {
    expect(parseAskUserQuestionPayload(fixture('pre-tool-use-bash.json'))).toBeNull();
  });

  it('refuses a payload for another tool even when it carries a questions array', () => {
    // `tool_name` is the discriminator, never the shape of `tool_input`.
    expect(
      parseAskUserQuestionPayload({
        tool_name: 'Bash',
        tool_input: { questions: [{ question: 'q?', options: [{ label: 'a' }] }] },
      }),
    ).toBeNull();
  });
});

describe('what is refused (Issue #1726)', () => {
  const rejected: Array<[string, unknown]> = [
    ['not an object', 'questions'],
    ['no questions key', {}],
    ['questions not an array', { questions: { question: 'q?' } }],
    ['questions empty', { questions: [] }],
    ['a question with no text', { questions: [{ options: [{ label: 'a' }] }] }],
    ['a question with a blank text', { questions: [{ question: '  ', options: [{ label: 'a' }] }] }],
    ['a question with no options', { questions: [{ question: 'q?' }] }],
    ['a question with an empty options array', { questions: [{ question: 'q?', options: [] }] }],
    ['an option that is not an object', { questions: [{ question: 'q?', options: ['a'] }] }],
    ['an option with no label', { questions: [{ question: 'q?', options: [{ description: 'd' }] }] }],
  ];

  it.each(rejected)('refuses %s', (_name, toolInput) => {
    expect(parseAskUserQuestionToolInput(toolInput)).toBeNull();
  });

  it('refuses the whole question when one of its options is unreadable', () => {
    // Position is the entire correspondence rule downstream: option k of the
    // payload is option k on screen. Dropping an unreadable option would shift
    // every option after it onto the wrong number.
    expect(
      parseAskUserQuestionToolInput({
        questions: [{ question: 'q?', options: [{ label: 'a' }, { label: 42 }, { label: 'c' }] }],
      }),
    ).toBeNull();
  });

  it('refuses more questions or options than a real call can have', () => {
    const options = Array.from({ length: MAX_ASK_USER_QUESTION_OPTIONS + 1 }, (_, i) => ({
      label: `option ${i}`,
    }));
    expect(parseAskUserQuestionToolInput({ questions: [{ question: 'q?', options }] })).toBeNull();

    const questions = Array.from({ length: MAX_ASK_USER_QUESTIONS + 1 }, () => ({
      question: 'q?',
      options: [{ label: 'a' }],
    }));
    expect(parseAskUserQuestionToolInput({ questions })).toBeNull();
  });
});

describe('normalisation (Issue #1726)', () => {
  it('bounds every string it keeps', () => {
    const spec = parseAskUserQuestionToolInput({
      questions: [
        {
          question: 'q'.repeat(5000),
          header: 'h'.repeat(500),
          options: [{ label: 'l'.repeat(5000), description: 'd'.repeat(5000) }],
        },
      ],
    });

    expect(spec![0].question.length).toBeLessThanOrEqual(1000);
    expect(spec![0].header!.length).toBeLessThanOrEqual(64);
    expect(spec![0].choices[0].label.length).toBeLessThanOrEqual(200);
    expect(spec![0].choices[0].description!.length).toBeLessThanOrEqual(500);
  });

  it('reports an absent description and an absent header as null, not as empty text', () => {
    const spec = parseAskUserQuestionToolInput({
      questions: [{ question: 'q?', options: [{ label: 'a' }] }],
    });

    expect(spec![0].header).toBeNull();
    expect(spec![0].choices[0].description).toBeNull();
    expect(spec![0].multiSelect).toBe(false);
  });

  it('carries multiSelect through', () => {
    const spec = parseAskUserQuestionToolInput({
      questions: [{ question: 'q?', multiSelect: true, options: [{ label: 'a' }] }],
    });

    expect(spec![0].multiSelect).toBe(true);
  });
});
