/**
 * The transform from a resolved role to what each CLI is handed (§5–§7 of
 * `docs/design/agent-roles-adapters.md`). Pure: no database, no filesystem, no
 * tmux. What the user's settings say arrives as {@link RoleComposition}, read
 * once by `./composition`, so the same inputs always give the same fingerprint.
 *
 * ## The injection fingerprint
 *
 * It says what the process would actually be told, and it decides everything that
 * compares roles: restart pending, whether two launches may join, and the file name.
 * In: the adapter and its version, the wrapper version, the body fingerprint, and
 * the composition inputs (Codex's `developer_instructions`, V2's effective agent, an
 * explicit agent). Out: the role's name and id, where it was inherited from, paths,
 * and the other keys of the user's env. So a rename or another level holding the
 * same text is not a restart, and a change in `config.toml` is.
 *
 * @module lib/agent-roles/adapters
 */
import { dirname } from 'path';
import { shellQuote } from '@/lib/hooks/hook-settings-generator';
import type { AgentRoleCliTool, ResolvedRole } from '@/types/agent-roles';
import { computeBodyFingerprint, computeFingerprint } from './fingerprint';

/** Moves when what an adapter generates for the same input changes. */
const ADAPTER_VERSION = '1';

/** The wrapper every adapter puts around a body. Moves with its text. */
export const ROLE_WRAPPER_VERSION = '1';

/** V2's wrapper: the shared one plus {@link OPENCODE_V2_COMMON_INSTRUCTIONS}. */
export const OPENCODE_V2_WRAPPER_VERSION = '1+common-1';

/**
 * Says that the request and the contract outrank the role. It is a request to the
 * model and guarantees nothing (§5): the gates still judge by evidence.
 */
export const ROLE_WRAPPER_TEXT =
  'CommandMate started you with the role below. Keep following the current request, ' +
  'any execution contract and the project instructions (AGENTS.md, CLAUDE.md and the like); ' +
  'where they conflict with the role, they win. The role does not relax a contract, ' +
  'a verification step or a permission rule.';

/**
 * For OpenCode V2 only, whose `system` replaces the provider's base prompt (§7.2).
 * A precaution for the guidance that replacement drops, not a measured improvement.
 * The API says "replaces the default instructions" beside it.
 */
export const OPENCODE_V2_COMMON_INSTRUCTIONS = [
  'You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.',
  'Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.',
  'Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.',
  'Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.',
].join('\n');

/** What the user's settings add to one injection. Read once per launch. */
export interface RoleComposition {
  /** Codex: `developer_instructions` of `config.toml`, which a profile would replace. */
  codexDeveloperInstructions?: string | null;
  /** OpenCode V1 and V2: the user's parsed `OPENCODE_CONFIG_CONTENT`, null when unset. */
  opencodeUserContent?: Record<string, unknown> | null;
  /** OpenCode V2: the agent whose `system` is overridden (§7.1). */
  opencodeV2EffectiveAgent?: string;
  /** Schedule's `agent`. Changes what V2 overrides; alongside for V1 and Claude. */
  explicitAgent?: string | null;
}

/** Everything about one injection except the file, which is the writer's. */
export interface RoleInjection {
  adapter: AgentRoleCliTool;
  adapterVersion: string;
  wrapperVersion: string;
  injectionFingerprint: string;
  /** The full text for the model: wrapped, and composed where the adapter needs it. */
  instructions: string;
  effectiveAgent: string | null;
  compositionSourceFingerprint: string | null;
}

export function roleWrapperVersion(adapter: AgentRoleCliTool): string {
  return adapter === 'opencode-v2' ? OPENCODE_V2_WRAPPER_VERSION : ROLE_WRAPPER_VERSION;
}

function buildInstructions(adapter: AgentRoleCliTool, body: string, composition: RoleComposition): string {
  const wrapped = `${ROLE_WRAPPER_TEXT}\n\n${body}`;
  if (adapter === 'opencode-v2') return `${OPENCODE_V2_COMMON_INSTRUCTIONS}\n\n${wrapped}`;
  const existing = composition.codexDeveloperInstructions;
  if (adapter === 'codex' && existing) return `${existing}\n\n${wrapped}`;
  return wrapped;
}

/**
 * Fingerprint and text for one role through one adapter.
 *
 * @param role - Only the body fingerprint and body are read; the name and id are not inputs
 */
export function computeRoleInjection(
  adapter: AgentRoleCliTool,
  role: Pick<ResolvedRole, 'body' | 'bodyFingerprint'>,
  composition: RoleComposition
): RoleInjection {
  const wrapperVersion = roleWrapperVersion(adapter);
  const codexSource =
    adapter === 'codex' && composition.codexDeveloperInstructions
      ? computeBodyFingerprint(composition.codexDeveloperInstructions)
      : null;
  const effectiveAgent = adapter === 'opencode-v2' ? (composition.opencodeV2EffectiveAgent ?? null) : null;
  const explicitAgent = composition.explicitAgent ?? null;
  const canonical = JSON.stringify({
    adapter,
    adapterVersion: ADAPTER_VERSION,
    wrapperVersion,
    bodyFingerprint: role.bodyFingerprint,
    codexDeveloperInstructions: codexSource,
    effectiveAgent,
    explicitAgent,
  });
  return {
    adapter,
    adapterVersion: ADAPTER_VERSION,
    wrapperVersion,
    injectionFingerprint: computeFingerprint(Buffer.from(canonical, 'utf8')),
    instructions: buildInstructions(adapter, role.body, composition),
    effectiveAgent,
    compositionSourceFingerprint: codexSource,
  };
}

/** How a generated file reaches the CLI. A name and a path; never the body. */
export interface RoleLaunchArguments {
  /** Raw arguments, unquoted. Interactive: after the command. Headless: see {@link headlessPosition}. */
  args: string[];
  /**
   * Where these go in a headless argv. Codex's `-p` must precede `exec`, and
   * Copilot's `--agent` must follow `gh copilot` and precede `-p` (§14).
   */
  headlessPosition: 'leading' | 'trailing';
  /** The environment to start with: a config value (OpenCode), or the home to look in (Codex, Copilot). */
  env: Record<string, string>;
  /**
   * Whether the OpenCode config in {@link env} contains values the user set. They may
   * be secrets, so it must not be spelled on a line a pane will show (§7.1). See
   * {@link splitRoleEnv}.
   */
  envCarriesUserValues: boolean;
}

export const OPENCODE_CONFIG_CONTENT_ENV_VAR = 'OPENCODE_CONFIG_CONTENT';
const CODEX_HOME_ENV_VAR = 'CODEX_HOME';
const COPILOT_HOME_ENV_VAR = 'COPILOT_HOME';

/** V1: appended to `instructions`, and nothing else touched (#2053's lesson). */
function composeOpencodeV1Content(
  user: Record<string, unknown> | null | undefined,
  path: string
): Record<string, unknown> {
  const existing = user?.instructions;
  return { ...user, instructions: [...(Array.isArray(existing) ? existing : []), path] };
}

/** V2: `agents.<effective>.system` only. `model`, `providers`, `default_agent` stay. */
function composeOpencodeV2Content(
  user: Record<string, unknown> | null | undefined,
  agent: string,
  path: string
): Record<string, unknown> {
  const agents = (user?.agents ?? {}) as Record<string, unknown>;
  const current = (agents[agent] ?? {}) as Record<string, unknown>;
  return { ...user, agents: { ...agents, [agent]: { ...current, system: `{file:${path}}` } } };
}

/**
 * The arguments and environment that hand one generated file to its CLI.
 *
 * @param artifact - The name and path `writeRoleArtifact` answered
 */
export function buildRoleLaunchArguments(
  injection: Pick<RoleInjection, 'adapter' | 'effectiveAgent'>,
  artifact: { name: string; path: string },
  composition: RoleComposition
): RoleLaunchArguments {
  const flag = (
    args: string[],
    headlessPosition: 'leading' | 'trailing',
    env: Record<string, string> = {}
  ): RoleLaunchArguments => ({
    args,
    headlessPosition,
    env,
    envCarriesUserValues: false,
  });
  const content = (value: Record<string, unknown>): RoleLaunchArguments => ({
    args: [],
    headlessPosition: 'trailing',
    env: { [OPENCODE_CONFIG_CONTENT_ENV_VAR]: JSON.stringify(value) },
    envCarriesUserValues: composition.opencodeUserContent != null,
  });
  const { adapter } = injection;
  switch (adapter) {
    case 'claude':
      return flag(['--append-system-prompt-file', artifact.path], 'trailing');
    case 'codex':
      // Codex finds a profile by name in its home, and a pane has the tmux server's
      // environment, not this process's. The home is stated so that the file just
      // inspected is the one it finds, with hooks on or off.
      return flag(['-p', artifact.name], 'leading', { [CODEX_HOME_ENV_VAR]: dirname(artifact.path) });
    case 'command-code':
      return flag(['--mod', artifact.path], 'trailing');
    case 'copilot':
      // The same for Copilot, whose definitions are in `<home>/agents/`.
      return flag(['--agent', artifact.name], 'leading', { [COPILOT_HOME_ENV_VAR]: dirname(dirname(artifact.path)) });
    case 'antigravity':
      return flag(['--agent', artifact.name], 'trailing');
    case 'opencode':
      return content(composeOpencodeV1Content(composition.opencodeUserContent, artifact.path));
    case 'opencode-v2':
      return content(
        composeOpencodeV2Content(composition.opencodeUserContent, injection.effectiveAgent ?? 'build', artifact.path)
      );
  }
}

/**
 * Which part of a role's environment may be written on a line.
 *
 * @returns `plain`, safe to spell (paths and names); `secret`, the value of the one
 *   variable that has to go through a private file, when it holds the user's values
 */
export function splitRoleEnv(role: Pick<RoleLaunchArguments, 'env' | 'envCarriesUserValues'>): {
  plain: Record<string, string>;
  secret: string | null;
} {
  const { [OPENCODE_CONFIG_CONTENT_ENV_VAR]: content, ...others } = role.env;
  if (content === undefined) return { plain: others, secret: null };
  if (role.envCarriesUserValues) return { plain: others, secret: content };
  return { plain: { ...others, [OPENCODE_CONFIG_CONTENT_ENV_VAR]: content }, secret: null };
}

/** The assignment that reads a composed config from its private file. */
export function renderSecretEnvAssignment(file: string): string {
  return `${OPENCODE_CONFIG_CONTENT_ENV_VAR}="$(cat ${shellQuote(file)})" `;
}

/** The arguments as they go on a shell line. */
export function renderRoleFlags(args: readonly string[]): string {
  return args.map((arg) => (/^[A-Za-z0-9_./=-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ');
}
