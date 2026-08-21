/**
 * OpenCode configuration file generator
 * Issue #379: Generates opencode.json with Ollama provider configuration
 * Issue #398: Added LM Studio provider support
 *
 * @remarks [D1-001 SRP] Separated from opencode.ts to maintain single responsibility.
 * This module handles Ollama/LM Studio HTTP API calls and config file I/O,
 * while opencode.ts handles tmux session management.
 *
 * ## Issue #1908: writing is opt-in, and the worktree is no longer the default
 *
 * Starting an opencode session used to drop a 4 KB `opencode.json` into the
 * worktree root whenever Ollama or LM Studio answered on localhost — one
 * untracked file per repository, in six repositories on the reporting machine,
 * including CommandMate's own checkout. Nothing asked, nothing announced, and
 * `git status` carried it from then on.
 *
 * Measured on opencode 1.18.21 (`opencode debug config`, disposable `HOME`), a
 * worktree-root `opencode.json` is not an additive convenience:
 *
 * | layer                                   | read? | on a key collision |
 * |-----------------------------------------|-------|--------------------|
 * | `<worktree>/opencode.jsonc`             | yes   | beats `opencode.json` |
 * | `<worktree>/opencode.json`              | yes   | beats both below   |
 * | `$OPENCODE_CONFIG`                      | yes   | **loses** to the worktree file |
 * | `$XDG_CONFIG_HOME/opencode/opencode.json(c)` | yes | loses to the worktree file |
 *
 * `provider` maps merge across the layers, so the generated file is additive
 * *until* the operator defines the same provider key somewhere else — at which
 * point CommandMate's snapshot silently outranks the config they chose,
 * `OPENCODE_CONFIG` included. That is the reason the skip list below is not just
 * "is there an `opencode.json`".
 *
 * So: generation is off unless {@link OPENCODE_LOCAL_PROVIDER_CONFIG_ENV} asks
 * for it, and even then it stands down in front of any configuration the
 * operator already owns. Files written by earlier versions are left exactly
 * where they are — they still load, so nobody's provider list disappears.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSafeDirectory } from '@/config/safe-directory';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/opencode-config');

// =============================================================================
// Constants
// =============================================================================

/**
 * [SEC-001] SSRF Prevention: Ollama API URL is hardcoded.
 * This value MUST NOT be derived from environment variables, config files,
 * or user input. OWASP A10:2021
 */
export const OLLAMA_API_URL = 'http://localhost:11434/api/tags' as const;

/**
 * [SEC-001] SSRF Prevention: Ollama base URL for opencode.json config.
 * Same policy as OLLAMA_API_URL.
 */
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1' as const;

/** Maximum number of Ollama models to include in config (DoS prevention) */
export const MAX_OLLAMA_MODELS = 100;

/**
 * Ollama model name validation pattern (with length limit).
 * Allows: alphanumeric, dots, underscores, colons, slashes, hyphens.
 * Max 100 characters (length encoded in regex). [D4-003]
 *
 * [SEC-001] Defense-in-depth validation at point of use.
 *
 * Note: This pattern differs from OLLAMA_MODEL_PATTERN in types.ts.
 * - types.ts: `^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$` (no length limit, requires alphanumeric start)
 *   Used for API/DB validation where the first character constraint matters.
 * - This file: `^[a-zA-Z0-9._:/-]{1,100}$` (length-limited, used for Ollama API response validation)
 *   Length limit provides DoS protection against excessively long model names from Ollama API.
 */
export const OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,100}$/;

/**
 * [SEC-001] SSRF Prevention: LM Studio API URL is hardcoded.
 * This value MUST NOT be derived from environment variables, config files,
 * or user input. OWASP A10:2021
 */
export const LM_STUDIO_API_URL = 'http://localhost:1234/v1/models' as const;

/**
 * [SEC-001] SSRF Prevention: LM Studio base URL for opencode.json config.
 * Same policy as LM_STUDIO_API_URL.
 */
export const LM_STUDIO_BASE_URL = 'http://localhost:1234/v1' as const;

/** Maximum number of LM Studio models to include in config (DoS prevention) */
export const MAX_LM_STUDIO_MODELS = 100;

/**
 * LM Studio model ID validation pattern (with length limit).
 * Allows: alphanumeric, dots, underscores, colons, slashes, @, hyphens.
 * Max 200 characters (length encoded in regex).
 *
 * [SEC-001] Defense-in-depth validation at point of use.
 *
 * Character set rationale:
 *   - a-zA-Z0-9._:/- : Common character set shared with Ollama (model names, org/model format)
 *   - @ : HuggingFace revision format support (e.g., org/model@revision)
 *
 * Actual model ID examples:
 *   - lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF (54 chars)
 *   - TheBloke/Mistral-7B-Instruct-v0.2-GGUF (41 chars)
 *
 * Length limit rationale: Actual model IDs max ~60 chars; 200 provides
 * sufficient safety margin for org+model+quantization+revision.
 *
 * Note: Hyphen `-` is placed at the end of the character class to avoid
 * the need for escaping in the regex.
 */
export const LM_STUDIO_MODEL_PATTERN = /^[a-zA-Z0-9._:/@-]{1,200}$/;

/** Ollama API request timeout in milliseconds */
const OLLAMA_API_TIMEOUT_MS = 3000;

/** Maximum Ollama API response size (1MB) [D4-007] */
const MAX_OLLAMA_RESPONSE_SIZE = 1 * 1024 * 1024;

/** LM Studio API request timeout in milliseconds */
const LM_STUDIO_API_TIMEOUT_MS = 3000;

/** Maximum LM Studio API response size (1MB) */
const MAX_LM_STUDIO_RESPONSE_SIZE = 1 * 1024 * 1024;

/** Config file name */
const CONFIG_FILE_NAME = 'opencode.json';

/**
 * The environment variable that turns local-provider config generation back on
 * (Issue #1908).
 *
 * Unset — the default — means CommandMate writes nothing. `worktree` restores
 * the pre-#1908 destination (`<worktree>/opencode.json`), `global` writes the
 * same content to `$XDG_CONFIG_HOME/opencode/opencode.json` so one machine-wide
 * file serves every checkout instead of one file per repository.
 *
 * An env var rather than a stored setting because that is how every other
 * launch-path switch in this codebase is spelled (`CM_AGENT_HOOKS_INJECT`,
 * `CM_OPENCODE_PORT_FILE`), and because the decision has to be readable from the
 * CLI, the server and a test without a database.
 */
export const OPENCODE_LOCAL_PROVIDER_CONFIG_ENV = 'CM_OPENCODE_LOCAL_PROVIDER_CONFIG';

/**
 * opencode's own "use this file" override. Treated as **positive evidence that
 * the operator owns the configuration**, never as a write target: measured on
 * 1.18.21, a worktree-root `opencode.json` outranks `$OPENCODE_CONFIG` on a key
 * collision, so generating one is the one thing most likely to defeat it.
 */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG';

/** Where generation may put the file (Issue #1908). */
export type OpencodeConfigMode = 'off' | 'worktree' | 'global';

/**
 * Config file names opencode reads out of a project directory, in the order it
 * merges them (measured with `opencode debug config`, 1.18.21). `.opencode/` is
 * included because a config placed there loads exactly like a root-level one.
 */
const WORKTREE_CONFIG_RELATIVE_PATHS = [
  'opencode.json',
  'opencode.jsonc',
  path.join('.opencode', 'opencode.json'),
  path.join('.opencode', 'opencode.jsonc'),
] as const;

/** Config file names opencode reads out of its global config directory. */
const GLOBAL_CONFIG_FILE_NAMES = ['opencode.json', 'opencode.jsonc'] as const;

/**
 * The environment as these resolvers read it.
 *
 * Deliberately looser than `NodeJS.ProcessEnv`, which this repository augments
 * with a required `NODE_ENV`: the resolvers touch three variables and a caller
 * should be able to hand them exactly those three.
 */
type EnvLike = Readonly<Record<string, string | undefined>>;

/** What {@link ensureOpencodeConfig} decided, so callers and tests can see it. */
export interface OpencodeConfigOutcome {
  /** Whether a file was created by this call */
  written: boolean;
  /** The file that was written, or null */
  configPath: string | null;
  /** Why it came out that way */
  reason:
    | 'disabled'
    | 'existing-config'
    | 'no-providers'
    | 'write-failed'
    | 'written';
}

// =============================================================================
// Types
// =============================================================================

/**
 * Common return type for fetchOllamaModels() and fetchLmStudioModels().
 * Matches the opencode.json `models` structure: Record<string, { name: string }>.
 *
 * This is a minimal design aligned with opencode.json's models structure.
 * Ollama-specific details (parameter_size, quantization_level) are folded into
 * the `name` string by formatModelDisplayName(). If UI layer needs additional
 * info, use the existing /api/ollama/models endpoint separately.
 */
export type ProviderModels = Record<string, { name: string }>;

/** Ollama model details from API response */
interface OllamaModelDetails {
  parameter_size?: string;
  quantization_level?: string;
}

/** Ollama model from API response */
interface OllamaModel {
  name?: unknown;
  details?: OllamaModelDetails;
}

/** LM Studio model from API response */
interface LmStudioModel {
  id?: unknown;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format model display name with size and quantization info
 */
function formatModelDisplayName(model: OllamaModel): string {
  const name = String(model.name);
  const details = model.details;
  if (!details) return name;

  const parts: string[] = [name];

  // Sanitize and extract parameter_size (e.g., "7.6B", "27.8B")
  if (typeof details.parameter_size === 'string' && /^[\d.]+[BKMGT]?B?$/i.test(details.parameter_size)) {
    parts.push(details.parameter_size);
  }

  // Sanitize and extract quantization_level (e.g., "Q4_K_M", "Q8_0")
  if (typeof details.quantization_level === 'string' && /^[A-Z0-9_]{1,20}$/i.test(details.quantization_level)) {
    parts.push(details.quantization_level);
  }

  return parts.length > 1 ? `${name} (${parts.slice(1).join(', ')})` : name;
}

/**
 * Validate worktree path for path traversal prevention [D4-004].
 *
 * Trust chain: API layer -> DB (worktrees.path) -> startSession -> ensureOpencodeConfig.
 * Although the DB stores validated paths, this function provides defense-in-depth
 * by re-validating at the point of filesystem access.
 *
 * Steps:
 * 1. path.resolve() - Normalize path (remove .., ., etc.)
 * 2. fs.lstatSync() - Verify path exists and is a directory (symlink-aware)
 * 3. fs.realpathSync() - Resolve symlinks to get the canonical path
 *
 * @param worktreePath - Path to validate
 * @returns Resolved real path (after symlink resolution)
 * @throws Error if path does not exist or is not a directory
 * @internal
 */
function validateWorktreePath(worktreePath: string): string {
  // 1. path.resolve() for normalization
  const resolvedPath = path.resolve(worktreePath);

  // 2. Verify the path exists and is a directory (lstatSync for symlink detection)
  try {
    const stat = fs.lstatSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }
    throw error;
  }

  // 3. Resolve symlinks to get real path
  const realPath = fs.realpathSync(resolvedPath);

  return realPath;
}

// =============================================================================
// Provider Functions
// =============================================================================

/**
 * Fetch model list from Ollama API.
 * Returns empty object on any failure (non-fatal).
 *
 * Extracted from ensureOpencodeConfig() for SRP compliance.
 * All error paths (non-200 response, size exceeded, invalid structure, exceptions)
 * return empty object {} instead of throwing.
 *
 * @returns Model map (key: model name, value: { name: display name })
 * @internal
 */
export async function fetchOllamaModels(): Promise<ProviderModels> {
  const models: ProviderModels = {};
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_API_TIMEOUT_MS);
    const response = await fetch(OLLAMA_API_URL, {
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutId);
    });

    if (!response.ok) {
      logger.warn('ollama-api-returned');
      return {};
    }

    // [D4-007] Response size check
    const text = await response.text();
    if (text.length > MAX_OLLAMA_RESPONSE_SIZE) {
      logger.warn('ollama-api-response');
      return {};
    }

    // Parse and validate response structure [D4-007]
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.models)) {
      logger.warn('invalid-ollama-api');
      return {};
    }

    // Limit model count (DoS prevention)
    const modelList: OllamaModel[] = data.models.slice(0, MAX_OLLAMA_MODELS);

    // Validate each model (whitelist approach) [D4-007]
    for (const model of modelList) {
      if (typeof model?.name !== 'string') continue;
      if (!OLLAMA_MODEL_PATTERN.test(model.name)) continue;
      models[model.name] = { name: formatModelDisplayName(model) };
    }
  } catch (error) {
    // Non-fatal: Ollama may not be running [D4-002]
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('ollama-api-timeout');
    } else {
      logger.warn('failed-to-fetch');
    }
  }
  return models;
}

/**
 * Fetch model list from LM Studio OpenAI-compatible API.
 * Returns empty object on any failure (non-fatal).
 *
 * LM Studio provides an OpenAI-compatible API at /v1/models.
 * Response format: { data: [{ id: string, object: string, ... }] }
 * Model IDs are used as-is for display names (no details available).
 *
 * Model IDs are validated with LM_STUDIO_MODEL_PATTERN and used as
 * opencode.json model keys. JSON.stringify() ensures proper escaping
 * to prevent JSON structure corruption via malicious model IDs. [SEC-005]
 *
 * @returns Model map (key: model id, value: { name: model id })
 * @internal
 */
export async function fetchLmStudioModels(): Promise<ProviderModels> {
  const models: ProviderModels = {};
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LM_STUDIO_API_TIMEOUT_MS);
    const response = await fetch(LM_STUDIO_API_URL, {
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutId);
    });

    if (!response.ok) {
      logger.warn('lm-studio-api');
      return {};
    }

    const text = await response.text();
    if (text.length > MAX_LM_STUDIO_RESPONSE_SIZE) {
      logger.warn('lm-studio-api');
      return {};
    }

    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.data)) {
      logger.warn('invalid-lm-studio');
      return {};
    }

    const modelList: LmStudioModel[] = data.data.slice(0, MAX_LM_STUDIO_MODELS);
    for (const model of modelList) {
      if (typeof model?.id !== 'string') continue;
      if (!LM_STUDIO_MODEL_PATTERN.test(model.id)) continue;
      models[model.id] = { name: model.id };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('lm-studio-api');
    } else {
      logger.warn('failed-to-fetch');
    }
  }
  return models;
}

// =============================================================================
// Main function
// =============================================================================

/**
 * opencode's global config directory — `$XDG_CONFIG_HOME/opencode`, falling
 * back to `~/.config/opencode` (confirmed against `opencode debug paths` under a
 * disposable `HOME`).
 *
 * `resolveSafeDirectory` because `XDG_CONFIG_HOME` is an operator-supplied
 * directory that reaches a recursive `mkdir` below, which is the exact shape
 * Issue #1774 guards.
 *
 * @internal
 */
export function opencodeGlobalConfigDir(env: EnvLike = process.env): string {
  const home = path.join(os.homedir(), '.config');
  return path.join(resolveSafeDirectory(env.XDG_CONFIG_HOME, home, 'XDG_CONFIG_HOME'), 'opencode');
}

/**
 * Read {@link OPENCODE_LOCAL_PROVIDER_CONFIG_ENV}.
 *
 * Unknown values resolve to `off` rather than to the old behaviour: a typo in an
 * opt-in must not opt the operator in.
 *
 * @internal
 */
export function resolveOpencodeConfigMode(
  env: EnvLike = process.env
): OpencodeConfigMode {
  const raw = (env[OPENCODE_LOCAL_PROVIDER_CONFIG_ENV] ?? '').trim().toLowerCase();
  if (raw === 'worktree' || raw === 'project') return 'worktree';
  if (raw === 'global' || raw === 'user') return 'global';
  if (raw !== '' && raw !== 'off' && raw !== '0' && raw !== 'false' && raw !== 'none') {
    logger.warn('opencode-config-mode-unrecognised', {
      variable: OPENCODE_LOCAL_PROVIDER_CONFIG_ENV,
      value: raw,
    });
  }
  return 'off';
}

/**
 * The configuration the operator already owns, if any.
 *
 * Returns the first thing found so the caller can log *what* made it stand down
 * — `'env:OPENCODE_CONFIG'` or a path. Order is "most explicit first".
 *
 * @param worktreePath - Directory to check for project-level config, or null to
 *   check only the global layer
 * @internal
 */
export function findOwnedOpencodeConfig(
  worktreePath: string | null,
  env: EnvLike = process.env
): string | null {
  const explicit = (env[OPENCODE_CONFIG_ENV] ?? '').trim();
  if (explicit !== '') return `env:${OPENCODE_CONFIG_ENV}`;

  if (worktreePath !== null) {
    for (const relative of WORKTREE_CONFIG_RELATIVE_PATHS) {
      const candidate = path.join(worktreePath, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const globalDir = opencodeGlobalConfigDir(env);
  for (const name of GLOBAL_CONFIG_FILE_NAMES) {
    const candidate = path.join(globalDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Build the `provider` block from whatever is answering on localhost.
 *
 * Both fetches catch everything internally and answer `{}`, so `Promise.all`
 * never rejects. Only providers with at least one model are included.
 *
 * @internal
 */
async function buildLocalProviderBlock(): Promise<Record<string, unknown>> {
  const [ollamaModels, lmStudioModels] = await Promise.all([
    fetchOllamaModels(),
    fetchLmStudioModels(),
  ]);

  const provider: Record<string, unknown> = {};
  if (Object.keys(ollamaModels).length > 0) {
    provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: OLLAMA_BASE_URL },
      models: ollamaModels,
    };
  }
  if (Object.keys(lmStudioModels).length > 0) {
    provider.lmstudio = {
      npm: '@ai-sdk/openai-compatible',
      name: 'LM Studio (local)',
      options: { baseURL: LM_STUDIO_BASE_URL },
      models: lmStudioModels,
    };
  }
  return provider;
}

/**
 * Generate a local-provider `opencode.json`, if and only if the operator asked
 * for one (Issue #1908).
 *
 * ## Decision order
 *
 * 1. {@link resolveOpencodeConfigMode} is `off` (the default): return
 *    immediately. Nothing is read, nothing is fetched, nothing is written — the
 *    two localhost probes that used to run on every launch are skipped too.
 * 2. {@link findOwnedOpencodeConfig} finds configuration the operator owns:
 *    stand down. In `worktree` mode that includes the global layer, because a
 *    file in the worktree root outranks both `$OPENCODE_CONFIG` and the global
 *    config on a key collision (measured, 1.18.21) — writing one would quietly
 *    override the very thing that proves they configured opencode themselves.
 *    In `global` mode only the global layer is consulted; one repository's
 *    config says nothing about the machine.
 * 3. Neither Ollama nor LM Studio has a model: nothing worth writing.
 * 4. Write with `flag: 'wx'`, so a racing writer wins and is left alone.
 *
 * Write failures stay non-fatal — a session must start whether or not this
 * succeeded.
 *
 * **Pre-existing files are never touched or removed.** A file an older
 * CommandMate wrote still loads, so upgrading does not take anyone's provider
 * list away; it only stops new ones appearing.
 *
 * @param worktreePath - Worktree directory path (from DB)
 * @returns What was decided, for logging and tests
 * @internal
 */
export async function ensureOpencodeConfig(
  worktreePath: string
): Promise<OpencodeConfigOutcome> {
  const mode = resolveOpencodeConfigMode();
  if (mode === 'off') {
    return { written: false, configPath: null, reason: 'disabled' };
  }

  // Validate path [D4-004]. Only on the worktree path, which is the only mode
  // that touches the caller-supplied directory.
  const validatedPath = mode === 'worktree' ? validateWorktreePath(worktreePath) : null;

  const owned = findOwnedOpencodeConfig(validatedPath);
  if (owned !== null) {
    logger.info('opencode-config-generation-skipped', { mode, owned });
    return { written: false, configPath: null, reason: 'existing-config' };
  }

  const targetDir = validatedPath ?? opencodeGlobalConfigDir();
  const configPath = path.join(targetDir, CONFIG_FILE_NAME);

  const provider = await buildLocalProviderBlock();
  if (Object.keys(provider).length === 0) {
    return { written: false, configPath: null, reason: 'no-providers' };
  }

  // [D4-005] Generate config using JSON.stringify (not template literals).
  // JSON.stringify ensures proper escaping of model names and other values,
  // preventing JSON injection via maliciously crafted model metadata.
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider,
  };

  try {
    if (mode === 'global') {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { written: false, configPath: null, reason: 'existing-config' };
    }
    // Non-fatal: write failure should not prevent session start
    logger.warn('failed-to-write-opencodejson:error-insta');
    return { written: false, configPath: null, reason: 'write-failed' };
  }

  logger.info('opencode-config-generated', { mode, configPath });
  return { written: true, configPath, reason: 'written' };
}
