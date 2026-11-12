/**
 * G-3's preview: what the screen shows before the first send after a boundary (Issue #4227
 * G-PR3, design `docs/design/mem-ui-4227.md` §3.1・§3.1.1・§3.2).
 *
 * `GET /api/worktrees/:id/mem/start-preview?instance=` answers whether to ask
 * (`show`: attended (`popup`), mode `on` / `derived`, `injectOnStart`, a `pending` boundary)
 * and three lines: the open items, the questions waiting for a person, the last update.
 * A read: no boundary, notice or reservation is taken or used (the list's condition
 * evaluation in `on` is A's / B's read, as `mem list` does).
 *
 * The questions are counted by classification, never by C's rank 1 (status rows are rank 1
 * too): {@link classifyHumanQuestions} reads C's JSON (`entries[]` and `sources[]`) and keys
 * each wait by `(worktree, instance)`; whatever it cannot read is reported as unknown, never
 * as "none".
 *
 * @module lib/handoff/preview
 */

import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { getCurrentBoundary } from '@/lib/db/session-brief-db';
import { withMemTarget } from '@/lib/mem/target';
import { memError, memList, type MemOutcome, type MemServiceDeps } from '@/lib/mem/service';
import { briefForRoute } from '@/lib/brief/service';
import type { BriefBuildDeps } from '@/lib/brief/build';
import type { BriefJson } from '@/types/brief';
import type { MemListResponse } from '@/types/mem';

/** The sources whose failure makes the question count unknown (and `omitted` when rank 1 was cut). */
export type QuestionUnknownSource = 'state' | 'relay' | 'omitted';

export interface HumanQuestions {
  count: number;
  /** Non-empty: the count may be short ("不明"), never read as "none". */
  unknownSources: QuestionUnknownSource[];
}

export interface StartPreviewLines {
  open: { count: number; unreflected: number };
  humanQuestions: HumanQuestions;
  /** ISO 8601, or null when nothing is on record. */
  lastUpdatedAt: string | null;
}

export type StartPreviewResponse =
  | { ok: true; show: false; attended?: boolean; injectOnStart?: boolean; mode?: string }
  | {
      ok: true;
      show: true;
      attended: true;
      injectOnStart: true;
      mode: 'on' | 'derived';
      boundary: { id: string; kind: string };
      /** null: the lines could not be read (the screen says so and still asks). */
      preview: StartPreviewLines | null;
    };

const UNKNOWN_STATUSES = new Set(['unavailable', 'unsupported', 'skipped']);

/**
 * An instance id's shape: `cli-tools/types`' `INSTANCE_ID_PATTERN` and `MAX_INSTANCE_ID_LENGTH`
 * (the hand-off's lib does not import `cli-tools/**`, guard `handoff-no-kill-4227`; the test
 * `handoff-start-preview-4227` pins these equal). It has no `/`, so a `peer` splits at its last.
 */
export const PREVIEW_INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;
export const PREVIEW_INSTANCE_ID_MAX = 64;
const isInstanceId = (value: string): boolean => PREVIEW_INSTANCE_ID.test(value) && value.length <= PREVIEW_INSTANCE_ID_MAX;
const keyOf = (worktreeId: string, instanceId: string): string => JSON.stringify([worktreeId, instanceId]);

/** `peer` (`<worktreeId>/<instanceId>`) split at its last `/`; null when it is not that shape. */
function splitPeer(peer: unknown): [string, string] | null {
  if (typeof peer !== 'string') return null;
  const at = peer.lastIndexOf('/');
  if (at <= 0 || at === peer.length - 1) return null;
  const instanceId = peer.slice(at + 1);
  if (!isInstanceId(instanceId)) return null;
  return [peer.slice(0, at), instanceId];
}

/**
 * The questions waiting for a person (design §3.1.1), from C's JSON as it is: a `state` row
 * with a `waiting` field, a relay `prompt` this instance owes (`dir=owed`: this instance is
 * stopped) or awaits (`dir=awaiting`: the `peer` is stopped). One per `(worktree, instance)`.
 */
export function classifyHumanQuestions(json: Pick<BriefJson, 'entries' | 'sources' | 'omitted'>, worktreeId: string, instanceId: string): HumanQuestions {
  const keys = new Set<string>();
  const unknown = new Set<QuestionUnknownSource>();
  for (const entry of json.entries) {
    const fields = entry.fields ?? {};
    if ('unavailable' in fields || 'unsupported' in fields) {
      if (entry.source === 'state' || entry.source === 'relay') unknown.add(entry.source);
      continue;
    }
    if (entry.source === 'state') {
      if (!('waiting' in fields)) continue; // not waiting: C drops the null field
      if (typeof fields.waiting !== 'string' || typeof fields.instance !== 'string') {
        unknown.add('state');
        continue;
      }
      keys.add(keyOf(worktreeId, fields.instance));
      continue;
    }
    if (entry.source === 'relay') {
      if (fields.state !== 'prompt') continue;
      if (fields.dir === 'owed') {
        keys.add(keyOf(worktreeId, instanceId));
      } else if (fields.dir === 'awaiting') {
        const peer = splitPeer(fields.peer);
        if (peer) keys.add(keyOf(peer[0], peer[1]));
        else unknown.add('relay');
      } else {
        unknown.add('relay');
      }
    }
  }
  for (const source of json.sources) {
    if ((source.id === 'state' || source.id === 'relay') && UNKNOWN_STATUSES.has(source.status)) unknown.add(source.id);
  }
  if ((json.omitted?.byRank?.['1'] ?? 0) >= 1) unknown.add('omitted');
  const order: QuestionUnknownSource[] = ['state', 'relay', 'omitted'];
  return { count: keys.size, unknownSources: order.filter((source) => unknown.has(source)) };
}

/**
 * Lines 1 and 3 from C's JSON (mode `on`): its `mem` entries are A's list after B's evaluation,
 * made in the same build that the questions are read from — the preview evaluates once.
 */
export function openLinesOfBrief(json: Pick<BriefJson, 'entries'>): Pick<StartPreviewLines, 'open' | 'lastUpdatedAt'> {
  const items = json.entries.filter((entry) => entry.source === 'mem' && entry.fields?.state !== 'closed');
  const unreflected = items.filter((entry) => entry.fields?.kind === 'decision' && entry.fields?.state === 'recorded').length;
  const last = items.reduce<string | null>((latest, entry) => (entry.updatedAt !== null && (latest === null || entry.updatedAt > latest) ? entry.updatedAt : latest), null);
  return { open: { count: items.length, unreflected }, lastUpdatedAt: last };
}

/** Lines 1 and 3 from A's list (mode `derived`: C reads no hand-written item there; the list is frozen, nothing evaluated). */
export function openLinesOf(list: MemListResponse): Pick<StartPreviewLines, 'open' | 'lastUpdatedAt'> {
  const items = [...list.items, ...list.now.map((slot) => slot.item)].filter((item) => item.state !== 'closed');
  const unreflected = items.filter((item) => item.kind === 'decision' && item.state === 'recorded').length;
  const last = items.reduce<string | null>((latest, item) => (latest === null || item.updatedAt > latest ? item.updatedAt : latest), null);
  return { open: { count: items.length, unreflected }, lastUpdatedAt: last };
}

export interface StartPreviewDeps {
  mem?: MemServiceDeps;
  brief?: BriefBuildDeps;
}

type PreviewTarget = { mode: string; popup: boolean; injectOnStart: boolean };

/**
 * Issue #4227 G-PR6: the answer when the boundary or the target changed while the lines were read.
 * The lines are A's, so they are not shown under any boundary; the screen sends nothing, keeps the
 * draft and reads again. The preview builds C once (#4224 R5: no maker of a pin in a repetition).
 */
export const START_PREVIEW_BOUNDARY_CHANGED = 'boundary_changed';

/** The preview of `instanceId`'s next send on the worktree (design §3.1). A read. */
export async function handoffStartPreview(
  db: Database.Database,
  worktreeId: string,
  instanceId: string | null,
  deps: StartPreviewDeps = {}
): Promise<MemOutcome> {
  if (!instanceId || !isInstanceId(instanceId)) return memError('invalid_request', { field: 'instance' });
  if (!getWorktreeById(db, worktreeId)) return memError('not_found');
  const readTarget = (): Promise<PreviewTarget | null> =>
    withMemTarget(db, { via: 'worktree', worktreeId }, deps.mem ?? {}, (resolved) =>
      resolved.ok ? { mode: resolved.mode, popup: resolved.features.popup, injectOnStart: resolved.features.injectOnStart } : null
    );
  const target = await readTarget();
  if (!target || target.mode === 'off') return { status: 200, body: { ok: true, show: false } satisfies StartPreviewResponse };
  if (!target.popup) return { status: 200, body: { ok: true, show: false, attended: false } satisfies StartPreviewResponse };
  if (!target.injectOnStart) {
    // design §0.0 S-F: with `injectOnStart` false D1 attaches nothing whatever is chosen.
    return { status: 200, body: { ok: true, show: false, attended: true, injectOnStart: false } satisfies StartPreviewResponse };
  }
  const mode = target.mode as 'on' | 'derived';
  const current = getCurrentBoundary(db, worktreeId, instanceId);
  if (!current || current.state !== 'pending') {
    return { status: 200, body: { ok: true, show: false, attended: true, injectOnStart: true, mode } satisfies StartPreviewResponse };
  }
  let preview: StartPreviewLines | null = null;
  try {
    // One build of C (its own pinned lifetimes; `on` evaluates the conditions once, as a read).
    const briefed = await briefForRoute(db, worktreeId, { instance: instanceId, budget: null, format: 'json', all: '1' }, deps.brief ?? { target: deps.mem });
    if (briefed.status === 200) {
      const json = briefed.body as BriefJson;
      let lines: Pick<StartPreviewLines, 'open' | 'lastUpdatedAt'> | null = null;
      if (mode === 'on') {
        lines = openLinesOfBrief(json);
      } else {
        const listed = await memList(db, { via: 'worktree', worktreeId }, {}, deps.mem ?? {});
        if (listed.status === 200) lines = openLinesOf(listed.body as MemListResponse);
      }
      if (lines) preview = { ...lines, humanQuestions: classifyHumanQuestions(json, worktreeId, instanceId) };
    }
  } catch {
    preview = null;
  }
  // G-PR6 (design §3.1): the lines were read across awaits. Read the boundary and the target again;
  // when either changed, A's lines are not answered under any id (409, the screen reads again).
  const after = getCurrentBoundary(db, worktreeId, instanceId);
  const targetAfter = await readTarget();
  const targetSame =
    targetAfter !== null &&
    targetAfter.mode === target.mode &&
    targetAfter.popup === target.popup &&
    targetAfter.injectOnStart === target.injectOnStart;
  if (targetSame && (!after || after.state !== 'pending')) {
    // Used (or gone) meanwhile: nothing to ask now — a valid show:false.
    return { status: 200, body: { ok: true, show: false, attended: true, injectOnStart: true, mode } satisfies StartPreviewResponse };
  }
  if (!targetSame || !after || after.id !== current.id) {
    return { status: 409, body: { ok: false, code: START_PREVIEW_BOUNDARY_CHANGED, message: 'The session boundary changed while the preview was read' } };
  }
  const body: StartPreviewResponse = {
    ok: true,
    show: true,
    attended: true,
    injectOnStart: true,
    mode,
    boundary: { id: current.id, kind: current.kind },
    preview,
  };
  return { status: 200, body };
}
