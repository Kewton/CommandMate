/**
 * CopyButton Component
 *
 * Issue #981: Extracted from AssistantMessageList for reuse across the app
 * (assistant chat message bubbles + markdown file preview code blocks).
 *
 * Behavior is preserved verbatim from the original AssistantMessageList
 * implementation: copies `text` via `copyToClipboard`, shows a Check icon for
 * `COPY_FEEDBACK_RESET_SHORT_MS` (1.5s), then reverts to the Copy icon. The
 * timer is cleared on unmount and de-duplicated on rapid clicks.
 *
 * @module components/common/CopyButton
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { COPY_FEEDBACK_RESET_SHORT_MS } from '@/config/ui-feedback-config';

function IconCopy() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export interface CopyButtonProps {
  /** Text copied to the clipboard when the button is pressed */
  text: string;
  /** Extra classes appended to the button (e.g. absolute positioning) */
  className?: string;
  /** Accessible label / visible caption shown next to the icon */
  label?: string;
}

/**
 * Compact copy-to-clipboard button with transient "Copied" feedback.
 */
export function CopyButton({ text, className = '', label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleClick = useCallback(async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_SHORT_MS);
    } catch {
      // ignore - copyToClipboard handles fallback
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800 ${className}`}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied!' : label}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export default CopyButton;
