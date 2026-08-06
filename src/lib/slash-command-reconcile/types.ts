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

/**
 * Lifecycle of a command as declared by its source (Issue #1603).
 *
 * An authoritative source is not only a list of *current* commands: the claude
 * docs table also carries history rows ("Removed in v2.1.92"). Only `active`
 * rows may be auto-added.
 */
export type ProviderCommandStatus = 'active' | 'removed';

/** One command enumerated from a provider's authoritative source. */
export interface ProviderCommand {
  /** Command name without the leading '/'. */
  name: string;
  /** English one-line description, when the source carries one. */
  description?: string;
  /** Minimum CLI version the command appeared in, when the source notes it. */
  minVersion?: string;
  /**
   * Last CLI version that still shipped the command, when the source notes a
   * removal. Reading this is what keeps history rows out of the catalog
   * (Issue #1603: the parser used to read min-version only).
   */
  maxVersion?: string;
  /** Lifecycle declared by the source; absent means `active`. */
  status?: ProviderCommandStatus;
  /** Canonical command this row is merely an alias of (`/cost` → `usage`). */
  aliasOf?: string;
  /** Badge the source puts on the row (`skill`, `workflow`), when present. */
  kind?: string;
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

/**
 * Why a command is kept out of the catalog (Issue #1704).
 *
 *  - `phantom`      the command does not exist on that CLI; the source row is a
 *                   history entry, a marker, or a stub. Self-settling: when
 *                   upstream starts shipping it for real, the row is deleted.
 *  - `out-of-scope` the command is real upstream and its description is fine; we
 *                   chose not to surface it. Only a human re-deciding removes it.
 *
 * The two are separate values rather than prose inside `reason` because their
 * future re-decision costs differ by an order of magnitude.
 */
export type ExclusionKind = 'phantom' | 'out-of-scope';

/**
 * One curation decision the reconcile must honor (Issue #1704).
 *
 * Scoped by `cliTools` on purpose: a name-wide ban is not expressible, because
 * v0.21.2 had to narrow the /vim ban from the name to claude alone once codex
 * 0.146.0 turned out to ship a real `/vim`.
 */
export interface CatalogExclusion {
  /** Command name without the leading '/'. */
  name: string;
  /** Tools this exclusion applies to; never empty. */
  cliTools: string[];
  /** Whether the command is absent upstream or merely out of scope. */
  kind: ExclusionKind;
  /** One sentence a later reader can act on without opening the issue. */
  reason: string;
  /** Issue the decision was made in. */
  issue: number;
}

/** Shape of src/config/slash-commands-exclusions.json. */
export interface CatalogExclusionsFile {
  exclusions: CatalogExclusion[];
}

/**
 * Raw catalog entry, as authored in slash-commands-catalog.json.
 *
 * `descriptionKey` is an override point, not a derived value (Issue #1704): it
 * defaults to `slashCommands.descriptions.<name>`, but an entry whose tool
 * disagrees with another tool about what the command does carries the tool-
 * scoped key `slashCommands.descriptions.<name>.<tool>` instead. Only contested
 * names are split — sharing one key is still the norm.
 */
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

/**
 * Why the reconcile refused to act on a source row (Issue #1603).
 *
 *  - `excluded`             a human decided this command stays out (Issue #1704).
 *  - `removed-row`          the source documents the command as gone.
 *  - `alias-row`            the row is an alias of another command, not a command.
 *  - `suspect-description`  the extracted prose looks like a marker/badge leftover.
 *  - `description-conflict` two tools disagree on the text behind one i18n key.
 */
export type ReconcileNoticeCategory =
  | 'excluded'
  | 'removed-row'
  | 'alias-row'
  | 'suspect-description'
  | 'description-conflict';

/** One categorized reconcile decision, surfaced by `--check`. */
export interface ReconcileNotice {
  category: ReconcileNoticeCategory;
  /** Tool the row came from; absent when the notice spans tools. */
  tool?: string;
  /** Command name without the leading '/'. */
  name: string;
  message: string;
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
  /** Categorized decisions the engine made about source rows (Issue #1603). */
  notices: ReconcileNotice[];
  /** True when the catalog or locales would change. */
  changed: boolean;
}
