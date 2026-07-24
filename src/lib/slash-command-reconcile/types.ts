/**
 * Slash Command Catalog reconcile — shared types (Issue #1489)
 *
 * The reconcile mechanism keeps the bundled slash-command snapshot
 * (src/config/slash-commands-catalog.json) fresh from each CLI's *authoritative*
 * source, so the catalog content and its `verifiedAgainst` version stamp move
 * together — the root cause of drift #1476/#1488 fought by convention.
 *
 * This file carries only data shapes; the engine (engine.ts) and providers
 * (providers/*.ts) hold the behavior. None of it is imported by the app runtime
 * — it is consumed by the release-time runner (scripts/) and unit tests.
 */

/** One command enumerated from a provider's authoritative source. */
export interface ProviderCommand {
  /** Command name without the leading '/'. */
  name: string;
  /** English one-line description, when the source carries one. */
  description?: string;
  /** Minimum CLI version the command appeared in, when the source notes it. */
  minVersion?: string;
}

/**
 * Result of running one provider.
 *
 * `ok: false` is the fail-soft signal: fetch or parse failed, so the engine must
 * leave that tool's catalog entries untouched (never delete on a bad fetch).
 */
export interface ProviderResult {
  /** Catalog tool id this provider enumerates ('claude' | 'codex' | 'antigravity'). */
  tool: string;
  /** Whether the source was fetched and parsed successfully. */
  ok: boolean;
  /** Enumerated commands (empty when `ok` is false). */
  commands: ProviderCommand[];
  /**
   * Version the enumeration was actually collated against, ONLY when the source
   * is version-pinned (e.g. codex release tag). Undefined for sources without a
   * catalog-wide version stamp (e.g. claude docs) — the engine then leaves
   * `verifiedAgainst[tool]` alone, honoring "stamp only what was verified".
   */
  sourceVersion?: string;
  /** Non-fatal notes surfaced to the runner (missing binary, format drift, …). */
  warnings: string[];
}

/** Raw catalog entry, as authored in slash-commands-catalog.json. */
export interface CatalogCommandEntry {
  name: string;
  descriptionKey?: string;
  category: string;
  cliTools?: string[];
  isStandard?: boolean;
  source?: string;
}

/** Shape of the bundled catalog file (src/config/slash-commands-catalog.json). */
export interface SlashCommandsCatalog {
  verifiedAgainst: Record<string, string>;
  frequentlyUsed: Record<string, string[]>;
  commands: CatalogCommandEntry[];
}

/** A command the reconcile added to the catalog. */
export interface ReconcileAddition {
  tool: string;
  name: string;
  descriptionKey: string;
  /** English description carried from the source, if any. */
  enDescription?: string;
  minVersion?: string;
}

/** A locale string the reconcile wants written into the dictionaries. */
export interface LocaleAddition {
  /** i18n key relative to the worktree namespace (e.g. slashCommands.descriptions.loop). */
  key: string;
  /** English text (from the source, or a placeholder when the source had none). */
  en: string;
  /** Japanese text — always a placeholder needing human review at this stage. */
  ja: string;
}

/** What changed (or would change) in a reconcile pass. */
export interface ReconcileDiff {
  /** Commands newly added to the catalog, per tool. */
  added: ReconcileAddition[];
  /**
   * Commands present in the catalog for a tool but absent from its authoritative
   * source. Reported for human review — never auto-deleted (a transient fetch or
   * a format change must not silently strip the catalog).
   */
  missingFromSource: Array<{ tool: string; name: string }>;
  /** verifiedAgainst stamps that changed, per tool. */
  verifiedAgainstUpdated: Record<string, { from?: string; to: string }>;
}

/** Full result of a reconcile pass. */
export interface ReconcileResult {
  /** The catalog after reconciliation (unchanged object contents when `changed` is false). */
  catalog: SlashCommandsCatalog;
  /** Locale strings to merge into en/ja dictionaries (deduped by key). */
  localeAdditions: LocaleAddition[];
  /** Structured diff of what changed. */
  diff: ReconcileDiff;
  /** Aggregated non-fatal warnings from every provider. */
  warnings: string[];
  /** True when the catalog or locales would change. */
  changed: boolean;
}
