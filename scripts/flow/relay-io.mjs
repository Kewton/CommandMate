#!/usr/bin/env node
/**
 * The relay watch's only contact with the CommandMate server (Issue #4418,
 * docs/design/flow-relay-watch-4418.md §3). `tick` runs it as a child through the shared runner
 * (`node relay-io.mjs read|notify '<json>'`), so its whole time is bounded by the runner's
 * SIGKILL; each request also has its own timeout.
 *
 * - `read` only reads (GET): the PM's relays (`GET /api/relays?worktree&instance`), the relay ids
 *   the PM's history names (`relay:<id>` / `relay-sys:<id>:…` request ids) and those the caller
 *   asks for (`GET /api/relays/:id`), the receivers' recent messages, and a hash of each watched
 *   screen (`current-output`; the screen itself is not passed on).
 * - `notify` sends one line to the PM's composer (`POST /api/worktrees/:pm/send`), the way any
 *   CLI send does. Nothing else is written; the relay, API and DB are not changed.
 *
 * The token is `CM_AUTH_TOKEN` from the environment (never an argument). Prints one JSON line
 * on stdout and exits 0; a failure is `{ "error": … }` in that line.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUEST_TIMEOUT_MS = 10_000;
export const MESSAGES_LIMIT = 100;
export const PM_MESSAGES_LIMIT = 200;
export const LOOKUP_MAX = 50;
export const SCREENS_MAX = 16;
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^relay(?:-sys)?:([0-9a-f-]{36})(?::|$)/i;
// ANSI escapes and digit runs do not count as a change of the screen: a clock or an elapsed
// counter in the footer alone is not progress (design §4.2).
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** The hash the watch compares between ticks (design §4.2). */
export function screenHash(text) {
  const normal = String(text ?? '')
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.replace(/\d+/g, '#').trimEnd())
    .join('\n')
    .trim();
  return crypto.createHash('sha256').update(normal).digest('hex').slice(0, 32);
}

/** The detail a claude `stop` carries when it leaves background work to resume by itself (`SELF_RESUME_PENDING_DETAIL`). */
export const SELF_RESUME_PENDING = 'self_resume_pending';
export const FOOTER_LINES = 6;
// Claude Code's footer while background shells / tasks run ("2 shells", "1 background task").
const BACKGROUND_FOOTER = /\b\d+\s+(?:background\s+)?(?:bash\s+)?(?:shells?|tasks?)\b/i;

/**
 * Whether the bottom of the screen shows background shells or tasks (design §4.2 (A)).
 * Only the last `FOOTER_LINES` non-empty lines: a count of tasks in the transcript is not a footer.
 */
export function footerShowsBackground(text) {
  const lines = String(text ?? '')
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-FOOTER_LINES);
  return lines.some((l) => BACKGROUND_FOOTER.test(l));
}

/**
 * What the receiver's own state says about being busy, from `current-output` (design §4.2 (A)).
 * Only fields the existing API publishes; the screen itself is not passed on.
 */
export function activityOf(body) {
  const events = body?.structuredEvents ?? null;
  return {
    sessionStatus: typeof body?.sessionStatus === 'string' ? body.sessionStatus : null,
    thinking: body?.thinking === true,
    lastEventType: typeof events?.lastEventType === 'string' ? events.lastEventType : null,
    lastEventDetail: typeof events?.lastEventDetail === 'string' ? events.lastEventDetail : null,
    lastEventAt: Number.isFinite(events?.lastEventAt) ? events.lastEventAt : null,
    backgroundFooter: footerShowsBackground(body?.fullOutput ?? body?.content ?? ''),
  };
}

/** The relay id a history row points at, or null. */
export function relayIdOfRequest(requestId) {
  const m = REQUEST_ID.exec(String(requestId ?? ''));
  return m && RELAY_ID.test(m[1]) ? m[1].toLowerCase() : null;
}

function baseUrl(input, env) {
  if (typeof input.url === 'string' && input.url !== '') return input.url.replace(/\/+$/, '');
  const port = /^\d{1,5}$/.test(String(env.CM_PORT ?? '')) ? env.CM_PORT : '3000';
  return `http://localhost:${port}`;
}

function client(input, deps) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const root = baseUrl(input, env);
  const headers = { Accept: 'application/json' };
  if (env.CM_AUTH_TOKEN) headers.Authorization = `Bearer ${env.CM_AUTH_TOKEN}`;
  /** @returns {Promise<{ ok: true, body: any } | { ok: false, why: string }>} */
  return async function call(method, pathname, body) {
    let response;
    try {
      response = await fetchImpl(`${root}${pathname}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      return { ok: false, why: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'server-down' };
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) return { ok: false, why: `http-${response.status}`, body: parsed };
    return { ok: true, body: parsed };
  };
}

const q = encodeURIComponent;
const sessionKey = (s) => `${s.worktreeId}/${s.instanceId}`;

function compactMessage(m) {
  return {
    id: String(m.id ?? ''),
    role: m.role,
    messageType: m.messageType ?? 'normal',
    instanceId: m.instanceId ?? null,
    at: typeof m.timestamp === 'string' ? m.timestamp : new Date(m.timestamp).toISOString(),
    requestId: m.requestId ?? null,
    head: String(m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    startsWithFrom: String(m.content ?? '').trimStart().startsWith('[from '),
    startsWithSlash: String(m.content ?? '').trimStart().startsWith('/'),
  };
}

/**
 * `read`: one snapshot of what the watch needs (design §3).
 * `lookupIds`: relays the caller saw open before (read by id when no longer listed);
 * `skipIds`: closed relays the caller already knows (not read again).
 * @param {{ url?: string, pm: { worktreeId: string, instanceId: string }, receivers: { worktreeId: string, instanceId: string }[], lookupIds?: string[], skipIds?: string[] }} input
 * @param {{ fetch?: typeof fetch, env?: Record<string, string | undefined> }} [deps]
 */
export async function readSnapshot(input, deps = {}) {
  const call = client(input, deps);
  const pm = input.pm;
  const list = await call('GET', `/api/relays?worktree=${q(pm.worktreeId)}&instance=${q(pm.instanceId)}`);
  if (!list.ok) return { error: list.why };
  const body = list.body ?? {};
  if (!Array.isArray(body.awaiting)) return { error: 'schema' };
  const known = new Set([...(body.awaiting ?? []), ...(body.held ?? []), ...(body.closedBlocked ?? [])].map((r) => r.id));
  for (const id of input.skipIds ?? []) known.add(id);

  const lookup = new Set((input.lookupIds ?? []).filter((id) => RELAY_ID.test(id) && !known.has(id)));
  const pmHistory = await call('GET', `/api/worktrees/${q(pm.worktreeId)}/messages?instance=${q(pm.instanceId)}&limit=${PM_MESSAGES_LIMIT}`);
  if (pmHistory.ok && Array.isArray(pmHistory.body)) {
    for (const m of pmHistory.body) {
      const id = relayIdOfRequest(m?.requestId);
      if (id && !known.has(id)) lookup.add(id);
    }
  }
  const lookedUp = [];
  const lookupFailed = [];
  for (const id of [...lookup].slice(0, LOOKUP_MAX)) {
    const one = await call('GET', `/api/relays/${q(id)}`);
    if (one.ok && one.body?.relay) lookedUp.push(one.body.relay);
    else lookupFailed.push(id);
  }

  const receivers = [];
  for (const r of input.receivers) {
    const got = await call('GET', `/api/worktrees/${q(r.worktreeId)}/messages?instance=${q(r.instanceId)}&limit=${MESSAGES_LIMIT}`);
    receivers.push({
      worktreeId: r.worktreeId,
      instanceId: r.instanceId,
      messages: got.ok && Array.isArray(got.body) ? got.body.map(compactMessage) : null,
      why: got.ok ? (Array.isArray(got.body) ? null : 'schema') : got.why,
    });
  }

  const screenTargets = new Map();
  for (const s of [pm, ...input.receivers, ...body.awaiting.map((r) => r.to).filter(Boolean)]) screenTargets.set(sessionKey(s), s);
  const screens = {};
  for (const [key, s] of [...screenTargets].slice(0, SCREENS_MAX + 1)) {
    const got = await call('GET', `/api/worktrees/${q(s.worktreeId)}/current-output?instance=${q(s.instanceId)}`);
    screens[key] = got.ok
      ? { isRunning: got.body?.isRunning === true, hash: screenHash(got.body?.fullOutput ?? got.body?.content ?? ''), activity: activityOf(got.body) }
      : { isRunning: null, hash: null, why: got.why };
  }

  // A verification run in progress in a watched worktree is work going on (design §4.2 (A)).
  const verifyRunning = {};
  for (const wt of new Set([...input.receivers, ...body.awaiting.map((r) => r.to).filter(Boolean)].map((s) => s.worktreeId))) {
    const got = await call('GET', `/api/worktrees/${q(wt)}/verify/runs?limit=5`);
    verifyRunning[wt] = got.ok && Array.isArray(got.body?.runs) ? got.body.runs.some((r) => r?.status === 'running') : null;
  }

  return {
    awaiting: body.awaiting,
    held: Array.isArray(body.held) ? body.held : null,
    closedBlocked: Array.isArray(body.closedBlocked) ? body.closedBlocked : null,
    lookedUp,
    lookupFailed,
    pmHistory: pmHistory.ok ? 'ok' : pmHistory.why,
    receivers,
    screens,
    verifyRunning,
  };
}

/**
 * `notify`: one line to the PM's composer (design §5).
 * @param {{ url?: string, pm: { worktreeId: string, instanceId: string }, text: string }} input
 * @param {{ fetch?: typeof fetch, env?: Record<string, string | undefined> }} [deps]
 */
export async function sendNotice(input, deps = {}) {
  const call = client(input, deps);
  const text = String(input.text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (text === '') return { error: 'empty' };
  const sent = await call('POST', `/api/worktrees/${q(input.pm.worktreeId)}/send`, { content: text, instanceId: input.pm.instanceId });
  if (!sent.ok) return { outcome: sent.why === 'timeout' || sent.why === 'server-down' ? 'unknown' : 'not_sent', why: sent.why };
  return { outcome: sent.body?.sendOutcome ?? 'sent' };
}

async function cli(argv) {
  const [action, json] = argv;
  let input;
  try {
    input = JSON.parse(json);
  } catch {
    return { error: 'arguments' };
  }
  if (action === 'read') return readSnapshot(input);
  if (action === 'notify') return sendNotice(input);
  return { error: 'arguments' };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  cli(process.argv.slice(2))
    .catch((e) => ({ error: `unexpected: ${e instanceof Error ? e.message : String(e)}` }))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 0;
    });
}
