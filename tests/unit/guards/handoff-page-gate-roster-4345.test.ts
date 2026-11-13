/**
 * Issue #4345 1c 再指示 2 (K1): the one roster of the gate's rows — the enabler's table of the page's
 * new operations (enabler-return-4345-1c-cause.md §1.2, PM's disposition (a)) — each row pointing at
 * the test that runs it under T2 (after another entry's 401: not sent, fetch 0) and, where it has a
 * caller to tell, T4 (not sent is not a failure). A row whose test is gone, or renamed away, fails
 * here: the roster and the tests are kept one list.
 *
 * Rows out of (a) (Git, timers, OpenCode's session, the description and notes, memos — 1d) are in
 * `handoff-page-write-gate-4345`'s exceptions instead; the records (#29) and the reads (#31) are
 * `page-gate-k1-4345` T5–T7.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const T = 'tests/unit';
const C = `${T}/components/worktree`;
const H = `${T}/hooks`;

/** §1.2 row → [test file, the name its test goes by (a substring of the source)]. */
const ROSTER: ReadonlyArray<readonly [string, string, string]> = [
  ['#1 composer send (PC・phone・chat)', `${C}/MessageInput-auth-gateway-4345.test.tsx`, "'awaited send (MessageInput → worktreeApi.sendMessage)'"],
  ['#1 composer send: preview held, 401, preview 200 (T3)', `${C}/MessageInput-operation-gate-4345.test.tsx`, '(a) preview held'],
  ['#1 composer send: not sent is no error (T4)', `${C}/page-gate-callers-4345.test.tsx`, 'the awaited send refused at the gate'],
  ['#2 brief choice send (pressed while expired)', `${C}/MessageInput-operation-gate-4345.test.tsx`, 'pressed while expired'],
  ['#3 retry of a failed row (T4)', `${H}/usePendingMessages-not-sent-4345.test.ts`, 'a retry not sent'],
  ['#4 automatic resend (T4: parked, resend not spent)', `${H}/usePendingMessages-not-sent-4345.test.ts`, 'an automatic resend not sent'],
  ['#3・#4 the optimistic send through the gate', `${H}/page-owner-polls-auth-4345.test.tsx`, "'optimistic send (useOptimisticPaneMessages)'"],
  ['#5 phone model picker (send)', `${C}/MobileTerminalTab-auth-gateway-4345.test.tsx`, "'model picker send (MobileTerminalTab → worktreeApi.sendMessage)'"],
  ['#6 phone model picker (OpenCode chord)', `${C}/MobileTerminalTab-auth-gateway-4345.test.tsx`, "'model picker chord (MobileTerminalTab, OpenCode → useSpecialKeys)'"],
  ['#7 special keys', `${C}/page-owner-chains-auth-4345.test.tsx`, "'special keys (useSpecialKeys)'"],
  ['#8 direct input', `${C}/page-owner-chains-auth-4345.test.tsx`, "'direct input (useDirectInput)'"],
  ['#9 interrupt', `${C}/page-owner-chains-auth-4345.test.tsx`, "'interrupt (InterruptButton)'"],
  ['#10 clear composer', `${C}/page-owner-chains-auth-4345.test.tsx`, "'clear composer (UnsentComposerBar)'"],
  ['#11 prompt answer (PC, controller) + T4', `${H}/useWorktreeDetailController-page-entries-auth-4345.test.tsx`, 'T4 the prompt answer not sent'],
  ['#12 prompt answer (split)', `${C}/TerminalSplitPaneContent-auth-gateway-4345.test.tsx`, "'the prompt answer (/prompt-response)'"],
  ['#12 split answer not sent tells nothing (T4)', `${C}/TerminalSplitPaneContent-auth-gateway-4345.test.tsx`, 'the split’s answer not sent tells nothing'],
  ['#13 respond (split)', `${C}/TerminalSplitPaneContent-auth-gateway-4345.test.tsx`, "'the decision answer (/respond)'"],
  ['#13 respond (phone sheet)', `${C}/WorktreeDetailRefactored-page-owner-4345.test.tsx`, 'the phone’s decision answer'],
  ['#14 plan review', `${C}/page-owner-panes-auth-4345.test.tsx`, "'plan review answer (PlanReviewControls)'"],
  ['#15 auto-yes toggle', `${H}/useWorktreeDetailController-page-entries-auth-4345.test.tsx`, "'auto-yes-post'"],
  ['#16 end confirmed after a 401 (T3・T4)', `${H}/useWorktreeDetailController-page-entries-auth-4345.test.tsx`, 'T3 (#16)'],
  ['#17 hand-off stop: kill not sent, not observed (T4)', `${C}/page-gate-callers-4345.test.tsx`, 'onStop says not-sent'],
  ['#18 role restart (T3: confirming)', `${T}/components/roles/page-owner-roles-gate-4345.test.tsx`, '401 taken while confirming'],
  ['#18 role restart (gate)', `${C}/page-owner-panes-auth-4345.test.tsx`, "'role row kill (InstanceRolesSection)'"],
  ['#19 update card restart', `${C}/page-owner-panes-auth-4345.test.tsx`, "'update card kill (AgentUpdatesCard)'"],
  ['#20 file create / folder / rename / delete', `${H}/useWorktreeDetailController-page-entries-auth-4345.test.tsx`, "'new-file', 'new-dir', 'rename', 'delete'"],
  ['#21 file upload', `${H}/useWorktreeDetailController-page-entries-auth-4345.test.tsx`, "'move', 'upload'"],
  ['#22 image attachment', `${C}/MessageInput-auth-gateway-4345.test.tsx`, "'image upload (MessageInput → worktreeApi.uploadImageFile)'"],
  ['#23 file move', `${H}/useWorktreeDetailController-page-entries-auth-4345.test.tsx`, 'const OPERATIONS'],
  ['#24 editor save', `${C}/page-owner-files-auth-4345.test.tsx`, "'editor save (MarkdownEditor)'"],
  ['#25 agent settings (PUT・PATCH)', `${C}/page-owner-panes-auth-4345.test.tsx`, "'OpenCode settings write (AgentSettingsPane)'"],
  ['#25 agent settings (PATCH)', `${C}/page-owner-panes-auth-4345.test.tsx`, "'agents PATCH (AgentSettingsPane)'"],
  ['#26 vibe-local settings', `${C}/page-owner-chains-auth-4345.test.tsx`, "'vibe-local model save (VibeLocalSettings)'"],
  ['#27 schedule delete', `${C}/page-owner-panes-auth-4345.test.tsx`, "'schedule delete (ExecutionLogPane)'"],
  ['#27 schedule toggle', `${C}/page-owner-panes-auth-4345.test.tsx`, "'schedule toggle (ExecutionLogPane)'"],
  ['#27 schedule save', `${C}/page-owner-chains-auth-4345.test.tsx`, "'schedule save (ScheduleEditDialog)'"],
  ['#28 hand-off API operations (gate, T1・T2)', `${T}/lib/handoff/page-gate-k1-4345.test.ts`, "'screen-client (decide)'"],
  ['#29 records leave with the capability (T5・T6)', `${T}/lib/handoff/page-gate-k1-4345.test.ts`, 'T6 a record without the capability'],
  ['#31 reads are never stopped (T7)', `${T}/lib/handoff/page-gate-k1-4345.test.ts`, 'T7 reads leave while expired'],
  ['T8 the press’s registration decides', `${T}/lib/handoff/page-gate-k1-4345.test.ts`, 'T8 pressed, then the page made again'],
  ['T10 every page-owned write goes through the gate', `${T}/guards/handoff-page-write-gate-4345.test.ts`, 'every page-owned write outside the named exceptions'],
];

/** The harness that turns each `operation: true` row into T2・T8・T9. */
const HARNESS = `${T}/lib/handoff/page-owner-harness.tsx`;

describe('[#4345 1c 再指示 2] the roster of the gate’s rows and their tests are one list', () => {
  it.each(ROSTER.map(([row, file, name]) => [row, file, name] as const))('%s', (_row, file, name) => {
    expect(readFileSync(path.join(process.cwd(), file), 'utf8')).toContain(name);
  });

  it('the harness runs T2 and T9 for every operation row', () => {
    const source = readFileSync(path.join(process.cwd(), HARNESS), 'utf8');
    expect(source).toContain('T2 %s after another entry’s 401: not sent (fetch 0)');
    expect(source).toContain('T9 %s outside any page');
  });
});
