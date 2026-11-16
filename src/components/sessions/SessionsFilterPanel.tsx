/**
 * The /sessions filter panel (Issue #4386): the branch field, its error, clear.
 * Rendered inside a Modal on PC and a bottom sheet on mobile.
 */

'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import type { SessionsFilterError } from '@/lib/sessions-filter';

export interface SessionsFilterPanelProps {
  branchPattern: string;
  onBranchPatternChange: (value: string) => void;
  error: SessionsFilterError | null;
  onClear: () => void;
}

export function SessionsFilterPanel({
  branchPattern,
  onBranchPatternChange,
  error,
  onClear,
}: SessionsFilterPanelProps) {
  const tCommon = useTranslations('common');
  return (
    <div className="space-y-3" data-testid="sessions-filter-panel">
      <label className="block text-sm text-foreground" htmlFor="sessions-branch-filter">
        {tCommon('sessions.branchFilter.label')}
      </label>
      <Input
        id="sessions-branch-filter"
        type="text"
        value={branchPattern}
        onChange={(e) => onBranchPatternChange(e.target.value)}
        placeholder={tCommon('sessions.branchFilter.placeholder')}
        data-testid="sessions-branch-filter"
        aria-invalid={error ? true : undefined}
        className={error ? 'border-danger-border focus-visible:ring-danger' : undefined}
      />
      {error && (
        <p className="text-sm text-danger-foreground" role="alert" data-testid="sessions-branch-filter-error">
          {tCommon(
            error === 'too_long'
              ? 'sessions.branchFilter.errorTooLong'
              : 'sessions.branchFilter.errorInvalid'
          )}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClear}
          data-testid="sessions-filter-clear"
          className="rounded-md border border-input bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        >
          {tCommon('sessions.branchFilter.clear')}
        </button>
      </div>
    </div>
  );
}
