/**
 * Slash Command Catalog reconcile — engine (Issue #1489)
 *
 * Pure, side-effect-free reconciliation: given the current catalog and the
 * results of each provider, it computes an updated catalog, the locale strings
 * to add, and a structured diff. Disk I/O and network fetches live in the
 * providers and the runner script — this file is deterministic and unit-tested.
 *
 * Design invariants:
 *  - Additive-only. New commands are added; commands missing from a source are
 *    *reported*, never deleted (a transient fetch failure must not strip the
 *    catalog). Deletion stays a human decision on the release PR.
 *  - Idempotent. A command already catalogued for a tool is skipped, so a second
 *    run adds nothing and the manual #1488 additions are never duplicated.
 *  - Content and stamp move together. `verifiedAgainst[tool]` is bumped only for
 *    a provider that reports a `sourceVersion` (version-pinned source, e.g.
 *    codex) — the root cause of #1476/#1488 drift.
 *  - Only active, canonical rows are auto-added (Issue #1603). A source lists
 *    more than its current commands: history rows ("Removed in vX") and alias
 *    rows are refused with a categorized notice instead of becoming catalog
 *    entries whose "description" is their own obituary.
 */

import { sanitizeProviderCommands } from './sanitize';
import type {
  ProviderResult,
  ProviderCommand,
  ReconcileDiff,
  ReconcileNotice,
  ReconcileNoticeCategory,
  ReconcileResult,
  SlashCommandsCatalog,
  CatalogCommandEntry,
  LocaleAddition,
} from './types';

/** i18n key prefix every built-in description resolves through (Issue #1306). */
const DESCRIPTION_KEY_PREFIX = 'slashCommands.descriptions.';
/** Category a newly discovered command lands in until a human recategorizes it. */
const DEFAULT_CATEGORY = 'standard-util';
/**
 * Marks a Japanese string as an untranslated placeholder needing review.
 *
 * Exported because the generator must not be the only side that knows this
 * string: the shipped-dictionary guard (Issue #1703) reads the same constant,
 * so changing the marker here can never silently disarm the guard.
 */
export const JA_REVIEW_PREFIX = '[要レビュー] ';

/**
 * A "description" that is really a row marker the parser failed to strip.
 *
 * A bare badge word (`Skill`) is a transform-order leftover; a leading `Removed
 * in` / `Alias for` / `Deprecated` is the row talking about itself rather than
 * about what the command does. Either way it must not become the shipped
 * English string — the command is still added, with a placeholder (Issue #1603).
 */
const SUSPECT_BADGE_ONLY_RE = /^(skill|workflow|plugin)$/i;
const SUSPECT_PREFIX_RE = /^(removed\b|alias for\b|deprecated\b)/i;

/** Order the `--check` report groups notice categories in. */
export const NOTICE_CATEGORY_ORDER: readonly ReconcileNoticeCategory[] = [
  'removed-row',
  'alias-row',
  'suspect-description',
  'description-conflict',
];

/**
 * True when `value` still carries the untranslated-placeholder marker.
 *
 * Deliberately looser than the generator: it matches the marker anywhere in the
 * string and ignores the trailing space, so a placeholder a human reflowed or
 * partially edited is still caught (Issue #1703).
 */
export function hasReviewMarker(value: unknown): boolean {
  return typeof value === 'string' && value.includes(JA_REVIEW_PREFIX.trim());
}

/** True when `description` looks like a row marker rather than a purpose. */
export function isSuspectDescription(description: string | undefined): boolean {
  if (!description) return false;
  return SUSPECT_BADGE_ONLY_RE.test(description) || SUSPECT_PREFIX_RE.test(description);
}

/** Render notices as report lines, grouped by category (used by `--check`). */
export function formatNoticesForReport(notices: ReconcileNotice[]): string[] {
  const lines: string[] = [];
  for (const category of NOTICE_CATEGORY_ORDER) {
    const group = notices.filter((n) => n.category === category);
    if (group.length === 0) continue;
    lines.push(`[${category}] (${group.length})`);
    for (const notice of group) {
      const scope = notice.tool ? `[${notice.tool}] ` : '';
      lines.push(`  - ${scope}/${notice.name}: ${notice.message}`);
    }
  }
  return lines;
}

/** Human-readable version window for a refused history row. */
function removedDetail(command: ProviderCommand): string {
  return command.maxVersion ? ` (last shipped in v${command.maxVersion})` : '';
}

export interface ReconcileOptions {
  /** Category assigned to newly added commands (default: standard-util). */
  defaultCategory?: string;
}

/** True when a catalog entry is in scope for `tool` (undefined cliTools = claude). */
function entryHasTool(entry: CatalogCommandEntry, tool: string): boolean {
  if (entry.cliTools && entry.cliTools.length > 0) {
    return entry.cliTools.includes(tool);
  }
  return tool === 'claude';
}

function descriptionKeyFor(name: string): string {
  return `${DESCRIPTION_KEY_PREFIX}${name}`;
}

/**
 * Reconcile the catalog against provider results.
 *
 * Never mutates the input catalog: the returned `catalog` is a fresh object with
 * cloned `commands` and `verifiedAgainst`.
 */
export function reconcileCatalog(
  catalog: SlashCommandsCatalog,
  providerResults: ProviderResult[],
  options: ReconcileOptions = {}
): ReconcileResult {
  const defaultCategory = options.defaultCategory ?? DEFAULT_CATEGORY;

  const commands: CatalogCommandEntry[] = catalog.commands.map((c) => ({ ...c }));
  const verifiedAgainst: Record<string, string> = { ...catalog.verifiedAgainst };

  const diff: ReconcileDiff = { added: [], missingFromSource: [], verifiedAgainstUpdated: {} };
  const localeAdditions: LocaleAddition[] = [];
  const warnings: string[] = [];
  const notices: ReconcileNotice[] = [];

  // Description keys already backed by a locale string (every catalog entry's
  // key resolves to an existing dictionary entry — a tested invariant).
  const existingKeys = new Set<string>(
    commands.map((c) => c.descriptionKey).filter((k): k is string => typeof k === 'string')
  );
  /** Locale entries staged this pass, by key — the seam a conflict rewrites. */
  const pendingLocale = new Map<string, LocaleAddition>();
  const conflictedKeys = new Set<string>();

  for (const result of providerResults) {
    warnings.push(...result.warnings);
    if (!result.ok) continue; // fail-soft: leave this tool's entries untouched.

    const tool = result.tool;
    const sourceCommands = sanitizeProviderCommands(result.commands);
    // Every name the source still *mentions*, refused rows included: a history
    // row is not evidence that the catalog entry vanished, so it must not turn
    // an existing entry into a missingFromSource deletion candidate.
    const sourceNames = new Set(sourceCommands.map((c) => c.name));

    // Names already catalogued for this tool (drives idempotency + no #1488 dupes).
    const existingNamesForTool = new Set(
      commands.filter((c) => entryHasTool(c, tool)).map((c) => c.name)
    );

    for (const command of sourceCommands) {
      // Refusals are reported even when the name is already catalogued — that
      // combination ("source says removed, catalog still ships it") is exactly
      // what a human needs to see on the release PR.
      const catalogued = existingNamesForTool.has(command.name);

      if (command.status === 'removed') {
        notices.push({
          category: 'removed-row',
          tool,
          name: command.name,
          message: catalogued
            ? `documented as removed${removedDetail(command)}; the catalog still lists it — review`
            : `documented as removed${removedDetail(command)}; not added`,
        });
        continue;
      }

      if (command.aliasOf) {
        notices.push({
          category: 'alias-row',
          tool,
          name: command.name,
          message: catalogued
            ? `alias for /${command.aliasOf}; the catalog still lists it — review`
            : `alias for /${command.aliasOf}; not added`,
        });
        continue;
      }

      if (catalogued) continue;

      let enDescription = command.description;
      if (isSuspectDescription(enDescription)) {
        notices.push({
          category: 'suspect-description',
          tool,
          name: command.name,
          message: `dropped a marker-like description: "${enDescription}"`,
        });
        enDescription = undefined;
      }

      const descriptionKey = descriptionKeyFor(command.name);
      commands.push({
        name: command.name,
        descriptionKey,
        category: defaultCategory,
        cliTools: [tool],
        isStandard: true,
        source: 'standard',
      });
      existingNamesForTool.add(command.name);

      diff.added.push({
        tool,
        name: command.name,
        descriptionKey,
        enDescription,
        minVersion: command.minVersion,
      });

      // Only add a locale string when this key is genuinely new (a name shared
      // with an existing command reuses its dictionary entry).
      const en = enDescription ?? command.name;
      const pending = pendingLocale.get(descriptionKey);
      if (!existingKeys.has(descriptionKey) && !pending) {
        const addition: LocaleAddition = {
          key: descriptionKey,
          en,
          ja: `${JA_REVIEW_PREFIX}${en}`,
        };
        localeAdditions.push(addition);
        pendingLocale.set(descriptionKey, addition);
      } else if (pending && pending.en !== en && !conflictedKeys.has(descriptionKey)) {
        // One i18n key, two tools, two meanings: first-wins would ship the
        // other tool's sentence under this key (Issue #1603). Neither wins —
        // the key falls back to a review placeholder for a human to author.
        conflictedKeys.add(descriptionKey);
        notices.push({
          category: 'description-conflict',
          name: command.name,
          message:
            `tools disagree on the description ("${pending.en}" vs "${en}"); ` +
            'left as a review placeholder',
        });
        pending.en = command.name;
        pending.ja = `${JA_REVIEW_PREFIX}${command.name}`;
      }
    }

    // Report catalog entries this tool no longer lists (human-reviewed, not auto-deleted).
    for (const entry of commands) {
      if (entryHasTool(entry, tool) && !sourceNames.has(entry.name)) {
        diff.missingFromSource.push({ tool, name: entry.name });
      }
    }

    // Stamp verifiedAgainst only for a version-pinned source.
    if (result.sourceVersion) {
      const from = verifiedAgainst[tool];
      if (from !== result.sourceVersion) {
        verifiedAgainst[tool] = result.sourceVersion;
        diff.verifiedAgainstUpdated[tool] = { from, to: result.sourceVersion };
      }
    }
  }

  const changed =
    diff.added.length > 0 ||
    localeAdditions.length > 0 ||
    Object.keys(diff.verifiedAgainstUpdated).length > 0;

  return {
    catalog: { ...catalog, commands, verifiedAgainst },
    localeAdditions,
    diff,
    warnings,
    notices,
    changed,
  };
}
