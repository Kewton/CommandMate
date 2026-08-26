/**
 * The prompt the structured layer publishes for a dialog nobody could parse
 * (Issue #1725).
 *
 * `Notification(notification_type=permission_prompt)` tells us a dialog is on
 * screen; it does not tell us what is in it. The live capture (#1721 §5.5)
 * measured the whole payload: a `message` written for a human
 * (`"Claude needs your permission to use Bash"`), a `notification_type`, and
 * nothing resembling the options the dialog is offering. So the fact the
 * structured layer can contribute is "a human has to act", and the shape below
 * is that fact and no more — a question, no options, and the agent's own line
 * kept verbatim for display.
 *
 * ## Why `type` is `unclassified` rather than a new prompt type
 *
 * `UNCLASSIFIED_PROMPT_TYPE` already means exactly this to every reader that
 * matters: `commandmate wait` reports it as the kind of exit 10 that nobody can
 * answer programmatically (#1708), `capture --prompts` renders it as its own
 * state instead of a pending prompt, and PromptPanel now degrades on it. Adding
 * a second word for "we know it is there, we cannot read it" would oblige each
 * of them to learn both. It is deliberately NOT a member of `PromptType` —
 * widening that union would force every exhaustive map over it (the contract
 * parser's promptType allowlist among them) to grow a case for a value no
 * prompt-answering path may accept. See the note on `UNCLASSIFIED_PROMPT_TYPE`
 * in `types/models.ts`.
 *
 * ## Pure on purpose
 *
 * Type-only imports and string building, exactly like `status-mapping`, so a
 * client component can import it: `PromptPanel`'s prop type widens to include
 * {@link StructuredPromptWaitingData} and it must be able to name the type.
 *
 * @module lib/session/structured-prompt
 */

import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';

/**
 * Where the structured layer learned that a dialog is open.
 *
 * - `notification` — `Notification(permission_prompt)`, which the spike
 *   measured firing ~6 s after the dialog is drawn and only then (§5.5). It is
 *   proof the dialog exists.
 * - `permission-request` — the `PermissionRequest` hook was answered with
 *   no-decision, which D5 measured as landing in the ordinary TUI approval
 *   flow, i.e. a dialog is about to be drawn. It arrives *before* the dialog,
 *   which is why a record from this source stays provisional until something
 *   corroborates it (see `agent-event-state`).
 */
export type StructuredPromptSource = 'notification' | 'permission-request';

/**
 * One reply an open approval accepts, addressed to the agent's own API rather
 * than to its screen (Issue #1898).
 *
 * These are **not** option numbers read off a dialog, and the distinction is
 * the whole reason they may be published at all. #1725 kept the degraded form
 * option-less because a number published against a screen nobody parsed is an
 * answer to the wrong question — the picker renumbers, the confirmation screen
 * looks identical, and Enter takes whatever is highlighted (#1681). A verdict
 * delivered over REST has none of those failure modes: it names the decision by
 * id, the agent applies it, and no key is sent anywhere.
 *
 * So they are offered only for a source that can be answered that way — see
 * `AgentSourceCapabilities.eventIdentity`, which is what
 * `current-output-builder` reads before filling this in.
 */
export interface StructuredDecisionOption {
  /** What an operator types: `commandmate respond <worktree> <number>`. */
  number: number;
  /** The human-facing label. */
  label: string;
  /** The wire value the reply carries. Accepted by `respond` as well. */
  reply: string;
}

/**
 * The three verdicts an approval dialog accepts, in the order `respond` numbers
 * them (Issue #1898).
 *
 * Verdict kinds rather than a tool's wire words: `allowOnce` / `allowAlways` /
 * `deny` is the shared vocabulary every source encodes for itself
 * (`AgentEventSource.encodeVerdict`), so this list stays true for the next
 * source that can be answered out of band. `reply` is opencode's spelling of
 * the same three, published because it is what its own logs and REST calls say
 * and an operator correlating the two should not have to translate.
 */
export const STRUCTURED_DECISION_OPTIONS: readonly StructuredDecisionOption[] = [
  // i18n (#1271) deliberately not applied to these three labels: they are part
  // of the CLI's accepted vocabulary, not display text. `commandmate respond
  // <id> "Allow once"` matches against them (see
  // `lib/hooks/structured-decision-response`), and a locale-dependent label
  // would make the same command work on one machine and fail on another. The
  // whole of this module is English by the same rule — see
  // `buildStructuredPromptQuestion`, whose output goes to stderr and stdout.
  // eslint-disable-next-line no-restricted-syntax -- CLI answer vocabulary, not display text
  { number: 1, label: 'Allow once', reply: 'once' },
  // eslint-disable-next-line no-restricted-syntax -- CLI answer vocabulary, not display text
  { number: 2, label: 'Allow always', reply: 'always' },
  // eslint-disable-next-line no-restricted-syntax -- CLI answer vocabulary, not display text
  { number: 3, label: 'Reject', reply: 'reject' },
];

/** Bound on the agent's `message`, which is prose and only ever displayed. */
export const MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH = 500;

/**
 * Whether an approval id is one a verdict can actually be addressed to
 * (Issue #2031).
 *
 * The reason this is a function and not an `if` at the one call site: the
 * publication condition for {@link STRUCTURED_DECISION_OPTIONS} and the
 * publication condition for `decisionId` have to be the SAME condition, and
 * #1932 is the record of what happens when they are merely intended to be. The
 * receiving end (`components/worktree/prompt-decision-id`) applies exactly this
 * predicate, so a payload the panel would reject as unaddressable can never
 * have been published with buttons in the first place.
 *
 * Deliberately identical to `readPromptDecisionId`'s test — a non-empty string
 * — and no stricter: the id has already been through `acceptExternalId` by the
 * time it reaches a payload, and a second, different notion of validity here
 * would be a way for the two ends to disagree again.
 */
export function isAddressableDecision(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * The question an `AskUserQuestion` call asked, for a dialog nobody parsed
 * (Issue #1726).
 *
 * Attached to the degraded form and *only* to it. When the scraper can read the
 * picker, the options are published properly — as a `multiple_choice` with real
 * option numbers (`ask-user-question-prompt`). This is what is left to say when
 * it cannot: the text of what was asked, so the human is not told merely that
 * "a dialog is open" while the server is holding the question.
 *
 * There are no numbers here on purpose. A single tool call walks through one
 * screen per question and then a `1. Submit answers / 2. Cancel` confirmation,
 * emitting no event at any transition (§5.6), so a layer that cannot see the
 * screen cannot know which of them is up — and a number published against the
 * wrong screen is an answer to the wrong question.
 */
export interface StructuredAskUserQuestionSummary {
  /** The first question of the call. */
  question: string;
  /** Its option labels, in the order the payload listed them. */
  labels: string[];
  /** How many questions the one tool call carries. */
  questionCount: number;
}

/** What a structured prompt is built from, from either source. */
export interface StructuredPromptFacts {
  source: StructuredPromptSource;
  /**
   * The agent's own human-facing line (`Notification.message`), or null.
   *
   * Display only. `notification_type` is the machine key (D3); this string is
   * English prose that Claude is free to reword, so nothing may branch on it.
   */
  message: string | null;
  /** Tool the pre-empted request named, when the source knows it. */
  toolName?: string | null;
  /** The `AskUserQuestion` call in flight, when there is one (Issue #1726). */
  askUserQuestion?: StructuredAskUserQuestionSummary | null;
  /**
   * The replies this dialog accepts over the agent's own API, when it accepts
   * any (Issue #1898). Null everywhere else, which is every hook source.
   */
  decisionOptions?: readonly StructuredDecisionOption[] | null;
  /**
   * The agent's own id for this approval, or null (Issue #2031).
   *
   * The same value `StructuredPendingDecision.decisionId` holds, carried the
   * last step to the browser. It is what makes {@link decisionOptions} mean a
   * verdict rather than a keystroke, which is why `current-output-builder`
   * derives the two from ONE expression — see `isAddressableDecision`.
   */
  decisionId?: string | null;
  /**
   * What answering `Allow always` would permit, already bounded (Issue #2031).
   *
   * opencode's `permission.asked` publishes the rules the approval would be
   * saved as (`patterns`), and `Allow always` is the one verdict here whose
   * effect outlives the dialog. A panel that offers that button without saying
   * what it grants is asking for a decision the user cannot see the size of.
   * Bounded where it is retained — `boundDecisionPatterns` — so a payload
   * cannot grow this list without limit.
   */
  patterns?: readonly string[] | null;
}

/**
 * The prompt published on `currentOutput.promptData` while the structured layer
 * — and only the structured layer — can see a dialog.
 *
 * Not a `PromptData`: it has no options, so nothing that answers prompts by
 * option number may be handed it by a path that only checks `messageType`.
 * `status` is `'pending'` because, unlike #1708's record of a detection
 * failure, this one *is* waiting for an answer — a human can give it in the
 * terminal.
 */
export interface StructuredPromptWaitingData {
  type: typeof UNCLASSIFIED_PROMPT_TYPE;
  status: 'pending';
  /** One line naming the situation and how to answer it. Already English. */
  question: string;
  /** Always empty: the dialog's options were never in the payload. */
  options: never[];
  /** Which structured signal reported it. */
  source: StructuredPromptSource;
  /** The agent's own line, for display. See {@link StructuredPromptFacts.message}. */
  message?: string;
  /** Tool the pre-empted permission request named, when known. */
  toolName?: string;
  /** What the agent asked, when it was an `AskUserQuestion` (Issue #1726). */
  askUserQuestion?: StructuredAskUserQuestionSummary;
  /**
   * The replies this dialog accepts over the agent's own API (Issue #1898).
   *
   * A separate field from {@link StructuredPromptWaitingData.options}, which
   * stays `never[]`, and deliberately so: `options` is the field every path
   * that answers a prompt *by option number on screen* reads, and this payload
   * must go on being unanswerable by those. A reader that understands this
   * field understands that answering means `respond`, not a keystroke.
   */
  decisionOptions?: readonly StructuredDecisionOption[];
  /**
   * The approval {@link StructuredPromptWaitingData.decisionOptions} address,
   * or null when there is none (Issue #2031).
   *
   * The sending end of #1932, which shipped `readPromptDecisionId` against a
   * field no builder wrote — so the panel's three buttons were unreachable and
   * the browser's only way to answer an opencode approval was the arrow-keys
   * safety net. Published as `null` rather than omitted: a reader has to be
   * able to tell "this server looked and there is no addressable approval"
   * from "this build does not publish the field".
   *
   * Always in step with {@link StructuredPromptWaitingData.decisionOptions} —
   * see `isAddressableDecision`, which is the single expression
   * `current-output-builder` derives both from. Options without an id is the
   * state that falls back to the keystroke path (#1681 / #1725), so the two
   * must not be able to drift apart.
   */
  decisionId?: string | null;
  /**
   * What `Allow always` would permit. See {@link StructuredPromptFacts.patterns}.
   *
   * Absent rather than empty when the approval named none, so a surface can
   * render the list on presence alone.
   */
  patterns?: readonly string[];
}

/**
 * The prompt-history row written when the structured layer saw a dialog the
 * scraper did not (Issue #1725, continuing #1708's proposal 2).
 *
 * `status` is `'unclassified'`, not `'pending'`, for the reason #1708 gives:
 * `markPendingPromptsAsAnswered()` selects on `status = 'pending'`, and this row
 * must never be stamped "(answered via terminal)" on the strength of a sweep —
 * it is an audit record of a detection gap, and the answer, if one comes, is
 * recorded by the ordinary prompt writer against its own row.
 */
export interface StructuredPromptHistoryRecord {
  type: typeof UNCLASSIFIED_PROMPT_TYPE;
  status: 'unclassified';
  question: string;
  options: never[];
  source: StructuredPromptSource;
  message?: string;
  toolName?: string;
  /** What the agent asked, when it was an `AskUserQuestion` (Issue #1726). */
  askUserQuestion?: StructuredAskUserQuestionSummary;
}

/** How each source reads in the one-line question. */
const SOURCE_LABEL: Record<StructuredPromptSource, string> = {
  notification: 'Notification(permission_prompt)',
  'permission-request': 'PermissionRequest (no decision)',
};

/**
 * The one line every surface shows for a structured prompt.
 *
 * It names the option NUMBER on purpose. `respond <id> yes` is not resolved
 * semantically on a numbered dialog — Enter takes the highlighted default
 * instead, so a "no" can be delivered as an approval (Issue #1681). This text
 * is the only guidance a caller of `wait` gets, so it has to say which form
 * actually works.
 */
export function buildStructuredPromptQuestion(
  worktreeId: string,
  facts: StructuredPromptFacts,
): string {
  const parts = [
    `A dialog is open in ${worktreeId}: the agent reported it via ${SOURCE_LABEL[facts.source]}` +
      `${facts.toolName ? ` for ${facts.toolName}` : ''}, but the detection layer published no ` +
      `options for it.`,
  ];
  if (facts.decisionOptions && facts.decisionOptions.length > 0) {
    // Issue #1898. The numbers are real here — they address a decision the
    // agent is holding, not a line on a screen — so the guidance says which one
    // to send instead of warning that none of them can be trusted.
    parts.push(
      `Answer it with \`commandmate respond ${worktreeId} <number>\`: ` +
        facts.decisionOptions
          .map((option) => `${option.number} = ${option.label} (${option.reply})`)
          .join(', ') +
        `. The reply goes to the agent's own API, so no keys are sent to the terminal ` +
        `and the label works too (\`respond ${worktreeId} "Allow once"\`).`,
    );
  } else {
    parts.push(
      `Answer it in the terminal, or send the option NUMBER with ` +
        `\`commandmate respond ${worktreeId} <number>\` — yes/no is not resolved on a numbered ` +
        `dialog (Issue #1681).`,
    );
  }
  if (facts.message) {
    parts.push(`Agent message: "${facts.message}"`);
  }
  if (facts.askUserQuestion) {
    const { question, labels, questionCount } = facts.askUserQuestion;
    // Issue #2100: whether these numbers may be QUOTED is the same test the
    // browser applies before drawing them as buttons — see
    // `components/worktree/prompt-decision-id`'s `readPromptQuestionChoices`:
    // an id to deliver an answer to, exactly one question, and no approval
    // verdicts on the same payload. Claude satisfies none of it (its picker is
    // read off the screen, renumbered, with entries the payload never
    // mentioned), so its sentence is the unchanged warning.
    //
    // This is not a nicety. `promptData.question` is what PromptPanel renders
    // ABOVE the choice buttons, so before this Issue an opencode question
    // showed working numbered buttons under a line telling the reader not to
    // count the list they were numbered from.
    const answerable =
      isAddressableDecision(facts.decisionId) &&
      questionCount === 1 &&
      !(facts.decisionOptions && facts.decisionOptions.length > 0);
    parts.push(
      `The agent asked${questionCount > 1 ? ` ${questionCount} questions, the first being` : ''}: ` +
        `"${question}" — offering: ${labels.join(' / ')}. ` +
        (answerable
          ? `Answer it with \`commandmate respond ${worktreeId} <number>\`: ` +
            labels.map((label, index) => `${index + 1} = ${label}`).join(', ') +
            `. The number is this list's own position and the reply goes to the agent's own ` +
            `API, so no keys are sent to the terminal (the label works too).`
          : `The picker renumbers and adds its own entries, so read the option NUMBER off the ` +
            `terminal rather than counting this list.`),
    );
  }
  return parts.join(' ');
}

/** The live `promptData` for a structured prompt. */
export function buildStructuredPromptData(
  worktreeId: string,
  facts: StructuredPromptFacts,
): StructuredPromptWaitingData {
  return {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'pending',
    question: buildStructuredPromptQuestion(worktreeId, facts),
    options: [],
    source: facts.source,
    ...(facts.message ? { message: facts.message } : {}),
    ...(facts.toolName ? { toolName: facts.toolName } : {}),
    ...(facts.askUserQuestion ? { askUserQuestion: facts.askUserQuestion } : {}),
    ...(facts.decisionOptions && facts.decisionOptions.length > 0
      ? { decisionOptions: facts.decisionOptions }
      : {}),
    // Issue #2031. Unconditional, unlike every field above it: those are prose
    // whose absence and emptiness mean the same thing, while this one answers
    // "is there an approval to address?" and `null` is a real answer. Dropping
    // this line is the mutation `structured-prompt-decision-id-2031` fires at —
    // it puts the payload back to #1932's half-built state, where the panel
    // publishes three verdicts nothing can deliver.
    decisionId: isAddressableDecision(facts.decisionId) ? facts.decisionId : null,
    ...(facts.patterns && facts.patterns.length > 0
      ? { patterns: [...facts.patterns] }
      : {}),
  };
}

/** The prompt-history row for a structured prompt the scraper never saw. */
export function buildStructuredPromptHistoryRecord(
  worktreeId: string,
  facts: StructuredPromptFacts,
): StructuredPromptHistoryRecord {
  return {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question: buildStructuredPromptQuestion(worktreeId, facts),
    options: [],
    source: facts.source,
    ...(facts.message ? { message: facts.message } : {}),
    ...(facts.toolName ? { toolName: facts.toolName } : {}),
    ...(facts.askUserQuestion ? { askUserQuestion: facts.askUserQuestion } : {}),
  };
}

/** Whether this prompt payload is the degraded structured form. */
export function isStructuredPromptWaitingData(
  value: { type?: unknown } | null | undefined,
): value is StructuredPromptWaitingData {
  return value?.type === UNCLASSIFIED_PROMPT_TYPE;
}
