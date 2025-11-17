/**
 * PromptMessage Component
 * Displays Claude prompts with interactive Yes/No buttons
 */

'use client';

import { useState } from 'react';
import type { ChatMessage } from '@/types/models';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

export interface PromptMessageProps {
  message: ChatMessage;
  worktreeId: string;
  onRespond: (answer: string) => Promise<void>;
}

export function PromptMessage({ message, worktreeId, onRespond }: PromptMessageProps) {
  const [responding, setResponding] = useState(false);
  const prompt = message.promptData!;
  const isPending = prompt.status === 'pending';
  const timestamp = format(new Date(message.timestamp), 'PPp', { locale: ja });

  const handleRespond = async (answer: string) => {
    setResponding(true);
    try {
      await onRespond(answer);
    } catch (error) {
      console.error('Failed to respond:', error);
      alert('応答の送信に失敗しました。もう一度お試しください。');
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4 shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚠️</span>
            <span className="font-bold text-yellow-800">Claudeからの確認</span>
          </div>
          <span className="text-xs text-yellow-600">{timestamp}</span>
        </div>

        {/* Question */}
        <div className="mb-4">
          <p className="text-base text-gray-800 leading-relaxed">
            {prompt.question}
          </p>
        </div>

        {/* Actions */}
        {isPending ? (
          <div className="space-y-3">
            {/* Yes/No buttons for yes_no prompts */}
            {prompt.type === 'yes_no' && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleRespond('yes')}
                  disabled={responding}
                  className={`
                    px-6 py-2 rounded-lg font-medium transition-all
                    bg-blue-600 text-white hover:bg-blue-700
                    disabled:opacity-50 disabled:cursor-not-allowed
                    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                  `}
                >
                  Yes
                </button>
                <button
                  onClick={() => handleRespond('no')}
                  disabled={responding}
                  className={`
                    px-6 py-2 rounded-lg font-medium transition-all
                    bg-white border-2 border-gray-300 hover:bg-gray-50
                    disabled:opacity-50 disabled:cursor-not-allowed
                    focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2
                  `}
                >
                  No
                </button>
                {responding && (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" />
                    <span>送信中...</span>
                  </div>
                )}
              </div>
            )}

            {/* Choice buttons for multiple_choice prompts */}
            {prompt.type === 'multiple_choice' && (
              <div className="space-y-2">
                {prompt.options.map((option) => (
                  <button
                    key={option.number}
                    onClick={() => handleRespond(option.number.toString())}
                    disabled={responding}
                    className={`
                      w-full text-left px-4 py-3 rounded-lg font-medium transition-all
                      ${option.isDefault
                        ? 'bg-blue-600 text-white hover:bg-blue-700 border-2 border-blue-600'
                        : 'bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-900'
                      }
                      disabled:opacity-50 disabled:cursor-not-allowed
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                    `}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`font-bold ${option.isDefault ? 'text-white' : 'text-blue-600'}`}>
                        {option.number}.
                      </span>
                      <span className="flex-1">{option.label}</span>
                      {option.isDefault && (
                        <span className="text-blue-100 text-sm">❯ デフォルト</span>
                      )}
                    </div>
                  </button>
                ))}
                {responding && (
                  <div className="flex items-center gap-2 text-sm text-gray-500 pt-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600" />
                    <span>送信中...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white border border-gray-300 rounded-lg px-4 py-2 inline-block">
            <span className="text-sm text-gray-600">
              ✅ 回答済み: <strong className="text-gray-900">{prompt.answer}</strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
