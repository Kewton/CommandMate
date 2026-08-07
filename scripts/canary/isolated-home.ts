/**
 * Throwaway HOME for the detection canary (Issue #1727).
 *
 * Scenario 4 opens Claude's `/model` overlay, which exists to WRITE the default
 * model into `~/.claude/settings.json`. So the canary runs every session against
 * a temporary HOME that is deleted afterwards, and `guards.ts` verifies the real
 * one did not change.
 *
 * Auth inside an isolated HOME
 * ----------------------------
 * Measured on macOS with Claude Code 2.1.223: the OAuth credential lives in the
 * login keychain, but Claude Code does NOT fall back to it once HOME (or
 * `CLAUDE_CONFIG_DIR`) moves — a bare isolated HOME lands on the `/login`
 * screen. So the canary resolves auth explicitly, in this order:
 *
 *   1. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` from the environment
 *      (the CI path — no keychain, no user config read), else
 *   2. the macOS keychain item `Claude Code-credentials`, copied into the
 *      throwaway HOME as `.claude/.credentials.json` (0600) and deleted with it.
 *
 * The keychain copy is refused when the access token is close to expiry: a
 * refresh performed by the throwaway session would rotate the refresh token and
 * can log the developer out of their real session.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertIsolatedHome } from './guards';

const execFileAsync = promisify(execFile);

/** Keychain service name Claude Code stores its OAuth credential under (macOS). */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Refuse to reuse a keychain credential that expires within this window: the
 * throwaway session would refresh it and rotate the developer's real token.
 */
export const CREDENTIAL_MIN_TTL_MS = 15 * 60 * 1000;

/** Environment variables that carry Claude auth and must survive sanitization. */
export const AUTH_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/**
 * Environment variables the parent process may carry that must NOT reach the
 * throwaway session: they either point at the outer Claude Code session or at
 * the user's tmux server.
 */
export const STRIPPED_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CONFIG_DIR',
  'TMUX',
  'TMUX_PANE',
  'TMUX_TMPDIR',
] as const;

/**
 * Build the environment for the private tmux server and the `claude` process.
 *
 * Pure, so the isolation is unit-testable. Drops the outer session's
 * `CLAUDE_CODE_*` bookkeeping (except the auth token), drops `$TMUX` so nothing
 * downstream can resolve the user's server, and pins HOME to the throwaway dir.
 */
export function sanitizeEnv(
  parentEnv: NodeJS.ProcessEnv,
  isolatedHome: string
): NodeJS.ProcessEnv {
  // Built as a plain record: the project augments ProcessEnv with a required
  // NODE_ENV, so an empty ProcessEnv literal would not typecheck
  // (same approach as sanitizeNpxEnv in src/cli/utils/npx-runner.ts).
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if ((STRIPPED_ENV_VARS as readonly string[]).includes(key)) continue;
    if (key.startsWith('CLAUDE_CODE_') && !(AUTH_ENV_VARS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  out.HOME = isolatedHome;
  // Marker so a stray session is identifiable, and so scenarios can be told
  // apart from a developer's own shell if one is ever left behind.
  out.CM_DETECTION_CANARY = '1';
  return out as NodeJS.ProcessEnv;
}

/** Shape of `~/.claude.json` fields the canary seeds. */
export interface SeedConfigInput {
  /** Absolute working directories the scenarios run `claude` in. */
  workingDirectories: readonly string[];
  /** `oauthAccount` copied from the real config (identity, not a token). */
  oauthAccount?: unknown;
  /** `userID` copied from the real config. */
  userID?: unknown;
  /** Version string used for `lastOnboardingVersion`. */
  claudeVersion: string;
}

/**
 * Build the `~/.claude.json` seed.
 *
 * Without it the throwaway session opens the theme picker, then the login-method
 * picker, then the trust dialog — three modal screens ahead of every scenario.
 * Seeding them removes that noise; `session.ts` still dismisses them defensively
 * in case a new Claude version adds one back.
 */
export function buildSeedConfig(input: SeedConfigInput): Record<string, unknown> {
  const projects: Record<string, unknown> = {};
  for (const dir of input.workingDirectories) {
    projects[dir] = {
      allowedTools: [],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
      projectOnboardingSeenCount: 3,
    };
  }
  const seed: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: input.claudeVersion,
    numStartups: 5,
    autoUpdates: false,
    // Suppress the "what's new" / release-notes interstitial for this version.
    lastReleaseNotesSeen: input.claudeVersion,
    projects,
  };
  if (input.oauthAccount !== undefined) seed.oauthAccount = input.oauthAccount;
  if (input.userID !== undefined) seed.userID = input.userID;
  return seed;
}

/**
 * Validate a keychain credential payload before copying it into the throwaway
 * HOME. Pure so the TTL guard is unit-testable.
 *
 * @throws when the payload is not a Claude OAuth credential, is already
 *   expired, or expires within `minTtlMs` (see {@link CREDENTIAL_MIN_TTL_MS}).
 */
export function assertCredentialUsable(payload: unknown, nowMs: number, minTtlMs: number): void {
  const oauth =
    typeof payload === 'object' && payload !== null
      ? (payload as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth
      : undefined;
  if (!oauth || typeof oauth !== 'object') {
    throw new Error(
      'canary: keychain credential has no claudeAiOauth section — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY instead'
    );
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== 'number') {
    throw new Error('canary: keychain credential has no numeric expiresAt — refusing to copy it');
  }
  const remainingMs = expiresAt - nowMs;
  if (remainingMs <= 0) {
    throw new Error('canary: the Claude credential in the keychain has expired — run `claude` once to refresh it');
  }
  if (remainingMs < minTtlMs) {
    throw new Error(
      `canary: the Claude credential expires in ${Math.round(remainingMs / 60000)} min. ` +
        `Refusing to copy it: the throwaway session would refresh and rotate your real refresh token. ` +
        `Re-run later, or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY.`
    );
  }
}

/** How the throwaway session authenticates. */
export type AuthSource =
  | { kind: 'env'; variable: string }
  | { kind: 'keychain'; service: string };

export interface IsolatedHome {
  /** Absolute path of the throwaway HOME. */
  readonly root: string;
  /** `<root>/work/<scenarioId>` for a scenario. */
  workingDirectoryFor(scenarioId: string): string;
  /** Environment for the private tmux server and `claude`. */
  readonly env: NodeJS.ProcessEnv;
  /** How auth was resolved (reported in the run summary). */
  readonly authSource: AuthSource;
  /** Delete the throwaway HOME. */
  dispose(): void;
}

async function readKeychainCredential(service: string): Promise<string> {
  const { stdout } = await execFileAsync('security', [
    'find-generic-password',
    '-s',
    service,
    '-a',
    os.userInfo().username,
    '-w',
  ]);
  return stdout.trim();
}

function readRealClaudeConfig(realHome: string): Record<string, unknown> {
  const configPath = path.join(realHome, '.claude.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface CreateIsolatedHomeOptions {
  realHome: string;
  scenarioIds: readonly string[];
  claudeVersion: string;
  parentEnv: NodeJS.ProcessEnv;
  /**
   * Model written into the throwaway `settings.json` (e.g. `haiku`). Only the
   * three scenarios that send a prompt spend tokens, so this is the cost lever
   * for unattended runs. Unset means Claude's default.
   */
  model?: string;
  /** Overridable for tests / debugging. */
  tmpDir?: string;
  now?: () => number;
}

/**
 * Create and seed the throwaway HOME.
 *
 * The directory is created with 0700 under the OS temp dir and holds a copy of
 * the Claude credential, so it is deleted in `dispose()` (and by `--keep` only
 * when the developer explicitly asks to inspect it).
 */
export async function createIsolatedHome(options: CreateIsolatedHomeOptions): Promise<IsolatedHome> {
  const now = options.now ?? Date.now;
  const base = options.tmpDir ?? os.tmpdir();
  // realpath matters: on macOS `os.tmpdir()` is /var/folders/... which is a
  // symlink to /private/var/folders/.... Claude keys its per-project trust state
  // by the RESOLVED path, so seeding `projects` with the symlinked path leaves
  // the trust dialog waiting in front of every scenario.
  const root = realpathSync(mkdtempSync(path.join(base, 'cmate-canary-home-')));
  assertIsolatedHome(options.realHome, root);

  const claudeDir = path.join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

  const workingDirectories = options.scenarioIds.map(id => path.join(root, 'work', id));
  for (const dir of workingDirectories) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const realConfig = readRealClaudeConfig(options.realHome);
  const seed = buildSeedConfig({
    workingDirectories,
    claudeVersion: options.claudeVersion,
    oauthAccount: realConfig.oauthAccount,
    userID: realConfig.userID,
  });
  writeFileSync(path.join(root, '.claude.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });

  // Pin the theme so the first-run theme picker never appears, and leave every
  // other setting at its default: the canary must observe the DEFAULT Claude
  // UI, not one shaped by the developer's settings. `model` is the one optional
  // exception — a cost lever for unattended runs (see docs/qa/detection-canary.md).
  const settings: Record<string, string> = { theme: 'dark' };
  if (options.model) settings.model = options.model;
  writeFileSync(path.join(claudeDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });

  const env = sanitizeEnv(options.parentEnv, root);

  let authSource: AuthSource | null = null;
  for (const variable of AUTH_ENV_VARS) {
    if (options.parentEnv[variable]) {
      authSource = { kind: 'env', variable };
      break;
    }
  }

  if (!authSource) {
    if (process.platform !== 'darwin') {
      throw new Error(
        'canary: no Claude auth available. Set CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) or ANTHROPIC_API_KEY before running.'
      );
    }
    let raw: string;
    try {
      raw = await readKeychainCredential(KEYCHAIN_SERVICE);
    } catch {
      rmSync(root, { recursive: true, force: true });
      throw new Error(
        `canary: no Claude auth available — keychain item "${KEYCHAIN_SERVICE}" not found and no ` +
          `CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the environment.`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      rmSync(root, { recursive: true, force: true });
      throw new Error('canary: keychain credential is not JSON — refusing to copy it');
    }
    try {
      assertCredentialUsable(parsed, now(), CREDENTIAL_MIN_TTL_MS);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    writeFileSync(path.join(claudeDir, '.credentials.json'), `${raw}\n`, { mode: 0o600 });
    authSource = { kind: 'keychain', service: KEYCHAIN_SERVICE };
  }

  return {
    root,
    env,
    authSource,
    workingDirectoryFor(scenarioId: string): string {
      return path.join(root, 'work', scenarioId);
    },
    dispose(): void {
      assertIsolatedHome(options.realHome, root);
      // Retries matter: the `claude` processes are killed a moment earlier and
      // can still be flushing state into HOME while the tree is being removed,
      // which otherwise leaves an empty directory (or a raced ENOTEMPTY) behind.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      }
    },
  };
}
