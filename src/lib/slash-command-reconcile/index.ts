/**
 * Slash Command Catalog reconcile — public entry point (Issue #1489)
 *
 * Ties the providers to the engine. `runReconcile` fetches every provider (each
 * fail-soft) and hands the results to the pure engine. The engine, providers,
 * and sanitizer are re-exported so the runner script and tests import from one
 * place.
 *
 * Two files under this directory ARE reachable from the app runtime, and both
 * say so in their own docblock: `attestations.ts` (src/lib/standard-commands.ts
 * derives `CATALOG_VERIFIED_AGAINST` from it) and, since Issue #2036,
 * `providers/opencode.ts` — the palette route parses a live `GET /command`
 * document with the same parser this reconcile uses, so a name that reaches the
 * palette and a name that reaches the catalog pass the identical allowlist.
 * Nothing else here is imported by the app runtime, this module included.
 */

import { reconcileCatalog, type ReconcileOptions } from './engine';
import { fetchClaudeCommands } from './providers/claude';
import { fetchCodexCommands, type FetchCodexOptions } from './providers/codex';
import { fetchAntigravityCommands } from './providers/antigravity';
import { fetchOpencodeCommands, type FetchOpencodeOptions } from './providers/opencode';
import type { FetchTextOptions } from './fetch';
import type { ProviderResult, ReconcileResult, SlashCommandsCatalog } from './types';

export * from './types';
export * from './sanitize';
export * from './check-report';
export * from './exclusions';
export * from './attestations';
export * from './locale';
export * from './runner-args';
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
export {
  OPENCODE_TOOL_ID,
  OPENCODE_COMMAND_HOST,
  OPENCODE_COMMAND_PATH,
  OPENCODE_COMMAND_TIMEOUT_MS,
  OPENCODE_LIVE_NAME_PATTERN,
  MAX_OPENCODE_COMMANDS,
  isValidOpencodeLiveName,
  isUsableOpencodePort,
  opencodeCommandUrl,
  parseOpencodeCommandDocument,
  fetchOpencodeLiveCommands,
  fetchOpencodeCommands,
  type OpencodeLiveCommand,
  type OpencodeLiveFetch,
  type FetchOpencodeOptions,
} from './providers/opencode';

export interface RunReconcileOptions extends ReconcileOptions {
  /** Fetch options for the claude provider, or false to skip it. */
  claude?: FetchTextOptions | false;
  /** Fetch options for the codex provider, or false to skip it. */
  codex?: FetchCodexOptions | false;
  /** Fetch options for the antigravity provider, or false to skip it. */
  antigravity?: FetchTextOptions | false;
  /**
   * Loopback port of a running opencode server, or false to skip it (default).
   *
   * Skipped by default because there is nothing to guess: the port belongs to a
   * process the operator started, and #1758 §5.9.2 measured that it cannot be
   * read back from disk. `GET /command` also covers only part of the opencode
   * catalog — see the provider's docblock — so this enumerates the markdown
   * commands and leaves the 16 TUI built-ins to their palette attestation.
   *
   * Issue #2036: until `--opencode-port` landed this field had no caller at all,
   * so the default was not a default but the only reachable value, and every run
   * printed `opencode provider skipped: no loopback port given`. The runner now
   * builds it from that flag (`runner-args.ts#opencodeOptionFromArgs`); a caller
   * that passes nothing still gets the skip, which is what keeps the weekly
   * catalog-drift workflow — which has no opencode server — unchanged.
   */
  opencode?: FetchOpencodeOptions | false;
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
  const [claude, codex, antigravity, opencode] = await Promise.all([
    options.claude === false ? skipped('claude') : fetchClaudeCommands(options.claude),
    options.codex === false ? skipped('codex') : fetchCodexCommands(options.codex),
    options.antigravity === false
      ? skipped('antigravity')
      : fetchAntigravityCommands(options.antigravity),
    fetchOpencodeCommands(options.opencode ?? false),
  ]);

  return reconcileCatalog(catalog, [claude, codex, antigravity, opencode], options);
}
