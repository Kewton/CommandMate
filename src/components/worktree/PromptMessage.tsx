/**
 * PromptMessage Component
 * Displays Claude prompts with interactive Yes/No buttons
 */

'use client';

import { useState } from 'react';
import { TriangleAlert, CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import type { ChatMessage } from '@/types/models';
import { format } from 'date-fns';
import { getDateFnsLocale } from '@/lib/date-locale';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import { Button } from '@/components/ui';

export interface PromptMessageProps {
  message: ChatMessage;
  worktreeId?: string;
  onRespond: (answer: string) => Promise<void>;
}

/**
 * Determine display content for instruction text.
 * Returns null if content should not be displayed (empty, or identical to question).
 *
 * Note [SF-S4-003]: The trim() + strict equality comparison may not handle
 * Unicode normalization differences (NFC/NFD) or residual control characters.
 * In such cases, content would be displayed (information not lost). YAGNI applies.
 *
 * @param content - message.content (may contain rawContent or cleanContent)
 * @param question - prompt.question text
 * @returns Display content string or null
 */
function getDisplayContent(content: string | undefined | null, question: string): string | null {
  // 1. Empty or undefined content -> do not display (fallback to question-only)
  if (!content?.trim()) return null;

  // 2. Content identical to question -> do not display to avoid duplication
  if (content.trim() === question.trim()) return null;

  // 3. Content contains question or is different -> display full content
  return content;
}

/**
 * Shared base classes for prompt action buttons.
 * Extracted to avoid duplicating disabled/focus styles across Yes/No/Choice buttons.
 */
const BUTTON_BASE_CLASSES = 'rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2';

/**
 * Sending indicator shown while a response is being submitted.
 * Extracted to eliminate duplication between yes_no and multiple_choice prompt types.
 *
 * @param className - Optional additional CSS classes
 */
function SendingIndicator({ className = '' }: { className?: string }) {
  const t = useTranslations('prompt');
  return (
    <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`.trim()}>
      <div className="animate-spin rounded-full h-4 w-4 border-2 border-input border-t-accent-600" />
      <span>{t('sending')}</span>
    </div>
  );
}

export function PromptMessage({ message, onRespond }: PromptMessageProps) {
  const t = useTranslations('prompt');
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const [responding, setResponding] = useState(false);
  const prompt = message.promptData!;
  const isPending = prompt.status === 'pending';
  const timestamp = format(new Date(message.timestamp), 'PPp', { locale: dateFnsLocale });
  // [SF-S3-003] Cache getDisplayContent result for DRY principle
  const displayContent = getDisplayContent(message.content, prompt.question);

  const handleRespond = async (answer: string) => {
    setResponding(true);
    try {
      await onRespond(answer);
    } catch (error) {
      console.error('Failed to respond:', error);
      window.alert(t('failedToRespond'));
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="bg-warning-subtle border-2 border-warning-border rounded-lg p-4 shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <TriangleAlert className="w-6 h-6 text-warning-foreground" aria-hidden="true" />
            <span className="font-bold text-warning-foreground">{t('confirmationFrom', { toolName: getCliToolDisplayNameSafe(message.cliToolId, 'Claude') })}</span>
          </div>
          <span className="text-xs text-warning-foreground/80">{timestamp}</span>
        </div>

        {/* Instruction text (Issue #235: rawContent display) [SF-S2-004] */}
        {displayContent && (
          <div className="text-sm text-foreground whitespace-pre-wrap mb-2">
            {displayContent}
          </div>
        )}

        {/* Question */}
        <div className="mb-4">
          <p className="text-base text-foreground leading-relaxed">
            {prompt.question}
          </p>
        </div>

        {/* Actions */}
        {isPending ? (
          <div className="space-y-3">
            {/* Yes/No buttons for yes_no prompts */}
            {prompt.type === 'yes_no' && (
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  onClick={() => handleRespond('yes')}
                  disabled={responding}
                  className={`px-6 py-2 ${BUTTON_BASE_CLASSES} bg-accent-600 text-white hover:bg-accent-700 focus:ring-ring`}
                >
                  {t('yes')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => handleRespond('no')}
                  disabled={responding}
                  className={`px-6 py-2 ${BUTTON_BASE_CLASSES} bg-surface border-2 border-input hover:bg-muted focus:ring-ring`}
                >
                  {t('no')}
                </Button>
                {responding && <SendingIndicator />}
              </div>
            )}

            {/* Choice buttons for multiple_choice prompts */}
            {prompt.type === 'multiple_choice' && (
              <div className="space-y-2">
                {prompt.options.map((option) => (
                  /* Issue #1061: full-width left-aligned choice row (w-full text-left) — base centering/hover-lift would break the row layout — 残置 */
                  <button
                    key={option.number}
                    onClick={() => handleRespond(option.number.toString())}
                    disabled={responding}
                    className={`
                      w-full text-left px-4 py-3 ${BUTTON_BASE_CLASSES}
                      ${option.isDefault
                        ? 'bg-accent-600 text-white hover:bg-accent-700 border-2 border-accent-600'
                        : 'bg-surface border-2 border-input hover:bg-muted text-foreground'
                      }
                      focus:ring-ring
                    `}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`font-bold ${option.isDefault ? 'text-white' : 'text-accent-600'}`}>
                        {option.number}.
                      </span>
                      <span className="flex-1">{option.label}</span>
                      {option.isDefault && (
                        <span className="text-accent-100 text-sm">❯ {t('default')}</span>
                      )}
                    </div>
                  </button>
                ))}
                {responding && <SendingIndicator className="pt-2" />}
              </div>
            )}
          </div>
        ) : (
          <div className="bg-surface border border-input rounded-lg px-4 py-2 inline-block">
            <span className="text-sm text-muted-foreground">
              <CircleCheck size={16} className="inline align-[-3px] mr-1 text-success" aria-hidden="true" />{t('answered')}: <strong className="text-foreground">{prompt.answer}</strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
