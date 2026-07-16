/**
 * ReportTab Component
 * Daily report generation, viewing, and editing.
 *
 * Issue #607: Daily summary feature
 * Issue #618: Report template system - 3 generation modes
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import ReportDatePicker from './ReportDatePicker';
import { Button, Card, Input, RadioGroup, RadioGroupItem, Skeleton, Spinner, Textarea } from '@/components/ui';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { SUMMARY_ALLOWED_TOOLS, MAX_USER_INSTRUCTION_LENGTH } from '@/config/review-config';
import { useReportGeneration } from '@/hooks/useReportGeneration';
import { useGenerationStatus } from '@/hooks/useGenerationStatus';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';
import type { GenerationMode } from '@/hooks/useReportGeneration';

/** Format Date to YYYY-MM-DD */
function formatToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface ReportData {
  date: string;
  content: string;
  generatedByTool: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `labelKey` rather than a literal: t() cannot be called at module scope,
 * where a literal would pin the mode labels to English (Issue #1271/#1273). */
const MODE_OPTIONS: Array<{ value: GenerationMode; labelKey: string }> = [
  { value: 'none', labelKey: 'report.modes.none' },
  { value: 'template', labelKey: 'report.modes.template' },
  { value: 'custom', labelKey: 'report.modes.custom' },
];

export default function ReportTab() {
  const t = useTranslations('review');
  const confirm = useConfirm();
  const [selectedDate, setSelectedDate] = useState(formatToday());
  const [selectedTool, setSelectedTool] = useState<string>('claude');
  const [modelInput, setModelInput] = useState('');
  const [report, setReport] = useState<ReportData | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [editContent, setEditContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    mode,
    setMode,
    userInstruction,
    setUserInstruction,
    isUserInstructionReadOnly,
    templates,
    selectedTemplateId,
    selectTemplate,
    isLoadingTemplates,
  } = useReportGeneration();

  // Issue #638: Poll generation status to detect remote/ongoing generation
  const remoteStatus = useGenerationStatus(!isGenerating);
  const isRemoteGenerating = remoteStatus.generating && !isGenerating;

  // Fetch report for selected date
  const fetchReport = useCallback(async (date: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/daily-summary?date=${date}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || t('report.errors.fetch'));
        return;
      }
      const data = await res.json();
      setReport(data.report);
      setMessageCount(data.messageCount);
      if (data.report) {
        setEditContent(data.report.content);
      } else {
        setEditContent('');
      }
      setIsEditing(false);
    } catch {
      setError(t('report.errors.fetch'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchReport(selectedDate);
  }, [selectedDate, fetchReport]);

  // Issue #638: Auto-refresh when remote generation completes
  const [wasRemoteGenerating, setWasRemoteGenerating] = useState(false);
  useEffect(() => {
    if (remoteStatus.generating) {
      setWasRemoteGenerating(true);
    } else if (wasRemoteGenerating) {
      setWasRemoteGenerating(false);
      fetchReport(selectedDate);
    }
  }, [remoteStatus.generating, wasRemoteGenerating, fetchReport, selectedDate]);

  const handleDateChange = (date: string) => {
    setSelectedDate(date);
  };

  const handleGenerate = async () => {
    // Overwrite confirmation
    if (report && !(await confirm({ description: t('report.regenerateConfirm') }))) {
      return;
    }

    setIsGenerating(true);
    setError(null);
    try {
      const body: Record<string, string> = { date: selectedDate, tool: selectedTool };
      if (selectedTool === 'copilot' && modelInput.trim()) {
        body.model = modelInput.trim();
      }
      if (mode !== 'none' && userInstruction.trim()) {
        body.userInstruction = userInstruction.trim();
      }

      const res = await fetch('/api/daily-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        setError(t('report.errors.rateLimited'));
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || t('report.errors.generate'));
        return;
      }

      const data = await res.json();
      setReport(data.report);
      setEditContent(data.report.content);
      setIsEditing(false);
    } catch {
      setError(t('report.errors.generate'));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!editContent.trim()) {
      setError(t('report.errors.emptyContent'));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/daily-summary', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selectedDate, content: editContent }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || t('report.errors.save'));
        return;
      }

      const data = await res.json();
      setReport(data.report);
      setIsEditing(false);
    } catch {
      setError(t('report.errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div data-testid="report-tab">
      {/* Date picker + Tool selector */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <ReportDatePicker value={selectedDate} onChange={handleDateChange} />

        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">{t('report.toolLabel')}</label>
          <select
            value={selectedTool}
            onChange={(e) => setSelectedTool(e.target.value)}
            className="px-3 py-1 text-sm rounded border border-input bg-surface dark:bg-surface-2 text-surface-foreground"
            data-testid="tool-selector"
          >
            {SUMMARY_ALLOWED_TOOLS.map((tool) => (
              <option key={tool} value={tool}>{tool}</option>
            ))}
          </select>

          {selectedTool === 'copilot' && (
            <Input
              type="text"
              inputSize="sm"
              placeholder={t('report.modelPlaceholder')}
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              className="w-auto"
              data-testid="model-input"
            />
          )}
        </div>

      </div>

      {/* Generation mode selector */}
      <div className="mb-4" data-testid="generation-mode-selector">
        <label className="text-sm font-medium text-foreground mb-2 block">
          {t('report.generationMode')}
        </label>
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as GenerationMode)}
          name="generation-mode"
          className="flex flex-row gap-4"
        >
          {MODE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm cursor-pointer">
              <RadioGroupItem value={option.value} data-testid={`mode-radio-${option.value}`} />
              <span className="text-foreground">{t(option.labelKey)}</span>
            </label>
          ))}
        </RadioGroup>
      </div>

      {/* Template selector (only in template mode) */}
      {mode === 'template' && (
        <div className="mb-4" data-testid="template-selector">
          <label className="text-sm font-medium text-foreground mb-2 block">
            {t('report.selectTemplate')}
          </label>
          {isLoadingTemplates ? (
            <Skeleton
              className="h-9 w-full"
              data-testid="report-template-loading"
              role="status"
              aria-label={t('report.loadingTemplates')}
              aria-hidden={undefined}
            />
          ) : templates.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('report.noTemplates')}</div>
          ) : (
            <select
              value={selectedTemplateId || ''}
              onChange={(e) => selectTemplate(e.target.value)}
              className="px-3 py-1 text-sm rounded border border-input bg-surface dark:bg-surface-2 text-surface-foreground"
              data-testid="template-select"
            >
              <option value="">{t('report.templatePlaceholderOption')}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* User instruction textarea (visible in template and custom modes) */}
      {mode !== 'none' && (
        <div className="mb-4">
          <Textarea
            value={userInstruction}
            onChange={(e) => setUserInstruction(e.target.value)}
            rows={3}
            maxLength={MAX_USER_INSTRUCTION_LENGTH}
            readOnly={isUserInstructionReadOnly}
            placeholder={
              mode === 'template'
                ? t('report.instructionPlaceholderTemplate')
                : t('report.instructionPlaceholderCustom')
            }
            className={`resize-y ${
              isUserInstructionReadOnly ? 'bg-muted cursor-not-allowed' : ''
            }`}
            data-testid="user-instruction-input"
          />
        </div>
      )}

      {/* Generate button */}
      <div className="mb-6">
        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={isGenerating || isRemoteGenerating || messageCount === 0}
          data-testid="generate-button"
        >
          {isGenerating || isRemoteGenerating ? t('report.generating') : t('report.generate')}
        </Button>
      </div>

      {/* Message count */}
      <div className="mb-4 text-sm text-muted-foreground" data-testid="message-count">
        {isLoading ? (
          <Skeleton className="h-4 w-48" />
        ) : messageCount === 0 ? (
          t('report.noMessages')
        ) : (
          t('report.messagesFound', { count: messageCount })
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-danger-subtle text-danger-foreground rounded-lg text-sm" data-testid="report-error">
          {error}
        </div>
      )}

      {/* Loading spinner for generation (local or remote) */}
      {(isGenerating || isRemoteGenerating) && (
        <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground" data-testid="generating-spinner">
          <Spinner size="sm" variant="muted" />
          {isRemoteGenerating && remoteStatus.tool
            ? remoteStatus.startedAt
              ? t('report.generatingRemoteWithTime', {
                  tool: remoteStatus.tool,
                  seconds: Math.round(
                    (Date.now() - new Date(remoteStatus.startedAt).getTime()) / 1000,
                  ),
                })
              : t('report.generatingRemote', { tool: remoteStatus.tool })
            : t('report.generatingSummary')}
        </div>
      )}

      {/* Report content */}
      {!isLoading && report && (
        <Card data-testid="report-content">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-muted-foreground">
              {t('report.generatedBy', { tool: report.generatedByTool })}
              {report.model && ` (${report.model})`}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await copyToClipboard(report.content);
                  setCopied(true);
                  setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
                }}
                data-testid="copy-report-button"
              >
                {copied ? t('report.copied') : t('report.copy')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (isEditing) {
                    handleSave();
                  } else {
                    setIsEditing(true);
                  }
                }}
                disabled={isSaving}
                data-testid="edit-save-button"
              >
                {isSaving ? t('report.saving') : isEditing ? t('report.save') : t('report.edit')}
              </Button>
            </div>
          </div>

          {isEditing ? (
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="h-64 p-3 font-mono"
              data-testid="report-editor"
            />
          ) : (
            <div className="prose dark:prose-invert max-w-none text-sm whitespace-pre-wrap" data-testid="report-preview">
              {report.content}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
