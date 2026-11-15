/**
 * Bottom sheet for the /sessions filter on mobile (Issue #4386). The bottom
 * placement mirrors MobilePromptSheet / MobileTerminalActionsSheet.
 */

'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export interface SessionsFilterSheetProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function SessionsFilterSheet({ isOpen, onClose, children }: SessionsFilterSheetProps) {
  const tCommon = useTranslations('common');
  const ref = useFocusTrap<HTMLDivElement>({ active: isOpen });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
        aria-hidden="true"
        data-testid="sessions-filter-sheet-overlay"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={tCommon('sessions.branchFilter.title')}
        data-testid="sessions-filter-sheet"
        className="fixed bottom-0 inset-x-0 z-50 rounded-t-2xl border-t border-border bg-surface p-4 pb-safe"
      >
        {children}
      </div>
    </>
  );
}
