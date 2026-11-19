/**
 * The relay watch of `tick` (Issue #4418, docs/design/flow-relay-watch-4418.md).
 *
 * Three checks over the PM's requests, read from the CommandMate server through `relay-io.mjs`:
 *  1. `noRelay`  — a request in a receiver's history (the sessions only the PM sends to) that no
 *                  relay from the PM is bound to (relay `inputBoundaryAt` = the row's timestamp);
 *  2. `stall`    — a relay from the PM `pending` for `pendingMinutes` while the receiver's screen
 *                  has not changed for `screenMinutes` across ticks;
 *  3. `heldOrExpired` — a relay from the PM under a delivery hold, or expired.
 *
 * Each tick writes one `kind: "relay-watch"` line to `<recordDir>/relay-watch/<date>.jsonl` (a
 * subdirectory: the tick readers never list it) with the checks (`found` / `unobserved` /
 * `unknown`) and the state the next tick needs (screens, relays seen, keys already told). Only
 * keys not told before go to the PM, as one line (check 1 only with `notifyNoRelay`: until #4420
 * it is recorded, never told — design §5.1); the line is written first (the mark of the
 * attempt), then the send, then a `kind: "relay-watch-notice"` line with its outcome.
 *
 * Nothing here throws to the caller's measurement: `runWatch` returns a summary or a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RELAY_IO_FILE } from './runner.mjs';
import { FILE_PATTERN, MAX_FILE_BYTES, appendTick } from './record.mjs';

export const WATCH_DIR = 'relay-watch';
export const WATCH_BUDGET_MS = 60_000;
export const READ_CAP_MS = 45_000;
export const NOTICE_CAP_MS = 15_000;
export const BOUNDARY_TOLERANCE_MS = 5_000;
export const LEGACY_MATCH_MS = 120_000;
export const LOOKBACK_MS = 24 * 3_600_000;
export const RELAY_MEMORY_MS = 26 * 3_600_000;
export const NOTICE_ITEMS_MAX = 5;
/** A relay waiting with evidence of work is told after this many × `pendingMinutes` (design §4.2 (B)). */
export const LONG_WAIT_FACTOR = 4;
const PREVIOUS_FILES_MAX = 3;
/**
 * The state is read from the end of a day file, never the whole file (design §6.1): the first
 * window is this big and grows ×4 up to `MAX_FILE_BYTES` of tail. A file over the limit is still
 * read (its last lines are the newest state); nothing is removed or rewritten.
 */
export const TAIL_FIRST_BYTES = 256 * 1024;
const OPEN_STATES = new Set(['pending', 'prompt']);
const MINUTE = 60_000;

const iso = (ms) => new Date(ms).toISOString();
const keyOf = (s) => `${s.worktreeId}/${s.instanceId}`;
const sameSession = (a, b) => !!a && !!b && a.worktreeId === b.worktreeId && a.instanceId === b.instanceId;
const timeOf = (text) => {
  const ms = typeof text === 'number' ? text : Date.parse(String(text ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

/** The state a tick starts from when no earlier line can be read. */
export function emptyState() {
  return { screens: {}, relays: {}, reported: [], previousAt: null };
}

/**
 * The complete lines of the last `bytes` of `file`, newest first (an unfinished tail is not a
 * line; the first, cut line of a window that does not start at 0 is not read).
 * @returns {{ lines: string[], whole: boolean } | null}
 */
function tailLines(fd, size, bytes) {
  const length = Math.min(size, bytes);
  const start = size - length;
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buffer, got, length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  const text = buffer.subarray(0, got).toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], whole: start === 0 };
  const lines = text.slice(0, end).split('\n');
  if (start > 0) lines.shift();
  return { lines: lines.reverse(), whole: start === 0 };
}

/** The state in one window of lines (newest first), or null when it has no `relay-watch` line. */
function stateIn(lines, scope) {
  const notSent = [];
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.v !== 1 || rec.repo !== scope.repo || rec.base !== scope.base) continue;
    // A notice the server answered as not sent (the PM stopped or replaced): not told, so the
    // next tick tries again (design §5). An unknown outcome stays told.
    if (rec.kind === 'relay-watch-notice') {
      if (rec.outcome === 'not_sent' && Array.isArray(rec.keys)) notSent.push({ tickId: rec.tickId, keys: rec.keys });
      continue;
    }
    if (rec.kind !== 'relay-watch') continue;
    const dropped = new Set(notSent.filter((n) => n.tickId === rec.tickId).flatMap((n) => n.keys));
    return {
      screens: rec.screens && typeof rec.screens === 'object' ? rec.screens : {},
      relays: rec.relays && typeof rec.relays === 'object' ? rec.relays : {},
      reported: Array.isArray(rec.reported) ? rec.reported.filter((k) => typeof k === 'string' && !dropped.has(k)) : [],
      previousAt: typeof rec.at === 'string' ? rec.at : null,
    };
  }
  return null;
}

/**
 * The state of the last `relay-watch` line of this scope (newest file first, up to 3 files),
 * read from the end of each file (design §6.1), so a file past the record size limit still gives
 * its newest state. An unreadable file is skipped; an unfinished tail is not a line.
 * @param {string} dir  `<recordDir>/relay-watch`
 * @param {{ repo: string, base: string }} scope
 * @param {{ firstBytes?: number, maxBytes?: number }} [options]
 */
export function readLastWatch(dir, scope, options = {}) {
  const firstBytes = options.firstBytes ?? TAIL_FIRST_BYTES;
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return emptyState();
  }
  const files = names.filter((n) => FILE_PATTERN.test(n)).sort().reverse().slice(0, PREVIOUS_FILES_MAX);
  for (const name of files) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, name), 'r');
      const size = fs.fstatSync(fd).size;
      for (let bytes = firstBytes; ; bytes *= 4) {
        const window = tailLines(fd, size, Math.min(bytes, maxBytes));
        const state = window ? stateIn(window.lines, scope) : null;
        if (state) return state;
        if (!window || window.whole || bytes >= maxBytes) break;
      }
    } catch {
      // unreadable: the next file
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return emptyState();
}

function remember(relay) {
  return {
    from: relay.from ? { worktreeId: relay.from.worktreeId, instanceId: relay.from.instanceId } : null,
    to: relay.to ? { worktreeId: relay.to.worktreeId, instanceId: relay.to.instanceId } : null,
    state: String(relay.state ?? ''),
    createdAt: timeOf(relay.createdAt),
    boundaryAt: timeOf(relay.inputBoundaryAt),
    expiresAt: timeOf(relay.expiresAt),
  };
}

/** Whether a relay from the PM is bound to a request row at `at` in `receiver` (design §4.1). */
function boundTo(relays, receiver, at) {
  for (const r of Object.values(relays)) {
    if (!sameSession(r.to, receiver)) continue;
    if (r.boundaryAt !== null && r.boundaryAt !== undefined) {
      if (Math.abs(r.boundaryAt - at) <= BOUNDARY_TOLERANCE_MS) return true;
    } else if (r.createdAt !== null && r.createdAt !== undefined && at >= r.createdAt && at <= r.createdAt + LEGACY_MATCH_MS) {
      return true;
    }
  }
  return false;
}

function isRequestRow(m, receiver) {
  if (!m || m.role !== 'user' || (m.messageType ?? 'normal') !== 'normal') return false;
  if (m.startsWithFrom || m.startsWithSlash) return false;
  if (typeof m.requestId === 'string' && /^relay(-sys)?:/.test(m.requestId)) return false;
  return m.instanceId === null || m.instanceId === undefined || m.instanceId === receiver.instanceId;
}

function check(items, unknown) {
  if (items.length > 0) return { state: 'found', count: items.length, items };
  return unknown ? { state: 'unknown', count: null, items: [] } : { state: 'unobserved', count: 0, items: [] };
}

/**
 * The evidence that a receiver is working although its screen has not changed (design §4.2 (A)).
 * Read from the existing `current-output` and `verify/runs` APIs only; an empty list = none seen.
 * @param {any} activity  `relay-io.mjs` `activityOf`
 * @param {boolean | null | undefined} verifyRunning
 * @param {number} nowMs
 * @param {number} recentMs  a hook event this recent counts as activity
 * @returns {string[]}
 */
export function busyEvidence(activity, verifyRunning, nowMs, recentMs) {
  const evidence = [];
  if (activity?.sessionStatus === 'running') evidence.push('session-running');
  if (activity?.thinking === true) evidence.push('thinking');
  if (activity?.lastEventType === 'stop' && activity?.lastEventDetail === 'self_resume_pending') evidence.push('background-pending');
  if (activity?.backgroundFooter === true) evidence.push('background-footer');
  // A recent `stop` / `session_end` is the end of work, not work.
  const ended = activity?.lastEventType === 'stop' || activity?.lastEventType === 'session_end';
  if (!ended && Number.isFinite(activity?.lastEventAt) && nowMs - activity.lastEventAt < recentMs) evidence.push('recent-hook-event');
  if (verifyRunning === true) evidence.push('verify-running');
  return evidence;
}

/**
 * The three checks over one snapshot (pure; design §4).
 * @param {{ snapshot: any, previous: ReturnType<typeof emptyState>, settings: { pm: any, receivers: any[], pendingMinutes: number, screenMinutes: number }, nowMs: number }} input
 */
export function evaluateWatch({ snapshot, previous, settings, nowMs }) {
  const pm = settings.pm;
  const fromPm = (r) => r && sameSession(r.from, pm);

  // Relays from the PM: the ones remembered (26 h) and every one this snapshot shows.
  /** @type {Record<string, ReturnType<typeof remember>>} */
  const relays = {};
  for (const [id, r] of Object.entries(previous.relays ?? {})) {
    if (r && sameSession(r.from, pm) && (r.createdAt ?? 0) >= nowMs - RELAY_MEMORY_MS) relays[id] = r;
  }
  const shown = [...(snapshot.awaiting ?? []), ...(snapshot.held ?? []), ...(snapshot.closedBlocked ?? []), ...(snapshot.lookedUp ?? [])];
  for (const r of shown) if (fromPm(r) && typeof r.id === 'string') relays[r.id] = remember(r);

  // Screens: since when the hash has been the same (only ticks observe it).
  // A screen that could not be read this tick is not a change: its hash and "since" are carried,
  // marked `unread`, and nothing is decided from it (design §4.2, §5).
  /** @type {Record<string, { hash: string | null, since: string | null, isRunning: boolean | null, unread?: true }>} */
  const screens = {};
  for (const [key, s] of Object.entries(snapshot.screens ?? {})) {
    const before = previous.screens?.[key];
    if (!s || !s.hash) {
      screens[key] = { hash: before?.hash ?? null, since: before?.since ?? null, isRunning: s?.isRunning ?? null, unread: true };
      continue;
    }
    const since = before && before.hash === s.hash && typeof before.since === 'string' ? before.since : iso(nowMs);
    screens[key] = { hash: s.hash, since, isRunning: s.isRunning ?? null };
  }

  // Keys this tick could not decide (not read, as opposed to read and gone): a key told before
  // stays told while it is undecided (design §5).
  const undecided = { keys: /** @type {string[]} */ ([]), prefixes: /** @type {string[]} */ ([]) };

  // 1. requests with no relay.
  const noRelay = [];
  let noRelayUnknown = false;
  for (const receiver of snapshot.receivers ?? []) {
    if (!Array.isArray(receiver.messages)) {
      noRelayUnknown = true;
      undecided.prefixes.push('no-relay:');
      continue;
    }
    for (const m of receiver.messages) {
      if (!isRequestRow(m, receiver)) continue;
      const at = timeOf(m.at);
      if (at === null || at < nowMs - LOOKBACK_MS || at > nowMs) continue;
      if (boundTo(relays, receiver, at)) continue;
      noRelay.push({ key: `no-relay:${m.id}`, to: { worktreeId: receiver.worktreeId, instanceId: receiver.instanceId }, messageId: m.id, at: iso(at), head: String(m.head ?? '').slice(0, 40) });
    }
  }

  // 2. stalled relays.
  const stall = [];
  const waiting = [];
  let stallUnknown = false;
  for (const r of snapshot.awaiting ?? []) {
    if (!fromPm(r) || r.state !== 'pending' || !r.to) continue;
    const start = timeOf(r.inputBoundaryAt) ?? timeOf(r.createdAt);
    if (start === null || nowMs - start < settings.pendingMinutes * MINUTE) continue;
    const screen = screens[keyOf(r.to)];
    if (!screen || !screen.since || screen.unread) {
      stallUnknown = true;
      undecided.keys.push(`stall:${r.id}`, `stall-long:${r.id}`);
      continue;
    }
    const unchanged = nowMs - Date.parse(screen.since);
    if (unchanged < settings.screenMinutes * MINUTE) continue;
    const item = { key: `stall:${r.id}`, relayId: r.id, to: r.to, pendingMinutes: Math.floor((nowMs - start) / MINUTE), screenMinutes: Math.floor(unchanged / MINUTE) };
    // (A) An unchanged screen alone is not a stall: a receiver waiting on background shells or a
    // verification run is working. Such a relay is recorded as waiting, never told.
    const busy = busyEvidence(snapshot.screens?.[keyOf(r.to)]?.activity, snapshot.verifyRunning?.[r.to.worktreeId], nowMs, settings.screenMinutes * MINUTE);
    if (busy.length > 0) {
      // (B) The second stage: waiting with evidence for LONG_WAIT_FACTOR × pendingMinutes is told
      // once, under its own key, with the evidence named (a wait that never ends is not silent).
      if (nowMs - start >= LONG_WAIT_FACTOR * settings.pendingMinutes * MINUTE) {
        stall.push({ ...item, key: `stall-long:${r.id}`, evidence: busy });
      } else {
        waiting.push({ ...item, key: `waiting:${r.id}`, evidence: busy });
      }
      continue;
    }
    stall.push(item);
  }

  // 3. held or expired relays.
  const heldOrExpired = [];
  const seen = new Set();
  const add = (item) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    heldOrExpired.push(item);
  };
  for (const r of snapshot.held ?? []) {
    if (!fromPm(r) || r.deliveryHold?.state !== 'uncertain') continue;
    add({ key: `held:${r.id}:${r.deliveryHold.payloadId ?? ''}`, relayId: r.id, to: r.to, kind: 'held', reason: r.deliveryHold.reason ?? null });
  }
  for (const r of snapshot.awaiting ?? []) {
    if (!fromPm(r)) continue;
    if (r.holdReason) add({ key: `hold:${r.id}:${r.holdReason}`, relayId: r.id, to: r.to, kind: 'held', reason: r.holdReason });
    const expires = timeOf(r.expiresAt);
    if (expires !== null && expires <= nowMs) add({ key: `expired:${r.id}`, relayId: r.id, to: r.to, kind: 'expired', reason: 'past-expiresAt' });
  }
  for (const r of snapshot.closedBlocked ?? []) {
    if (fromPm(r)) add({ key: `expired:${r.id}`, relayId: r.id, to: r.to, kind: 'expired', reason: r.lastDeliveryBlock?.reason ?? 'notice-blocked' });
  }
  for (const [id, r] of Object.entries(relays)) {
    if (r.state === 'expired' && (r.expiresAt ?? 0) >= nowMs - LOOKBACK_MS) add({ key: `expired:${id}`, relayId: id, to: r.to, kind: 'expired', reason: null });
  }

  if (!Array.isArray(snapshot.held) || !Array.isArray(snapshot.closedBlocked)) undecided.prefixes.push('held:', 'expired:');
  for (const id of snapshot.lookupFailed ?? []) undecided.keys.push(`expired:${id}`);

  const checks = {
    noRelay: check(noRelay, noRelayUnknown),
    stall: { ...check(stall, stallUnknown), waiting },
    heldOrExpired: check(heldOrExpired, !Array.isArray(snapshot.held)),
  };
  const all = [...noRelay, ...stall, ...heldOrExpired];
  const told = new Set(previous.reported ?? []);
  return {
    checks,
    screens,
    relays,
    current: all.map((i) => i.key),
    fresh: all.filter((i) => !told.has(i.key)),
    undecided,
  };
}

/** The one line the PM reads (design §5): the relay header form, then the new items. */
export function noticeText(fresh, { pm, file }) {
  const short = (id) => String(id ?? '').slice(0, 8);
  const where = (s) => (s ? `${s.worktreeId}/${s.instanceId}` : '?');
  const parts = fresh.slice(0, NOTICE_ITEMS_MAX).map((i) => {
    if (i.key.startsWith('stall-long:')) {
      return `長い待機 relay=${short(i.relayId)} -> ${where(i.to)}（pending ${i.pendingMinutes} 分・画面 ${i.screenMinutes} 分不変。動いている証拠: ${(i.evidence ?? []).join(',')}。止まっていないかを確かめて）`;
    }
    if (i.key.startsWith('stall:')) {
      return `STALL の疑い relay=${short(i.relayId)} -> ${where(i.to)}（根拠: pending ${i.pendingMinutes} 分・画面 ${i.screenMinutes} 分不変・動いている証拠なし。待機中の可能性は残る。capture で確かめて）`;
    }
    if (i.key.startsWith('no-relay:')) return `relay なしの依頼 ${where(i.to)} ${i.at}「${i.head}」`;
    if (i.kind === 'held') return `配送の保留 relay=${short(i.relayId)} -> ${where(i.to)} reason=${i.reason ?? '?'}`;
    return `期限切れ relay=${short(i.relayId)} -> ${where(i.to)}`;
  });
  const more = fresh.length > NOTICE_ITEMS_MAX ? ` / ほか ${fresh.length - NOTICE_ITEMS_MAX} 件` : '';
  return `[from flow-watch / ${pm.worktreeId}] relay の見張り（flow tick）で新しく ${fresh.length} 件: ${parts.join(' / ')}${more}（記録: ${file}）`;
}

function parseChild(r) {
  if (r.status === 'timeout') return { error: 'timeout' };
  if (r.status === 'refused') return { error: 'refused' };
  if (r.status !== 'ok') return { error: 'fail' };
  try {
    const out = JSON.parse(String(r.stdout ?? '').trim().split('\n').pop() ?? '');
    return out && typeof out === 'object' && !Array.isArray(out) ? out : { error: 'schema' };
  } catch {
    return { error: 'schema' };
  }
}

/**
 * One watch inside `tick`, after the measurement was written. Never throws.
 * @param {{ settings: any, scope: { repo: string, base: string }, recordDir: string, tz: string, tickId: string, atMs: number, runBounded: Function, monoNow: () => number, execPath?: string }} ctx
 * @returns {{ ok: boolean, summary: string, error?: string }}
 */
export function runWatch(ctx) {
  try {
    return watchOnce(ctx);
  } catch (e) {
    return { ok: false, summary: 'relayWatch=error', error: e instanceof Error ? e.message : String(e) };
  }
}

function watchOnce({ settings, scope, recordDir, tz, tickId, atMs, runBounded, monoNow, execPath = process.execPath }) {
  const t0 = monoNow();
  const deadlineMono = t0 + WATCH_BUDGET_MS;
  const dir = path.join(recordDir, WATCH_DIR);
  const previous = readLastWatch(dir, scope);
  const pm = settings.pm;
  const base = { url: settings.url ?? undefined, pm };
  const remembered = Object.entries(previous.relays ?? {});
  const read = parseChild(
    runBounded(
      execPath,
      [
        RELAY_IO_FILE,
        'read',
        JSON.stringify({
          ...base,
          receivers: settings.receivers,
          lookupIds: remembered.filter(([, r]) => OPEN_STATES.has(r?.state)).map(([id]) => id).slice(0, 50),
          skipIds: remembered.filter(([, r]) => !OPEN_STATES.has(r?.state)).map(([id]) => id).slice(0, 500),
        }),
      ],
      { deadlineMono, capMs: READ_CAP_MS },
    ),
  );

  const line = { v: 1, kind: 'relay-watch', tickId, at: iso(atMs), repo: scope.repo, base: scope.base, pm, previousAt: previous.previousAt };
  let fresh = [];
  let pmRunning = null;
  if ('error' in read) {
    const unknown = { state: 'unknown', count: null, items: [] };
    Object.assign(line, {
      status: 'unknown',
      why: read.error,
      checks: { noRelay: unknown, stall: unknown, heldOrExpired: unknown },
      // Carried as they were: a failed read does not reset what was told or seen.
      screens: previous.screens,
      relays: previous.relays,
      reported: previous.reported,
    });
  } else {
    const result = evaluateWatch({ snapshot: read, previous, settings, nowMs: atMs });
    // Check 1 is recorded only (not told) unless `notifyNoRelay` (design §5.1, until #4420).
    const recordOnly = settings.notifyNoRelay === true ? [] : result.fresh.filter((i) => i.key.startsWith('no-relay:'));
    fresh = result.fresh.filter((i) => !recordOnly.includes(i));
    pmRunning = read.screens?.[`${pm.worktreeId}/${pm.instanceId}`]?.isRunning ?? null;
    const attempt = fresh.length > 0 && pmRunning === true;
    const keep = new Set(previous.reported);
    // A key is told once: kept while it is current or undecided (not read this tick); a new one
    // only when this tick tries to send it. Read and gone is the only way a told key is forgotten.
    const current = new Set(result.current);
    const undecided = (k) => result.undecided.keys.includes(k) || result.undecided.prefixes.some((p) => k.startsWith(p));
    const reported = [
      ...result.current.filter((k) => keep.has(k) || (attempt && fresh.some((i) => i.key === k))),
      ...[...keep].filter((k) => !current.has(k) && undecided(k)),
    ];
    Object.assign(line, {
      status: 'ok',
      checks: result.checks,
      screens: result.screens,
      relays: result.relays,
      reported,
      lookupFailed: Array.isArray(read.lookupFailed) ? read.lookupFailed.length : 0,
      notice: {
        keys: fresh.map((i) => i.key),
        attempt,
        why: fresh.length === 0 ? (recordOnly.length > 0 ? 'record-only' : 'nothing-new') : attempt ? null : 'pm-not-running',
        recordOnly: recordOnly.map((i) => i.key),
      },
    });
  }
  line.durationMs = Math.max(0, Math.round(monoNow() - t0));
  const written = appendTick(dir, line, { tz });
  const states = line.status === 'ok' ? `noRelay=${line.checks.noRelay.state} stall=${line.checks.stall.state} heldOrExpired=${line.checks.heldOrExpired.state}` : `why=${line.why}`;
  if (!written.ok) {
    return { ok: false, summary: `relayWatch=${line.status} ${states} record=not-written`, error: `cannot write ${written.file} (${written.reason}${written.code ? ` ${written.code}` : ''}); nothing sent` };
  }
  if (!line.notice?.attempt) {
    return { ok: line.status === 'ok', summary: `relayWatch=${line.status} ${states}`, error: line.status === 'ok' ? undefined : `relay watch could not read (${line.why})` };
  }
  const sent = parseChild(
    runBounded(execPath, [RELAY_IO_FILE, 'notify', JSON.stringify({ ...base, text: noticeText(fresh, { pm, file: written.file }) })], {
      deadlineMono,
      capMs: NOTICE_CAP_MS,
    }),
  );
  const outcome = 'error' in sent ? (sent.error === 'timeout' ? 'unknown' : 'fail') : String(sent.outcome ?? 'unknown');
  appendTick(dir, { v: 1, kind: 'relay-watch-notice', tickId, at: iso(atMs), repo: scope.repo, base: scope.base, keys: fresh.map((i) => i.key), outcome, why: sent.error ?? sent.why ?? null }, { tz });
  return { ok: true, summary: `relayWatch=ok ${states} notice=${outcome}` };
}
