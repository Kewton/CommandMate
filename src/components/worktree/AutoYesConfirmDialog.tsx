/**
 * AutoYesConfirmDialog - Confirmation dialog for enabling auto-yes mode
 *
 * Displays a warning message, risk explanation, disclaimer,
 * duration selection radio buttons, and stop pattern input before enabling auto-yes mode.
 *
 * Issue #225: Added duration selection (1h/3h/8h)
 * Issue #314: Added stop pattern (regex) input field
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

/** Props for AutoYesConfirmDialog component */
export interface AutoYesConfirmDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when user confirms enabling auto-yes with selected duration and optional stop pattern */
  onConfirm: (duration: AutoYesDuration, stopPattern?: string) => void;
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
  const [regexError, setRegexError] = useState<string | null>(null);
  const [showRegexTips, setShowRegexTips] = useState(false);
  const tipsRef = useRef<HTMLDivElement>(null);

  /** Resolve a DURATION_LABELS value (e.g. 'autoYes.durations.1h') to a translated string */
  const durationLabel = (duration: AutoYesDuration): string =>
    t(DURATION_LABELS[duration].replace('autoYes.', ''));

  // Reset stopPattern, regexError, and tips when dialog opens/closes (DS1-F008)
  useEffect(() => {
    if (isOpen) {
      setStopPattern('');
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
    onConfirm(selectedDuration, trimmed || undefined);
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
        <div className="text-sm text-gray-700 dark:text-gray-200">
          <p className="font-medium mb-2">{t('featureDescription')}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('yesNoAutoResponse')}</li>
            <li>{t('multipleChoiceAutoSelect')}</li>
          </ul>
          <p className="mt-1">{t('autoDisableAfter', { duration: durationLabel(selectedDuration) })}</p>
          {cliToolName && (
            <p className="mt-2 text-gray-500 dark:text-gray-300">
              {t('appliesOnlyToCurrent', { toolName: cliToolName })}
            </p>
          )}
        </div>

        {/* Duration selection - horizontal button group */}
        <div className="text-sm text-gray-700 dark:text-gray-200">
          <p className="font-medium mb-2">{t('duration')}</p>
          <div className="flex gap-2">
            {ALLOWED_DURATIONS.map((duration) => (
              <button
                key={duration}
                type="button"
                onClick={() => setSelectedDuration(duration)}
                className={`flex-1 py-2 px-3 text-sm font-medium rounded-md border-2 transition-colors ${
                  selectedDuration === duration
                    ? 'border-cyan-600 bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400'
                    : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500'
                }`}
                style={{ minHeight: '44px' }}
              >
                {durationLabel(duration)}
              </button>
            ))}
          </div>
        </div>

        {/* Stop Pattern input (Issue #314) */}
        <div className="text-sm text-gray-700 dark:text-gray-200">
          <div className="flex items-center gap-1.5 mb-1">
            <label htmlFor="stop-pattern-input" className="font-medium">
              {t('stopPatternLabel')}
            </label>
            <div className="relative" ref={tipsRef}>
              <button
                type="button"
                onClick={() => setShowRegexTips(!showRegexTips)}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-200 text-[10px] font-bold hover:bg-gray-400 dark:hover:bg-gray-500 focus:outline-none"
                aria-label={t('regexTipsLabel')}
                data-testid="regex-tips-button"
              >
                ?
              </button>
              {showRegexTips && (
                <div
                  className="absolute left-0 top-6 z-50 w-72 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-3 shadow-lg text-xs text-gray-700 dark:text-gray-200"
                  data-testid="regex-tips-tooltip"
                >
                  <p className="font-medium mb-1.5">{t('regexTipsTitle')}</p>
                  <ul className="space-y-1">
                    <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">\bcat\b</code> {t('regexTipWordBoundary')}</li>
                    <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">error|fatal</code> {t('regexTipOr')}</li>
                    <li><code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">(?i)error</code> {t('regexTipCaseNote')}</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-300 mb-2">{t('stopPatternDescription')}</p>
          <input
            id="stop-pattern-input"
            type="text"
            value={stopPattern}
            onChange={(e) => setStopPattern(e.target.value)}
            placeholder={t('stopPatternPlaceholder')}
            className={`w-full px-3 py-2 border rounded-md text-sm font-mono dark:bg-gray-800 dark:text-gray-100 ${
              regexError
                ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
                : 'border-gray-300 dark:border-gray-600 focus:ring-cyan-500 focus:border-cyan-500'
            } focus:outline-none focus:ring-1`}
            data-testid="stop-pattern-input"
          />
          {regexError && (
            <p className="mt-1 text-xs text-red-600" data-testid="stop-pattern-error">
              {regexError}
            </p>
          )}
        </div>

        <div className="text-sm text-gray-700 dark:text-gray-200">
          <p className="font-medium mb-2">{t('aboutRisks')}</p>
          <p>
            {t('riskWarning')}
          </p>
        </div>

        <div className="bg-yellow-50 dark:bg-yellow-900/30 border-l-4 border-yellow-400 dark:border-yellow-600 p-3">
          <p className="text-sm text-yellow-800 dark:text-yellow-300">
            <span className="font-medium">{t('disclaimer')}</span>
            {t('disclaimerText')}
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200"
          >
            {tCommon('cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!!regexError}
            className={`px-4 py-2 text-sm font-medium rounded-md text-white ${
              regexError
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-yellow-600 hover:bg-yellow-700'
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
