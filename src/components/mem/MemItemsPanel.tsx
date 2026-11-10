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
 *       conflict, shown side by side, never taken for "saved" by comparing fields. The comparison,
 *       and the resend of a unit whose row is not listed, are on the units' side, apart from the
 *       list: a closed item leaves the default list, its comparison stays (Codex review-4227-pr1c P2).
 *       (d) A unit holds everything its resend and its view need (the values read and shown, the
 *       destination, the key, every field sent; the comparisons are kept per item) and never reads
 *       the one-at-a-time screen state (`edit`, `closing`, the add's draft): opening or saving
 *       another item's edit or close leaves the unit and its view (Codex review-4227-pr1d P2).
 *       (e) While a unit is being sent or its result is unknown, nothing else is written: every
 *       other write (add, edit, close, "save on top", "close again") cannot be pressed, the unit's
 *       fields are read-only and the reason is shown; only the unit's own resend or drop is left.
 *       Reading again and changing the selection stay (they only read). The combinations of a
 *       unit with another write are gone, not handled one by one (the PM's rule after Codex
 *       review-4227-pr1e P2, which also settles the PM review P3-3);
 *   (5) the buttons are read off the transition table (`memScreenActions`).
 * - Read again on focus and every 30 seconds; a row whose version moved is marked.
 * - The notices no session took, each with "take it".
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { RepositoryMemSettings } from '@/components/mem/RepositoryMemSettings';
import { memWriteLockOfOthers, useMemWriteLock } from '@/components/mem/mem-write-lock';
import {
  dropMemItemsUnit,
  handoffStoreSnapshot,
  handoffUnitsLock,
  memItemsUnitsAll,
  settleMemItemsWrite,
  startMemItemsWrite,
  subscribeHandoffStore,
  type SentMemItemsWrite,
} from '@/lib/handoff/close-rule';
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
/** This panel's name in the screens' shared write lock (`mem-write-lock.ts`). */
const MEM_ITEMS_LOCK_OWNER = 'mem-items';

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
  | { op: 'update'; worktreeId: string; itemId: string; input: MemScreenUpdateInput; draft: EditDraft }
  | { op: 'close'; worktreeId: string; itemId: string; input: MemScreenCloseInput; closing: Closing };

/**
 * A unit holds everything its resend and its view need (rule (4)(d)): an edit's draft (the
 * values read and shown) and a close's `Closing` (the item read, the reason), besides what is
 * sent. Its view never reads the one-at-a-time screen state (`edit`, `closing`), so opening
 * another item's edit or close does not hide it (Codex review-4227-pr1d P2).
 */
type PendingItemUnit = Exclude<Pending, { op: 'add' }>;

/** A record without one key (the same record when it has none). */
function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

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
  const [closing, setClosing] = useState<Closing | null>(null);
  // The comparisons, one per item (rule (4)(d)): another item's operation does not drop them.
  const [conflicts, setConflicts] = useState<Readonly<Record<string, Conflict>>>({});
  const [closeConflicts, setCloseConflicts] = useState<Readonly<Record<string, CloseConflict>>>({});
  /**
   * G-PR3 (design §4.1.1・§2.4.1 (4e), one rule for the whole screen): the units — the write being
   * sent and the writes whose result is unknown — are the hand-off's store's (keyed by the worktree
   * each was sent to), not this component's: they outlive a remount or a page left and come back
   * to, as the dialog's do, and both screens read one lock from them.
   */
  const store = useSyncExternalStore(subscribeHandoffStore, handoffStoreSnapshot, handoffStoreSnapshot);
  const storeUnits = useMemo(() => memItemsUnitsAll(store), [store]);
  const unitBySlot = useMemo<Readonly<Record<string, SentMemItemsWrite>>>(
    () => Object.fromEntries(storeUnits.unknown.map((unit) => [unit.slot, unit])),
    [storeUnits]
  );
  const pendings = useMemo<Readonly<Record<string, Pending>>>(
    () => Object.fromEntries(storeUnits.unknown.map((unit) => [unit.slot, unit.request as Pending])),
    [storeUnits]
  );
  const [adding, setAdding] = useState({ kind: 'note' as Exclude<MemKind, 'now'>, text: '', closeWhen: '', evidence: '', promoteTo: '' });
  const [busy, setBusy] = useState(false);
  /** The request being sent now (rule (4)(e)): its fields are read-only until it is answered. */
  const inflight = (storeUnits.sending?.request as Pending | undefined) ?? null;
  /** The sending this panel started and has not settled (its answer names it). */
  const sendingRef = useRef<SentMemItemsWrite | null>(null);
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
  /**
   * Rule (4)(e): while a unit is being sent or its result is unknown, no other write. `lock` says
   * why (shown to the person); `otherPending(slot)` is true when a unit other than `slot` waits, so
   * only that unit's own resend is left.
   */
  const ownLock: 'sending' | 'unknown' | null = inflight !== null ? 'sending' : Object.keys(pendings).length > 0 ? 'unknown' : null;
  /**
   * Issue #4227 G-PR2 (PM P3-3): the hand-off's approval writes items too, so its unit (being
   * sent, or unknown) locks this panel as this panel's own does, and the other way round.
   */
  // G-PR3: the hand-off's units are the store's too — they hold this panel even while no dialog is drawn.
  const otherLock = useMemWriteLock(MEM_ITEMS_LOCK_OWNER, ownLock) ?? handoffUnitsLock(store);
  const lock = ownLock ?? otherLock;
  const otherPending = (slot: string) => Object.keys(pendings).some((key) => key !== slot);
  /** The add's unit (unknown or being sent): the add's fields show it and are read-only. */
  const addUnit = pendingAdd?.op === 'add' ? pendingAdd : inflight?.op === 'add' ? inflight : null;
  const addShown = addUnit
    ? {
        kind: addUnit.input.kind as Exclude<MemKind, 'now'>,
        text: addUnit.input.text,
        closeWhen: addUnit.input.closeWhen ?? '',
        evidence: (addUnit.input.evidence ?? []).join(', '),
        promoteTo: addUnit.input.promoteTo ?? '',
      }
    : adding;
  const changeAdding = (next: Partial<typeof adding>) => {
    if (!addUnit) setAdding({ ...adding, ...next });
  };
  /** The person's "drop it without sending it again" (rule (4)(b)): that slot's unit only. */
  const dropPending = useCallback(
    (slot: string) => {
      const unit = unitBySlot[slot];
      if (unit) dropMemItemsUnit(unit);
    },
    [unitBySlot]
  );
  /** Ends this item's open edit or close only; another item's is left as it is. */
  const endEdit = useCallback((itemId: string) => setEdit((current) => (current?.itemId === itemId ? null : current)), []);
  const endClosing = useCallback((itemId: string) => setClosing((current) => (current?.itemId === itemId ? null : current)), []);
  const closeWhenRequired = CLOSE_WHEN_REQUIRED_KINDS.has(addShown.kind);

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
      const unknown = isUnknown(result);
      const sending = sendingRef.current;
      if (sending) {
        // G-PR3: the store keeps the unit (unknown) or clears its slot (answered).
        settleMemItemsWrite(sending, unknown ? 'unknown' : 'answered');
        sendingRef.current = null;
      }
      if (unknown) {
        setNotice({ tone: 'alert', text: t(request.op === 'add' ? 'mem.items.unknown' : 'mem.items.unknownVersioned') });
        return true;
      }
      return false;
    },
    [t]
  );

  /**
   * Sends one request as the one in flight (rule (4)(e)): one at a time, and none while a unit
   * other than its own waits. Returns null when it was not sent.
   */
  const sendOne = useCallback(
    async <R,>(request: Pending, run: () => Promise<R>): Promise<R | null> => {
      if (sendingRef.current) return null;
      if (Object.keys(pendings).some((key) => key !== slotOf(request))) return null;
      // Another screen's write of items is sent or unknown (rule (4)(e) across screens, PM P3-3).
      if (memWriteLockOfOthers(MEM_ITEMS_LOCK_OWNER) !== null) return null;
      // G-PR3: the store refuses too (another unit, a decide of the hand-off being sent or unknown).
      const sending = startMemItemsWrite({ worktreeId: request.worktreeId, slot: slotOf(request), request });
      if (!sending) return null;
      sendingRef.current = sending;
      setBusy(true);
      setNotice(null);
      try {
        return await run();
      } finally {
        // An answer that was not settled (a throw) ends the sending as answered: nothing is kept.
        if (sendingRef.current === sending) settleMemItemsWrite(sending, 'answered');
        sendingRef.current = null;
        setBusy(false);
      }
    },
    [pendings]
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
    const request: Pending = { op: 'add', worktreeId: target, input };
    await sendOne(request, async () => {
      const result = await memItemsApi.add(target, input);
      if (settle(result, request)) return;
      if (await finish(result, t('mem.items.added'))) setAdding((current) => ({ ...current, text: '', closeWhen: '', evidence: '', promoteTo: '' }));
    });
  }, [adding, branch, canWrite, finish, instanceId, pendingAdd, sendOne, settle, t, worktree]);

  const save = useCallback(
    async (draft: EditDraft) => {
      if (!worktree) return;
      const unit = pendings[pendingSlot('update', draft.itemId)];
      const again = unit?.op === 'update' ? unit : null;
      if (again && !pendingSendable(again, worktree.id, instanceId)) return;
      const target = again?.worktreeId ?? worktree.id;
      const input: MemScreenUpdateInput = again?.input ?? { instanceId, ifVersion: draft.ifVersion, ...editChanges(draft) };
      // The unit keeps the draft it was built from: its view does not read `edit` (rule (4)(d)).
      const shown = again?.draft ?? draft;
      const request: Pending = { op: 'update', worktreeId: target, itemId: draft.itemId, input, draft: shown };
      await sendOne(request, async () => {
        const result = await memItemsApi.update(target, draft.itemId, input);
        if (settle(result, request)) return;
        if (!result.ok && result.code === 'version_conflict' && result.item) {
          // A conflict, also to a resend whose first try may have landed (rule (4)(c)): an edit has
          // no key the store could answer for, so the screen does not guess from the fields.
          // Never laid on top by itself: the person chooses (design §2.4).
          const current = result.item;
          setConflicts((all) => ({ ...all, [draft.itemId]: { draft: shown, current } }));
          endEdit(draft.itemId);
          setNotice({ tone: 'alert', text: t('mem.items.refusal.version_conflict') });
          await load();
          return;
        }
        if (await finish(result, t('mem.items.saved'))) {
          endEdit(draft.itemId);
          setConflicts((all) => without(all, draft.itemId));
        }
      });
    },
    [endEdit, finish, instanceId, load, pendings, sendOne, settle, t, worktree]
  );

  const close = useCallback(
    async (target: Closing, confirmUnreflected: boolean) => {
      if (!worktree) return;
      const unit = pendings[pendingSlot('close', target.itemId)];
      const again = unit?.op === 'close' ? unit : null;
      if (again && !pendingSendable(again, worktree.id, instanceId)) return;
      const destination = again?.worktreeId ?? worktree.id;
      // The unit keeps the item read and the reason: its view does not read `closing` (rule (4)(d)).
      const shown = again?.closing ?? target;
      // The version read when "close" was opened (rule (3)), not the one of the last read.
      const input: MemScreenCloseInput = again?.input ?? {
        instanceId,
        ifVersion: target.read.version,
        ...(target.reason.trim() ? { reason: target.reason.trim() } : {}),
        ...(confirmUnreflected ? { confirmUnreflected: true } : {}),
      };
      const request: Pending = { op: 'close', worktreeId: destination, itemId: target.itemId, input, closing: shown };
      await sendOne(request, async () => {
        const result = await memItemsApi.close(destination, target.itemId, input);
        if (settle(result, request)) return;
        if (!result.ok && result.code === 'version_conflict' && result.item) {
          // A conflict, also to a resend whose first try may have closed it (rule (4)(c)): a close
          // has no key the store could answer for. Back to the comparison and an explicit
          // confirmation of the current one (a closed one offers no "close again").
          const current = result.item;
          setCloseConflicts((all) => ({ ...all, [target.itemId]: { read: shown.read, current, reason: shown.reason } }));
          endClosing(target.itemId);
          setNotice({ tone: 'alert', text: t('mem.items.refusal.version_conflict') });
          await load();
          return;
        }
        if (await finish(result, t('mem.items.closed'))) {
          endClosing(target.itemId);
          setCloseConflicts((all) => without(all, target.itemId));
        }
      });
    },
    [endClosing, finish, instanceId, load, pendings, sendOne, settle, t, worktree]
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

  // Opening an edit or a close replaces the one open draft, and drops this item's comparisons only:
  // another item's unit, its view and its comparison stay (rule (4)(d)).
  const startEdit = (item: MemItemView) => {
    setClosing(null);
    setConflicts((all) => without(all, item.id));
    setCloseConflicts((all) => without(all, item.id));
    const read = readSnapshot(item);
    // Opening this item's edit again is the person dropping its unknown edit; nothing else is dropped.
    dropPending(pendingSlot('update', item.id));
    setEdit({ itemId: item.id, read, ifVersion: read.version, text: read.text, closeWhen: '', evidence: read.evidence.join(', ') });
  };

  const startClose = (item: MemItemView) => {
    setEdit(null);
    setConflicts((all) => without(all, item.id));
    setCloseConflicts((all) => without(all, item.id));
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

  /**
   * The discard of a unit: the person drops its unknown request (and the open edit or close of the
   * same item), and the list is read again to see whether it was written.
   */
  const discardUnit = (unit: PendingItemUnit) => {
    dropPending(slotOf(unit));
    if (unit.op === 'update') endEdit(unit.itemId);
    else endClosing(unit.itemId);
    void load();
  };

  /**
   * The editor of one item (in its row, or on the units' side when its row is not listed). With a
   * unit it shows the unit's own draft and resends the unit; it never reads `edit` (rule (4)(d)).
   */
  const renderEditor = (itemId: string, draft: EditDraft, unit: Extract<Pending, { op: 'update' }> | null) => {
    const shown = unit?.draft ?? draft;
    // Rule (4)(e): the unit's fields, and those of the edit being sent, are read-only.
    const held = unit !== null || (inflight?.op === 'update' && inflight.itemId === itemId);
    const change = (next: Partial<EditDraft>) => {
      if (!held) setEdit({ ...shown, ...next });
    };
    return (
      <div className="space-y-1" data-testid={`mem-item-editor-${itemId}`}>
        <textarea
          aria-label={t('mem.items.text')}
          className={`${INPUT_CLASS} w-full`}
          rows={3}
          value={shown.text}
          disabled={held}
          data-testid={`mem-item-edit-text-${itemId}`}
          onChange={(e) => change({ text: e.target.value })}
        />
        <input
          type="text"
          aria-label={t('mem.items.closeWhenInput')}
          placeholder={shown.read.closeWhenType ? t('mem.items.closeWhenKeep', { type: shown.read.closeWhenType }) : t('mem.items.closeWhenInput')}
          className={`${INPUT_CLASS} w-full`}
          value={shown.closeWhen}
          disabled={held}
          data-testid={`mem-item-edit-close-when-${itemId}`}
          onChange={(e) => change({ closeWhen: e.target.value })}
        />
        <input
          type="text"
          aria-label={t('mem.items.evidence')}
          placeholder={t('mem.items.evidence')}
          className={`${INPUT_CLASS} w-full`}
          value={shown.evidence}
          disabled={held}
          data-testid={`mem-item-edit-evidence-${itemId}`}
          onChange={(e) => change({ evidence: e.target.value })}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            data-testid={`mem-item-save-${itemId}`}
            disabled={busy || (unit ? !sendable(unit) || otherPending(slotOf(unit)) : lock !== null || !canWrite)}
            onClick={() => void save(shown)}
          >
            {unit ? t('mem.items.resend') : t('mem.items.save')}
          </Button>
          {unit ? (
            <Button size="sm" variant="ghost" data-testid={`mem-item-unit-discard-${slotOf(unit)}`} disabled={busy} onClick={() => discardUnit(unit)}>
              {t('mem.items.pendingDiscard')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              {t('mem.items.cancel')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  /**
   * The close steps of one item (in its row, or on the units' side when its row is not listed).
   * With a unit it shows the unit's own item read and reason and resends the unit; it never reads
   * `closing` (rule (4)(d)). A unit was sent, so it is past the confirmation steps.
   */
  const renderCloser = (itemId: string, open: Closing, unit: Extract<Pending, { op: 'close' }> | null) => {
    const shown = unit?.closing ?? open;
    // Rule (4)(e): the unit's reason, and that of the close being sent, are read-only.
    const held = unit !== null || (inflight?.op === 'close' && inflight.itemId === itemId);
    // The steps follow the item as read when "close" was opened, not the last read.
    const readActions = memScreenActions(shown.read.kind, shown.read.state);
    const twoStep = readActions.close?.transition === 'withdraw-recorded';
    const confirmLabel = twoStep
      ? t('mem.items.recordedClose.confirm')
      : readActions.close?.withdraw
        ? t('mem.items.withdraw')
        : t('mem.items.close');
    return (
      <div className="space-y-1" data-testid={`mem-item-closer-${itemId}`}>
        {!unit && twoStep && shown.step === 1 ? (
          <>
            <p className="text-xs text-warning-foreground">{t('mem.items.recordedClose.first')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" data-testid={`mem-item-close-step1-${itemId}`} onClick={() => setClosing({ ...shown, step: 2 })}>
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
              value={shown.reason}
              disabled={held}
              data-testid={`mem-item-close-reason-${itemId}`}
              onChange={(e) => {
                if (!held) setClosing({ ...shown, reason: e.target.value });
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                data-testid={`mem-item-close-confirm-${itemId}`}
                disabled={busy || (unit ? !sendable(unit) || otherPending(slotOf(unit)) : lock !== null || !canWrite)}
                onClick={() => void close(shown, unit ? unit.input.confirmUnreflected === true : twoStep)}
              >
                {unit ? t('mem.items.resend') : confirmLabel}
              </Button>
              {unit ? (
                <Button size="sm" variant="ghost" data-testid={`mem-item-unit-discard-${slotOf(unit)}`} disabled={busy} onClick={() => discardUnit(unit)}>
                  {t('mem.items.pendingDiscard')}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                  {t('mem.items.cancel')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  /**
   * The comparison of an edit's conflict. Shown on the units' side, never inside a row: the
   * item may have left the default list (closed meanwhile) and the comparison must stay.
   */
  const renderConflict = (conflict: Conflict) => {
    const itemId = conflict.current.id;
    return (
      <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid={`mem-item-conflict-${itemId}`}>
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
        <p className="text-xs text-muted-foreground" data-testid={`mem-conflict-sends-${itemId}`}>
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
              data-testid={`mem-item-rebase-${itemId}`}
              disabled={busy || lock !== null || !canWrite}
              onClick={() => void save({ ...conflict.draft, ifVersion: conflict.current.version })}
            >
              {t('mem.items.conflict.rebase')}
            </Button>
          )}
          <Button size="sm" variant="ghost" data-testid={`mem-item-discard-${itemId}`} onClick={() => setConflicts((all) => without(all, itemId))}>
            {t('mem.items.conflict.discard')}
          </Button>
        </div>
      </div>
    );
  };

  /**
   * The comparison of a close's conflict (Codex review-4227-pr1c P2). A resend whose first try
   * closed the item answers 409 with a closed one; the read again right after lists it no more
   * (closed ones are hidden by default), so the comparison lives on the units' side, not in its row.
   */
  const renderCloseConflict = (closeConflict: CloseConflict) => {
    const itemId = closeConflict.current.id;
    return (
      <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid={`mem-item-close-conflict-${itemId}`}>
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
              data-testid={`mem-item-close-again-${itemId}`}
              disabled={busy || lock !== null || !canWrite}
              onClick={() => {
                // The person saw the current one: its version is the one read now, and the steps start again.
                setEdit(null);
                setClosing({ itemId, read: closeConflict.current, step: 1, reason: closeConflict.reason });
                setCloseConflicts((all) => without(all, itemId));
              }}
            >
              {t('mem.items.closeConflict.again')}
            </Button>
          )}
          <Button size="sm" variant="ghost" data-testid={`mem-item-close-conflict-discard-${itemId}`} onClick={() => setCloseConflicts((all) => without(all, itemId))}>
            {t('mem.items.cancel')}
          </Button>
        </div>
      </div>
    );
  };

  // The rows listed now. Every unit of an edit or a close whose row is not among them (it left the
  // default list) is shown on the units' side instead, so its resend stays reachable. Read off the
  // units alone, never off the one open `edit` or `closing` (rule (4)(d), Codex review-4227-pr1d P2).
  const listedIds = new Set<string>(list ? [...list.items.map((entry) => entry.id), ...list.now.map((slot) => slot.item.id)] : []);
  const itemUnit = <O extends PendingItemUnit['op']>(op: O, itemId: string) => {
    const unit = pendings[pendingSlot(op, itemId)];
    return unit?.op === op ? (unit as Extract<Pending, { op: O }>) : null;
  };
  const unlistedUnits = Object.values(pendings).filter(
    (unit): unit is PendingItemUnit => unit.op !== 'add' && !listedIds.has(unit.itemId)
  );
  const conflictList = Object.values(conflicts);
  const closeConflictList = Object.values(closeConflicts);

  const renderRow = (item: MemItemView, slotOf?: string) => {
    const condition = list?.conditions?.[item.id];
    // Rule (5): the buttons are what the transition table lets this state do.
    const actions = memScreenActions(item.kind, item.state);
    const writable = canWrite && actions.edit;
    const closable = canWrite && actions.close !== null;
    const editUnit = itemUnit('update', item.id);
    const closeUnit = itemUnit('close', item.id);
    const editingThis = edit?.itemId === item.id || editUnit !== null;
    const closingThis = closing?.itemId === item.id || closeUnit !== null;
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
            <Button size="sm" variant="ghost" data-testid={`mem-item-edit-${item.id}`} disabled={busy || lock !== null} onClick={() => startEdit(item)}>
              {t('mem.items.edit')}
            </Button>
          )}
          {closable && !closingThis && (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`mem-item-close-${item.id}`}
              disabled={busy || lock !== null}
              onClick={() => startClose(item)}
            >
              {actions.close?.withdraw ? t('mem.items.withdraw') : t('mem.items.close')}
            </Button>
          )}
        </div>
        {editUnit ? renderEditor(item.id, editUnit.draft, editUnit) : edit?.itemId === item.id && renderEditor(item.id, edit, null)}
        {closeUnit ? renderCloser(item.id, closeUnit.closing, closeUnit) : closing?.itemId === item.id && renderCloser(item.id, closing, null)}
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
      {lock && (
        <p role="status" className="text-xs text-warning-foreground" data-testid="mem-items-write-locked">
          {ownLock === null ? t('mem.items.lockedElsewhere') : lock === 'sending' ? t('mem.items.lockedSending') : t('mem.items.lockedUnknown')}
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

      {(conflictList.length > 0 || closeConflictList.length > 0 || unlistedUnits.length > 0) && (
        // The units' side (Codex review-4227-pr1c P2): a comparison, and an unknown request whose
        // row is not listed (closed meanwhile; closed ones are hidden by default), stay here,
        // apart from the list, so they can be read and confirmed without "show closed".
        <section className="space-y-2" data-testid="mem-items-units">
          {conflictList.map((entry) => (
            <React.Fragment key={`conflict:${entry.current.id}`}>{renderConflict(entry)}</React.Fragment>
          ))}
          {closeConflictList.map((entry) => (
            <React.Fragment key={`close-conflict:${entry.current.id}`}>{renderCloseConflict(entry)}</React.Fragment>
          ))}
          {unlistedUnits.map((unit) => (
            <React.Fragment key={slotOf(unit)}>
              {unit.op === 'update' ? renderEditor(unit.itemId, unit.draft, unit) : renderCloser(unit.itemId, unit.closing, unit)}
            </React.Fragment>
          ))}
        </section>
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
              value={addShown.kind}
              disabled={addUnit !== null}
              data-testid="mem-items-add-kind"
              onChange={(e) => changeAdding({ kind: e.target.value as Exclude<MemKind, 'now'> })}
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
            value={addShown.text}
            disabled={addUnit !== null}
            data-testid="mem-items-add-text"
            onChange={(e) => changeAdding({ text: e.target.value })}
          />
          <input
            type="text"
            aria-label={closeWhenRequired ? t('mem.items.closeWhenRequired') : t('mem.items.closeWhenInput')}
            placeholder={closeWhenRequired ? t('mem.items.closeWhenRequired') : t('mem.items.closeWhenInput')}
            aria-required={closeWhenRequired}
            className={`${INPUT_CLASS} w-full`}
            value={addShown.closeWhen}
            disabled={addUnit !== null}
            data-testid="mem-items-add-close-when"
            onChange={(e) => changeAdding({ closeWhen: e.target.value })}
          />
          {closeWhenRequired && (
            <p className="text-xs text-muted-foreground" data-testid="mem-items-add-close-when-required">
              {t('mem.items.closeWhenRequiredHelp', { kind: t(`mem.items.kinds.${addShown.kind}`) })}
            </p>
          )}
          <input
            type="text"
            aria-label={t('mem.items.evidence')}
            placeholder={t('mem.items.evidence')}
            className={`${INPUT_CLASS} w-full`}
            value={addShown.evidence}
            disabled={addUnit !== null}
            data-testid="mem-items-add-evidence"
            onChange={(e) => changeAdding({ evidence: e.target.value })}
          />
          {addShown.kind === 'decision' && (
            <input
              type="text"
              aria-label={t('mem.items.promoteTo')}
              placeholder={t('mem.items.promoteTo')}
              className={`${INPUT_CLASS} w-full`}
              value={addShown.promoteTo}
              disabled={addUnit !== null}
              onChange={(e) => changeAdding({ promoteTo: e.target.value })}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="mem-items-add-submit"
              disabled={busy || (addPending ? !sendable(pendingAdd) || otherPending(pendingSlot('add')) : lock !== null || adding.text.trim().length === 0)}
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
              {/* Outside the lock (PM P3-3): taking a notice writes no item. */}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void acknowledge(entry)} data-testid={`mem-notice-take-${entry.id}`}>
                {t('mem.items.notices.take')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
