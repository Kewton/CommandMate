/**
 * Reading what a role has to be composed with: the user's env value, Codex's
 * `config.toml`, OpenCode V2's effective agent (§6.2, §7.1). Reads only; the D4
 * rule is that an existing file of the user's is never written.
 *
 * A failure refuses the launch ({@link RoleCompositionError}) rather than falling
 * through: V2 silently ignores a broken env, and overriding an agent's own `system`
 * silently removes the user's text from the request (§7.1).
 *
 * ## Which environment
 *
 * A pane inherits the tmux server's environment, not this process's, so an
 * interactive launch asks tmux (`./pane-env`), and with no server running the one
 * it starts is this process's. A Schedule reads what its child gets
 * (`sanitizeEnvForChildProcess`). What a login shell's rc adds cannot be known here.
 *
 * Errors name a file or a variable, never a value: these can hold API keys.
 *
 * @module lib/agent-roles/composition
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseToml } from 'smol-toml';
import { getCodexHome } from '@/lib/hooks/sources/codex/hooks-config';
import type { AgentRoleCliTool } from '@/types/agent-roles';
import { OPENCODE_CONFIG_CONTENT_ENV_VAR, type RoleComposition } from './adapters';
import { parseJsoncObject } from './jsonc';

export class RoleCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleCompositionError';
  }
}

/** An environment, as handed around here. */
export type RoleEnv = Readonly<Record<string, string | undefined>>;

/** Reads one variable of the environment the agent will get. */
export type RoleEnvReader = (name: string) => Promise<string | undefined>;

export interface RoleCompositionContext {
  worktreePath: string;
  readEnv: RoleEnvReader;
  /** Schedule's `agent`. */
  explicitAgent?: string | null;
  /** Another Codex home than this process's. A probe's, in its isolated state. */
  codexHome?: string;
}

/** An agent name goes into a config key, so nothing unusual gets through unnoticed. */
const AGENT_NAME = /^[A-Za-z0-9_.-]+$/;

/** An env reader for a child process given exactly this environment. */
export function fixedEnvReader(env: RoleEnv): RoleEnvReader {
  return async (name) => env[name];
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RoleCompositionError(`Could not read ${path}`);
  }
}

/**
 * What a profile would otherwise replace (§6.2). Never written.
 *
 * @throws {RoleCompositionError} `config.toml` cannot be read, is not TOML, or holds another type there
 */
export function readCodexDeveloperInstructions(codexHome: string = getCodexHome()): string | null {
  const path = join(codexHome, 'config.toml');
  const text = readOptional(path);
  if (text === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch {
    throw new RoleCompositionError(`${path} is not valid TOML`);
  }
  const value = parsed.developer_instructions;
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new RoleCompositionError(`developer_instructions in ${path} is not a string`);
  return value;
}

/**
 * The user's `OPENCODE_CONFIG_CONTENT`, parsed, or null when unset.
 *
 * @throws {RoleCompositionError} It is not a JSONC object
 */
export function parseUserOpencodeContent(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    return parseJsoncObject(raw);
  } catch (error) {
    throw new RoleCompositionError(
      `${OPENCODE_CONFIG_CONTENT_ENV_VAR} is ${error instanceof Error ? error.message : 'invalid'}; ` +
        'OpenCode V2 would silently ignore it and start with no role'
    );
  }
}

/** One config file, parsed. */
export interface OpencodeConfigFile {
  path: string;
  data: Record<string, unknown>;
}

/** The files read at one level of §7.1's order. */
function readConfigLevel(paths: readonly string[]): OpencodeConfigFile[] {
  const files: OpencodeConfigFile[] = [];
  for (const path of paths) {
    const text = readOptional(path);
    if (text === null) continue;
    try {
      files.push({ path, data: parseJsoncObject(text) });
    } catch {
      throw new RoleCompositionError(`${path} is not valid JSONC, so the effective agent cannot be worked out`);
    }
  }
  return files;
}

function defaultAgentOf(data: Record<string, unknown>, where: string): string | null {
  const value = data.default_agent;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !AGENT_NAME.test(value)) {
    throw new RoleCompositionError(`default_agent in ${where} is not a usable agent name`);
  }
  return value;
}

/**
 * The strongest level's answer. Two files at one level saying different things have
 * no measured order (§7.1), so that is refused rather than guessed.
 */
function levelDefaultAgent(files: readonly OpencodeConfigFile[]): string | null {
  const answers = files
    .map((file) => ({ path: file.path, agent: defaultAgentOf(file.data, file.path) }))
    .filter((answer): answer is { path: string; agent: string } => answer.agent !== null);
  if (new Set(answers.map((answer) => answer.agent)).size > 1) {
    throw new RoleCompositionError(`${answers.map((answer) => answer.path).join(' and ')} name different default agents`);
  }
  return answers[0]?.agent ?? null;
}

function agentHasOwnSystem(data: Record<string, unknown>, agent: string): boolean {
  for (const key of ['agents', 'agent']) {
    const agents = data[key];
    if (typeof agents !== 'object' || agents === null) continue;
    const entry = (agents as Record<string, unknown>)[agent];
    if (typeof entry === 'object' && entry !== null && (entry as { system?: unknown }).system !== undefined) return true;
  }
  return false;
}

export interface OpencodeV2AgentInput {
  explicitAgent?: string | null;
  userContent: Record<string, unknown> | null;
  projectConfigs: readonly OpencodeConfigFile[];
  globalConfigs: readonly OpencodeConfigFile[];
  /** A Markdown definition of this agent, where one exists: it has a body of its own. */
  markdownDefinition: (agent: string) => string | null;
}

/**
 * §7.1's order: explicit, env, project, global, `build`. Refuses an agent whose
 * `system` the user wrote, wherever they wrote it: overriding it would drop their text.
 *
 * @throws {RoleCompositionError}
 */
export function resolveOpencodeV2EffectiveAgent(input: OpencodeV2AgentInput): string {
  const { explicitAgent, userContent, projectConfigs, globalConfigs } = input;
  if (explicitAgent != null && !AGENT_NAME.test(explicitAgent)) {
    throw new RoleCompositionError('The explicit agent is not a usable agent name');
  }
  const agent =
    explicitAgent ??
    (userContent ? defaultAgentOf(userContent, OPENCODE_CONFIG_CONTENT_ENV_VAR) : null) ??
    levelDefaultAgent(projectConfigs) ??
    levelDefaultAgent(globalConfigs) ??
    'build';

  const holders = [
    ...(userContent && agentHasOwnSystem(userContent, agent) ? [OPENCODE_CONFIG_CONTENT_ENV_VAR] : []),
    ...[...projectConfigs, ...globalConfigs].filter((file) => agentHasOwnSystem(file.data, agent)).map((file) => file.path),
  ];
  const markdown = input.markdownDefinition(agent);
  if (markdown) holders.push(markdown);
  if (holders.length > 0) {
    throw new RoleCompositionError(
      `The agent "${agent}" has its own system text (${holders.join(', ')}); a role would remove it from the request`
    );
  }
  return agent;
}

const JSON_NAMES = ['opencode.json', 'opencode.jsonc'] as const;

async function loadOpencodeV2Agent(
  context: RoleCompositionContext,
  userContent: Record<string, unknown> | null
): Promise<string> {
  const home = (await context.readEnv('HOME')) || homedir();
  const configHome = (await context.readEnv('XDG_CONFIG_HOME')) || join(home, '.config');
  const globalDir = join(configHome, 'opencode');
  const projectDirs = [context.worktreePath, join(context.worktreePath, '.opencode')];
  return resolveOpencodeV2EffectiveAgent({
    explicitAgent: context.explicitAgent,
    userContent,
    projectConfigs: readConfigLevel(projectDirs.flatMap((dir) => JSON_NAMES.map((name) => join(dir, name)))),
    globalConfigs: readConfigLevel(JSON_NAMES.map((name) => join(globalDir, name))),
    markdownDefinition: (agent) => {
      const candidates = [join(context.worktreePath, '.opencode'), globalDir].flatMap((dir) =>
        ['agents', 'agent'].map((sub) => join(dir, sub, `${agent}.md`))
      );
      return candidates.find((path) => existsSync(path)) ?? null;
    },
  });
}

/**
 * Everything the adapter needs from the user's settings.
 *
 * @throws {RoleCompositionError} Anything unreadable or contradictory
 */
export async function loadRoleComposition(
  adapter: AgentRoleCliTool,
  context: RoleCompositionContext
): Promise<RoleComposition> {
  const explicitAgent = context.explicitAgent ?? null;
  switch (adapter) {
    case 'codex':
      return { explicitAgent, codexDeveloperInstructions: readCodexDeveloperInstructions(context.codexHome) };
    case 'opencode': {
      const opencodeUserContent = parseUserOpencodeContent(await context.readEnv(OPENCODE_CONFIG_CONTENT_ENV_VAR));
      const existing = opencodeUserContent?.instructions;
      if (existing !== undefined && !Array.isArray(existing)) {
        throw new RoleCompositionError(`instructions in ${OPENCODE_CONFIG_CONTENT_ENV_VAR} is not an array`);
      }
      return { explicitAgent, opencodeUserContent };
    }
    case 'opencode-v2': {
      const opencodeUserContent = parseUserOpencodeContent(await context.readEnv(OPENCODE_CONFIG_CONTENT_ENV_VAR));
      return {
        explicitAgent,
        opencodeUserContent,
        opencodeV2EffectiveAgent: await loadOpencodeV2Agent(context, opencodeUserContent),
      };
    }
    default:
      return { explicitAgent };
  }
}
