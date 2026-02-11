/**
 * PromptPanel Component
 *
 * A dedicated panel for displaying and responding to Claude prompts.
 * Supports yes/no prompts, multiple choice prompts, and text input.
 * Features fade-in/fade-out animations.
 */

'use client';

import { useState, useCallback, useId, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { PromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { usePromptAnimation } from '@/hooks/usePromptAnimation';

/** Animation duration for prompt panel transitions */
const ANIMATION_DURATION_MS = 200;

/** Common button base styles */
const BUTTON_BASE_STYLES = `
  px-6 py-2 rounded-lg font-medium transition-all
  disabled:opacity-50 disabled:cursor-not-allowed
  focus:outline-none focus:ring-2 focus:ring-offset-2
`.trim();

/** Primary button styles */
const BUTTON_PRIMARY_STYLES = 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500';

/** Secondary button styles */
const BUTTON_SECONDARY_STYLES = 'bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-800 focus:ring-gray-500';

/**
 * Props for PromptPanel component
 */
export interface PromptPanelProps {
  /** Prompt data (question, options, etc.) */
  promptData: PromptData | null;
  /** Associated message ID */
  messageId: string | null;
  /** Whether the panel is visible */
  visible: boolean;
  /** Whether user is currently answering (submitting response) */
  answering: boolean;
  /** Callback when user submits a response */
  onRespond: (answer: string) => Promise<void>;
  /** Optional callback to dismiss the panel */
  onDismiss?: () => void;
}

/** Props for PromptPanelContent component */
interface PromptPanelContentProps {
  promptData: PromptData;
  answering: boolean;
  onRespond: (answer: string) => Promise<void>;
  onDismiss?: () => void;
  labelId: string;
}

/**
 * Internal content component for PromptPanel
 */
function PromptPanelContent({
  promptData,
  answering,
  onRespond,
  onDismiss,
  labelId,
}: PromptPanelContentProps) {
  const t = useTranslations('prompt');
  const [selectedOption, setSelectedOption] = useState<number | null>(() => {
    if (promptData.type === 'multiple_choice') {
      const defaultOpt = promptData.options.find(opt => opt.isDefault);
      return defaultOpt?.number ?? null;
    }
    return null;
  });
  const [textInputValue, setTextInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Memoize selected option data to avoid recalculation on every render
  const selectedOptionData = useMemo(() => {
    if (promptData.type !== 'multiple_choice') return null;
    return promptData.options.find(opt => opt.number === selectedOption) ?? null;
  }, [promptData, selectedOption]);

  const requiresTextInput = selectedOptionData?.requiresTextInput === true;
  const isDisabled = answering || isSubmitting;

  // Handle yes/no button click
  const handleYesNoClick = useCallback(async (answer: 'yes' | 'no') => {
    if (isDisabled) return;
    setIsSubmitting(true);
    try {
      await onRespond(answer);
    } catch (error) {
      // Log error for debugging purposes
      if (process.env.NODE_ENV !== 'production') {
        console.error('[PromptPanel] Failed to respond:', error);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, onRespond]);

  // Handle multiple choice submit
  const handleMultipleChoiceSubmit = useCallback(async () => {
    if (isDisabled || selectedOption === null) return;
    setIsSubmitting(true);
    try {
      // If text input is required and has value, send the text value
      const answer = requiresTextInput && textInputValue.trim()
        ? textInputValue.trim()
        : selectedOption.toString();
      await onRespond(answer);
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[PromptPanel] Failed to respond:', error);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, onRespond, selectedOption, requiresTextInput, textInputValue]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 id={labelId} className="text-lg font-semibold text-yellow-800 flex items-center gap-2">
          <span className="text-xl" aria-hidden="true">?</span>
          {t('confirmationFromClaude')}
        </h3>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="close"
            className="p-1 rounded hover:bg-yellow-200 transition-colors"
          >
            <svg className="w-5 h-5 text-yellow-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Instruction Text (context preceding the prompt) */}
      {promptData.instructionText && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-gray-600 bg-gray-50 rounded p-2 border border-gray-200">
          {promptData.instructionText}
        </div>
      )}

      {/* Question */}
      <p className="text-gray-800 leading-relaxed">{promptData.question}</p>

      {/* Answering indicator */}
      {isDisabled && (
        <div data-testid="answering-indicator" className="flex items-center gap-2 text-sm text-gray-500" role="status" aria-live="polite">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" aria-hidden="true" />
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

      {/* Multiple Choice Prompt */}
      {promptData.type === 'multiple_choice' && (
        <MultipleChoicePromptActions
          promptData={promptData}
          disabled={isDisabled}
          selectedOption={selectedOption}
          onSelectOption={setSelectedOption}
          textInputValue={textInputValue}
          onTextInputChange={setTextInputValue}
          showTextInput={requiresTextInput}
          onSubmit={handleMultipleChoiceSubmit}
        />
      )}
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
  const isYesDefault = promptData.defaultOption === 'yes';
  const isNoDefault = promptData.defaultOption === 'no';

  const yesButtonClasses = `${BUTTON_BASE_STYLES} ${BUTTON_PRIMARY_STYLES} ${isYesDefault ? 'primary default highlighted' : ''}`;
  const noButtonClasses = `${BUTTON_BASE_STYLES} ${isNoDefault ? 'bg-gray-600 text-white hover:bg-gray-700 primary default highlighted' : BUTTON_SECONDARY_STYLES}`;

  return (
    <div className="flex items-center gap-3" role="group" aria-label="Yes or No options">
      <button
        type="button"
        onClick={onYes}
        disabled={disabled}
        className={yesButtonClasses}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={onNo}
        disabled={disabled}
        className={noButtonClasses}
      >
        No
      </button>
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
      ? 'bg-blue-50 border-2 border-blue-500'
      : 'bg-white border-2 border-gray-200 hover:border-gray-300';
    const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';
    return `${baseClasses} ${selectionClasses} ${disabledClasses}`;
  }, [selectedOption, disabled]);

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">Select an option</legend>
        <div className="space-y-2">
          {promptData.options.map((option) => (
            <label
              key={option.number}
              className={getOptionClasses(option.number)}
            >
              <input
                type="radio"
                name={groupName}
                value={option.number}
                checked={selectedOption === option.number}
                onChange={() => onSelectOption(option.number)}
                disabled={disabled}
                className="mt-1"
                aria-describedby={option.isDefault ? `default-${option.number}` : undefined}
              />
              <div className="flex-1">
                <span className="font-medium">{option.number}. {option.label}</span>
                {option.isDefault && (
                  <span id={`default-${option.number}`} className="ml-2 text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded">
                    {t('default')}
                  </span>
                )}
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Text input for options that require it */}
      {showTextInput && (
        <div className="mt-3">
          <label htmlFor={`text-input-${groupName}`} className="sr-only">Custom value input</label>
          <input
            id={`text-input-${groupName}`}
            type="text"
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            disabled={disabled}
            placeholder={t('enterValuePlaceholder')}
            className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
        </div>
      )}

      {/* Submit button */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled || selectedOption === null}
        className={`w-full ${BUTTON_BASE_STYLES} ${BUTTON_PRIMARY_STYLES}`}
      >
        Submit
      </button>
    </div>
  );
}

/**
 * Generates container class names based on animation state
 */
function getContainerClasses(animationClass: string): string {
  const baseClasses = 'bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4 shadow-lg transition-all duration-200 ease-in-out';

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
export function PromptPanel({
  promptData,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved for future use (tracking, analytics)
  messageId,
  visible,
  answering,
  onRespond,
  onDismiss,
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
          onDismiss={onDismiss}
          labelId={labelId}
        />
      </div>
    </ErrorBoundary>
  );
}

export default PromptPanel;
