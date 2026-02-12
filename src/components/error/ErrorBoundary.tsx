/**
 * Error Boundary Component
 * Catches JavaScript errors in child components and displays fallback UI
 */

'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { useTranslations } from 'next-intl';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  componentName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary for catching and handling component errors
 *
 * @example
 * ```tsx
 * <ErrorBoundary componentName="Terminal" fallback={<TerminalErrorFallback />}>
 *   <TerminalDisplay output={output} />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.componentName || 'unknown'}]`, error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <DefaultErrorFallback
          componentName={this.props.componentName}
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}

interface ErrorFallbackProps {
  componentName?: string;
  error: Error | null;
  onRetry?: () => void;
}

/**
 * Default error fallback UI
 */
function DefaultErrorFallback({
  componentName,
  error,
  onRetry,
}: ErrorFallbackProps) {
  const tError = useTranslations('error');
  const tCommon = useTranslations('common');

  return (
    <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
      <div className="flex items-center gap-2 text-red-800 mb-2">
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        <span className="font-medium">
          {componentName ? tError('boundary.errorOccurredIn', { componentName }) : tError('boundary.errorOccurred')}
        </span>
      </div>
      {error && (
        <p className="text-sm text-red-600 mb-3">{error.message}</p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
        >
          {tCommon('retry')}
        </button>
      )}
    </div>
  );
}

export default ErrorBoundary;
