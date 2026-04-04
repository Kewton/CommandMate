/**
 * useReportGeneration hook
 * Manages report generation mode and template selection state.
 *
 * Issue #618: Report template system
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

/** Generation mode for report creation */
export type GenerationMode = 'none' | 'template' | 'custom';

/** Template data from API */
export interface TemplateData {
  id: string;
  name: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface UseReportGenerationReturn {
  /** Current generation mode */
  mode: GenerationMode;
  /** Set the generation mode */
  setMode: (mode: GenerationMode) => void;
  /** Current user instruction text */
  userInstruction: string;
  /** Set user instruction (only works in 'custom' mode) */
  setUserInstruction: (value: string) => void;
  /** Whether user instruction is read-only */
  isUserInstructionReadOnly: boolean;
  /** Available templates */
  templates: TemplateData[];
  /** Currently selected template ID */
  selectedTemplateId: string | null;
  /** Select a template by ID */
  selectTemplate: (id: string) => void;
  /** Whether templates are loading */
  isLoadingTemplates: boolean;
  /** Refresh templates from API */
  refreshTemplates: () => Promise<void>;
}

export function useReportGeneration(): UseReportGenerationReturn {
  const [mode, setModeInternal] = useState<GenerationMode>('none');
  const [userInstruction, setUserInstructionInternal] = useState('');
  const [templates, setTemplates] = useState<TemplateData[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setIsLoadingTemplates(true);
    try {
      const res = await fetch('/api/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data.templates || []);
      }
    } catch {
      // Silently fail - templates are optional
    } finally {
      setIsLoadingTemplates(false);
    }
  }, []);

  // Fetch templates on mount
  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const setMode = useCallback((newMode: GenerationMode) => {
    setModeInternal(newMode);
    // Reset userInstruction when mode changes
    setUserInstructionInternal('');
    setSelectedTemplateId(null);
  }, []);

  const setUserInstruction = useCallback((value: string) => {
    // Only allow setting in 'custom' mode
    if (mode === 'custom') {
      setUserInstructionInternal(value);
    }
  }, [mode]);

  const selectTemplate = useCallback((id: string) => {
    const template = templates.find(t => t.id === id);
    if (template && mode === 'template') {
      setSelectedTemplateId(id);
      setUserInstructionInternal(template.content);
    }
  }, [templates, mode]);

  return {
    mode,
    setMode,
    userInstruction,
    setUserInstruction,
    isUserInstructionReadOnly: mode === 'template',
    templates,
    selectedTemplateId,
    selectTemplate,
    isLoadingTemplates,
    refreshTemplates: fetchTemplates,
  };
}
