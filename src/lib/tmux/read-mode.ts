/**
 * Reading mode: `prefix+g` opens a squeezed transcript in a tmux popup (Issue #1623, 案A).
 *
 * Attaching to a CommandMate session shows nothing readable. The pane is pinned to
 * 200x1000 (Issue #1163), the agent draws its composer at the bottom and its
 * transcript at the top, and tmux follows the cursor — which sits at row 997.
 * Measured on a live session: an attached 72-row client sees ZERO transcript rows.
 * This module adds an on-demand way to read, WITHOUT touching the geometry that
 * status detection, Auto-Yes and the response saver depend on.
 *
 * ## This module mutates state CommandMate does not own — read before changing it
 *
 * `bind-key` writes the tmux server's GLOBAL prefix key table. Every session on
 * that server inherits it, including ones CommandMate knows nothing about. Four
 * guards keep that intervention honest, and all four are load-bearing:
 *
 * 1. **Capability probe.** `display-popup` is tmux 3.2+. Measured on 3.5a:
 *    `tmux list-commands <unknown>` exits 0 with EMPTY stdout, so the exit code is
 *    useless as a probe — the presence of output is the signal. Older tmux gets
 *    no binding at all (a genuine no-op), and the CLI viewer is the fallback.
 * 2. **Conflict check.** `list-keys -T prefix <key>` exits 1 with `unknown key`
 *    when the key is free and exits 0 printing the binding when it is taken. A key
 *    already bound to something that is not ours is left ALONE. The Issue's claim
 *    that `prefix+g` is unbound on stock tmux 3.5a is true here, but says nothing
 *    about a user's own `.tmux.conf`.
 *    ORDER IS LOAD-BEARING: guard 1 runs first, and must keep doing so. On tmux
 *    3.0 and older `list-keys` takes no key argument either (`usage: list-keys
 *    [-T key-table]`, measured in #1641), so this check degrades to "the key is
 *    always free" there. It is harmless only because those versions never reach
 *    it — guard 1 has already returned `unsupported-tmux`.
 * 3. **Session-name guard.** The binding fires `if-shell -F '#{m:mcbd-*,...}'`, so
 *    pressing the key in a non-CommandMate session does nothing (measured: the
 *    format yields 1 for `mcbd-*` sessions and 0 for everything else).
 * 4. **Opt-out that converges.** `CM_READ_MODE=off` does not merely skip
 *    installation — it REMOVES a binding a previous run installed. That is the
 *    uninstall path, and it is why shutdown does not unbind (see below).
 *
 * ## Why shutdown does not unbind
 *
 * CommandMate supports several servers at once (`commandmate start --issue N`),
 * all sharing one tmux server. Unbinding when one of them stops would rip the key
 * out from under the others, and the popup needs no CommandMate server to work —
 * it only shells out to tmux. Removal is therefore an explicit user action
 * (`CM_READ_MODE=off` + restart), not a shutdown side effect.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { PAGER_SCRIPT, PAGER_SCRIPT_FILENAME } from './read-mode-pager';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('tmux-read-mode');

/** tmux calls here are interactive-latency, not long-running. */
const TMUX_TIMEOUT = 5000;

/**
 * Session-name prefix every CommandMate tmux session carries.
 *
 * Not imported from `cli-tools/base.ts` because it is a template literal there,
 * not a constant. `tests/unit/lib/tmux/read-mode.test.ts` asserts that a real
 * `getSessionName()` still starts with this, so a rename breaks the test instead
 * of silently turning the guard into a permanent "never fire".
 */
export const MCBD_SESSION_PREFIX = 'mcbd-';

/** Key bound under the prefix table when `CM_READ_MODE_KEY` is unset. */
export const DEFAULT_READ_MODE_KEY = 'g';

/**
 * Accepted `CM_READ_MODE_KEY` values: a single alphanumeric, an F-key, either
 * optionally with a `C-` / `M-` / `S-` modifier. Deliberately narrow — a typo
 * should be rejected loudly rather than bound to something surprising in the
 * user's global key table.
 */
const READ_MODE_KEY_PATTERN = /^(?:[CMS]-)?(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2]))$/;

/** Popup geometry. Large enough to read, small enough to still see it is a popup. */
const POPUP_WIDTH = '90%';
const POPUP_HEIGHT = '85%';

/** Why {@link installReadModeBinding} did what it did. */
export type ReadModeOutcome =
  | 'installed'
  | 'already-installed'
  | 'removed'
  | 'not-installed'
  | 'disabled'
  | 'unsupported-tmux'
  | 'key-conflict'
  | 'invalid-key'
  | 'unsafe-script-path'
  | 'error';

/** Result of reconciling the binding with the configured state. */
export interface ReadModeStatus {
  /** True when the binding is present and ours after this call. */
  installed: boolean;
  outcome: ReadModeOutcome;
  key: string;
  scriptPath: string;
  /** Human-readable context for the log line; never part of the contract. */
  detail?: string;
}

/**
 * Absolute path of the materialized pager script.
 *
 * Always under `~/.commandmate/`, never the install directory and never the cwd:
 * `bind-key` is server-global and long-lived, so the path it names has to outlive
 * a `npx` cache eviction or a `cd`.
 */
export function getPagerScriptPath(): string {
  return join(homedir(), '.commandmate', 'bin', PAGER_SCRIPT_FILENAME);
}

/** True unless the user set `CM_READ_MODE=off` (or `0` / `false`). */
export function isReadModeEnabled(): boolean {
  const raw = (process.env.CM_READ_MODE ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/**
 * Resolve the configured key, or undefined when it is malformed.
 * @returns The key to bind, or undefined if `CM_READ_MODE_KEY` fails validation
 */
export function resolveReadModeKey(): string | undefined {
  const raw = (process.env.CM_READ_MODE_KEY ?? '').trim();
  if (raw === '') return DEFAULT_READ_MODE_KEY;
  return READ_MODE_KEY_PATTERN.test(raw) ? raw : undefined;
}

/**
 * Quote a path for the shell-command tmux stores in a binding.
 *
 * tmux lexes the stored command itself before handing words to `/bin/sh`, so the
 * quoting has to survive that pass. POSIX `'...'` with `'\''` for embedded quotes
 * satisfies both. Returns undefined for a path that cannot be represented (a
 * newline has no single-quoted form tmux will parse), which callers treat as
 * "do not install".
 */
export function quoteForTmuxCommand(path: string): string | undefined {
  if (path.includes('\n') || path.includes('\r')) return undefined;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * The exact `bind-key` argument vector for a given key and script path.
 * Exported so tests assert the wire form rather than a paraphrase of it.
 */
export function buildBindKeyArgs(key: string, quotedScriptPath: string): string[] {
  return [
    'bind-key',
    '-T',
    'prefix',
    key,
    'if-shell',
    '-F',
    `#{m:${MCBD_SESSION_PREFIX}*,#{session_name}}`,
    `display-popup -w ${POPUP_WIDTH} -h ${POPUP_HEIGHT} -E ${quotedScriptPath}`,
  ];
}

/**
 * Whether this tmux understands `display-popup` (3.2+).
 *
 * Probes on OUTPUT, not exit status. Measured against real binaries in
 * containers (Issue #1641; harness: `scripts/verify-legacy-tmux-readmode.sh`):
 *
 * | tmux | `list-commands display-popup` | verdict |
 * |---|---|---|
 * | 2.8 / 3.0a | exit 1, `usage: list-commands [-F format]` | false |
 * | 3.1c | exit 0, EMPTY stdout | false |
 * | 3.3a / 3.5a | exit 0, the command's help line | true |
 *
 * Two different reasons produce the same right answer, and only the output test
 * covers both: an exit-code probe calls 3.1c capable, and a stderr probe calls
 * 3.3a incapable.
 *
 * NOT a general-purpose capability prober. On tmux 3.0 and older `list-commands`
 * takes no command argument at all, so it answers `usage:` for names that tmux
 * DOES support — reusing this shape for a command that predates 3.1 would report
 * a false negative on every old tmux.
 */
export async function supportsDisplayPopup(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-commands', 'display-popup'], {
      timeout: TMUX_TIMEOUT,
    });
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Current prefix-table binding for `key`, or undefined when the key is free.
 *
 * @param key - tmux key name
 * @returns The `bind-key ...` line tmux reports, or undefined if unbound
 */
export async function readExistingBinding(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-keys', '-T', 'prefix', key], {
      timeout: TMUX_TIMEOUT,
    });
    const line = stdout.trim();
    return line === '' ? undefined : line;
  } catch {
    // Exit 1 + `unknown key: <k>` on stderr is how tmux reports "not bound".
    return undefined;
  }
}

/**
 * Write the pager script to {@link getPagerScriptPath}, if its content changed.
 *
 * Idempotent by content comparison so a restart does not churn the file's mtime,
 * and re-executable after a `chmod` accident because the mode is re-applied.
 *
 * @returns The absolute path written
 */
export function materializePagerScript(): string {
  const scriptPath = getPagerScriptPath();
  mkdirSync(dirname(scriptPath), { recursive: true });

  let current: string | undefined;
  if (existsSync(scriptPath)) {
    try {
      current = readFileSync(scriptPath, 'utf-8');
    } catch {
      current = undefined;
    }
  }
  if (current !== PAGER_SCRIPT) {
    writeFileSync(scriptPath, PAGER_SCRIPT, { mode: 0o755 });
  }
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * The exact argument vector that removes the binding again.
 *
 * Paired with {@link buildBindKeyArgs} and exported for the same reason: the
 * install and uninstall paths are asserted against these builders rather than
 * against re-typed literals, so a test cannot drift from what actually runs —
 * and `tests/unit/config/tmux-live-test-safety.test.ts` keeps its meaning,
 * because the mutating verbs appear in exactly one place, here in `src/`.
 */
export function buildUnbindKeyArgs(key: string): string[] {
  return ['unbind-key', '-T', 'prefix', key];
}

/**
 * Remove the binding, but ONLY when it is still the one we installed.
 *
 * A user who rebound the key after us owns it now; clobbering that would be the
 * same rudeness the conflict check exists to avoid.
 */
async function removeOwnBinding(key: string, scriptPath: string): Promise<ReadModeOutcome> {
  const existing = await readExistingBinding(key);
  if (existing === undefined) return 'not-installed';
  if (!existing.includes(scriptPath)) return 'key-conflict';

  await execFileAsync('tmux', buildUnbindKeyArgs(key), { timeout: TMUX_TIMEOUT });
  return 'removed';
}

/**
 * Reconcile the tmux prefix key table with the configured reading-mode state.
 *
 * Safe to call on every server start: installing twice is a no-op, and the
 * disabled path removes what an earlier run installed. Never throws — reading
 * mode is a convenience, and no failure here may keep the server from starting.
 *
 * @returns What was done, for logging and for tests
 */
export async function reconcileReadModeBinding(): Promise<ReadModeStatus> {
  const key = resolveReadModeKey();
  const scriptPath = getPagerScriptPath();

  if (key === undefined) {
    return {
      installed: false,
      outcome: 'invalid-key',
      key: process.env.CM_READ_MODE_KEY ?? '',
      scriptPath,
      detail: 'CM_READ_MODE_KEY must be a single alphanumeric or F-key, optionally with a C-/M-/S- modifier',
    };
  }

  try {
    if (!isReadModeEnabled()) {
      const outcome = await removeOwnBinding(key, scriptPath);
      return { installed: false, outcome, key, scriptPath, detail: 'CM_READ_MODE=off' };
    }

    if (!(await supportsDisplayPopup())) {
      return {
        installed: false,
        outcome: 'unsupported-tmux',
        key,
        scriptPath,
        detail: 'display-popup requires tmux 3.2+; use `commandmate capture <id> --pane` instead',
      };
    }

    const quoted = quoteForTmuxCommand(scriptPath);
    if (quoted === undefined) {
      return { installed: false, outcome: 'unsafe-script-path', key, scriptPath };
    }

    const existing = await readExistingBinding(key);
    if (existing !== undefined && !existing.includes(scriptPath)) {
      return {
        installed: false,
        outcome: 'key-conflict',
        key,
        scriptPath,
        detail: `prefix+${key} is already bound: ${existing}`,
      };
    }

    materializePagerScript();
    await execFileAsync('tmux', buildBindKeyArgs(key, quoted), { timeout: TMUX_TIMEOUT });

    return {
      installed: true,
      outcome: existing === undefined ? 'installed' : 'already-installed',
      key,
      scriptPath,
    };
  } catch (error: unknown) {
    return {
      installed: false,
      outcome: 'error',
      key,
      scriptPath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Startup entry point: reconcile and log the outcome once.
 *
 * `server.ts` must reach this through `await import()`, never a top-level static
 * import — pulling module graphs into server.ts's eval-time graph perturbs Next's
 * AsyncLocalStorage bootstrap under `tsx server.ts` and the first request that
 * compiles middleware dies (see the Skill reconciler note in server.ts).
 */
export async function initReadMode(): Promise<ReadModeStatus> {
  const status = await reconcileReadModeBinding();

  switch (status.outcome) {
    case 'installed':
    case 'already-installed':
      logger.info('read-mode:ready', { key: status.key, scriptPath: status.scriptPath });
      break;
    case 'removed':
    case 'not-installed':
    case 'disabled':
      logger.info('read-mode:disabled', { key: status.key, outcome: status.outcome });
      break;
    default:
      logger.warn('read-mode:not-installed', {
        outcome: status.outcome,
        key: status.key,
        detail: status.detail,
      });
  }

  return status;
}
