/**
 * Fork Manager
 * Issue #1480: Native "fork and add" support for repository registration.
 *
 * Creates a fork in the authenticated GitHub user's namespace via `gh repo fork`
 * so the cloned repository's origin points at the user's own fork — push never
 * targets the upstream. The original URL is returned as the upstream so the clone
 * flow can register an `upstream` remote for fetch/pull tracking.
 *
 * Security:
 * - Uses execFile (not exec) to prevent command injection (consistent with github-api.ts).
 * - host/owner/repo are parsed from a validated URL and matched against strict
 *   token patterns before being passed to gh.
 * - gh commands run in a neutral cwd (os.tmpdir) so gh never resolves an ambient
 *   repository from the server process cwd.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { createLogger } from '@/lib/logger';

const logger = createLogger('fork-manager');
const execFileAsync = promisify(execFile);

/** Timeout for the availability / auth probe commands. */
const GH_PROBE_TIMEOUT_MS = 5000;
/** Timeout for `gh repo fork` (a network-creating operation). */
const GH_FORK_TIMEOUT_MS = 30000;

/** Default GitHub host; other hosts are passed to gh via the GH_HOST env var. */
const DEFAULT_GH_HOST = 'github.com';

/** Strict token patterns to guard interpolation into fork URLs. */
const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
const OWNER_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9-]+$/;

/** URL scheme of the source clone URL, preserved for the fork URL. */
export type SourceScheme = 'https' | 'ssh-scp' | 'ssh-url';

/** Parsed components of a GitHub repository URL. */
export interface ParsedRepoUrl {
  host: string;
  owner: string;
  repo: string;
  scheme: SourceScheme;
}

/** Successful fork result. */
export interface ForkResult {
  /** Clone URL of the user's fork — becomes origin. */
  forkUrl: string;
  /** Original source URL — becomes the upstream remote. */
  upstreamUrl: string;
  /** `<login>/<repo>` of the created (or reused) fork. */
  forkFullName: string;
}

/** Error codes surfaced by forkRepository(). */
export type ForkErrorCode =
  | 'GH_NOT_AVAILABLE'
  | 'GH_NOT_AUTHENTICATED'
  | 'INVALID_SOURCE_URL'
  | 'FORK_FAILED';

/** Structured error for fork failures, mapped to an HTTP response by the route. */
export class ForkError extends Error {
  code: ForkErrorCode;

  constructor(code: ForkErrorCode, message: string) {
    super(message);
    this.name = 'ForkError';
    this.code = code;
  }
}

/**
 * Parse a GitHub repository URL into its components, preserving the scheme so the
 * fork URL can be built in the same form (https / scp-like ssh / ssh:// ).
 *
 * @returns Parsed components, or null when the URL is not a recognized repo URL
 *          or contains characters outside the strict token patterns.
 */
export function parseGitHubRepoUrl(url: string): ParsedRepoUrl | null {
  const trimmed = url.trim();

  let host: string | undefined;
  let owner: string | undefined;
  let repo: string | undefined;
  let scheme: SourceScheme | undefined;

  const httpsMatch = trimmed.match(
    /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );
  const scpMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  const sshUrlMatch = trimmed.match(
    /^ssh:\/\/git@([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );

  if (httpsMatch) {
    [, host, owner, repo] = httpsMatch;
    scheme = 'https';
  } else if (scpMatch) {
    [, host, owner, repo] = scpMatch;
    scheme = 'ssh-scp';
  } else if (sshUrlMatch) {
    [, host, owner, repo] = sshUrlMatch;
    scheme = 'ssh-url';
  } else {
    return null;
  }

  if (
    !HOST_PATTERN.test(host) ||
    !OWNER_PATTERN.test(owner) ||
    !REPO_PATTERN.test(repo)
  ) {
    return null;
  }

  return { host, owner, repo, scheme };
}

/**
 * Build the fork's clone URL from the login and the source URL's components,
 * preserving host and scheme so it matches the user's existing auth setup.
 */
function buildForkUrl(parsed: ParsedRepoUrl, login: string): string {
  const { host, repo, scheme } = parsed;
  switch (scheme) {
    case 'ssh-scp':
      return `git@${host}:${login}/${repo}.git`;
    case 'ssh-url':
      return `ssh://git@${host}/${login}/${repo}.git`;
    case 'https':
    default:
      return `https://${host}/${login}/${repo}.git`;
  }
}

/** Build the exec env, adding GH_HOST only for non-default hosts. */
function ghEnv(host: string): NodeJS.ProcessEnv {
  if (host === DEFAULT_GH_HOST) {
    return process.env;
  }
  return { ...process.env, GH_HOST: host };
}

/** Check whether the gh CLI is installed. */
async function isGhCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], {
      timeout: GH_PROBE_TIMEOUT_MS,
      cwd: tmpdir(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the authenticated user's login. Doubles as the auth check: `gh api user`
 * fails when the user is not logged in.
 *
 * @returns login string, or null when not authenticated / the call fails.
 */
async function resolveAuthenticatedLogin(host: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', 'user', '--jq', '.login'],
      { timeout: GH_PROBE_TIMEOUT_MS, cwd: tmpdir(), env: ghEnv(host) }
    );
    const login = stdout.trim();
    return login.length > 0 && LOGIN_PATTERN.test(login) ? login : null;
  } catch {
    return null;
  }
}

/**
 * Create (or reuse) a fork of the source repository in the authenticated user's
 * namespace and return the clone URL of that fork plus the original URL as the
 * upstream.
 *
 * `gh repo fork` is idempotent: it reuses an existing fork (exit 0) instead of
 * failing, so re-adding the same repository is safe.
 *
 * @throws {ForkError} with a specific code for each failure class.
 */
export async function forkRepository(sourceUrl: string): Promise<ForkResult> {
  const parsed = parseGitHubRepoUrl(sourceUrl);
  if (!parsed) {
    throw new ForkError(
      'INVALID_SOURCE_URL',
      'Fork requires a GitHub repository URL (https or ssh).'
    );
  }

  if (!(await isGhCliAvailable())) {
    throw new ForkError(
      'GH_NOT_AVAILABLE',
      'GitHub CLI (gh) is not installed. Install gh to use the fork option.'
    );
  }

  const login = await resolveAuthenticatedLogin(parsed.host);
  if (!login) {
    throw new ForkError(
      'GH_NOT_AUTHENTICATED',
      'GitHub CLI is not authenticated. Run `gh auth login` and try again.'
    );
  }

  const { host, owner, repo } = parsed;
  try {
    await execFileAsync(
      'gh',
      ['repo', 'fork', `${owner}/${repo}`, '--clone=false'],
      { timeout: GH_FORK_TIMEOUT_MS, cwd: tmpdir(), env: ghEnv(host) }
    );
  } catch (err) {
    const stderr =
      (err as { stderr?: string }).stderr ||
      (err instanceof Error ? err.message : String(err));
    // Do not echo the raw source URL back; log the failure server-side only.
    logger.warn('fork:failed', { owner, repo, host });
    throw new ForkError(
      'FORK_FAILED',
      `Failed to fork ${owner}/${repo}: ${stderr.trim().slice(0, 200)}`
    );
  }

  const forkFullName = `${login}/${repo}`;
  logger.info('fork:created', { forkFullName, host });

  return {
    forkUrl: buildForkUrl(parsed, login),
    upstreamUrl: sourceUrl.trim(),
    forkFullName,
  };
}
