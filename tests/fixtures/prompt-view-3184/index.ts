/**
 * The prompt payloads the Issue #3184 tables are written over
 * (design §4.1: four rows plus three controls).
 *
 * Nothing here is new data: R1 / R3 are the measured Command Code golden
 * (`command-code-askuserquestion-2522/promptdata-golden-2755.json`), and the
 * structured rows are built with `buildStructuredPromptData`, the server's own
 * builder, the way `PromptHeadingUnclassified-3181.test.tsx` builds them. N1 is
 * the one hand-made payload: #1932's options-without-id half state, which the
 * builder deliberately cannot produce.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { LivePromptData, MultipleChoicePromptData, YesNoPromptData } from '@/types/models';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptFacts,
  type StructuredPromptHistoryRecord,
} from '@/lib/session/structured-prompt';

const GOLDEN_2755 = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../command-code-askuserquestion-2522/promptdata-golden-2755.json'),
    'utf8',
  ),
) as Record<string, MultipleChoicePromptData>;

function structured(facts: Partial<StructuredPromptFacts>) {
  return buildStructuredPromptData('wt-3184', {
    source: 'notification',
    message: null,
    ...facts,
  } as StructuredPromptFacts);
}

/** The Issue's four categories, and what each must be read as. */
export type PromptViewRowId = 'R1' | 'R2' | 'R3' | 'R4' | 'N1' | 'N2' | 'N3';

export interface PromptViewRow {
  id: PromptViewRowId;
  /** Which of the Issue's categories the row stands for. */
  category: string;
  data: LivePromptData;
  expected: {
    kind: 'screen-choices' | 'api-choices' | 'unreadable';
    heading: 'question' | 'approval' | 'agent-question' | 'unreadable';
    choiceCount: number;
    freeText: 'screen' | 'api' | null;
    apiTarget: 'approval' | 'question' | null;
  };
}

export const PROMPT_VIEW_ROWS: readonly PromptViewRow[] = [
  {
    id: 'R1',
    category: 'screen choices (answered by the option number on screen)',
    data: GOLDEN_2755['question-description-indent-0-1-2'],
    expected: { kind: 'screen-choices', heading: 'question', choiceCount: 3, freeText: null, apiTarget: null },
  },
  {
    id: 'R2',
    category: 'API choices (V2 approval with decisionOptions)',
    data: structured({
      message: 'edit hello.txt',
      toolName: 'edit',
      decisionOptions: STRUCTURED_DECISION_OPTIONS,
      decisionId: 'per_3184probePermission0000000',
      patterns: ['*'],
    }),
    expected: { kind: 'api-choices', heading: 'approval', choiceCount: 3, freeText: null, apiTarget: 'approval' },
  },
  {
    id: 'R3',
    category: 'free text (default option is a text field on screen)',
    data: GOLDEN_2755['question-default-on-free-text'],
    expected: { kind: 'screen-choices', heading: 'question', choiceCount: 3, freeText: 'screen', apiTarget: null },
  },
  {
    id: 'R4',
    category: 'unreadable',
    data: structured({ message: 'something is open', decisionOptions: null }),
    expected: { kind: 'unreadable', heading: 'unreadable', choiceCount: 0, freeText: null, apiTarget: null },
  },
  {
    id: 'N1',
    category: 'negative control: verdicts without an id (#1932 half state)',
    data: {
      ...structured({ message: 'edit hello.txt', toolName: 'edit' }),
      decisionOptions: STRUCTURED_DECISION_OPTIONS,
      decisionId: null,
    },
    expected: { kind: 'unreadable', heading: 'unreadable', choiceCount: 0, freeText: null, apiTarget: null },
  },
  {
    id: 'N2',
    category: 'API question (decisionId, no verdicts, one question)',
    data: structured({
      toolName: 'question',
      decisionId: 'que_3184probeQuestion00000000',
      askUserQuestion: { question: 'Which branch?', labels: ['main', 'develop'], questionCount: 1 },
    }),
    expected: { kind: 'api-choices', heading: 'agent-question', choiceCount: 2, freeText: null, apiTarget: 'question' },
  },
  {
    id: 'N3',
    category: 'API free text (question with custom: true, #2951)',
    data: structured({
      toolName: 'question',
      decisionId: 'que_3184probeQuestionCustom00',
      askUserQuestion: { question: 'Name it', labels: ['alpha', 'beta'], questionCount: 1, custom: true },
    }),
    expected: { kind: 'api-choices', heading: 'agent-question', choiceCount: 2, freeText: 'api', apiTarget: 'question' },
  },
];

/** A yes/no prompt, for the `y`/`n` answers of the screen path. */
export const YES_NO_PROMPT: YesNoPromptData = {
  type: 'yes_no',
  question: 'Continue?',
  options: ['yes', 'no'],
  defaultOption: 'yes',
  status: 'pending',
};

/** A stored history record of a structured prompt (never answerable). */
export const STORED_STRUCTURED_RECORD: StructuredPromptHistoryRecord =
  buildStructuredPromptHistoryRecord('wt-3184', {
    source: 'notification',
    message: 'edit hello.txt',
    toolName: 'edit',
  });
