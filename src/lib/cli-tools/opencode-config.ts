/**
 * OpenCode configuration file generator
 * Issue #379: Generates opencode.json with Ollama provider configuration
 * Issue #398: Added LM Studio provider support
 *
 * @remarks [D1-001 SRP] Separated from opencode.ts to maintain single responsibility.
 * This module handles Ollama/LM Studio HTTP API calls and config file I/O,
 * while opencode.ts handles tmux session management.
 */

import * as fs from 'fs';
import * as path from 'path';
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
 * Ensure opencode.json exists in the worktree directory.
 * If the file already exists, it is NOT overwritten (respects user configuration).
 * If both Ollama and LM Studio are not running, the function returns without error
 * and does not generate opencode.json.
 *
 * Provider configuration is built dynamically: only providers with models are included.
 * If a 3rd provider is added, consider refactoring to a data-driven design
 * (providerDefinitions array + loop) instead of inline if-branches. [KISS]
 * HTTP fetch logic (fetchWithTimeout) can be extracted to a shared helper.
 *
 * @param worktreePath - Worktree directory path (from DB)
 * @internal
 */
export async function ensureOpencodeConfig(worktreePath: string): Promise<void> {
  // Validate path [D4-004]
  const validatedPath = validateWorktreePath(worktreePath);

  const configPath = path.join(validatedPath, CONFIG_FILE_NAME);

  // Skip if config already exists (respect user configuration)
  if (fs.existsSync(configPath)) {
    return;
  }

  // Fetch models from both providers in parallel.
  // Each function catches all exceptions internally and returns {} on failure,
  // so Promise.all will never reject.
  const [ollamaModels, lmStudioModels] = await Promise.all([
    fetchOllamaModels(),
    fetchLmStudioModels(),
  ]);

  // Dynamic provider configuration: only include providers with models
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

  // Both providers have 0 models: skip opencode.json generation
  if (Object.keys(provider).length === 0) {
    return;
  }

  // [D4-005] Generate config using JSON.stringify (not template literals).
  // JSON.stringify ensures proper escaping of model names and other values,
  // preventing JSON injection via maliciously crafted model metadata.
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider,
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return;
    }
    // Non-fatal: write failure should not prevent session start
    logger.warn('failed-to-write-opencodejson:error-insta');
  }
}
