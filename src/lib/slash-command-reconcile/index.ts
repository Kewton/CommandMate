/**
 * Slash Command Catalog reconcile — public entry point (Issue #1489)
 *
 * Ties the providers to the engine. `runReconcile` fetches every provider (each
 * fail-soft) and hands the results to the pure engine. The engine, providers,
 * and sanitizer are re-exported so the runner script and tests import from one
 * place. Nothing here is imported by the app runtime.
 */

import { reconcileCatalog, type ReconcileOptions } from './engine';
import { fetchClaudeCommands } from './providers/claude';
import { fetchCodexCommands, type FetchCodexOptions } from './providers/codex';
import { fetchAntigravityCommands } from './providers/antigravity';
import type { FetchTextOptions } from './fetch';
import type { ProviderResult, ReconcileResult, SlashCommandsCatalog } from './types';

export * from './types';
export * from './sanitize';
export * from './engine';
export * from './fetch';
export {
  CLAUDE_COMMANDS_DOC_URL,
  parseClaudeCommandsDoc,
  fetchClaudeCommands,
} from './providers/claude';
export {
  CODEX_OWNER_REPO,
  CODEX_ENUM_PATH,
  CODEX_LATEST_RELEASE_URL,
  codexEnumRawUrl,
  versionFromTag,
  parseCodexSlashCommandEnum,
  resolveCodexLatestTag,
  fetchCodexCommands,
  type FetchCodexOptions,
} from './providers/codex';
export {
  ANTIGRAVITY_DOCS_URL,
  parseAntigravityReference,
  fetchAntigravityCommands,
} from './providers/antigravity';

export interface RunReconcileOptions extends ReconcileOptions {
  /** Fetch options for the claude provider, or false to skip it. */
  claude?: FetchTextOptions | false;
  /** Fetch options for the codex provider, or false to skip it. */
  codex?: FetchCodexOptions | false;
  /** Fetch options for the antigravity provider, or false to skip it. */
  antigravity?: FetchTextOptions | false;
}

function skipped(tool: string): ProviderResult {
  return { tool, ok: false, commands: [], warnings: [`${tool} provider skipped`] };
}

/**
 * Run every enabled provider and reconcile the result against `catalog`.
 * Each provider is fail-soft, so a single source outage never aborts the pass.
 */
export async function runReconcile(
  catalog: SlashCommandsCatalog,
  options: RunReconcileOptions = {}
): Promise<ReconcileResult> {
  const [claude, codex, antigravity] = await Promise.all([
    options.claude === false ? skipped('claude') : fetchClaudeCommands(options.claude),
    options.codex === false ? skipped('codex') : fetchCodexCommands(options.codex),
    options.antigravity === false
      ? skipped('antigravity')
      : fetchAntigravityCommands(options.antigravity),
  ]);

  return reconcileCatalog(catalog, [claude, codex, antigravity], options);
}
