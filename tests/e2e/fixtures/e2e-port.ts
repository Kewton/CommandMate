/**
 * Which TCP port the E2E suite's own dev server binds (Issues #1180, #1771, #1871).
 *
 * Lives beside the specs rather than inside `playwright.config.ts` so it can be
 * unit-tested: the config module boots at import time — it mkdirs the scratch
 * state dir and shells out to `git` — so a test that wanted to exercise the port
 * rule by importing it would have to accept those side effects in `$HOME`.
 *
 * ## Why the port has to be derived at all
 *
 * `reuseExistingServer: false` (Issue #1180) means Playwright always boots its
 * own server, so two E2E runs on one machine cannot share a port: the second
 * one dies on the bind. That is fine until worktrees are verified in parallel,
 * where it turns a *resource* conflict into what reads as a *code* failure —
 * `GATE e2e FAIL exit=1` looks identical whether the branch is broken or whether
 * a sibling worktree happened to be running.
 *
 * Issue #1771 shipped the fix's raw material: every command gate is run with
 * `CM_WORKTREE_INDEX`, a small integer the verification runner claims per
 * worktree (`src/lib/verification/worktree-index.ts`) and guarantees is unique
 * among live worktrees. Adding it to a base port gives every worktree its own
 * port, which removes the collision instead of serializing around it — the
 * `mutex:` gate option would also remove the failure, but by giving up the
 * parallelism that made the second worktree worth having.
 *
 * ## Precedence
 *
 * 1. `CM_E2E_PORT` — an explicit request, and explicit always wins. It is also
 *    what makes the *control* case expressible: pinning both worktrees to one
 *    port is how Issue #1871 demonstrated that the collision is real and that
 *    the derivation is what removes it.
 * 2. `CM_WORKTREE_INDEX` — the verification runner's per-worktree number.
 * 3. Neither set — {@link DEFAULT_E2E_PORT}, i.e. offset 0. The default is not
 *    optional: a rule with no default collapses every worktree onto one port
 *    the moment the variable is missing, which is the exact failure this
 *    module exists to prevent.
 */

/** Base port. Offset 0, and the port a plain `npm run test:e2e` still uses. */
export const DEFAULT_E2E_PORT = 3177;

/** The port a developer's real CommandMate instance uses. Never test against it. */
export const FORBIDDEN_PORT = 3000;

/** Explicit override; beats the derived port. */
export const E2E_PORT_ENV = 'CM_E2E_PORT';

/** Per-worktree number injected by the verification runner (Issue #1771). */
export const WORKTREE_INDEX_ENV = 'CM_WORKTREE_INDEX';

const MIN_PORT = 1024;
const MAX_PORT = 65535;

type Env = Record<string, string | undefined>;

/** Shared tail of both paths, so an override and a derived port answer alike. */
function assertUsable(port: number, source: string, display: string): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `${source} must be an integer between ${MIN_PORT} and ${MAX_PORT}, received: ${display}`
    );
  }
  if (port === FORBIDDEN_PORT) {
    throw new Error(
      `${source} must not be ${FORBIDDEN_PORT}: that is the default CommandMate port. ` +
        `Pointing E2E at it risks driving a live server and its production DB (Issue #1180).`
    );
  }
  return port;
}

/**
 * The offset {@link WORKTREE_INDEX_ENV} asks for.
 *
 * Unset or empty is 0 — that is the documented default and the pre-#1871
 * behaviour. A *malformed* value throws instead of falling back to 0, because
 * silently reading a broken index as "worktree 0" is indistinguishable from the
 * collision this derivation removes, and it would be indistinguishable in the
 * logs too.
 */
function resolveWorktreeOffset(env: Env): number {
  const raw = env[WORKTREE_INDEX_ENV];
  if (raw === undefined || raw.trim() === '') return 0;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `${WORKTREE_INDEX_ENV} must be a non-negative integer, received: ${raw}. ` +
        `It is set by the verification runner (Issue #1771); unset it if you set it by hand.`
    );
  }
  return Number(raw.trim());
}

/** The port this run must bind. See the module comment for the precedence. */
export function resolveE2EPort(env: Env = process.env): number {
  const explicit = env[E2E_PORT_ENV];
  if (explicit !== undefined && explicit.trim() !== '') {
    return assertUsable(Number(explicit.trim()), E2E_PORT_ENV, explicit);
  }
  const port = DEFAULT_E2E_PORT + resolveWorktreeOffset(env);
  return assertUsable(port, `${DEFAULT_E2E_PORT}+${WORKTREE_INDEX_ENV}`, String(port));
}
