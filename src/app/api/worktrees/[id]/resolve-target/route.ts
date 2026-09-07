/**
 * API Route: GET /api/worktrees/:id/resolve-target
 *
 * Issue #1925 (design §4 D5 決定 1): the server is the authority on which CLI
 * tool and instance a request targets, and this is how the CLI asks. Before it
 * existed the CLI carried its own copy of the precedence rules — a copy that
 * was missing the primary-anchor stage, so `--instance codex` against a roster
 * that never registered `codex` resolved to the worktree default on the client
 * and to codex on the server. Two authorities, two answers, one tmux session
 * name built from whichever one happened to run.
 *
 * Read-only by construction (DR3-015): a request whose explicit tool
 * contradicts the roster still answers 200 with the roster's answer and the
 * contradiction attached, because `capture` polls this path and an error here
 * would stall the monitor loops that treat a non-zero capture as "skip this
 * poll". Callers with a side effect refuse the contradiction themselves.
 *
 * Issue #2376 adds one stage AFTER the four this route already delegates to:
 * an `?instance=` that names no roster row and is no CLI tool id is looked up
 * as an ALIAS. That is the name the GUI shows and the only name a human has for
 * `codex-2` — `commandmate instances <id> alias codex-2 "レビュー担当"` puts it
 * there — and until now it reached nothing. The stage is last on purpose: every
 * request that resolved before this Issue resolves to the same answer, byte for
 * byte, because it never gets here.
 */

import { NextRequest, NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { getAgentInstances } from '@/lib/db/agent-instances-db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getClientIp } from '@/lib/security/ip-restriction';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';
import {
  CLI_TOOL_IDS,
  isCliToolType,
  isValidInstanceId,
  MAX_AGENT_ALIAS_LENGTH,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import {
  resolveSessionTarget,
  type SessionTargetConflict,
  type SessionTargetResolvedBy,
} from '@/lib/session/resolve-session-target';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/resolve-target');

/**
 * Per-IP budget (DR4-015 / S20). Applied — unlike `/api/capabilities` — because
 * every call reads the worktree row and the roster. Sized for the polling
 * callers rather than for a human: `capture` resolves once per poll at the
 * 5-second cadence the monitor skills use, and several workers share one server.
 */
const rateLimiter = createRequestRateLimiter({ limit: 240, windowMs: 60_000 });

/** Response shape consumed by the CLI's thin resolution client. */
export interface ResolveTargetResponse {
  cliToolId: CLIToolType;
  instanceId: string;
  resolvedBy: SessionTargetResolvedBy;
  /** Null rather than absent so the field is always readable. */
  conflict: SessionTargetConflict | null;
}

/**
 * Machine code for an `?instance=` that two or more roster rows answer to
 * (Issue #2376). Read by the CLI, which turns it into exit 2 and prints the
 * candidates rather than picking one.
 *
 * NOT exported: Next.js accepts only its own names as route-module exports, and
 * `scripts/check-route-exports.mjs` exists because `export const
 * SERVER_CAPABILITIES` in a route file broke `npm run build` on develop
 * (Issue #1946). The CLI keeps its own copy in `commands/instances.ts`, the same
 * arrangement `send.ts` has with `PROMPT_WAITING`.
 */
const AMBIGUOUS_INSTANCE_ALIAS = 'ambiguous_instance_alias';

/**
 * Longest `?instance=` this route will look at.
 *
 * An alias is bounded by {@link MAX_AGENT_ALIAS_LENGTH} where it is written
 * (`agent-instances-validator`), so anything longer cannot be one and there is
 * nothing to search for. The bound is what keeps a long query string from
 * turning into a roster scan.
 */
const MAX_INSTANCE_SELECTOR_LENGTH = MAX_AGENT_ALIAS_LENGTH;

/**
 * Whether `value` could be an alias somebody actually set.
 *
 * Deliberately permissive about the CHARACTERS — an alias is free text and
 * `レビュー担当` is the motivating example — and strict about the two things
 * that make a value unusable as a lookup key: emptiness and length. Control
 * characters are excluded because nothing can type them into the alias field
 * and a request carrying them is not asking a real question.
 */
function isPlausibleAlias(value: string): boolean {
  if (value.length === 0 || value.length > MAX_INSTANCE_SELECTOR_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Roster rows whose alias answers to `selector`.
 *
 * Exact match first, and only when nothing matches exactly is the comparison
 * relaxed to case-insensitive: `Codex` and `codex` are different aliases if
 * somebody took the trouble to write both, and the looser pass exists for the
 * operator typing `codex 2` at a shell rather than to merge two rows that were
 * declared distinct.
 */
function matchAlias(instances: AgentInstance[], selector: string): AgentInstance[] {
  const exact = instances.filter((inst) => inst.alias === selector);
  if (exact.length > 0) return exact;

  const folded = selector.trim().toLowerCase();
  return instances.filter((inst) => inst.alias.trim().toLowerCase() === folded);
}

/** What {@link resolveInstanceSelector} decided about an `?instance=` value. */
type InstanceSelectorResolution =
  | { kind: 'instance'; instanceId: string }
  | { kind: 'ambiguous'; candidates: AgentInstance[] };

/**
 * Turn an `?instance=` value into the instance id the resolver is given.
 *
 * The last stage of the chain, and additive by construction: a value that names
 * a roster row, or that is itself a CLI tool id (the primary anchor, #868), or
 * that is an ad-hoc id the roster has never seen, is handed through untouched —
 * exactly what happened before Issue #2376. Only a value that no id explains is
 * looked up as an alias.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (already canonicalized and validated)
 * @param selector - The raw `?instance=` value
 * @returns The instance id to resolve with, or the ambiguity to report
 */
function resolveInstanceSelector(
  db: Database.Database,
  worktreeId: string,
  selector: string,
): InstanceSelectorResolution {
  // A value that cannot be an instance id can only be an alias; a value that
  // can be one is an id first. Reading the roster once serves both questions.
  const instances = getAgentInstances(db, worktreeId);

  if (isValidInstanceId(selector)) {
    if (instances.some((inst) => inst.id === selector)) {
      return { kind: 'instance', instanceId: selector };
    }
    // The primary anchor outranks any alias: `--instance codex` has meant
    // "codex's primary instance" since #868, with or without a roster row.
    if (isCliToolType(selector)) {
      return { kind: 'instance', instanceId: selector };
    }
  }

  const matches = matchAlias(instances, selector);
  if (matches.length === 1) {
    return { kind: 'instance', instanceId: matches[0].id };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', candidates: matches };
  }

  // No row and no alias. An id-shaped value is the ad-hoc instance
  // `send --instance codex-3` creates; anything else is a name for nothing, and
  // the resolver's own precedence chain answers for both.
  return { kind: 'instance', instanceId: selector };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const clientIp = getClientIp(request.headers) ?? 'unknown';
    const limit = rateLimiter.check(clientIp);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } }
      );
    }

    const db = getDbInstance();
    // The roster lookup is scoped to this worktree, so a 404 here is what stops
    // an instance id from resolving against somebody else's worktree.
    if (!getWorktreeById(db, id)) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const url = new URL(request.url);

    const instanceParam = url.searchParams.get('instance');
    // Issue #2376: an instance id OR an alias. The two shapes are checked
    // together because the caller does not know which one it holds — the GUI's
    // "delegate to this session" menu and a human at a shell both name a
    // session by whatever they can see.
    if (
      instanceParam !== null
      && !isValidInstanceId(instanceParam)
      && !isPlausibleAlias(instanceParam)
    ) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }

    const cliToolParam = url.searchParams.get('cliTool');
    if (cliToolParam !== null && !(CLI_TOOL_IDS as readonly string[]).includes(cliToolParam)) {
      return NextResponse.json(
        { error: `Invalid cliTool: '${cliToolParam}'. Valid values: ${CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Issue #2376: resolve the SELECTOR to an instance id before the resolver
    // sees it. An ambiguity is the one thing this route cannot answer 200 to —
    // there is no "the roster's verdict" to fall back on, only two of them — so
    // it is a 409 carrying both candidates rather than a silent pick.
    let instanceId: string | undefined;
    if (instanceParam !== null) {
      const selected = resolveInstanceSelector(db, id, instanceParam);
      if (selected.kind === 'ambiguous') {
        return NextResponse.json(
          {
            error:
              `Instance '${instanceParam}' matches ${selected.candidates.length} roster entries. `
              + 'Name one by its instance id.',
            code: AMBIGUOUS_INSTANCE_ALIAS,
            // `issues` because that is the field the CLI already prints in full
            // (see ApiErrorPayload): one line per candidate, ready to copy.
            issues: selected.candidates.map(
              (inst) => `${inst.id} (${inst.cliTool}) — alias "${inst.alias}"`,
            ),
          },
          { status: 409 }
        );
      }
      instanceId = selected.instanceId;
    }

    const target = resolveSessionTarget(db, id, {
      instanceId,
      requestedCliTool: (cliToolParam as CLIToolType | null) ?? undefined,
    });

    const body: ResolveTargetResponse = {
      cliToolId: target.cliToolId,
      instanceId: target.instanceId,
      resolvedBy: target.resolvedBy,
      conflict: target.conflict ?? null,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-resolving-session-target:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to resolve session target' },
      { status: 500 }
    );
  }
}
