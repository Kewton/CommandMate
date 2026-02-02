/**
 * BranchMismatchAlert Component
 * Issue #111: Branch visualization feature
 *
 * Displays a warning when the current git branch differs from the
 * branch at session start.
 *
 * Security:
 * - Uses React auto-escaping for branch names (XSS prevention)
 * - No dangerouslySetInnerHTML
 */

'use client';

import { useState, useEffect, memo } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Props for BranchMismatchAlert component
 * ISP: Only required fields, not entire gitStatus
 */
export interface BranchMismatchAlertProps {
  /** Whether branches mismatch */
  isBranchMismatch: boolean;
  /** Current git branch name */
  currentBranch: string;
  /** Branch at session start (null if not recorded) */
  initialBranch: string | null;
}

/**
 * BranchMismatchAlert - Warning banner for branch mismatch
 *
 * Features:
 * - Amber/yellow warning styling
 * - Dismissible with close button
 * - Auto-reappears when currentBranch changes (after dismiss)
 * - KISS: Simple dismissed state with useEffect reset
 */
export const BranchMismatchAlert = memo(function BranchMismatchAlert({
  isBranchMismatch,
  currentBranch,
  initialBranch,
}: BranchMismatchAlertProps) {
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed state when currentBranch changes
  useEffect(() => {
    setDismissed(false);
  }, [currentBranch]);

  // Don't show if:
  // - No mismatch
  // - User dismissed
  // - No initial branch recorded
  if (!isBranchMismatch || dismissed || initialBranch === null) {
    return null;
  }

  return (
    <div
      data-testid="branch-mismatch-alert"
      role="alert"
      className="flex items-center gap-3 px-4 py-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg"
    >
      <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm">
          Branch changed from{' '}
          <span className="font-medium">{initialBranch}</span>
          {' '}to{' '}
          <span className="font-medium">{currentBranch}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-amber-100 transition-colors"
        aria-label="Dismiss alert"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
});

export default BranchMismatchAlert;
