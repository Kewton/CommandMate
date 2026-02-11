/**
 * AutoYesConfirmDialog - Confirmation dialog for enabling auto-yes mode
 *
 * Displays a warning message, risk explanation, disclaimer,
 * and duration selection radio buttons before enabling auto-yes mode.
 *
 * Issue #225: Added duration selection (1h/3h/8h)
 */

'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import {
  ALLOWED_DURATIONS,
  DEFAULT_AUTO_YES_DURATION,
  DURATION_LABELS,
  type AutoYesDuration,
} from '@/config/auto-yes-config';

/** Props for AutoYesConfirmDialog component */
export interface AutoYesConfirmDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when user confirms enabling auto-yes with selected duration */
  onConfirm: (duration: AutoYesDuration) => void;
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

  /** Resolve a DURATION_LABELS value (e.g. 'autoYes.durations.1h') to a translated string */
  const durationLabel = (duration: AutoYesDuration): string =>
    t(DURATION_LABELS[duration].replace('autoYes.', ''));

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
            onClick={() => onConfirm(selectedDuration)}
            className="px-4 py-2 text-sm font-medium rounded-md bg-yellow-600 hover:bg-yellow-700 text-white"
          >
            {t('agreeAndEnable')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default AutoYesConfirmDialog;
