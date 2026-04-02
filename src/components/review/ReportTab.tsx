/**
 * ReportTab Component
 * Daily report generation, viewing, and editing.
 *
 * Issue #607: Daily summary feature
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import ReportDatePicker from './ReportDatePicker';
import { SUMMARY_ALLOWED_TOOLS } from '@/config/review-config';

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

export default function ReportTab() {
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
  const [error, setError] = useState<string | null>(null);

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

  const handleDateChange = (date: string) => {
    setSelectedDate(date);
  };

  const handleGenerate = async () => {
    // Overwrite confirmation
    if (report && !window.confirm('A report already exists for this date. Regenerate and overwrite?')) {
      return;
    }

    setIsGenerating(true);
    setError(null);
    try {
      const body: Record<string, string> = { date: selectedDate, tool: selectedTool };
      if (selectedTool === 'copilot' && modelInput.trim()) {
        body.model = modelInput.trim();
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
          <label className="text-sm text-gray-600 dark:text-gray-400">Tool:</label>
          <select
            value={selectedTool}
            onChange={(e) => setSelectedTool(e.target.value)}
            className="px-3 py-1 text-sm border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
            data-testid="tool-selector"
          >
            {SUMMARY_ALLOWED_TOOLS.map((tool) => (
              <option key={tool} value={tool}>{tool}</option>
            ))}
          </select>

          {selectedTool === 'copilot' && (
            <input
              type="text"
              placeholder="Model (optional)"
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              className="px-3 py-1 text-sm border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200"
              data-testid="model-input"
            />
          )}
        </div>

        <button
          onClick={handleGenerate}
          disabled={isGenerating || messageCount === 0}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            isGenerating || messageCount === 0
              ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-500 cursor-not-allowed'
              : 'bg-cyan-600 text-white hover:bg-cyan-700'
          }`}
          data-testid="generate-button"
        >
          {isGenerating ? 'Generating...' : 'Generate Summary'}
        </button>
      </div>

      {/* Message count */}
      <div className="mb-4 text-sm text-gray-600 dark:text-gray-400" data-testid="message-count">
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

      {/* Loading spinner for generation */}
      {isGenerating && (
        <div className="flex items-center gap-2 mb-4 text-sm text-gray-600 dark:text-gray-400" data-testid="generating-spinner">
          <div className="w-4 h-4 border-2 border-cyan-600 border-t-transparent rounded-full animate-spin" />
          Generating summary...
        </div>
      )}

      {/* Report content */}
      {!isLoading && report && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 p-4" data-testid="report-content">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Generated by: {report.generatedByTool}
              {report.model && ` (${report.model})`}
            </div>
            <button
              onClick={() => {
                if (isEditing) {
                  handleSave();
                } else {
                  setIsEditing(true);
                }
              }}
              disabled={isSaving}
              className="px-3 py-1 text-xs font-medium rounded transition-colors bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
              data-testid="edit-save-button"
            >
              {isSaving ? 'Saving...' : isEditing ? 'Save' : 'Edit'}
            </button>
          </div>

          {isEditing ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full h-64 p-3 text-sm border rounded dark:bg-gray-900 dark:border-gray-600 dark:text-gray-200 font-mono"
              data-testid="report-editor"
            />
          ) : (
            <div className="prose dark:prose-invert max-w-none text-sm whitespace-pre-wrap" data-testid="report-preview">
              {report.content}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
