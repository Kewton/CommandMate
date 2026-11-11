/**
 * G-3: before the first send after a session boundary, the person chooses how much of the
 * hand-off the agent reads (Issue #4227 G-PR3, design `docs/design/mem-ui-4227.md` §3).
 *
 * Three lines of preview (open items, questions waiting for a person, the last update) and
 * three choices: the short brief (the default), the whole brief, or none this time. Closing
 * sends nothing and leaves the draft where it is (the composer owns the draft; this only
 * answers a choice). Shown only when the branch is attended (`popup`), mode `on` / `derived`,
 * `injectOnStart`, and a boundary is pending — the server's preview decides (`show`).
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import type { StartPreviewLines } from '@/lib/handoff/preview';

/** What the person chose (design §3.2's table). */
export type StartBriefChoice = 'short' | 'full' | 'decline';

export interface SessionStartBriefDialogProps {
  isOpen: boolean;
  /** null: the lines could not be read (the choice is still asked). */
  preview: StartPreviewLines | null;
  /** Shown above the choices, e.g. after the boundary changed and the person is asked again. */
  notice?: string | null;
  /** Disable the choices while the chosen send is in flight. */
  busy?: boolean;
  onChoose: (choice: StartBriefChoice) => void;
  /** Esc, ×, the backdrop: nothing is sent, the draft stays. */
  onClose: () => void;
}

function QuestionsLine({ questions }: { questions: StartPreviewLines['humanQuestions'] }) {
  const t = useTranslations('common');
  const unknown = questions.unknownSources.length > 0 ? questions.unknownSources.join(', ') : null;
  if (questions.count === 0 && !unknown) return <>{t('mem.startBrief.questionsNone')}</>;
  if (unknown) return <>{t('mem.startBrief.questionsUnknown', { count: questions.count, sources: unknown })}</>;
  return <>{t('mem.startBrief.questions', { count: questions.count })}</>;
}

export function SessionStartBriefDialog({ isOpen, preview, notice, busy = false, onChoose, onClose }: SessionStartBriefDialogProps) {
  const t = useTranslations('common');
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('mem.startBrief.title')} size="md">
      <div className="space-y-3 text-sm" data-testid="session-start-brief-dialog">
        {notice ? (
          <p role="status" className="rounded border border-warning-border bg-warning-subtle px-2 py-1 text-foreground" data-testid="session-start-brief-notice">
            {notice}
          </p>
        ) : null}
        {preview ? (
          <ul className="space-y-1" data-testid="session-start-brief-preview">
            <li data-testid="session-start-brief-open">
              {t('mem.startBrief.open', { count: preview.open.count, unreflected: preview.open.unreflected })}
            </li>
            <li data-testid="session-start-brief-questions">
              <QuestionsLine questions={preview.humanQuestions} />
            </li>
            <li data-testid="session-start-brief-updated">
              {preview.lastUpdatedAt
                ? t('mem.startBrief.updated', { at: new Date(preview.lastUpdatedAt).toLocaleString() })
                : t('mem.startBrief.updatedNone')}
            </li>
          </ul>
        ) : (
          <p data-testid="session-start-brief-preview-failed">{t('mem.startBrief.previewFailed')}</p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button size="sm" autoFocus disabled={busy} onClick={() => onChoose('short')} data-testid="session-start-brief-short">
            {t('mem.startBrief.short')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChoose('full')} data-testid="session-start-brief-full">
            {t('mem.startBrief.full')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChoose('decline')} data-testid="session-start-brief-decline">
            {t('mem.startBrief.decline')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('mem.startBrief.declineNote')}</p>
      </div>
    </Modal>
  );
}
