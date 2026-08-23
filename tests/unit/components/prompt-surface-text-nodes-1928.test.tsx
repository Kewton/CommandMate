/**
 * S19: the prompt surfaces render detection output as TEXT and nothing else
 * (Issue #1928, 方針書 §13.2 S19 / §10.13 DR4-016).
 *
 * Everything `PromptPanel` and `ActivityPane` show about a dialog is scraped off
 * a terminal pane that a model wrote into. The design policy's §10 had no XSS
 * row, DR4-016 added one, and the measurement it recorded — "the receivers are
 * safe today" — is worth exactly as much as the test that keeps them that way.
 * So this file pins the property rather than restating the measurement:
 *
 *  1. **Structural.** Neither component may use `dangerouslySetInnerHTML`, and
 *     neither may put scraped text in a `title` attribute. `title` is on the
 *     list with the injection sink because it is the other way pane text leaks
 *     out of the text-node contract — a tooltip is not sanitised by React's
 *     escaping story, it is a different rendering path, and it is the one a
 *     future "show the full option on hover" change would reach for.
 *  2. **Behavioural.** A dialog whose question and options carry markup renders
 *     that markup as characters: the string is findable as text, and no element
 *     it names exists in the DOM.
 *
 * The payloads below are the shapes a terminal can genuinely deliver — a model
 * quoting HTML in a reply, a file path with angle brackets in an approval
 * prompt — not exotic ones. That is the point: this is a non-regression test,
 * not a penetration test.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PromptPanel } from '@/components/worktree/PromptPanel';
import { ActivityPane } from '@/components/worktree/ActivityPane';
import type { MultipleChoicePromptData } from '@/types/models';

const COMPONENTS = path.resolve(__dirname, '../../../src/components/worktree');

/** A payload that becomes an element if anything ever stops escaping it. */
const INJECTION = '<img src=x onerror="window.__xss1928=1">';

/**
 * `status: 'pending'` — the dialog is on screen and waiting for a human.
 *
 * That is the state S19 is about: the scraped question and option labels are
 * being shown to an operator right now, next to controls they are about to
 * click. It is also the only status under which this panel is a live answering
 * surface, so it is the one that keeps the option assertions below meaningful.
 *
 * NOT `'unclassified'`: that value marks a row recording a detection FAILURE
 * (#1708), and `src/types/models.ts` keeps it out of `'pending'` precisely so
 * `markPendingPromptsAsAnswered()` cannot stamp "(answered via terminal)" onto a
 * frame nobody could answer. This fixture is the opposite case — a fully parsed
 * dialog whose TEXT happens to be hostile.
 */
const promptData: MultipleChoicePromptData = {
  type: 'multiple_choice',
  status: 'pending',
  question: `Do you want to run ${INJECTION}?`,
  options: [
    { number: 1, label: `Yes, and run ${INJECTION}`, isDefault: true },
    { number: 2, label: 'No' },
  ],
};

describe('[#1928] S19: no injection sink in the prompt surfaces', () => {
  it.each(['PromptPanel.tsx', 'ActivityPane.tsx'])(
    '%s uses neither dangerouslySetInnerHTML nor a title attribute',
    file => {
      const source = readFileSync(path.join(COMPONENTS, file), 'utf8');

      expect(source).not.toContain('dangerouslySetInnerHTML');
      // `title=` rather than `title` — the word appears in prose and in prop
      // names; the JSX attribute is what this forbids.
      expect(source).not.toMatch(/\stitle=/);
    },
  );
});

describe('[#1928] S19: PromptPanel renders scraped text as text', () => {
  it('shows the question and the options as characters, not as markup', () => {
    const { container } = render(
      <PromptPanel
        promptData={promptData}
        messageId="prompt-1928"
        visible
        answering={false}
        onRespond={vi.fn()}
      />,
    );

    // Found as TEXT: `getByText` matches against textContent, so a payload that
    // had been parsed into an element would not be here as a string.
    expect(screen.getByText(`Do you want to run ${INJECTION}?`)).toBeInTheDocument();
    expect(screen.getByText(`1. Yes, and run ${INJECTION}`)).toBeInTheDocument();

    // …and it produced no element. Both halves are needed: the assertions above
    // would still pass if the markup were rendered AND the text kept somewhere
    // else on the panel.
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img');
    expect((window as unknown as { __xss1928?: number }).__xss1928).toBeUndefined();
  });
});

describe('[#1928] S19: ActivityPane renders what it is handed as text', () => {
  it('passes a string child through without parsing it', () => {
    // ActivityPane is a container: it renders whatever node the parent built,
    // inside an ErrorBoundary. The property S19 wants from it is that the
    // container itself adds no parsing step — a string child stays a string.
    const { container } = render(
      <ActivityPane active="files" activities={{ files: INJECTION }} />,
    );

    expect(screen.getByTestId('activity-pane')).toHaveTextContent(INJECTION);
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss1928?: number }).__xss1928).toBeUndefined();
  });
});
