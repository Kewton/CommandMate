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

import React, { useState, useEffect } from 'react';
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

  /** Resolve a DURATION_LABELS value (e.g. 'autoYes.durations.1h') to a translated string */
  const durationLabel = (duration: AutoYesDuration): string =>
    t(DURATION_LABELS[duration].replace('autoYes.', ''));

  // Reset stopPattern and regexError when dialog opens/closes (DS1-F008)
  useEffect(() => {
    if (isOpen) {
      setStopPattern('');
      setRegexError(null);
    }
  }, [isOpen]);

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
        <div className="text-sm text-gray-700">
          <p className="font-medium mb-2">{t('featureDescription')}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('yesNoAutoResponse')}</li>
            <li>{t('multipleChoiceAutoSelect')}</li>
          </ul>
          <p className="mt-1">{t('autoDisableAfter', { duration: durationLabel(selectedDuration) })}</p>
          {cliToolName && (
            <p className="mt-2 text-gray-500">
              {t('appliesOnlyToCurrent', { toolName: cliToolName })}
            </p>
          )}
        </div>

        {/* Duration selection - horizontal button group */}
        <div className="text-sm text-gray-700">
          <p className="font-medium mb-2">{t('duration')}</p>
          <div className="flex gap-2">
            {ALLOWED_DURATIONS.map((duration) => (
              <button
                key={duration}
                type="button"
                onClick={() => setSelectedDuration(duration)}
                className={`flex-1 py-2 px-3 text-sm font-medium rounded-md border-2 transition-colors ${
                  selectedDuration === duration
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                }`}
                style={{ minHeight: '44px' }}
              >
                {durationLabel(duration)}
              </button>
            ))}
          </div>
        </div>

        {/* Stop Pattern input (Issue #314) */}
        <div className="text-sm text-gray-700">
          <label htmlFor="stop-pattern-input" className="font-medium mb-1 block">
            {t('stopPatternLabel')}
          </label>
          <p className="text-xs text-gray-500 mb-2">{t('stopPatternDescription')}</p>
          <input
            id="stop-pattern-input"
            type="text"
            value={stopPattern}
            onChange={(e) => setStopPattern(e.target.value)}
            placeholder={t('stopPatternPlaceholder')}
            className={`w-full px-3 py-2 border rounded-md text-sm font-mono ${
              regexError
                ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
                : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500'
            } focus:outline-none focus:ring-1`}
            data-testid="stop-pattern-input"
          />
          {regexError && (
            <p className="mt-1 text-xs text-red-600" data-testid="stop-pattern-error">
              {regexError}
            </p>
          )}
        </div>

        <div className="text-sm text-gray-700">
          <p className="font-medium mb-2">{t('aboutRisks')}</p>
          <p>
            {t('riskWarning')}
          </p>
        </div>

        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-3">
          <p className="text-sm text-yellow-800">
            <span className="font-medium">{t('disclaimer')}</span>
            {t('disclaimerText')}
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700"
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
