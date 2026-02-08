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
 * Issue #135: CM_DB_PATH removed - use getDefaultDbPath() instead
 * for dynamic path resolution based on install type
 */
export const ENV_DEFAULTS = {
  CM_PORT: 3000,
  CM_BIND: '127.0.0.1',
  // CM_DB_PATH removed - Issue #135: use getDefaultDbPath() instead
  CM_LOG_LEVEL: 'info',
  CM_LOG_FORMAT: 'text',
} as const;

/**
 * Default root directory for worktrees
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
