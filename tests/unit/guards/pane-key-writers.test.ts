/**
 * Every key written into a pane through tmux is on a ledger, with its decision
 * (Issue #3981).
 *
 * ## Why
 *
 * #3945 → #3952 → #3975 widened the instance input lock to the sites the last
 * review named, and four generations running the same invariant ("keys typed
 * into a pane are ordered") came back with a counterpart left over: tmux's
 * `sendKeys` takes no ticket, anyone can call it, and nothing listed the
 * callers that do so outside the lock. This file is that list, read off the
 * source by `pane-key-writers-scan.ts`, and checked both ways.
 *
 * ## The ledger's rules (review 3)
 *
 * - One row per `{file, site, callee}`, with how many references it covers.
 *   A reference the ledger does not have — a new `sendKeys(`, also inside a
 *   wrapper whose name nobody knows — fails. A row with nothing behind it fails.
 * - `lock`: the keys go out while the writer holds a ticket. `held: 'lexical'`
 *   rows are checked in the source (the reference sits in a function passed to
 *   the lock, or one that takes a ticket), so taking the wrapper off fails here;
 *   every `lock` row names a behavioural test that runs it under the lock.
 *   `lock` rows may be added, with such a test.
 * - `decided-outside` / `kill` / `dead` are the un-ordered rows. They may only
 *   go down ({@link UNMEDIATED_BASELINE}); every `decided-outside` row names a
 *   test of the decision.
 * - A row whose lock its caller holds (`held: 'caller'`), or that is marked
 *   `callersOnLedger`, has its callers on a ledger of their own
 *   ({@link CALLER_LEDGER}, review P2-1): its `sendKeys` reference does not
 *   move when someone calls the function from a new place outside the lock,
 *   so the callers are read off the source and checked the same way. A caller
 *   is `lexical` (it sits in a function passed to the lock) or `listed` (the
 *   reason says how it holds the lock); `listed` callers may only go down
 *   ({@link LISTED_CALLER_BASELINE}).
 *
 * ## Stage 2 (Issue #4032)
 *
 * - Every other key writer of the tmux module (`sendSpecialKey(s)`,
 *   `clearInputLine`, …, read off the module by `tmuxKeyWriterExports`) is on
 *   {@link STAGE_2_LEDGER}, by the same rules, with callers of its own
 *   ({@link STAGE_2_CALLER_LEDGER}). {@link LEDGER} stays the `sendKeys` ledger:
 *   each ledger is reconciled against the sites of its own writers.
 * - `send-keys` / `paste-buffer` composed outside the tmux module are on
 *   {@link RAW_KEY_WRITES}, each with its reason.
 * - A caller is found through a renamed or namespace import too, and a
 *   re-export of a caller-held function fails (`<re-export>`).
 * - A `lock` row's evidence test names the site's function.
 *
 * Later (another Issue): once the un-ordered rows are 0, narrow the writers to
 * a ticket-taking API in the type system.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, resolveRepoSpecifier } from './route-tmux-reach';
import {
  callerFiles,
  candidateFiles,
  KEY_WRITERS,
  scanCallers,
  scanKeyWriters,
  scanRawKeyWrites,
  scanReferences,
  scanRepository,
  scanRepositoryRawWrites,
  srcFiles,
  TMUX_MODULE,
  tmuxKeyWriterExports,
  type KeySite,
  type RawKeyWrite,
} from './pane-key-writers-scan';

type Kind = 'lock' | 'decided-outside' | 'kill' | 'dead';

interface LedgerRow {
  file: string;
  /** Innermost named function holding the reference (see the scanner). */
  site: string;
  callee: string;
  kind: Kind;
  /** For `lock`: whether the source shows the lock (`lexical`) or the caller holds it (`caller`). */
  held?: 'lexical' | 'caller';
  /** References this row covers; 1 when omitted. */
  count?: number;
  reason: string;
  /** Required for `lock` and `decided-outside`. */
  evidence?: string;
  /** Its callers are checked against {@link CALLER_LEDGER} (implied by `held: 'caller'`). */
  callersOnLedger?: true;
}

const LAUNCH_EVIDENCE = 'tests/unit/cli-tools/launch-lines-input-lock-3981.test.ts';
const NON_PARTICIPANTS_EVIDENCE = 'tests/unit/session/input-lock-non-participants-3952.test.ts';
const PROMPT_ANSWER_EVIDENCE = 'tests/unit/prompt-answer-sender-input-lock-3952.test.ts';
const KILL_REASON =
  'Exit keys of a stop (`requestExitAndKill` / `stopSession`): not ordered against sends, by decision (#3981, cli-operations-guide) — a stop must not queue behind the send it may be meant to end, and the session is torn down right after.';

export const LEDGER: readonly LedgerRow[] = [
  {
    file: 'src/lib/cli-tools/launch-keys.ts',
    site: 'typeLaunchLines',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'Every tool’s launch line, in one exclusive turn (#3981); joins the launcher’s own ticket inside a send.',
    evidence: LAUNCH_EVIDENCE,
  },
  {
    file: 'src/lib/session/claude-session.ts',
    site: 'sendTrustDialogKey',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'claude’s folder-trust Enter at launch, as an exclusive answer (#3975).',
    evidence: 'tests/unit/session/launch-keys-input-lock-3975.test.ts',
  },
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.waitForReady',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    count: 2,
    reason: 'codex’s launch-time update and trust digits, as answers under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/codex-launch-dialog-ticket-3981.test.ts',
  },
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.sendCodexHooksScreenKey',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'caller',
    count: 2,
    reason: 'codex’s hooks-screen keys; only called from `answerCodexHooksScreen`’s `answerUnderInstanceInputLock` (#3952).',
    evidence: 'tests/unit/cli-tools/codex-hooks-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/command-code-plan-review.ts',
    site: 'sendCommandCodePlanReviewKeys',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'caller',
    reason: 'Command Code plan-review comment text; sent by the plan-review answer under the lock, ticket asked before each step (#3952).',
    evidence: 'tests/unit/api/plan-review-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/copilot.ts',
    site: 'typeLeavingMarkOnFailure',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'copilot’s own selection-list and `/model` commands, typed with the owner’s ticket (#3945).',
    evidence: 'tests/unit/cli-tools/copilot-input-lock-3945.test.ts',
  },
  {
    file: 'src/lib/cli-tools/copilot.ts',
    site: 'CopilotTool.answerFolderTrustDialog',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'copilot’s folder-trust digit at launch, as an answer under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/copilot-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'sendUnderInputLock',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'A message body typed by the shared sender, ownership asserted before the key (#3945).',
    evidence: 'tests/unit/cli-tools/submit-verified-sender-input-lock-3945.test.ts',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendPromptAnswerKeys',
    callee: 'sendKeys',
    kind: 'lock',
    held: 'caller',
    reason: 'The Enter after a typed answer; inside the callback `sendAsInputWriter` runs under `answerUnderInstanceInputLock` (#3952).',
    evidence: PROMPT_ANSWER_EVIDENCE,
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'typeText',
    callee: 'sendKeys',
    kind: 'decided-outside',
    reason: 'An answer’s text. Under the writer’s lock when an Enter follows; an `answer_only` digit with no Enter is typed without waiting, by #3952’s decision.',
    evidence: PROMPT_ANSWER_EVIDENCE,
    callersOnLedger: true,
  },
  {
    file: 'src/lib/tmux/control-mode-tmux-transport.ts',
    site: 'ControlModeTmuxTransport.sendInput',
    callee: 'sendKeys',
    kind: 'decided-outside',
    reason: 'A person’s terminal input (WebSocket `terminal_input`): neither refused nor held, by #3952’s decision.',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/lib/tmux/polling-tmux-transport.ts',
    site: 'PollingTmuxTransport.sendInput',
    callee: 'sendKeys',
    kind: 'decided-outside',
    reason: 'The same terminal input on the polling transport: neither refused nor held, by #3952’s decision.',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  { file: 'src/lib/cli-tools/gemini.ts', site: 'GeminiTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/command-code.ts', site: 'CommandCodeTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/copilot.ts', site: 'CopilotTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/opencode.ts', site: 'OpenCodeTool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/cli-tools/opencode-v2.ts', site: 'OpenCodeV2Tool.killSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
  { file: 'src/lib/session-key-sender.ts', site: 'stopSession', callee: 'sendKeys', kind: 'kill', reason: KILL_REASON },
];

/** The tmux writers {@link LEDGER} is reconciled against. */
const SEND_KEYS_WRITERS: readonly string[] = ['sendKeys'];

/**
 * How many un-ordered rows (`decided-outside` + `kill` + `dead`) the ledger
 * may hold. May only go DOWN: lower it when a row moves to `lock` or goes away.
 * 11 -> 9: #4032 removed `sanitizeSessionEnvironment` and `pasted-text-helper.ts`.
 */
export const UNMEDIATED_BASELINE = 9;

const SPECIAL_KEY_KILL_REASON = `${KILL_REASON} The exit keys here are \`sendSpecialKey(s)\` (#4032).`;
const STRICT_ANSWER_EVIDENCE = 'tests/unit/lib/session/strict-prompt-answer-input-lock-3952.test.ts';
const SENDER_EVIDENCE = 'tests/unit/cli-tools/submit-verified-sender-input-lock-3945.test.ts';

/**
 * Every other key writer of the tmux module (Issue #4032): the keys, the
 * clearing keys, a person's direct input. The same rules as {@link LEDGER}.
 */
export const STAGE_2_LEDGER: readonly LedgerRow[] = [
  {
    file: 'src/lib/cli-tools/antigravity.ts',
    site: 'AntigravityTool.waitForReady',
    callee: 'sendSpecialKey',
    kind: 'lock',
    held: 'lexical',
    reason: 'agy’s folder-trust Enter in the launch window, as an answer under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/antigravity-trust-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/antigravity.ts',
    site: 'AntigravityTool.waitForPrompt',
    callee: 'sendSpecialKey',
    kind: 'lock',
    held: 'lexical',
    reason: 'agy’s owed trust Enter after the launch window, claimed and typed under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/antigravity-trust-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.waitForReady',
    callee: 'sendSpecialKey',
    kind: 'lock',
    held: 'lexical',
    reason: 'codex’s launch-time “Press enter to continue”, as an answer under the lock (#3952).',
    evidence: 'tests/unit/cli-tools/codex-launch-dialog-ticket-3981.test.ts',
  },
  {
    file: 'src/lib/cli-tools/gemini.ts',
    site: 'GeminiTool.waitForReady',
    callee: 'sendSpecialKey',
    kind: 'lock',
    held: 'lexical',
    reason: 'gemini’s folder-trust key at launch, as an exclusive answer under the lock (#3975).',
    evidence: 'tests/unit/session/launch-keys-input-lock-3975.test.ts',
  },
  {
    file: 'src/lib/session/claude-session.ts',
    site: 'sendTrustDialogKey',
    callee: 'sendSpecialKeys',
    kind: 'lock',
    held: 'lexical',
    reason: 'claude’s folder-trust keys at launch, as an exclusive answer (#3975).',
    evidence: 'tests/unit/session/launch-keys-input-lock-3975.test.ts',
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'sendUnderInputLock',
    callee: 'sendSpecialKeys',
    kind: 'lock',
    held: 'lexical',
    count: 2,
    reason: 'The shared sender’s submit keys, after ownership is asserted under the ticket (#3945).',
    evidence: SENDER_EVIDENCE,
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'sendUnderInputLock',
    callee: 'clearInputLine',
    kind: 'lock',
    held: 'lexical',
    reason: 'The shared sender clearing its own line under the ticket, before it types (#3945).',
    evidence: SENDER_EVIDENCE,
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'withdrawUnsentBody',
    callee: 'clearInputLine',
    kind: 'lock',
    held: 'lexical',
    reason: 'Taking back a body that was not submitted, only while the ticket is the owner’s (#3945).',
    evidence: SENDER_EVIDENCE,
  },
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.sendCodexHooksScreenKey',
    callee: 'sendSpecialKey',
    kind: 'lock',
    held: 'caller',
    reason: 'codex’s hooks-screen Escape; only called from `answerCodexHooksScreen`’s `answerUnderInstanceInputLock` (#3952).',
    evidence: 'tests/unit/cli-tools/codex-hooks-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/cli-tools/command-code-plan-review.ts',
    site: 'sendCommandCodePlanReviewKeys',
    callee: 'sendSpecialKeys',
    kind: 'lock',
    held: 'caller',
    reason: 'Command Code plan-review keys; sent by the plan-review answer under the lock, ticket asked before each step (#3952).',
    evidence: 'tests/unit/api/plan-review-input-lock-3952.test.ts',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendSpecialKeysWhileCurrent',
    callee: 'sendSpecialKeys',
    kind: 'lock',
    held: 'caller',
    count: 2,
    reason: 'A prompt answer’s cursor and toggle keys; typed inside `sendAsInputWriter`’s callback, which runs under `answerUnderInstanceInputLock` (#3952).',
    evidence: PROMPT_ANSWER_EVIDENCE,
  },
  {
    file: 'src/lib/session/cli-session.ts',
    site: 'sendSessionAnswerKey',
    callee: 'sendSpecialKeys',
    kind: 'lock',
    held: 'caller',
    reason: 'The strict `respond`’s one answer key; its caller holds the strict answer’s ticket (#3952).',
    evidence: STRICT_ANSWER_EVIDENCE,
  },
  {
    file: 'src/lib/session/composer-clear.ts',
    site: 'clearComposer',
    callee: 'clearComposerLine',
    kind: 'lock',
    held: 'caller',
    reason: 'Clearing the composer; every caller runs it under a ticket and asks it before each pass (`beforePass`, #3945).',
    evidence: SENDER_EVIDENCE,
  },
  {
    file: 'src/lib/session/composer-clear.ts',
    site: 'clearComposer',
    callee: 'clearComposerPasteToken',
    kind: 'lock',
    held: 'caller',
    reason: 'Deleting a paste token from the composer, in the same passes as the line clear (#3945).',
    evidence: SENDER_EVIDENCE,
  },
  {
    file: 'src/lib/cli-tools/base.ts',
    site: 'BaseCLITool.interrupt',
    callee: 'sendSpecialKey',
    kind: 'decided-outside',
    reason: 'interrupt’s Escape: never waits for, joins or ends a send in progress, by #3952’s decision (cli-operations-guide).',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/lib/cli-tools/opencode.ts',
    site: 'OpenCodeTool.interrupt',
    callee: 'sendSpecialKey',
    kind: 'decided-outside',
    count: 2,
    reason: 'opencode’s interrupt keys when the server abort did not apply: the same interrupt decision as every tool’s (#3952).',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/lib/cli-tools/direct-input.ts',
    site: 'sendDirectInput',
    callee: 'sendDirectInputAndInvalidate',
    kind: 'decided-outside',
    reason: 'A person’s `direct-input`: neither refused nor held, by #3952’s decision (cli-operations-guide).',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/app/api/worktrees/[id]/special-keys/route.ts',
    site: 'POST',
    callee: 'sendSpecialKeysAndInvalidate',
    kind: 'decided-outside',
    reason: 'A person’s `special-keys` (the unsent bar’s Run among them): neither refused nor held, by #3952’s decision.',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/lib/tmux/control-mode-tmux-transport.ts',
    site: 'ControlModeTmuxTransport.sendSpecialKey',
    callee: 'sendSpecialKey',
    kind: 'decided-outside',
    reason: 'The terminal transport’s special key, beside its `sendInput`: a person’s terminal input, by #3952’s decision (no caller in src today).',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  {
    file: 'src/lib/tmux/polling-tmux-transport.ts',
    site: 'PollingTmuxTransport.sendSpecialKey',
    callee: 'sendSpecialKey',
    kind: 'decided-outside',
    reason: 'The same special key on the polling transport: a person’s terminal input, by #3952’s decision (no caller in src today).',
    evidence: NON_PARTICIPANTS_EVIDENCE,
  },
  { file: 'src/lib/cli-tools/antigravity.ts', site: 'AntigravityTool.killSession', callee: 'sendSpecialKey', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/codex.ts', site: 'CodexTool.killSession', callee: 'sendSpecialKey', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/copilot.ts', site: 'CopilotTool.killSession', callee: 'sendSpecialKey', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/gemini.ts', site: 'GeminiTool.killSession', callee: 'sendSpecialKey', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/vibe-local.ts', site: 'VibeLocalTool.killSession', callee: 'sendSpecialKey', kind: 'kill', count: 2, reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/session-key-sender.ts', site: 'stopSession', callee: 'sendSpecialKey', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/command-code.ts', site: 'CommandCodeTool.killSession', callee: 'sendSpecialKeys', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/copilot.ts', site: 'CopilotTool.killSession', callee: 'sendSpecialKeys', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/opencode.ts', site: 'OpenCodeTool.killSession', callee: 'sendSpecialKeys', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
  { file: 'src/lib/cli-tools/opencode-v2.ts', site: 'OpenCodeV2Tool.killSession', callee: 'sendSpecialKeys', kind: 'kill', reason: SPECIAL_KEY_KILL_REASON },
];

/** The tmux writers {@link STAGE_2_LEDGER} is reconciled against: every one but `sendKeys`. */
const STAGE_2_WRITERS: readonly string[] = KEY_WRITERS.filter((w) => !SEND_KEYS_WRITERS.includes(w));

/** {@link UNMEDIATED_BASELINE} of {@link STAGE_2_LEDGER}. May only go DOWN. */
export const STAGE_2_UNMEDIATED_BASELINE = 16;

interface CallerRow {
  file: string;
  /** Innermost named function holding the call (as for {@link LedgerRow.site}). */
  site: string;
  /** The ledger row's function being called. */
  callee: string;
  /** `lexical`: the call sits in a function passed to the lock (checked). `listed`: the reason says how. */
  held: 'lexical' | 'listed';
  /** References this row covers; 1 when omitted. */
  count?: number;
  reason: string;
}

/**
 * Every caller of a ledger row whose lock is held by its caller (review P2-1).
 * A new caller — from a function that does not hold the lock — fails until it
 * is put here, and as `listed` only if {@link LISTED_CALLER_BASELINE} allows.
 */
export const CALLER_LEDGER: readonly CallerRow[] = [
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.answerCodexHooksScreen',
    callee: 'sendCodexHooksScreenKey',
    held: 'lexical',
    reason: 'The hooks-screen key is the answer callback of `answerUnderInstanceInputLock` (#3952).',
  },
  {
    file: 'src/app/api/worktrees/[id]/prompt-response/plan-review.ts',
    site: 'answerCommandCodePlanReview',
    callee: 'sendCommandCodePlanReviewKeys',
    held: 'lexical',
    reason: 'The plan-review keys are the answer callback of `answerUnderInstanceInputLock`, each step while the ticket is current (#3952).',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendPromptAnswer',
    callee: 'sendPromptAnswerKeys',
    held: 'listed',
    reason: '`sendPromptAnswer` only adds `keysSent`; the keys’ Enter goes out inside `sendAsInputWriter`’s callback, which runs under `answerUnderInstanceInputLock` (#3952).',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendPromptAnswerKeys',
    callee: 'typeText',
    held: 'listed',
    count: 2,
    reason: 'Text with an Enter: inside `sendAsInputWriter`’s callback (the lock). An `answer_only` digit with no Enter: outside, by #3952’s decision.',
  },
];

/** How many `listed` callers {@link CALLER_LEDGER} may hold. May only go DOWN. */
export const LISTED_CALLER_BASELINE = 2;

/** {@link CALLER_LEDGER} of {@link STAGE_2_LEDGER} (Issue #4032). */
export const STAGE_2_CALLER_LEDGER: readonly CallerRow[] = [
  {
    file: 'src/lib/cli-tools/codex.ts',
    site: 'CodexTool.answerCodexHooksScreen',
    callee: 'sendCodexHooksScreenKey',
    held: 'lexical',
    reason: 'The hooks-screen key is the answer callback of `answerUnderInstanceInputLock` (#3952).',
  },
  {
    file: 'src/app/api/worktrees/[id]/prompt-response/plan-review.ts',
    site: 'answerCommandCodePlanReview',
    callee: 'sendCommandCodePlanReviewKeys',
    held: 'lexical',
    reason: 'The plan-review keys are the answer callback of `answerUnderInstanceInputLock`, each step while the ticket is current (#3952).',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendCommandCodeMultiSelectAnswer',
    callee: 'sendSpecialKeysWhileCurrent',
    held: 'listed',
    count: 3,
    reason: 'Command Code’s multi-select toggles, walk and confirm; the function is only called inside `sendAsInputWriter`’s callback in `sendPromptAnswerKeys` (the lock), with its `assertOwned` before each key (#3952).',
  },
  {
    file: 'src/lib/prompt-answer-sender.ts',
    site: 'sendPromptAnswerKeys',
    callee: 'sendSpecialKeysWhileCurrent',
    held: 'listed',
    reason: 'A choice’s cursor keys, inside `sendAsInputWriter`’s callback, which runs under `answerUnderInstanceInputLock` (#3952).',
  },
  {
    file: 'src/lib/session/strict-prompt-answer-io.ts',
    site: 'createStrictRespondDeps',
    callee: 'sendSessionAnswerKey',
    held: 'lexical',
    reason: 'The strict respond’s key, in the deps built for its ticket; refused once the ticket is not current (#3952).',
  },
  {
    file: 'src/app/api/worktrees/[id]/clear-composer/route.ts',
    site: 'POST',
    callee: 'clearComposer',
    held: 'lexical',
    reason: 'The [Clear] button’s clear, in the route’s `withInstanceInputLock` callback, asking the ticket before each pass (#3945).',
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'withdrawUnsentBody',
    callee: 'clearComposer',
    held: 'lexical',
    reason: 'The withdrawal’s clear, in a function that takes the send’s ticket (#3945).',
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'waitOutCarriedPaste',
    callee: 'clearComposer',
    held: 'lexical',
    reason: 'The clear after a carried paste, in a function that takes the send’s ticket (#3945).',
  },
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'clearComposerBeforeSend',
    callee: 'clearComposer',
    held: 'lexical',
    reason: 'The clear before a send types, in a function that takes the send’s ticket (#3945).',
  },
];

/** {@link LISTED_CALLER_BASELINE} of {@link STAGE_2_CALLER_LEDGER}. May only go DOWN. */
export const STAGE_2_LISTED_CALLER_BASELINE = 2;

interface RawWriteRow {
  file: string;
  site: string;
  command: string;
  count?: number;
  reason: string;
}

/**
 * `send-keys` / `paste-buffer` composed outside the tmux module (Issue #4032):
 * not key-writer references, so not on the ledgers above, but each with its
 * reason. A new one fails until it is put here.
 */
export const RAW_KEY_WRITES: readonly RawWriteRow[] = [
  {
    file: 'src/lib/cli-tools/submit-verified-sender.ts',
    site: 'pasteBody',
    command: 'paste-buffer',
    reason: 'The shared sender’s paste of a body, after `assertInputOwner` under the send’s ticket (#3945); the `sendUnderInputLock` row’s evidence covers it.',
  },
  {
    file: 'src/lib/tmux/key-sequence.ts',
    site: 'keySequenceArgs',
    command: 'send-keys',
    count: 2,
    reason: 'The argv builder `sendKeys` types its literal text through; not a writer of its own while its callers are the ones on KEY_SEQUENCE_CALLERS.',
  },
  {
    file: 'src/lib/tmux/tmux-control-client.ts',
    site: 'TmuxControlClient.sendInput',
    command: 'send-keys',
    reason: 'The control-mode client’s `send-keys -H` for a person’s terminal input (#2767), reached from the control-mode transport’s `sendInput` row: decided outside the lock (#3952).',
  },
];

const rawKeyOf = (r: { file: string; site: string; command: string }): string => `${r.file} :: ${r.site} :: ${r.command}`;

const KEY_SEQUENCE_MODULE = 'src/lib/tmux/key-sequence.ts';

/**
 * Every caller of `key-sequence.ts`'s `send-keys` builders (review-4032 P3-2):
 * the raw row above holds only while `keySequenceArgs` is reached from
 * `sendKeys` (a writer on {@link LEDGER}) and the module's own
 * `runKeySequence`, which nothing in src calls. A new caller of either is a
 * key writer nobody ledgered, and fails.
 */
export const KEY_SEQUENCE_CALLERS: readonly { file: string; site: string; callee: string; count?: number }[] = [
  { file: 'src/lib/tmux/tmux.ts', site: 'sendKeys', callee: 'keySequenceArgs' },
  { file: KEY_SEQUENCE_MODULE, site: 'runKeySequence', callee: 'keySequenceArgs' },
];

const KEY_SEQUENCE_BUILDERS: readonly string[] = ['keySequenceArgs', 'runKeySequence'];

/** What is wrong between the callers of the key-sequence builders and {@link KEY_SEQUENCE_CALLERS}. */
export function reconcileKeySequenceCallers(found: readonly KeySite[], ledger = KEY_SEQUENCE_CALLERS): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, number>();
  for (const s of found) byKey.set(keyOf(s), (byKey.get(keyOf(s)) ?? 0) + 1);
  const rows = new Map(ledger.map((r) => [keyOf(r), r]));
  for (const [key, n] of byKey) {
    const row = rows.get(key);
    if (row === undefined) problems.push(`key-sequence caller not on the ledger: ${key}`);
    else if (n !== (row.count ?? 1)) problems.push(`key-sequence caller count changed: ${key} has ${n}, the ledger says ${row.count ?? 1}`);
  }
  for (const key of rows.keys()) if (!byKey.has(key)) problems.push(`key-sequence caller row with no call behind it: ${key}`);
  return problems;
}

const scanKeySequenceCallers = (): KeySite[] => KEY_SEQUENCE_BUILDERS.flatMap((name) => scanCallers(KEY_SEQUENCE_MODULE, name));

/** What is wrong between the raw writes found and {@link RAW_KEY_WRITES}. Empty when they agree. */
export function reconcileRaw(found: readonly RawKeyWrite[], ledger: readonly RawWriteRow[]): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, RawKeyWrite[]>();
  for (const w of found) byKey.set(rawKeyOf(w), [...(byKey.get(rawKeyOf(w)) ?? []), w]);
  const rows = new Map(ledger.map((r) => [rawKeyOf(r), r]));
  for (const [key, writes] of byKey) {
    const row = rows.get(key);
    if (row === undefined) problems.push(`raw key write not on the ledger: ${key} (lines ${writes.map((w) => w.line).join(', ')})`);
    else if (writes.length !== (row.count ?? 1)) problems.push(`raw write count changed: ${key} has ${writes.length}, the ledger says ${row.count ?? 1}`);
  }
  for (const key of rows.keys()) if (!byKey.has(key)) problems.push(`raw row with no write behind it: ${key}`);
  return problems;
}

const functionName = (site: string): string => site.split('.').pop() as string;

/**
 * The ledger rows whose callers {@link CALLER_LEDGER} covers — one per
 * function, since one function may type through several writers (#4032).
 */
const callerGuarded = (ledger: readonly LedgerRow[]): LedgerRow[] => {
  const seen = new Set<string>();
  return ledger.filter((r) => {
    if (!((r.kind === 'lock' && r.held === 'caller') || r.callersOnLedger === true)) return false;
    const key = `${r.file} :: ${functionName(r.site)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Every caller of the guarded rows' functions in `src` today. */
function scanGuardedCallers(ledger: readonly LedgerRow[] = LEDGER): KeySite[] {
  return callerGuarded(ledger).flatMap((r) => scanCallers(r.file, functionName(r.site)));
}

/** What is wrong between the callers found and the caller ledger. Empty when they agree. */
export function reconcileCallers(
  callers: readonly KeySite[],
  ledger: readonly CallerRow[],
  guarded: readonly LedgerRow[] = callerGuarded(LEDGER),
  baseline = LISTED_CALLER_BASELINE
): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, KeySite[]>();
  for (const site of callers) byKey.set(keyOf(site), [...(byKey.get(keyOf(site)) ?? []), site]);
  const rows = new Map(ledger.map((r) => [keyOf(r), r]));
  for (const [key, found] of byKey) {
    const row = rows.get(key);
    if (row === undefined) {
      problems.push(`caller not on the ledger: ${key} (lines ${found.map((s) => s.line).join(', ')})`);
      continue;
    }
    if (found.length !== (row.count ?? 1)) {
      problems.push(`caller count changed: ${key} has ${found.length}, the ledger says ${row.count ?? 1}`);
    }
    if (row.held === 'lexical') {
      for (const site of found.filter((s) => !s.lexicallyLocked)) {
        problems.push(`caller no longer under the lock in the source: ${key} (line ${site.line})`);
      }
    }
  }
  for (const key of rows.keys()) {
    if (!byKey.has(key)) problems.push(`caller row with no call behind it: ${key}`);
  }
  for (const row of guarded) {
    if (!ledger.some((c) => c.callee === functionName(row.site))) {
      problems.push(`no caller on the ledger for: ${keyOf(row)}`);
    }
  }
  const listed = ledger.filter((r) => r.held === 'listed').length;
  if (listed > baseline) problems.push(`listed callers went up: ${listed} > ${baseline}`);
  return problems;
}

/**
 * Out of this ledger's reach but on the same invariant, tracked for a later
 * Issue (#3981 横展開): they type through the shared sender, so they are not
 * `sendKeys` sites, but their readiness is not decided before the keys.
 *
 * Issue #4032 recorded them, by its contract's decision, without changing them:
 * each changes when a send is typed, which that refactor was not to change.
 */
const READINESS_FOLLOW_UP_REASON =
  'Recorded, not fixed, by #4032’s decision: deciding readiness before the keys changes when a send is typed (a behaviour change). 追跡: #4040.';
const READINESS_FOLLOW_UPS: readonly { file: string; what: string; reason: string }[] = [
  { file: 'src/lib/cli-tools/copilot.ts', what: 'the normal send drops `ready: false` from its prompt wait', reason: READINESS_FOLLOW_UP_REASON },
  { file: 'src/lib/cli-tools/vibe-local.ts', what: 'no readiness wait before a send', reason: READINESS_FOLLOW_UP_REASON },
  { file: 'src/lib/cli-tools/opencode.ts', what: 'the tmux fallback when no server can be attached', reason: READINESS_FOLLOW_UP_REASON },
];

/** The source with its comments taken out, so prose naming a function is not a use. */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const LOCK_EVIDENCE = /currentInstanceInputTicket|withInstanceInputLock|answerUnderInstanceInputLock/;

/**
 * What is wrong with a `lock` row's evidence test, given its text: it must run
 * the lock, and name the site's function (Issue #4032, review-3981 P3-6) — a
 * test of the lock that never mentions the site says nothing about the site.
 */
export function lockEvidenceProblems(row: LedgerRow, text: string): string[] {
  if (row.kind !== 'lock' || row.evidence === undefined) return [];
  const problems: string[] = [];
  // Read without its comments (Issue #4032 review P3-3): a site named only in
  // prose is not a site the test drives.
  const code = codeOf(text);
  if (!LOCK_EVIDENCE.test(code)) problems.push(`lock evidence does not run the lock: ${keyOf(row)} (${row.evidence})`);
  const name = functionName(row.site);
  if (!new RegExp(`\\b${name}\\b`).test(code)) {
    problems.push(`lock evidence never names its site \`${name}\`: ${keyOf(row)} (${row.evidence})`);
  }
  return problems;
}

const keyOf = (r: { file: string; site: string; callee: string }): string => `${r.file} :: ${r.site} :: ${r.callee}`;

/** What is wrong between the sites found and a ledger. Empty when they agree. */
export function reconcile(
  sites: readonly KeySite[],
  ledger: readonly LedgerRow[],
  baseline = UNMEDIATED_BASELINE,
  writers: readonly string[] = SEND_KEYS_WRITERS
): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, KeySite[]>();
  for (const site of sites.filter((s) => writers.includes(s.callee))) byKey.set(keyOf(site), [...(byKey.get(keyOf(site)) ?? []), site]);
  const rows = new Map(ledger.map((r) => [keyOf(r), r]));

  for (const [key, found] of byKey) {
    const row = rows.get(key);
    if (row === undefined) {
      problems.push(`not on the ledger: ${key} (lines ${found.map((s) => s.line).join(', ')})`);
      continue;
    }
    if (found.length !== (row.count ?? 1)) {
      problems.push(`count changed: ${key} has ${found.length}, the ledger says ${row.count ?? 1}`);
    }
    if (row.kind === 'lock' && row.held === 'lexical') {
      for (const site of found.filter((s) => !s.lexicallyLocked)) {
        problems.push(`no longer under the lock in the source: ${key} (line ${site.line})`);
      }
    }
  }
  for (const key of rows.keys()) {
    if (!byKey.has(key)) problems.push(`ledger row with no site behind it: ${key}`);
  }
  for (const row of ledger) {
    if (!writers.includes(row.callee)) problems.push(`row for a writer this ledger does not cover: ${keyOf(row)}`);
    if (row.kind === 'lock' && row.held === undefined) problems.push(`lock row without \`held\`: ${keyOf(row)}`);
    if ((row.kind === 'lock' || row.kind === 'decided-outside') && row.evidence === undefined) {
      problems.push(`${row.kind} row without an evidence test: ${keyOf(row)}`);
    }
  }
  const unmediated = ledger.filter((r) => r.kind !== 'lock').length;
  if (unmediated > baseline) problems.push(`un-ordered rows went up: ${unmediated} > ${baseline}`);
  return problems;
}

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8');

describe('[#3981] every pane key writer in src is on the ledger', () => {
  it('the scan of src agrees with the ledger (negative control: today’s tree passes)', () => {
    expect(reconcile(scanRepository(), LEDGER)).toEqual([]);
  });

  it('every evidence test exists; a lock row’s runs the lock', () => {
    for (const row of LEDGER) {
      if (row.evidence === undefined) continue;
      expect(existsSync(join(REPO_ROOT, row.evidence)), `${row.evidence} is missing`).toBe(true);
      if (row.kind === 'lock') expect(read(row.evidence), row.evidence).toMatch(LOCK_EVIDENCE);
    }
  });

  it('every row states a reason', () => {
    for (const row of LEDGER) expect(row.reason.length, keyOf(row)).toBeGreaterThan(40);
  });

  it('the un-ordered rows are at the baseline (lower it when one goes)', () => {
    expect(LEDGER.filter((r) => r.kind !== 'lock')).toHaveLength(UNMEDIATED_BASELINE);
  });

  it('a `dead` row is dead: no other file in src names its function', () => {
    for (const row of LEDGER.filter((r) => r.kind === 'dead')) {
      const name = row.site.split('.').pop() as string;
      const callers = srcFiles().filter((f) => f !== row.file && new RegExp(`\\b${name}\\b`).test(codeOf(read(f))));
      expect(callers, keyOf(row)).toEqual([]);
    }
  });

  it('the readiness follow-ups still name files that exist', () => {
    for (const { file, what } of READINESS_FOLLOW_UPS) {
      expect(existsSync(join(REPO_ROOT, file)), what).toBe(true);
    }
  });
});

describe('[#3981 review P2-1] every caller of a caller-held row is on the caller ledger', () => {
  it('negative control: today’s callers agree with the caller ledger', () => {
    expect(reconcileCallers(scanGuardedCallers(), CALLER_LEDGER)).toEqual([]);
  });

  it('the guarded rows are the four whose lock is the caller’s', () => {
    expect(callerGuarded(LEDGER).map((r) => functionName(r.site)).sort()).toEqual([
      'sendCodexHooksScreenKey',
      'sendCommandCodePlanReviewKeys',
      'sendPromptAnswerKeys',
      'typeText',
    ]);
  });

  it('every caller row states a reason, and its file can call the function', () => {
    const guarded = callerGuarded(LEDGER);
    for (const row of CALLER_LEDGER) {
      expect(row.reason.length, keyOf(row)).toBeGreaterThan(40);
      const defining = guarded.find((r) => functionName(r.site) === row.callee);
      expect(defining, keyOf(row)).toBeDefined();
      expect(callerFiles((defining as LedgerRow).file), keyOf(row)).toContain(row.file);
    }
  });

  /** Today's callers, with `file`'s replaced by a scan of `text`. */
  const withFile = (file: string, text: string, callee: string): KeySite[] =>
    scanGuardedCallers().filter((s) => s.file !== file).concat(
      scanGuardedCallers().filter((s) => s.file === file && s.callee !== callee),
      scanReferences(file, text, [callee])
    );

  const ROGUE =
    "import { sendCommandCodePlanReviewKeys } from '@/lib/cli-tools/command-code-plan-review';\nexport async function rogue(s: string) { await sendCommandCodePlanReviewKeys(s, []); }\n";

  const mutations: Array<{ callee: string; file: string; edit: (src: string) => string }> = [
    {
      callee: 'sendPromptAnswerKeys',
      file: 'src/lib/prompt-answer-sender.ts',
      edit: (src) =>
        `${src}\nexport async function answerWithoutLock(p: SendPromptAnswerParams): Promise<void> {\n  await sendPromptAnswerKeys(p, { touched: false });\n}\n`,
    },
    {
      callee: 'typeText',
      file: 'src/lib/prompt-answer-sender.ts',
      edit: (src) => src.replace('      await typeText();\n', '      await typeText();\n      await typeText();\n'),
    },
    {
      callee: 'sendCodexHooksScreenKey',
      file: 'src/lib/cli-tools/codex.ts',
      edit: (src) =>
        src.replace(
          '  private async sendCodexHooksScreenKey(',
          "  private async answerHooksDirectly(s: string): Promise<void> {\n    await this.sendCodexHooksScreenKey(s, 'review' as never, 1, false);\n  }\n\n  private async sendCodexHooksScreenKey("
        ),
    },
    {
      callee: 'sendCommandCodePlanReviewKeys',
      file: 'src/app/api/worktrees/[id]/prompt-response/plan-review.ts',
      edit: (src) =>
        `${src}\nexport async function sendPlanDirectly(s: string): Promise<void> {\n  await sendCommandCodePlanReviewKeys(s, []);\n}\n`,
    },
  ];

  for (const { callee, file, edit } of mutations) {
    it(`positive: one more caller of \`${callee}\` outside the lock fails`, () => {
      const original = read(file);
      const mutated = edit(original);
      expect(mutated).not.toBe(original);
      const problems = reconcileCallers(withFile(file, mutated, callee), CALLER_LEDGER);
      expect(problems.length, problems.join('\n')).toBeGreaterThan(0);
      expect(problems.every((p) => p.includes(callee)), problems.join('\n')).toBe(true);
    });
  }

  it('positive: a caller from another module that imports the function is found too', () => {
    const found = scanReferences('src/lib/rogue.ts', ROGUE, ['sendCommandCodePlanReviewKeys']);
    expect(found.map((s) => s.site)).toEqual(['rogue']);
    expect(reconcileCallers([...scanGuardedCallers(), ...found], CALLER_LEDGER)).toEqual([
      expect.stringContaining('caller not on the ledger: src/lib/rogue.ts :: rogue :: sendCommandCodePlanReviewKeys'),
    ]);
  });

  it('positive: taking the lock off a `lexical` caller fails (codex’s `answerUnderInstanceInputLock` renamed away)', () => {
    const file = 'src/lib/cli-tools/codex.ts';
    const mutated = read(file).replace(/answerUnderInstanceInputLock\(/g, 'notALock(');
    expect(reconcileCallers(withFile(file, mutated, 'sendCodexHooksScreenKey'), CALLER_LEDGER)).toEqual([
      expect.stringContaining('caller no longer under the lock in the source: src/lib/cli-tools/codex.ts :: CodexTool.answerCodexHooksScreen'),
    ]);
  });

  it('positive: putting the new caller on the ledger as `listed` fails the baseline', () => {
    const found = scanReferences('src/lib/rogue.ts', ROGUE, ['sendCommandCodePlanReviewKeys']);
    const row: CallerRow = { file: 'src/lib/rogue.ts', site: 'rogue', callee: 'sendCommandCodePlanReviewKeys', held: 'listed', reason: 'fixture' };
    expect(reconcileCallers([...scanGuardedCallers(), ...found], [...CALLER_LEDGER, row])).toEqual([
      expect.stringContaining('listed callers went up'),
    ]);
  });

  it('negative: a new caller under the lock, put on the ledger as `lexical`, passes', () => {
    const text =
      "import { sendCommandCodePlanReviewKeys } from '@/lib/cli-tools/command-code-plan-review';\nimport { withInstanceInputLock } from '@/lib/session/instance-input-lock';\nexport async function locked(s: string) { await withInstanceInputLock(s, () => sendCommandCodePlanReviewKeys(s, [])); }\n";
    const found = scanReferences('src/lib/locked.ts', text, ['sendCommandCodePlanReviewKeys']);
    const row: CallerRow = { file: 'src/lib/locked.ts', site: 'locked', callee: 'sendCommandCodePlanReviewKeys', held: 'lexical', reason: 'fixture' };
    expect(reconcileCallers([...scanGuardedCallers(), ...found], [...CALLER_LEDGER, row])).toEqual([]);
  });

  it('negative: declarations, imports, another object’s property and prose are not callers', () => {
    const text =
      "import { typeText } from './x';\n/** typeText() */\nconst o = { typeText: 1 };\nother.typeText();\nfunction typeText2() {}\nclass C { typeText() {} }\n";
    expect(scanReferences('src/lib/x.ts', text, ['typeText'])).toEqual([]);
  });
});

describe('[#3981] the scanner and the rules are not vacuous', () => {
  const TMUX = "import { sendKeys } from '../tmux/tmux';\n";

  it('positive: a new `sendKeys(` that is not on the ledger fails', () => {
    const sites = [...scanRepository(), ...scanKeyWriters('src/lib/x.ts', `${TMUX}export async function f(s: string) { await sendKeys(s, 'x', true); }\n`)];
    expect(reconcile(sites, LEDGER)).toEqual([expect.stringContaining('not on the ledger: src/lib/x.ts :: f :: sendKeys')]);
  });

  it('positive: a wrapper nobody has named is still a site — renamed, namespaced, dynamic, or handed on', () => {
    const cases: Array<[string, string]> = [
      ["import { sendKeys as typeIt } from '@/lib/tmux/tmux';\nconst helper = async (s: string) => typeIt(s, 'x', true);\n", 'helper'],
      ["import * as tmux from '../tmux/tmux';\nclass A { async go(s: string) { await tmux.sendKeys(s, 'x', true); } }\n", 'A.go'],
      ["async function late(s: string) { const { sendKeys } = await import('@/lib/tmux/tmux'); await sendKeys(s, 'x', true); }\n", 'late'],
      [`${TMUX}function retry(fn: unknown) { return fn; }\nexport function wire() { return retry(sendKeys); }\n`, 'wire'],
      ["export { sendKeys } from '../tmux/tmux';\n", '<re-export>'],
    ];
    for (const [text, site] of cases) {
      const found = scanKeyWriters('src/lib/x.ts', text);
      expect(found.map((s) => s.site), text).toEqual([site]);
      expect(reconcile([...scanRepository(), ...found], LEDGER), text).toHaveLength(1);
    }
  });

  it('negative: prose, another module’s `sendKeys`, and a property of that name are not sites', () => {
    const text =
      "import { capturePane } from '../tmux/tmux';\n/** sendKeys(s, 'x') */\nconst sendKeys = (k: string[]) => k;\nobj.sendKeys(['a']);\nsendKeys(['b']);\n";
    expect(scanKeyWriters('src/lib/x.ts', text)).toEqual([]);
  });

  it('positive: taking the lock off a `lexical` lock row fails (launch-keys without its wrapper)', () => {
    const file = 'src/lib/cli-tools/launch-keys.ts';
    const original = read(file);
    const unwrapped = original.replace('await withInstanceInputLock(sessionName, async () => {', 'await (async () => {').replace(/\n {2}\}\);\n\}\n?$/, '\n  })();\n}\n');
    expect(unwrapped).not.toBe(original);
    const sites = scanRepository().filter((s) => s.file !== file).concat(scanKeyWriters(file, unwrapped));
    expect(reconcile(sites, LEDGER)).toEqual([expect.stringContaining('no longer under the lock in the source: src/lib/cli-tools/launch-keys.ts')]);
  });

  it('positive: the same for claude’s trust Enter (its `answerUnderInstanceInputLock` taken off)', () => {
    const file = 'src/lib/session/claude-session.ts';
    const original = read(file);
    const unwrapped = original.replace(/answerUnderInstanceInputLock\(/g, 'notALock(');
    expect(unwrapped).not.toBe(original);
    const sites = scanRepository().filter((s) => s.file !== file).concat(scanKeyWriters(file, unwrapped));
    expect(reconcile(sites, LEDGER)).toEqual([expect.stringContaining('no longer under the lock in the source: src/lib/session/claude-session.ts :: sendTrustDialogKey')]);
  });

  it('negative: one more `lock` row, with its site and evidence, passes', () => {
    const text = "import { sendKeys } from '../tmux/tmux';\nimport { withInstanceInputLock } from '../session/instance-input-lock';\nexport async function g(s: string) { await withInstanceInputLock(s, () => sendKeys(s, 'x', true)); }\n";
    const row: LedgerRow = { file: 'src/lib/y.ts', site: 'g', callee: 'sendKeys', kind: 'lock', held: 'lexical', reason: 'fixture', evidence: LAUNCH_EVIDENCE };
    expect(reconcile([...scanRepository(), ...scanKeyWriters('src/lib/y.ts', text)], [...LEDGER, row])).toEqual([]);
  });

  it('positive: one more un-ordered row fails, even with its site behind it', () => {
    const text = `${TMUX}export async function h(s: string) { await sendKeys(s, 'x', true); }\n`;
    const row: LedgerRow = { file: 'src/lib/z.ts', site: 'h', callee: 'sendKeys', kind: 'kill', reason: 'fixture' };
    expect(reconcile([...scanRepository(), ...scanKeyWriters('src/lib/z.ts', text)], [...LEDGER, row])).toEqual([
      expect.stringContaining('un-ordered rows went up'),
    ]);
  });

  it('positive: a `decided-outside` row without an evidence test fails', () => {
    const ledger = LEDGER.map((r) => (r.kind === 'decided-outside' ? { ...r, evidence: undefined } : r));
    expect(reconcile(scanRepository(), ledger).filter((p) => p.includes('without an evidence test'))).toHaveLength(3);
  });

  it('the walk reached every ledger file', () => {
    const files = candidateFiles();
    for (const row of LEDGER) expect(files, row.file).toContain(row.file);
  });
});

describe('[#4032] every other tmux key writer is on the stage-2 ledger', () => {
  const reconcileStage2 = (sites: readonly KeySite[], ledger: readonly LedgerRow[] = STAGE_2_LEDGER): string[] =>
    reconcile(sites, ledger, STAGE_2_UNMEDIATED_BASELINE, STAGE_2_WRITERS);

  it('the writers are the tmux module’s, read off it; the two ledgers split them', () => {
    expect([...KEY_WRITERS].sort()).toEqual(tmuxKeyWriterExports(read(TMUX_MODULE)));
    expect([...SEND_KEYS_WRITERS, ...STAGE_2_WRITERS].sort()).toEqual([...KEY_WRITERS].sort());
    expect(SEND_KEYS_WRITERS.filter((w) => STAGE_2_WRITERS.includes(w))).toEqual([]);
  });

  it('positive: a new exported writer of the tmux module — or a wrapper of one — is read off it', () => {
    const text =
      "import { execFile } from 'child_process';\n" +
      "export async function capturePane(s: string) { return execFile('tmux', ['capture-pane', '-t', s]); }\n" +
      "export async function sendKeys(s: string, k: string) { await execFile('tmux', ['send-keys', '-t', s, k]); }\n" +
      "async function typeTab(s: string) { await sendKeys(s, 'Tab'); }\n" +
      "export async function sendTab(s: string) { await typeTab(s); }\n" +
      "export async function pasteIt(s: string) { await execFile('tmux', ['paste-buffer', '-t', s]); }\n";
    expect(tmuxKeyWriterExports(text)).toEqual(['pasteIt', 'sendKeys', 'sendTab']);
  });

  it('negative control: the scan of src agrees with the stage-2 ledger', () => {
    expect(reconcileStage2(scanRepository())).toEqual([]);
  });

  it('the stage-2 un-ordered rows are at their baseline (lower it when one goes)', () => {
    expect(STAGE_2_LEDGER.filter((r) => r.kind !== 'lock')).toHaveLength(STAGE_2_UNMEDIATED_BASELINE);
  });

  it('every stage-2 row states a reason, and its file was reached by the walk', () => {
    const files = candidateFiles();
    for (const row of STAGE_2_LEDGER) {
      expect(row.reason.length, keyOf(row)).toBeGreaterThan(40);
      expect(files, row.file).toContain(row.file);
      if (row.kind === 'lock' || row.kind === 'decided-outside') {
        expect(row.evidence !== undefined && existsSync(join(REPO_ROOT, row.evidence)), keyOf(row)).toBe(true);
      }
    }
  });

  it('no ledger holds a `dead` row of the stage-2 writers', () => {
    expect(STAGE_2_LEDGER.filter((r) => r.kind === 'dead')).toEqual([]);
  });

  it('no ledger holds a `dead` row at all (#4032 removed the last two)', () => {
    expect([...LEDGER, ...STAGE_2_LEDGER].filter((r) => r.kind === 'dead')).toEqual([]);
  });

  it('positive: a new `sendSpecialKey(` outside the lock fails', () => {
    const text = "import { sendSpecialKey } from '../tmux/tmux';\nexport async function pressEnter(s: string) { await sendSpecialKey(s, 'Enter'); }\n";
    expect(reconcileStage2([...scanRepository(), ...scanKeyWriters('src/lib/x.ts', text)])).toEqual([
      expect.stringContaining('not on the ledger: src/lib/x.ts :: pressEnter :: sendSpecialKey'),
    ]);
  });

  it('positive: one more `sendSpecialKey(` in a function already on the ledger fails its count', () => {
    const file = 'src/lib/cli-tools/base.ts';
    const original = read(file);
    const mutated = original.replace("    await sendSpecialKey(sessionName, 'Escape');\n", "    await sendSpecialKey(sessionName, 'Escape');\n    await sendSpecialKey(sessionName, 'Enter');\n");
    expect(mutated).not.toBe(original);
    const sites = scanRepository().filter((s) => s.file !== file).concat(scanKeyWriters(file, mutated));
    expect(reconcileStage2(sites)).toEqual([expect.stringContaining('count changed: src/lib/cli-tools/base.ts :: BaseCLITool.interrupt :: sendSpecialKey')]);
  });

  it('positive: a renamed or namespaced `sendSpecialKey` is a site too', () => {
    for (const text of [
      "import { sendSpecialKey as press } from '@/lib/tmux/tmux';\nexport const go = (s: string) => press(s, 'Enter');\n",
      "import * as tmux from '../tmux/tmux';\nexport async function go(s: string) { await tmux.sendSpecialKey(s, 'Enter'); }\n",
    ]) {
      expect(reconcileStage2([...scanRepository(), ...scanKeyWriters('src/lib/x.ts', text)]), text).toEqual([
        expect.stringContaining('not on the ledger: src/lib/x.ts :: go :: sendSpecialKey'),
      ]);
    }
  });

  it('negative: a method named like a writer is not a site (a transport’s `sendSpecialKey`)', () => {
    const text = "import { capturePane } from '../tmux/tmux';\nclass T { async sendSpecialKey(s: string) { return s; } }\n";
    expect(scanKeyWriters('src/lib/x.ts', text)).toEqual([]);
  });

  it('positive: taking the lock off agy’s trust Enter fails both of its rows', () => {
    const file = 'src/lib/cli-tools/antigravity.ts';
    const mutated = read(file).replace(/answerUnderInstanceInputLock\(/g, 'notALock(');
    const sites = scanRepository().filter((s) => s.file !== file).concat(scanKeyWriters(file, mutated));
    expect(reconcileStage2(sites)).toEqual([
      expect.stringContaining('no longer under the lock in the source: src/lib/cli-tools/antigravity.ts :: AntigravityTool.waitForReady'),
      expect.stringContaining('no longer under the lock in the source: src/lib/cli-tools/antigravity.ts :: AntigravityTool.waitForPrompt'),
    ]);
  });

  it('positive: one more un-ordered stage-2 row fails, even with its site behind it', () => {
    const text = "import { sendSpecialKey } from '../tmux/tmux';\nexport async function h(s: string) { await sendSpecialKey(s, 'C-c'); }\n";
    const row: LedgerRow = { file: 'src/lib/z.ts', site: 'h', callee: 'sendSpecialKey', kind: 'kill', reason: 'fixture' };
    expect(reconcileStage2([...scanRepository(), ...scanKeyWriters('src/lib/z.ts', text)], [...STAGE_2_LEDGER, row])).toEqual([
      expect.stringContaining('un-ordered rows went up'),
    ]);
  });

  it('positive: a `sendKeys` row put on the stage-2 ledger fails (each ledger keeps its writers)', () => {
    const row = LEDGER[0];
    expect(reconcileStage2(scanRepository(), [...STAGE_2_LEDGER, row])).toEqual([
      expect.stringContaining(`ledger row with no site behind it: ${keyOf(row)}`),
      expect.stringContaining(`row for a writer this ledger does not cover: ${keyOf(row)}`),
    ]);
  });
});

describe('[#4032] the stage-2 caller-held rows have their callers on a ledger', () => {
  const guarded = callerGuarded(STAGE_2_LEDGER);
  const reconcileStage2Callers = (callers: readonly KeySite[], ledger: readonly CallerRow[] = STAGE_2_CALLER_LEDGER): string[] =>
    reconcileCallers(callers, ledger, guarded, STAGE_2_LISTED_CALLER_BASELINE);

  it('negative control: today’s callers agree with the stage-2 caller ledger', () => {
    expect(reconcileStage2Callers(scanGuardedCallers(STAGE_2_LEDGER))).toEqual([]);
  });

  it('one guarded function per function, however many writers it types through', () => {
    expect(guarded.map((r) => functionName(r.site)).sort()).toEqual([
      'clearComposer',
      'sendCodexHooksScreenKey',
      'sendCommandCodePlanReviewKeys',
      'sendSessionAnswerKey',
      'sendSpecialKeysWhileCurrent',
    ]);
  });

  it('every caller row states a reason, and its file can call the function', () => {
    for (const row of STAGE_2_CALLER_LEDGER) {
      expect(row.reason.length, keyOf(row)).toBeGreaterThan(40);
      const defining = guarded.find((r) => functionName(r.site) === row.callee);
      expect(defining, keyOf(row)).toBeDefined();
      expect(callerFiles((defining as LedgerRow).file), keyOf(row)).toContain(row.file);
    }
  });

  it('positive: a new caller of `sendSessionAnswerKey` outside the lock fails', () => {
    const text = "import { sendSessionAnswerKey } from '@/lib/session/cli-session';\nexport async function pressDown(w: string) { await sendSessionAnswerKey(w, 'claude', 'Down'); }\n";
    const found = scanReferences('src/lib/rogue.ts', text, ['sendSessionAnswerKey']);
    expect(reconcileStage2Callers([...scanGuardedCallers(STAGE_2_LEDGER), ...found])).toEqual([
      expect.stringContaining('caller not on the ledger: src/lib/rogue.ts :: pressDown :: sendSessionAnswerKey'),
    ]);
  });
});

describe('[#4032] a caller-held function reached by another name, or re-exported, is a caller', () => {
  const DEFINING = 'src/lib/cli-tools/command-code-plan-review.ts';
  const NAME = 'sendCommandCodePlanReviewKeys';
  /** A caller written in `file`, read the way `scanCallers` reads the real ones. */
  const scanAs = (file: string, text: string): KeySite[] =>
    scanReferences(file, text, [NAME], {
      fromDefiningModule: (specifier) => resolveRepoSpecifier(specifier, join(REPO_ROOT, file)) === join(REPO_ROOT, DEFINING),
    });
  const withCallers = (found: readonly KeySite[]): string[] => reconcileCallers([...scanGuardedCallers(), ...found], CALLER_LEDGER);

  const positives: Array<[string, string, string]> = [
    [
      'a renamed import',
      `import { ${NAME} as typeKeys } from '@/lib/cli-tools/command-code-plan-review';\nexport async function rogue(s: string) { await typeKeys(s, []); }\n`,
      `caller not on the ledger: src/lib/rogue.ts :: rogue :: ${NAME}`,
    ],
    [
      'a namespace import',
      `import * as ccpr from '../lib/cli-tools/command-code-plan-review';\nexport async function rogue(s: string) { await ccpr.${NAME}(s, []); }\n`,
      `caller not on the ledger: src/lib/rogue.ts :: rogue :: ${NAME}`,
    ],
    [
      'a re-export',
      `export { ${NAME} as sendPlanKeys } from './cli-tools/command-code-plan-review';\n`,
      `caller not on the ledger: src/lib/rogue.ts :: <re-export> :: ${NAME}`,
    ],
    [
      'a re-export of everything',
      "export * from '@/lib/cli-tools/command-code-plan-review';\n",
      `caller not on the ledger: src/lib/rogue.ts :: <re-export> :: ${NAME}`,
    ],
    [
      'the imported binding exported again',
      `import { ${NAME} as k } from '@/lib/cli-tools/command-code-plan-review';\nexport { k };\n`,
      `caller not on the ledger: src/lib/rogue.ts :: <re-export> :: ${NAME}`,
    ],
    [
      'a renamed destructured dynamic import',
      `export async function rogue(s: string) { const { ${NAME}: k } = await import('@/lib/cli-tools/command-code-plan-review'); await k(s, []); }\n`,
      `caller not on the ledger: src/lib/rogue.ts :: rogue :: ${NAME}`,
    ],
  ];

  for (const [what, text, problem] of positives) {
    it(`positive: ${what}, outside the lock, fails`, () => {
      const found = scanAs('src/lib/rogue.ts', text);
      expect(found.length, text).toBeGreaterThan(0);
      expect(withCallers(found)).toEqual([expect.stringContaining(problem)]);
    });
  }

  it('the re-export is where it fails: the module calling through it does not import the definition', () => {
    const third = `import { sendPlanKeys } from './rogue';\nexport async function far(s: string) { await sendPlanKeys(s, []); }\n`;
    expect(scanAs('src/lib/far.ts', third)).toEqual([]);
  });

  it('negative: a renamed import used under the lock, put on the ledger as `lexical`, passes', () => {
    const text = `import { ${NAME} as typeKeys } from '@/lib/cli-tools/command-code-plan-review';\nimport { withInstanceInputLock } from '@/lib/session/instance-input-lock';\nexport async function locked(s: string) { await withInstanceInputLock(s, () => typeKeys(s, [])); }\n`;
    const row: CallerRow = { file: 'src/lib/locked.ts', site: 'locked', callee: NAME, held: 'lexical', reason: 'fixture' };
    expect(reconcileCallers([...scanGuardedCallers(), ...scanAs('src/lib/locked.ts', text)], [...CALLER_LEDGER, row])).toEqual([]);
  });

  it('negative: the same names from another module, and another object’s property, are not callers', () => {
    const text =
      `import { ${NAME} as typeKeys } from '@/lib/other';\nimport * as ccpr from '@/lib/other';\n` +
      `export async function f(s: string) { await typeKeys(s); await ccpr.${NAME}(s); await other.${NAME}(s); }\n`;
    expect(scanAs('src/lib/x.ts', text)).toEqual([]);
  });

  describe('the defining module is told apart by resolving the specifier', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    it('positive: a relative import of the defining file is followed; negative: one of another file is not', () => {
      dir = mkdtempSync(join(tmpdir(), 'pane-key-writers-4032-'));
      const defining = join(dir, 'defining.ts');
      const other = join(dir, 'other.ts');
      const caller = join(dir, 'caller.ts');
      writeFileSync(defining, `export async function ${NAME}() {}\n`);
      writeFileSync(other, `export async function ${NAME}() {}\n`);
      writeFileSync(caller, '');
      const fromDefining = (specifier: string): boolean => resolveRepoSpecifier(specifier, caller) === defining;
      const viaDefining = `import { ${NAME} as k } from './defining';\nexport async function a() { await k(); }\n`;
      const viaOther = `import { ${NAME} as k } from './other';\nexport async function b() { await k(); }\n`;
      expect(scanReferences(caller, viaDefining, [NAME], { fromDefiningModule: fromDefining }).map((s) => s.site)).toEqual(['a']);
      expect(scanReferences(caller, viaOther, [NAME], { fromDefiningModule: fromDefining })).toEqual([]);
    });
  });
});

describe('[#4032 review-3981 P3-6] a lock row’s evidence test names its site', () => {
  const lockRows = [...LEDGER, ...STAGE_2_LEDGER].filter((r) => r.kind === 'lock');

  it('negative control: every lock row’s evidence runs the lock and names the site', () => {
    for (const row of lockRows) expect(lockEvidenceProblems(row, read(row.evidence as string)), keyOf(row)).toEqual([]);
  });

  it('positive: the site’s function taken out of the evidence fails, for every lock row', () => {
    for (const row of lockRows) {
      const name = functionName(row.site);
      const text = read(row.evidence as string).replace(new RegExp(`\\b${name}\\b`, 'g'), 'someOtherFunction');
      expect(lockEvidenceProblems(row, text), keyOf(row)).toEqual([
        expect.stringContaining(`lock evidence never names its site \`${name}\``),
      ]);
    }
  });

  it('positive (#4050): the site named only in a comment of the evidence fails, for every lock row', () => {
    for (const row of lockRows) {
      const name = functionName(row.site);
      const code = read(row.evidence as string).replace(new RegExp(`\\b${name}\\b`, 'g'), 'someOtherFunction');
      const text = `${code}\n// Drives ${name}.\n/** ${name} under the lock */\n`;
      expect(lockEvidenceProblems(row, text), keyOf(row)).toEqual([
        expect.stringContaining(`lock evidence never names its site \`${name}\``),
      ]);
    }
  });

  it('positive (#4050): a lock run only in a comment is not a run of the lock', () => {
    const row = LEDGER[0];
    const name = functionName(row.site);
    expect(lockEvidenceProblems(row, `// withInstanceInputLock\nit('types', () => ${name}());`)).toEqual([
      expect.stringContaining('lock evidence does not run the lock'),
    ]);
  });

  it('positive: evidence that never runs the lock fails', () => {
    const row = LEDGER[0];
    expect(lockEvidenceProblems(row, `it('types', () => ${functionName(row.site)}());`)).toEqual([
      expect.stringContaining('lock evidence does not run the lock'),
    ]);
  });
});

describe('[#4032] raw `send-keys` / `paste-buffer` outside the tmux module are on their ledger', () => {
  it('negative control: today’s raw writes agree with the ledger', () => {
    expect(reconcileRaw(scanRepositoryRawWrites(), RAW_KEY_WRITES)).toEqual([]);
  });

  it('every raw row states a reason', () => {
    for (const row of RAW_KEY_WRITES) expect(row.reason.length, rawKeyOf(row)).toBeGreaterThan(40);
  });

  it('positive: an argv or a control-mode line that writes keys fails until it is listed', () => {
    for (const [text, site, command] of [
      ["export async function typeRaw(s: string) { await execFile('tmux', ['send-keys', '-t', s, 'x']); }\n", 'typeRaw', 'send-keys'],
      ["export const paste = (s: string) => run(['paste-buffer', '-t', s]);\n", 'paste', 'paste-buffer'],
      ['class C { write(s: string) { this.stdin.write(`send-keys -t ${s} -H 61\\n`); } }\n', 'C.write', 'send-keys'],
    ] as const) {
      const found = scanRawKeyWrites('src/lib/x.ts', text);
      expect(found.map((w) => [w.site, w.command]), text).toEqual([[site, command]]);
      expect(reconcileRaw([...scanRepositoryRawWrites(), ...found], RAW_KEY_WRITES)).toEqual([
        expect.stringContaining(`raw key write not on the ledger: src/lib/x.ts :: ${site} :: ${command}`),
      ]);
    }
  });

  it('negative: a label, a comment and another command are not raw writes', () => {
    const text =
      "// tmux send-keys -t x\nassertInputOwner(t, 'claude', 'paste-buffer', false);\nrun(['load-buffer', '-b', 'b', '-']);\nconst m = 'send-keys failed';\n";
    expect(scanRawKeyWrites('src/lib/x.ts', text)).toEqual([]);
  });
});

describe('[#4032] the readiness follow-ups say why they are not fixed here', () => {
  it('every follow-up states a reason', () => {
    for (const { file, reason } of READINESS_FOLLOW_UPS) expect(reason.length, file).toBeGreaterThan(40);
  });
});

describe('[#4032 review P3-2] the key-sequence builders are called from where the raw row says', () => {
  it('negative control: today’s callers agree with the ledger', () => {
    expect(reconcileKeySequenceCallers(scanKeySequenceCallers())).toEqual([]);
  });

  it('positive: a new caller of `runKeySequence` or `keySequenceArgs` fails', () => {
    for (const [name, text] of [
      ['runKeySequence', "import { runKeySequence } from '../tmux/key-sequence';\nexport async function typeSteps(t: string) { await runKeySequence(t, [], { run: async () => {} }); }\n"],
      ['keySequenceArgs', "import { keySequenceArgs as args } from '@/lib/tmux/key-sequence';\nexport const typeSteps = (t: string) => args(t, { kind: 'literal', text: 'x' });\n"],
    ] as const) {
      const found = scanReferences('src/lib/cli-tools/x.ts', text, [name]);
      expect(reconcileKeySequenceCallers([...scanKeySequenceCallers(), ...found]), text).toEqual([
        `key-sequence caller not on the ledger: src/lib/cli-tools/x.ts :: typeSteps :: ${name}`,
      ]);
    }
  });
});

describe('[#4050] raw tmux key commands in the shapes #4032’s scan did not read', () => {
  // A file on the tmux allowlist: no other guard stops a raw write there.
  const FILE = 'src/lib/cli-tools/x.ts';
  const positives: Array<[string, string, string, string]> = [
    ['a shell line', 'export async function typeShell(s: string) { await exec(`tmux send-keys -t ${s} Enter`); }\n', 'typeShell', 'send-keys'],
    ['a shell line with a global flag', "export const pasteShell = () => execAsync('tmux -L cm pasteb -t x');\n", 'pasteShell', 'paste-buffer'],
    ['an argv with a global flag first', "export async function typeSock(s: string, sock: string) { await execFile('tmux', ['-L', sock, 'send-keys', '-t', s, 'x']); }\n", 'typeSock', 'send-keys'],
    ['an argv with the program first', "export const typeArgv = (s: string) => spawn(['tmux', '-u', 'send-keys', '-t', s]);\n", 'typeArgv', 'send-keys'],
    ['the alias `send`', "export async function typeAlias(s: string) { await execFile('tmux', ['send', '-t', s, 'x']); }\n", 'typeAlias', 'send-keys'],
    ['the alias `pasteb` through runTmux', "export const pasteAlias = (s: string) => runTmux(['pasteb', '-t', s]);\n", 'pasteAlias', 'paste-buffer'],
    ['a command chained after `;`', "export const chained = (s: string) => execFile('tmux', ['select-pane', '-t', s, ';', 'send-keys', 'x']);\n", 'chained', 'send-keys'],
  ];

  for (const [what, text, site, command] of positives) {
    it(`positive: ${what} fails until it is listed`, () => {
      const found = scanRawKeyWrites(FILE, text);
      expect(found.map((w) => [w.site, w.command]), text).toEqual([[site, command]]);
      expect(reconcileRaw([...scanRepositoryRawWrites(), ...found], RAW_KEY_WRITES)).toEqual([
        expect.stringContaining(`raw key write not on the ledger: ${FILE} :: ${site} :: ${command}`),
      ]);
    });
  }

  it('negative: CLI command names, labels, permission patterns and arguments are not raw writes', () => {
    const text =
      "const cmd = new Command('send');\n" +
      "export const argv = (m: string) => ['send', 'wt', m, '--instance', 'claude'];\n" +
      "execFile('commandmate', ['send', 'wt', 'hi']);\n" +
      "followUpCommand('send', 'wt', 't', 'x');\n" +
      "const allow = ['Bash(tmux kill-session:*)', 'Bash(tmux send-keys:*)'];\n" +
      "execFile('tmux', ['display-message', '-p', 'send']);\n" +
      "assertInputOwner(t, 'claude', 'paste-buffer', false);\n" +
      "// exec(`tmux send-keys -t x Enter`)\n";
    expect(scanRawKeyWrites(FILE, text)).toEqual([]);
  });

  it('negative: an argv whose literal text is a command word counts once, for its command', () => {
    const text = "export const once = (s: string) => execFile('tmux', ['send-keys', '-t', s, 'send']);\n";
    expect(scanRawKeyWrites(FILE, text).map((w) => w.command)).toEqual(['send-keys']);
  });
});

describe('[#4050] key-writer references in the shapes #4032’s scan did not read', () => {
  const FILE = 'src/lib/cli-tools/x.ts';
  const cases: Array<[string, string, string, string]> = [
    ['a namespace read by element access', "import * as ns from '../tmux/tmux';\nexport async function keyed(s: string) { await ns['sendSpecialKey'](s, 'Enter'); }\n", 'keyed', 'sendSpecialKey'],
    ['an unbound dynamic import', "export async function late(s: string) { await (await import('@/lib/tmux/tmux')).sendSpecialKey(s, 'Enter'); }\n", 'late', 'sendSpecialKey'],
    ['an unbound dynamic import read by element access', "export async function lateKeyed(s: string) { await (await import('@/lib/tmux/tmux'))['sendKeys'](s, 'x', true); }\n", 'lateKeyed', 'sendKeys'],
    ['a dynamic import’s `.then`', "export function later(s: string) { return import('@/lib/tmux/tmux').then((m) => m.sendSpecialKey(s, 'Enter')); }\n", 'later', 'sendSpecialKey'],
    ['a dynamic import’s `.then`, destructured', "export function laterKeys(s: string) { return import('../tmux/tmux').then(({ sendKeys }) => sendKeys(s, 'x', true)); }\n", 'laterKeys', 'sendKeys'],
  ];

  for (const [what, text, site, callee] of cases) {
    it(`positive: ${what} is a site, off every ledger`, () => {
      const found = scanKeyWriters(FILE, text);
      expect(found.map((s) => [s.site, s.callee]), text).toEqual([[site, callee]]);
      const ledger = SEND_KEYS_WRITERS.includes(callee) ? LEDGER : STAGE_2_LEDGER;
      const [baseline, writers] = SEND_KEYS_WRITERS.includes(callee)
        ? [UNMEDIATED_BASELINE, SEND_KEYS_WRITERS]
        : [STAGE_2_UNMEDIATED_BASELINE, STAGE_2_WRITERS];
      expect(reconcile([...scanRepository(), ...found], ledger, baseline, writers)).toEqual([
        expect.stringContaining(`not on the ledger: ${FILE} :: ${site} :: ${callee}`),
      ]);
    });
  }

  it('negative: the same shapes on another module, or a computed key, are not sites', () => {
    const text =
      "import * as ns from '../tmux/tmux';\n" +
      "export async function f(s: string, k: string) {\n" +
      "  await (await import('@/lib/other')).sendSpecialKey(s, 'Enter');\n" +
      "  await import('@/lib/other').then((m) => m.sendKeys(s));\n" +
      "  await ns[k](s);\n" +
      "  await ns['capturePane'](s);\n" +
      "}\n";
    expect(scanKeyWriters(FILE, text)).toEqual([]);
  });

  it('positive: a caller-held function read the same ways is a caller', () => {
    const name = 'sendCommandCodePlanReviewKeys';
    const text =
      `import * as ccpr from '@/lib/cli-tools/command-code-plan-review';\n` +
      `export async function a(s: string) { await ccpr['${name}'](s, []); }\n` +
      `export async function b(s: string) { await (await import('@/lib/cli-tools/command-code-plan-review')).${name}(s, []); }\n` +
      `export function c(s: string) { return import('@/lib/cli-tools/command-code-plan-review').then((m) => m.${name}(s, [])); }\n`;
    expect(scanReferences('src/lib/rogue.ts', text, [name]).map((r) => r.site)).toEqual(['a', 'b', 'c']);
  });
});
