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
 * - The screen's five rules (design §2.4, the table "画面の入口ごとの規則"), on every entrance
 *   (add, edit, close, the close of a recorded decision):
 *   (1) it keeps the version and every field as read (when the edit or the close was opened);
 *   (2) it sends only the fields the person changed (an emptied evidence is sent as `[]`);
 *   (3) it sends the version read; a conflict lays the values side by side and goes back to
 *       an explicit confirmation — a read again never replaces the version of an open draft;
 *   (4) when the result is unknown (timeout, a lost connection) it keeps the request as one
 *       unit that does not change — the operation, its worktree and instance, the item, the key,
 *       every field sent and the version read — one unit per operation, and the next press sends
 *       that unit as it is (never rebuilt from the selection or the draft). (a) When the selection
 *       moved off the unit's worktree or instance, it cannot be sent: the person goes back to it or
 *       drops it. (b) Another operation's answer never drops it. (c) Only the store's own answer
 *       for the same key says it landed (an add's replay); a 409 to a resent edit or close is a
 *       conflict, shown side by side, never taken for "saved" by comparing fields;
 *   (5) the buttons are read off the transition table (`memScreenActions`).
 * - Read again on focus and every 30 seconds; a row whose version moved is marked.
 * - The notices no session took, each with "take it".
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { RepositoryMemSettings } from '@/components/mem/RepositoryMemSettings';
import {
  memItemsApi,
  type MemItemsResult,
  type MemScreenAddInput,
  type MemScreenCloseInput,
  type MemScreenUpdateInput,
  type MemScreenWorktree,
} from '@/lib/mem/screen-client';
import { memScreenActions } from '@/lib/mem/transitions';
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

/**
 * The kinds whose close condition must be given (A's `CLOSE_WHEN_DEFAULTS` is null for
 * them). Kept here because `close-when.ts` pulls node's `fs`; a unit test holds the two equal.
 */
export const CLOSE_WHEN_REQUIRED_KINDS: ReadonlySet<MemKind> = new Set<MemKind>(['waiting', 'next', 'external']);

/** An item as it was read when the person opened its edit or its close (rule (1)). */
export interface MemReadSnapshot {
  version: number;
  text: string;
  evidence: string[];
  closeWhenType: string | null;
}

export interface EditDraft {
  itemId: string;
  /** What was read when the edit was opened: kept for the changed fields and the side-by-side view. */
  read: MemReadSnapshot;
  /** The version sent as `ifVersion`: the one read, or the current one the person chose after a conflict. */
  ifVersion: number;
  text: string;
  /** Empty: the condition stays as it is (a condition is replaced, never emptied here). */
  closeWhen: string;
  evidence: string;
}

interface Conflict {
  draft: EditDraft;
  current: MemItemView;
}

interface Closing {
  itemId: string;
  /** The item as read when "close" was opened: its version is sent, its state picks the steps. */
  read: MemItemView;
  step: 1 | 2;
  reason: string;
}

interface CloseConflict {
  read: MemItemView;
  current: MemItemView;
  reason: string;
}

/**
 * A request whose result is unknown (status 0): one unit that does not change, sent again as
 * it is on the next press (rule (4)). Its destination is part of it: `worktreeId` here and the
 * instance in `input.instanceId`; the item, the key, every field and the version are in `input`.
 */
export type Pending =
  | { op: 'add'; worktreeId: string; input: MemScreenAddInput }
  | { op: 'update'; worktreeId: string; itemId: string; input: MemScreenUpdateInput }
  | { op: 'close'; worktreeId: string; itemId: string; input: MemScreenCloseInput };

/** One unit per operation: the add, and each item's edit and close (rule (4)(b)). */
export const pendingSlot = (op: Pending['op'], itemId?: string): string => (op === 'add' ? 'add' : `${op}:${itemId}`);

const slotOf = (request: Pending): string => pendingSlot(request.op, request.op === 'add' ? undefined : request.itemId);

/** Whether the unit can be sent with the current selection (rule (4)(a)). */
export const pendingSendable = (request: Pending, worktreeId: string, instanceId: string): boolean =>
  request.worktreeId === worktreeId && request.input.instanceId === instanceId;

/** One key per request (A §5.4): `[A-Za-z0-9._:-]{1,128}`. A resend of an unknown result keeps it. */
function newKey(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `screen-${Date.now().toString(36)}-${random}`;
}

export const splitEvidence = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export function readSnapshot(item: MemItemView): MemReadSnapshot {
  return { version: item.version, text: item.text ?? '', evidence: [...(item.evidence ?? [])], closeWhenType: item.closeWhen?.type ?? null };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((entry, i) => entry === b[i]);

/**
 * The fields of an edit the person changed against what was read (rule (2)): an
 * unchanged field is not sent, so a value someone else wrote meanwhile is kept; an
 * emptied evidence is `[]` (the store keeps an omitted one and clears an empty one).
 */
export function editChanges(draft: EditDraft): Pick<MemScreenUpdateInput, 'text' | 'closeWhen' | 'evidence'> {
  const changes: Pick<MemScreenUpdateInput, 'text' | 'closeWhen' | 'evidence'> = {};
  if (draft.text !== draft.read.text) changes.text = draft.text;
  const evidence = splitEvidence(draft.evidence);
  if (!sameList(evidence, draft.read.evidence)) changes.evidence = evidence;
  if (draft.closeWhen.trim()) changes.closeWhen = draft.closeWhen.trim();
  return changes;
}

const isUnknown = (result: MemItemsResult<unknown>) => !result.ok && result.status === 0;

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
  const [closing, setClosing] = useState<Closing | null>(null);
  const [closeConflict, setCloseConflict] = useState<CloseConflict | null>(null);
  const [pendings, setPendings] = useState<Readonly<Record<string, Pending>>>({});
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
  const pendingAdd = pendings[pendingSlot('add')] ?? null;
  const addPending = pendingAdd !== null;
  const sendable = (request: Pending | null) => request === null || pendingSendable(request, worktreeId, instanceId);
  const dropPending = useCallback((slot: string) => {
    setPendings((current) => {
      if (!(slot in current)) return current;
      const next = { ...current };
      delete next[slot];
      return next;
    });
  }, []);
  const closeWhenRequired = CLOSE_WHEN_REQUIRED_KINDS.has(adding.kind);

  const refusalText = useCallback(
    (result: Extract<MemItemsResult<unknown>, { ok: false }>) => {
      const code = result.code ?? '';
      if (code === 'invalid_close_when') {
        // Say what is wanted (P3-4): a kind that needs a condition, or how to write one.
        if (result.reason === 'required') return t('mem.items.refusal.invalid_close_when_required');
        if (result.reason === 'kind_forbids_type') return t('mem.items.refusal.invalid_close_when_kind');
        if (result.reason) return t('mem.items.refusal.invalid_close_when_reason', { reason: result.reason });
      }
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

  /**
   * Rule (4): a result that is unknown keeps the request (its unit) for the next press; an
   * answer ends that unit only — never another operation's (rule (4)(b)).
   */
  const settle = useCallback(
    (result: MemItemsResult<unknown>, request: Pending): boolean => {
      const slot = slotOf(request);
      if (isUnknown(result)) {
        setPendings((current) => ({ ...current, [slot]: request }));
        setNotice({ tone: 'alert', text: t(request.op === 'add' ? 'mem.items.unknown' : 'mem.items.unknownVersioned') });
        return true;
      }
      dropPending(slot);
      return false;
    },
    [dropPending, t]
  );

  const add = useCallback(async () => {
    if (!canWrite || !worktree) return;
    const unit = pendingAdd?.op === 'add' ? pendingAdd : null;
    // Rule (4)(a): the unit goes to its own worktree and instance, or not at all.
    if (unit && !pendingSendable(unit, worktree.id, instanceId)) return;
    const again = unit?.input ?? null;
    if (!again && adding.text.trim().length === 0) return;
    const target = unit?.worktreeId ?? worktree.id;
    // The same content and key when the last result was unknown (the store answers the same item).
    const input: MemScreenAddInput = again ?? {
      instanceId,
      kind: adding.kind,
      text: adding.text,
      ...(adding.closeWhen.trim() ? { closeWhen: adding.closeWhen.trim() } : {}),
      ...(adding.evidence.trim() ? { evidence: splitEvidence(adding.evidence) } : {}),
      ...(adding.kind === 'decision' && adding.promoteTo.trim() ? { promoteTo: adding.promoteTo.trim() } : {}),
      key: newKey(),
      expectBranch: branch,
    };
    setBusy(true);
    setNotice(null);
    try {
      const result = await memItemsApi.add(target, input);
      if (settle(result, { op: 'add', worktreeId: target, input })) return;
      if (await finish(result, t('mem.items.added'))) setAdding((current) => ({ ...current, text: '', closeWhen: '', evidence: '', promoteTo: '' }));
    } finally {
      setBusy(false);
    }
  }, [adding, branch, canWrite, finish, instanceId, pendingAdd, settle, t, worktree]);

  const save = useCallback(
    async (draft: EditDraft) => {
      if (!worktree) return;
      const unit = pendings[pendingSlot('update', draft.itemId)];
      const again = unit?.op === 'update' ? unit : null;
      if (again && !pendingSendable(again, worktree.id, instanceId)) return;
      const target = again?.worktreeId ?? worktree.id;
      const input: MemScreenUpdateInput = again?.input ?? { instanceId, ifVersion: draft.ifVersion, ...editChanges(draft) };
      setBusy(true);
      setNotice(null);
      try {
        const result = await memItemsApi.update(target, draft.itemId, input);
        if (settle(result, { op: 'update', worktreeId: target, itemId: draft.itemId, input })) return;
        if (!result.ok && result.code === 'version_conflict' && result.item) {
          // A conflict, also to a resend whose first try may have landed (rule (4)(c)): an edit has
          // no key the store could answer for, so the screen does not guess from the fields.
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
    [finish, instanceId, load, pendings, settle, t, worktree]
  );

  const close = useCallback(
    async (target: Closing, confirmUnreflected: boolean) => {
      if (!worktree) return;
      const unit = pendings[pendingSlot('close', target.itemId)];
      const again = unit?.op === 'close' ? unit : null;
      if (again && !pendingSendable(again, worktree.id, instanceId)) return;
      const destination = again?.worktreeId ?? worktree.id;
      // The version read when "close" was opened (rule (3)), not the one of the last read.
      const input: MemScreenCloseInput = again?.input ?? {
        instanceId,
        ifVersion: target.read.version,
        ...(target.reason.trim() ? { reason: target.reason.trim() } : {}),
        ...(confirmUnreflected ? { confirmUnreflected: true } : {}),
      };
      setBusy(true);
      setNotice(null);
      try {
        const result = await memItemsApi.close(destination, target.itemId, input);
        if (settle(result, { op: 'close', worktreeId: destination, itemId: target.itemId, input })) return;
        if (!result.ok && result.code === 'version_conflict' && result.item) {
          // A conflict, also to a resend whose first try may have closed it (rule (4)(c)): a close
          // has no key the store could answer for. Back to the comparison and an explicit
          // confirmation of the current one (a closed one offers no "close again").
          setCloseConflict({ read: target.read, current: result.item, reason: target.reason });
          setClosing(null);
          setNotice({ tone: 'alert', text: t('mem.items.refusal.version_conflict') });
          await load();
          return;
        }
        if (await finish(result, t('mem.items.closed'))) {
          setClosing(null);
          setCloseConflict(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [finish, instanceId, load, pendings, settle, t, worktree]
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
    setCloseConflict(null);
    const read = readSnapshot(item);
    // Opening this item's edit again is the person dropping its unknown edit; nothing else is dropped.
    dropPending(pendingSlot('update', item.id));
    setEdit({ itemId: item.id, read, ifVersion: read.version, text: read.text, closeWhen: '', evidence: read.evidence.join(', ') });
  };

  const startClose = (item: MemItemView) => {
    setEdit(null);
    setConflict(null);
    setCloseConflict(null);
    dropPending(pendingSlot('close', item.id));
    setClosing({ itemId: item.id, read: item, step: 1, reason: '' });
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
    // Rule (5): the buttons are what the transition table lets this state do.
    const actions = memScreenActions(item.kind, item.state);
    const writable = canWrite && actions.edit;
    const closable = canWrite && actions.close !== null;
    const editingThis = edit?.itemId === item.id;
    const closingThis = closing?.itemId === item.id;
    const conflictThis = conflict?.current.id === item.id;
    const closeConflictThis = closeConflict?.current.id === item.id;
    const pendingEdit = pendings[pendingSlot('update', item.id)] ?? null;
    const pendingClose = pendings[pendingSlot('close', item.id)] ?? null;
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
        <p className="break-words text-xs text-muted-foreground">
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
              onClick={() => startClose(item)}
            >
              {actions.close?.withdraw ? t('mem.items.withdraw') : t('mem.items.close')}
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
              disabled={pendingEdit !== null}
              data-testid={`mem-item-edit-text-${item.id}`}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
            />
            <input
              type="text"
              aria-label={t('mem.items.closeWhenInput')}
              placeholder={edit.read.closeWhenType ? t('mem.items.closeWhenKeep', { type: edit.read.closeWhenType }) : t('mem.items.closeWhenInput')}
              className={`${INPUT_CLASS} w-full`}
              value={edit.closeWhen}
              disabled={pendingEdit !== null}
              data-testid={`mem-item-edit-close-when-${item.id}`}
              onChange={(e) => setEdit({ ...edit, closeWhen: e.target.value })}
            />
            <input
              type="text"
              aria-label={t('mem.items.evidence')}
              placeholder={t('mem.items.evidence')}
              className={`${INPUT_CLASS} w-full`}
              value={edit.evidence}
              disabled={pendingEdit !== null}
              data-testid={`mem-item-edit-evidence-${item.id}`}
              onChange={(e) => setEdit({ ...edit, evidence: e.target.value })}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" data-testid={`mem-item-save-${item.id}`} disabled={busy || !sendable(pendingEdit)} onClick={() => void save(edit)}>
                {pendingEdit ? t('mem.items.resend') : t('mem.items.save')}
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
              {(
                [
                  ['draft', t('mem.items.conflict.draft'), conflict.draft.text, splitEvidence(conflict.draft.evidence)],
                  ['read', t('mem.items.conflict.read', { version: conflict.draft.read.version }), conflict.draft.read.text, conflict.draft.read.evidence],
                  [
                    'current',
                    t('mem.items.conflict.current', { version: conflict.current.version }),
                    conflict.current.withheld ? t('mem.items.withheldShort') : (conflict.current.text ?? ''),
                    conflict.current.withheld ? [] : (conflict.current.evidence ?? []),
                  ],
                ] as const
              ).map(([which, label, text, evidence]) => (
                <div key={which} className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{label}</p>
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground" data-testid={`mem-conflict-${which}`}>
                    {text}
                  </p>
                  <p className="break-words text-xs text-muted-foreground" data-testid={`mem-conflict-evidence-${which}`}>
                    {t('mem.items.conflict.evidence', { evidence: evidence.length > 0 ? evidence.join(', ') : '—' })}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" data-testid={`mem-conflict-sends-${item.id}`}>
              {t('mem.items.conflict.sends', {
                fields:
                  Object.keys(editChanges(conflict.draft))
                    .map((field) => t(`mem.items.conflict.field.${field}`))
                    .join(', ') || '—',
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              {memScreenActions(conflict.current.kind, conflict.current.state).edit && (
                <Button
                  size="sm"
                  data-testid={`mem-item-rebase-${item.id}`}
                  disabled={busy}
                  onClick={() => void save({ ...conflict.draft, ifVersion: conflict.current.version })}
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
        {closeConflictThis && closeConflict && (
          <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid={`mem-item-close-conflict-${item.id}`}>
            <p className="text-xs text-foreground">{t('mem.items.closeConflict.title')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">{t('mem.items.conflict.read', { version: closeConflict.read.version })}</p>
                <p className="whitespace-pre-wrap break-words text-xs text-foreground" data-testid="mem-close-conflict-read">
                  {`${t(`mem.items.state.${closeConflict.read.state}`)} · ${closeConflict.read.withheld ? t('mem.items.withheldShort') : (closeConflict.read.text ?? '')}`}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">{t('mem.items.conflict.current', { version: closeConflict.current.version })}</p>
                <p className="whitespace-pre-wrap break-words text-xs text-foreground" data-testid="mem-close-conflict-current">
                  {`${t(`mem.items.state.${closeConflict.current.state}`)} · ${closeConflict.current.withheld ? t('mem.items.withheldShort') : (closeConflict.current.text ?? '')}`}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {memScreenActions(closeConflict.current.kind, closeConflict.current.state).close !== null && (
                <Button
                  size="sm"
                  data-testid={`mem-item-close-again-${item.id}`}
                  disabled={busy}
                  onClick={() => {
                    // The person saw the current one: its version is the one read now, and the steps start again.
                    setClosing({ itemId: item.id, read: closeConflict.current, step: 1, reason: closeConflict.reason });
                    setCloseConflict(null);
                  }}
                >
                  {t('mem.items.closeConflict.again')}
                </Button>
              )}
              <Button size="sm" variant="ghost" data-testid={`mem-item-close-conflict-discard-${item.id}`} onClick={() => setCloseConflict(null)}>
                {t('mem.items.cancel')}
              </Button>
            </div>
          </div>
        )}
        {closingThis && closing && (() => {
          // The steps follow the item as read when "close" was opened, not the last read.
          const readActions = memScreenActions(closing.read.kind, closing.read.state);
          const twoStep = readActions.close?.transition === 'withdraw-recorded';
          const confirmLabel = twoStep
            ? t('mem.items.recordedClose.confirm')
            : readActions.close?.withdraw
              ? t('mem.items.withdraw')
              : t('mem.items.close');
          return (
            <div className="space-y-1" data-testid={`mem-item-closer-${item.id}`}>
              {twoStep && closing.step === 1 ? (
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
                  {twoStep && <p className="text-xs text-warning-foreground">{t('mem.items.recordedClose.second')}</p>}
                  <input
                    type="text"
                    aria-label={t('mem.items.reason')}
                    placeholder={t('mem.items.reason')}
                    className={`${INPUT_CLASS} w-full`}
                    value={closing.reason}
                    disabled={pendingClose !== null}
                    data-testid={`mem-item-close-reason-${item.id}`}
                    onChange={(e) => setClosing({ ...closing, reason: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      data-testid={`mem-item-close-confirm-${item.id}`}
                      disabled={busy || !sendable(pendingClose)}
                      onClick={() => void close(closing, twoStep)}
                    >
                      {pendingClose ? t('mem.items.resend') : confirmLabel}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                      {t('mem.items.cancel')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </li>
    );
  };

  return (
    <div className="space-y-4" data-testid="mem-items-panel">
      <section className="space-y-1">
        <p className="break-words text-sm text-foreground" data-testid="mem-items-mode">
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
        <label className="flex min-w-0 max-w-full items-center gap-1 text-xs text-foreground">
          <span className="shrink-0">{t('mem.items.worktree')}</span>
          <select
            className={`${INPUT_CLASS} min-w-0 max-w-full truncate`}
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
          <label className="flex min-w-0 max-w-full items-center gap-1 text-xs text-foreground">
            <span className="shrink-0">{t('mem.items.instance')}</span>
            <select className={`${INPUT_CLASS} min-w-0 max-w-full truncate`} value={instanceId} data-testid="mem-items-instance" onChange={(e) => setInstanceId(e.target.value)}>
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

      {Object.entries(pendings)
        .filter(([, request]) => !pendingSendable(request, worktreeId, instanceId))
        .map(([slot, request]) => {
          const destination = worktrees.find((entry) => entry.id === request.worktreeId);
          return (
            <div key={slot} className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid={`mem-items-pending-elsewhere-${slot}`}>
              <p className="break-words text-xs text-foreground">
                {t('mem.items.pendingElsewhere', {
                  op: t(`mem.items.pendingOp.${request.op}`),
                  worktree: destination?.name ?? request.worktreeId,
                  instance: request.input.instanceId,
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid={`mem-items-pending-return-${slot}`}
                  disabled={busy}
                  onClick={() => {
                    setWorktreeId(request.worktreeId);
                    setInstanceId(request.input.instanceId);
                  }}
                >
                  {t('mem.items.pendingReturn')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`mem-items-pending-drop-${slot}`}
                  disabled={busy}
                  onClick={() => {
                    dropPending(slot);
                    void load();
                  }}
                >
                  {t('mem.items.pendingDiscard')}
                </Button>
              </div>
            </div>
          );
        })}
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
          {addPending && (
            <p className="text-xs text-warning-foreground" data-testid="mem-items-add-pending">
              {t('mem.items.addPending')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <select
              aria-label={t('mem.items.kind')}
              className={INPUT_CLASS}
              value={adding.kind}
              disabled={addPending}
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
            disabled={addPending}
            data-testid="mem-items-add-text"
            onChange={(e) => setAdding({ ...adding, text: e.target.value })}
          />
          <input
            type="text"
            aria-label={closeWhenRequired ? t('mem.items.closeWhenRequired') : t('mem.items.closeWhenInput')}
            placeholder={closeWhenRequired ? t('mem.items.closeWhenRequired') : t('mem.items.closeWhenInput')}
            aria-required={closeWhenRequired}
            className={`${INPUT_CLASS} w-full`}
            value={adding.closeWhen}
            disabled={addPending}
            data-testid="mem-items-add-close-when"
            onChange={(e) => setAdding({ ...adding, closeWhen: e.target.value })}
          />
          {closeWhenRequired && (
            <p className="text-xs text-muted-foreground" data-testid="mem-items-add-close-when-required">
              {t('mem.items.closeWhenRequiredHelp', { kind: t(`mem.items.kinds.${adding.kind}`) })}
            </p>
          )}
          <input
            type="text"
            aria-label={t('mem.items.evidence')}
            placeholder={t('mem.items.evidence')}
            className={`${INPUT_CLASS} w-full`}
            value={adding.evidence}
            disabled={addPending}
            data-testid="mem-items-add-evidence"
            onChange={(e) => setAdding({ ...adding, evidence: e.target.value })}
          />
          {adding.kind === 'decision' && (
            <input
              type="text"
              aria-label={t('mem.items.promoteTo')}
              placeholder={t('mem.items.promoteTo')}
              className={`${INPUT_CLASS} w-full`}
              value={adding.promoteTo}
              disabled={addPending}
              onChange={(e) => setAdding({ ...adding, promoteTo: e.target.value })}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="mem-items-add-submit"
              disabled={busy || !sendable(pendingAdd) || (!addPending && adding.text.trim().length === 0)}
              onClick={() => void add()}
            >
              {addPending ? t('mem.items.resend') : t('mem.items.add')}
            </Button>
            {addPending && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="mem-items-add-pending-discard"
                disabled={busy}
                onClick={() => {
                  dropPending(pendingSlot('add'));
                  void load();
                }}
              >
                {t('mem.items.pendingDiscard')}
              </Button>
            )}
          </div>
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
