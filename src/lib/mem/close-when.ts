/**
 * `close_when`: the grammar, the stored form and which kind takes which type
 * (Issue #4221, design §2). This module does not evaluate a condition; #4222 does,
 * from the stored form, and reads the same fixture (`tests/fixtures/mem/close-when-v1.json`).
 *
 * Three steps, because two of the inputs need git and the write must not await:
 * 1. {@link parseCloseWhen}: syntax and the kind × type table, pure.
 * 2. {@link closeWhenGitNeeds}: what git has to be asked (the origin for `#N`, a tip).
 * 3. {@link finalizeCloseWhen}: in the write's synchronous stretch, with the answers.
 *
 * @module lib/mem/close-when
 */

import {
  CLOSE_WHEN_ALLOWED,
  CLOSE_WHEN_DEFAULTS,
  type MemCloseWhen,
  type MemKind,
} from '@/types/mem';
import { parseIsoWithOffset } from './validate';

export const CLOSE_WHEN_SCHEMA = 1;
export const CLOSE_WHEN_MAX_LENGTH = 300;

/**
 * The kind × type table and the defaults live in `types/mem` (Issue #4227 G-PR4): the CLI reads them
 * there without the `@/` alias. Re-exported here under the same names; nothing about them changes.
 */
export { CLOSE_WHEN_ALLOWED, CLOSE_WHEN_DEFAULTS, CLOSE_WHEN_TYPES } from '@/types/mem';

export interface CloseWhenTarget {
  host: string;
  owner: string;
  repo: string;
}

/** A condition parsed but not yet bound to its repository, git or worktree. */
export type CloseWhenDraft =
  | { type: 'promoted' }
  | { type: 'manual' }
  | { type: 'replaced' }
  | { type: 'issue'; target: CloseWhenTarget | null; number: number }
  | { type: 'pr'; target: CloseWhenTarget | null; number: number; state: 'merged' | 'closed' }
  | { type: 'branch'; name: string; event: 'merged' | 'deleted'; into: string | null; scope: 'local' | 'remote' }
  | { type: 'relay'; relayId: string }
  | { type: 'worktree'; worktreeId: string }
  | { type: 'session'; sessionId: string }
  | { type: 'at'; epochMs: number; offset: string };

export type CloseWhenParse = { ok: true; draft: CloseWhenDraft } | { ok: false; reason: string };

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,250}$/;
const TARGET = /^([A-Za-z0-9.-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

const invalid = (reason: string): CloseWhenParse => ({ ok: false, reason });

function parseIssueLike(rest: string): { target: CloseWhenTarget | null; number: number; query: string } | null {
  const hash = rest.indexOf('#');
  if (hash < 0) return null;
  const targetText = rest.slice(0, hash);
  const afterHash = rest.slice(hash + 1);
  const match = /^([1-9][0-9]{0,9})(\?.*)?$/.exec(afterHash);
  if (!match) return null;
  let target: CloseWhenTarget | null = null;
  if (targetText.length > 0) {
    const t = TARGET.exec(targetText);
    if (!t) return null;
    target = { host: t[1], owner: t[2], repo: t[3] };
  }
  return { target, number: Number(match[1]), query: match[2] ?? '' };
}

/** `?a=b&c` into ordered pairs; null on a repeated or empty key. */
function parseQuery(query: string): Array<[string, string | null]> | null {
  if (query === '') return [];
  if (!query.startsWith('?')) return null;
  const pairs: Array<[string, string | null]> = [];
  const seen = new Set<string>();
  for (const part of query.slice(1).split('&')) {
    if (part.length === 0) return null;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? null : part.slice(eq + 1);
    if (key.length === 0 || seen.has(key)) return null;
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs;
}

function parseSyntax(raw: string): CloseWhenParse {
  if (raw === 'manual') return { ok: true, draft: { type: 'manual' } };
  if (raw === 'replaced') return { ok: true, draft: { type: 'replaced' } };
  const colon = raw.indexOf(':');
  if (colon < 0) return invalid('unknown_type');
  const type = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);

  switch (type) {
    case 'issue': {
      const parsed = parseIssueLike(rest);
      if (!parsed || parsed.query !== '') return invalid('bad_issue');
      return { ok: true, draft: { type: 'issue', target: parsed.target, number: parsed.number } };
    }
    case 'pr': {
      const parsed = parseIssueLike(rest);
      if (!parsed) return invalid('bad_pr');
      const pairs = parseQuery(parsed.query);
      if (!pairs) return invalid('bad_query');
      let state: 'merged' | 'closed' = 'merged';
      for (const [key, value] of pairs) {
        if (key !== 'state' || (value !== 'merged' && value !== 'closed')) return invalid('bad_query');
        state = value;
      }
      return { ok: true, draft: { type: 'pr', target: parsed.target, number: parsed.number, state } };
    }
    case 'branch': {
      const question = rest.indexOf('?');
      if (question < 0) return invalid('bad_branch');
      const name = rest.slice(0, question);
      if (!REF.test(name)) return invalid('bad_branch');
      const pairs = parseQuery(rest.slice(question));
      if (!pairs || pairs.length === 0) return invalid('bad_query');
      const [first, ...others] = pairs;
      let event: 'merged' | 'deleted';
      let into: string | null = null;
      if (first[0] === 'merged' && first[1] !== null && REF.test(first[1])) {
        event = 'merged';
        into = first[1];
      } else if (first[0] === 'deleted' && first[1] === null) {
        event = 'deleted';
      } else {
        return invalid('bad_query');
      }
      let scope: 'local' | 'remote' = 'local';
      for (const [key, value] of others) {
        if (key !== 'scope' || (value !== 'local' && value !== 'remote')) return invalid('bad_query');
        scope = value;
      }
      return { ok: true, draft: { type: 'branch', name, event, into, scope } };
    }
    case 'relay':
      return ID.test(rest) ? { ok: true, draft: { type: 'relay', relayId: rest } } : invalid('bad_id');
    case 'worktree':
      return ID.test(rest) ? { ok: true, draft: { type: 'worktree', worktreeId: rest } } : invalid('bad_id');
    case 'session':
      // A PID is not a session: it is re-used by the OS. Issue #4222 (S1): only the
      // runs CommandMate records the end of, each under its namespace.
      return ID.test(rest) && parseSessionId(rest) !== null
        ? { ok: true, draft: { type: 'session', sessionId: rest } }
        : invalid('bad_id');
    case 'at': {
      const epochMs = parseIsoWithOffset(rest);
      if (epochMs === null) return invalid('bad_time');
      const offsetMatch = /(Z|[+-]\d{2}:\d{2})$/.exec(rest);
      const offset = offsetMatch?.[1] === 'Z' ? '+00:00' : (offsetMatch?.[1] ?? '+00:00');
      return { ok: true, draft: { type: 'at', epochMs, offset } };
    }
    default:
      return invalid('unknown_type');
  }
}

/** The namespaces of a `session:` id (Issue #4222, S1): the runs whose end is in the database. */
export const SESSION_NAMESPACES = ['task', 'verify', 'schedule'] as const;
export type SessionNamespace = (typeof SESSION_NAMESPACES)[number];

/**
 * `task:<id>` / `verify:<run id>` / `schedule:<execution log id>`, or null. A value
 * stored before #4222 without a namespace reads as null, which evaluates as unknown.
 */
export function parseSessionId(sessionId: string): { kind: SessionNamespace; id: string } | null {
  const match = /^(task|verify|schedule):([A-Za-z0-9._:-]{1,120})$/.exec(sessionId);
  if (!match) return null;
  const kind = match[1] as SessionNamespace;
  if (kind === 'verify' && !/^[1-9][0-9]{0,15}$/.test(match[2])) return null;
  return { kind, id: match[2] };
}

/**
 * The syntax of one condition and whether the kind takes it (§2.1, §2.3).
 *
 * @param raw - As typed; undefined or null when omitted
 */
export function parseCloseWhen(kind: MemKind, raw: unknown): CloseWhenParse {
  if (raw === undefined || raw === null) {
    const fallback = CLOSE_WHEN_DEFAULTS[kind];
    if (fallback === null) return invalid('required');
    return { ok: true, draft: { type: fallback } };
  }
  if (typeof raw !== 'string' || raw.length === 0) return invalid('not_a_string');
  if (Array.from(raw).length > CLOSE_WHEN_MAX_LENGTH) return invalid('too_long');
  const parsed = parseSyntax(raw);
  if (!parsed.ok) return parsed;
  if (parsed.draft.type !== 'promoted' && !CLOSE_WHEN_ALLOWED[kind].has(parsed.draft.type)) {
    return invalid('kind_forbids_type');
  }
  return parsed;
}

/**
 * What git has to answer before the write, for this draft. `tipOf` lists the refs to
 * try in order; the first that names a commit is the tip (Issue #4222, P2-1: `deleted`
 * keeps the tip too, read from the ref of its scope).
 */
export function closeWhenGitNeeds(draft: CloseWhenDraft): { origin: boolean; tipOf: string[] | null } {
  if ((draft.type === 'issue' || draft.type === 'pr') && draft.target === null) {
    return { origin: true, tipOf: null };
  }
  if (draft.type === 'branch') {
    const refs =
      draft.scope === 'remote' ? [`refs/remotes/origin/${draft.name}`, `refs/heads/${draft.name}`] : [`refs/heads/${draft.name}`];
    return { origin: false, tipOf: refs };
  }
  return { origin: false, tipOf: null };
}

/** Parse `origin`'s URL into host/owner/repo; null when it is not one this can name. */
export function parseOriginUrl(url: string | null): CloseWhenTarget | null {
  if (!url) return null;
  const trimmed = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp) return { host: scp[1], owner: scp[2], repo: scp[3] };
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    trimmed
  );
  if (web) return { host: web[1], owner: web[2], repo: web[3] };
  return null;
}

export interface CloseWhenBinding {
  /** Answered by git for `#N` with no target. */
  origin: CloseWhenTarget | null;
  /** Answered by git for `branch:…` (required for `merged`, kept when present for `deleted`). */
  tip: string | null;
  /** Where the item is stored. */
  repositoryId: string;
  /** The current incarnation of a worktree, made when absent; null when the worktree does not exist. */
  worktreeIncarnation: (worktreeId: string) => string | null;
  sessionGeneration: string | null;
}

/**
 * The stored JSON (§2.2), or a refusal. `promoted` stores NULL. Runs in the write's
 * synchronous stretch: the worktree's incarnation is read (and made) there.
 */
export function finalizeCloseWhen(
  draft: CloseWhenDraft,
  binding: CloseWhenBinding
): { ok: true; value: MemCloseWhen | null } | { ok: false; reason: string } {
  switch (draft.type) {
    case 'promoted':
      return { ok: true, value: null };
    case 'manual':
    case 'replaced':
      return { ok: true, value: { schema: 1, type: draft.type } };
    case 'issue':
    case 'pr': {
      const target = draft.target ?? binding.origin;
      if (!target) return { ok: false, reason: 'no_origin' };
      const base = { schema: 1 as const, host: target.host, owner: target.owner, repo: target.repo, number: draft.number };
      return draft.type === 'issue'
        ? { ok: true, value: { ...base, type: 'issue' } }
        : { ok: true, value: { ...base, type: 'pr', state: draft.state } };
    }
    case 'branch': {
      let tip = '';
      if (draft.event === 'merged') {
        if (!binding.tip || !/^[0-9a-f]{40}$/.test(binding.tip)) return { ok: false, reason: 'no_tip' };
        tip = binding.tip;
      } else if (binding.tip && /^[0-9a-f]{40}$/.test(binding.tip)) {
        // `deleted` keeps the tip when the ref exists, and is not refused without one (#4222 P2-1).
        tip = binding.tip;
      }
      return {
        ok: true,
        value: {
          schema: 1,
          type: 'branch',
          repositoryId: binding.repositoryId,
          name: draft.name,
          event: draft.event,
          into: draft.into,
          scope: draft.scope,
          tipAtCreate: tip,
        },
      };
    }
    case 'relay':
      return { ok: true, value: { schema: 1, type: 'relay', relayId: draft.relayId } };
    case 'worktree': {
      const incarnation = binding.worktreeIncarnation(draft.worktreeId);
      if (!incarnation) return { ok: false, reason: 'no_worktree' };
      return { ok: true, value: { schema: 1, type: 'worktree', worktreeId: draft.worktreeId, worktreeIncarnation: incarnation } };
    }
    case 'session':
      return { ok: true, value: { schema: 1, type: 'session', sessionId: draft.sessionId, sessionGeneration: binding.sessionGeneration } };
    case 'at':
      return { ok: true, value: { schema: 1, type: 'at', epochMs: draft.epochMs, offset: draft.offset } };
  }
}

/** Read a stored value back; null for NULL or a shape this version does not know. */
export function readStoredCloseWhen(json: string | null): MemCloseWhen | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { schema?: unknown; type?: unknown };
    if (value && value.schema === CLOSE_WHEN_SCHEMA && typeof value.type === 'string') return value as MemCloseWhen;
  } catch {
    // An unreadable value reads as unknown, which never closes anything.
  }
  return null;
}
