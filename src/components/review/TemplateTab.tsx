/**
 * TemplateTab Component
 * Template management UI for report generation.
 *
 * Issue #618: Report template system
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Card, Input, Textarea } from '@/components/ui';
import {
  MAX_TEMPLATES,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_CONTENT_LENGTH,
} from '@/config/review-config';
import type { TemplateData } from '@/hooks/useReportGeneration';

export default function TemplateTab() {
  const [templates, setTemplates] = useState<TemplateData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/templates');
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to fetch templates');
        return;
      }
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch {
      setError('Failed to fetch templates');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleCreate = async () => {
    if (!newName.trim() || !newContent.trim()) {
      setError('Name and content are required');
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), content: newContent.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create template');
        return;
      }

      setNewName('');
      setNewContent('');
      await fetchTemplates();
    } catch {
      setError('Failed to create template');
    } finally {
      setIsCreating(false);
    }
  };

  const handleEdit = (template: TemplateData) => {
    setEditingId(template.id);
    setEditName(template.name);
    setEditContent(template.content);
  };

  const handleSave = async () => {
    if (!editingId || !editName.trim() || !editContent.trim()) {
      setError('Name and content are required');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), content: editContent.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update template');
        return;
      }

      setEditingId(null);
      await fetchTemplates();
    } catch {
      setError('Failed to update template');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this template?')) return;

    setError(null);
    try {
      const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to delete template');
        return;
      }
      await fetchTemplates();
    } catch {
      setError('Failed to delete template');
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditContent('');
  };

  return (
    <div data-testid="template-tab">
      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg text-sm" data-testid="template-error">
          {error}
        </div>
      )}

      {/* Template list */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Templates ({templates.length}/{MAX_TEMPLATES})
        </h2>

        {isLoading ? (
          <div className="text-sm text-gray-500" data-testid="template-loading">Loading...</div>
        ) : templates.length === 0 ? (
          <div className="text-sm text-gray-500" data-testid="template-empty">No templates yet.</div>
        ) : (
          <div className="space-y-3" data-testid="template-list">
            {templates.map((template) => (
              <Card
                key={template.id}
                padding="sm"
                data-testid={`template-item-${template.id}`}
              >
                {editingId === template.id ? (
                  <div className="space-y-2">
                    <Input
                      type="text"
                      inputSize="sm"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={MAX_TEMPLATE_NAME_LENGTH}
                      data-testid="edit-name-input"
                    />
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      maxLength={MAX_TEMPLATE_CONTENT_LENGTH}
                      rows={3}
                      className="resize-y"
                      data-testid="edit-content-input"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSave}
                        disabled={isSaving}
                        data-testid="edit-save-button"
                      >
                        {isSaving ? 'Saving...' : 'Save'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleCancelEdit}
                        data-testid="edit-cancel-button"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100" data-testid="template-name">
                        {template.name}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleEdit(template)}
                          data-testid={`edit-button-${template.id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDelete(template.id)}
                          data-testid={`delete-button-${template.id}`}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap" data-testid="template-content">
                      {template.content}
                    </p>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create form (only shown when under limit) */}
      {templates.length < MAX_TEMPLATES && (
        <div className="p-4 bg-surface border border-border rounded-lg shadow-sm" data-testid="create-form">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">New Template</h3>
          <div className="space-y-3">
            <Input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={MAX_TEMPLATE_NAME_LENGTH}
              placeholder="Template name"
              data-testid="new-name-input"
            />
            <Textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              maxLength={MAX_TEMPLATE_CONTENT_LENGTH}
              rows={3}
              placeholder="Template content (instructions for report generation)"
              className="resize-y"
              data-testid="new-content-input"
            />
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={isCreating || !newName.trim() || !newContent.trim()}
              data-testid="create-button"
            >
              {isCreating ? 'Creating...' : 'Create Template'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
