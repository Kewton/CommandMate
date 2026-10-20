/**
 * Claude frames that carry the AskUserQuestion confirmation page's WORDING
 * without being that page (Issue #3748) — the negative controls of
 * `isClaudeAskUserQuestionConfirmPage`.
 *
 * DERIVED, not captured: each is a live capture with text substituted, so the
 * chrome around the substitution is measured. The `.txt` sweeps over
 * `tests/fixtures/` are corpora of LIVE captures, which is why this is a module.
 *
 * - Bash / Edit approvals: `../../unit/lib/detection/fixtures/claude-live-1708/
 *   bash-approval-taskpanel.txt` (claude-cli 2.1.240, plain text). The Edit
 *   approval replaces the Bash block with an Edit block (header, file, diff
 *   rows, `Do you want to make this edit to a.ts?`) and its three options.
 * - AskUserQuestion: `../claude-live-2486/tabs-q1.txt` (claude-cli 2.1.268, SGR
 *   intact) with the end of the question's text replaced.
 *
 * The worker that runs into these is the one working on this very feature:
 * `grep -rn "review your answers" src` is an ordinary command there.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASH_APPROVAL = readFileSync(
  path.resolve(__dirname, '../../unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'),
  'utf8',
);
const TABS_Q1 = readFileSync(path.resolve(__dirname, '../claude-live-2486/tabs-q1.txt'), 'utf8');

const BASH_COMMAND = 'touch /tmp/probe1708-marker && echo done';
const BASH_DESCRIPTION = 'Create marker file in /tmp';
const BASH_BLOCK = [
  ' Bash command',
  '',
  `   ${BASH_COMMAND}`,
  `   ${BASH_DESCRIPTION}`,
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to tmp/ from this project',
  '   3. No',
].join('\n');
const QUESTION_TAIL = '右のプレビューに子ごとの権限表があります。';

function replaceOnce(frame: string, from: string, to: string): string {
  if (!frame.includes(from)) throw new Error(`fixture drifted: ${from}`);
  return frame.replace(from, to);
}

/** The Bash approval, running `command` (every echo of it), with `description` under it. */
export function bashApprovalRunning(command: string, description: string = BASH_DESCRIPTION): string {
  return replaceOnce(BASH_APPROVAL.split(BASH_COMMAND).join(command), `   ${BASH_DESCRIPTION}`, `   ${description}`);
}

/** An Edit approval whose diff's last rows carry the page's two sentences. */
export function editApprovalWithDiff(): string {
  return replaceOnce(
    BASH_APPROVAL,
    BASH_BLOCK,
    [
      ' Edit file',
      ' src/a.ts',
      '╌'.repeat(150),
      " 1 -const heading = 'Review your answers';",
      " 1 +const heading = 'Ready to submit your answers?';",
      '╌'.repeat(150),
      ' Do you want to make this edit to a.ts?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No',
    ].join('\n'),
  );
}

/** An ordinary AskUserQuestion screen whose question ends with `sentence`. */
export function askUserQuestionAsking(sentence: string): string {
  return replaceOnce(TABS_Q1, QUESTION_TAIL, sentence);
}
