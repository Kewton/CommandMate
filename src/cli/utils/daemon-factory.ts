/**
 * DaemonManager Factory
 * Issue #136: Phase 3 - Task 3.1 - DaemonManager abstraction
 *
 * Provides Factory pattern for creating DaemonManager instances with
 * issue-specific configurations while maintaining backward compatibility
 * with existing DaemonManager(pidFilePath: string) constructor.
 *
 * MF-CONS-002: Backward compatibility with existing constructor maintained
 * SF-002: Factory pattern for DaemonManager creation
 */

import { DaemonManager } from './daemon';
import { PidPathResolver, DbPathResolver } from './resource-resolvers';
import { getEnvPath } from './env-setup';
import type { DaemonStatus, StartOptions } from '../types';

/**
 * DaemonManager interface (abstraction)
 * Defines the contract for daemon management operations
 */
export interface IDaemonManager {
  /**
   * Start the daemon process
   * @param options - Start options
   * @returns Process ID of the started daemon
   */
  start(options: StartOptions): Promise<number>;

  /**
   * Stop the daemon process
   * @param force - Use SIGKILL instead of SIGTERM
   * @returns true if stopped successfully
   */
  stop(force?: boolean): Promise<boolean>;

  /**
   * Get daemon status
   * @returns Status object or null if no PID file
   */
  getStatus(): Promise<DaemonStatus | null>;

  /**
   * Check if daemon is running
   * @returns true if running
   */
  isRunning(): Promise<boolean>;
}

/**
 * Configuration for DaemonManagerWrapper
 */
export interface DaemonManagerConfig {
  /** PID file path */
  pidPath: string;
  /** Environment file path */
  envPath: string;
  /** Database file path */
  dbPath: string;
  /** Issue number (undefined for main server) */
  issueNo?: number;
}

/**
 * Wrapper around existing DaemonManager to implement IDaemonManager
 * MF-CONS-002: Uses existing DaemonManager(pidFilePath: string) internally
 */
export class DaemonManagerWrapper implements IDaemonManager {
  private innerManager: DaemonManager;
  private config: DaemonManagerConfig;

  constructor(innerManager: DaemonManager, config: DaemonManagerConfig) {
    this.innerManager = innerManager;
    this.config = config;
  }

  async start(options: StartOptions): Promise<number> {
    // Set environment variables for the daemon process
    // This allows the daemon to use the correct DB path for worktree
    if (this.config.issueNo !== undefined) {
      process.env.CM_DB_PATH = this.config.dbPath;
      process.env.CM_ISSUE_NO = String(this.config.issueNo);
    }

    return this.innerManager.start(options);
  }

  async stop(force: boolean = false): Promise<boolean> {
    return this.innerManager.stop(force);
  }

  async getStatus(): Promise<DaemonStatus | null> {
    return this.innerManager.getStatus();
  }

  async isRunning(): Promise<boolean> {
    return this.innerManager.isRunning();
  }

  /**
   * Get configuration (for testing/debugging)
   */
  getConfig(): DaemonManagerConfig {
    return { ...this.config };
  }
}

/**
 * Factory for creating DaemonManager instances
 * SF-002: Factory pattern implementation
 *
 * @example
 * ```typescript
 * // Create manager for main server
 * const factory = new DaemonManagerFactory();
 * const mainManager = factory.create();
 *
 * // Create manager for worktree #135
 * const worktreeManager = factory.create(135);
 * ```
 */
export class DaemonManagerFactory {
  private pidResolver: PidPathResolver;
  private dbResolver: DbPathResolver;

  constructor() {
    this.pidResolver = new PidPathResolver();
    this.dbResolver = new DbPathResolver();
  }

  /**
   * Create a DaemonManager instance
   * @param issueNo - Optional issue number for worktree-specific manager
   * @returns IDaemonManager instance
   */
  create(issueNo?: number): IDaemonManager {
    const pidPath = this.pidResolver.resolve(issueNo);
    const envPath = getEnvPath(issueNo);
    const dbPath = this.dbResolver.resolve(issueNo);

    // MF-CONS-002: Use existing DaemonManager constructor
    const innerManager = new DaemonManager(pidPath);

    // Wrap with additional configuration
    return new DaemonManagerWrapper(innerManager, {
      pidPath,
      envPath,
      dbPath,
      issueNo,
    });
  }
}

/**
 * Singleton factory instance for convenience
 */
let _factoryInstance: DaemonManagerFactory | null = null;

/**
 * Get singleton factory instance
 */
export function getDaemonManagerFactory(): DaemonManagerFactory {
  if (!_factoryInstance) {
    _factoryInstance = new DaemonManagerFactory();
  }
  return _factoryInstance;
}

/**
 * Reset singleton factory (for testing)
 */
export function resetDaemonManagerFactory(): void {
  _factoryInstance = null;
}
