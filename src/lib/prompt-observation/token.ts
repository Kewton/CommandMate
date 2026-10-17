/**
 * The observation token (Issue #3755): a short-lived value the server issues
 * with each observation of a decision screen, and checks again when a sender
 * answers it (the strict `respond`, #3756).
 *
 * ## What it binds
 *
 * The instance (worktree, tool, instance), the session generation, the pane
 * (tmux session name), which appearance of the screen it is (`./appearance`),
 * and what the screen asks: its kind, question, option labels, approval target
 * and the highlighted option. A sender that presents the token with its answer
 * is checked against a FRESH observation of the same instance — if any of those
 * changed (the trust screen became a command approval, the agent was
 * relaunched, the option list moved, the cursor moved to `No`, the screen went
 * away and came back) the token does not verify, and the answer is not sent to
 * a screen the sender never read (#3746 P4-1).
 *
 * A token is issued only when every one of those is known: never for `unknown`
 * and never without a session generation (`./observe`).
 *
 * ## Single use
 *
 * {@link consumeObservationToken} is the entry a sender's answer goes through:
 * it verifies, then records the APPEARANCE the token was issued on as answered.
 * Every observation issues a token of its own (`issuedAt` differs), so `wait`'s
 * polls leave many live tokens for one appearance; once one of them is
 * consumed, all of them are refused, until the TTL has passed.
 *
 * Generation and verification are in this one module so the two cannot drift
 * about the canonical form.
 *
 * @module lib/prompt-observation/token
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getOrInitGlobal } from '@/lib/global-state';

/** How long a token verifies after it was issued. */
export const PROMPT_OBSERVATION_TOKEN_TTL_MS = 120_000;

/** How far in the future an `issuedAt` may lie before it is refused (clock steps on one host). */
const ISSUED_AT_FUTURE_TOLERANCE_MS = 5_000;

const TOKEN_PREFIX = 'po1';

/** Longer than any token this module issues (about 56 characters); refused before parsing. */
const TOKEN_MAX_LENGTH = 80;

/** How many used, unexpired tokens are remembered at once. */
const MAX_CONSUMED_APPEARANCES = 4096;

/** What a token is bound to. Rebuilt from a fresh observation on verification. */
export interface ObservationTokenBinding {
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
  /** tmux session name the frame was read from. */
  sessionName: string;
  /** Epoch ms of the session generation. No token is issued without one. */
  sessionGeneration: number;
  /** Epoch ms this appearance of the screen was first observed (`./appearance`). */
  screenAppearedAt: number;
  kind: string;
  question: string | null;
  /** Option labels, in draw order. */
  options: readonly string[];
  approvalTarget: string | null;
  /** 1-based position of the highlighted option, or null when none is. */
  selectedPosition: number | null;
}

/**
 * Why a token did not verify. `consumed`: a token of the same appearance
 * already answered. `consumed-store-full`: too many appearances were answered
 * recently to remember one more,
 * so it is refused rather than accepted unrecorded.
 */
export type ObservationTokenRejection =
  | 'malformed'
  | 'expired'
  | 'not-yet-valid'
  | 'mismatch'
  | 'consumed'
  | 'consumed-store-full';

export type ObservationTokenVerdict =
  | { ok: true; issuedAt: number }
  | { ok: false; reason: ObservationTokenRejection };

// The secret lives on `globalThis` for the reason `auto-yes-suppression-state`
// gives (Issue #1736): the route that issues a token and the route that checks
// it are bundled separately under `next dev`, and each would otherwise hold a
// secret of its own.
declare global {
  // eslint-disable-next-line no-var
  var __promptObservationTokenSecret: { value: Buffer } | undefined;
  // eslint-disable-next-line no-var
  var __promptObservationConsumedTokens: Map<string, number> | undefined;
}

const secret = getOrInitGlobal('__promptObservationTokenSecret', () => ({ value: randomBytes(32) }));

/** Answered appearances (binding digests) → the epoch ms they are forgotten at. */
const consumed = getOrInitGlobal('__promptObservationConsumedTokens', () => new Map<string, number>());

/** The binding in one fixed, unambiguous form (JSON of an array, so no field can bleed into another). */
function canonical(binding: ObservationTokenBinding, issuedAt: number): string {
  return JSON.stringify([
    TOKEN_PREFIX,
    binding.worktreeId,
    binding.cliToolId,
    binding.instanceId,
    binding.sessionName,
    binding.sessionGeneration,
    binding.screenAppearedAt,
    binding.kind,
    binding.question,
    [...binding.options],
    binding.approvalTarget,
    binding.selectedPosition,
    issuedAt,
  ]);
}

function mac(binding: ObservationTokenBinding, issuedAt: number): Buffer {
  return createHmac('sha256', secret.value).update(canonical(binding, issuedAt)).digest();
}

/**
 * Issue a token for an observation.
 *
 * @param issuedAt - Epoch ms; the observation's own time
 */
export function issueObservationToken(binding: ObservationTokenBinding, issuedAt: number): string {
  const at = Math.floor(issuedAt);
  return `${TOKEN_PREFIX}.${at.toString(36)}.${mac(binding, at).toString('base64url')}`;
}

/** Epoch ms after which a token issued at `issuedAt` stops verifying. */
export function observationTokenExpiresAt(issuedAt: number): number {
  return Math.floor(issuedAt) + PROMPT_OBSERVATION_TOKEN_TTL_MS;
}

/**
 * Check a token against the binding of a fresh observation (the entry #3756
 * uses).
 *
 * `mismatch` covers every way the screen, pane, generation or instance can have
 * moved — on purpose one reason, since a MAC cannot say which field changed.
 *
 * @param now - Epoch ms; defaults to now
 */
export function verifyObservationToken(
  token: string,
  binding: ObservationTokenBinding,
  now: number = Date.now()
): ObservationTokenVerdict {
  if (typeof token !== 'string' || token.length > TOKEN_MAX_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  if (!/^[0-9a-z]{1,12}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
    return { ok: false, reason: 'malformed' };
  }
  const issuedAt = parseInt(parts[1], 36);
  // Only the one spelling this module issues: no leading zeros, no MAC whose
  // unused trailing bits differ — so one token has one string (the used set).
  if (!Number.isSafeInteger(issuedAt) || issuedAt.toString(36) !== parts[1]) {
    return { ok: false, reason: 'malformed' };
  }
  const presented = Buffer.from(parts[2], 'base64url');
  if (presented.toString('base64url') !== parts[2]) return { ok: false, reason: 'malformed' };

  const expected = mac(binding, issuedAt);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  if (issuedAt - now > ISSUED_AT_FUTURE_TOLERANCE_MS) return { ok: false, reason: 'not-yet-valid' };
  if (now >= observationTokenExpiresAt(issuedAt)) return { ok: false, reason: 'expired' };
  return { ok: true, issuedAt };
}

/** Forget used tokens that have expired; they no longer verify anyway. */
function sweepConsumed(now: number): void {
  for (const [digest, forgetAt] of consumed) {
    if (now >= forgetAt) consumed.delete(digest);
  }
}

/**
 * The appearance a binding names, as one digest: the binding without
 * `issuedAt` (which differs per observation) and without the highlighted
 * option (moving the cursor does not make the screen a second one to answer).
 */
function appearanceDigest(binding: ObservationTokenBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        TOKEN_PREFIX,
        binding.worktreeId,
        binding.cliToolId,
        binding.instanceId,
        binding.sessionName,
        binding.sessionGeneration,
        binding.screenAppearedAt,
        binding.kind,
        binding.question,
        [...binding.options],
        binding.approvalTarget,
      ])
    )
    .digest('base64url');
}

/**
 * Verify a token and use up the appearance it was issued on: the entry a
 * sender's answer goes through (#3756). Once a token verifies here, every
 * token of the same appearance — the same string or another observation's —
 * is refused as `consumed` for {@link PROMPT_OBSERVATION_TOKEN_TTL_MS}, which
 * outlives every token issued before the consume. A new appearance (the screen
 * went away and came back: `screenAppearedAt` moves) is a new binding and
 * passes. A token that fails verification consumes nothing.
 *
 * Consumed BEFORE the answer is sent: a send that then fails has still used
 * the appearance up (fail closed).
 *
 * @param now - Epoch ms; defaults to now
 */
export function consumeObservationToken(
  token: string,
  binding: ObservationTokenBinding,
  now: number = Date.now()
): ObservationTokenVerdict {
  const verdict = verifyObservationToken(token, binding, now);
  if (!verdict.ok) return verdict;
  sweepConsumed(now);
  const digest = appearanceDigest(binding);
  if (consumed.has(digest)) return { ok: false, reason: 'consumed' };
  if (consumed.size >= MAX_CONSUMED_APPEARANCES) return { ok: false, reason: 'consumed-store-full' };
  consumed.set(digest, Math.floor(now) + PROMPT_OBSERVATION_TOKEN_TTL_MS);
  return verdict;
}
