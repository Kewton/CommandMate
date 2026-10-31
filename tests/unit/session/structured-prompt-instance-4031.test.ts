/**
 * Issue #4031 (item 2): the `respond` a structured prompt's question names goes
 * to the instance whose prompt it is.
 *
 * Before #4031 the question said `commandmate respond <id> <number>` with no
 * `--instance`, so for `codex-2` it sent the reader to the worktree's default
 * instance. Positive: `--instance codex-2` in each of the three places.
 * Negative: without an instance (the primary) the sentence is as before.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  buildStructuredPromptQuestion,
  STRUCTURED_DECISION_OPTIONS,
} from '@/lib/session/structured-prompt';
import { promptWaitingMessage } from '@/lib/session/prompt-waiting-guard';

const WT = 'wt-4031';
const FACTS = { source: 'notification' as const, message: 'touch /tmp/marker.txt', toolName: 'bash' };
const QUESTION = {
  ...FACTS,
  decisionId: 'que_4031',
  askUserQuestion: { question: 'Which one?', labels: ['A', 'B'], questionCount: 1 },
};

/** The three places, as (name, build) pairs. */
const PLACES = [
  ['the screen dialog (yes/no is not resolved)', (id?: string) => buildStructuredPromptQuestion(WT, FACTS, id)],
  [
    'the decision verdicts',
    (id?: string) => buildStructuredPromptQuestion(WT, { ...FACTS, decisionOptions: STRUCTURED_DECISION_OPTIONS }, id),
  ],
  ['the answerable question', (id?: string) => buildStructuredPromptQuestion(WT, QUESTION, id)],
] as const;

describe('[#4031] structured prompt questions name the instance', () => {
  it.each(PLACES)('positive: %s — `--instance codex-2`', (_name, build) => {
    expect(build('codex-2')).toContain(`\`commandmate respond ${WT} <number> --instance codex-2\``);
  });

  it.each(PLACES)('negative: %s — no instance, the sentence as before', (_name, build) => {
    const text = build(undefined);
    expect(text).toContain(`\`commandmate respond ${WT} <number>\``);
    expect(text).not.toContain('--instance');
  });

  it('the label example of the verdicts names it too', () => {
    const text = buildStructuredPromptQuestion(WT, { ...FACTS, decisionOptions: STRUCTURED_DECISION_OPTIONS }, 'codex-2');
    expect(text).toContain(`\`respond ${WT} "Allow once" --instance codex-2\``);
  });

  it('the live payload and the history row carry the same question', () => {
    expect(buildStructuredPromptData(WT, FACTS, 'codex-2').question).toBe(
      buildStructuredPromptQuestion(WT, FACTS, 'codex-2'),
    );
    expect(buildStructuredPromptHistoryRecord(WT, FACTS, 'codex-2').question).toBe(
      buildStructuredPromptQuestion(WT, FACTS, 'codex-2'),
    );
    expect(buildStructuredPromptData(WT, FACTS).question).toBe(buildStructuredPromptQuestion(WT, FACTS));
  });
});

describe('[#4031] promptWaitingMessage names the instance', () => {
  it('positive: scraper refusal for codex-2', () => {
    expect(promptWaitingMessage(WT, 'scraper', 'codex-2')).toContain(
      `\`commandmate respond ${WT} <answer> --instance codex-2\``,
    );
  });

  it('positive: structured refusal for codex-2 — the respond and the bypass send', () => {
    const text = promptWaitingMessage(WT, 'structured', 'codex-2');
    expect(text).toContain(`\`commandmate respond ${WT} <answer> --instance codex-2\``);
    expect(text).toContain(`\`commandmate send ${WT} <message> --instance codex-2 --ignore-structured-prompt\``);
  });

  it('negative: no instance — exactly the sentence as before', () => {
    expect(promptWaitingMessage(WT, 'scraper')).toBe(promptWaitingMessage(WT, 'scraper', undefined));
    expect(promptWaitingMessage(WT)).toBe(
      `${WT} is waiting on a prompt. Sending now would type into the prompt's input line instead of ` +
        `reaching the agent, and would leave that text in place for the next answer. Answer the prompt ` +
        `first: \`commandmate respond ${WT} <answer>\`.`,
    );
    expect(promptWaitingMessage(WT, 'structured')).not.toContain('--instance');
  });
});
