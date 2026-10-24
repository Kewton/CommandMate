/**
 * AutoYesConfirmDialog - Confirmation dialog for enabling auto-yes mode
 *
 * Displays a warning message, risk explanation, disclaimer,
 * duration selection radio buttons, and stop pattern input before enabling auto-yes mode.
 *
 * Issue #225: Added duration selection (1h/3h/8h)
 * Issue #314: Added stop pattern (regex) input field
 * Issue #3863: Added the answer mode (おまかせ `recommended` / 慎重 `careful`)
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import {
  ALLOWED_DURATIONS,
  DEFAULT_AUTO_YES_DURATION,
  DURATION_LABELS,
  validateStopPattern,
  type AutoYesDuration,
} from '@/config/auto-yes-config';
import {
  AUTO_YES_ANSWER_MODES,
  DEFAULT_AUTO_YES_ANSWER_MODE,
  type AutoYesAnswerMode,
} from '@/types/auto-yes-answer-mode';

/** Props for AutoYesConfirmDialog component */
export interface AutoYesConfirmDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /**
   * Callback when user confirms enabling auto-yes with selected duration and optional stop pattern.
   *
   * Issue #3863: `answerMode` is passed only when the user picked a mode other
   * than the default (`recommended`); omitted means the default. The two-argument
   * call for the default is the shape the callers' tests pin.
   */
  onConfirm: (duration: AutoYesDuration, stopPattern?: string, answerMode?: AutoYesAnswerMode) => void;
  /** Callback when user cancels */
  onCancel: () => void;
  /** Name of the CLI tool Auto Yes will target */
  cliToolName?: string;
}

export function AutoYesConfirmDialog({
  isOpen,
  onConfirm,
  onCancel,
  cliToolName,
}: AutoYesConfirmDialogProps) {
  const t = useTranslations('autoYes');
  const tCommon = useTranslations('common');
  const [selectedDuration, setSelectedDuration] = useState<AutoYesDuration>(DEFAULT_AUTO_YES_DURATION);
  const [stopPattern, setStopPattern] = useState<string>('');
  const [selectedAnswerMode, setSelectedAnswerMode] = useState<AutoYesAnswerMode>(DEFAULT_AUTO_YES_ANSWER_MODE);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [showRegexTips, setShowRegexTips] = useState(false);
  const tipsRef = useRef<HTMLDivElement>(null);

  /** Resolve a DURATION_LABELS value (e.g. 'autoYes.durations.1h') to a translated string */
  const durationLabel = (duration: AutoYesDuration): string =>
    t(DURATION_LABELS[duration].replace('autoYes.', ''));

  // Reset stopPattern, regexError, and tips when dialog opens/closes (DS1-F008)
  // Issue #3863: the answer mode too — each enabling starts from the default.
  useEffect(() => {
    if (isOpen) {
      setStopPattern('');
      setSelectedAnswerMode(DEFAULT_AUTO_YES_ANSWER_MODE);
      setRegexError(null);
      setShowRegexTips(false);
    }
  }, [isOpen]);

  // Close tooltip on click outside
  useEffect(() => {
    if (!showRegexTips) return;
    const handleClick = (e: MouseEvent) => {
      if (tipsRef.current && !tipsRef.current.contains(e.target as Node)) {
        setShowRegexTips(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showRegexTips]);

  // Real-time validation of stop pattern
  useEffect(() => {
    if (!stopPattern.trim()) {
      setRegexError(null);
      return;
    }
    const validation = validateStopPattern(stopPattern.trim());
    if (!validation.valid) {
      setRegexError(validation.error ?? t('invalidRegexPattern'));
    } else {
      setRegexError(null);
    }
  }, [stopPattern, t]);

  const handleConfirm = () => {
    const trimmed = stopPattern.trim();
    if (selectedAnswerMode === DEFAULT_AUTO_YES_ANSWER_MODE) {
      onConfirm(selectedDuration, trimmed || undefined);
    } else {
      onConfirm(selectedDuration, trimmed || undefined, selectedAnswerMode);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={cliToolName ? t('enableTitleWithTool', { toolName: cliToolName }) : t('enableTitle')}
      size="sm"
      showCloseButton={true}
    >
      <div className="space-y-4">
        <div className="text-sm text-foreground">
          <p className="font-medium mb-2">{t('featureDescription')}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('yesNoAutoResponse')}</li>
            <li>{t('multipleChoiceAutoSelect')}</li>
          </ul>
          <p className="mt-1">{t('autoDisableAfter', { duration: durationLabel(selectedDuration) })}</p>
          {cliToolName && (
            <p className="mt-2 text-muted-foreground">
              {t('appliesOnlyToCurrent', { toolName: cliToolName })}
            </p>
          )}
        </div>

        {/* Duration selection - horizontal button group */}
        <div className="text-sm text-foreground">
          <p className="font-medium mb-2">{t('duration')}</p>
          <div className="flex gap-2">
            {ALLOWED_DURATIONS.map((duration) => (
              <button
                key={duration}
                type="button"
                onClick={() => setSelectedDuration(duration)}
                className={`flex-1 py-2 px-3 text-sm font-medium rounded-md border-2 transition-colors ${
                  selectedDuration === duration
                    ? 'border-accent-600 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400'
                    : 'border-border bg-surface dark:bg-surface-2 text-foreground hover:border-muted-foreground'
                }`}
                style={{ minHeight: '44px' }}
              >
                {durationLabel(duration)}
              </button>
            ))}
          </div>
        </div>

        {/* Answer mode (Issue #3863): how a question is answered; permissions are answered under either */}
        <div className="text-sm text-foreground">
          <p className="font-medium mb-2" id="auto-yes-answer-mode-label">{t('answerModeLabel')}</p>
          <div
            className="flex flex-col gap-2"
            role="radiogroup"
            aria-labelledby="auto-yes-answer-mode-label"
            data-testid="auto-yes-answer-mode-options"
          >
            {AUTO_YES_ANSWER_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selectedAnswerMode === mode}
                onClick={() => setSelectedAnswerMode(mode)}
                className={`w-full py-2 px-3 text-left rounded-md border-2 transition-colors ${
                  selectedAnswerMode === mode
                    ? 'border-accent-600 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400'
                    : 'border-border bg-surface dark:bg-surface-2 text-foreground hover:border-muted-foreground'
                }`}
                style={{ minHeight: '44px' }}
                data-testid={`auto-yes-answer-mode-${mode}`}
              >
                <span className="block text-sm font-medium">{t(`answerModes.${mode}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`answerModeDescriptions.${mode}`)}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground" data-testid="auto-yes-answer-mode-permission-note">
            {t('answerModePermissionNote')}
          </p>
        </div>

        {/* Stop Pattern input (Issue #314) */}
        <div className="text-sm text-foreground">
          <div className="flex items-center gap-1.5 mb-1">
            <label htmlFor="stop-pattern-input" className="font-medium">
              {t('stopPatternLabel')}
            </label>
            <div className="relative" ref={tipsRef}>
              <button
                type="button"
                onClick={() => setShowRegexTips(!showRegexTips)}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] font-bold hover:bg-muted/80 focus:outline-none"
                aria-label={t('regexTipsLabel')}
                data-testid="regex-tips-button"
              >
                ?
              </button>
              {showRegexTips && (
                <div
                  className="absolute left-0 top-6 z-50 w-72 rounded-md border border-border bg-surface p-3 shadow-lg text-xs text-foreground"
                  data-testid="regex-tips-tooltip"
                >
                  <p className="font-medium mb-1.5">{t('regexTipsTitle')}</p>
                  <ul className="space-y-1">
                    <li><code className="bg-muted px-1 rounded">\bcat\b</code> {t('regexTipWordBoundary')}</li>
                    <li><code className="bg-muted px-1 rounded">error|fatal</code> {t('regexTipOr')}</li>
                    <li><code className="bg-muted px-1 rounded">(?i)error</code> {t('regexTipCaseNote')}</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-2">{t('stopPatternDescription')}</p>
          <input
            id="stop-pattern-input"
            type="text"
            value={stopPattern}
            onChange={(e) => setStopPattern(e.target.value)}
            placeholder={t('stopPatternPlaceholder')}
            className={`w-full px-3 py-2 border rounded-md text-sm font-mono bg-surface dark:bg-surface-2 text-foreground ${
              regexError
                ? 'border-danger focus:ring-danger focus:border-danger'
                : 'border-input focus:ring-ring focus:border-accent-500'
            } focus:outline-none focus:ring-1`}
            data-testid="stop-pattern-input"
          />
          {regexError && (
            <p className="mt-1 text-xs text-danger" data-testid="stop-pattern-error">
              {regexError}
            </p>
          )}
        </div>

        <div className="text-sm text-foreground">
          <p className="font-medium mb-2">{t('aboutRisks')}</p>
          <p>
            {t('riskWarning')}
          </p>
        </div>

        <div className="bg-warning-subtle border-l-4 border-warning p-3">
          <p className="text-sm text-warning-foreground">
            <span className="font-medium">{t('disclaimer')}</span>
            {t('disclaimerText')}
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-md bg-muted hover:bg-muted/80 text-foreground"
          >
            {tCommon('cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!!regexError}
            className={`px-4 py-2 text-sm font-medium rounded-md text-white ${
              regexError
                ? 'bg-muted-foreground cursor-not-allowed'
                : 'bg-warning hover:bg-warning/90'
            }`}
            data-testid="confirm-button"
          >
            {t('agreeAndEnable')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
