/**
 * The message length `send` is verified to deliver whole (Issue #2464), shared by
 * the CLI's `--help` and the server (Issue #4274).
 *
 * The largest body sent through the paste path to claude, codex, command-code and
 * antigravity and found byte-identical in each tool's own transcript
 * (`docs/design/2464-long-body-repro-matrix.md`). For a body the operator wrote it
 * is a documented guarantee, not an enforced cap: a longer message takes the same
 * path and the same check. The server reads it only when it would ADD a session
 * brief in front of the operator's body (`docs/design/session-boundary-brief-4274.md`
 * §6): the brief is left off rather than pushing the whole past what was verified,
 * and the operator's body is never cut.
 */

/** Verified size, in KiB. */
export const SEND_VERIFIED_MAX_KIB = 48;

/** Verified size, in UTF-8 bytes. */
export const SEND_VERIFIED_MAX_BYTES = SEND_VERIFIED_MAX_KIB * 1024;

/** Verified line count (`"\n"` count + 1). */
export const SEND_VERIFIED_MAX_LINES = 240;
