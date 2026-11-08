/**
 * The reservation of develop's Claude 3 (Issue #4243; design
 * docs/design/claude3-dispatch-exclusion-4243.md). Claude 3 is both the
 * development leader (PM's briefs, docs/orchestrate/team.md) and the daily
 * dispatch's destination; whoever sends to it holds this reservation first.
 *
 * State is a series of generation files `gen-<N>.json` in one directory; the
 * current one is the largest N. Every operation reads N, checks its own
 * premise, and publishes N+1 with `fs.linkSync` — which fails with EEXIST if
 * another caller published N+1 first, so of two racing callers exactly one
 * wins and the other re-reads. Nothing ever deletes or moves the current
 * generation (unlike run-lock's rename, design §1.4), and nothing reclaims a
 * reservation by age: `reviewAfter` only marks it for a person to look at.
 *
 * Old generations are cleaned, which frees their names; a caller paused for
 * long enough could then link a cleaned name. So a publish counts only if,
 * right after the link, it is still the newest generation or the next one was
 * built on it (`parentPublishId`); otherwise it is stale and fails (design §10 I9).
 *
 * A dispatch run ends with `finish --token` (design §10 I10), which leaves
 * `finished-<token>.json` here before releasing: the only evidence that lets
 * PM take over a dispatch reservation the run failed to release.
 *
 * The production directory is one absolute path under `os.homedir()`
 * ({@link defaultReservationDir}); no environment variable, `--state-dir` or
 * cwd moves it. Tests pass their own directory.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DISPATCH_CLI_TOOL, DISPATCH_INSTANCE_ID, DISPATCH_WORKTREE_ID } from './dispatch';

export const RESERVATION_SCHEMA_VERSION = 1;
/** Generations older than current − this are removed by whoever publishes. */
export const RESERVATION_KEEP_GENERATIONS = 10;
/** How many times an operation re-reads after losing a race before giving up (exit 2). */
export const RESERVATION_MAX_ATTEMPTS = 5;
/** A send whose parent and child are both dead stops counting as in progress after this. */
export const SENDING_STALE_MS = 15 * 60_000;
export const DEFAULT_RESERVATION_HOURS = 8;

export interface ReservationTarget {
  worktreeId: string;
  instanceId: string;
  cliTool: string;
}

export const RESERVATION_TARGET: ReservationTarget = {
  worktreeId: DISPATCH_WORKTREE_ID,
  instanceId: DISPATCH_INSTANCE_ID,
  cliTool: DISPATCH_CLI_TOOL,
};

export type ReservationHolder = 'pm' | 'dispatch';

export interface SendingMark {
  parentPid: number;
  childPid: number | null;
  since: string;
}

export interface ReservationGeneration {
  schemaVersion: 1;
  generation: number;
  target: ReservationTarget;
  state: 'held' | 'released';
  holder: ReservationHolder | null;
  token: string | null;
  label: string | null;
  /** JST date of the dispatch that holds it (dispatch only). */
  date: string | null;
  heldSince: string | null;
  reviewAfter: string | null;
  sending: SendingMark | null;
  previousToken: string | null;
  /** Unique per publish; the next generation names it in `parentPublishId` (stale-link check). */
  publishId: string | null;
  parentPublishId: string | null;
}

/** `~/.commandmate/agent-health/claude3.reservation` — the only production location. */
export function defaultReservationDir(): string {
  return path.join(os.homedir(), '.commandmate', 'agent-health', 'claude3.reservation');
}

export interface ReservationEnv {
  dir: string;
  now: () => Date;
  /** This process's pid (the `parentPid` of a send). */
  pid: number;
  isAlive?: (pid: number) => boolean;
  randomHex?: () => string;
  /** Test hook: called after reading N and before publishing N+1. */
  beforePublish?: (next: ReservationGeneration) => void;
  /** Test hook: called after a publish was verified and before its cleaning. */
  beforeClean?: (next: ReservationGeneration) => void;
}

/** 2 = configuration / I/O / gave up, 3 = held by someone else / token mismatch / sending, 4 = Claude 3 busy (callers). */
export type ReservationFailureCode = 2 | 3 | 4;

export type ReservationResult =
  | { ok: true; generation: ReservationGeneration }
  | { ok: false; code: ReservationFailureCode; message: string; current?: ReservationGeneration };

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releasedAt(generation: number): ReservationGeneration {
  return {
    schemaVersion: 1,
    generation,
    target: { ...RESERVATION_TARGET },
    state: 'released',
    holder: null,
    token: null,
    label: null,
    date: null,
    heldSince: null,
    reviewAfter: null,
    sending: null,
    previousToken: null,
    publishId: null,
    parentPublishId: null,
  };
}

const GEN_RE = /^gen-(\d+)\.json$/;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseGeneration(text: string, n: number): ReservationGeneration | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== RESERVATION_SCHEMA_VERSION || r.generation !== n) return null;
  if (r.state !== 'held' && r.state !== 'released') return null;
  const t = r.target as Record<string, unknown> | null;
  if (typeof t !== 'object' || t === null) return null;
  const s = r.sending as Record<string, unknown> | null;
  const sending: SendingMark | null =
    typeof s === 'object' && s !== null && typeof s.parentPid === 'number' && typeof s.since === 'string'
      ? { parentPid: s.parentPid, childPid: typeof s.childPid === 'number' ? s.childPid : null, since: s.since }
      : null;
  return {
    schemaVersion: 1,
    generation: n,
    target: { worktreeId: String(t.worktreeId), instanceId: String(t.instanceId), cliTool: String(t.cliTool) },
    state: r.state,
    holder: r.holder === 'pm' || r.holder === 'dispatch' ? r.holder : null,
    token: str(r.token),
    label: str(r.label),
    date: str(r.date),
    heldSince: str(r.heldSince),
    reviewAfter: str(r.reviewAfter),
    sending,
    previousToken: str(r.previousToken),
    publishId: str(r.publishId),
    parentPublishId: str(r.parentPublishId),
  };
}

export type ReadResult = { ok: true; current: ReservationGeneration } | { ok: false; message: string };

/** The current generation (released at 0 when there is none). Writes nothing. */
export function readReservation(dir: string): ReadResult {
  for (let attempt = 0; attempt < RESERVATION_MAX_ATTEMPTS; attempt++) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, current: releasedAt(0) };
      return { ok: false, message: `予約を読めなかった: ${dir}（${(error as Error).message}）` };
    }
    let max = 0;
    for (const name of names) {
      const m = GEN_RE.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (max === 0) return { ok: true, current: releasedAt(0) };
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, `gen-${max}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // cleaned while reading: read again
      return { ok: false, message: `予約を読めなかった: ${dir}（${(error as Error).message}）` };
    }
    const parsed = parseGeneration(text, max);
    if (!parsed) return { ok: false, message: `予約の世代 gen-${max}.json が壊れている（${dir}）` };
    return { ok: true, current: parsed };
  }
  return { ok: false, message: `予約を読み直し続けた（${dir}）` };
}

export function targetMatches(target: ReservationTarget): boolean {
  return (
    target.worktreeId === RESERVATION_TARGET.worktreeId &&
    target.instanceId === RESERVATION_TARGET.instanceId &&
    target.cliTool === RESERVATION_TARGET.cliTool
  );
}

/** Whether a send is in progress (a dead parent and child count only after {@link SENDING_STALE_MS}). */
export function isSending(current: ReservationGeneration, now: Date, isAlive: (pid: number) => boolean): boolean {
  const s = current.sending;
  if (!s) return false;
  const dead = !isAlive(s.parentPid) && (s.childPid === null || !isAlive(s.childPid));
  const since = Date.parse(s.since);
  if (dead && Number.isFinite(since) && now.getTime() - since >= SENDING_STALE_MS) return false;
  return true;
}

export function isOverdue(current: ReservationGeneration, now: Date): boolean {
  const review = current.reviewAfter ? Date.parse(current.reviewAfter) : NaN;
  return Number.isFinite(review) && now.getTime() > review;
}

/** One line on who holds it, for skip reasons and `status`. */
export function describeHolder(current: ReservationGeneration, now: Date): string {
  if (current.state !== 'held') return 'claude-3 の予約は空き';
  const overdue = isOverdue(current, now) ? '・期限超過・要確認' : '';
  if (current.holder === 'pm') {
    return `claude-3 を PM が予約中（${current.label ?? '-'}、${current.reviewAfter ?? '-'} まで${overdue}）`;
  }
  return `claude-3 を自動依頼（${current.date ?? '-'}）の run が予約中（${current.reviewAfter ?? '-'} まで${overdue}）`;
}

type Fields = Omit<ReservationGeneration, 'generation' | 'schemaVersion' | 'target' | 'publishId' | 'parentPublishId'>;
type Decision = { ok: true; next: Fields } | { ok: false; code: ReservationFailureCode; message: string };

const FINISHED_RE = /^finished-([A-Za-z0-9-]+)\.json$/;

function maxGeneration(dir: string): number {
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = GEN_RE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * After a successful link: is this publish real? Newest → yes. Otherwise the
 * next generation must have been built on it; if that one is not there or was
 * built on something else, the name was a cleaned one and this link is stale.
 * (A real publish whose successor was already cleaned again is also refused:
 * that fails closed — nobody sends — and needs ~10 publishes inside this window.)
 */
function publishIsCurrent(dir: string, next: ReservationGeneration): boolean {
  if (maxGeneration(dir) === next.generation) return true;
  try {
    const after = parseGeneration(fs.readFileSync(path.join(dir, `gen-${next.generation + 1}.json`), 'utf8'), next.generation + 1);
    return after !== null && after.parentPublishId === next.publishId;
  } catch {
    return false;
  }
}

/**
 * `premiseToken` is the token of the generation this publish was built on. When
 * the publish moves the reservation away from it, that token can never hold
 * again (tokens are unique), so its finished mark is removed — and only that
 * one: a paused publish that resumes late never touches the mark of whoever
 * holds the reservation now (design §10.2 I14).
 */
function publish(env: ReservationEnv, next: ReservationGeneration, premiseToken: string | null): 'ok' | 'conflict' | string {
  const tmp = path.join(env.dir, `tmp-${env.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  const name = path.join(env.dir, `gen-${next.generation}.json`);
  try {
    fs.mkdirSync(env.dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    try {
      fs.linkSync(tmp, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict';
      throw error;
    }
    if (!publishIsCurrent(env.dir, next)) {
      // A cleaned name: below the newest, never read as current. Remove our copy.
      fs.rmSync(name, { force: true });
      return 'conflict';
    }
  } catch (error) {
    return `予約を書けなかった: ${env.dir}（${(error as Error).message}）`;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
  env.beforeClean?.(next);
  const oldest = next.generation - RESERVATION_KEEP_GENERATIONS;
  try {
    for (const entry of fs.readdirSync(env.dir)) {
      const m = GEN_RE.exec(entry);
      if (m && Number(m[1]) < oldest) fs.rmSync(path.join(env.dir, entry), { force: true });
      const f = FINISHED_RE.exec(entry);
      if (f && premiseToken !== null && f[1] === premiseToken && next.token !== premiseToken) {
        fs.rmSync(path.join(env.dir, entry), { force: true });
      }
    }
  } catch {
    // cleaning is best effort
  }
  return 'ok';
}

/** Read N → decide → publish N+1; re-read on a lost race. */
function transition(env: ReservationEnv, decide: (current: ReservationGeneration) => Decision): ReservationResult {
  for (let attempt = 0; attempt < RESERVATION_MAX_ATTEMPTS; attempt++) {
    const read = readReservation(env.dir);
    if (!read.ok) return { ok: false, code: 2, message: read.message };
    const current = read.current;
    if (!targetMatches(current.target)) {
      return {
        ok: false,
        code: 2,
        message: `予約の送り先が設定と違う（${current.target.worktreeId}/${current.target.instanceId}/${current.target.cliTool}）`,
        current,
      };
    }
    const decision = decide(current);
    if (!decision.ok) return { ...decision, current };
    const next: ReservationGeneration = {
      schemaVersion: 1,
      generation: current.generation + 1,
      target: { ...RESERVATION_TARGET },
      ...decision.next,
      publishId: crypto.randomBytes(8).toString('hex'),
      parentPublishId: current.publishId,
    };
    env.beforePublish?.(next);
    const published = publish(env, next, current.token);
    if (published === 'ok') return { ok: true, generation: next };
    if (published !== 'conflict') return { ok: false, code: 2, message: published, current };
  }
  return { ok: false, code: 2, message: `予約の競合が続いた（${RESERVATION_MAX_ATTEMPTS} 回）` };
}

function isAliveOf(env: ReservationEnv): (pid: number) => boolean {
  return env.isAlive ?? defaultIsAlive;
}

function newToken(env: ReservationEnv, holder: ReservationHolder): string {
  const stamp = env.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `${holder}-${stamp}-${env.randomHex?.() ?? crypto.randomBytes(4).toString('hex')}`;
}

function hoursLater(env: ReservationEnv, hours: number): string {
  return new Date(env.now().getTime() + hours * 3_600_000).toISOString();
}

function heldBy(current: ReservationGeneration, token: string, env: ReservationEnv): Decision | null {
  if (current.state !== 'held' || current.token !== token) {
    return { ok: false, code: 3, message: `token が今の予約と一致しない（${describeHolder(current, env.now())}）` };
  }
  return null;
}

function notSending(current: ReservationGeneration, env: ReservationEnv): Decision | null {
  if (isSending(current, env.now(), isAliveOf(env))) {
    return { ok: false, code: 3, message: `送信中（pid ${current.sending?.parentPid}、${current.sending?.since} から）` };
  }
  return null;
}

/** released → held by `holder` with a new token. */
export function acquireReservation(
  env: ReservationEnv,
  input: { holder: ReservationHolder; label: string; date?: string | null; hours?: number }
): ReservationResult {
  return transition(env, (current) => {
    if (current.state === 'held') return { ok: false, code: 3, message: describeHolder(current, env.now()) };
    return {
      ok: true,
      next: {
        state: 'held',
        holder: input.holder,
        token: newToken(env, input.holder),
        label: input.label,
        date: input.date ?? null,
        heldSince: env.now().toISOString(),
        reviewAfter: hoursLater(env, input.hours ?? DEFAULT_RESERVATION_HOURS),
        sending: null,
        previousToken: null,
      },
    };
  });
}

export function renewReservation(env: ReservationEnv, token: string, hours = DEFAULT_RESERVATION_HOURS): ReservationResult {
  return transition(env, (current) => {
    const refused = heldBy(current, token, env) ?? notSending(current, env);
    if (refused) return refused;
    return { ok: true, next: { ...strip(current), sending: null, reviewAfter: hoursLater(env, hours) } };
  });
}

/** held (by this token) → released. */
export function releaseReservation(env: ReservationEnv, token: string): ReservationResult {
  return transition(env, (current) => {
    const refused = heldBy(current, token, env) ?? notSending(current, env);
    if (refused) return refused;
    return { ok: true, next: { ...strip(releasedAt(0)), previousToken: token } };
  });
}

/** A person's release of the generation they looked at (`fromToken`). */
export function forceReleaseReservation(env: ReservationEnv, fromToken: string): ReservationResult {
  return releaseReservation(env, fromToken);
}

export type TakeoverReason = 'restart' | 'dispatch-finished';

/**
 * PM takes the generation it looked at: its own after a restart, or a
 * dispatch run's that forgot to release (`finished` says the run's report is
 * there; design §3.6).
 */
export function takeoverReservation(
  env: ReservationEnv,
  input: { fromToken: string; reason: TakeoverReason; label?: string; hours?: number; finished?: (current: ReservationGeneration) => boolean }
): ReservationResult {
  return transition(env, (current) => {
    const refused = heldBy(current, input.fromToken, env) ?? notSending(current, env);
    if (refused) return refused;
    const wanted: ReservationHolder = input.reason === 'restart' ? 'pm' : 'dispatch';
    if (current.holder !== wanted) {
      return { ok: false, code: 3, message: `--reason ${input.reason} は ${wanted} の予約にだけ使える（${describeHolder(current, env.now())}）` };
    }
    if (input.reason === 'dispatch-finished' && !(input.finished?.(current) ?? false)) {
      return { ok: false, code: 3, message: '自動依頼の run が終わった証拠（その token の完了の印 finished-<token>.json。run の最後の finish --token が書く）が無い。人が release --force で判断する' };
    }
    return {
      ok: true,
      next: {
        state: 'held',
        holder: 'pm',
        token: newToken(env, 'pm'),
        label: input.label ?? current.label,
        date: null,
        heldSince: env.now().toISOString(),
        reviewAfter: hoursLater(env, input.hours ?? DEFAULT_RESERVATION_HOURS),
        sending: null,
        previousToken: input.fromToken,
      },
    };
  });
}

function strip(g: ReservationGeneration): Fields {
  const { generation: _g, schemaVersion: _s, target: _t, publishId: _p, parentPublishId: _pp, ...rest } = g;
  return rest;
}

/**
 * Marks a send in progress (no child yet). With `holder`, the reservation must
 * also be that holder's — checked inside the same compare-and-swap (PM's
 * `send` passes `pm`, so a dispatch token does not let PM send; §10 I12).
 */
export function beginSend(env: ReservationEnv, token: string, holder?: ReservationHolder): ReservationResult {
  return transition(env, (current) => {
    const refused = heldBy(current, token, env) ?? notSending(current, env);
    if (refused) return refused;
    if (holder && current.holder !== holder) {
      return { ok: false, code: 3, message: `この token の予約は ${holder} のものでない（${describeHolder(current, env.now())}）` };
    }
    return { ok: true, next: { ...strip(current), sending: { parentPid: env.pid, childPid: null, since: env.now().toISOString() } } };
  });
}

export function markSendChild(env: ReservationEnv, token: string, childPid: number): ReservationResult {
  return transition(env, (current) => {
    const refused = heldBy(current, token, env);
    if (refused) return refused;
    if (!current.sending || current.sending.parentPid !== env.pid) return { ok: false, code: 3, message: '送信中の印が自分のものでない' };
    return { ok: true, next: { ...strip(current), sending: { ...current.sending, childPid } } };
  });
}

export function endSend(env: ReservationEnv, token: string): ReservationResult {
  return transition(env, (current) => {
    const refused = heldBy(current, token, env);
    if (refused) return refused;
    return { ok: true, next: { ...strip(current), sending: null } };
  });
}

export interface SendResult {
  status: number | null;
  stdout: string;
}

export type GuardedSendResult =
  | { sent: true; status: number | null; stdout: string }
  | { sent: false; code: ReservationFailureCode; message: string };

/**
 * One send under the reservation (design §3.5): check the token and mark the
 * send → run it (the child's pid is recorded as soon as it is known) → clear
 * the mark. Nothing is sent when the token no longer holds.
 */
export async function sendUnderReservation(
  env: ReservationEnv,
  token: string,
  run: (onChild: (pid: number) => void) => Promise<SendResult>,
  holder?: ReservationHolder
): Promise<GuardedSendResult> {
  const begun = beginSend(env, token, holder);
  if (!begun.ok) return { sent: false, code: begun.code, message: begun.message };
  let result: SendResult;
  try {
    result = await run((pid) => {
      markSendChild(env, token, pid);
    });
  } finally {
    endSend(env, token);
  }
  return { sent: true, status: result.status, stdout: result.stdout };
}

const TOKEN_RE = /^[A-Za-z0-9-]+$/;

function finishedMarkPath(dir: string, token: string): string {
  return path.join(dir, `finished-${token}.json`);
}

/**
 * The dispatch run's last step (`finish --token`): leave the finished mark for
 * this token, then release. The mark is written only while the token holds a
 * dispatch reservation; if the release then fails (e.g. a send is in
 * progress), the mark is what lets PM take over later (§10 I10).
 */
export function finishDispatchRun(env: ReservationEnv, token: string): ReservationResult {
  if (!TOKEN_RE.test(token)) return { ok: false, code: 2, message: `token の形が違う: ${token}` };
  const read = readReservation(env.dir);
  if (!read.ok) return { ok: false, code: 2, message: read.message };
  const current = read.current;
  if (current.state !== 'held' || current.token !== token || current.holder !== 'dispatch') {
    return { ok: false, code: 3, message: `token が今の自動依頼の予約と一致しない（${describeHolder(current, env.now())}）`, current };
  }
  try {
    fs.writeFileSync(
      finishedMarkPath(env.dir, token),
      `${JSON.stringify({ token, date: current.date, finishedAt: env.now().toISOString() })}\n`
    );
  } catch (error) {
    return { ok: false, code: 2, message: `完了の印を書けなかった: ${env.dir}（${(error as Error).message}）`, current };
  }
  return releaseReservation(env, token);
}

/** Whether this dispatch reservation's run left its finished mark (`finish --token`). */
export function dispatchRunFinishedMark(dir: string, current: ReservationGeneration): boolean {
  if (current.holder !== 'dispatch' || !current.token || !TOKEN_RE.test(current.token)) return false;
  try {
    const mark = JSON.parse(fs.readFileSync(finishedMarkPath(dir, current.token), 'utf8')) as { token?: unknown };
    return mark.token === current.token;
  } catch {
    return false;
  }
}
