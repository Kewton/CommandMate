import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, MessageCircleQuestion, ShieldCheck } from 'lucide-react';
import {
  countToolApprovalEntries,
  type ToolApprovalEntry,
  type ToolApprovalOutcome,
} from '@/lib/chat/chat-tool-approvals';
import {
  CHAT_BUBBLE_ROW_CLASS,
  CHAT_TOOL_ACTIVITY_CHIP_CLASS,
  useChatToolActivityDisclosure,
} from '@/components/worktree/chat-bubble-tool-activity';

// ============================================================================
// Tool approvals (Issue #2245)
// ============================================================================

/** The collapsible row a run of approval dialogs is drawn as. */
export const CHAT_TOOL_APPROVAL_GROUP_TESTID = 'chat-tool-approval-group';
/** The disclosure control on that row. */
export const CHAT_TOOL_APPROVAL_TOGGLE_TESTID = 'chat-tool-approval-toggle';
/** One chip inside an opened group. */
export const CHAT_TOOL_APPROVAL_ENTRY_TESTID = 'chat-tool-approval-entry';

/** The `chatTranscript.toolApproval.*` key describing each outcome. */
const OUTCOME_LABEL_KEY: Record<ToolApprovalOutcome, string> = {
  human: 'chatTranscript.toolApproval.answeredByHuman',
  auto: 'chatTranscript.toolApproval.autoApproved',
  terminal: 'chatTranscript.toolApproval.answeredInTerminal',
  pending: 'chatTranscript.toolApproval.awaitingAnswer',
  unclassified: 'chatTranscript.toolApproval.unclassified',
  unknown: 'chatTranscript.toolApproval.resolved',
};

/**
 * The same map for a QUESTION row (Issue #2460).
 *
 * One entry differs, and it is the one that was wrong on screen: a question
 * Auto-Yes answered was labelled "auto-APPROVED", which reads as a permission
 * decision on a dialog nobody ever saw as a question. Everything else — who
 * answered, awaiting an answer, resolved — says the same thing about both kinds
 * and is deliberately not duplicated into a second vocabulary.
 */
const QUESTION_OUTCOME_LABEL_KEY: Record<ToolApprovalOutcome, string> = {
  ...OUTCOME_LABEL_KEY,
  auto: 'chatTranscript.toolApproval.autoAnswered',
};

/**
 * A run of tool-approval dialogs, as one collapsed row.
 *
 * ## Why a group rather than one chip per row
 *
 * Chips are an improvement over 2 KB bubbles even one at a time, but the shape
 * of the data is runs: 41 consecutive `Approve Bash?` rows between two sentences
 * on the codex worktree, 13 on the antigravity one. Forty-one one-line chips is
 * still forty-one rows of scrolling between a question and its answer. Closed by
 * default, therefore — and openable, because the information is not deleted,
 * only folded.
 *
 * ## What the summary counts (Issue #2460)
 *
 * Approvals, questions and loose submit confirmations, each on its own, from the
 * FOLDED chips. `entries.length` and `messageIds.length` are both wrong here for
 * the same reason from opposite ends: the second counts the rows the producers
 * duplicated (three, for the measured two-question call) and the first counts
 * chips of mixed kinds under one noun. `data-approval-count` keeps meaning "how
 * many chips", which is what #2245's tests read it for, and the breakdown lives
 * beside it in three attributes of its own.
 *
 * ## Why nothing but open/closed is remembered
 *
 * Open/closed is the reader's, and since Issue #2284 it is the READER'S for the
 * whole column: {@link useChatToolActivityDisclosure} answers to the
 * transcript's one tool-activity toggle, with a per-chip override that lasts
 * until that toggle moves again. Everything else is derived
 * from `entries` on every render, with nothing cached: `promptData.status` flips
 * pending → answered through a `message_updated` push, and a chip that
 * remembered its own outcome would keep saying "awaiting answer" after the
 * dialog was answered — or, since #2460, would keep counting an answered
 * question as an approval.
 */
export const ChatToolApprovalGroup = memo(function ChatToolApprovalGroup({
  entries,
}: {
  entries: ToolApprovalEntry[];
}) {
  const t = useTranslations('worktree');
  // [#2284] The transcript's toggle reaches this run too: approvals, the tool
  // log and the reasoning are one kind of thing and answer to one control.
  const { isOpen, toggle } = useChatToolActivityDisclosure();

  if (entries.length === 0) return null;

  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const counts = countToolApprovalEntries(entries);
  const hasQuestions = counts.questions + counts.confirmations > 0;
  const hasApprovals = counts.approvals > 0;

  // Every non-empty count, in one order, joined by the locale's own separator:
  // `ツール承認 1 件・質問 2 件`. A zero is not printed — "questions · 0" tells
  // the reader to look for something that is not there.
  const summarySegments: string[] = [];
  if (hasApprovals) {
    summarySegments.push(t('chatTranscript.toolApproval.summary', { count: counts.approvals }));
  }
  if (counts.questions > 0) {
    summarySegments.push(
      t('chatTranscript.toolApproval.summaryQuestions', { count: counts.questions }),
    );
  }
  if (counts.confirmations > 0) {
    // Alone, a confirmation has to name what it confirms ("質問の送信確認"); beside
    // the questions it belongs to, the short form is enough and the long one
    // repeats the word "question" twice in one chip.
    summarySegments.push(
      t(
        hasApprovals || counts.questions > 0
          ? 'chatTranscript.toolApproval.summaryConfirmations'
          : 'chatTranscript.toolApproval.summaryConfirmationsOnly',
        { count: counts.confirmations },
      ),
    );
  }

  // The toggle names what it opens. A group of questions that says "show the
  // tool approvals" is the same mislabelling as the summary, one control lower.
  const toggleSuffix = hasQuestions && hasApprovals ? 'Mixed' : hasQuestions ? 'Questions' : '';
  const Icon = hasApprovals ? ShieldCheck : MessageCircleQuestion;

  return (
    <div
      data-testid={CHAT_TOOL_APPROVAL_GROUP_TESTID}
      data-approval-count={entries.length}
      data-approvals={counts.approvals}
      data-questions={counts.questions}
      data-confirmations={counts.confirmations}
      className={`${CHAT_BUBBLE_ROW_CLASS} items-start`}
    >
      <button
        type="button"
        data-testid={CHAT_TOOL_APPROVAL_TOGGLE_TESTID}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-label={t(
          `chatTranscript.toolApproval.${isOpen ? 'collapse' : 'expand'}${toggleSuffix}`,
        )}
        className={CHAT_TOOL_ACTIVITY_CHIP_CLASS}
      >
        <Icon size={12} aria-hidden="true" />
        <span>{summarySegments.join(t('chatTranscript.toolApproval.summarySeparator'))}</span>
        <Chevron size={12} aria-hidden="true" />
      </button>

      {isOpen && (
        <ul
          data-testid="chat-tool-approval-list"
          className="mr-auto flex w-full max-w-full flex-col gap-1 pl-1"
        >
          {entries.map((entry) => {
            const isQuestion = entry.kind === 'question';
            const outcomeKey = isQuestion ? QUESTION_OUTCOME_LABEL_KEY : OUTCOME_LABEL_KEY;
            const fallbackLabelKey = !isQuestion
              ? 'chatTranscript.toolApproval.unlabeled'
              : entry.phase === 'confirmation'
                ? 'chatTranscript.toolApproval.submitConfirmation'
                : 'chatTranscript.toolApproval.unlabeledQuestion';

            return (
              <li
                key={entry.id}
                data-testid={CHAT_TOOL_APPROVAL_ENTRY_TESTID}
                data-approval-outcome={entry.outcome}
                data-approval-kind={entry.kind}
                data-approval-phase={entry.phase}
                data-approval-confirmation={entry.confirmationOutcome}
                data-approval-audit={entry.isPermissionAudit ? 'true' : undefined}
                data-approval-merged={entry.messageIds.length}
                className="flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
              >
                {entry.phase === 'confirmation' && entry.label && (
                  <span data-testid="chat-tool-approval-phase">
                    {t('chatTranscript.toolApproval.submitConfirmation')}
                  </span>
                )}
                <span className="min-w-0 break-words [word-break:break-word] font-mono text-foreground">
                  {entry.label || t(fallbackLabelKey)}
                </span>
                <span data-testid="chat-tool-approval-outcome">{t(outcomeKey[entry.outcome])}</span>
                {/* [#2460] The confirmer, beside the answerer rather than over
                    it: the measured set was answered by Auto-Yes and submitted
                    by a person, and one outcome cannot say both. */}
                {entry.confirmationOutcome && (
                  <span data-testid="chat-tool-approval-confirmation">
                    {t('chatTranscript.toolApproval.confirmation', {
                      outcome: t(QUESTION_OUTCOME_LABEL_KEY[entry.confirmationOutcome]),
                    })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
