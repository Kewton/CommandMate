/**
 * ScheduleEditDialog Component
 * Issue #824: Schedules UX Phase 1
 * Issue #825: Schedules UX Phase 2 (mobile full-screen modal + section accordion)
 *
 * Desktop/Mobile shared dialog for creating and editing a schedule. On save it
 * writes to CMATE.md via /api/worktrees/:id/cmate/schedules (Option C, write-only
 * sync) — it never calls the schedule DB API directly.
 *
 * Layout (Phase 2):
 * - Desktop (>= md): the Phase 1 centered `Modal` with all three sections expanded.
 * - Mobile (< md): a `FullScreenModal` (slide up, sticky footer) with the sections
 *   collapsed into an accordion where only the first section is open by default.
 *
 * Dynamic behavior:
 * - The Permission dropdown options change when the CLI Tool changes.
 * - The Model field is shown only for CLI tools that support `--model` (copilot).
 */

'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Info, SlidersHorizontal, MessageSquare, ChevronDown } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { FullScreenModal } from '@/components/common/FullScreenModal';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  CLI_TOOL_IDS,
  getCliToolDisplayNameSafe,
  agentInstancesFromSelectedAgents,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import {
  getPermissionOptionsForTool,
  DEFAULT_PERMISSIONS,
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_SCHEDULE_MESSAGE_LENGTH,
} from '@/config/schedule-config';
import { NAME_PATTERN, isValidCronExpression } from '@/config/cmate-constants';
import { validateCopilotModelName } from '@/lib/cmate-cli-tool-parser';
import { cronPrompt, messageDraftPrompt } from '@/lib/schedule-ai-prompt-templates';

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
  /**
   * Issue #827: draft a context-aware "Ask AI" prompt into the active CLI tab's
   * MessageInput composer (no auto-send). When omitted the "Ask AI" buttons are
   * hidden (graceful degradation, same as the GitPane #817 pattern).
   */
  onInsertToMessage?: (text: string) => void;
  /**
   * Issue #942: registered agent instances. Drives the agent selector so it
   * lists registered instance aliases instead of the raw CLI tool names. The
   * schedule is persisted/executed by the selected instance's backing CLI tool
   * (UI-label only — Schedule runs a fresh `claude -p` process, so per-instance
   * session routing is not meaningful here). Falls back to the primary instance
   * of every CLI tool when omitted/empty.
   */
  instances?: AgentInstance[];
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

/** Accordion section identifiers (Issue #825). */
type SectionId = 'basic' | 'advanced' | 'message';

// ============================================================================
// AskAiButton
// ============================================================================

/**
 * "Ask AI" button (Issue #827). Drafts a context-aware prompt into the active
 * CLI tab's MessageInput composer (no auto-send) so the user can review/edit
 * before sending. Presentational only: the call site owns the `onClick` (it
 * builds the prompt from a `schedule-ai-prompt-templates` builder and closes the
 * modal). Mirrors the GitPane #817 button styling for a consistent affordance.
 */
function AskAiButton({
  onClick,
  label,
  title,
  testId,
}: {
  onClick: () => void;
  label: string;
  title: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 transition-colors"
    >
      <span aria-hidden="true">✨</span>
      {label}
    </button>
  );
}

// ============================================================================
// AccordionSection
// ============================================================================

interface AccordionSectionProps {
  id: SectionId;
  title: string;
  summary: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
}

/** Collapsible section with an icon + summary header (Issue #825). */
function AccordionSection({
  id,
  title,
  summary,
  icon,
  isOpen,
  onToggle,
  children,
}: AccordionSectionProps) {
  const contentId = `schedule-section-${id}-content`;
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        data-testid={`schedule-section-${id}`}
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => onToggle(id)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <span className="flex-shrink-0 text-cyan-600 dark:text-cyan-400">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</span>
          {summary && (
            <span
              data-testid={`schedule-section-${id}-summary`}
              className="block truncate text-xs text-gray-500 dark:text-gray-400"
            >
              {summary}
            </span>
          )}
        </span>
        <ChevronDown
          className={`flex-shrink-0 w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {isOpen && (
        <div id={contentId} className="px-3 py-3 flex flex-col gap-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export function ScheduleEditDialog({
  isOpen,
  worktreeId,
  initialValues,
  originalName,
  onInsertToMessage,
  instances,
  onClose,
  onSaved,
}: ScheduleEditDialogProps) {
  const t = useTranslations('schedule');
  const isMobile = useIsMobile();

  // Resolve the agent roster: explicit instances when configured, otherwise the
  // primary instance of every CLI tool (legacy behavior).
  const resolvedInstances = useMemo<AgentInstance[]>(
    () => (instances && instances.length > 0
      ? instances
      : agentInstancesFromSelectedAgents([...CLI_TOOL_IDS])),
    [instances]
  );

  const [form, setForm] = useState<ScheduleFormValues>(DEFAULT_FORM);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Accordion: desktop shows every section open; mobile opens only the first.
  const [openSections, setOpenSections] = useState<Set<SectionId>>(
    () => new Set<SectionId>(['basic', 'advanced', 'message']),
  );

  // Seed (or reset) the form whenever the dialog is opened.
  useEffect(() => {
    if (!isOpen) return;
    setSubmitError(null);
    setSubmitting(false);
    const cliToolId = initialValues?.cliToolId ?? DEFAULT_FORM.cliToolId;
    setForm({
      name: initialValues?.name ?? DEFAULT_FORM.name,
      cronExpression: initialValues?.cronExpression ?? DEFAULT_FORM.cronExpression,
      message: initialValues?.message ?? DEFAULT_FORM.message,
      cliToolId,
      enabled: initialValues?.enabled ?? DEFAULT_FORM.enabled,
      permission: initialValues?.permission ?? DEFAULT_FORM.permission,
      model: initialValues?.model ?? DEFAULT_FORM.model,
    });
    // Issue #942: pick the instance backing the seeded CLI tool. The modal is
    // blocking, so the roster cannot change while it is open.
    const match = resolvedInstances.find((inst) => inst.cliTool === cliToolId);
    setSelectedInstanceId(match?.id ?? resolvedInstances[0]?.id ?? cliToolId);
  }, [isOpen, initialValues, resolvedInstances]);

  // Reset which sections are open whenever the dialog opens or the layout changes.
  useEffect(() => {
    if (!isOpen) return;
    setOpenSections(
      isMobile
        ? new Set<SectionId>(['basic'])
        : new Set<SectionId>(['basic', 'advanced', 'message']),
    );
  }, [isOpen, isMobile]);

  const toggleSection = useCallback((id: SectionId) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  // Issue #942: the agent selector picks an instance (by alias); the schedule is
  // still keyed by the instance's backing CLI tool (UI-label only).
  const handleInstanceChange = useCallback((instanceId: string) => {
    const selected = resolvedInstances.find((inst) => inst.id === instanceId);
    if (!selected) return;
    setSelectedInstanceId(instanceId);
    handleToolChange(selected.cliTool);
  }, [resolvedInstances, handleToolChange]);

  const cronPresetValue = CRON_PRESETS.some((p) => p.value === form.cronExpression)
    ? form.cronExpression
    : 'custom';

  const handleCronPresetChange = useCallback((value: string) => {
    if (value === 'custom') return;
    setForm((prev) => ({ ...prev, cronExpression: value }));
  }, []);

  // Issue #827: draft a prompt into the composer, then close the modal so the
  // user can review the AI's reply (minimal impl — they reopen the modal to
  // paste the suggested cron / message back in).
  const handleAskAi = useCallback(
    (text: string) => {
      onInsertToMessage?.(text);
      onClose();
    },
    [onInsertToMessage, onClose],
  );

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

  // ----- Accordion header summaries -----
  // Show the selected instance alias, falling back to the CLI tool name.
  const cliToolName =
    resolvedInstances.find((inst) => inst.id === selectedInstanceId)?.alias
    ?? getCliToolDisplayNameSafe(form.cliToolId);
  const basicSummary = form.name.trim()
    ? `${form.name.trim()} · ${form.cronExpression}`
    : form.cronExpression;
  const advancedSummary = [
    cliToolName,
    showPermission ? form.permission : null,
    showModel && form.model.trim() ? form.model.trim() : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const messagePreview = form.message.trim();
  const messageSummary =
    messagePreview.length > 32 ? `${messagePreview.slice(0, 32)}…` : messagePreview;

  // ----- Field groups (shared by Desktop and Mobile) -----
  const basicFields = (
    <>
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
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300" htmlFor="schedule-cron-input">
            {t('edit.cron')}
          </label>
          {onInsertToMessage && (
            <AskAiButton
              testId="schedule-cron-ask-ai"
              label={t('edit.askAiCron')}
              title={t('edit.askAiHint')}
              onClick={() => handleAskAi(cronPrompt(form.cronExpression))}
            />
          )}
        </div>
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
    </>
  );

  const advancedFields = (
    <>
      {/* CLI Tool */}
      <div>
        <label className={LABEL_CLASS} htmlFor="schedule-cli-tool-select">
          {t('edit.cliTool')}
        </label>
        <select
          id="schedule-cli-tool-select"
          data-testid="schedule-cli-tool-select"
          value={selectedInstanceId}
          onChange={(e) => handleInstanceChange(e.target.value)}
          className={INPUT_CLASS}
        >
          {resolvedInstances.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.alias}
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
    </>
  );

  const messageFields = (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300" htmlFor="schedule-message-input">
          {t('edit.message')}
        </label>
        {onInsertToMessage && (
          <AskAiButton
            testId="schedule-message-ask-ai"
            label={t('edit.askAiMessage')}
            title={t('edit.askAiHint')}
            onClick={() => handleAskAi(messageDraftPrompt(form.name))}
          />
        )}
      </div>
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
  );

  // ----- Shared body: three accordion sections -----
  const sections = (
    <div className="flex flex-col gap-3">
      <AccordionSection
        id="basic"
        title={t('edit.sectionBasic')}
        summary={basicSummary}
        icon={<Info className="w-4 h-4" />}
        isOpen={openSections.has('basic')}
        onToggle={toggleSection}
      >
        {basicFields}
      </AccordionSection>

      <AccordionSection
        id="advanced"
        title={t('edit.sectionAdvanced')}
        summary={advancedSummary}
        icon={<SlidersHorizontal className="w-4 h-4" />}
        isOpen={openSections.has('advanced')}
        onToggle={toggleSection}
      >
        {advancedFields}
      </AccordionSection>

      <AccordionSection
        id="message"
        title={t('edit.sectionMessage')}
        summary={messageSummary}
        icon={<MessageSquare className="w-4 h-4" />}
        isOpen={openSections.has('message')}
        onToggle={toggleSection}
      >
        {messageFields}
      </AccordionSection>

      {submitError && (
        <div
          className="text-xs p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"
          data-testid="schedule-submit-error"
        >
          {submitError}
        </div>
      )}
    </div>
  );

  // ----- Shared footer buttons -----
  const footerButtons = (
    <div className="flex items-center justify-end gap-2">
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
  );

  const title = isEdit ? t('edit.titleEdit') : t('edit.titleCreate');

  // Mobile: full-screen modal with a sticky footer (Issue #825).
  if (isMobile) {
    return (
      <FullScreenModal isOpen={isOpen} onClose={onClose} title={title} footer={footerButtons}>
        {sections}
      </FullScreenModal>
    );
  }

  // Desktop: the Phase 1 centered modal, sections expanded.
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <div className="flex flex-col gap-4">
        {sections}
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">{footerButtons}</div>
      </div>
    </Modal>
  );
}

export default ScheduleEditDialog;
