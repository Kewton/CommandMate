/**
 * Environment Setup Utility
 * Issue #96: npm install CLI support
 * Issue #136: DRY refactoring - isGlobalInstall and getConfigDir extracted to install-context.ts
 * Migrated from scripts/setup-env.sh
 */

import {
  existsSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'fs';
import { join, normalize } from 'path';
import { homedir } from 'os';
import {
  EnvConfig,
  EnvSetupOptions,
  ValidationResult,
} from '../types';

// Issue #136: Import from install-context.ts to avoid circular imports
// Re-export for backward compatibility
import {
  isGlobalInstall as _isGlobalInstall,
  getConfigDir as _getConfigDir,
} from './install-context';

export { isGlobalInstall, getConfigDir } from './install-context';

/**
 * Default environment configuration values
 * SF-4: DRY - Centralized defaults
 *
 * These are the static values `commandmate init` writes into a new .env file.
 * They are not the runtime resolution order: getEnv() reads every CM_* value
 * from the process environment regardless of what appears here.
 *
 * Issue #135: CM_DB_PATH has no static default - it depends on the install type,
 * so it is resolved dynamically by getDefaultDbPath() instead.
 */
export const ENV_DEFAULTS = {
  CM_PORT: 3000,
  CM_BIND: '127.0.0.1',
  // CM_DB_PATH: resolved by getDefaultDbPath() - see Issue #135 note above.
  // This absence does not make CM_DB_PATH unsupported as an environment
  // variable; getEnv() honours it (Issue #1267).
  CM_LOG_LEVEL: 'info',
  CM_LOG_FORMAT: 'text',
} as const;

/**
 * Default managed repository directory (CM_ROOT_DIR).
 *
 * CM_ROOT_DIR is the scope CommandMate may manage: repositories must be inside
 * it to be registered, and clones are placed under it. It is a container of
 * repositories, not a repository itself, and is never scanned directly
 * (Issue #1328).
 */
export const DEFAULT_ROOT_DIR = join(homedir(), 'repos');

/**
 * Get the default database path based on install type
 * Issue #135: Dynamic DB path resolution
 * Issue #136: Uses isGlobalInstall from install-context.ts
 *
 * For global installs: ~/.commandmate/data/cm.db
 * For local installs: <cwd>/data/cm.db (as absolute path)
 *
 * @returns Absolute path to the default database file
 */
export function getDefaultDbPath(): string {
  if (_isGlobalInstall()) {
    return join(homedir(), '.commandmate', 'data', 'cm.db');
  }
  // Use path module for absolute path resolution
  const cwd = process.cwd();
  return join(cwd, 'data', 'cm.db');
}

/**
 * Get the path to .env file based on install type
 * Issue #119: Global install uses ~/.commandmate/, local uses cwd
 * Issue #136: Uses isGlobalInstall from install-context.ts
 * Issue #136: Added issueNo parameter for worktree-specific .env files
 *
 * @param issueNo - Optional issue number for worktree-specific .env
 * @returns Path to .env file
 */
export function getEnvPath(issueNo?: number): string {
  if (_isGlobalInstall()) {
    const configDir = join(homedir(), '.commandmate');

    // Create config directory if it doesn't exist
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }

    // Issue #136: Worktree-specific .env file
    if (issueNo !== undefined) {
      const envsDir = join(configDir, 'envs');
      if (!existsSync(envsDir)) {
        mkdirSync(envsDir, { recursive: true, mode: 0o700 });
      }
      return join(envsDir, `${issueNo}.env`);
    }

    return join(configDir, '.env');
  }

  // Local install - use current working directory
  // Note: Worktree-specific .env not supported in local install mode
  return join(process.cwd(), '.env');
}

/**
 * Resolve path securely by resolving symlinks and verifying within allowed directory
 * Issue #125: Path traversal protection (OWASP A01:2021 - Broken Access Control)
 *
 * @param targetPath - The path to resolve and verify
 * @param allowedBaseDir - The base directory that targetPath must be within
 * @returns The resolved real path
 * @throws Error if path resolves outside allowed directory
 */
export function resolveSecurePath(targetPath: string, allowedBaseDir: string): string {
  const realPath = realpathSync(targetPath);
  const realBaseDir = realpathSync(allowedBaseDir);

  if (!realPath.startsWith(realBaseDir)) {
    throw new Error(`Path traversal detected: ${targetPath} resolves outside of ${allowedBaseDir}`);
  }

  return realPath;
}

// Note: getConfigDir is now exported from install-context.ts
// The re-export above provides backward compatibility

/**
 * Get the PIDs directory path
 * Issue #136: Centralized pids directory path resolution
 *
 * @returns Path to pids directory
 */
export function getPidsDir(): string {
  const configDir = _getConfigDir();
  return join(configDir, 'pids');
}

/**
 * Get the PID file path based on install type
 * Issue #125: DRY principle - centralized PID file path resolution
 * Issue #136: Uses getConfigDir from install-context.ts
 *
 * @param issueNo - Optional issue number for worktree-specific PID file
 * @returns Path to PID file (uses getConfigDir for consistency)
 */
export function getPidFilePath(issueNo?: number): string {
  const configDir = _getConfigDir();
  if (issueNo !== undefined) {
    // Issue #136: Worktree-specific PID file in pids/ directory
    const pidsDir = getPidsDir();
    if (!existsSync(pidsDir)) {
      mkdirSync(pidsDir, { recursive: true, mode: 0o700 });
    }
    return join(pidsDir, `${issueNo}.pid`);
  }
  // Default: main PID file for backward compatibility
  return join(configDir, '.commandmate.pid');
}

/**
 * Sanitize input by removing control characters
 * SF-SEC-3: Input sanitization
 */
export function sanitizeInput(input: string): string {
  // Remove control characters (0x00-0x1F and 0x7F)
  return input.replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Sanitize path input
 * SF-SEC-3: Path sanitization
 */
export function sanitizePath(input: string): string {
  const sanitized = sanitizeInput(input);
  return normalize(sanitized);
}

/**
 * Normalize a comma-separated CM_BROWSE_ROOTS value (Issue #1517).
 *
 * @param input - Raw comma-separated directories, or undefined.
 * @param resolveEntry - Per-entry resolver; pass `resolvePath` to expand `~`.
 * @returns Normalized comma-separated value, or undefined when empty.
 */
export function normalizeBrowseRoots(
  input: string | undefined,
  resolveEntry: (entry: string) => string = sanitizePath
): string | undefined {
  if (!input) return undefined;

  const roots = Array.from(
    new Set(
      input
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map(resolveEntry)
    )
  );

  return roots.length > 0 ? roots.join(',') : undefined;
}

/**
 * Validate port number
 * SF-SEC-3: Port validation
 */
export function validatePort(input: string): number {
  const port = parseInt(input, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return port;
}

/**
 * Escape value for .env file
 * SF-SEC-3: Safe .env value escaping
 */
export function escapeEnvValue(value: string): string {
  // Escape backslashes and double quotes
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Quote if contains special characters
  if (/[\s"'$`!]/.test(value)) {
    return `"${escaped}"`;
  }

  return value;
}

/**
 * The VAPID variables already present in an `.env`, if any (Issue #2123).
 *
 * `init --force` rewrites the file from scratch. Regenerating the key pair there
 * would be a data-loss bug wearing a helpful face: the public key is baked into
 * every `PushSubscription` a browser has already created, so a new pair silently
 * orphans every device that had subscribed — they stay in `push_subscriptions`,
 * every send fails, and the reader is told nothing (which is the exact failure
 * mode Issue #2124 was filed about). So an existing pair is carried across.
 *
 * Deliberately a minimal parser rather than `dotenv`: this reads a file that is
 * about to be OVERWRITTEN, so it must not populate `process.env` as a side effect
 * — `dotenv.config()` does, and would leak the old keys into the running CLI.
 * It handles the shapes `escapeEnvValue()` writes (bare, or double-quoted with
 * backslash escapes) and ignores everything else, because anything it cannot
 * parse is safest treated as "not configured": the caller then generates a fresh
 * pair, which is the same outcome as before this Issue.
 *
 * Never throws — an unreadable file means "no keys", not a failed `init`.
 *
 * @param envPath - The `.env` to read.
 * @returns Only the keys that were found; missing ones are absent.
 */
export function readExistingVapidKeys(
  envPath: string
): Partial<Pick<EnvConfig, 'CM_VAPID_PUBLIC_KEY' | 'CM_VAPID_PRIVATE_KEY' | 'CM_VAPID_SUBJECT'>> {
  const wanted = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
  const found: Record<string, string> = {};

  try {
    if (!existsSync(envPath)) return {};
    for (const rawLine of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq <= 0) continue;

      const name = line.slice(0, eq).trim();
      if (!(wanted as readonly string[]).includes(name)) continue;

      const raw = line.slice(eq + 1).trim();
      const value =
        raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
          ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1')
          : raw;
      if (value.length > 0) found[name] = value;
    }
  } catch {
    return {};
  }

  return found;
}

/**
 * Environment setup utility
 */
export class EnvSetup {
  private envPath: string;

  constructor(envPath?: string) {
    this.envPath = envPath || join(process.cwd(), '.env');
  }

  /**
   * Create .env file
   * SF-SEC-1: Sets file permissions to 0600
   */
  async createEnvFile(
    config: EnvConfig,
    options: EnvSetupOptions = {}
  ): Promise<void> {
    if (existsSync(this.envPath) && !options.force) {
      throw new Error('.env file already exists. Use --force to overwrite.');
    }

    // Build .env content
    const lines: string[] = [
      '# CommandMate Environment Configuration',
      '# Generated by commandmate init',
      '',
      `CM_ROOT_DIR=${escapeEnvValue(config.CM_ROOT_DIR)}`,
      `CM_PORT=${config.CM_PORT}`,
      `CM_BIND=${config.CM_BIND}`,
      `CM_DB_PATH=${escapeEnvValue(config.CM_DB_PATH)}`,
      `CM_LOG_LEVEL=${config.CM_LOG_LEVEL}`,
      `CM_LOG_FORMAT=${config.CM_LOG_FORMAT}`,
    ];

    // Issue #1517: omitted entirely when unset, so the file does not imply that
    // browsing needs configuring — CM_ROOT_DIR is always browsable.
    if (config.CM_BROWSE_ROOTS) {
      lines.push(`CM_BROWSE_ROOTS=${escapeEnvValue(config.CM_BROWSE_ROOTS)}`);
    }

    // Issue #2123: the Web Push trio, written as a set or not at all (see
    // EnvConfig). The comment above them is the only place a reader learns that
    // the private key is a secret and that the file is not meant to be committed
    // — `.gitignore` covers `.env`, but a copied file is not covered by anything.
    if (config.CM_VAPID_PUBLIC_KEY && config.CM_VAPID_PRIVATE_KEY) {
      lines.push('');
      lines.push('# Web Push (phone notifications). Setup: docs/user-guide/webapp-guide.md');
      lines.push('# CM_VAPID_PRIVATE_KEY is a secret: never commit it, never share it.');
      lines.push('# Replacing this pair orphans every device that has already subscribed.');
      lines.push(`CM_VAPID_PUBLIC_KEY=${escapeEnvValue(config.CM_VAPID_PUBLIC_KEY)}`);
      lines.push(`CM_VAPID_PRIVATE_KEY=${escapeEnvValue(config.CM_VAPID_PRIVATE_KEY)}`);
      if (config.CM_VAPID_SUBJECT) {
        // Issue #2124: the `sub` claim Apple validates. Written explicitly rather
        // than left to the built-in default so it is visible and editable.
        lines.push(`CM_VAPID_SUBJECT=${escapeEnvValue(config.CM_VAPID_SUBJECT)}`);
      }
    }

    lines.push('');

    const content = lines.join('\n');

    // Write with secure permissions
    writeFileSync(this.envPath, content, { mode: 0o600 });

    // Ensure permissions are set (for existing file updates)
    chmodSync(this.envPath, 0o600);
  }

  /**
   * Backup existing .env file
   */
  async backupExisting(): Promise<string | null> {
    if (!existsSync(this.envPath)) {
      return null;
    }

    const timestamp = Date.now();
    const backupPath = `${this.envPath}.backup.${timestamp}`;
    copyFileSync(this.envPath, backupPath);

    return backupPath;
  }

  /**
   * Validate configuration
   */
  validateConfig(config: EnvConfig): ValidationResult {
    const errors: string[] = [];

    // Validate port
    if (config.CM_PORT < 1 || config.CM_PORT > 65535) {
      errors.push('Invalid port: must be between 1 and 65535');
    }

    // Validate bind address
    const validBinds = ['127.0.0.1', '0.0.0.0', 'localhost'];
    if (!validBinds.includes(config.CM_BIND)) {
      errors.push(`Invalid bind address: must be one of ${validBinds.join(', ')}`);
    }

    // Validate log level
    const validLogLevels = ['debug', 'info', 'warn', 'error'];
    if (!validLogLevels.includes(config.CM_LOG_LEVEL)) {
      errors.push(`Invalid log level: must be one of ${validLogLevels.join(', ')}`);
    }

    // Validate log format
    const validLogFormats = ['text', 'json'];
    if (!validLogFormats.includes(config.CM_LOG_FORMAT)) {
      errors.push(`Invalid log format: must be one of ${validLogFormats.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
