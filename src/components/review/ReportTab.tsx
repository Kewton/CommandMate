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
import { Button, Card, Input, RadioGroup, RadioGroupItem, Textarea } from '@/components/ui';
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

const MODE_OPTIONS: Array<{ value: GenerationMode; label: string }> = [
  { value: 'none', label: 'No instruction' },
  { value: 'template', label: 'Template' },
  { value: 'custom', label: 'Custom' },
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
        setError(data.error || 'Failed to fetch report');
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
      setError('Failed to fetch report');
    } finally {
      setIsLoading(false);
    }
  }, []);

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
        setError('Another summary is being generated. Please wait.');
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to generate summary');
        return;
      }

      const data = await res.json();
      setReport(data.report);
      setEditContent(data.report.content);
      setIsEditing(false);
    } catch {
      setError('Failed to generate summary');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!editContent.trim()) {
      setError('Content cannot be empty');
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
        setError(data.error || 'Failed to save report');
        return;
      }

      const data = await res.json();
      setReport(data.report);
      setIsEditing(false);
    } catch {
      setError('Failed to save report');
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
          <label className="text-sm text-muted-foreground">Tool:</label>
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
              placeholder="Model (optional)"
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
          Generation Mode
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
              <span className="text-foreground">{option.label}</span>
            </label>
          ))}
        </RadioGroup>
      </div>

      {/* Template selector (only in template mode) */}
      {mode === 'template' && (
        <div className="mb-4" data-testid="template-selector">
          <label className="text-sm font-medium text-foreground mb-2 block">
            Select Template
          </label>
          {isLoadingTemplates ? (
            <div className="text-sm text-muted-foreground">Loading templates...</div>
          ) : templates.length === 0 ? (
            <div className="text-sm text-muted-foreground">No templates available. Create one in the Template tab.</div>
          ) : (
            <select
              value={selectedTemplateId || ''}
              onChange={(e) => selectTemplate(e.target.value)}
              className="px-3 py-1 text-sm rounded border border-input bg-surface dark:bg-surface-2 text-surface-foreground"
              data-testid="template-select"
            >
              <option value="">-- Select a template --</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
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
                ? 'Select a template above to populate this field'
                : 'Additional instructions for summary generation'
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
          {isGenerating || isRemoteGenerating ? 'Generating...' : 'Generate Summary'}
        </Button>
      </div>

      {/* Message count */}
      <div className="mb-4 text-sm text-muted-foreground" data-testid="message-count">
        {isLoading ? (
          'Loading...'
        ) : messageCount === 0 ? (
          'No messages for this date.'
        ) : (
          `${messageCount} messages found for this date.`
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm" data-testid="report-error">
          {error}
        </div>
      )}

      {/* Loading spinner for generation (local or remote) */}
      {(isGenerating || isRemoteGenerating) && (
        <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground" data-testid="generating-spinner">
          <div className="w-4 h-4 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          {isRemoteGenerating && remoteStatus.tool
            ? `Generating report... (tool: ${remoteStatus.tool}${remoteStatus.startedAt ? `, started: ${Math.round((Date.now() - new Date(remoteStatus.startedAt).getTime()) / 1000)}s ago` : ''})`
            : 'Generating summary...'}
        </div>
      )}

      {/* Report content */}
      {!isLoading && report && (
        <Card data-testid="report-content">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-muted-foreground">
              Generated by: {report.generatedByTool}
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
                {copied ? 'Copied!' : 'Copy'}
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
                {isSaving ? 'Saving...' : isEditing ? 'Save' : 'Edit'}
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
