/**
 * SkillNotice (Issue #1232)
 *
 * Always-visible explanatory box used for the statements the Catalog UI is not
 * allowed to hide: that a permission is a declaration, that a risk level is the
 * publisher's claim, that a field is simply not in the Catalog. Rendered inline
 * rather than behind a disclosure so導入前に確認できる (UX-09).
 *
 * @module components/skills/SkillNotice
 */

import React from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export type SkillNoticeTone = 'info' | 'warning' | 'danger' | 'neutral';

const TONE_CLASS: Record<SkillNoticeTone, string> = {
  info: 'bg-info-subtle border-info-border text-info-foreground',
  warning: 'bg-warning-subtle border-warning-border text-warning-foreground',
  danger: 'bg-danger-subtle border-danger-border text-danger-foreground',
  neutral: 'bg-muted border-border text-muted-foreground',
};

const TONE_ICON: Record<SkillNoticeTone, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  danger: ShieldAlert,
  neutral: Info,
};

export interface SkillNoticeProps {
  tone?: SkillNoticeTone;
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function SkillNotice({
  tone = 'neutral',
  children,
  className,
  'data-testid': testId,
}: SkillNoticeProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed',
        TONE_CLASS[tone],
        className
      )}
    >
      <Icon size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default SkillNotice;
