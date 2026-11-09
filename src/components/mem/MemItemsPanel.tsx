/**
 * The items of a branch, read and written by a person (Issue #4227, design
 * `mem-ui-4227.md` §2 G-1). PC and phone share it; only the arrangement wraps.
 *
 * - Top: the branch, its mode and what decided it. `derived` freezes the writes; `off`
 *   lists nothing (the items are kept). The mode is changed in A's settings, opened here.
 * - The list: each kind's section, the `now` of each instance by name, and per row the
 *   author, the version, the condition's answer, staleness and a decision's "unreflected".
 * - Writes (mode `on`, through a worktree of this branch and an instance of its roster):
 *   add, edit, close. A recorded decision closes only after a two-step confirmation that
 *   it is not reflected; recording and reflecting a decision is E's screen.
 * - A version conflict lays the draft, what was read and what is there now side by side;
 *   "save on top of the current" sends again only when the person presses it.
 * - Read again on focus and every 30 seconds; a row whose version moved is marked.
 * - The notices no session took, each with "take it".
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { RepositoryMemSettings } from '@/components/mem/RepositoryMemSettings';
import { memItemsApi, type MemItemsResult, type MemScreenWorktree } from '@/lib/mem/screen-client';
import type { MemItemView, MemKind, MemListResponse, MemModeResponse, MemNoticeView } from '@/types/mem';

/** How often the open list is read again (design §2.4). */
export const MEM_ITEMS_REFRESH_MS = 30000;

const INPUT_CLASS =
  'rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const ADDABLE_KINDS: ReadonlyArray<Exclude<MemKind, 'now'>> = ['waiting', 'decision', 'next', 'external', 'note'];
const SECTION_KINDS: ReadonlyArray<Exclude<MemKind, 'now'>> = ['waiting', 'decision', 'next', 'external', 'note'];

/** The refusals the screen names; anything else is shown with its code. */
const KNOWN_CODES = new Set([
  'disabled',
  'version_conflict',
  'state_forbids',
  'not_owner',
  'incarnation_changed',
  'membership_changed',
  'confirmation_required',
  'screen_only',
  'item_not_found',
  'instance_not_found',
  'duplicate_key',
  'limit_exceeded',
  'secret_like',
  'invalid_close_when',
]);

type Notice = { tone: 'status' | 'alert'; text: string } | null;

interface EditDraft {
  itemId: string;
  /** The version the person read: sent as `ifVersion`. */
  readVersion: number;
  /** What was read, kept for the side-by-side view of a conflict. */
  readText: string;
  text: string;
  closeWhen: string;
  evidence: string;
}

interface Conflict {
  draft: EditDraft;
  current: MemItemView;
}

/** One key per press (A §5.4): `[A-Za-z0-9._:-]{1,128}`. */
function newKey(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `screen-${Date.now().toString(36)}-${random}`;
}

const splitEvidence = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export interface MemItemsPanelProps {
  repositoryId: string;
  branch: string;
  /** The worktree the screen was opened from (`?worktree=`), if any. */
  worktreeId: string | null;
}

export function MemItemsPanel({ repositoryId, branch, worktreeId: initialWorktreeId }: MemItemsPanelProps): React.ReactElement {
  const t = useTranslations('common');
  const [mode, setMode] = useState<MemModeResponse | null>(null);
  const [list, setList] = useState<MemListResponse | null>(null);
  const [listRefusal, setListRefusal] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notices, setNotices] = useState<MemNoticeView[]>([]);
  const [worktrees, setWorktrees] = useState<MemScreenWorktree[]>([]);
  const [worktreeId, setWorktreeId] = useState<string>(initialWorktreeId ?? '');
  const [instanceId, setInstanceId] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [closing, setClosing] = useState<{ itemId: string; step: 1 | 2; reason: string } | null>(null);
  const [adding, setAdding] = useState({ kind: 'note' as Exclude<MemKind, 'now'>, text: '', closeWhen: '', evidence: '', promoteTo: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const requestRef = useRef(0);
  const versionsRef = useRef<Map<string, number>>(new Map());

  const loadWorktrees = useCallback(async () => {
    const result = await memItemsApi.worktrees();
    if (!result.ok) return;
    const repository = result.body.repositories.find((entry) => entry.id === repositoryId);
    const mine = repository ? result.body.worktrees.filter((entry) => entry.repositoryPath === repository.path) : [];
    setWorktrees(mine);
    setWorktreeId((current) => {
      if (current && mine.some((entry) => entry.id === current)) return current;
      return mine.find((entry) => entry.branch === branch)?.id ?? '';
    });
  }, [branch, repositoryId]);

  const load = useCallback(async () => {
    requestRef.current += 1;
    const request = requestRef.current;
    const [modeResult, listResult, noticesResult] = await Promise.all([
      memItemsApi.mode(repositoryId, branch),
      memItemsApi.list({ worktreeId: worktreeId || null, repositoryId }, branch, showAll),
      memItemsApi.notices(repositoryId, branch),
    ]);
    if (request !== requestRef.current) return;
    if (modeResult.ok) setMode(modeResult.body);
    if (noticesResult.ok) setNotices(noticesResult.body.notices);
    if (listResult.ok) {
      // A row whose version moved since the last read is marked (design §2.4, "stale diff").
      const seen = versionsRef.current;
      const moved = new Set<string>();
      for (const item of [...listResult.body.items, ...listResult.body.now.map((slot) => slot.item)]) {
        const before = seen.get(item.id);
        if (before !== undefined && before !== item.version) moved.add(item.id);
        seen.set(item.id, item.version);
      }
      if (moved.size > 0) setChanged((current) => new Set([...current, ...moved]));
      setList(listResult.body);
      setListRefusal(null);
      setLoadFailed(false);
    } else if (listResult.code) {
      setList(null);
      setListRefusal(listResult.code);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
  }, [branch, repositoryId, showAll, worktreeId]);

  useEffect(() => {
    void loadWorktrees();
  }, [loadWorktrees]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void load(), MEM_ITEMS_REFRESH_MS);
    return () => {
      requestRef.current += 1;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [load]);

  const worktree = useMemo(() => worktrees.find((entry) => entry.id === worktreeId) ?? null, [worktreeId, worktrees]);
  const roster = useMemo(() => worktree?.agentInstances ?? [], [worktree]);
  useEffect(() => {
    setInstanceId((current) => (roster.some((entry) => entry.id === current) ? current : (roster[0]?.id ?? '')));
  }, [roster]);

  const currentMode = list?.mode ?? mode?.mode ?? null;
  const worktreeOnBranch = worktree !== null && (worktree.branch === undefined || worktree.branch === branch);
  const canWrite = currentMode === 'on' && worktree !== null && worktreeOnBranch && instanceId.length > 0;

  const refusalText = useCallback(
    (result: Extract<MemItemsResult<unknown>, { ok: false }>) => {
      const code = result.code ?? '';
      if (KNOWN_CODES.has(code)) return t(`mem.items.refusal.${code}`);
      return t('mem.items.refusal.other', { code: code || String(result.status) });
    },
    [t]
  );

  const finish = useCallback(
    async (result: MemItemsResult<unknown>, success: string): Promise<boolean> => {
      if (result.ok) {
        setNotice({ tone: 'status', text: success });
        await load();
        return true;
      }
      setNotice({ tone: 'alert', text: refusalText(result) });
      await load();
      return false;
    },
    [load, refusalText]
  );

  const add = useCallback(async () => {
    if (!canWrite || !worktree || adding.text.trim().length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await memItemsApi.add(worktree.id, {
        instanceId,
        kind: adding.kind,
        text: adding.text,
        ...(adding.closeWhen.trim() ? { closeWhen: adding.closeWhen.trim() } : {}),
        ...(adding.evidence.trim() ? { evidence: splitEvidence(adding.evidence) } : {}),
        ...(adding.kind === 'decision' && adding.promoteTo.trim() ? { promoteTo: adding.promoteTo.trim() } : {}),
        key: newKey(),
        expectBranch: branch,
      });
      if (await finish(result, t('mem.items.added'))) setAdding((current) => ({ ...current, text: '', closeWhen: '', evidence: '', promoteTo: '' }));
    } finally {
      setBusy(false);
    }
  }, [adding, branch, canWrite, finish, instanceId, t, worktree]);

  const save = useCallback(
    async (draft: EditDraft) => {
      if (!worktree) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await memItemsApi.update(worktree.id, draft.itemId, {
          instanceId,
          ifVersion: draft.readVersion,
          text: draft.text,
          ...(draft.closeWhen.trim() ? { closeWhen: draft.closeWhen.trim() } : {}),
          ...(draft.evidence.trim() ? { evidence: splitEvidence(draft.evidence) } : {}),
        });
        if (!result.ok && result.code === 'version_conflict' && result.item) {
          // Never laid on top by itself: the person chooses (design §2.4).
          setConflict({ draft, current: result.item });
          setEdit(null);
          setNotice({ tone: 'alert', text: t('mem.items.refusal.version_conflict') });
          await load();
          return;
        }
        if (await finish(result, t('mem.items.saved'))) {
          setEdit(null);
          setConflict(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [finish, instanceId, load, t, worktree]
  );

  const close = useCallback(
    async (item: MemItemView, reason: string, confirmUnreflected: boolean) => {
      if (!worktree) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await memItemsApi.close(worktree.id, item.id, {
          instanceId,
          ifVersion: item.version,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(confirmUnreflected ? { confirmUnreflected: true } : {}),
        });
        if (await finish(result, t('mem.items.closed'))) setClosing(null);
      } finally {
        setBusy(false);
      }
    },
    [finish, instanceId, t, worktree]
  );

  const acknowledge = useCallback(
    async (entry: MemNoticeView) => {
      setBusy(true);
      try {
        await finish(await memItemsApi.acknowledgeNotice(repositoryId, entry.id, entry.version), t('mem.items.notices.taken'));
      } finally {
        setBusy(false);
      }
    },
    [finish, repositoryId, t]
  );

  const startEdit = (item: MemItemView) => {
    setConflict(null);
    setClosing(null);
    setEdit({
      itemId: item.id,
      readVersion: item.version,
      readText: item.text ?? '',
      text: item.text ?? '',
      closeWhen: '',
      evidence: (item.evidence ?? []).join(', '),
    });
  };

  const modeSource = mode?.source;
  const sourceText = modeSource
    ? modeSource.level === 'override'
      ? t('mem.items.source.override')
      : modeSource.level === 'rule'
        ? t('mem.items.source.rule', { pattern: modeSource.pattern ?? t('mem.rules.detached') })
        : t('mem.items.source.fallback')
    : '';

  const renderRow = (item: MemItemView, slotOf?: string) => {
    const condition = list?.conditions?.[item.id];
    const writable = canWrite && item.kind !== 'now' && item.state !== 'closed' && item.state !== 'promoted';
    const closable = canWrite && item.kind !== 'now' && item.state !== 'closed';
    const editingThis = edit?.itemId === item.id;
    const closingThis = closing?.itemId === item.id;
    const conflictThis = conflict?.current.id === item.id;
    return (
      <li key={item.id} className="space-y-1 rounded border border-border p-2" data-testid={`mem-item-${item.id}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">{slotOf ? t('mem.items.slot', { instance: slotOf }) : item.kind}</span>
          <span className="text-foreground">{t(`mem.items.state.${item.state}`)}</span>
          <span className="text-muted-foreground">v{item.version}</span>
          {item.stale && <span className="text-warning-foreground">{t('mem.items.stale')}</span>}
          {item.frozen && <span className="text-muted-foreground">{t('mem.items.frozen')}</span>}
          {changed.has(item.id) && (
            <span className="text-info-foreground" data-testid={`mem-item-changed-${item.id}`}>
              {t('mem.items.changed')}
            </span>
          )}
        </div>
        {item.withheld ? (
          <p className="text-xs text-muted-foreground">{t('mem.items.withheld', { field: item.withheld.field, rule: item.withheld.rule })}</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground" data-testid={`mem-item-text-${item.id}`}>
            {item.text}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('mem.items.meta', {
            createdBy: item.createdBy,
            instance: item.owner.instanceId,
            updatedBy: item.updatedBy,
            updatedAt: item.updatedAt,
          })}
          {item.closeWhen ? ` · ${t('mem.items.closeWhen', { type: item.closeWhen.type })}` : ''}
          {condition ? ` · {${condition.result}:${condition.reason}}` : ''}
        </p>
        {item.kind === 'decision' && item.state === 'recorded' && (
          <p className="text-xs text-warning-foreground" data-testid={`mem-item-unreflected-${item.id}`}>
            {t('mem.decisions.unreflected')}
          </p>
        )}
        {item.kind === 'now' && <p className="text-xs text-muted-foreground">{t('mem.items.nowNote')}</p>}
        <div className="flex flex-wrap gap-2">
          {item.kind === 'decision' && item.state !== 'closed' && (
            <Link
              href={`/repositories/${encodeURIComponent(repositoryId)}/mem/decisions?branch=${encodeURIComponent(branch)}`}
              className="text-xs text-foreground underline"
            >
              {t('mem.items.toDecisions')}
            </Link>
          )}
          {writable && !editingThis && (
            <Button size="sm" variant="ghost" data-testid={`mem-item-edit-${item.id}`} disabled={busy} onClick={() => startEdit(item)}>
              {t('mem.items.edit')}
            </Button>
          )}
          {closable && !closingThis && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`mem-item-close-${item.id}`}
              disabled={busy}
              onClick={() => {
                setEdit(null);
                setClosing({ itemId: item.id, step: 1, reason: '' });
              }}
            >
              {item.kind === 'decision' && item.state === 'open' ? t('mem.items.withdraw') : t('mem.items.close')}
            </Button>
          )}
        </div>
        {editingThis && edit && (
          <div className="space-y-1" data-testid={`mem-item-editor-${item.id}`}>
            <textarea
              aria-label={t('mem.items.text')}
              className={`${INPUT_CLASS} w-full`}
              rows={3}
              value={edit.text}
              data-testid={`mem-item-edit-text-${item.id}`}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            />
            <input
              type="text"
              aria-label={t('mem.items.closeWhenInput')}
              placeholder={t('mem.items.closeWhenInput')}
              className={`${INPUT_CLASS} w-full`}
              value={edit.closeWhen}
              onChange={(e) => setEdit({ ...edit, closeWhen: e.target.value })}
            />
            <input
              type="text"
              aria-label={t('mem.items.evidence')}
              placeholder={t('mem.items.evidence')}
              className={`${INPUT_CLASS} w-full`}
              value={edit.evidence}
              onChange={(e) => setEdit({ ...edit, evidence: e.target.value })}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" data-testid={`mem-item-save-${item.id}`} disabled={busy} onClick={() => void save(edit)}>
                {t('mem.items.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                {t('mem.items.cancel')}
              </Button>
            </div>
          </div>
        )}
        {conflictThis && conflict && (
          <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid={`mem-item-conflict-${item.id}`}>
            <p className="text-xs text-foreground">{t('mem.items.conflict.title')}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium text-foreground">{t('mem.items.conflict.draft')}</p>
                <p className="whitespace-pre-wrap break-words text-xs text-foreground" data-testid="mem-conflict-draft">
                  {conflict.draft.text}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-foreground">{t('mem.items.conflict.read', { version: conflict.draft.readVersion })}</p>
                <p className="whitespace-pre-wrap break-words text-xs text-foreground" data-testid="mem-conflict-read">
                  {conflict.draft.readText}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-foreground">{t('mem.items.conflict.current', { version: conflict.current.version })}</p>
                <p className="whitespace-pre-wrap break-words text-xs text-foreground" data-testid="mem-conflict-current">
                  {conflict.current.withheld ? t('mem.items.withheldShort') : (conflict.current.text ?? '')}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {conflict.current.state === 'open' && (
                <Button
                  size="sm"
                  data-testid={`mem-item-rebase-${item.id}`}
                  disabled={busy}
                  onClick={() => void save({ ...conflict.draft, readVersion: conflict.current.version, readText: conflict.current.text ?? '' })}
                >
                  {t('mem.items.conflict.rebase')}
                </Button>
              )}
              <Button size="sm" variant="ghost" data-testid={`mem-item-discard-${item.id}`} onClick={() => setConflict(null)}>
                {t('mem.items.conflict.discard')}
              </Button>
            </div>
          </div>
        )}
        {closingThis && closing && (
          <div className="space-y-1" data-testid={`mem-item-closer-${item.id}`}>
            {item.kind === 'decision' && item.state === 'recorded' ? (
              closing.step === 1 ? (
                <>
                  <p className="text-xs text-warning-foreground">{t('mem.items.recordedClose.first')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" data-testid={`mem-item-close-step1-${item.id}`} onClick={() => setClosing({ ...closing, step: 2 })}>
                      {t('mem.items.recordedClose.next')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                      {t('mem.items.cancel')}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-warning-foreground">{t('mem.items.recordedClose.second')}</p>
                  <input
                    type="text"
                    aria-label={t('mem.items.reason')}
                    placeholder={t('mem.items.reason')}
                    className={`${INPUT_CLASS} w-full`}
                    value={closing.reason}
                    onChange={(e) => setClosing({ ...closing, reason: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      data-testid={`mem-item-close-confirm-${item.id}`}
                      disabled={busy}
                      onClick={() => void close(item, closing.reason, true)}
                    >
                      {t('mem.items.recordedClose.confirm')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                      {t('mem.items.cancel')}
                    </Button>
                  </div>
                </>
              )
            ) : (
              <>
                <input
                  type="text"
                  aria-label={t('mem.items.reason')}
                  placeholder={t('mem.items.reason')}
                  className={`${INPUT_CLASS} w-full`}
                  value={closing.reason}
                  onChange={(e) => setClosing({ ...closing, reason: e.target.value })}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    data-testid={`mem-item-close-confirm-${item.id}`}
                    disabled={busy}
                    onClick={() => void close(item, closing.reason, false)}
                  >
                    {item.kind === 'decision' ? t('mem.items.withdraw') : t('mem.items.close')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                    {t('mem.items.cancel')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4" data-testid="mem-items-panel">
      <section className="space-y-1">
        <p className="text-sm text-foreground" data-testid="mem-items-mode">
          {mode ? t('mem.items.modeLine', { mode: t(`mem.mode.${mode.mode}`), source: sourceText }) : t('mem.loading')}
        </p>
        {currentMode === 'derived' && <p className="text-xs text-warning-foreground">{t('mem.items.derived')}</p>}
        {currentMode === 'off' && <p className="text-xs text-muted-foreground">{t('mem.items.off')}</p>}
        <Button size="sm" variant="ghost" data-testid="mem-items-settings-toggle" onClick={() => setShowSettings((value) => !value)}>
          {t('mem.items.changeMode')}
        </Button>
        {showSettings && <RepositoryMemSettings repositoryId={repositoryId} initialOverrideBranch={branch} onSaved={() => void load()} />}
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-foreground">
          {t('mem.items.worktree')}
          <select
            className={INPUT_CLASS}
            value={worktreeId}
            data-testid="mem-items-worktree"
            onChange={(e) => setWorktreeId(e.target.value)}
          >
            <option value="">{t('mem.items.noWorktree')}</option>
            {worktrees.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.branch ?? '-'})
              </option>
            ))}
          </select>
        </label>
        {roster.length > 0 && (
          <label className="flex items-center gap-1 text-xs text-foreground">
            {t('mem.items.instance')}
            <select className={INPUT_CLASS} value={instanceId} data-testid="mem-items-instance" onChange={(e) => setInstanceId(e.target.value)}>
              {roster.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.alias ?? entry.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1 text-xs text-foreground">
          <input type="checkbox" checked={showAll} data-testid="mem-items-all" onChange={(e) => setShowAll(e.target.checked)} />
          {t('mem.items.showClosed')}
        </label>
      </section>
      {currentMode === 'on' && !canWrite && (
        <p className="text-xs text-muted-foreground" data-testid="mem-items-readonly">
          {worktree && !worktreeOnBranch ? t('mem.items.otherBranch') : t('mem.items.readOnly')}
        </p>
      )}

      {notice && (
        <p
          role={notice.tone === 'status' ? 'status' : 'alert'}
          data-testid="mem-items-notice"
          className={`text-xs ${notice.tone === 'status' ? 'text-muted-foreground' : 'text-danger-foreground'}`}
        >
          {notice.text}
        </p>
      )}
      {loadFailed && (
        <p role="alert" className="text-xs text-danger-foreground">
          {t('mem.items.loadError')}
        </p>
      )}
      {listRefusal && listRefusal !== 'disabled' && (
        <p role="alert" className="text-xs text-danger-foreground">
          {t('mem.items.refusal.other', { code: listRefusal })}
        </p>
      )}

      {canWrite && (
        <section className="space-y-1 rounded border border-border p-2" data-testid="mem-items-add">
          <h3 className="text-xs font-medium text-foreground">{t('mem.items.addTitle')}</h3>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label={t('mem.items.kind')}
              className={INPUT_CLASS}
              value={adding.kind}
              data-testid="mem-items-add-kind"
              onChange={(e) => setAdding({ ...adding, kind: e.target.value as Exclude<MemKind, 'now'> })}
            >
              {ADDABLE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`mem.items.kinds.${kind}`)}
                </option>
              ))}
            </select>
          </div>
          <textarea
            aria-label={t('mem.items.text')}
            placeholder={t('mem.items.text')}
            className={`${INPUT_CLASS} w-full`}
            rows={2}
            value={adding.text}
            data-testid="mem-items-add-text"
            onChange={(e) => setAdding({ ...adding, text: e.target.value })}
          />
          <input
            type="text"
            aria-label={t('mem.items.closeWhenInput')}
            placeholder={t('mem.items.closeWhenInput')}
            className={`${INPUT_CLASS} w-full`}
            value={adding.closeWhen}
            onChange={(e) => setAdding({ ...adding, closeWhen: e.target.value })}
          />
          <input
            type="text"
            aria-label={t('mem.items.evidence')}
            placeholder={t('mem.items.evidence')}
            className={`${INPUT_CLASS} w-full`}
            value={adding.evidence}
            onChange={(e) => setAdding({ ...adding, evidence: e.target.value })}
          />
          {adding.kind === 'decision' && (
            <input
              type="text"
              aria-label={t('mem.items.promoteTo')}
              placeholder={t('mem.items.promoteTo')}
              className={`${INPUT_CLASS} w-full`}
              value={adding.promoteTo}
              onChange={(e) => setAdding({ ...adding, promoteTo: e.target.value })}
            />
          )}
          <Button size="sm" data-testid="mem-items-add-submit" disabled={busy || adding.text.trim().length === 0} onClick={() => void add()}>
            {t('mem.items.add')}
          </Button>
        </section>
      )}

      {list && (
        <div className="space-y-3" data-testid="mem-items-list">
          {list.now.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-xs font-medium text-foreground">{t('mem.items.kinds.now')}</h3>
              <ul className="space-y-1">{list.now.map((slot) => renderRow(slot.item, slot.instanceId))}</ul>
            </section>
          )}
          {SECTION_KINDS.map((kind) => {
            const items = list.items.filter((item) => item.kind === kind);
            if (items.length === 0) return null;
            return (
              <section key={kind} className="space-y-1" data-testid={`mem-items-section-${kind}`}>
                <h3 className="text-xs font-medium text-foreground">{t(`mem.items.kinds.${kind}`)}</h3>
                <ul className="space-y-1">{items.map((item) => renderRow(item))}</ul>
              </section>
            );
          })}
          {list.items.length === 0 && list.now.length === 0 && <p className="text-xs text-muted-foreground">{t('mem.items.none')}</p>}
        </div>
      )}

      <section className="space-y-1" data-testid="mem-items-notices">
        <h3 className="text-xs font-medium text-foreground">{t('mem.items.notices.title')}</h3>
        {notices.length === 0 && <p className="text-xs text-muted-foreground">{t('mem.items.notices.none')}</p>}
        <ul className="space-y-1">
          {notices.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2 text-xs text-foreground" data-testid={`mem-notice-${entry.id}`}>
              <span>{t('mem.items.notices.line', { item: entry.itemId, reason: entry.endReason, outcome: entry.outcome })}</span>
              {entry.uncertain && <span className="text-warning-foreground">{t('mem.items.notices.uncertain')}</span>}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void acknowledge(entry)}>
                {t('mem.items.notices.take')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
