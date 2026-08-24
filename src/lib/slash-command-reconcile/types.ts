/**
 * Slash Command Catalog reconcile — shared types (Issue #1489)
 *
 * The reconcile mechanism keeps the bundled slash-command snapshot
 * (src/config/slash-commands-catalog.json) fresh from each CLI's *authoritative*
 * source, so the catalog content and the version stamp that describes it move
 * together — the root cause of drift #1476/#1488 fought by convention. Issue
 * #2026 moved that stamp into the attestation record, where it sits next to the
 * set it stands for and can only be moved by hand.
 *
 * This file carries only data shapes; the engine (engine.ts) and providers
 * (providers/*.ts) hold the behavior. The behavior is release-time only, with
 * one exception: attestations.ts is reachable from the app runtime, because
 * src/lib/standard-commands.ts derives `CATALOG_VERIFIED_AGAINST` from it.
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
 * A human's signed reading of one tool's authoritative source (Issue #2026).
 *
 * "As of version V, source S enumerated exactly this set of commands for tool
 * T." Nothing in the toolchain writes it: `catalog:refresh --write` adds catalog
 * entries and locale strings and stops there, so an attestation moves only when
 * a person opens the source and edits the file — and that act is the review the
 * count pins used to stand in for.
 */
export interface CatalogAttestation {
  /** Catalog tool id this reading covers; one record per tool. */
  tool: string;
  /**
   * CLI version the reading is claimed against.
   *
   * The only home of that number since #2026: `verifiedAgainst` left
   * slash-commands-catalog.json and is derived from here, so a stamp can never
   * outlive the set it stands for.
   */
  version: string;
  /** Where to look to re-run this exact measurement — an instruction, not a citation. */
  source: string;
  /**
   * `YYYY-MM-DD` the source was read. Load-bearing for a source that is not
   * version-pinned: the claude docs page is live, so a version alone does not
   * identify a document.
   */
  observedAt: string;
  /** Issue the reading was taken in. */
  issue: number;
  /**
   * The enumerated set, sorted, without the leading '/'.
   *
   * Active canonical rows only — a source that also lists history ("Removed in
   * vX") and alias rows is describing its past, not what the CLI ships. Curation
   * is *not* applied here: a command a human decided to keep out of the catalog
   * still belongs in this list, with the reason recorded in the exclusions file.
   */
  commands: string[];
}

/** Shape of src/config/slash-commands-attestations.json. */
export interface CatalogAttestationsFile {
  attestations: CatalogAttestation[];
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

/**
 * Shape of the bundled catalog file (src/config/slash-commands-catalog.json).
 *
 * Issue #2026 removed `verifiedAgainst` from this file. The version a tool's
 * entries were collated against is now one field of that tool's attestation
 * (src/config/slash-commands-attestations.json), so the stamp travels with the
 * set it describes instead of being a second, separately-editable copy of it.
 */
export interface SlashCommandsCatalog {
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
  /**
   * Version stamps the source has moved past, per tool.
   *
   * Issue #2026: `from` is the *attested* version, not a value read off the
   * catalog, and nothing applies these any more — re-stamping is part of
   * re-attesting, which is a human edit to the attestations file. Before that,
   * `--write` bumped the stamp on its own, which quietly re-dated a claim about
   * a source that nobody had re-read.
   */
  verifiedAgainstUpdated: Record<string, { from?: string; to: string }>;
  /**
   * Per-tool difference between what a source enumerates now and what its
   * attestation says it enumerated (Issue #2026). Only tools whose provider
   * actually answered appear; a fail-soft source yields no row rather than an
   * empty one, because "not compared" must never read as "unchanged".
   */
  attestationDrift: AttestationDrift[];
}

/**
 * Per-tool comparison of what a source enumerates *now* against the set its
 * attestation claims it enumerated (Issue #2026).
 *
 * This is the staleness signal `catalog:refresh --check` reports. An attestation
 * is a dated claim about a document, and the run that can actually see the
 * document is the only place that can say the claim has expired.
 *
 * The *version* half of that staleness is not repeated here: it is already
 * `ReconcileDiff.verifiedAgainstUpdated`, which since #2026 compares the source
 * version against the attested one. This type carries the set half only.
 */
export interface AttestationDrift {
  tool: string;
  /** False when no attestation covers this tool at all. */
  attested: boolean;
  /** Names the source enumerates that the attestation does not list. */
  unattested: string[];
  /** Names the attestation lists that the source no longer enumerates. */
  vanished: string[];
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
