/**
 * What `roles`, `instances` and `send` share about roles (Issue #4116): reading a
 * role or repository the way a person names it, reading a body, and turning the
 * role API's refusals into an exit code.
 *
 * ## Decisions
 *
 * - **A role is named by ID or name, and nothing is reserved.** "No role" and
 *   "follow the defaults" are flags, so a role called `none` is just a role.
 *   An exact match wins; failing that, a match ignoring case and Unicode form.
 *   Two answers at the same step is an error listing them, never a pick.
 * - **`--repo` is, in this order: an ID, a path, a name.** A value containing a `/`
 *   or starting with `.` is a path; it may be a registered root, or a worktree of
 *   one (which answers for its root). A bare word is never read as a path, so what
 *   the current directory holds cannot change which repository a word means.
 * - **Unknown, unregistered and ambiguous have their own codes**: `unknown_repository`,
 *   `repository_not_registered` (a real directory with no row) and `ambiguous_repository`.
 *   A root with no row for a tool is not an error: it reads `stored: inherit`.
 *
 * Type imports and {@link isAgentRoleCliTool} only from the shared types: the CLI
 * does not load the server's role layer.
 */

import { ExitCode } from '../types';
import { ApiError, type ApiClient } from './api-client';
import { handleCommandError } from './command-helpers';
import { RoleCliError, roleFailureFromApi, usageError } from './role-failure';
import { canonicalPath, isDirectory } from './role-input';
import {
  AGENT_ROLE_CLI_TOOLS,
  isAgentRoleCliTool,
  type AgentRoleCliTool,
  type AgentRoleListResponse,
  type AgentRoleSummary,
  type RoleAssignmentInput,
} from '../../types/agent-roles';

export { RoleCliError, roleFailureFromApi, usageError };
export { readRoleBodyOption } from './role-input';

/**
 * End a role command on `error`: the sentence on stderr, and with `--json` the same
 * thing as an object on stdout, so a caller parsing stdout gets an answer either way.
 */
export function reportRoleFailure(error: unknown, json: boolean | undefined): void {
  const failure = error instanceof RoleCliError ? error : roleFailureFromApi(error);
  if (!failure) {
    if (error instanceof ApiError && error.statusCode === 404 && !error.payload) {
      console.error(
        'Error: the server has no such route. It may be older than this CLI: commandmate stop && commandmate start'
      );
      process.exit(ExitCode.UNEXPECTED_ERROR);
      return;
    }
    handleCommandError(error);
    return;
  }
  if (json) {
    console.log(JSON.stringify({ success: false, error: failure.code, message: failure.message, ...failure.details }, null, 2));
  }
  console.error(`Error: ${failure.message}`);
  process.exit(failure.exitCode);
}

/** The role's ID and name, the way a candidate is listed. */
function describeRole(role: Pick<AgentRoleSummary, 'id' | 'name'>): string {
  return `${role.id}  ${role.name}`;
}

function foldName(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function ambiguousRole(selector: string, matches: AgentRoleSummary[]): RoleCliError {
  return new RoleCliError(
    'ambiguous_role',
    `'${selector}' could mean ${matches.length} roles. Name one by its ID (an ID that is also another role's name: rename that role):\n`
      + matches.map((role) => `  - ${describeRole(role)}`).join('\n'),
    ExitCode.CONFIG_ERROR,
    { candidates: matches.map(({ id, name }) => ({ id, name })) }
  );
}

/**
 * The role `selector` names. The database keeps names unique ignoring ASCII case
 * only, so Unicode forms and non-ASCII case can still answer twice, and a name can
 * equal another role's ID.
 */
export function pickRole<T extends AgentRoleSummary>(roles: readonly T[], selector: string): T {
  const exact = roles.filter((role) => role.id === selector || role.name === selector);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw ambiguousRole(selector, exact);
  const folded = roles.filter((role) => foldName(role.name) === foldName(selector));
  if (folded.length === 1) return folded[0];
  if (folded.length > 1) throw ambiguousRole(selector, folded);
  throw new RoleCliError(
    'unknown_role',
    `No role is called '${selector}'. List them with: commandmate roles list`,
    ExitCode.CONFIG_ERROR
  );
}

export async function resolveRole(client: ApiClient, selector: string): Promise<AgentRoleSummary> {
  const { roles } = await client.get<AgentRoleListResponse>('/api/roles');
  return pickRole(roles, selector);
}

/** The tool a role command names, or the failure for one outside the role feature. */
export function assertRoleTool(tool: string): AgentRoleCliTool {
  if (isAgentRoleCliTool(tool)) return tool;
  throw new RoleCliError(
    'tool_not_supported',
    `Roles do not apply to '${tool}'. They apply to: ${AGENT_ROLE_CLI_TOOLS.join(', ')}`,
    ExitCode.CONFIG_ERROR
  );
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * `--role` and `--no-role` share one commander value, where the last one given wins.
 * Asking for both is a contradiction, so the two are watched as they are parsed.
 *
 * @returns Whether both were given. Read after parsing.
 */
export function watchRoleFlagConflict(command: { on(event: string, listener: () => void): unknown }): () => boolean {
  let role = false;
  let noRole = false;
  command.on('option:role', () => {
    role = true;
  });
  command.on('option:no-role', () => {
    noRole = true;
  });
  return () => role && noRole;
}

/** `--role <role>` / `--no-role` as a setting, or undefined when neither was given. */
export async function roleAssignmentFromFlag(
  client: ApiClient,
  flag: string | false | undefined
): Promise<RoleAssignmentInput | undefined> {
  if (flag === undefined) return undefined;
  if (flag === false) return { state: 'none' };
  const role = await resolveRole(client, flag);
  return { state: 'role', roleId: role.id };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface RegisteredRepository {
  id: string;
  name: string;
  path: string;
  enabled?: boolean;
}

function isPathShaped(selector: string): boolean {
  return selector.includes('/') || selector.startsWith('.');
}

function describeRepository(repository: RegisteredRepository): string {
  return `${repository.id}  ${repository.name}  ${repository.path}`;
}

function ambiguousRepository(selector: string, matches: RegisteredRepository[]): RoleCliError {
  return new RoleCliError(
    'ambiguous_repository',
    `'${selector}' could mean ${matches.length} repositories. Name one by its ID:\n`
      + matches.map((repository) => `  - ${describeRepository(repository)}`).join('\n'),
    ExitCode.CONFIG_ERROR,
    { candidates: matches.map(({ id, name, path: repositoryPath }) => ({ id, name, path: repositoryPath })) }
  );
}

export async function listRepositories(client: ApiClient): Promise<RegisteredRepository[]> {
  const { repositories } = await client.get<{ repositories: RegisteredRepository[] }>('/api/repositories');
  return repositories;
}

/**
 * The root a path-shaped `--repo` names: a registered root, or the root of the
 * registered worktree at that path, which is what "this repository" is from inside one.
 */
async function repositoryAtPath(
  client: ApiClient,
  repositories: readonly RegisteredRepository[],
  selector: string
): Promise<RegisteredRepository[]> {
  const wanted = canonicalPath(selector);
  const roots = repositories.filter((repository) => canonicalPath(repository.path) === wanted);
  if (roots.length > 0) return roots;
  const { worktrees } = await client.get<{ worktrees?: Array<{ path?: string; repositoryPath?: string }> }>('/api/worktrees');
  const worktree = (worktrees ?? []).find((row) => typeof row.path === 'string' && canonicalPath(row.path) === wanted);
  if (typeof worktree?.repositoryPath !== 'string') return [];
  const root = canonicalPath(worktree.repositoryPath);
  return repositories.filter((repository) => canonicalPath(repository.path) === root);
}

/** The registered repository `--repo` names. See the module's decisions for the order. */
export async function resolveRepository(client: ApiClient, selector: string): Promise<RegisteredRepository> {
  const repositories = await listRepositories(client);
  const byId = repositories.filter((repository) => repository.id === selector);
  if (byId.length === 1) return byId[0];

  if (isPathShaped(selector)) {
    const matches = await repositoryAtPath(client, repositories, selector);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw ambiguousRepository(selector, matches);
    if (isDirectory(selector)) {
      throw new RoleCliError(
        'repository_not_registered',
        `${selector} is a directory, but neither a registered repository nor a worktree of one. `
          + 'See what is registered with: commandmate roles defaults',
        ExitCode.CONFIG_ERROR
      );
    }
  } else {
    const exact = repositories.filter((repository) => repository.name === selector);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw ambiguousRepository(selector, exact);
    const folded = repositories.filter((repository) => foldName(repository.name) === foldName(selector));
    if (folded.length === 1) return folded[0];
    if (folded.length > 1) throw ambiguousRepository(selector, folded);
  }
  throw new RoleCliError(
    'unknown_repository',
    `No repository matches '${selector}'. See what is registered with: commandmate roles defaults`,
    ExitCode.CONFIG_ERROR
  );
}
