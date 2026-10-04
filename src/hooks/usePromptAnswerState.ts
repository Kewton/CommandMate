/**
 * usePromptAnswerState
 *
 * The answer state and submit handlers shared by `PromptPanel` (PC) and
 * `MobilePromptSheet` (phone), moved here from the two components (Issue #3209).
 *
 * What differs between the surfaces stays with the caller:
 * - `send` — the PC forwards the decision id with the answer, the phone does not.
 * - `onError` — the PC logs outside production, the phone swallows the error.
 * - `requireDecisionId` — the PC's structured submit refuses to fire without a
 *   decision id; the phone's does not.
 */

import { useState, useCallback, useMemo } from 'react';
import type { LivePromptData } from '@/types/models';
import { optionTakesTypedText } from '@/lib/session/prompt-view';
import {
  initialCheckedNumbers,
  initialSelectedOption,
  promptQuestionKey,
} from '@/components/worktree/prompt-answer';

export interface UsePromptAnswerStateParams {
  promptData: LivePromptData;
  answering: boolean;
  /** Issue #2870. */
  answerable?: boolean;
  /** Delivers an answer to the caller's own `onRespond`. */
  send: (answer: string) => Promise<void>;
  /** Called with whatever `send` rejected with; omitted = swallowed. */
  onError?: (error: unknown) => void;
  /**
   * `false` makes {@link UsePromptAnswerStateResult.handleDecisionRespond} do
   * nothing (the PC passes `!!decisionId`). Omitted = always allowed.
   */
  canRespondDecision?: boolean;
}

export function usePromptAnswerState({
  promptData,
  answering,
  answerable,
  send,
  onError,
  canRespondDecision = true,
}: UsePromptAnswerStateParams) {
  const [selectedOption, setSelectedOption] = useState<number | null>(
    () => initialSelectedOption(promptData),
  );
  // Issue #2755: the boxes ticked on a checkbox question, as the operator has
  // them right now. Ascending order is applied at submit time, not here, so a
  // click never reorders the list under the pointer.
  const [checkedNumbers, setCheckedNumbers] = useState<readonly number[]>(
    () => initialCheckedNumbers(promptData),
  );
  const [textInputValue, setTextInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Issue #2755: reset when the QUESTION changes, and only then. The card is
  // not remounted between the questions of one `AskUserQuestion` call, so a
  // `useState` initialiser is not enough — see {@link promptQuestionKey}.
  // Written as the documented "adjust state during render" pattern rather than
  // an effect: React re-renders this component immediately with the new state
  // and nothing downstream ever sees the stale selection.
  const questionKey = promptQuestionKey(promptData);
  const [seenQuestionKey, setSeenQuestionKey] = useState(questionKey);
  if (questionKey !== seenQuestionKey) {
    setSeenQuestionKey(questionKey);
    setSelectedOption(initialSelectedOption(promptData));
    setCheckedNumbers(initialCheckedNumbers(promptData));
    setTextInputValue('');
  }

  /** The checkbox question's options, or null when this is not one (#2755). */
  const multiSelectOptions = promptData.type === 'multiple_choice'
    && promptData.multiSelect === true
    ? promptData.options
    : null;

  // Memoize selected option data to avoid recalculation on every render
  const selectedOptionData = useMemo(() => {
    if (promptData.type !== 'multiple_choice') return null;
    return promptData.options.find(opt => opt.number === selectedOption) ?? null;
  }, [promptData, selectedOption]);

  // Issue #2573: the text field is offered — and its text sent — only for an
  // option that IS a text field on screen, not for every `requiresTextInput` row.
  // Issue #2755: on a checkbox question the same rule reads the TICKED rows —
  // ticking `Type something...` is how that screen offers its text field.
  const checkedTextFieldNumbers = useMemo(
    () =>
      (multiSelectOptions ?? [])
        .filter((opt) => checkedNumbers.includes(opt.number) && optionTakesTypedText(opt))
        .map((opt) => opt.number),
    [multiSelectOptions, checkedNumbers],
  );
  const takesTypedText = multiSelectOptions !== null
    ? checkedTextFieldNumbers.length > 0
    : selectedOptionData !== null && optionTakesTypedText(selectedOptionData);

  const isBusy = answering || isSubmitting;
  // Issue #2870: a window the route would refuse keeps its options on screen
  // but nothing on it can be pressed.
  const isDisabled = isBusy || answerable === false;

  const handleToggleOption = useCallback((optionNumber: number, checked: boolean) => {
    setCheckedNumbers((previous) =>
      checked
        ? previous.includes(optionNumber) ? previous : [...previous, optionNumber]
        : previous.filter((n) => n !== optionNumber),
    );
  }, []);

  // Handle yes/no button click
  const handleYesNoClick = useCallback(async (answer: 'yes' | 'no') => {
    if (isDisabled) return;
    setIsSubmitting(true);
    try {
      await send(answer);
    } catch (error) {
      onError?.(error);
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, send, onError]);

  // Handle multiple choice submit
  const handleMultipleChoiceSubmit = useCallback(async () => {
    if (isDisabled || selectedOption === null) return;
    setIsSubmitting(true);
    try {
      // A text field with a value sends the text; every other option, including
      // a menu row that reads as taking text, sends its number (Issue #2573).
      const answer = takesTypedText && textInputValue.trim()
        ? textInputValue.trim()
        : selectedOption.toString();
      await send(answer);
    } catch (error) {
      onError?.(error);
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, send, onError, selectedOption, takesTypedText, textInputValue]);

  /**
   * Submit a checkbox question (Issue #2755).
   *
   * The answer is the SET, ascending, de-duplicated and comma-separated —
   * `"1,3"` — because that is what the sender turns into toggles against the
   * boxes on screen. A ticked `Type something...` sends the TEXT and nothing
   * else: the two cannot be combined, since typing into that row is what ticks
   * it and the other numbers would be swallowed by the field.
   */
  const handleMultiSelectSubmit = useCallback(async () => {
    if (isDisabled) return;
    const numbers = [...checkedNumbers].sort((a, b) => a - b);
    if (numbers.length === 0) return;
    const answer = takesTypedText ? textInputValue.trim() : numbers.join(',');
    if (answer === '') return;
    setIsSubmitting(true);
    try {
      await send(answer);
    } catch (error) {
      onError?.(error);
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, send, onError, checkedNumbers, takesTypedText, textInputValue]);

  // Issue #1932: the degraded form's own submit. Separate from the two above
  // because there is no `selectedOption` state behind it — the verdict comes
  // straight off the button that was pressed — and because on the PC it must
  // never fire without a decision id: these numbers address an approval over
  // the agent's API, and posting one with no id would send it down the
  // keystroke path, where a bare "1" at a picker means whatever line is
  // highlighted (#1681). Issue #2945: the phone sends a verdict or a choice
  // number for an addressable decision the same way.
  const handleDecisionRespond = useCallback(async (answer: string) => {
    if (isDisabled || !canRespondDecision) return;
    setIsSubmitting(true);
    try {
      await send(answer);
    } catch (error) {
      onError?.(error);
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, canRespondDecision, send, onError]);

  return {
    selectedOption,
    setSelectedOption,
    checkedNumbers,
    textInputValue,
    setTextInputValue,
    multiSelectOptions,
    selectedOptionData,
    takesTypedText,
    isBusy,
    isDisabled,
    handleToggleOption,
    handleYesNoClick,
    handleMultipleChoiceSubmit,
    handleMultiSelectSubmit,
    handleDecisionRespond,
  };
}
