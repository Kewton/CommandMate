/**
 * OpenCode configuration file generator
 * Issue #379: Generates opencode.json with Ollama provider configuration
 *
 * @remarks [D1-001 SRP] Separated from opencode.ts to maintain single responsibility.
 * This module handles Ollama HTTP API calls and config file I/O,
 * while opencode.ts handles tmux session management.
 */

import * as fs from 'fs';
import * as path from 'path';

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

/** Ollama API request timeout in milliseconds */
const OLLAMA_API_TIMEOUT_MS = 3000;

/** Maximum Ollama API response size (1MB) [D4-007] */
const MAX_OLLAMA_RESPONSE_SIZE = 1 * 1024 * 1024;

/** Config file name */
const CONFIG_FILE_NAME = 'opencode.json';

// =============================================================================
// Types
// =============================================================================

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
// Main function
// =============================================================================

/**
 * Ensure opencode.json exists in the worktree directory.
 * If the file already exists, it is NOT overwritten (respects user configuration).
 * If Ollama is not running, the function logs a warning and returns without error.
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

  // Fetch models from Ollama API
  const models: Record<string, { name: string }> = {};
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_API_TIMEOUT_MS);
    const response = await fetch(OLLAMA_API_URL, {
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutId);
    });

    if (!response.ok) {
      console.warn(`Ollama API returned status ${response.status}, skipping opencode.json generation`);
      return;
    }

    // [D4-007] Response size check
    const text = await response.text();
    if (text.length > MAX_OLLAMA_RESPONSE_SIZE) {
      console.warn('Ollama API response too large, skipping opencode.json generation');
      return;
    }

    // Parse and validate response structure [D4-007]
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.models)) {
      console.warn('Invalid Ollama API response structure, skipping opencode.json generation');
      return;
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
      console.warn('Ollama API timeout, skipping opencode.json generation');
    } else {
      console.warn('Failed to fetch Ollama models, skipping opencode.json generation');
    }
    return;
  }

  // [D4-005] Generate config using JSON.stringify (not template literals).
  // JSON.stringify ensures proper escaping of model names and other values,
  // preventing JSON injection via maliciously crafted Ollama model metadata.
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL: OLLAMA_BASE_URL },
        models,
      },
    },
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
    console.warn(`Failed to write opencode.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}
