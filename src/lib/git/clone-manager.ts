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
import { UrlNormalizer } from '@/lib/url-normalizer';
import { validateWorktreePath } from '@/lib/security/path-validator';
import {
  createCloneJob as dbCreateCloneJob,
  getCloneJob,
  updateCloneJob,
  getActiveCloneJobByUrl,
  getRepositoryByNormalizedUrl,
  getRepositoryByPath,
  createRepository,
  deleteRepository,
  countWorktreesByRepositoryPath,
  type CloneJobDB,
  type Repository,
} from '@/lib/db/db-repository';
import { scanWorktrees } from './worktrees';
import { gitRemoteAdd } from './git-remote';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import type { CloneError, CloneErrorCategory, CloneJobStatus } from '@/types/clone';
import { createLogger } from '@/lib/logger';

const logger = createLogger('clone-manager');

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
 * Options for startCloneJob (Issue #1480)
 */
export interface StartCloneJobOptions {
  /**
   * When set, an `upstream` remote pointing at this URL is registered after a
   * successful clone. Used by the fork flow so origin stays the user's fork while
   * upstream tracks the original repository (fetch/pull).
   */
  upstreamUrl?: string;
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
  // Issue #1340: repositories.path は UNIQUE。clone URL を持たない行がその path に
  // 残っていると URL 重複チェックをすり抜け、クローン完了後の createRepository が
  // UNIQUE 違反で throw する。事前検証で明示的なエラーとして返す。
  DUPLICATE_REPOSITORY_PATH: {
    category: 'validation',
    code: 'DUPLICATE_REPOSITORY_PATH',
    message: 'Another repository is already registered at the target location',
    recoverable: true,
    suggestedAction: 'Choose a different directory, or remove the existing repository registration',
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
  // Issue #1342: executeClone の準備処理（status 更新・親ディレクトリ作成）が throw した場合。
  // [D4-001] 原因の詳細はパス情報を含むためログのみに出し、クライアントには定型文を返す。
  CLONE_SETUP_FAILED: {
    category: 'filesystem',
    code: 'CLONE_SETUP_FAILED',
    message: 'Failed to prepare the clone target directory',
    recoverable: true,
    suggestedAction: 'Check the permissions and free space of the target directory, then try again',
  },
  // Issue #1340: git clone 自体は成功した後の後処理（リポジトリ登録・ジョブ完了記録）が
  // throw した場合。[D4-001] 原因の詳細はパス情報を含むためログのみに出し、
  // クライアントには定型文を返す。
  CLONE_REGISTRATION_FAILED: {
    category: 'system',
    code: 'CLONE_REGISTRATION_FAILED',
    message: 'The repository was cloned but could not be registered',
    recoverable: true,
    suggestedAction: 'Remove the cloned directory and try again',
  },
};

/**
 * Module-scoped flag to ensure WORKTREE_BASE_PATH deprecation warning
 * is emitted only once per process lifetime.
 */
let warnedWorktreeBasePath = false;

/** @internal テスト専用。本番コードから呼び出さないこと。 */
export function resetWorktreeBasePathWarning(): void {
  warnedWorktreeBasePath = false;
}

/**
 * Resolve and validate a custom target path.
 * Returns the resolved absolute path, or null if the path is invalid.
 *
 * [D1-001] Wraps validateWorktreePath() to maintain consistency with
 * the existing boolean/null error pattern used throughout startCloneJob().
 * [D4-001] Exception messages from validateWorktreePath() contain rootDir
 * values and must not be exposed to clients.
 * [S1-001] Logs rejection for attack detection and debugging using a
 * fixed message string to avoid leaking rootDir.
 *
 * @internal
 */
export function resolveCustomTargetPath(
  customTargetPath: string,
  basePath: string
): string | null {
  try {
    return validateWorktreePath(customTargetPath, basePath);
  } catch {
    // [S1-001] Log rejection for attack detection and debugging.
    // Use a fixed message string to avoid leaking rootDir from exception messages.
    logger.warn('invalid-custom-target');
    return null;
  }
}

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
  /**
   * Issue #1480: upstream URL to register (as the `upstream` remote) once the
   * clone for a given job succeeds. Kept in memory — mirroring activeProcesses —
   * because clone jobs run in-process and this needs no persistence.
   */
  private pendingUpstreamUrls: Map<string, string>;

  constructor(db: Database.Database, config: CloneManagerConfig = {}) {
    this.db = db;
    this.urlNormalizer = UrlNormalizer.getInstance();
    this.config = {
      basePath: config.basePath || this.resolveDefaultBasePath(),
      timeout: config.timeout || 10 * 60 * 1000, // 10 minutes
    };
    this.activeProcesses = new Map();
    this.pendingUpstreamUrls = new Map();
  }

  /**
   * Resolve the default basePath when not explicitly provided via config.
   *
   * Priority:
   * 1. WORKTREE_BASE_PATH (deprecated, emits console.warn once per process)
   * 2. process.cwd() (final fallback)
   *
   * [D1-007] WORKTREE_BASE_PATH is normalized with path.resolve() to ensure
   * it is an absolute path, preventing unexpected behavior with relative paths.
   *
   * @returns Absolute path to use as the base directory for clone operations
   */
  private resolveDefaultBasePath(): string {
    const worktreeBasePath = process.env.WORKTREE_BASE_PATH;
    if (worktreeBasePath) {
      if (!warnedWorktreeBasePath) {
        logger.warn('config:deprecated', { key: 'WORKTREE_BASE_PATH', replacement: 'CM_ROOT_DIR' });
        warnedWorktreeBasePath = true;
      }
      return path.resolve(worktreeBasePath);
    }
    return process.cwd();
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
   * Check if a repository row already occupies the target path (Issue #1340)
   *
   * `repositories.path` is UNIQUE, and a row can exist without a clone URL
   * (UI registration / disableRepository / ensureEnvRepositoriesRegistered).
   * Such a row passes the URL duplicate check but makes createRepository()
   * throw a UNIQUE violation after the clone has already finished.
   */
  checkRepositoryAtPath(targetPath: string): Repository | null {
    return getRepositoryByPath(this.db, targetPath);
  }

  /**
   * Remove a "ghost" repositories row if the given row is one (Issue #1350).
   *
   * A duplicate check (by URL or by path) can match a row whose on-disk
   * directory has been deleted and that has no worktrees left. Such a row is
   * unrecoverable dead weight: it blocks re-cloning the same URL/path forever,
   * and before #1350 there was no way to remove it from the UI or API. When we
   * detect one, physically delete it so the clone can proceed.
   *
   * A row is treated as LIVE (kept, and the caller must reject as a duplicate)
   * when either:
   *   - its directory still exists on disk — a real, working repository, or
   *   - it still has worktrees registered — deleting it could drop worktree
   *     records for a repository whose directory is only transiently missing
   *     (e.g. an unmounted volume). This mirrors migration v43 (#1339), which
   *     also refuses to treat a row with worktrees as a ghost.
   *
   * @returns true if a ghost row was removed (caller may proceed with the
   *          clone), false if the row is live (caller must reject).
   */
  private removeIfGhostRepository(repo: Repository): boolean {
    if (existsSync(repo.path)) {
      return false; // Directory exists: a real repository, not a ghost.
    }
    if (countWorktreesByRepositoryPath(this.db, repo.path) > 0) {
      return false; // Still has worktrees: keep for safety.
    }
    deleteRepository(this.db, repo.id);
    logger.info('clone:ghost-repository-removed', { repositoryId: repo.id, name: repo.name });
    return true;
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
  async startCloneJob(
    cloneUrl: string,
    customTargetPath?: string,
    options?: StartCloneJobOptions
  ): Promise<CloneResult> {
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

    // 2. Check for duplicate repository (by normalized URL)
    // Issue #1350: a row whose directory was deleted and that has no worktrees
    // left is a ghost — removeIfGhostRepository() clears it so the same URL can
    // be re-cloned instead of being rejected forever.
    const existingRepo = this.checkDuplicateRepository(normalizedUrl);
    if (existingRepo && !this.removeIfGhostRepository(existingRepo)) {
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
    // [D1-002] When customTargetPath is provided, validate AND resolve to absolute path
    // using resolveCustomTargetPath() to prevent relative path bypass (Issue #392).
    let targetPath: string;
    if (customTargetPath) {
      const resolved = resolveCustomTargetPath(customTargetPath, this.config.basePath!);
      if (!resolved) {
        // [D4-001] Use default error message to avoid leaking basePath value
        return { success: false, error: ERROR_DEFINITIONS.INVALID_TARGET_PATH };
      }
      targetPath = resolved;
    } else {
      targetPath = this.getTargetPath(repoName);
    }

    // 5. Check if directory exists
    // [D4-001] Use default error message to avoid leaking full targetPath
    if (existsSync(targetPath)) {
      return { success: false, error: ERROR_DEFINITIONS.DIRECTORY_EXISTS };
    }

    // 6. Check for an existing repositories row at the target path (Issue #1340)
    // [D4-001] Report the registered repository name only; targetPath must not leak.
    // Issue #1350: step 5 guarantees targetPath has no directory, so a row found
    // here is a ghost unless it still has worktrees — removeIfGhostRepository()
    // clears the ghost so the path can be reused; otherwise we reject.
    const repoAtPath = this.checkRepositoryAtPath(targetPath);
    if (repoAtPath && !this.removeIfGhostRepository(repoAtPath)) {
      return {
        success: false,
        error: {
          ...ERROR_DEFINITIONS.DUPLICATE_REPOSITORY_PATH,
          message: `Another repository is already registered at the target location as "${repoAtPath.name}"`,
        },
      };
    }

    // 7. Create clone job
    const job = this.createCloneJob({
      cloneUrl,
      normalizedCloneUrl: normalizedUrl,
      targetPath,
    });

    // Issue #1480: remember the upstream URL to register once this job succeeds.
    if (options?.upstreamUrl) {
      this.pendingUpstreamUrls.set(job.id, options.upstreamUrl);
    }

    // 8. Start clone in background (don't await)
    this.executeClone(job.id, cloneUrl, targetPath).catch((error) => {
      logger.error('clone:job-failed', { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
    });

    return {
      success: true,
      jobId: job.id,
    };
  }

  /**
   * Mark a job as failed, tolerating a failing DB write.
   *
   * Issue #1342: 呼び出し元は失敗パスの最中なので、ここでの throw は元の原因を握り潰す。
   * DB 書き込みが失敗した場合はログに残すだけにして、元のエラーを伝播させる。
   */
  private markJobFailed(jobId: string, error: CloneError): void {
    // Issue #1480: a job that never reaches onCloneSuccess must not leak its
    // pending upstream entry.
    this.pendingUpstreamUrls.delete(jobId);
    try {
      updateCloneJob(this.db, jobId, {
        status: 'failed',
        errorCategory: error.category,
        errorCode: error.code,
        errorMessage: error.message,
        completedAt: new Date(),
      });
    } catch (dbError) {
      logger.error('clone:job-status-update-failed', {
        jobId,
        errorCode: error.code,
        dbError: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }
  }

  /**
   * Execute git clone operation
   *
   * This method runs asynchronously and updates the job status.
   */
  async executeClone(jobId: string, cloneUrl: string, targetPath: string): Promise<void> {
    // Issue #1342: ここは Promise 生成前の同期処理。throw すると失敗が
    // startCloneJob の .catch()（ログのみ）に吸われ、ジョブが terminal state へ
    // 遷移しないまま running / pending で固着する。必ず failed へ落とす。
    let parentDir: string;
    try {
      // Update job status to running
      updateCloneJob(this.db, jobId, {
        status: 'running',
        startedAt: new Date(),
      });

      // Ensure parent directory exists
      parentDir = path.dirname(targetPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
    } catch (err) {
      // [D4-001] 原因の詳細（パスを含む）はログのみ。ジョブに載せる message は定型文。
      logger.error('clone:setup-failed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.markJobFailed(jobId, ERROR_DEFINITIONS.CLONE_SETUP_FAILED);
      throw new CloneManagerError(ERROR_DEFINITIONS.CLONE_SETUP_FAILED);
    }

    return new Promise<void>((resolve, reject) => {
      // Spawn git clone process
      // Issue #1334: cwd を省略するとサーバープロセスの cwd を継承する。npx 起動時の cwd は
      // npm キャッシュ配下であり、消滅すると git が起動時に cwd を読めず exit 128 で失敗する。
      // 直前に存在を保証した parentDir を明示する。
      const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, targetPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: parentDir,
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
        this.pendingUpstreamUrls.delete(jobId);
        reject(new CloneManagerError(ERROR_DEFINITIONS.CLONE_TIMEOUT));
      }, this.config.timeout);

      // Handle process exit
      gitProcess.on('close', async (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(jobId);

        if (code === 0) {
          // Success - create repository record and scan worktrees
          // Issue #1340: onCloneSuccess の throw をここで拾わないと、この async リスナーが
          // 返す誰も待たない Promise が reject されるだけで、executeClone の Promise は
          // resolve も reject もされないまま残る（ジョブが running で固着する）。
          try {
            await this.onCloneSuccess(jobId, cloneUrl, targetPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          // Failure - parse error
          this.pendingUpstreamUrls.delete(jobId);
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
        this.pendingUpstreamUrls.delete(jobId);

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
   *
   * Issue #1340: ここでの throw は startCloneJob の .catch()（ログのみ）にしか届かない。
   * 握り潰すとディスク上のクローンだけが成功し、ジョブは running のまま残って UI が沈黙する。
   * どこで失敗しても必ず failed へ落とし、構造化エラーとして呼び出し元へ伝える。
   */
  private async onCloneSuccess(jobId: string, cloneUrl: string, targetPath: string): Promise<void> {
    try {
      const job = getCloneJob(this.db, jobId);
      if (!job) return;

      // Determine clone source from URL type
      const urlType = this.urlNormalizer.getUrlType(cloneUrl);
      const cloneSource = urlType || 'https';

      // Create repository record
      // repositories.path is UNIQUE - a row already occupying targetPath throws here.
      const repo = createRepository(this.db, {
        name: path.basename(targetPath),
        path: targetPath,
        cloneUrl,
        normalizedCloneUrl: job.normalizedCloneUrl,
        cloneSource: cloneSource as 'local' | 'https' | 'ssh',
      });

      // Issue #1480: register the upstream remote for the fork flow. Best-effort:
      // a failure here (e.g. the remote already exists) must not fail the clone,
      // which has already succeeded and been registered.
      const upstreamUrl = this.pendingUpstreamUrls.get(jobId);
      if (upstreamUrl) {
        this.pendingUpstreamUrls.delete(jobId);
        try {
          await gitRemoteAdd(targetPath, 'upstream', upstreamUrl);
          logger.info('clone:upstream-registered', { jobId });
        } catch (error) {
          logger.warn('clone:upstream-register-failed', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Issue #526: Scan and register worktrees with cleanup (MF-001, IA-MF-002)
      try {
        const worktrees = await scanWorktrees(targetPath);
        if (worktrees.length > 0) {
          const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(this.db, worktrees);
          logger.info('clone:worktrees-registered', { count: worktrees.length, upserted: syncResult.upsertedCount });
          if (cleanupWarnings.length > 0) {
            logger.warn('clone:cleanup-warnings', { cleanupWarnings });
          }
        }
      } catch (error) {
        // IA-MF-002: syncWorktreesAndCleanup failure should not break clone success
        logger.error('clone:worktree-scan-failed', { targetPath, error: error instanceof Error ? error.message : String(error) });
        // Continue even if worktree scan fails - the repository is still registered
      }

      // Update job as completed
      updateCloneJob(this.db, jobId, {
        status: 'completed',
        progress: 100,
        repositoryId: repo.id,
        completedAt: new Date(),
      });
    } catch (error) {
      // [D4-001] 原因の詳細（パス・SQL 文）はログのみ。ジョブに載せる message は定型文。
      logger.error('clone:registration-failed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.markJobFailed(jobId, ERROR_DEFINITIONS.CLONE_REGISTRATION_FAILED);
      throw new CloneManagerError(ERROR_DEFINITIONS.CLONE_REGISTRATION_FAILED);
    }
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
