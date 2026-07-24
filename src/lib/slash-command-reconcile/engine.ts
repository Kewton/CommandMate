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
 */

import { sanitizeProviderCommands } from './sanitize';
import type {
  ProviderResult,
  ReconcileDiff,
  ReconcileResult,
  SlashCommandsCatalog,
  CatalogCommandEntry,
  LocaleAddition,
} from './types';

/** i18n key prefix every built-in description resolves through (Issue #1306). */
const DESCRIPTION_KEY_PREFIX = 'slashCommands.descriptions.';
/** Category a newly discovered command lands in until a human recategorizes it. */
const DEFAULT_CATEGORY = 'standard-util';
/** Marks a Japanese string as an untranslated placeholder needing review. */
const JA_REVIEW_PREFIX = '[要レビュー] ';

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

  // Description keys already backed by a locale string (every catalog entry's
  // key resolves to an existing dictionary entry — a tested invariant).
  const existingKeys = new Set<string>(
    commands.map((c) => c.descriptionKey).filter((k): k is string => typeof k === 'string')
  );
  const addedLocaleKeys = new Set<string>();

  for (const result of providerResults) {
    warnings.push(...result.warnings);
    if (!result.ok) continue; // fail-soft: leave this tool's entries untouched.

    const tool = result.tool;
    const sourceCommands = sanitizeProviderCommands(result.commands);
    const sourceNames = new Set(sourceCommands.map((c) => c.name));

    // Names already catalogued for this tool (drives idempotency + no #1488 dupes).
    const existingNamesForTool = new Set(
      commands.filter((c) => entryHasTool(c, tool)).map((c) => c.name)
    );

    for (const command of sourceCommands) {
      if (existingNamesForTool.has(command.name)) continue;

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
        enDescription: command.description,
        minVersion: command.minVersion,
      });

      // Only add a locale string when this key is genuinely new (a name shared
      // with an existing command reuses its dictionary entry).
      if (!existingKeys.has(descriptionKey) && !addedLocaleKeys.has(descriptionKey)) {
        const en = command.description ?? command.name;
        const ja = `${JA_REVIEW_PREFIX}${command.description ?? command.name}`;
        localeAdditions.push({ key: descriptionKey, en, ja });
        addedLocaleKeys.add(descriptionKey);
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
    changed,
  };
}
