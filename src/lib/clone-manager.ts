/**
 * Clone Manager
 * Issue #71: Clone URL registration feature
 *
 * Manages git clone operations with:
 * - URL validation and normalization
 * - Duplicate detection (DB-based)
 * - Concurrent clone prevention
 * - Progress tracking
 * - Error handling
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { UrlNormalizer } from './url-normalizer';
import { isPathSafe } from './path-validator';
import {
  createCloneJob as dbCreateCloneJob,
  getCloneJob,
  updateCloneJob,
  getActiveCloneJobByUrl,
  getRepositoryByNormalizedUrl,
  createRepository,
  type CloneJobDB,
  type Repository,
} from './db-repository';
import { scanWorktrees, syncWorktreesToDB } from './worktrees';
import type { CloneError, CloneErrorCategory, CloneJobStatus } from '@/types/clone';

/**
 * Clone manager configuration
 */
export interface CloneManagerConfig {
  /** Base path for cloned repositories */
  basePath?: string;
  /** Timeout for clone operation in milliseconds */
  timeout?: number;
}

/**
 * Clone request validation result
 */
export interface CloneValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  repoName?: string;
  error?: CloneError;
}

/**
 * Clone job status response
 */
export interface CloneJobStatusResponse {
  jobId: string;
  status: CloneJobStatus;
  progress: number;
  repositoryId?: string;
  error?: {
    category: string;
    code: string;
    message: string;
  };
}

/**
 * Clone operation result
 */
export interface CloneResult {
  success: boolean;
  jobId?: string;
  repositoryId?: string;
  error?: CloneError;
}

/**
 * Clone Manager Error
 */
export class CloneManagerError extends Error implements CloneError {
  category: CloneErrorCategory;
  code: string;
  recoverable: boolean;
  suggestedAction: string;

  constructor(error: CloneError) {
    super(error.message);
    this.name = 'CloneManagerError';
    this.category = error.category;
    this.code = error.code;
    this.recoverable = error.recoverable;
    this.suggestedAction = error.suggestedAction;
  }
}

/**
 * Error code to CloneError mapping
 */
const ERROR_DEFINITIONS: Record<string, CloneError> = {
  EMPTY_URL: {
    category: 'validation',
    code: 'EMPTY_URL',
    message: 'Clone URL is required',
    recoverable: true,
    suggestedAction: 'Please enter a valid git clone URL',
  },
  INVALID_URL_FORMAT: {
    category: 'validation',
    code: 'INVALID_URL_FORMAT',
    message: 'Invalid URL format. Please use HTTPS or SSH URL.',
    recoverable: true,
    suggestedAction: 'Enter a valid URL like https://github.com/owner/repo or git@github.com:owner/repo',
  },
  DUPLICATE_CLONE_URL: {
    category: 'validation',
    code: 'DUPLICATE_CLONE_URL',
    message: 'This repository is already registered',
    recoverable: false,
    suggestedAction: 'Use the existing repository instead',
  },
  CLONE_IN_PROGRESS: {
    category: 'validation',
    code: 'CLONE_IN_PROGRESS',
    message: 'A clone operation is already in progress for this URL',
    recoverable: false,
    suggestedAction: 'Wait for the current clone to complete',
  },
  DIRECTORY_EXISTS: {
    category: 'filesystem',
    code: 'DIRECTORY_EXISTS',
    message: 'Target directory already exists',
    recoverable: true,
    suggestedAction: 'Choose a different directory or remove the existing one',
  },
  INVALID_TARGET_PATH: {
    category: 'validation',
    code: 'INVALID_TARGET_PATH',
    message: 'Target path is invalid or outside allowed directory',
    recoverable: true,
    suggestedAction: 'Use a path within the configured base directory',
  },
  AUTH_FAILED: {
    category: 'auth',
    code: 'AUTH_FAILED',
    message: 'Authentication failed',
    recoverable: true,
    suggestedAction: 'Check your credentials or SSH keys',
  },
  NETWORK_ERROR: {
    category: 'network',
    code: 'NETWORK_ERROR',
    message: 'Network error occurred',
    recoverable: true,
    suggestedAction: 'Check your internet connection and try again',
  },
  GIT_ERROR: {
    category: 'git',
    code: 'GIT_ERROR',
    message: 'Git command failed',
    recoverable: false,
    suggestedAction: 'Check the error message for details',
  },
  CLONE_TIMEOUT: {
    category: 'network',
    code: 'CLONE_TIMEOUT',
    message: 'Clone operation timed out',
    recoverable: true,
    suggestedAction: 'Try again or clone a smaller repository',
  },
};

/**
 * Clone Manager class
 *
 * Manages the lifecycle of git clone operations:
 * 1. Validate URL format
 * 2. Check for duplicate repositories
 * 3. Check for active clone jobs
 * 4. Create clone job
 * 5. Execute git clone
 * 6. Register repository on success
 */
export class CloneManager {
  private db: Database.Database;
  private urlNormalizer: UrlNormalizer;
  private config: CloneManagerConfig;
  private activeProcesses: Map<string, ChildProcess>;

  constructor(db: Database.Database, config: CloneManagerConfig = {}) {
    this.db = db;
    this.urlNormalizer = UrlNormalizer.getInstance();
    this.config = {
      basePath: config.basePath || process.env.WORKTREE_BASE_PATH || '/tmp/repos',
      timeout: config.timeout || 10 * 60 * 1000, // 10 minutes
    };
    this.activeProcesses = new Map();
  }

  /**
   * Validate clone request
   */
  validateCloneRequest(cloneUrl: string): CloneValidationResult {
    const validation = this.urlNormalizer.validate(cloneUrl);

    if (!validation.valid) {
      const errorDef = ERROR_DEFINITIONS[validation.error || 'INVALID_URL_FORMAT'];
      return {
        valid: false,
        error: errorDef,
      };
    }

    const normalizedUrl = this.urlNormalizer.normalize(cloneUrl);
    const repoName = this.urlNormalizer.extractRepoName(cloneUrl);

    return {
      valid: true,
      normalizedUrl,
      repoName,
    };
  }

  /**
   * Check if repository already exists (by normalized URL)
   */
  checkDuplicateRepository(normalizedUrl: string): Repository | null {
    return getRepositoryByNormalizedUrl(this.db, normalizedUrl);
  }

  /**
   * Check if there's an active clone job for this URL
   */
  checkActiveCloneJob(normalizedUrl: string): CloneJobDB | null {
    return getActiveCloneJobByUrl(this.db, normalizedUrl);
  }

  /**
   * Create a new clone job
   */
  createCloneJob(data: {
    cloneUrl: string;
    normalizedCloneUrl: string;
    targetPath: string;
  }): CloneJobDB {
    return dbCreateCloneJob(this.db, data);
  }

  /**
   * Get target path for a repository
   */
  getTargetPath(repoName: string): string {
    return path.join(this.config.basePath!, repoName);
  }

  /**
   * Start a clone job
   *
   * This method:
   * 1. Validates the URL
   * 2. Checks for duplicates
   * 3. Creates a job record
   * 4. Returns immediately (clone runs in background)
   */
  async startCloneJob(cloneUrl: string, customTargetPath?: string): Promise<CloneResult> {
    // 1. Validate URL
    const validation = this.validateCloneRequest(cloneUrl);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
      };
    }

    const normalizedUrl = validation.normalizedUrl!;
    const repoName = validation.repoName!;

    // 2. Check for duplicate repository
    const existingRepo = this.checkDuplicateRepository(normalizedUrl);
    if (existingRepo) {
      return {
        success: false,
        error: {
          ...ERROR_DEFINITIONS.DUPLICATE_CLONE_URL,
          message: `This repository is already registered as "${existingRepo.name}"`,
        },
      };
    }

    // 3. Check for active clone job
    const activeJob = this.checkActiveCloneJob(normalizedUrl);
    if (activeJob) {
      return {
        success: false,
        jobId: activeJob.id,
        error: ERROR_DEFINITIONS.CLONE_IN_PROGRESS,
      };
    }

    // 4. Determine target path
    const targetPath = customTargetPath || this.getTargetPath(repoName);

    // 4.1. Validate target path (prevent path traversal)
    if (customTargetPath && !isPathSafe(customTargetPath, this.config.basePath!)) {
      return {
        success: false,
        error: {
          ...ERROR_DEFINITIONS.INVALID_TARGET_PATH,
          message: `Target path must be within ${this.config.basePath}`,
        },
      };
    }

    // 5. Check if directory exists
    if (existsSync(targetPath)) {
      return {
        success: false,
        error: {
          ...ERROR_DEFINITIONS.DIRECTORY_EXISTS,
          message: `Target directory already exists: ${targetPath}`,
        },
      };
    }

    // 6. Create clone job
    const job = this.createCloneJob({
      cloneUrl,
      normalizedCloneUrl: normalizedUrl,
      targetPath,
    });

    // 7. Start clone in background (don't await)
    this.executeClone(job.id, cloneUrl, targetPath).catch((error) => {
      console.error(`[CloneManager] Clone failed for job ${job.id}:`, error);
    });

    return {
      success: true,
      jobId: job.id,
    };
  }

  /**
   * Execute git clone operation
   *
   * This method runs asynchronously and updates the job status.
   */
  async executeClone(jobId: string, cloneUrl: string, targetPath: string): Promise<void> {
    // Update job status to running
    updateCloneJob(this.db, jobId, {
      status: 'running',
      startedAt: new Date(),
    });

    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    return new Promise<void>((resolve, reject) => {
      // Spawn git clone process
      const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, targetPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeProcesses.set(jobId, gitProcess);

      // Update PID
      if (gitProcess.pid) {
        updateCloneJob(this.db, jobId, { pid: gitProcess.pid });
      }

      let stderr = '';

      // Capture stderr (git outputs progress to stderr)
      gitProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();

        // Parse progress from git output
        const progress = this.parseGitProgress(data.toString());
        if (progress !== null) {
          updateCloneJob(this.db, jobId, { progress });
        }
      });

      // Set timeout
      const timeout = setTimeout(() => {
        gitProcess.kill('SIGTERM');
        updateCloneJob(this.db, jobId, {
          status: 'failed',
          errorCategory: 'network',
          errorCode: 'CLONE_TIMEOUT',
          errorMessage: 'Clone operation timed out',
          completedAt: new Date(),
        });
        this.activeProcesses.delete(jobId);
        reject(new CloneManagerError(ERROR_DEFINITIONS.CLONE_TIMEOUT));
      }, this.config.timeout);

      // Handle process exit
      gitProcess.on('close', async (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(jobId);

        if (code === 0) {
          // Success - create repository record and scan worktrees
          await this.onCloneSuccess(jobId, cloneUrl, targetPath);
          resolve();
        } else {
          // Failure - parse error
          const error = this.parseGitError(stderr, code);
          updateCloneJob(this.db, jobId, {
            status: 'failed',
            errorCategory: error.category,
            errorCode: error.code,
            errorMessage: error.message,
            completedAt: new Date(),
          });
          reject(new CloneManagerError(error));
        }
      });

      // Handle process error
      gitProcess.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(jobId);

        const error: CloneError = {
          category: 'system',
          code: 'SPAWN_ERROR',
          message: `Failed to spawn git process: ${err.message}`,
          recoverable: false,
          suggestedAction: 'Ensure git is installed and available in PATH',
        };

        updateCloneJob(this.db, jobId, {
          status: 'failed',
          errorCategory: error.category,
          errorCode: error.code,
          errorMessage: error.message,
          completedAt: new Date(),
        });

        reject(new CloneManagerError(error));
      });
    });
  }

  /**
   * Handle successful clone
   */
  private async onCloneSuccess(jobId: string, cloneUrl: string, targetPath: string): Promise<void> {
    const job = getCloneJob(this.db, jobId);
    if (!job) return;

    // Determine clone source from URL type
    const urlType = this.urlNormalizer.getUrlType(cloneUrl);
    const cloneSource = urlType || 'https';

    // Create repository record
    const repo = createRepository(this.db, {
      name: path.basename(targetPath),
      path: targetPath,
      cloneUrl,
      normalizedCloneUrl: job.normalizedCloneUrl,
      cloneSource: cloneSource as 'local' | 'https' | 'ssh',
    });

    // Scan and register worktrees
    try {
      const worktrees = await scanWorktrees(targetPath);
      if (worktrees.length > 0) {
        syncWorktreesToDB(this.db, worktrees);
        console.log(`[CloneManager] Registered ${worktrees.length} worktree(s) for ${targetPath}`);
      }
    } catch (error) {
      console.error(`[CloneManager] Failed to scan worktrees for ${targetPath}:`, error);
      // Continue even if worktree scan fails - the repository is still registered
    }

    // Update job as completed
    updateCloneJob(this.db, jobId, {
      status: 'completed',
      progress: 100,
      repositoryId: repo.id,
      completedAt: new Date(),
    });
  }

  /**
   * Parse git clone progress from output
   *
   * Git outputs progress like:
   * "Receiving objects:  42% (123/456), 1.23 MiB | 2.34 MiB/s"
   *
   * @param output - Git stderr output containing progress info
   * @returns Percentage (0-100) or null if no progress found
   */
  parseGitProgress(output: string): number | null {
    // Combined regex pattern for all progress formats
    const progressMatch = output.match(
      /(?:Receiving objects|Resolving deltas|Cloning into[^:]*?):\s*(\d+)%/
    );

    if (progressMatch) {
      const progress = parseInt(progressMatch[1], 10);
      return isNaN(progress) ? null : progress;
    }

    return null;
  }

  /**
   * Parse git error from stderr
   *
   * Categorizes git errors into auth, network, or generic git errors
   * with truncated error messages for display.
   *
   * @param stderr - Git stderr output
   * @param exitCode - Git process exit code
   * @returns Categorized CloneError object
   */
  parseGitError(stderr: string, exitCode: number | null): CloneError {
    const lowerStderr = stderr.toLowerCase();
    const truncatedStderr = stderr.substring(0, 200);

    // Authentication error patterns
    const authPatterns = [
      'authentication failed',
      'permission denied',
      'could not read from remote repository',
    ];

    // Network error patterns
    const networkPatterns = [
      'could not resolve host',
      'connection refused',
      'network is unreachable',
    ];

    // Check authentication errors (early return)
    if (authPatterns.some((pattern) => lowerStderr.includes(pattern))) {
      return {
        ...ERROR_DEFINITIONS.AUTH_FAILED,
        message: `Authentication failed: ${truncatedStderr}`,
      };
    }

    // Check network errors (early return)
    if (networkPatterns.some((pattern) => lowerStderr.includes(pattern))) {
      return {
        ...ERROR_DEFINITIONS.NETWORK_ERROR,
        message: `Network error: ${truncatedStderr}`,
      };
    }

    // Default: generic git error
    return {
      ...ERROR_DEFINITIONS.GIT_ERROR,
      message: `Git clone failed (exit code ${exitCode}): ${truncatedStderr}`,
    };
  }

  /**
   * Get clone job status
   */
  getCloneJobStatus(jobId: string): CloneJobStatusResponse | null {
    const job = getCloneJob(this.db, jobId);
    if (!job) return null;

    const response: CloneJobStatusResponse = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      repositoryId: job.repositoryId,
    };

    if (job.status === 'failed' && job.errorCode) {
      response.error = {
        category: job.errorCategory || 'system',
        code: job.errorCode,
        message: job.errorMessage || 'Unknown error',
      };
    }

    return response;
  }

  /**
   * Cancel a clone job
   */
  cancelCloneJob(jobId: string): boolean {
    const process = this.activeProcesses.get(jobId);
    if (process) {
      process.kill('SIGTERM');
      this.activeProcesses.delete(jobId);

      updateCloneJob(this.db, jobId, {
        status: 'cancelled',
        completedAt: new Date(),
      });

      return true;
    }

    // Job might be pending (not started)
    const job = getCloneJob(this.db, jobId);
    if (job && job.status === 'pending') {
      updateCloneJob(this.db, jobId, {
        status: 'cancelled',
        completedAt: new Date(),
      });
      return true;
    }

    return false;
  }
}
