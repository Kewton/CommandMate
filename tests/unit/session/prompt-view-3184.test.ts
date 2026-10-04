/**
 * The one decision of how a prompt is shown and answered (Issue #3184).
 *
 * Design §4.2: one table over the shared fixture rows, plus the invariants the
 * rest of the codebase leans on — chiefly that the view and the closed
 * `PromptData` narrowing (`isAnswerablePromptData`, #1725) can never disagree.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  derivePromptView,
  readPromptView,
  UNCLASSIFIED_PROMPT_VIEW_TYPE,
  type PromptViewSource,
} from '@/lib/session/prompt-view';
import {
  isAnswerablePromptData,
  UNCLASSIFIED_PROMPT_TYPE,
  type UnclassifiedFrameRecord,
} from '@/types/models';
import {
  readDecisionId as readPromptDecisionId,
  readQuestionChoices as readPromptQuestionChoices,
  readDecisionHeading as readStructuredDecisionHeading,
} from '@/lib/session/prompt-view';
import {
  PROMPT_VIEW_ROWS,
  STORED_STRUCTURED_RECORD,
  YES_NO_PROMPT,
} from '../../fixtures/prompt-view-3184';

const UNCLASSIFIED_FRAME_RECORD: UnclassifiedFrameRecord = {
  type: UNCLASSIFIED_PROMPT_TYPE,
  status: 'unclassified',
  question: 'Unclassified interactive frame on wt-3184 for 60s',
  options: [],
  dwellSeconds: 60,
  sessionStatusReason: 'running/default',
};

/** Every payload the invariants below are checked over. */
const ALL_SOURCES: { name: string; data: PromptViewSource }[] = [
  ...PROMPT_VIEW_ROWS.map((row) => ({ name: row.id, data: row.data as PromptViewSource })),
  { name: 'yes_no', data: YES_NO_PROMPT },
  { name: 'stored structured record', data: STORED_STRUCTURED_RECORD },
  { name: 'stored unclassified frame record', data: UNCLASSIFIED_FRAME_RECORD },
];

describe('derivePromptView over the fixture rows (design §4.1)', () => {
  it.each(PROMPT_VIEW_ROWS.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const view = derivePromptView(row.data);
    expect(view).not.toBeNull();
    expect({
      kind: view!.kind,
      heading: view!.heading.kind,
      choiceCount: view!.choices.length,
      freeText: view!.freeText?.via ?? null,
      apiTarget: view!.apiTarget,
    }).toEqual(row.expected);
  });

  it('answers null for no prompt', () => {
    expect(derivePromptView(null)).toBeNull();
    expect(derivePromptView(undefined)).toBeNull();
  });

  it('numbers screen choices by their option number and yes/no by the word', () => {
    expect(derivePromptView(PROMPT_VIEW_ROWS[0].data)!.choices.map((c) => c.answer)).toEqual(['1', '2', '3']);
    const yesNo = derivePromptView(YES_NO_PROMPT)!;
    expect(yesNo.choices.map((c) => [c.answer, c.isDefault])).toEqual([['yes', true], ['no', false]]);
  });

  it('marks only the text-field option of the free-text row (#2573)', () => {
    const view = derivePromptView(PROMPT_VIEW_ROWS.find((r) => r.id === 'R3')!.data)!;
    expect(view.choices.map((c) => c.takesText)).toEqual([false, false, true]);
  });

  it('numbers an API question by position, and an approval by its verdict numbers', () => {
    const question = derivePromptView(PROMPT_VIEW_ROWS.find((r) => r.id === 'N2')!.data)!;
    expect(question.choices.map((c) => [c.answer, c.label])).toEqual([['1', 'main'], ['2', 'develop']]);
    const approval = derivePromptView(PROMPT_VIEW_ROWS.find((r) => r.id === 'R2')!.data)!;
    expect(approval.choices.map((c) => c.answer)).toEqual(['1', '2', '3']);
  });
});

describe('invariants', () => {
  it.each(ALL_SOURCES.map((s) => [s.name, s.data] as const))(
    "%s: kind === 'screen-choices' exactly when isAnswerablePromptData (#1725)",
    (_name, data) => {
      const screen = derivePromptView(data)?.kind === 'screen-choices';
      expect(screen).toBe(isAnswerablePromptData(data as Parameters<typeof isAnswerablePromptData>[0]));
    },
  );

  it.each(ALL_SOURCES.map((s) => [s.name, s.data] as const))(
    "%s: decisionId is non-null exactly when kind === 'api-choices' (#2031)",
    (_name, data) => {
      const view = derivePromptView(data)!;
      expect(view.decisionId !== null).toBe(view.kind === 'api-choices');
      if (view.kind === 'unreadable') expect(view.choices).toEqual([]);
    },
  );

  it('stored records are never answerable (no decision id is ever written to one)', () => {
    expect(derivePromptView(STORED_STRUCTURED_RECORD)!.kind).toBe('unreadable');
    expect(derivePromptView(UNCLASSIFIED_FRAME_RECORD)!.kind).toBe('unreadable');
  });

  it('a V2 approval is never headed "could not read" (#3181)', () => {
    const view = derivePromptView(PROMPT_VIEW_ROWS.find((r) => r.id === 'R2')!.data)!;
    expect(view.heading).toEqual({ kind: 'approval', toolName: 'edit' });
  });

  it('positive control: the unreadable row IS headed "could not read"', () => {
    expect(derivePromptView(PROMPT_VIEW_ROWS.find((r) => r.id === 'R4')!.data)!.heading).toEqual({
      kind: 'unreadable',
    });
  });

  it('restates the sentinel with the same value as types/models', () => {
    expect(UNCLASSIFIED_PROMPT_VIEW_TYPE).toBe(UNCLASSIFIED_PROMPT_TYPE);
  });

  it('has no imports, so the CLI build can compile it (design §2.1)', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../src/lib/session/prompt-view.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe('the field readers agree with derivePromptView', () => {
  it.each(PROMPT_VIEW_ROWS.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const view = derivePromptView(row.data)!;
    if (view.kind === 'api-choices') {
      expect(readPromptDecisionId(row.data)).toBe(view.decisionId);
      expect(readStructuredDecisionHeading(row.data)).toEqual(
        view.apiTarget === 'approval'
          ? { kind: 'approval', toolName: (view.heading as { toolName: string | null }).toolName }
          : { kind: 'question' },
      );
      expect(readPromptQuestionChoices(row.data) !== null).toBe(view.apiTarget === 'question');
    } else {
      expect(readStructuredDecisionHeading(row.data)).toBeNull();
      expect(readPromptQuestionChoices(row.data)).toBeNull();
    }
  });
});

describe('readPromptView', () => {
  const r2 = PROMPT_VIEW_ROWS.find((r) => r.id === 'R2')!.data;

  it('derives from promptData when the server published no view (pre-#3184 daemon)', () => {
    expect(readPromptView({ promptData: r2 })).toEqual(derivePromptView(r2));
  });

  it('prefers the published view', () => {
    const published = derivePromptView(PROMPT_VIEW_ROWS[0].data);
    expect(readPromptView({ promptData: r2, promptView: published })).toBe(published);
  });

  it('answers null for no payload and no prompt', () => {
    expect(readPromptView(null)).toBeNull();
    expect(readPromptView({ promptData: null })).toBeNull();
  });
});
