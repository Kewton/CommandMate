/**
 * MobilePromptSheet Component
 *
 * Mobile bottom sheet for prompt responses
 */

'use client';

import { useState, useCallback, useId, useMemo, useRef, useEffect, memo } from 'react';
import type { PromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { usePromptAnimation } from '@/hooks/usePromptAnimation';

/** Animation duration for sheet transitions */
const ANIMATION_DURATION_MS = 300;

/** Swipe threshold to dismiss in pixels */
const SWIPE_DISMISS_THRESHOLD = 100;

/** Button style constants */
const BUTTON_STYLES = {
  /** Common button base styles */
  base: 'px-6 py-3 rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2',
  /** Primary button styles */
  primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
  /** Secondary button styles */
  secondary: 'bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-800 focus:ring-gray-500',
  /** Default selected button styles */
  defaultSelected: 'bg-gray-600 text-white hover:bg-gray-700',
} as const;

/**
 * Props for MobilePromptSheet component
 */
export interface MobilePromptSheetProps {
  /** Prompt data (question, options, etc.) */
  promptData: PromptData | null;
  /** Whether the sheet is visible */
  visible: boolean;
  /** Whether user is currently answering */
  answering: boolean;
  /** Callback when user submits a response */
  onRespond: (answer: string) => Promise<void>;
  /** Optional callback to dismiss the sheet */
  onDismiss?: () => void;
}

/**
 * MobilePromptSheet - Bottom sheet for prompt responses
 *
 * Displays prompts in a mobile-friendly bottom sheet format.
 * Supports swipe to dismiss and overlay click to dismiss.
 */
export function MobilePromptSheet({
  promptData,
  visible,
  answering,
  onRespond,
  onDismiss,
}: MobilePromptSheetProps) {
  const { shouldRender, animationClass } = usePromptAnimation({
    visible: visible && promptData !== null,
    duration: ANIMATION_DURATION_MS,
  });
  const labelId = useId();

  // Swipe handling state
  const [touchStartY, setTouchStartY] = useState<number | null>(null);
  const [translateY, setTranslateY] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Reset translate when visibility changes
  useEffect(() => {
    if (!visible) {
      setTranslateY(0);
    }
  }, [visible]);

  /**
   * Handle touch start
   */
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    setTouchStartY(e.touches[0].clientY);
  }, []);

  /**
   * Handle touch move
   */
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY === null) return;

    const currentY = e.touches[0].clientY;
    const deltaY = currentY - touchStartY;

    // Only allow swiping down (positive delta)
    if (deltaY > 0) {
      setTranslateY(deltaY);
    }
  }, [touchStartY]);

  /**
   * Handle touch end
   */
  const handleTouchEnd = useCallback(() => {
    if (translateY > SWIPE_DISMISS_THRESHOLD && onDismiss) {
      onDismiss();
    }
    setTranslateY(0);
    setTouchStartY(null);
  }, [translateY, onDismiss]);

  /**
   * Handle overlay click
   */
  const handleOverlayClick = useCallback(() => {
    if (onDismiss) {
      onDismiss();
    }
  }, [onDismiss]);

  /**
   * Handle sheet click (prevent propagation)
   */
  const handleSheetClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Don't render if not visible or no prompt data
  if (!shouldRender || !promptData) {
    return null;
  }

  // Compute animation styles
  // Sheet should be visible when NOT animating out (i.e., during fade-in OR when fully visible)
  const isAnimatingOut = animationClass === 'animate-fade-out';
  const sheetTransform = translateY > 0 ? `translateY(${translateY}px)` : undefined;
  const overlayOpacity = isAnimatingOut ? 'opacity-0' : 'opacity-100';
  const overlayPointerEvents = isAnimatingOut ? 'pointer-events-none' : '';
  const sheetAnimation = isAnimatingOut ? 'translate-y-full' : 'translate-y-0';

  return (
    <ErrorBoundary componentName="MobilePromptSheet">
      {/* Overlay */}
      <div
        data-testid="prompt-overlay"
        onClick={handleOverlayClick}
        className={`fixed inset-0 bg-black/50 z-50 transition-opacity duration-300 ${overlayOpacity} ${overlayPointerEvents}`}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        data-testid="mobile-prompt-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onClick={handleSheetClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ transform: sheetTransform }}
        className={`fixed bottom-0 inset-x-0 bg-white rounded-t-2xl z-50 pb-safe transform transition-transform duration-300 ${sheetAnimation}`}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div
            data-testid="drag-handle"
            className="w-10 h-1 bg-gray-300 rounded-full"
            aria-hidden="true"
          />
        </div>

        {/* Content */}
        <div className="px-4 pb-6">
          <PromptContent
            promptData={promptData}
            answering={answering}
            onRespond={onRespond}
            labelId={labelId}
          />
        </div>
      </div>
    </ErrorBoundary>
  );
}

/**
 * Props for PromptContent component
 */
interface PromptContentProps {
  promptData: PromptData;
  answering: boolean;
  onRespond: (answer: string) => Promise<void>;
  labelId: string;
}

/**
 * Internal content component for MobilePromptSheet
 */
function PromptContent({
  promptData,
  answering,
  onRespond,
  labelId,
}: PromptContentProps) {
  const [selectedOption, setSelectedOption] = useState<number | null>(() => {
    if (promptData.type === 'multiple_choice') {
      const defaultOpt = promptData.options.find(opt => opt.isDefault);
      return defaultOpt?.number ?? null;
    }
    return null;
  });
  const [textInputValue, setTextInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Memoize selected option data
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
    } catch {
      // Error handling silently
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, onRespond]);

  // Handle multiple choice submit
  const handleMultipleChoiceSubmit = useCallback(async () => {
    if (isDisabled || selectedOption === null) return;
    setIsSubmitting(true);
    try {
      const answer = requiresTextInput && textInputValue.trim()
        ? textInputValue.trim()
        : selectedOption.toString();
      await onRespond(answer);
    } catch {
      // Error handling silently
    } finally {
      setIsSubmitting(false);
    }
  }, [isDisabled, onRespond, selectedOption, requiresTextInput, textInputValue]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <h3 id={labelId} className="text-lg font-semibold text-gray-900">
        Claudeからの確認
      </h3>

      {/* Question */}
      <p className="text-gray-700 leading-relaxed">{promptData.question}</p>

      {/* Answering indicator */}
      {isDisabled && (
        <div data-testid="answering-indicator" className="flex items-center gap-2 text-sm text-gray-500" role="status" aria-live="polite">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" aria-hidden="true" />
          <span>送信中...</span>
        </div>
      )}

      {/* Yes/No Prompt */}
      {promptData.type === 'yes_no' && (
        <YesNoActions
          promptData={promptData}
          disabled={isDisabled}
          onYes={() => handleYesNoClick('yes')}
          onNo={() => handleYesNoClick('no')}
        />
      )}

      {/* Multiple Choice Prompt */}
      {promptData.type === 'multiple_choice' && (
        <MultipleChoiceActions
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

/**
 * Props for YesNoActions component
 */
interface YesNoActionsProps {
  promptData: YesNoPromptData;
  disabled: boolean;
  onYes: () => void;
  onNo: () => void;
}

/**
 * Yes/No action buttons
 */
const YesNoActions = memo(function YesNoActions({
  promptData,
  disabled,
  onYes,
  onNo,
}: YesNoActionsProps) {
  const isYesDefault = promptData.defaultOption === 'yes';
  const isNoDefault = promptData.defaultOption === 'no';

  return (
    <div className="flex gap-3" role="group" aria-label="Yes or No options">
      <button
        type="button"
        onClick={onYes}
        disabled={disabled}
        className={`flex-1 ${BUTTON_STYLES.base} ${BUTTON_STYLES.primary} ${isYesDefault ? 'ring-2 ring-blue-300' : ''}`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={onNo}
        disabled={disabled}
        className={`flex-1 ${BUTTON_STYLES.base} ${isNoDefault ? BUTTON_STYLES.defaultSelected : BUTTON_STYLES.secondary}`}
      >
        No
      </button>
    </div>
  );
});

/**
 * Props for MultipleChoiceActions component
 */
interface MultipleChoiceActionsProps {
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
 * Multiple choice action options
 */
const MultipleChoiceActions = memo(function MultipleChoiceActions({
  promptData,
  disabled,
  selectedOption,
  onSelectOption,
  textInputValue,
  onTextInputChange,
  showTextInput,
  onSubmit,
}: MultipleChoiceActionsProps) {
  const groupName = useId();

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">Select an option</legend>
        <div className="space-y-2">
          {promptData.options.map((option) => {
            const isSelected = selectedOption === option.number;
            return (
              <label
                key={option.number}
                className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-blue-50 border-2 border-blue-500'
                    : 'bg-white border-2 border-gray-200 hover:border-gray-300'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.number}
                  checked={isSelected}
                  onChange={() => onSelectOption(option.number)}
                  disabled={disabled}
                  className="mt-1"
                />
                <div className="flex-1">
                  <span className="font-medium">{option.number}. {option.label}</span>
                  {option.isDefault && (
                    <span className="ml-2 text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded">
                      デフォルト
                    </span>
                  )}
                </div>
              </label>
            );
          })}
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
            placeholder="値を入力してください..."
            className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
        </div>
      )}

      {/* Submit button */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled || selectedOption === null}
        className={`w-full ${BUTTON_STYLES.base} ${BUTTON_STYLES.primary}`}
      >
        Submit
      </button>
    </div>
  );
});

export default MobilePromptSheet;
