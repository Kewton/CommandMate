/**
 * wait Command - stderr notices about Auto-Yes and pane obstructions
 * Issue #3964: split out of wait.ts; wait.ts re-exports what it exported.
 */

import type { AutoYesSuppressionReason, CurrentOutputResponse } from '../types/api-responses';

/**
 * The keystroke that closes opencode's sidebar, in opencode's own notation
 * (Issue #2095).
 *
 * A local copy of `OPENCODE_SIDEBAR_RECOVERY_CHORD` from
 * `src/lib/detection/opencode-pane-obstruction.ts` and not an import: the CLI
 * builds with `"paths": {}` (tsconfig.cli.json) and cannot reach `@/lib` at all,
 * which is why `api-responses.ts` mirrors payload shapes rather than importing
 * them. Taken from opencode's own keybind table, which its `ctrl+p` palette
 * prints as `Show sidebar   ctrl+x b`.
 */
const OPENCODE_SIDEBAR_RECOVERY_CHORD = 'ctrl+x b';

/**
 * The cause sentence to append when the frame carries a pane obstruction, or ''
 * (Issue #2095).
 *
 * Appended rather than substituted, and no exit code moves: the frame is
 * genuinely unclassified and `wait` was already right to stop on it. What it
 * could not say before is WHY, which left an operator with `capture --pane` and
 * a screenful of box drawing to work it out from.
 *
 * Empty for a server too old to publish the field, which is the same output
 * `wait` produced before this Issue.
 */
export function describePaneObstruction(data: CurrentOutputResponse): string {
  const obstruction = data.paneObstruction;
  if (!obstruction) return '';
  return (
    ` Cause: paneObstruction=${obstruction.id} — a second column is sharing rows with the ` +
    `transcript (it reads ${JSON.stringify(obstruction.matchedText)}), which covers the marker ` +
    `that ends a turn. Press \`${OPENCODE_SIDEBAR_RECOVERY_CHORD}\` in the pane to close ` +
    `opencode's sidebar.`
  );
}

/**
 * How recent `autoYes.lastSuppression` must be to be reported as the reason this
 * wait is blocked (Issue #1699).
 *
 * The record is refreshed on every poll for as long as the suppressed prompt is
 * on screen, so a fresh timestamp means "this is happening now" while an old one
 * is a historical suppression of some earlier prompt. The window is generous
 * against the server's own poll interval — being a few seconds late with a true
 * report beats staying silent, which is the failure this exists to fix.
 *
 * Issue #2463 reads the same window as "the policy withheld THIS prompt", which
 * is what ends the Auto-Yes hold at once. `current-output` publishes no start
 * time for a scraped prompt, so the push gate's `suppression.at >= waitingSince`
 * (`src/lib/push/prompt-push-gate.ts`) cannot be computed here; a record that is
 * still being re-stamped is the CLI's reading of it. Using one window for both
 * keeps the hold and the payload in agreement: an exit 10 carries
 * `autoYesSuppression` exactly when the hold judged the answer withheld. The
 * error runs towards reporting — a withheld answer to an earlier prompt, under a
 * minute old, still ends the hold, which is the pre-#2463 exit rather than a
 * new failure.
 *
 * Issue #3798: a server that names the waiting episodes does what the push gate
 * does — the record's `episodeId` against the payload's
 * `autoYes.waitingEpisodeId`, which decide when both are present: another id
 * (or no wait open) is a record of an earlier wait, however recent; the same
 * id is this wait's. Either one missing (an older server, a record written
 * before any wait was open), this window decides as before. Whichever
 * decides, a record the server marks `lastSuppressionAnswered` — Auto-Yes
 * answered the open wait after it was written — is history, not this wait's
 * reason, as the push gate reads it: the hold goes on.
 */
const SUPPRESSION_FRESH_MS = 60_000;

type LastSuppression = NonNullable<
  NonNullable<CurrentOutputResponse['autoYes']>['lastSuppression']
>;

/**
 * The suppression currently blocking this session, or null.
 *
 * Issue #3863: with the Auto-Yes answer mode in effect (`autoYesAnswerMode`)
 * when the server publishes one — what `question-left-to-human` and
 * `recommended-option-unidentified` depend on.
 */
export function activeSuppression(
  data: CurrentOutputResponse,
  now: number,
): { suppression: LastSuppression; ageSeconds: number; answerMode?: string } | null {
  // No `autoYes` at all (a session that is not running, Issue #3300) reads as
  // "nothing was withheld", the same as a null record.
  const suppression = data.autoYes?.lastSuppression;
  if (!suppression) return null;
  const ageMs = now - suppression.at;
  const waitId = data.autoYes?.waitingEpisodeId;
  if (suppression.episodeId !== undefined && waitId !== undefined) {
    if (suppression.episodeId !== waitId) return null;
  } else if (ageMs > SUPPRESSION_FRESH_MS) {
    // A negative age is clock skew between the CLI and the server, not staleness.
    return null;
  }
  if (data.autoYes?.lastSuppressionAnswered === true) return null;
  const answerMode = data.autoYesAnswerMode;
  return {
    suppression,
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    ...(answerMode !== undefined ? { answerMode } : {}),
  };
}

/** The wording for the four reasons a contract's `autoYes` block really authors. */
const CONTRACT_POLICY_CAUSE = 'by contract policy';

/**
 * What withheld the answer, in the words `wait` puts on stderr (Issue #1843).
 *
 * A Record over the whole reason union rather than one fixed phrase: adding a
 * reason to {@link AutoYesSuppressionReason} without deciding what `wait` should
 * say about it is a compile error here, which is the point. Until #1843 the
 * notice hard-coded "by contract policy" for every reason, so #1829's
 * `agent-launch-dialog` — a product-side decision the poller makes with no
 * contract in sight (`suppressIfNotOursToAnswer` in
 * `src/lib/polling/auto-yes-prompt-suppression.ts`: codex's lifecycle dialogs,
 * gemini's folder trust since #3776 and copilot's since #3790) — sent operators
 * of contract-less worktrees hunting for a `denyPatterns` entry that did not
 * exist.
 *
 * The three sites that record a suppression are covered: the poller's launch-dialog
 * branch (`agent-launch-dialog`), the poller's policy branch and
 * `lib/hooks/permission-decision-service.ts` (both the four `evaluatePolicyAgainstTexts`
 * verdicts, which is why those four keep the pre-#1843 wording exactly), and
 * the poller's stopped-answer branch (`partial-answer`, Issue #3706 / #3713),
 * and the poller's agy trust-screen branch (`startup-trust-unhandled`, Issue #3757),
 * and the poller's question confirm-page branch (`question-confirm-page`, Issue #3748),
 * and the poller's question branch (`question-left-to-human`, Issue #3822),
 * and the resolver's permission-row reading (`allow-once-unidentified`, Issue #3822),
 * and the resolver's choice of a question's recommended option
 * (`recommended-option-unidentified`, Issue #3863),
 * and the poller's agy receipt-gate branch (`no-hook-receipt`, Issue #3767),
 * and a contract lookup that failed on either of the policy paths
 * (`policy-lookup-failed`, Issue #3822).
 */
const SUPPRESSION_CAUSE: Record<AutoYesSuppressionReason, string> = {
  'mode-off': CONTRACT_POLICY_CAUSE,
  'deny-pattern': CONTRACT_POLICY_CAUSE,
  'deny-pattern-unusable': CONTRACT_POLICY_CAUSE,
  'type-not-allowed': CONTRACT_POLICY_CAUSE,
  // Issue #3822. Not "by contract policy": the contract could not be read at
  // all, so nothing it says was applied. Withheld rather than answered, since
  // the contract may state `off`; it clears once the server reads it again.
  'policy-lookup-failed':
    'because the server could not read the execution contract (the database lookup failed), so Auto-Yes does not answer until it can; check the server log for policy-lookup-failed',
  // Issue #3790: after the launch window the poller still leaves copilot's and
  // gemini's trust dialogs alone when the cursor is not on the safe row, and
  // nobody else answers them then.
  'agent-launch-dialog':
    "while the agent's launch dialog was on screen; if it stays after the launch (copilot's cursor on 2. or 3., gemini's not on 1. Trust folder), answer it at the pane",
  // Issue #1924. Deliberately not "by contract policy": no contract was
  // consulted. The frame looked like a numbered list to the generic estimator
  // and like prose to the tool's own detector, and an operator who reads this
  // should go and look at the pane rather than at `denyPatterns`.
  'unclassified-frame': 'because no tool-specific dialog detector recognised the frame',
  // Issue #3713 (#3706's reason). Not "by contract policy" either: an earlier
  // Auto-Yes answer was stopped with some of its keys already in the input, and
  // typing it again would append to them, so the prompt waits for a human.
  // Issue #3880: or a send of it (Auto-Yes's, or a person's that failed) ended
  // without tmux confirming it, and no key may be known to be there. The #3713
  // sentence is kept as it was and the other case follows it.
  'partial-answer':
    "because an earlier answer left partial input; Auto-Yes is waiting for a human (or that answer's send could not be confirmed, so the input may hold it: check the pane, then answer; an answer that goes through releases the hold)",
  // Issue #3757. agy's startup folder-trust screen: the launch's to confirm, not
  // Auto-Yes's, and agy drew it after the launch window had ended.
  'startup-trust-unhandled':
    "because agy's startup folder-trust confirmation is the launch's to answer, not Auto-Yes's; the next send confirms it once, or answer it at the pane",
  // Issue #3748. The AskUserQuestion confirm page (`Submit` / `Cancel`): the
  // tool's own reader recognised it, and `Submit` commits whatever stands as the
  // answers, so it waits for a human. Was recorded as `unclassified-frame`,
  // whose wording above says the opposite (nothing recognised the frame).
  'question-confirm-page':
    "because the question's Submit/Cancel confirmation commits the answers as they stand, so Auto-Yes leaves it to a human",
  // Issue #3822. A question the agent asks the operator (an AskUserQuestion
  // picker, OpenCode V2's question form): Auto-Yes answers permissions only,
  // and no contract setting delegates the question. Issue #3863: since the
  // answer modes, that is the `careful` mode's rule (and OpenCode V2's form
  // under either mode); `answerMode=` on the line says which mode was on.
  'question-left-to-human':
    'because the agent is asking a question, and Auto-Yes answers permissions only (the careful answer mode, or a question form no mode answers); answer it at the pane (prompt --json, respond), or turn Auto-Yes on with --answer-mode recommended to have it pick the recommended option',
  // Issue #3822. A permission dialog none of whose rows allows this call only
  // (each saves a rule, changes the mode or denies), or two of which read so.
  // Auto-Yes never picks a row that outlives this call, so it waits for a human.
  'allow-once-unidentified':
    'because no single option of the permission dialog allows this call only (the others save a rule, change the permission mode, or deny); Auto-Yes does not pick those, so answer it at the pane (prompt --json, respond)',
  // Issue #3863. The recommended answer mode answers a question with its one
  // recommended option (else its default), and could not tell which that is.
  'recommended-option-unidentified':
    "because the question's recommended option could not be told (two or more marked recommended, a title it could not tell from its description, a typed-text or multi-select answer); answer it at the pane (prompt --json, respond)",
  // Issue #3767. agy's approval dialog has no matching hook question (none, too
  // late, already on screen, or the hook stopped arriving). Not a contract verdict.
  // Issue #3789: nor one left unused — the last was spent on keys Auto-Yes sent,
  // and a dialog is still up past the grace — so "no unused question" covers both.
  'no-hook-receipt':
    "because there is no unused agy hook permission question for this dialog (none arrived in time, or the last one was spent on keys that did not clear it); answer it yourself (auto-yes --disable, prompt --json, respond --expect-screen) or check hooks.json",
};

/**
 * {@link SUPPRESSION_CAUSE} for a reason that arrived over the wire.
 *
 * `reason` is a server-supplied string, so a server newer than this CLI can name
 * a reason the union does not have. Naming it verbatim is the only honest answer:
 * quietly folding an unknown reason into "by contract policy" is the same
 * misattribution #1843 exists to remove, just for a future reason instead of
 * `agent-launch-dialog`.
 */
function suppressionCause(reason: string): string {
  return Object.prototype.hasOwnProperty.call(SUPPRESSION_CAUSE, reason)
    ? SUPPRESSION_CAUSE[reason as AutoYesSuppressionReason]
    : `for a reason this CLI does not recognise (${reason})`;
}

/**
 * One stderr line naming what is holding this prompt (Issue #1699).
 *
 * `wait` used to print only "Waiting for human response...", which reads the
 * same whether a human was always going to answer or whether Auto-Yes silently
 * refused to. That ambiguity is what let a deny pattern matching a finished turn
 * stall two workers unnoticed; the pattern and the reason code belong on screen.
 *
 * Issue #1843: the cause is chosen per reason rather than asserted. `reason=` is
 * in the payload either way, so the prefix is the only part that can lie — and it
 * did, for every non-contract suppression.
 */
export function formatSuppressionNotice(suppression: LastSuppression, ageSeconds: number, answerMode?: string): string {
  const parts = [
    `reason=${suppression.reason}`,
    `mode=${suppression.mode ?? 'none'}`,
    `promptType=${suppression.promptType}`,
  ];
  if (suppression.pattern !== undefined) {
    parts.push(`pattern=${JSON.stringify(suppression.pattern)}`);
  }
  // Issue #3863: the Auto-Yes answer mode in effect, when the server says.
  if (answerMode !== undefined) {
    parts.push(`answerMode=${answerMode}`);
  }
  const cause = suppressionCause(suppression.reason);
  return `  auto-yes suppressed this prompt ${cause}: ${parts.join(' ')} (${ageSeconds}s ago)`;
}

/**
 * One stderr line saying Auto-Yes is off on this instance because the server
 * restarted (Issue #3730), or null.
 *
 * Only words: the prompt was going to be reported either way — an instance
 * whose grant the restart released is an instance with Auto-Yes off, and exit
 * 10 for it is exactly the hand-back it always was. What this adds is the WHY,
 * so a delegating agent re-enables Auto-Yes instead of guessing. A server
 * older than the reason sends none, and nothing is printed.
 *
 * The command it suggests names the instance this wait is about: without
 * `--instance`, `auto-yes --enable` arms the worktree's default primary, which
 * for an alias (or a non-default tool) is another instance — the waited-on one
 * would stay off while a grant went somewhere nobody asked for. The instance is
 * the resolved `--instance` when one was given, else the CLI tool the server
 * answered for (a primary's instance ID is its tool ID).
 *
 * @param instanceId - The resolved `--instance` of this wait, if any
 */
export function formatRestartReleaseNotice(
  worktreeId: string,
  data: CurrentOutputResponse,
  instanceId?: string,
): string | null {
  if (data.autoYes?.enabled !== false || data.autoYes.stopReason !== 'server-restart') return null;
  const target = instanceId ?? data.cliToolId;
  const command = `commandmate auto-yes ${worktreeId} --enable${target ? ` --instance ${target}` : ''}`;
  return `  auto-yes was released by a server restart on ${worktreeId} (it is not turned back on ` +
    `automatically); re-enable it with \`${command}\` if this session should keep answering.`;
}

/**
 * One stderr line saying Auto-Yes pressed Enter on THIS prompt (Issue #3397), or
 * null when the record is absent or about another screen.
 *
 * The prompt is one CommandMate could not read (the window offers direct input
 * for it). `sent` — Auto-Yes confirmed whatever was selected; `no-effect` — the
 * same screen outlived the Enter, no second one was sent, and it is a human's
 * again. An outcome this CLI does not know is named verbatim (#1843's rule).
 * `currentPrompt` is the server's judgement that the record is about the
 * `promptData` of the same response, so an Enter sent to an earlier screen is
 * never reported against this one.
 */
export function formatEnterFallbackNotice(data: CurrentOutputResponse, now: number): string | null {
  const record = data.autoYes?.lastEnterFallback;
  if (!record || record.currentPrompt !== true) return null;
  const detail = `refusal=${record.refusalReason} promptType=${record.promptType}`;
  const ago = `(${Math.max(0, Math.round((now - record.at) / 1000))}s ago)`;
  if (record.outcome === 'sent') {
    return `  auto-yes sent Enter to this prompt (CommandMate could not read it): ${detail} ${ago}`;
  }
  if (record.outcome === 'no-effect') {
    return `  auto-yes sent Enter to this prompt, but the same screen is still up (no-effect); ` +
      `answer it in the terminal: ${detail} ${ago}`;
  }
  return `  auto-yes Enter record for this prompt: outcome=${record.outcome} ${detail} ${ago}`;
}

/**
 * Issue #3821: the server's own word that Auto-Yes left this prompt to a human
 * (`autoYesDecision.state === 'withheld'`) — `server-poller-inactive` when no
 * poller runs for the instance, or a stop the suppression record does not
 * carry. Read only when the server publishes the field; an older one leaves
 * `wait` holding as before.
 */
export function decisionWithheldReason(data: CurrentOutputResponse): string | null {
  const decision = data.autoYesDecision;
  if (decision?.state !== 'withheld') return null;
  return decision.reason ?? 'unknown';
}
