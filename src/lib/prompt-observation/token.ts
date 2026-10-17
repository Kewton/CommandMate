/**
 * The observation token (Issue #3755): a short-lived value the server issues
 * with each observation of a decision screen, and checks again when a sender
 * answers it (the strict `respond`, #3756).
 *
 * ## What it binds
 *
 * The instance (worktree, tool, instance), the session generation, the pane
 * (tmux session name), and what the screen asks: its kind, question, option
 * labels and approval target. A sender that presents the token with its answer
 * is checked against a FRESH observation of the same instance — if any of those
 * changed (the trust screen became a command approval, the agent was
 * relaunched, the option list moved) the token does not verify, and the answer
 * is not sent to a screen the sender never read (#3746 P4-1).
 *
 * ## Structure
 *
 * `po1.<issuedAt, base36>.<HMAC-SHA256, base64url>`. The MAC is keyed with a
 * random per-process secret, so a token is only ever valid on the server
 * process that issued it, and a restart (which also forgets every session
 * generation) invalidates all of them. The binding itself is not in the token:
 * the verifier rebuilds it from what is on screen, which is the point.
 *
 * Generation and verification are in this one module so the two cannot drift
 * about the canonical form.
 *
 * @module lib/prompt-observation/token
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getOrInitGlobal } from '@/lib/global-state';

/** How long a token verifies after it was issued. */
export const PROMPT_OBSERVATION_TOKEN_TTL_MS = 120_000;

/** How far in the future an `issuedAt` may lie before it is refused (clock steps on one host). */
const ISSUED_AT_FUTURE_TOLERANCE_MS = 5_000;

const TOKEN_PREFIX = 'po1';

/** What a token is bound to. Rebuilt from a fresh observation on verification. */
export interface ObservationTokenBinding {
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
  /** tmux session name the frame was read from. */
  sessionName: string;
  /** Epoch ms of the session generation, or null when the server knows none. */
  sessionGeneration: number | null;
  kind: string;
  question: string | null;
  /** Option labels, in draw order. */
  options: readonly string[];
  approvalTarget: string | null;
}

/** Why a token did not verify. */
export type ObservationTokenRejection = 'malformed' | 'expired' | 'not-yet-valid' | 'mismatch';

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
}

const secret = getOrInitGlobal('__promptObservationTokenSecret', () => ({ value: randomBytes(32) }));

/** The binding in one fixed, unambiguous form (JSON of an array, so no field can bleed into another). */
function canonical(binding: ObservationTokenBinding, issuedAt: number): string {
  return JSON.stringify([
    TOKEN_PREFIX,
    binding.worktreeId,
    binding.cliToolId,
    binding.instanceId,
    binding.sessionName,
    binding.sessionGeneration,
    binding.kind,
    binding.question,
    [...binding.options],
    binding.approvalTarget,
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
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  if (!/^[0-9a-z]{1,12}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
    return { ok: false, reason: 'malformed' };
  }
  const issuedAt = parseInt(parts[1], 36);
  if (!Number.isSafeInteger(issuedAt)) return { ok: false, reason: 'malformed' };

  const presented = Buffer.from(parts[2], 'base64url');
  const expected = mac(binding, issuedAt);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  if (issuedAt - now > ISSUED_AT_FUTURE_TOLERANCE_MS) return { ok: false, reason: 'not-yet-valid' };
  if (now >= observationTokenExpiresAt(issuedAt)) return { ok: false, reason: 'expired' };
  return { ok: true, issuedAt };
}
