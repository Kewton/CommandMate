/**
 * ScheduleEditDialog Component
 * Issue #824: Schedules UX Phase 1
 *
 * Desktop/Mobile shared modal for creating and editing a schedule. On save it
 * writes to CMATE.md via /api/worktrees/:id/cmate/schedules (Option C, write-only
 * sync) — it never calls the schedule DB API directly.
 *
 * Dynamic behavior:
 * - The Permission dropdown options change when the CLI Tool changes.
 * - The Model field is shown only for CLI tools that support `--model` (copilot).
 */

'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { CLI_TOOL_IDS, getCliToolDisplayName } from '@/lib/cli-tools/types';
import {
  getPermissionOptionsForTool,
  DEFAULT_PERMISSIONS,
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_SCHEDULE_MESSAGE_LENGTH,
} from '@/config/schedule-config';
import { NAME_PATTERN, isValidCronExpression } from '@/config/cmate-constants';
import { validateCopilotModelName } from '@/lib/cmate-cli-tool-parser';

// ============================================================================
// Types
// ============================================================================

export interface ScheduleFormValues {
  name: string;
  cronExpression: string;
  message: string;
  cliToolId: string;
  enabled: boolean;
  permission: string;
  model: string;
}

export interface ScheduleEditDialogProps {
  isOpen: boolean;
  worktreeId: string;
  /** Existing values when editing; undefined for create mode */
  initialValues?: Partial<ScheduleFormValues>;
  /** Original name for locating the CMATE.md row on rename (edit mode) */
  originalName?: string;
  onClose: () => void;
  onSaved: () => void;
}

// ============================================================================
// Constants / Helpers
// ============================================================================

/** Cron presets offered in the dropdown (Issue #824). */
const CRON_PRESETS: { value: string; labelKey: string }[] = [
  { value: '0 */1 * * *', labelKey: 'cronPresetHourly' },
  { value: '0 9 * * *', labelKey: 'cronPresetDaily9' },
  { value: '0 9 * * 1', labelKey: 'cronPresetWeeklyMon9' },
];

const DEFAULT_FORM: ScheduleFormValues = {
  name: '',
  cronExpression: '0 9 * * *',
  message: '',
  cliToolId: 'claude',
  enabled: true,
  permission: DEFAULT_PERMISSIONS.claude ?? '',
  model: '',
};

/** Default permission for a CLI tool (falls back to the first allowed option). */
function permissionDefaultFor(cliToolId: string): string {
  const fromMap = DEFAULT_PERMISSIONS[cliToolId];
  if (fromMap !== undefined) return fromMap;
  const options = getPermissionOptionsForTool(cliToolId);
  return options.length > 0 ? options[0] : '';
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500';
const LABEL_CLASS = 'block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1';
const ERROR_CLASS = 'mt-1 text-xs text-red-600 dark:text-red-400';

// ============================================================================
// Component
// ============================================================================

export function ScheduleEditDialog({
  isOpen,
  worktreeId,
  initialValues,
  originalName,
  onClose,
  onSaved,
}: ScheduleEditDialogProps) {
  const t = useTranslations('schedule');
  const [form, setForm] = useState<ScheduleFormValues>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Seed (or reset) the form whenever the dialog is opened.
  useEffect(() => {
    if (!isOpen) return;
    setSubmitError(null);
    setSubmitting(false);
    setForm({
      name: initialValues?.name ?? DEFAULT_FORM.name,
      cronExpression: initialValues?.cronExpression ?? DEFAULT_FORM.cronExpression,
      message: initialValues?.message ?? DEFAULT_FORM.message,
      cliToolId: initialValues?.cliToolId ?? DEFAULT_FORM.cliToolId,
      enabled: initialValues?.enabled ?? DEFAULT_FORM.enabled,
      permission: initialValues?.permission ?? DEFAULT_FORM.permission,
      model: initialValues?.model ?? DEFAULT_FORM.model,
    });
  }, [isOpen, initialValues]);

  const permissionOptions = getPermissionOptionsForTool(form.cliToolId);
  const showPermission = permissionOptions.length > 0;
  const showModel = form.cliToolId === 'copilot';
  const isEdit = Boolean(originalName);

  // ----- Validation -----
  const nameError = useMemo(() => {
    const value = form.name.trim();
    if (!value) return t('edit.errorNameRequired');
    if (value.length > MAX_SCHEDULE_NAME_LENGTH) {
      return t('edit.errorNameTooLong', { max: MAX_SCHEDULE_NAME_LENGTH });
    }
    if (!NAME_PATTERN.test(value)) return t('edit.errorNameInvalid');
    return null;
  }, [form.name, t]);

  const cronError = useMemo(() => {
    if (!isValidCronExpression(form.cronExpression.trim())) return t('edit.errorCronInvalid');
    return null;
  }, [form.cronExpression, t]);

  const messageError = useMemo(() => {
    if (!form.message.trim()) return t('edit.errorMessageRequired');
    if (form.message.length > MAX_SCHEDULE_MESSAGE_LENGTH) {
      return t('edit.errorMessageTooLong', { max: MAX_SCHEDULE_MESSAGE_LENGTH });
    }
    return null;
  }, [form.message, t]);

  const modelError = useMemo(() => {
    if (!showModel || !form.model.trim()) return null;
    return validateCopilotModelName(form.model.trim()).valid ? null : t('edit.errorModelInvalid');
  }, [showModel, form.model, t]);

  const isValid = !nameError && !cronError && !messageError && !modelError;

  // ----- Handlers -----
  const handleToolChange = useCallback((next: string) => {
    setForm((prev) => ({
      ...prev,
      cliToolId: next,
      permission: permissionDefaultFor(next),
      model: next === 'copilot' ? prev.model : '',
    }));
  }, []);

  const cronPresetValue = CRON_PRESETS.some((p) => p.value === form.cronExpression)
    ? form.cronExpression
    : 'custom';

  const handleCronPresetChange = useCallback((value: string) => {
    if (value === 'custom') return;
    setForm((prev) => ({ ...prev, cronExpression: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/cmate/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          cronExpression: form.cronExpression.trim(),
          message: form.message.trim(),
          cliToolId: form.cliToolId,
          enabled: form.enabled,
          permission: showPermission ? form.permission : '',
          model: showModel && form.model.trim() ? form.model.trim() : undefined,
          originalName: originalName ?? undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setSubmitError(data.error || t('edit.saveError'));
        return;
      }
      onSaved();
      onClose();
    } catch {
      setSubmitError(t('edit.saveError'));
    } finally {
      setSubmitting(false);
    }
  }, [
    isValid,
    submitting,
    worktreeId,
    form,
    showPermission,
    showModel,
    originalName,
    onSaved,
    onClose,
    t,
  ]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? t('edit.titleEdit') : t('edit.titleCreate')}
      size="md"
    >
      <div className="flex flex-col gap-4">
        {/* Name */}
        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-name-input">
            {t('edit.name')}
          </label>
          <input
            id="schedule-name-input"
            data-testid="schedule-name-input"
            type="text"
            value={form.name}
            maxLength={MAX_SCHEDULE_NAME_LENGTH}
            placeholder={t('edit.namePlaceholder')}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            className={INPUT_CLASS}
          />
          {nameError && <p className={ERROR_CLASS} data-testid="schedule-name-error">{nameError}</p>}
        </div>

        {/* Cron */}
        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-cron-input">
            {t('edit.cron')}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="schedule-cron-input"
              data-testid="schedule-cron-input"
              type="text"
              value={form.cronExpression}
              placeholder={t('edit.cronPlaceholder')}
              onChange={(e) => setForm((prev) => ({ ...prev, cronExpression: e.target.value }))}
              className={`${INPUT_CLASS} font-mono sm:flex-1`}
            />
            <select
              data-testid="schedule-cron-preset"
              aria-label={t('edit.cronPreset')}
              value={cronPresetValue}
              onChange={(e) => handleCronPresetChange(e.target.value)}
              className={`${INPUT_CLASS} sm:w-48`}
            >
              {CRON_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {t(`edit.${preset.labelKey}`)}
                </option>
              ))}
              <option value="custom">{t('edit.cronPresetCustom')}</option>
            </select>
          </div>
          {cronError && <p className={ERROR_CLASS} data-testid="schedule-cron-error">{cronError}</p>}
        </div>

        {/* CLI Tool */}
        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-cli-tool-select">
            {t('edit.cliTool')}
          </label>
          <select
            id="schedule-cli-tool-select"
            data-testid="schedule-cli-tool-select"
            value={form.cliToolId}
            onChange={(e) => handleToolChange(e.target.value)}
            className={INPUT_CLASS}
          >
            {CLI_TOOL_IDS.map((tool) => (
              <option key={tool} value={tool}>
                {getCliToolDisplayName(tool)}
              </option>
            ))}
          </select>
        </div>

        {/* Model (copilot only) */}
        {showModel && (
          <div>
            <label className={LABEL_CLASS} htmlFor="schedule-model-input">
              {t('edit.model')}
            </label>
            <input
              id="schedule-model-input"
              data-testid="schedule-model-input"
              type="text"
              value={form.model}
              placeholder={t('edit.modelPlaceholder')}
              onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
              className={INPUT_CLASS}
            />
            {modelError && (
              <p className={ERROR_CLASS} data-testid="schedule-model-error">{modelError}</p>
            )}
          </div>
        )}

        {/* Permission (dynamic per CLI tool) */}
        {showPermission && (
          <div>
            <label className={LABEL_CLASS} htmlFor="schedule-permission-select">
              {t('edit.permission')}
            </label>
            <select
              id="schedule-permission-select"
              data-testid="schedule-permission-select"
              value={form.permission}
              onChange={(e) => setForm((prev) => ({ ...prev, permission: e.target.value }))}
              className={INPUT_CLASS}
            >
              {permissionOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Message */}
        <div>
          <label className={LABEL_CLASS} htmlFor="schedule-message-input">
            {t('edit.message')}
          </label>
          <textarea
            id="schedule-message-input"
            data-testid="schedule-message-input"
            value={form.message}
            rows={4}
            maxLength={MAX_SCHEDULE_MESSAGE_LENGTH}
            placeholder={t('edit.messagePlaceholder')}
            onChange={(e) => setForm((prev) => ({ ...prev, message: e.target.value }))}
            className={`${INPUT_CLASS} resize-none`}
          />
          <div className="mt-1 flex items-center justify-between">
            {messageError ? (
              <p className={ERROR_CLASS} data-testid="schedule-message-error">{messageError}</p>
            ) : (
              <span />
            )}
            <span className="text-xs text-gray-400 dark:text-gray-500" data-testid="schedule-message-count">
              {t('edit.charCount', { count: form.message.length, max: MAX_SCHEDULE_MESSAGE_LENGTH })}
            </span>
          </div>
        </div>

        {/* Enabled */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            data-testid="schedule-enabled-toggle"
            checked={form.enabled}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
            className="h-4 w-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('edit.enabledLabel')}</span>
        </label>

        {submitError && (
          <div
            className="text-xs p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"
            data-testid="schedule-submit-error"
          >
            {submitError}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
          >
            {t('edit.cancel')}
          </button>
          <button
            type="button"
            data-testid="schedule-save-button"
            onClick={() => void handleSubmit()}
            disabled={!isValid || submitting}
            className="px-4 py-2 text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
          >
            {t('edit.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default ScheduleEditDialog;
