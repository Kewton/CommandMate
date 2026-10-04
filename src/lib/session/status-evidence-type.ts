/**
 * Whether a status rests on something positive, or on the absence of a negative
 * (Issue #1924, §4 D1 決定 2).
 *
 * `'positive'` — a marker, a tool-specific idle-composer rule, or a structured
 * event said so. `'none'` — nothing on the frame could be read either way, and
 * the status is a fallback.
 *
 * The design policy adds this rather than a fifth `SessionStatus`: the value
 * domain stays four wide, because `src/cli/types/api-responses.ts` enumerates it
 * and a new member is a breaking change for every consumer older than the server
 * — including `commandmate-skills`' `orchestrate-monitor`, which reads
 * `capture --json` as its primary signal.
 */
export type StatusEvidence = 'positive' | 'none';
