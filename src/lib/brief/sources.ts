/**
 * The sources of the brief, S1〜S9 (Issue #4223, design §1).
 *
 * Each one reads its own canonical store every time (D2: nothing is copied) and
 * changes nothing it reads: no state detection, no capture, no observation of a wait,
 * no auto-yes expiry rewrite, no relay delivery (§1.4). The only modules imported are
 * leaves that do not reach tmux, the relay service or the WebSocket server (I9):
 * the relay ledger is read from `lib/db/relay-db`, not `lib/relay/relay-service`.
 *
 * A reader answers its rows, or throws; `build.ts` turns a throw or a timeout into
 * one "could not be read" row of that source and keeps the others.
 *
 * @module lib/brief/sources
 */

import type Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { buildCompositeKey, peekAutoYesState } from '@/lib/auto-yes-state';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { getMessages } from '@/lib/db/chat-db';
import { listMem, type MemScope } from '@/lib/db/mem-db';
import { getSessionRelaySummary } from '@/lib/db/relay-db';
import { getCurrentBoundary } from '@/lib/db/session-brief-db';
import { getActiveTaskForInstance, listTasks, type Task } from '@/lib/db/tasks-db';
import { listVerificationRuns } from '@/lib/db/verification-db';
import { listMemNoticesFor, type MemNoticeRecipient } from '@/lib/mem/notices';
import { presentMemItem } from '@/lib/mem/present';
import type { MemTargetResolved } from '@/lib/mem/target';
import { isAutoYesBlockedByPolicy } from '@/lib/polling/auto-yes-policy';
import { getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { peekLastKnownStatus } from '@/lib/session/status-evidence';
import { getWaitingEpisode } from '@/lib/session/waiting-episode-state-store';
import { pickLatestReply, replyCandidates, REPLY_LOOKBACK_MESSAGES, TRANSCRIPT_READER_TOOLS } from '@/cli/utils/reply-ledger';
import type { PromptMessageResponse } from '@/cli/types/api-responses';
import type { SessionRelay } from '@/lib/relay/types';
import type {
  BriefEntry,
  BriefFieldValue,
  BriefRank,
  BriefSourceId,
  BriefSourceStatus,
  BriefUnavailableReason,
} from '@/types/brief';
import { BRIEF_SOURCE_IDS } from '@/types/brief';
import type { MemConditionView, MemItemView } from '@/types/mem';
import type { BriefItem } from './model';
import { sanitizeBriefField } from './sanitize';

/** What a reader is given (built once per brief by `build.ts`). */
export interface BriefSourceContext {
  db: Database.Database;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  /** The worktree's roster (DB only). */
  roster: AgentInstance[];
  target: MemTargetResolved;
  /** Epoch ms of the brief. */
  now: number;
  /** `commandmate brief … --all`: where a left-out body is read. */
  readAll: string;
  /** #4222's evaluation of this brief, by item id (`on` only). */
  conditions: ReadonlyMap<string, MemConditionView>;
  /** The notice recipient captured for this brief (`on` only). */
  recipient: MemNoticeRecipient | null;
}

export interface BriefSourceAnswer {
  status: Exclude<BriefSourceStatus, 'skipped'>;
  reason?: BriefUnavailableReason;
  items: BriefItem[];
}

export type BriefSourceReader = (ctx: BriefSourceContext) => BriefSourceAnswer | Promise<BriefSourceAnswer>;

/** S1〜S9 → 1〜9 (the second key of the order, design §2.4). */
export const BRIEF_SOURCE_INDEX: Readonly<Record<BriefSourceId, number>> = Object.fromEntries(
  BRIEF_SOURCE_IDS.map((id, index) => [id, index + 1])
) as Record<BriefSourceId, number>;

/** Where a source's "could not be read" row goes: the rank its first entry would take (design §2.3). */
export const BRIEF_STATUS_ROW_RANK: Readonly<Record<BriefSourceId, BriefRank>> = {
  state: 1,
  'auto-yes': 6,
  relay: 1,
  task: 6,
  verify: 6,
  run: 6,
  mem: 2,
  notice: 9,
  transcript: 10,
};

/** The sources a `derived` brief reads (design §1.2・§4): not the hand-written items or their notices. */
export const BRIEF_DERIVED_SOURCES: ReadonlySet<BriefSourceId> = new Set<BriefSourceId>([
  'state',
  'auto-yes',
  'relay',
  'task',
  'verify',
  'run',
  'transcript',
]);

const iso = (epoch: number): string => new Date(epoch).toISOString();

function compact(fields: Record<string, BriefFieldValue | undefined>): Record<string, BriefFieldValue> {
  const out: Record<string, BriefFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) out[key] = value;
  return out;
}

/** One "could not be read" / "not supported" row of a source (design §1.3). */
export function statusRowItem(
  source: BriefSourceId,
  status: 'unavailable' | 'unsupported',
  reason: BriefUnavailableReason,
  observedAt: string,
  extra: Record<string, BriefFieldValue> = {}
): BriefItem {
  return {
    sourceIndex: BRIEF_SOURCE_INDEX[source],
    sortAt: null,
    entry: {
      rank: BRIEF_STATUS_ROW_RANK[source],
      source,
      id: typeof extra.instance === 'string' ? extra.instance : source,
      author: { type: 'server' },
      updatedAt: null,
      observedAt,
      fields: { ...extra, [status]: reason },
    },
  };
}

function serverItem(
  source: BriefSourceId,
  rank: BriefRank,
  id: string,
  ctx: BriefSourceContext,
  fields: Record<string, BriefFieldValue | undefined>,
  options: { updatedAt?: number | null; sortAt?: number | null; text?: { value: string; field: string } } = {}
): BriefItem {
  const entry: BriefEntry = {
    rank,
    source,
    id,
    author: { type: 'server' },
    updatedAt: options.updatedAt === undefined || options.updatedAt === null ? null : iso(options.updatedAt),
    observedAt: iso(ctx.now),
    fields: compact(fields),
  };
  if (options.text) applyText(entry, options.text.value, options.text.field, ctx.readAll);
  return { entry, sourceIndex: BRIEF_SOURCE_INDEX[source], sortAt: options.sortAt ?? null };
}

/** Put a free-text value on an entry through the exit check (design §3.3). */
export function applyText(entry: BriefEntry, value: string, field: string, readAll: string): void {
  const checked = sanitizeBriefField(value, field);
  if (checked.kind === 'ok') entry.text = checked.value;
  else if (checked.kind === 'withheld') entry.withheld = checked.withheld;
  else entry.omittedBody = { bytes: checked.bytes, read: readAll };
}

/** A structured value from a record: kept when the exit check passes it unchanged, else withheld. */
function recordedWord(entry: BriefEntry, field: string, value: string): void {
  const checked = sanitizeBriefField(value, field);
  if (checked.kind === 'ok' && checked.value === value && /^[A-Za-z0-9._:-]{1,64}$/.test(value)) {
    entry.fields[field] = value;
  } else if (checked.kind === 'withheld') {
    entry.withheld = checked.withheld;
  } else {
    entry.withheld = { code: 'control_char', field };
  }
}

// ---------------------------------------------------------------------------
// S1 worktree・instance state: the values the ordinary monitoring left (no detection)
// ---------------------------------------------------------------------------

export const readStateSource: BriefSourceReader = (ctx) => {
  let observed = false;
  const items = ctx.roster.map((instance) => {
    const key = buildCompositeKey(ctx.worktreeId, instance.cliTool, instance.id);
    const latch = peekLastKnownStatus(key, ctx.now);
    const waiting = getWaitingEpisode(ctx.worktreeId, instance.cliTool, instance.id);
    if (latch || waiting) observed = true;
    const own = instance.id === ctx.instanceId;
    const rank: BriefRank = waiting ? 1 : own ? 6 : 10;
    return serverItem('state', rank, instance.id, ctx, {
      instance: instance.id,
      tool: instance.cliTool,
      status: latch?.status ?? null,
      observed: latch ? iso(latch.at) : 'none',
      waiting: waiting ? iso(waiting.since) : null,
      waitKind: waiting?.kind ?? null,
    });
  });
  return { status: observed ? 'ok' : 'unobserved', items };
};

// ---------------------------------------------------------------------------
// S2 auto-yes, per instance (never the aggregate fields of the auto-yes route)
// ---------------------------------------------------------------------------

/** Whether a task is this instance's (design §1.6): the tool, and `instanceId ?? cliToolId`. */
export function isTaskOfInstance(task: Task, cliToolId: string, instanceId: string): boolean {
  return task.cliToolId === cliToolId && (task.instanceId ?? task.cliToolId) === instanceId;
}

export const readAutoYesSource: BriefSourceReader = (ctx) => {
  const items: BriefItem[] = [];
  for (const instance of ctx.roster) {
    const own = instance.id === ctx.instanceId;
    const state = peekAutoYesState(ctx.worktreeId, instance.cliTool, instance.id);
    if (!own && !state) continue;
    const task = getActiveTaskForInstance(ctx.db, ctx.worktreeId, instance.cliTool, instance.id);
    // The contract's verdict, judged from the task this brief read (the poller's own
    // lookup writes its cache, so it is not called here).
    const blocked = task && isTaskOfInstance(task, instance.cliTool, instance.id) ? isAutoYesBlockedByPolicy(task.contract.autoYes) : false;
    const suppression = getLastPolicySuppression(ctx.worktreeId, instance.cliTool, instance.id);
    const ranOut = state !== null && state.enabled && ctx.now >= state.expiresAt;
    const enabled = state !== null && state.enabled && !ranOut;
    items.push(
      serverItem('auto-yes', own ? 6 : 10, instance.id, ctx, {
        instance: instance.id,
        enabled,
        expires: state && state.expiresAt > 0 ? iso(state.expiresAt) : null,
        mode: enabled ? (state?.answerMode ?? 'recommended') : null,
        stop: ranOut ? 'expired' : (state?.stopReason ?? null),
        suppressed: suppression?.reason ?? null,
        contract: blocked ? 'blocked' : null,
      })
    );
  }
  return { status: 'ok', items };
};

// ---------------------------------------------------------------------------
// S3 relays at this instance's ends (the ledger's SELECT, nothing delivered)
// ---------------------------------------------------------------------------

function relayItem(ctx: BriefSourceContext, relay: SessionRelay, dir: 'owed' | 'awaiting'): BriefItem {
  const peer = dir === 'owed' ? relay.from : relay.to;
  const held = relay.deliveryHold !== null || relay.pendingKind !== null;
  const rank: BriefRank = relay.state === 'prompt' ? 1 : held ? 3 : 10;
  return serverItem(
    'relay',
    rank,
    relay.id,
    ctx,
    {
      dir,
      peer: `${peer.worktreeId}/${peer.instanceId}`,
      state: relay.state,
      pending: relay.pendingKind,
      hold: relay.deliveryHold?.state ?? null,
      holdReason: relay.holdReason,
      expires: iso(relay.expiresAt),
    },
    { updatedAt: relay.updatedAt, sortAt: relay.updatedAt }
  );
}

export const readRelaySource: BriefSourceReader = (ctx) => {
  const summary = getSessionRelaySummary(ctx.db, { worktreeId: ctx.worktreeId, instanceId: ctx.instanceId });
  return {
    status: 'ok',
    items: [...summary.owed.map((relay) => relayItem(ctx, relay, 'owed')), ...summary.awaiting.map((relay) => relayItem(ctx, relay, 'awaiting'))],
  };
};

// ---------------------------------------------------------------------------
// S4 execution contracts, attributed to the instance (design §1.6)
// ---------------------------------------------------------------------------

export const readTaskSource: BriefSourceReader = (ctx) => {
  const recent = listTasks(ctx.db, ctx.worktreeId, 50);
  const items: BriefItem[] = [];
  for (const instance of ctx.roster) {
    const own = instance.id === ctx.instanceId;
    const active = getActiveTaskForInstance(ctx.db, ctx.worktreeId, instance.cliTool, instance.id);
    const task =
      active && isTaskOfInstance(active, instance.cliTool, instance.id)
        ? active
        : (recent.find((candidate) => isTaskOfInstance(candidate, instance.cliTool, instance.id)) ?? null);
    if (!task) continue;
    const updated = task.updatedAt.getTime();
    items.push(
      serverItem(
        'task',
        own ? 6 : 10,
        task.id,
        ctx,
        { instance: instance.id, status: task.status, lastVerify: task.lastVerificationRunId },
        { updatedAt: updated, sortAt: updated, text: { value: task.title, field: 'title' } }
      )
    );
  }
  return { status: 'ok', items };
};

// ---------------------------------------------------------------------------
// S5 verification runs: the instance's own, and the worktree's (instanceId null)
// ---------------------------------------------------------------------------

export const readVerifySource: BriefSourceReader = (ctx) => {
  const runs = listVerificationRuns(ctx.db, ctx.worktreeId, 50);
  const items: BriefItem[] = [];
  const pick = [
    { run: runs.find((run) => run.instanceId === ctx.instanceId), rank: 6 as BriefRank, scope: 'instance' },
    { run: runs.find((run) => run.instanceId === null), rank: 10 as BriefRank, scope: 'worktree' },
  ];
  for (const { run, rank, scope } of pick) {
    if (!run) continue;
    const started = run.startedAt.getTime();
    items.push(
      serverItem(
        'verify',
        rank,
        String(run.id),
        ctx,
        {
          scope,
          ...(scope === 'instance' ? { instance: ctx.instanceId } : {}),
          status: run.status,
          started: iso(started),
          finished: run.finishedAt ? run.finishedAt.toISOString() : null,
        },
        { updatedAt: run.finishedAt?.getTime() ?? started, sortAt: started }
      )
    );
  }
  return { status: 'ok', items };
};

// ---------------------------------------------------------------------------
// S6 the orchestrate run record (`scripts/orchestrate/run-log.mjs`'s JSONL)
// ---------------------------------------------------------------------------

export const RUN_LOG_MAX_BYTES = 1024 * 1024;
export const RUN_LOG_MAX_AGE_DAYS = 31;
const RUNS_DIR = path.join('workspace', 'orchestration', 'runs');

/** The Issue of a branch named by CLAUDE.md's rule, or null (design §1.5). */
export function issueOfBranch(branch: string | null): number | null {
  if (branch === null) return null;
  const match = /^(feature|fix|hotfix|docs)\/(\d+)-/.exec(branch);
  return match ? Number(match[2]) : null;
}

/** Whether `run-<issues>.jsonl`'s `<issues>` (`3477`, `3477-3481`, `3477,3480`) names the Issue. */
export function runFileNamesIssue(fileName: string, issue: number): boolean {
  const match = /^run-(\d+(?:[-,]\d+)*)\.jsonl$/.exec(fileName);
  if (!match) return false;
  return match[1].split(',').some((part) => {
    const [from, to] = part.split('-').map(Number);
    return to === undefined ? from === issue : from <= issue && issue <= to;
  });
}

interface RunRecord {
  issue: number;
  stage: string;
  result: string;
  at: string;
}

function readRunRecord(line: string): RunRecord | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return null;
    const { issue, stage, result, at } = value;
    if (typeof issue !== 'number' || typeof stage !== 'string' || typeof result !== 'string' || typeof at !== 'string') return null;
    if (Number.isNaN(Date.parse(at))) return null;
    return { issue, stage, result, at };
  } catch {
    return null;
  }
}

export const readRunSource: BriefSourceReader = (ctx) => {
  const issue = issueOfBranch(ctx.target.detached ? null : ctx.target.branch);
  if (issue === null) return { status: 'absent', items: [] };
  const roots = ctx.target.members.map((member) => path.join(member.path, RUNS_DIR)).filter((dir) => existsSync(dir));
  if (roots.length === 0) return { status: 'absent', items: [] };
  const oldest = ctx.now - RUN_LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let files = 0;
  let readable = 0;
  let tooLarge = false;
  let latest: { record: RunRecord; date: string; issues: string } | null = null;
  for (const root of roots) {
    for (const date of readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse()) {
      const day = Date.parse(`${date}T00:00:00Z`);
      if (Number.isNaN(day) || day + 24 * 60 * 60 * 1000 < oldest) continue;
      const dir = path.join(root, date);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir).filter((file) => runFileNamesIssue(file, issue)).sort()) {
        files += 1;
        const file = path.join(dir, name);
        if (statSync(file).size > RUN_LOG_MAX_BYTES) {
          tooLarge = true;
          continue;
        }
        for (const line of readFileSync(file, 'utf-8').split('\n')) {
          if (line.trim() === '') continue;
          const record = readRunRecord(line);
          if (!record) continue;
          readable += 1;
          if (record.issue !== issue) continue;
          if (!latest || Date.parse(record.at) >= Date.parse(latest.record.at)) {
            latest = { record, date, issues: name.slice('run-'.length, -'.jsonl'.length) };
          }
        }
      }
    }
  }
  if (files === 0) return { status: 'absent', items: [] };
  if (!latest) {
    if (readable === 0 && !tooLarge) return { status: 'unsupported', reason: 'format', items: [] };
    if (tooLarge) return { status: 'unsupported', reason: 'too_large', items: [] };
    return { status: 'absent', items: [] };
  }
  const at = Date.parse(latest.record.at);
  const item = serverItem(
    'run',
    6,
    `#${issue}`,
    ctx,
    {
      issue,
      at: iso(at),
      read: `node scripts/orchestrate/run-log.mjs status --run-dir ${RUNS_DIR}/${latest.date} --issues ${latest.issues}`,
    },
    { updatedAt: at, sortAt: at }
  );
  recordedWord(item.entry, 'stage', latest.record.stage);
  recordedWord(item.entry, 'result', latest.record.result);
  return { status: 'ok', items: [item] };
};

// ---------------------------------------------------------------------------
// S7 the hand-written items (#4221), after #4222's evaluation
// ---------------------------------------------------------------------------

function memRank(view: MemItemView, own: boolean): BriefRank {
  switch (view.kind) {
    case 'now':
      return own ? 2 : 7;
    case 'decision':
      return view.state === 'recorded' ? 4 : 10;
    case 'next':
      return 5;
    case 'waiting':
    case 'external':
      return 8;
    case 'note':
      return 10;
  }
}

function memItem(ctx: BriefSourceContext, view: MemItemView, slotOwn: boolean | null): BriefItem {
  const own = slotOwn ?? false;
  const condition = ctx.conditions.get(view.id);
  const entry: BriefEntry = {
    rank: memRank(view, own),
    source: 'mem',
    id: view.id,
    author: view.createdBy === 'human' ? { type: 'human' } : { type: 'agent', instanceId: view.owner.instanceId },
    updatedAt: view.updatedAt,
    observedAt: iso(ctx.now),
    fields: compact({
      kind: view.kind,
      state: view.state,
      instance: view.kind === 'now' && !own ? view.owner.instanceId : null,
      worktree: view.kind === 'now' && !own ? view.owner.worktreeId : null,
      cond: condition ? `${condition.result}:${condition.reason}` : null,
      unreflected: condition?.unreflected ? true : null,
      stale: view.stale ? true : null,
    }),
  };
  if (view.withheld) {
    entry.withheld = { code: 'secret_like', field: view.withheld.field, rule: view.withheld.rule };
  } else {
    applyText(entry, view.text ?? '', 'text', ctx.readAll);
    const refs = (view.evidence ?? []).map((ref) => sanitizeBriefField(ref, 'evidence'));
    if (refs.length > 0 && entry.withheld === undefined) {
      const bad = refs.find((ref) => ref.kind !== 'ok');
      if (bad && bad.kind === 'withheld') entry.withheld = bad.withheld;
      else if (!bad) entry.fields.refs = refs.map((ref) => (ref.kind === 'ok' ? ref.value : '')).join(' ');
    }
  }
  return { entry, sourceIndex: BRIEF_SOURCE_INDEX.mem, sortAt: Date.parse(view.updatedAt) };
}

export function memScopeOf(target: MemTargetResolved): MemScope {
  return {
    storageRepositoryId: target.storageRepositoryId,
    readRepositoryIds: target.readRepositoryIds,
    branch: target.detached ? null : target.branch,
    worktreeId: target.worktree?.id ?? null,
  };
}

export const readMemSource: BriefSourceReader = (ctx) => {
  const listed = listMem(ctx.db, memScopeOf(ctx.target));
  const items: BriefItem[] = [];
  const seen = new Set<string>();
  for (const slot of listed.now) {
    const view = presentMemItem(slot.record, { now: ctx.now });
    seen.add(view.id);
    items.push(memItem(ctx, view, slot.instanceId === ctx.instanceId && slot.worktreeId === ctx.worktreeId));
  }
  for (const record of listed.items) {
    if (seen.has(record.id) || record.kind === 'now') continue;
    items.push(memItem(ctx, presentMemItem(record, { now: ctx.now }), null));
  }
  return { status: 'ok', items };
};

// ---------------------------------------------------------------------------
// S8 the "it ended" notices (#4222), listed only (reserved by the provider's reserve)
// ---------------------------------------------------------------------------

export const readNoticeSource: BriefSourceReader = (ctx) => {
  if (!ctx.recipient) return { status: 'ok', items: [] };
  const notices = listMemNoticesFor(ctx.db, ctx.recipient, { now: () => ctx.now });
  return {
    status: 'ok',
    items: notices.map((notice) => {
      const closed = Date.parse(notice.closedAt);
      const entry: BriefEntry = {
        rank: 9,
        source: 'notice',
        id: notice.id,
        author:
          notice.audience === 'successor'
            ? { type: 'prev', instanceId: notice.origin.instanceId, createdAt: notice.origin.itemCreatedAt }
            : { type: 'agent', instanceId: notice.origin.instanceId },
        updatedAt: notice.closedAt,
        observedAt: iso(ctx.now),
        fields: compact({
          item: notice.itemId,
          end: notice.endReason,
          outcome: notice.outcome,
          audience: notice.audience,
          uncertain: notice.uncertain ? true : null,
        }),
      };
      return { entry, sourceIndex: BRIEF_SOURCE_INDEX.notice, sortAt: closed, notice: { id: notice.id, uncertain: notice.uncertain } };
    }),
  };
};

// ---------------------------------------------------------------------------
// S9 the conversation: a reference to the latest transcript turn, never its body
// ---------------------------------------------------------------------------

/** The latest transcript turn of an instance by `reply`'s rule, or why there is none. */
export function latestTurnOf(
  db: Database.Database,
  worktreeId: string,
  instance: Pick<AgentInstance, 'id' | 'cliTool'>
): { at: string } | { unavailable: 'no_transcript_reader' | 'no_turn_yet' } {
  if (!TRANSCRIPT_READER_TOOLS.has(instance.cliTool)) return { unavailable: 'no_transcript_reader' };
  const rows = getMessages(db, worktreeId, {
    instanceId: instance.id,
    cliToolId: instance.cliTool,
    matchResolvedInstance: true,
    limit: REPLY_LOOKBACK_MESSAGES,
  });
  // The DB answers newest first; `pickLatestReply` reads from the end, as the
  // messages route serves them (oldest first). Sorted the same way (2nd review ⑧).
  const messages: PromptMessageResponse[] = rows
    .map((row) => ({
      id: row.id,
      worktreeId: row.worktreeId,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp.toISOString(),
      messageType: row.messageType,
      archived: row.archived,
      ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
    }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const latest = pickLatestReply(replyCandidates(messages, 0), true);
  return latest ? { at: latest.at } : { unavailable: 'no_turn_yet' };
}

export const readTranscriptSource: BriefSourceReader = (ctx) => {
  let ownReason: BriefUnavailableReason | null = null;
  const items = ctx.roster.map((instance) => {
    const turn = latestTurnOf(ctx.db, ctx.worktreeId, instance);
    if ('unavailable' in turn) {
      if (instance.id === ctx.instanceId) ownReason = turn.unavailable;
      return statusRowItem('transcript', 'unavailable', turn.unavailable, iso(ctx.now), { instance: instance.id });
    }
    const boundary = getCurrentBoundary(ctx.db, ctx.worktreeId, instance.id);
    return serverItem('transcript', 10, instance.id, ctx, {
      instance: instance.id,
      boundary: boundary ? `${boundary.id}@${iso(boundary.openedAt)}` : null,
      last: turn.at,
      read: `commandmate reply ${ctx.worktreeId} --instance ${instance.id}`,
    });
  });
  return ownReason ? { status: 'unavailable', reason: ownReason, items } : { status: 'ok', items };
};

/** Every reader, by source. A new source is a new key here and a new row of the invariants' table. */
export const BRIEF_SOURCE_READERS: Readonly<Record<BriefSourceId, BriefSourceReader>> = {
  state: readStateSource,
  'auto-yes': readAutoYesSource,
  relay: readRelaySource,
  task: readTaskSource,
  verify: readVerifySource,
  run: readRunSource,
  mem: readMemSource,
  notice: readNoticeSource,
  transcript: readTranscriptSource,
};
