/**
 * PromptPanel Component
 *
 * A dedicated panel for displaying and responding to Claude prompts.
 * Supports yes/no prompts, multiple choice prompts, and text input.
 * Features fade-in/fade-out animations.
 */

'use client';

import { memo, useState, useCallback, useId } from 'react';
import { useTranslations } from 'next-intl';
import type { LivePromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';
import { isAnswerablePromptData } from '@/types/models';
import type {
  StructuredDecisionOption,
  StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import {
  isQuestionFreeTextNumeric,
  QUESTION_FREE_TEXT_MAX_LENGTH,
  readQuestionFreeText,
} from '@/components/worktree/prompt-decision-id';
import { PromptStuckHint } from '@/components/worktree/PromptStuckHint';

import {
  derivePromptView,
  readQuestionChoices,
  type PromptView,
  type QuestionChoices,
} from '@/lib/session/prompt-view';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { Checkbox, RadioGroup, RadioGroupItem, Button, Spinner } from '@/components/ui';
import { usePromptAnimation } from '@/hooks/usePromptAnimation';
import { usePromptAnswerState } from '@/hooks/usePromptAnswerState';
import {
  promptHeadingText,
  promptQuestionKey,
} from '@/components/worktree/prompt-answer';

/** Animation duration for prompt panel transitions */
const ANIMATION_DURATION_MS = 200;

/** Common button base styles */
const BUTTON_BASE_STYLES = `
  px-6 py-2 rounded-lg font-medium transition-all
  disabled:opacity-50 disabled:cursor-not-allowed
  focus:outline-none focus:ring-2 focus:ring-offset-2
`.trim();

/** Primary button styles */
const BUTTON_PRIMARY_STYLES = 'bg-accent-600 text-white hover:bg-accent-700 focus:ring-ring';

/** Secondary button styles */
const BUTTON_SECONDARY_STYLES = 'bg-surface border-2 border-input hover:bg-muted text-foreground focus:ring-ring';

/** Re-exported from `prompt-answer`, where the pure helpers now live (Issue #3209). */
export { promptQuestionKey };

/**
 * Props for PromptPanel component
 */
/**
 * What the panel may be handed (Issue #1725).
 *
 * The union itself now lives in `types/models` as {@link LivePromptData} —
 * Issue #1738, because every layer between `/current-output` and this prop
 * carries the same two shapes and had been typed for only one of them. This
 * alias is kept so the panel's own signatures still read in panel terms; it
 * adds no second definition.
 */
export type PanelPromptData = LivePromptData;

export interface PromptPanelProps {
  /** Prompt data (question, options, etc.) */
  promptData: PanelPromptData | null;
  /** Associated message ID */
  messageId: string | null;
  /**
   * The approval the agent is holding, when it published an id for one
   * (Issue #1932).
   *
   * Not an alternative spelling of {@link PromptPanelProps.messageId}. A
   * message id names a row this server stored after reading a dialog off the
   * pane; a decision id names an approval the AGENT is blocked on, answered
   * over its own API with no keys sent anywhere — which for a source whose
   * dialog the scraper cannot parse (opencode) is the only way to answer at
   * all. The panel does not choose between them: it hands whichever it was
   * given to {@link PromptPanelProps.onRespond}, and the caller decides where
   * to post.
   */
  decisionId?: string | null;
  /** Whether the panel is visible */
  visible: boolean;
  /** Whether user is currently answering (submitting response) */
  answering: boolean;
  /**
   * Callback when user submits a response.
   *
   * `decisionId` is the panel's own prop, passed back so a caller answering a
   * structured approval does not have to thread it through its own state. The
   * second parameter is optional so every pre-#1932 one-argument handler is
   * still assignable.
   */
  onRespond: (answer: string, decisionId?: string | null) => Promise<void>;
  /** Optional callback to dismiss the panel */
  onDismiss?: () => void;
  /** CLI tool display name (e.g., 'Claude', 'Gemini') for header */
  cliToolName?: string;
  /**
   * Issue #2869: the same window has survived two Sends in a row. Drawn only
   * together with {@link PromptPanelProps.onSwitchToDirectInput}.
   */
  showStuckHint?: boolean;
  /** Issue #2869: the hint's link — opens direct-input mode for this pane. */
  onSwitchToDirectInput?: () => void;
  /**
   * Issue #2870: whether `/prompt-response` would answer this window — the
   * status API's `promptAnswerable`. `false` keeps the options on screen but
   * disables every control, and says to use direct input instead (with the
   * #2869 link, no Send count needed). Undefined or `true`: unchanged.
   */
  answerable?: boolean;
}

/** The PC logs a failed respond outside production (Issue #3209: moved out of the handlers). */
function logRespondError(error: unknown): void {
  // Log error for debugging purposes
  if (process.env.NODE_ENV !== 'production') {
    console.error('[PromptPanel] Failed to respond:', error);
  }
}

/** Props for PromptPanelContent component */
interface PromptPanelContentProps {
  promptData: PanelPromptData;
  answering: boolean;
  onRespond: (answer: string, decisionId?: string | null) => Promise<void>;
  /** Issue #1932. See {@link PromptPanelProps.decisionId}. */
  decisionId?: string | null;
  onDismiss?: () => void;
  labelId: string;
  cliToolName?: string;
  /** Issue #2870. See {@link PromptPanelProps.answerable}. */
  answerable?: boolean;
}

/**
 * Internal content component for PromptPanel
 */
function PromptPanelContent({
  promptData,
  answering,
  onRespond,
  decisionId,
  onDismiss,
  labelId,
  cliToolName,
  answerable,
}: PromptPanelContentProps) {
  const t = useTranslations('prompt');
  // Issue #1932: the PC forwards the decision id with every answer, logs a
  // failed respond outside production, and refuses the structured submit
  // without an id.
  const send = useCallback(
    (answer: string) => onRespond(answer, decisionId),
    [onRespond, decisionId],
  );
  const {
    selectedOption,
    setSelectedOption,
    checkedNumbers,
    textInputValue,
    setTextInputValue,
    multiSelectOptions,
    takesTypedText,
    isBusy,
    isDisabled,
    handleToggleOption,
    handleYesNoClick,
    handleMultipleChoiceSubmit,
    handleMultiSelectSubmit,
    handleDecisionRespond,
  } = usePromptAnswerState({
    promptData,
    answering,
    answerable,
    send,
    onError: logRespondError,
    canRespondDecision: !!decisionId,
  });
  // Issue #3184: what this payload is and how it is answered, decided by the
  // one shared function rather than re-derived from `type` / `decisionOptions`
  // here. See {@link panelPromptView} for which decision id it reads.
  const view = panelPromptView(promptData, decisionId);
  // #3184: type narrowing only — to the closed `PromptData` union (#1725) for
  // the screen controls below, and to the structured form for the notice. It is
  // the same split as `view.kind === 'screen-choices'` (pinned by
  // prompt-view-3184.test); what is SHOWN is decided by `view`.
  const screenPrompt = isAnswerablePromptData(promptData) ? promptData : null;
  const structuredPrompt = screenPrompt === null ? (promptData as StructuredPromptWaitingData) : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 id={labelId} className="text-lg font-semibold text-warning-foreground flex items-center gap-2">
          <span className="text-xl" aria-hidden="true">?</span>
          {cliToolName ? t('confirmationFrom', { toolName: cliToolName }) : t('confirmationFromClaude')}
        </h3>
        {onDismiss && (
          <Button
            variant="ghost"
            type="button"
            onClick={onDismiss}
            aria-label="close"
            className="p-1 rounded hover:bg-warning-border/50 transition-colors"
          >
            <svg className="w-5 h-5 text-warning-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        )}
      </div>

      {/* Instruction Text (context preceding the prompt). Issue #1725: the
          structured form has none — it is built from a Notification payload,
          not from a pane, so there is no scrollback to show. */}
      {screenPrompt?.instructionText && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground bg-muted rounded p-2 border border-border">
          {screenPrompt.instructionText}
        </div>
      )}

      {/* Issue #1726: one `AskUserQuestion` call can carry several questions,
          asked one screen at a time with no event at any transition. Saying
          which one this is stops the panel reading as if it were the whole
          request. */}
      {promptData.type === 'multiple_choice' && promptData.askUserQuestion && (
        <p className="text-xs text-muted-foreground" data-testid="ask-user-question-progress">
          {promptData.askUserQuestion.questionCount > 1
            ? t('askUserQuestionProgress', {
                index: promptData.askUserQuestion.questionIndex + 1,
                total: promptData.askUserQuestion.questionCount,
              })
            : t('askUserQuestionSource')}
        </p>
      )}

      {/* Question. Issue #1725: the structured form's `question` is a server-side
          English one-liner built for `wait` / `capture`; the panel says the same
          thing in the user's locale instead. */}
      <p className="text-foreground leading-relaxed">
        {promptHeadingText(t, view.heading)}
      </p>

      {/* Answering indicator */}
      {isBusy && (
        <div data-testid="answering-indicator" className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
          <Spinner size="sm" variant="accent" />
          <span>{t('sending')}</span>
        </div>
      )}

      {/* Yes/No Prompt */}
      {promptData.type === 'yes_no' && (
        <YesNoPromptActions
          promptData={promptData}
          disabled={isDisabled}
          onYes={() => handleYesNoClick('yes')}
          onNo={() => handleYesNoClick('no')}
        />
      )}

      {/* Multiple Choice Prompt. Issue #2755: a checkbox question is drawn by
          its own component — a RadioGroup cannot express "two of these" — and
          everything else keeps the radio list byte for byte. */}
      {promptData.type === 'multiple_choice' && multiSelectOptions !== null && (
        <MultiSelectPromptActions
          promptData={promptData}
          disabled={isDisabled}
          checkedNumbers={checkedNumbers}
          onToggleOption={handleToggleOption}
          textInputValue={textInputValue}
          onTextInputChange={setTextInputValue}
          showTextInput={takesTypedText}
          onSubmit={handleMultiSelectSubmit}
        />
      )}
      {promptData.type === 'multiple_choice' && multiSelectOptions === null && (
        <MultipleChoicePromptActions
          promptData={promptData}
          disabled={isDisabled}
          selectedOption={selectedOption}
          onSelectOption={setSelectedOption}
          textInputValue={textInputValue}
          onTextInputChange={setTextInputValue}
          showTextInput={takesTypedText}
          onSubmit={handleMultipleChoiceSubmit}
        />
      )}

      {/* Issue #1725: a dialog the structured layer reported and nobody parsed */}
      {structuredPrompt && (
        <UnclassifiedPromptNotice
          promptData={structuredPrompt}
          view={view}
          viewSource={{ ...structuredPrompt, decisionId: view.decisionId }}
          disabled={isDisabled}
          onRespond={handleDecisionRespond}
        />
      )}
    </div>
  );
}

/**
 * The degraded rendering for a dialog only the structured layer can see
 * (Issue #1725).
 *
 * There is nothing to click, and that is the honest state of the world: the
 * agent's `Notification` says a dialog is open and carries no options (#1721
 * §5.5), so any button drawn here would be a guess about which key it sends.
 * What the panel can do instead is stop the session looking idle and say where
 * the answer has to go.
 *
 * The instruction names the option NUMBER on purpose. `respond <id> yes` is not
 * resolved semantically on a numbered dialog — Enter takes the highlighted
 * default, so a "no" can be delivered as an approval (Issue #1681). Telling the
 * user "answer it" without telling them how would walk them into that.
 */
function UnclassifiedPromptNotice({
  promptData,
  view,
  viewSource,
  disabled,
  onRespond,
}: {
  promptData: StructuredPromptWaitingData;
  /** Issue #3184: the panel's {@link PromptView} of this payload. */
  view: PromptView;
  /** The payload with the decision id the view was derived with. */
  viewSource: StructuredPromptWaitingData;
  disabled: boolean;
  onRespond: (answer: string) => void;
}) {
  const t = useTranslations('prompt');
  // Issue #1932: both halves are required. `decisionOptions` says the dialog
  // accepts these three verdicts; `decisionId` says WHICH approval they would
  // be applied to. With options but no id there is nothing to address, and the
  // panel says what it said before — answer it in the terminal.
  //
  // Issue #3184: that "both halves" test is the view's `api-choices` /
  // `approval`, so it is read off the view instead of restated.
  const answerable = view.apiTarget === 'approval' ? promptData.decisionOptions ?? null : null;
  // Issue #2039: the same question asked of the OTHER kind of addressable
  // decision. `readPromptQuestionChoices` returns non-null only when this
  // payload names an id, published choices for exactly one question, and is NOT
  // offering the three approval verdicts — so the two branches below are
  // mutually exclusive by construction rather than by the order they are
  // written in. Answering a question with `Allow once` is refused at the source
  // (`question-needs-answer-verdict`), which is why the panel must not be able
  // to draw both.
  const questionChoices = view.apiTarget === 'question' ? readQuestionChoices(viewSource) : null;

  return (
    <div className="space-y-2" data-testid="unclassified-prompt-notice">
      {/* Issue #2945: a multi-line message is an approval's diff (OpenCode V2's
          `permission.asked` carries the patch), drawn as the lines it is. A
          single line — every other tool's message — renders as before. */}
      {promptData.message && promptData.message.includes('\n') ? (
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-muted p-2 font-mono text-xs text-foreground"
          data-testid="structured-decision-message"
        >
          {promptData.message}
        </pre>
      ) : promptData.message ? (
        <p className="text-sm text-muted-foreground">{promptData.message}</p>
      ) : null}
      {/* Issue #1726: the agent told us what it asked even though nothing could
          read the screen. The labels are listed WITHOUT numbers — the picker
          renumbers and appends its own entries, and this branch exists precisely
          because nobody here can see which screen is up.

          Issue #2039: unless the numbers are REAL. When the payload names the
          question by id, the choices go to `POST /question/:id/reply` by label
          and no key is sent to any pane, so there is no screen to be renumbered
          out from under them — and the list becomes a picker. */}
      {promptData.askUserQuestion && (
        <div className="space-y-1" data-testid="unclassified-ask-user-question">
          <p className="text-sm text-foreground">{promptData.askUserQuestion.question}</p>
          {questionChoices ? (
            <StructuredQuestionActions
              choices={questionChoices}
              disabled={disabled}
              onRespond={onRespond}
            />
          ) : (
            <ul className="list-disc list-inside text-sm text-muted-foreground">
              {promptData.askUserQuestion.labels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Issue #2039: the picker above IS the answer affordance, so neither the
          verdict buttons nor the "answer it in the terminal" line belongs under
          it. The first arm is load-bearing for the second of those — with a
          question drawn, `answerable` is null and the fallback text would
          otherwise contradict the picker it sits below. */}
      {questionChoices ? null : answerable && answerable.length > 0 ? (
        <>
          {/* Issue #2031: what these three buttons are about. Rendered only on
              the addressable branch, so no other tool's panel changes: for
              claude / codex / gemini / copilot / antigravity the payload
              carries `decisionId: null`, `answerable` is null, and this whole
              subtree is the same "answer it in the terminal" line it was. */}
          <StructuredDecisionSubject
            toolName={promptData.toolName ?? null}
            patterns={promptData.patterns ?? null}
            allowAlwaysLabel={
              answerable.find((option) => option.reply === 'always')?.label ?? null
            }
          />
          <StructuredDecisionActions
            options={answerable}
            disabled={disabled}
            onRespond={onRespond}
          />
        </>
      ) : (
        <p className="text-sm text-foreground">
          {t('unclassifiedInstruction', { command: t('unclassifiedRespondCommand') })}
        </p>
      )}
    </div>
  );
}

/**
 * What the approval in front of the user is actually about (Issue #2031).
 *
 * Two facts the payload has been carrying and no surface was showing. The tool
 * name is the `message.part.updated` correlation — `permission.asked` does not
 * name the tool itself (#1758 §5.4) — and `patterns` is the rule answering
 * `Allow always` would SAVE, which is the one verdict here whose effect
 * outlives this dialog. Offering that button without showing its scope asks for
 * a decision whose size the user cannot see.
 *
 * ## Why there is no translated label on any of this
 *
 * Every string rendered here is the agent's own: a tool name, a glob, and the
 * `Allow always` label read straight off {@link STRUCTURED_DECISION_OPTIONS} —
 * which is deliberately untranslated CLI answer vocabulary, for the reason its
 * own comment gives. That is the same rule the rest of this notice already
 * follows: `promptData.message` and the `askUserQuestion` labels above are
 * printed verbatim too. Adding English chrome ("Tool:", "Allows:") would be the
 * only untranslated *display* text in the panel, so the layout carries the
 * relation instead — the label sits directly above the rules it grants.
 */
function StructuredDecisionSubject({
  toolName,
  patterns,
  allowAlwaysLabel,
}: {
  toolName: string | null;
  patterns: readonly string[] | null;
  /** The `Allow always` verdict's own label, or null if it was not offered. */
  allowAlwaysLabel: string | null;
}) {
  const hasPatterns = patterns !== null && patterns.length > 0;
  if (!toolName && !hasPatterns) return null;

  return (
    <div className="space-y-1" data-testid="structured-decision-subject">
      {toolName && (
        <p
          className="text-sm font-medium text-foreground font-mono break-all"
          data-testid="structured-decision-tool"
        >
          {toolName}
        </p>
      )}
      {hasPatterns && (
        <div className="text-xs text-muted-foreground">
          {allowAlwaysLabel && (
            <span data-testid="structured-decision-patterns-label">{allowAlwaysLabel}</span>
          )}
          <ul
            className="mt-0.5 flex flex-wrap gap-1"
            data-testid="structured-decision-patterns"
          >
            {patterns.map((pattern) => (
              <li
                key={pattern}
                className="font-mono break-all bg-muted border border-border rounded px-1.5 py-0.5"
              >
                {pattern}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The three verdicts an addressable approval accepts (Issue #1932).
 *
 * One button per verdict rather than a radio group and a submit: there is no
 * free-text option to guard and no default to preselect, so a second click
 * would only add a way to press "Allow always" by momentum. The labels are the
 * agent's own vocabulary and deliberately not translated — see
 * `STRUCTURED_DECISION_OPTIONS`, which is the same list `commandmate respond`
 * accepts, and a locale-dependent label would make the two disagree.
 */
function StructuredDecisionActions({
  options,
  disabled,
  onRespond,
}: {
  options: readonly StructuredDecisionOption[];
  disabled: boolean;
  onRespond: (answer: string) => void;
}) {
  const t = useTranslations('prompt');

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={t('selectAnOption')}
      data-testid="structured-decision-actions"
    >
      {options.map((option) => (
        <Button
          key={option.number}
          variant="ghost"
          type="button"
          disabled={disabled}
          onClick={() => onRespond(String(option.number))}
          data-testid={`structured-decision-option-${option.number}`}
          className={`${BUTTON_BASE_STYLES} ${
            option.number === 3 ? BUTTON_SECONDARY_STYLES : BUTTON_PRIMARY_STYLES
          }`}
        >
          {option.number}. {option.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * The choices a question published, as a picker (Issue #2039).
 *
 * ## Why this is a radio group and the verdicts next door are buttons
 *
 * {@link StructuredDecisionActions} is one button per verdict because there is
 * no wrong click to protect against being made twice — three fixed options, no
 * default, and a second click would only add a way to hit `Allow always` by
 * momentum. A question is the other case: the list is the agent's own, of
 * unbounded length, and the labels are prose rather than three words an operator
 * has read a hundred times. Select-then-submit is what
 * {@link MultipleChoicePromptActions} already does for exactly that content, so
 * this looks the same on purpose — the Issue asks for the choices to be drawn
 * "like multiple_choice", and a user should not have to learn that a picker
 * behaves differently depending on which layer could see it.
 *
 * ## What is sent
 *
 * The option NUMBER, 1-based in payload order —
 * `resolveStructuredQuestionAnswer` resolves it against the same list read from
 * `listPending()`. Not the label: a label that happens to be a digit would be
 * read as a number by that resolver, and a label sent verbatim would then be a
 * choice the operator did not click. The number cannot collide with itself.
 *
 * Issue #2951: a question that takes a typed answer (`choices.custom`) also
 * gets a text input. Typing clears the radio and picking a radio clears the
 * text, so what Submit sends is never ambiguous; the typed text is sent as the
 * answer, guarded by `readQuestionFreeText` (digits alone would be read as an
 * option number, so they are refused here with a hint).
 *
 * Single-select only. `multiSelect` is on the agent's own payload but
 * `summarizeAskUserQuestion` does not carry it to the browser, so the panel
 * cannot know when several answers are allowed; the API accepts `1,3` for the
 * questions that do. Widening the browser payload is a `lib/session` change and
 * this Issue does not own that file.
 */
function StructuredQuestionActions({
  choices,
  disabled,
  onRespond,
}: {
  choices: QuestionChoices;
  disabled: boolean;
  onRespond: (answer: string) => void;
}) {
  const t = useTranslations('prompt');
  const groupName = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const [freeText, setFreeText] = useState('');
  const typedAnswer = choices.custom ? readQuestionFreeText(freeText) : null;
  const typedIsNumeric = choices.custom === true && isQuestionFreeTextNumeric(freeText);

  const getOptionClasses = useCallback(
    (optionNumber: number) => {
      const isSelected = selected === optionNumber;
      const baseClasses = 'flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all';
      const selectionClasses = isSelected
        ? 'bg-accent-50 dark:bg-accent-900/30 border-2 border-accent-500'
        : 'bg-surface border-2 border-border hover:border-input';
      const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';
      return `${baseClasses} ${selectionClasses} ${disabledClasses}`;
    },
    [selected, disabled],
  );

  return (
    <div className="space-y-3" data-testid="structured-question-actions">
      <fieldset>
        <legend className="sr-only">{t('selectAnOption')}</legend>
        <RadioGroup
          name={groupName}
          value={selected != null ? String(selected) : ''}
          onValueChange={(v) => {
            setSelected(Number(v));
            setFreeText('');
          }}
          disabled={disabled}
          className="flex flex-col gap-2"
        >
          {choices.labels.map((label, index) => (
            /* Index-keyed on purpose: the agent may offer the same label twice,
               and the POSITION is what is being answered with. */
            <label key={`${index + 1}-${label}`} className={getOptionClasses(index + 1)}>
              <RadioGroupItem value={String(index + 1)} className="mt-1" />
              <div className="flex-1">
                <span className="font-medium">{index + 1}. {label}</span>
              </div>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {choices.custom && (
        <div>
          <label htmlFor={`free-text-${groupName}`} className="block text-sm text-muted-foreground mb-1">
            {t('freeTextLabel')}
          </label>
          <input
            id={`free-text-${groupName}`}
            data-testid="structured-question-free-text"
            type="text"
            value={freeText}
            maxLength={QUESTION_FREE_TEXT_MAX_LENGTH}
            onChange={(e) => {
              setFreeText(e.target.value);
              if (e.target.value !== '') setSelected(null);
            }}
            disabled={disabled}
            placeholder={t('enterValuePlaceholder')}
            className="w-full px-4 py-2 border-2 border-input dark:bg-muted dark:text-foreground rounded-lg focus:outline-none focus:border-accent-500 disabled:opacity-50"
          />
          {typedIsNumeric && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="structured-question-free-text-numeric">
              {t('freeTextNumericHint')}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="structured-question-submit"
        onClick={() => {
          if (typedAnswer !== null) onRespond(typedAnswer);
          else if (selected !== null) onRespond(String(selected));
        }}
        disabled={disabled || (selected === null && typedAnswer === null)}
        className={`w-full ${BUTTON_BASE_STYLES} ${BUTTON_PRIMARY_STYLES}`}
      >
        {t('submit')}
      </button>
    </div>
  );
}

/** Props for YesNoPromptActions component */
interface YesNoPromptActionsProps {
  promptData: YesNoPromptData;
  disabled: boolean;
  onYes: () => void;
  onNo: () => void;
}

/**
 * Yes/No prompt action buttons
 */
function YesNoPromptActions({
  promptData,
  disabled,
  onYes,
  onNo,
}: YesNoPromptActionsProps) {
  const t = useTranslations('prompt');
  const isYesDefault = promptData.defaultOption === 'yes';
  const isNoDefault = promptData.defaultOption === 'no';

  const yesButtonClasses = `${BUTTON_BASE_STYLES} ${BUTTON_PRIMARY_STYLES} ${isYesDefault ? 'primary default highlighted' : ''}`;
  const noButtonClasses = `${BUTTON_BASE_STYLES} ${isNoDefault ? 'bg-foreground text-background hover:bg-foreground/90 primary default highlighted' : BUTTON_SECONDARY_STYLES}`;

  return (
    <div className="flex items-center gap-3" role="group" aria-label={t('yesNoGroupLabel')}>
      <Button
        variant="ghost"
        type="button"
        onClick={onYes}
        disabled={disabled}
        className={yesButtonClasses}
      >
        {t('yes')}
      </Button>
      <Button
        variant="ghost"
        type="button"
        onClick={onNo}
        disabled={disabled}
        className={noButtonClasses}
      >
        {t('no')}
      </Button>
    </div>
  );
}

/** Props for MultipleChoicePromptActions component */
interface MultipleChoicePromptActionsProps {
  promptData: MultipleChoicePromptData;
  disabled: boolean;
  selectedOption: number | null;
  onSelectOption: (num: number) => void;
  textInputValue: string;
  onTextInputChange: (value: string) => void;
  showTextInput: boolean;
  onSubmit: () => void;
}

/**
 * Multiple choice prompt action options
 */
function MultipleChoicePromptActions({
  promptData,
  disabled,
  selectedOption,
  onSelectOption,
  textInputValue,
  onTextInputChange,
  showTextInput,
  onSubmit,
}: MultipleChoicePromptActionsProps) {
  const groupName = useId();
  const t = useTranslations('prompt');

  const getOptionClasses = useCallback((optionNumber: number) => {
    const isSelected = selectedOption === optionNumber;
    const baseClasses = 'flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all';
    const selectionClasses = isSelected
      ? 'bg-accent-50 dark:bg-accent-900/30 border-2 border-accent-500'
      : 'bg-surface border-2 border-border hover:border-input';
    const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';
    return `${baseClasses} ${selectionClasses} ${disabledClasses}`;
  }, [selectedOption, disabled]);

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">{t('selectAnOption')}</legend>
        <RadioGroup
          name={groupName}
          value={selectedOption != null ? String(selectedOption) : ''}
          onValueChange={(v) => onSelectOption(Number(v))}
          disabled={disabled}
          className="flex flex-col gap-2"
        >
          {promptData.options.map((option) => (
            <label
              key={option.number}
              className={getOptionClasses(option.number)}
            >
              <RadioGroupItem
                value={String(option.number)}
                className="mt-1"
                aria-describedby={option.isDefault ? `default-${option.number}` : undefined}
              />
              <div className="flex-1">
                <span className="font-medium">{option.number}. {option.label}</span>
                {option.isDefault && (
                  <span id={`default-${option.number}`} className="ml-2 text-xs text-accent-600 dark:text-accent-400 bg-accent-100 dark:bg-accent-900/30 px-2 py-0.5 rounded">
                    {t('default')}
                  </span>
                )}
                {/* Issue #1726: the picker's second line, which only the agent's
                    own AskUserQuestion payload carries — the scraper treats it
                    as a continuation line and drops it. */}
                {option.description && (
                  <p className="mt-0.5 text-sm text-muted-foreground">{option.description}</p>
                )}
              </div>
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      {/* Text input for options that require it */}
      {showTextInput && (
        <div className="mt-3">
          <label htmlFor={`text-input-${groupName}`} className="sr-only">{t('customValueInput')}</label>
          <input
            id={`text-input-${groupName}`}
            type="text"
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            disabled={disabled}
            placeholder={t('enterValuePlaceholder')}
            className="w-full px-4 py-2 border-2 border-input dark:bg-muted dark:text-foreground rounded-lg focus:outline-none focus:border-accent-500 disabled:opacity-50"
          />
        </div>
      )}

      {/* Submit button */}
      {/* Issue #1061: full-width (w-full) without justify-center — base centering/hover-lift would alter layout — 残置 */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled || selectedOption === null}
        className={`w-full ${BUTTON_BASE_STYLES} ${BUTTON_PRIMARY_STYLES}`}
      >
        {t('submit')}
      </button>
    </div>
  );
}

/** Props for MultiSelectPromptActions component (Issue #2755). */
interface MultiSelectPromptActionsProps {
  promptData: MultipleChoicePromptData;
  disabled: boolean;
  /** Option numbers currently ticked, in click order. */
  checkedNumbers: readonly number[];
  onToggleOption: (optionNumber: number, checked: boolean) => void;
  textInputValue: string;
  onTextInputChange: (value: string) => void;
  showTextInput: boolean;
  onSubmit: () => void;
}

/**
 * The answer affordance for a CHECKBOX question (Issue #2755).
 *
 * A separate component from {@link MultipleChoicePromptActions} rather than a
 * mode inside it, for the reason the Issue gives for not splitting the PR: a
 * `RadioGroup` is structurally one-of-N, so the moment the payload says several
 * answers are allowed the control has to be a different one. Keeping the radio
 * list untouched is also what lets 受入基準 (c) pin that single-select screens
 * did not move.
 *
 * ## What the rows say
 *
 * Each box opens on `option.checked` — the state the TERMINAL is in — so the
 * card and the pane agree before the operator touches anything. There is no
 * `Default` badge: on this screen the `❯` is a cursor marking the row a key
 * would toggle, not a pre-selected answer, and labelling it "default" is
 * exactly the misreading that had `respond --default` untick somebody's choice.
 *
 * Submit is live as soon as one box is ticked — the same rule the radio list
 * uses for `selectedOption === null` — except when the ticked set includes the
 * free-text row, which sends its TEXT and therefore needs some.
 */
function MultiSelectPromptActions({
  promptData,
  disabled,
  checkedNumbers,
  onToggleOption,
  textInputValue,
  onTextInputChange,
  showTextInput,
  onSubmit,
}: MultiSelectPromptActionsProps) {
  const groupName = useId();
  const t = useTranslations('prompt');

  const getOptionClasses = useCallback((checked: boolean) => {
    const baseClasses = 'flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all';
    const selectionClasses = checked
      ? 'bg-accent-50 dark:bg-accent-900/30 border-2 border-accent-500'
      : 'bg-surface border-2 border-border hover:border-input';
    const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';
    return `${baseClasses} ${selectionClasses} ${disabledClasses}`;
  }, [disabled]);

  const nothingTicked = checkedNumbers.length === 0;
  const textMissing = showTextInput && textInputValue.trim() === '';

  return (
    <div className="space-y-3" data-testid="multi-select-prompt-actions">
      <p className="text-xs text-muted-foreground" data-testid="multi-select-hint">
        {t('multiSelectHint')}
      </p>
      <fieldset>
        <legend className="sr-only">{t('selectAllThatApply')}</legend>
        <div
          role="group"
          aria-label={t('selectAllThatApply')}
          className="flex flex-col gap-2"
        >
          {promptData.options.map((option) => {
            const checked = checkedNumbers.includes(option.number);
            return (
              <label key={option.number} className={getOptionClasses(checked)}>
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => onToggleOption(option.number, next === true)}
                  disabled={disabled}
                  className="mt-1"
                  data-testid={`multi-select-option-${option.number}`}
                  aria-label={`${option.number}. ${option.label}`}
                />
                <div className="flex-1">
                  <span className="font-medium">{option.number}. {option.label}</span>
                  {option.description && (
                    <p className="mt-0.5 text-sm text-muted-foreground">{option.description}</p>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* The free-text row's field. Ticking `Type something...` is how this
          screen offers one, and its text is sent INSTEAD of the numbers. */}
      {showTextInput && (
        <div className="mt-3">
          <label htmlFor={`multi-text-input-${groupName}`} className="sr-only">{t('customValueInput')}</label>
          <input
            id={`multi-text-input-${groupName}`}
            type="text"
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            disabled={disabled}
            placeholder={t('enterValuePlaceholder')}
            className="w-full px-4 py-2 border-2 border-input dark:bg-muted dark:text-foreground rounded-lg focus:outline-none focus:border-accent-500 disabled:opacity-50"
          />
        </div>
      )}

      <button
        type="button"
        data-testid="multi-select-submit"
        onClick={onSubmit}
        disabled={disabled || nothingTicked || textMissing}
        className={`w-full ${BUTTON_BASE_STYLES} ${BUTTON_PRIMARY_STYLES}`}
      >
        {t('submit')}
      </button>
    </div>
  );
}

/**
 * Generates container class names based on animation state
 */
function getContainerClasses(animationClass: string): string {
  const baseClasses = 'bg-warning-subtle border-2 border-warning-border rounded-lg p-4 shadow-lg transition-all duration-200 ease-in-out';

  let animationStyles = 'opacity-100';
  if (animationClass === 'animate-fade-in') {
    animationStyles = 'opacity-100 transform translate-y-0';
  } else if (animationClass === 'animate-fade-out') {
    animationStyles = 'opacity-0 transform translate-y-2';
  }

  return `${baseClasses} ${animationClass} ${animationStyles}`;
}

/**
 * PromptPanel - Dedicated prompt response panel
 *
 * Displays Claude prompts with interactive response options.
 * Supports yes/no prompts, multiple choice prompts, and text input.
 *
 * @example
 * ```tsx
 * <PromptPanel
 *   promptData={state.prompt.data}
 *   messageId={state.prompt.messageId}
 *   visible={state.prompt.visible}
 *   answering={state.prompt.answering}
 *   onRespond={handleRespond}
 *   onDismiss={handleDismiss}
 * />
 * ```
 */
export const PromptPanel = memo(function PromptPanel({
  promptData,
  // messageId reserved for future use (tracking, analytics)
  messageId: _messageId,
  decisionId,
  visible,
  answering,
  onRespond,
  onDismiss,
  cliToolName,
  showStuckHint,
  onSwitchToDirectInput,
  answerable,
}: PromptPanelProps) {
  const { shouldRender, animationClass } = usePromptAnimation({
    visible: visible && promptData !== null,
    duration: ANIMATION_DURATION_MS,
  });
  const labelId = useId();

  // Don't render if not visible or no prompt data
  if (!shouldRender || !promptData) {
    return null;
  }

  const containerClasses = getContainerClasses(animationClass);

  return (
    <ErrorBoundary componentName="PromptPanel">
      <div
        data-testid="prompt-panel"
        role="dialog"
        aria-labelledby={labelId}
        aria-modal="true"
        className={containerClasses}
      >
        <PromptPanelContent
          promptData={promptData}
          answering={answering}
          onRespond={onRespond}
          decisionId={decisionId}
          onDismiss={onDismiss}
          labelId={labelId}
          cliToolName={cliToolName}
          answerable={answerable}
        />
        <PromptStuckHint
          showStuckHint={showStuckHint}
          onSwitchToDirectInput={onSwitchToDirectInput}
          answerable={answerable}
          linkClassName="underline font-medium hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-border rounded"
        />
      </div>
    </ErrorBoundary>
  );
});

export default PromptPanel;

/**
 * The panel's view of its payload (Issue #3184).
 *
 * The decision id is the panel's own `decisionId` prop and nothing else: it is
 * the id every answer is sent with (#1932), and `handleDecisionRespond` refuses
 * to send without it — so a payload that names an id the caller did not pass
 * must not draw buttons, nor a heading that promises them
 * (`PromptPanelDecisionSubject-2031`'s "verdicts but no id" case).
 */
function panelPromptView(promptData: PanelPromptData, decisionId: string | null | undefined): PromptView {
  // derivePromptView answers null only for a null payload; the panel has one.
  return derivePromptView({ ...promptData, decisionId: decisionId ?? null })!;
}
