/**
 * Terminal-specific error fallback
 *
 * Always-dark island: styled to match the fixed-dark terminal output surface
 * so it looks consistent in BOTH themes (same policy as *Terminal* files and
 * the xterm output area). It intentionally uses raw dark utilities rather than
 * theme-following tokens — tokenizing this to `bg-surface`/`text-foreground`
 * would make it render light over the always-dark terminal in light mode. Kept
 * in a `*Terminal*` file so the token-discipline CI guard excludes it. See
 * docs/design-system.md → 常時ダーク領域とテーマ追従.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

interface ErrorFallbackProps {
  componentName?: string;
  error: Error | null;
  onRetry?: () => void;
}

export function TerminalErrorFallback({
  error,
  onRetry,
}: ErrorFallbackProps) {
  const tError = useTranslations('error');
  const tCommon = useTranslations('common');

  return (
    <div className="h-full flex items-center justify-center bg-gray-900 text-gray-100 p-4">
      <div className="text-center">
        <div className="text-red-400 mb-2">
          <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium mb-2">{tError('terminal.displayError')}</h3>
        <p className="text-sm text-gray-400 mb-4">
          {error?.message || tError('terminal.outputError')}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors text-sm"
          >
            {tCommon('reload')}
          </button>
        )}
      </div>
    </div>
  );
}
