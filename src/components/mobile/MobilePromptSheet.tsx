/**
 * MobilePromptSheet Component
 *
 * Mobile bottom sheet for prompt responses
 */

'use client';

import { useState, useCallback, useId, useMemo, useEffect, memo } from 'react';
import { useTranslations } from 'next-intl';
import type { PromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { RadioGroup, RadioGroupItem, Spinner } from '@/components/ui';
import { usePromptAnimation } from '@/hooks/usePromptAnimation';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';

/** Animation duration for sheet transitions */
const ANIMATION_DURATION_MS = 300;

/** Swipe threshold to dismiss in pixels */
const SWIPE_DISMISS_THRESHOLD = 100;

/** Button style constants */
const BUTTON_STYLES = {
  /** Common button base styles */
  base: 'px-6 py-3 rounded-lg font-medium transition-all touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2',
  /** Primary button styles */
  primary: 'bg-accent-600 text-white hover:bg-accent-700 focus:ring-ring',
  /** Secondary button styles */
  secondary: 'bg-muted border-2 border-input hover:bg-muted/80 text-foreground focus:ring-ring',
  /** Default selected button styles */
  defaultSelected: 'bg-muted-foreground text-background hover:bg-muted-foreground/90',
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
  /** CLI tool display name (e.g., 'Claude', 'Gemini') for header */
  cliToolName?: string;
}

/**
 * MobilePromptSheet - Bottom sheet for prompt responses
 *
 * Displays prompts in a mobile-friendly bottom sheet format.
 * Supports swipe to dismiss and overlay click to dismiss.
 */
export const MobilePromptSheet = memo(function MobilePromptSheet({
  promptData,
  visible,
  answering,
  onRespond,
  onDismiss,
  cliToolName,
}: MobilePromptSheetProps) {
  const { shouldRender, animationClass } = usePromptAnimation({
    visible: visible && promptData !== null,
    duration: ANIMATION_DURATION_MS,
  });
  const labelId = useId();

  const isActive = visible && promptData !== null;

  // [Issue #1127] Trap keyboard focus within the sheet while it is the active
  // modal surface (Tab cycling + focus restore); shares the single useFocusTrap
  // implementation with ui/Modal. The ref doubles as the sheet element ref.
  const sheetRef = useFocusTrap<HTMLDivElement>({
    active: isActive,
  });

  // Swipe-to-dismiss (Issue #1128): unified on the shared useSwipeGesture hook
  // (was an ad-hoc touch handler). Vertical axis + direction lock keeps a
  // horizontal drag from dismissing; onSwipeMove drives the finger-follow
  // translate, and a downward swipe past the threshold dismisses.
  const [translateY, setTranslateY] = useState(0);

  // Reset translate when visibility changes
  useEffect(() => {
    if (!visible) {
      setTranslateY(0);
    }
  }, [visible]);

  const handleSwipeMove = useCallback(({ deltaY }: { deltaX: number; deltaY: number }) => {
    // Only follow downward drags (positive delta).
    setTranslateY(deltaY > 0 ? deltaY : 0);
  }, []);

  const handleSwipeDismiss = useCallback(() => {
    onDismiss?.();
  }, [onDismiss]);

  const handleSwipeEnd = useCallback(() => {
    setTranslateY(0);
  }, []);

  const { ref: swipeRef } = useSwipeGesture({
    axis: 'vertical',
    threshold: SWIPE_DISMISS_THRESHOLD,
    enabled: isActive,
    onSwipeMove: handleSwipeMove,
    onSwipeDown: handleSwipeDismiss,
    onSwipeEnd: handleSwipeEnd,
  });

  // Merge the focus-trap container ref (#1127) with the swipe ref (#1128) onto
  // the single sheet element without disturbing either hook's contract.
  const setSheetRef = useCallback(
    (el: HTMLDivElement | null) => {
      (sheetRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      (swipeRef as React.MutableRefObject<HTMLElement | null>).current = el;
    },
    [sheetRef, swipeRef]
  );

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
        ref={setSheetRef}
        data-testid="mobile-prompt-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onClick={handleSheetClick}
        style={{ transform: sheetTransform }}
        className={`fixed bottom-0 inset-x-0 bg-surface rounded-t-2xl z-50 pb-safe transform transition-transform duration-300 ${sheetAnimation}`}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div
            data-testid="drag-handle"
            className="w-10 h-1 bg-input rounded-full"
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
            cliToolName={cliToolName}
          />
        </div>
      </div>
    </ErrorBoundary>
  );
});

/**
 * Props for PromptContent component
 */
interface PromptContentProps {
  promptData: PromptData;
  answering: boolean;
  onRespond: (answer: string) => Promise<void>;
  labelId: string;
  cliToolName?: string;
}

/**
 * Internal content component for MobilePromptSheet
 */
function PromptContent({
  promptData,
  answering,
  onRespond,
  labelId,
  cliToolName,
}: PromptContentProps) {
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
      <h3 id={labelId} className="text-lg font-semibold text-foreground">
        {cliToolName ? t('confirmationFrom', { toolName: cliToolName }) : t('confirmationFromClaude')}
      </h3>

      {/* Instruction Text (context preceding the prompt) */}
      {promptData.instructionText && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground bg-muted rounded p-2 border border-border">
          {promptData.instructionText}
        </div>
      )}

      {/* Question */}
      <p className="text-foreground leading-relaxed">{promptData.question}</p>

      {/* Answering indicator */}
      {isDisabled && (
        <div data-testid="answering-indicator" className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
          <Spinner size="sm" variant="accent" />
          <span>{t('sending')}</span>
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
  const t = useTranslations('prompt');
  const isYesDefault = promptData.defaultOption === 'yes';
  const isNoDefault = promptData.defaultOption === 'no';

  return (
    <div className="flex gap-3" role="group" aria-label={t('yesNoGroupLabel')}>
      <button
        type="button"
        onClick={onYes}
        disabled={disabled}
        className={`flex-1 ${BUTTON_STYLES.base} ${BUTTON_STYLES.primary} ${isYesDefault ? 'ring-2 ring-accent-300' : ''}`}
      >
        {t('yes')}
      </button>
      <button
        type="button"
        onClick={onNo}
        disabled={disabled}
        className={`flex-1 ${BUTTON_STYLES.base} ${isNoDefault ? BUTTON_STYLES.defaultSelected : BUTTON_STYLES.secondary}`}
      >
        {t('no')}
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
  const t = useTranslations('prompt');

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
          {promptData.options.map((option) => {
            const isSelected = selectedOption === option.number;
            return (
              <label
                key={option.number}
                className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-accent-50 dark:bg-accent-900/30 border-2 border-accent-500'
                    : 'bg-surface border-2 border-border hover:border-input'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <RadioGroupItem
                  value={String(option.number)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <span className="font-medium text-foreground">{option.number}. {option.label}</span>
                  {option.isDefault && (
                    <span className="ml-2 text-xs text-accent-600 bg-accent-100 px-2 py-0.5 rounded">
                      {t('default')}
                    </span>
                  )}
                </div>
              </label>
            );
          })}
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
            // Issue #1128: mobile keyboard hints for the custom-value field.
            inputMode="text"
            enterKeyHint="done"
            className="w-full px-4 py-3 border-2 border-input rounded-lg bg-surface text-foreground focus:outline-none focus:border-ring disabled:opacity-50"
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
        {t('submit')}
      </button>
    </div>
  );
});

export default MobilePromptSheet;
