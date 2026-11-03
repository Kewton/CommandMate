/**
 * roles Command - define roles and set their defaults, without a screen (Issue #4116).
 *
 * A thin client over `/api/roles`, `/api/settings/agent-role-defaults` and
 * `/api/repositories/:id/role-defaults`. The rules are the server's; what is here
 * is naming things the way a person does (`utils/agent-roles.ts`) and saying what a
 * change reaches.
 */

import { Command } from 'commander';
import type { RolesOptions } from '../types';
import { ApiClient, ApiError } from '../utils/api-client';
import { TOKEN_WARNING } from '../utils/command-helpers';
import {
  assertRoleTool,
  listRepositories,
  readRoleBodyOption,
  reportRoleFailure,
  resolveRepository,
  resolveRole,
  usageError,
  type RegisteredRepository,
} from '../utils/agent-roles';
import {
  AGENT_ROLE_CLI_TOOLS,
  type AgentRoleDeleteResponse,
  type AgentRoleDetail,
  type AgentRoleDetailResponse,
  type AgentRoleEditResponse,
  type AgentRoleListResponse,
  type AgentRoleReferences,
  type EffectiveRole,
  type RepositoryRoleDefaultEntry,
  type RepositoryRoleDefaultsResponse,
  type RoleAssignmentInput,
  type StoredRoleState,
  type StoredSystemRoleState,
  type SystemRoleDefaultEntry,
  type SystemRoleDefaultsResponse,
} from '../../types/agent-roles';

/** Stated in `roles --help`, in `docs` and in the guide; the three say the same. */
const ROLES_HELP = `
Three different things (only the last touches a running session):
  roles edit       changes the role's text. Every setting pointing at it follows,
                   from the next start. Running sessions keep what they started with.
  roles default    changes what a new start resolves to, per tool: for one repository
                   (--repo) or for all that do not say otherwise. Schedules follow too.
  instances <wt> set-role / send --role
                   sets one instance. A role is fixed when the process starts: a running
                   one keeps its role until stopped (instances <wt> kill <id>). Then send.

<role> is an ID or a name; an exact match wins, then one ignoring case and Unicode form.
Two answers is exit 2 with the candidates. Nothing is reserved: --none and --inherit are
flags, so a role can be called "none".

--repo is an ID, then a path, then a name:
  - a value with a "/" or starting with "." is a path: a registered repository, or a
    worktree of one, which answers for its repository (so --repo . works in a worktree)
  - a bare word is a name, never a path
See what is registered with: commandmate roles defaults
Errors say which: unknown_repository, repository_not_registered (a directory with no
row), ambiguous_repository. A repository with no setting for a tool is not an error:
it reads stored: inherit, and effective says what it gets instead.

Tools: ${AGENT_ROLE_CLI_TOOLS.join(', ')}. Any other is exit 2 (tool_not_supported).

Exit codes:
  0   done
  1   the server is not running
  2   bad arguments, a body that cannot be stored, unknown or ambiguous role or
      repository, a tool outside the feature
  31  a conflict; nothing changed: name_conflict, version_conflict (--if-version),
      role_in_use (roles rm without --force)
  99  anything else

--json goes to stdout:
  list      { success, roles: [{ id, name, bodyVersion, bodyFingerprint, bodyBytes, createdAt, updatedAt }] }
  show      { success, role: { ...those, body }, references: { instances, repositories, system } }
  add       { success, role }
  edit      { success, before, after, bodyVersion, affected, impact }
  rm        { success, deleted: { id, name }, affected }
  default   { success, level: system | repository, cliToolId, repository?, before, after, impact }
              before / after: { stored, effective? }; impact: { repositories, schedules, runningSessions, message }
  defaults  { success, system: [{ cliToolId, adapterEnabled, stored, effective }], repositories }
            with --repo: { success, repository, defaults: [{ cliToolId, adapterEnabled, stored, effective }] }
              stored.state: role | none | inherit (no row) | unset (system, no row)
              effective.kind: role | none | ambiguous; effective.source: repository | system | fallback
  failure   { success: false, error: <code>, message, candidates? | references? | currentBodyVersion? }
            The same sentence goes to stderr. Failures with no role code of their own say
            internal_error, request_failed, no_response (no server), role_api_unavailable
            (a server older than roles) or unexpected_error, with the exit code above.
            A missing argument or unknown option is commander's: stderr only, exit 1.

Example: define a reviewer and make it this repository's Codex default
  commandmate roles add reviewer --file ./reviewer.md
  commandmate roles default codex --repo . --role reviewer
`;

type RolesAction = (client: ApiClient) => Promise<void>;

async function run(options: RolesOptions, action: RolesAction): Promise<void> {
  try {
    await action(new ApiClient({ token: options.token }));
  } catch (error) {
    reportRoleFailure(error, options.json);
  }
}

function withCommon(command: Command): Command {
  return command
    .option('--json', 'JSON output on stdout, failures included')
    .option('--token <token>', TOKEN_WARNING);
}

function print(options: RolesOptions, value: unknown, text: string): void {
  if (options.json) console.log(JSON.stringify(value, null, 2));
  else console.log(text);
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

function describeStored(stored: StoredRoleState | StoredSystemRoleState): string {
  if (stored.state === 'role') return stored.roleName;
  return stored.state === 'inherit' ? 'inherit (no setting)' : stored.state === 'unset' ? 'unset' : 'none';
}

function describeEffective(effective: EffectiveRole | SystemEffective): string {
  if (effective.kind === 'role') return `${effective.role.name} (${effective.source})`;
  if (effective.kind === 'none') return `no role (${effective.source})`;
  return 'ambiguous: the roots of this repository disagree';
}

function describeReferences(references: AgentRoleReferences): string[] {
  return [
    ...references.instances.map(({ worktreeId, instanceId }) => `  instance ${instanceId} of ${worktreeId}`),
    ...references.repositories.map(({ repositoryPath, cliToolId }) => `  ${cliToolId} default of ${repositoryPath}`),
    ...references.system.map(({ cliToolId }) => `  ${cliToolId} system default`),
  ];
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

async function listRoles(client: ApiClient, options: RolesOptions): Promise<void> {
  const response = await client.get<AgentRoleListResponse>('/api/roles');
  print(
    options,
    response,
    response.roles.length === 0
      ? 'No roles. Define one with: commandmate roles add <name> --file <path>'
      : formatTable(
          ['ID', 'NAME', 'VERSION', 'BYTES'],
          response.roles.map((role) => [role.id, role.name, String(role.bodyVersion), String(role.bodyBytes)])
        )
  );
}

async function showRole(client: ApiClient, selector: string, options: RolesOptions): Promise<void> {
  const { id } = await resolveRole(client, selector);
  const response = await client.get<AgentRoleDetailResponse>(`/api/roles/${encodeURIComponent(id)}`);
  const { role, references } = response;
  const used = describeReferences(references);
  print(
    options,
    response,
    [
      `id: ${role.id}`,
      `name: ${role.name}`,
      `version: ${role.bodyVersion}`,
      `used by: ${used.length === 0 ? 'nothing directly' : ''}`,
      ...used,
      '',
      role.body,
    ].join('\n')
  );
}

interface BodyOptions extends RolesOptions {
  file?: string;
  stdin?: boolean;
}

async function addRole(client: ApiClient, name: string, options: BodyOptions): Promise<void> {
  const body = await readRoleBodyOption(options);
  if (body === undefined) throw usageError('Give the body with --file <path> or --stdin.');
  const response = await client.post<{ success: true; role: AgentRoleDetail }>('/api/roles', { name, body });
  print(options, response, `Role added: ${response.role.name} (${response.role.id})`);
}

/** Editing a role reaches everything resolving to it, from the next start. */
const EDIT_IMPACT_MESSAGE =
  'Every setting pointing at this role, and everything inheriting one, gets the new text from its next start, '
  + 'Schedules included. Running sessions keep what they started with.';

async function editRole(
  client: ApiClient,
  selector: string,
  options: BodyOptions & { name?: string; ifVersion?: string }
): Promise<void> {
  let expectedBodyVersion: number | undefined;
  if (options.ifVersion !== undefined) {
    if (!/^[0-9]+$/.test(options.ifVersion)) throw usageError('--if-version must be a whole number.');
    expectedBodyVersion = Number(options.ifVersion);
  }
  const body = await readRoleBodyOption(options);
  if (options.name === undefined && body === undefined) {
    throw usageError('Nothing to change: give --name, --file or --stdin.');
  }
  const { id } = await resolveRole(client, selector);
  const response = await client.put<AgentRoleEditResponse>(`/api/roles/${encodeURIComponent(id)}`, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(expectedBodyVersion !== undefined ? { expectedBodyVersion } : {}),
  });
  const { before, after, affected } = response;
  const used = describeReferences(affected);
  print(
    options,
    { ...response, impact: { schedules: true, runningSessions: false, message: EDIT_IMPACT_MESSAGE } },
    [
      `Role updated: ${before.name === after.name ? after.name : `${before.name} -> ${after.name}`} `
        + `(version ${before.bodyVersion} -> ${after.bodyVersion})`,
      `Points at it directly: ${used.length === 0 ? 'nothing' : ''}`,
      ...used,
      EDIT_IMPACT_MESSAGE,
    ].join('\n')
  );
}

async function removeRole(client: ApiClient, selector: string, options: RolesOptions & { force?: boolean }): Promise<void> {
  const { id } = await resolveRole(client, selector);
  let response: AgentRoleDeleteResponse;
  try {
    response = await client.delete<AgentRoleDeleteResponse>(
      `/api/roles/${encodeURIComponent(id)}${options.force ? '?force=true' : ''}`
    );
  } catch (error) {
    // The sentence alone does not say what is in the way.
    if (error instanceof ApiError && error.payload?.error === 'role_in_use' && error.payload.references && !options.json) {
      const used = describeReferences(error.payload.references as AgentRoleReferences);
      console.error(['In use by:', ...used, 'To remove it along with those settings: --force'].join('\n'));
    }
    throw error;
  }
  const dropped = describeReferences(response.affected);
  print(
    options,
    response,
    [
      `Role removed: ${response.deleted.name}`,
      ...(dropped.length > 0 ? ['Settings that pointed at it now follow the defaults:', ...dropped] : []),
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The system level as the same three words a repository's entry answers in. */
type SystemEffective =
  | { kind: 'role'; source: 'system'; role: { id: string; name: string } }
  | { kind: 'none'; source: 'fallback'; reason: 'no-default' };

function systemEffective(stored: StoredSystemRoleState): SystemEffective {
  return stored.state === 'role'
    ? { kind: 'role', source: 'system', role: { id: stored.roleId, name: stored.roleName } }
    : { kind: 'none', source: 'fallback', reason: 'no-default' };
}

function systemEntryOf(defaults: SystemRoleDefaultEntry[], tool: string): SystemRoleDefaultEntry {
  const entry = defaults.find(({ cliToolId }) => cliToolId === tool);
  if (!entry) throw usageError(`The server has no default for ${tool}.`);
  return entry;
}

function repositoryEntryOf(defaults: RepositoryRoleDefaultEntry[], tool: string): RepositoryRoleDefaultEntry {
  const entry = defaults.find(({ cliToolId }) => cliToolId === tool);
  if (!entry) throw usageError(`The server has no default for ${tool}.`);
  return entry;
}

function repositorySummary({ id, name, path, enabled }: RegisteredRepository): RegisteredRepository {
  return { id, name, path, ...(enabled !== undefined ? { enabled } : {}) };
}

/**
 * The repositories a system default reaches: those holding no setting of their own
 * for the tool. Null when that could not be read; the change has happened by then,
 * and this only describes it.
 */
async function repositoriesInheriting(client: ApiClient, tool: string): Promise<RegisteredRepository[] | null> {
  try {
    const repositories = await listRepositories(client);
    const inheriting = await Promise.all(
      repositories.map(async (repository) => {
        const { defaults } = await client.get<RepositoryRoleDefaultsResponse>(
          `/api/repositories/${encodeURIComponent(repository.id)}/role-defaults`
        );
        return repositoryEntryOf(defaults, tool).stored.state === 'inherit';
      })
    );
    return repositories.filter((_, index) => inheriting[index]).map(repositorySummary);
  } catch {
    return null;
  }
}

interface DefaultOptions extends RolesOptions {
  repo?: string;
  role?: string;
  none?: boolean;
  inherit?: boolean;
}

function assertOneAssignment(options: DefaultOptions): void {
  const given = [options.role !== undefined, options.none === true, options.inherit === true].filter(Boolean).length;
  if (given !== 1) {
    throw usageError(
      options.repo === undefined
        ? 'Give one of --role <role> or --none.'
        : 'Give one of --role <role>, --none or --inherit.'
    );
  }
  if (options.repo === undefined && options.inherit) {
    throw usageError('--inherit needs --repo: the system level is the last one, and has nothing to inherit from.');
  }
}

function warnAdapterDisabled(tool: string, enabled: boolean): void {
  if (!enabled) {
    console.error(`Warning: roles are not enabled for ${tool} yet: a start that resolves to one is refused.`);
  }
}

async function setSystemDefault(client: ApiClient, tool: string, options: DefaultOptions): Promise<void> {
  const roleId = options.role !== undefined ? (await resolveRole(client, options.role)).id : null;
  const before = systemEntryOf(
    (await client.get<SystemRoleDefaultsResponse>('/api/settings/agent-role-defaults')).defaults,
    tool
  );
  const { defaults } = await client.put<SystemRoleDefaultsResponse>('/api/settings/agent-role-defaults', {
    cliToolId: tool,
    roleId,
  });
  const after = systemEntryOf(defaults, tool);
  warnAdapterDisabled(tool, after.adapterEnabled);
  const repositories = await repositoriesInheriting(client, tool);
  const message =
    `From its next start, every ${tool} session with no setting of its own in a repository with none either `
    + 'gets this, Schedules included. Running sessions keep what they started with.';
  print(
    options,
    {
      success: true,
      level: 'system',
      cliToolId: tool,
      before: { stored: before.stored, effective: systemEffective(before.stored) },
      after: { stored: after.stored, effective: systemEffective(after.stored) },
      impact: { repositories, schedules: true, runningSessions: false, message },
    },
    [
      `System default of ${tool}: ${describeStored(before.stored)} -> ${describeStored(after.stored)}`,
      repositories === null
        ? 'Could not read which repositories inherit it.'
        : `Repositories inheriting it: ${repositories.map(({ name }) => name).join(', ') || 'none'}`,
      message,
    ].join('\n')
  );
}

async function setRepositoryDefault(client: ApiClient, tool: string, repo: string, options: DefaultOptions): Promise<void> {
  const repository = await resolveRepository(client, repo);
  const role: RoleAssignmentInput = options.none
    ? { state: 'none' }
    : options.inherit
      ? { state: 'inherit' }
      : { state: 'role', roleId: (await resolveRole(client, options.role as string)).id };
  const url = `/api/repositories/${encodeURIComponent(repository.id)}/role-defaults`;
  const before = repositoryEntryOf((await client.get<RepositoryRoleDefaultsResponse>(url)).defaults, tool);
  const response = await client.put<RepositoryRoleDefaultsResponse>(url, { cliToolId: tool, role });
  const after = repositoryEntryOf(response.defaults, tool);
  warnAdapterDisabled(tool, after.adapterEnabled);
  if (after.effective.kind === 'ambiguous') {
    console.error(
      'Warning: the registered roots of this repository now disagree, and a start there is refused until they agree:\n'
        + after.effective.roots.map(({ path, state }) => `  - ${path}: ${describeStored(state)}`).join('\n')
    );
  }
  const message =
    `From its next start, every ${tool} session of this repository with no setting of its own gets this, `
    + 'Schedules included. Running sessions keep what they started with.';
  print(
    options,
    {
      success: true,
      level: 'repository',
      cliToolId: tool,
      repository: response.repository,
      before: { stored: before.stored, effective: before.effective },
      after: { stored: after.stored, effective: after.effective },
      impact: {
        repositories: [response.repository],
        sharedRootIds: after.effective.repositoryIds,
        schedules: true,
        runningSessions: false,
        message,
      },
    },
    [
      `Default of ${tool} in ${response.repository.name}: ${describeStored(before.stored)} -> ${describeStored(after.stored)}`,
      `A new start there gets: ${describeEffective(after.effective)}`,
      message,
    ].join('\n')
  );
}

async function setDefault(client: ApiClient, tool: string, options: DefaultOptions): Promise<void> {
  assertRoleTool(tool);
  assertOneAssignment(options);
  if (options.repo !== undefined) await setRepositoryDefault(client, tool, options.repo, options);
  else await setSystemDefault(client, tool, options);
}

async function showDefaults(client: ApiClient, options: RolesOptions & { repo?: string; tool?: string }): Promise<void> {
  if (options.tool !== undefined) assertRoleTool(options.tool);
  const wanted = <T extends { cliToolId: string }>(entries: T[]): T[] =>
    options.tool === undefined ? entries : entries.filter(({ cliToolId }) => cliToolId === options.tool);

  if (options.repo !== undefined) {
    const repository = await resolveRepository(client, options.repo);
    const response = await client.get<RepositoryRoleDefaultsResponse>(
      `/api/repositories/${encodeURIComponent(repository.id)}/role-defaults`
    );
    const defaults = wanted(response.defaults);
    print(
      options,
      { ...response, defaults },
      [
        `${response.repository.name}  ${response.repository.path}`,
        formatTable(
          ['TOOL', 'STORED', 'EFFECTIVE'],
          defaults.map(({ cliToolId, stored, effective }) => [cliToolId, describeStored(stored), describeEffective(effective)])
        ),
      ].join('\n')
    );
    return;
  }

  const { defaults } = await client.get<SystemRoleDefaultsResponse>('/api/settings/agent-role-defaults');
  const repositories = (await listRepositories(client)).map(repositorySummary);
  const system = wanted(defaults).map((entry) => ({ ...entry, effective: systemEffective(entry.stored) }));
  print(
    options,
    { success: true, system, repositories },
    [
      formatTable(
        ['TOOL', 'SYSTEM_DEFAULT', 'EFFECTIVE'],
        system.map(({ cliToolId, stored, effective }) => [cliToolId, describeStored(stored), describeEffective(effective)])
      ),
      '',
      'Registered repositories (for --repo):',
      repositories.length === 0
        ? '  none'
        : formatTable(['ID', 'NAME', 'PATH'], repositories.map(({ id, name, path }) => [id, name, path])),
    ].join('\n')
  );
}

export function createRolesCommand(): Command {
  const cmd = new Command('roles');
  cmd.description('Define roles and set which one a new session gets, by tool and repository').addHelpText('after', ROLES_HELP);

  withCommon(cmd.command('list').description('List the roles, without their bodies'))
    .action((options: RolesOptions) => run(options, (client) => listRoles(client, options)));

  withCommon(cmd.command('show').description('Show one role, its body and what points at it').argument('<role>', 'Role ID or name'))
    .action((role: string, options: RolesOptions) => run(options, (client) => showRole(client, role, options)));

  withCommon(
    cmd
      .command('add')
      .description('Define a role. The body comes from --file or stdin, byte for byte')
      .argument('<name>', 'Role name')
      .option('--file <path>', 'Read the body from this file')
      .option('--stdin', 'Read the body from stdin')
  ).action((name: string, options: BodyOptions) => run(options, (client) => addRole(client, name, options)));

  withCommon(
    cmd
      .command('edit')
      .description('Rename a role or change its body. Running sessions keep what they started with')
      .argument('<role>', 'Role ID or name')
      .option('--name <name>', 'New name')
      .option('--file <path>', 'Read the new body from this file')
      .option('--stdin', 'Read the new body from stdin')
      .option('--if-version <n>', 'Refuse (exit 31) unless the body is still at this version')
  ).action((role: string, options: BodyOptions & { name?: string; ifVersion?: string }) =>
    run(options, (client) => editRole(client, role, options))
  );

  withCommon(
    cmd
      .command('rm')
      .description('Remove a role. Refused (exit 31) while something points at it')
      .argument('<role>', 'Role ID or name')
      .option('--force', 'Remove what points at it too; those settings then follow the defaults')
  ).action((role: string, options: RolesOptions & { force?: boolean }) =>
    run(options, (client) => removeRole(client, role, options))
  );

  withCommon(
    cmd
      .command('default')
      .description('Set which role a new start of this tool gets, for one repository (--repo) or all that do not say otherwise')
      .argument('<tool>', `One of: ${AGENT_ROLE_CLI_TOOLS.join(', ')}`)
      .option('--repo <repository>', 'Repository ID, path or name. Omit for the system level')
      .option('--role <role>', 'Role ID or name')
      .option('--none', 'With --repo: explicitly no role. Without: remove the system default')
      .option('--inherit', 'With --repo: drop the setting, and follow the system default')
  ).action((tool: string, options: DefaultOptions) => run(options, (client) => setDefault(client, tool, options)));

  withCommon(
    cmd
      .command('defaults')
      .description('Show the defaults and the registered repositories. Changes nothing')
      .option('--repo <repository>', 'Repository ID, path or name: what it holds, and what a worktree of it gets')
      .option('--tool <tool>', 'Only this tool')
  ).action((options: RolesOptions & { repo?: string; tool?: string }) => run(options, (client) => showDefaults(client, options)));

  return cmd;
}
