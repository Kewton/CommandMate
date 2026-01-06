/**
 * Error Fallback UI Components
 * Specialized fallback components for different parts of the application
 */

'use client';

import React from 'react';

interface ErrorFallbackProps {
  componentName?: string;
  error: Error | null;
  onRetry?: () => void;
}

/**
 * Terminal-specific error fallback
 * Styled to match the terminal appearance
 */
export function TerminalErrorFallback({
  error,
  onRetry,
}: ErrorFallbackProps) {
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
        <h3 className="text-lg font-medium mb-2">ターミナル表示エラー</h3>
        <p className="text-sm text-gray-400 mb-4">
          {error?.message || 'ターミナル出力の表示中にエラーが発生しました'}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors text-sm"
          >
            再読み込み
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * History pane error fallback
 * Styled for the message history area
 */
export function HistoryErrorFallback({
  error,
  onRetry,
}: ErrorFallbackProps) {
  return (
    <div className="h-full flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center">
        <div className="text-yellow-500 mb-2">
          <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-gray-800 mb-2">メッセージ履歴の読み込みエラー</h3>
        <p className="text-sm text-gray-600 mb-4">
          {error?.message || '履歴の表示中にエラーが発生しました'}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm"
          >
            再読み込み
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Prompt panel error fallback
 * Styled for the prompt response area
 */
export function PromptErrorFallback({
  error,
  onRetry,
}: ErrorFallbackProps) {
  return (
    <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
      <div className="flex items-center gap-2 text-yellow-800 mb-2">
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        <span className="font-medium">プロンプト応答エラー</span>
      </div>
      <p className="text-sm text-yellow-700 mb-3">
        {error?.message || '選択肢の表示中にエラーが発生しました'}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 transition-colors text-sm"
        >
          再試行
        </button>
      )}
    </div>
  );
}

/**
 * Connection error fallback
 * For WebSocket or API connection issues
 */
export function ConnectionErrorFallback({
  error,
  onRetry,
}: ErrorFallbackProps) {
  return (
    <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg">
      <div className="flex items-center gap-2 text-orange-800 mb-2">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
          />
        </svg>
        <span className="font-medium">接続エラー</span>
      </div>
      <p className="text-sm text-orange-700 mb-3">
        {error?.message || 'サーバーへの接続に問題が発生しました'}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 transition-colors text-sm"
        >
          再接続
        </button>
      )}
    </div>
  );
}
