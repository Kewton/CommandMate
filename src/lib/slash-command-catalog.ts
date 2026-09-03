/**
 * Slash Command Catalog — user extension + staleness (Issue #1476)
 *
 * The built-in command snapshot is bundled JSON (see standard-commands.ts). This
 * module adds the two release-independent pieces around it:
 *
 *  - User extension files under `<configDir>/slash-commands/*.json`, validated
 *    and merged into the standard layer so users can surface commands the
 *    bundled snapshot has not caught up to yet (e.g. Claude Code `/loop`).
 *  - Staleness detection: probe the installed claude/codex/antigravity CLI
 *    versions and compare against `CATALOG_VERIFIED_AGAINST`, so the UI can hint
 *    when the built-in list is likely behind. Issue #2026 changed where that map
 *    comes from — the attestation record rather than a field in the catalog file
 *    — but not its shape or meaning here. What it buys this module is that the
 *    version can no longer be newer than the reading it claims to summarize:
 *    `catalog:refresh --write` used to bump the stamp by itself, so a tool could
 *    report "not stale" off a version no human had checked the entries against.
 *
 * Server-only: this module shells out via execFile and reads the filesystem, so
 * it must never be imported from a client component.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  SlashCommand,
  SlashCommandCategory,
  SlashCommandGroup,
  CatalogStaleness,
} from '@/types/slash-commands';
import { CATEGORY_LABELS } from '@/types/slash-commands';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';
import { getConfigDir } from '@/cli/utils/install-context';
import { CATALOG_VERIFIED_AGAINST } from '@/lib/standard-commands';
import { resolveCopilotExecutable } from '@/lib/cli-tools/copilot-executable';
import { sanitizeEnvForChildProcess } from '@/lib/security/env-sanitizer';
import { mergeCommandGroups, groupByCategory } from '@/lib/command-merger';
import { truncateString } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('slash-command-catalog');

/** User extension directory, relative to the resolved config dir. */
const USER_CATALOG_SUBDIR = 'slash-commands';
/** Max size of a single user extension file (64KB, matches skill files). */
const MAX_USER_CATALOG_FILE_SIZE_BYTES = 65536;
/** Max entries honored from one user extension file. */
const MAX_USER_CATALOG_ENTRIES_PER_FILE = 200;
/** Command name truncate limit (reused from skill limits, Issue #343). */
const MAX_COMMAND_NAME_LENGTH = 100;
/** Command description truncate limit (reused from skill limits, Issue #343). */
const MAX_COMMAND_DESCRIPTION_LENGTH = 500;
/** Default category when a user entry omits or misspells `category`. */
const DEFAULT_USER_CATEGORY: SlashCommandCategory = 'standard-util';
/** `<cli> --version` probe timeout (matches copilot.ts, Issue #1476 R3). */
const VERSION_PROBE_TIMEOUT_MS = 5000;
/**
 * Cap on `--version` output kept in memory (Issue #1913, DR4-010 (4)).
 *
 * `execFile` defaults to 1MB; a probe that answers with a megabyte of text is
 * already misbehaving, so the buffer is sized to a version banner and the child
 * is killed past it. The result is discarded either way — an over-long answer
 * surfaces as `error` and leaves the tool out of the staleness report.
 */
const VERSION_PROBE_MAX_BUFFER_BYTES = 64 * 1024;

/** Valid category set, derived from the label map so it stays in sync. */
const VALID_CATEGORIES = new Set<string>(Object.keys(CATEGORY_LABELS));

/** Extracts a `major.minor.patch` triple from arbitrary `--version` output. */
const VERSION_REGEX = /(\d+)\.(\d+)\.(\d+)/;

/**
 * One staleness probe.
 *
 * `execFile` is the default: run `<command> <args>` and read a version out of
 * the output. `delegated` exists for a tool that owns its own resolution,
 * because *finding* the executable is part of the question for it.
 */
type VersionProbe =
  | { kind: 'execFile'; command: string; args: string[] }
  | { kind: 'delegated'; probe: () => Promise<string | null> };

/**
 * Staleness probes: catalog tool id → how to read its installed version.
 *
 * The binary for antigravity is `agy` (Issue #1476 R3).
 *
 * **copilot is delegated, and must stay delegated** (Issue #1913 follow-up).
 * The first cut of this table probed `gh copilot -- --version`, on the premise
 * that the launch executable was `COPILOT_LAUNCH_COMMAND = 'gh copilot'`.
 * Issue #1907 then measured what that command actually does: `copilot` is a
 * preview command built into `gh`, not an extension, and on a machine whose
 * PATH has no copilot **it downloads the CLI** into ~/.local/share/gh/copilot.
 * A staleness hint must never install software, and a probe that may fetch a
 * release over the network has no business on a request path. #1907 also moved
 * the launch executable to PATH `copilot` (gh's copy is the fallback), so the
 * `gh` spelling stopped matching the launched binary as well.
 *
 * `resolveCopilotExecutable` is the same resolution `CopilotTool.startSession`
 * uses, so probe and launch cannot disagree (§4 D2 / DR4-010 (1)), and it
 * already resolves to an absolute path before executing (DR4-010 (2)).
 *
 * The remaining four names are still resolved by `execFile` off the server's
 * PATH; see probeCliVersion for why absolute-path resolution lands with Phase 3.
 *
 * **command-code is deliberately absent** (Issue #2253). It has an attestation
 * like the other five, so `CATALOG_VERIFIED_AGAINST['command-code']` exists and a
 * probe row would work — but `commandcode --version` is not a read. Run against
 * a scratch `HOME` on 2026-09-03 (1.40.1) it created
 * `$HOME/.commandcode/telemetry-install-id`, i.e. it mints a telemetry identity
 * for whoever runs it, and it took 0.41–0.47s against `codex --version`'s 0.04s.
 * That is the same bar copilot was moved off `gh` for: a staleness hint is a
 * convenience, and it must not have side effects on a machine whose owner has
 * the binary on PATH but has never chosen to use the tool here. The cost of
 * leaving it out is bounded and visible — computeCatalogStaleness skips a tool
 * with no probe, so the palette shows no staleness banner for Command Code and
 * nothing else changes. The shape that would make it safe is a `delegated`
 * probe that reads the installed package's own `package.json` rather than
 * executing the binary; that is a separate build, not something to smuggle in
 * with a catalog addition.
 */
const VERSION_PROBES: Record<string, VersionProbe> = {
  claude: { kind: 'execFile', command: 'claude', args: ['--version'] },
  codex: { kind: 'execFile', command: 'codex', args: ['--version'] },
  antigravity: { kind: 'execFile', command: 'agy', args: ['--version'] },
  opencode: { kind: 'execFile', command: 'opencode', args: ['--version'] },
  copilot: {
    kind: 'delegated',
    probe: async () => (await resolveCopilotExecutable())?.version ?? null,
  },
};

// --------------------------------------------------------------------------
// User extension loading
// --------------------------------------------------------------------------

interface RawUserCommand {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  cliTools?: unknown;
}

interface RawUserCatalogFile {
  commands?: unknown;
}

let userCatalogCache: SlashCommand[] | null = null;

/**
 * Validate a user-supplied `cliTools` value.
 *
 * - omitted → valid, undefined scope (Claude-only, per keyOf semantics)
 * - non-array / empty / any invalid tool id → the whole entry is rejected
 *   (Issue #1476: "cliTools は isCliToolType で検証、不正値はエントリごとスキップ")
 */
function parseUserCliTools(value: unknown): { ok: boolean; tools?: CLIToolType[] } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value) || value.length === 0) return { ok: false };
  const tools: CLIToolType[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isCliToolType(entry)) return { ok: false };
    tools.push(entry);
  }
  return { ok: true, tools };
}

function parseUserCategory(value: unknown): SlashCommandCategory {
  if (typeof value === 'string' && VALID_CATEGORIES.has(value)) {
    return value as SlashCommandCategory;
  }
  return DEFAULT_USER_CATEGORY;
}

/**
 * Convert one raw user entry into a validated SlashCommand, or null if it is
 * malformed. `descriptionKey` is intentionally ignored for user entries — their
 * description is authored literally and needs no i18n resolution (Issue #1476).
 */
function toUserCommand(raw: unknown): SlashCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as RawUserCommand;

  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) return null;

  const cliTools = parseUserCliTools(entry.cliTools);
  if (!cliTools.ok) return null;

  const description = typeof entry.description === 'string' ? entry.description : '';

  const command: SlashCommand = {
    name: truncateString(entry.name.trim(), MAX_COMMAND_NAME_LENGTH),
    description: truncateString(description, MAX_COMMAND_DESCRIPTION_LENGTH),
    category: parseUserCategory(entry.category),
    source: 'user-catalog',
    isStandard: false,
    filePath: '',
  };
  if (cliTools.tools) command.cliTools = cliTools.tools;
  return command;
}

/**
 * Read one user extension file. Any failure (missing, oversized, bad JSON,
 * wrong shape) is logged and yields an empty list so a single broken file never
 * takes down the whole command list.
 */
function loadUserCatalogFile(filePath: string): SlashCommand[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  if (stat.size > MAX_USER_CATALOG_FILE_SIZE_BYTES) {
    logger.warn('user-catalog-file-too-large', { size: stat.size });
    return [];
  }

  let parsed: RawUserCatalogFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    logger.warn('user-catalog-file-parse-failed');
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.commands)) {
    logger.warn('user-catalog-file-invalid-shape');
    return [];
  }

  if (parsed.commands.length > MAX_USER_CATALOG_ENTRIES_PER_FILE) {
    logger.warn('user-catalog-file-entry-limit', { count: parsed.commands.length });
  }

  const rawCommands = parsed.commands.slice(0, MAX_USER_CATALOG_ENTRIES_PER_FILE);
  const commands: SlashCommand[] = [];
  for (const raw of rawCommands) {
    const command = toUserCommand(raw);
    if (command) {
      commands.push(command);
    } else {
      logger.warn('user-catalog-entry-skipped');
    }
  }
  return commands;
}

/** Resolve the user extension directory, or null if the config dir is unavailable. */
function resolveUserCatalogDir(): string | null {
  try {
    return path.join(getConfigDir(), USER_CATALOG_SUBDIR);
  } catch {
    return null;
  }
}

function readUserCatalogCommands(): SlashCommand[] {
  const dir = resolveUserCatalogDir();
  if (!dir) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory absent (the common case) → no user extensions.
    return [];
  }

  const resolvedRoot = path.resolve(dir) + path.sep;
  const commands: SlashCommand[] = [];
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('..'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of files) {
    const filePath = path.resolve(dir, entry.name);
    if (!filePath.startsWith(resolvedRoot)) continue;
    commands.push(...loadUserCatalogFile(filePath));
  }
  return commands;
}

/**
 * Load user extension commands, cached per process (Issue #1476 R2).
 * File changes are picked up on server restart (hot reload is out of scope).
 */
export function loadUserCatalogCommands(): SlashCommand[] {
  if (userCatalogCache === null) {
    userCatalogCache = readUserCatalogCommands();
  }
  return userCatalogCache;
}

/**
 * Fold user extension commands into the bundled standard layer (Issue #1476).
 *
 * User entries override bundled entries that share the same name + CLI tool
 * scope (keyOf), but the result is still the *standard* layer: callers merge it
 * against worktree commands afterwards, so the SF-1 invariant (worktree wins
 * over standard) is preserved — worktree entries override user entries too.
 */
export function composeStandardLayer(
  bundledGroups: SlashCommandGroup[],
  userCommands: SlashCommand[],
): SlashCommandGroup[] {
  if (userCommands.length === 0) return bundledGroups;
  return mergeCommandGroups(bundledGroups, groupByCategory(userCommands));
}

// --------------------------------------------------------------------------
// Staleness detection
// --------------------------------------------------------------------------

let stalenessCache: CatalogStaleness | null = null;
let stalenessInFlight: Promise<CatalogStaleness> | null = null;

/** Extract a normalized `major.minor.patch` version from `--version` output. */
export function parseCliVersion(output: string): string | null {
  const match = VERSION_REGEX.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Compare two `major.minor.patch` versions numerically.
 * @returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Probe a CLI's version via execFile (no shell). Resolves null on any failure.
 *
 * The child runs with `sanitizeEnvForChildProcess()` (DR4-010 (3)) so a probe
 * never hands CommandMate's auth token, TLS key or DB path to a third-party
 * CLI, and with an explicit `maxBuffer` (DR4-010 (4)).
 *
 * DR4-010 (2) — resolving the command to an absolute path with `which`
 * semantics before executing it, so a repository-local `node_modules/.bin`
 * cannot decide which binary a cold probe runs — is deliberately NOT done here.
 * §13.2 S17 places that receipt on `DETECTOR_VERSION_PROBES` in Phase 3, and
 * the two tables should grow the same resolution helper in one change: doing it
 * to this table alone leaves two probe mechanisms with different trust models,
 * which is the shape DR4-010 is trying to remove.
 */
function probeCliVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: VERSION_PROBE_MAX_BUFFER_BYTES,
        env: sanitizeEnvForChildProcess(),
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseCliVersion(`${stdout ?? ''}\n${stderr ?? ''}`));
      }
    );
  });
}

async function computeCatalogStaleness(): Promise<CatalogStaleness> {
  const result: CatalogStaleness = {};

  await Promise.all(
    Object.keys(VERSION_PROBES).map(async (tool) => {
      const verifiedAgainst = CATALOG_VERIFIED_AGAINST[tool];
      if (!verifiedAgainst) return;
      const probe = VERSION_PROBES[tool];
      const current =
        probe.kind === 'execFile'
          ? await probeCliVersion(probe.command, probe.args)
          : await probe.probe().catch(() => null);
      // Unknown version (missing binary / timeout / unparseable) is never
      // reported — safe side, so we don't nag users with false positives.
      if (!current) return;
      result[tool] = {
        current,
        verifiedAgainst,
        stale: compareCliVersions(current, verifiedAgainst) > 0,
      };
    })
  );

  if (Object.values(result).some((entry) => entry.stale)) {
    logger.warn('builtin-catalog-stale', { staleness: result });
  }
  return result;
}

/**
 * Detect built-in catalog staleness, computed lazily once per process and
 * cached (Issue #1476 R3). Concurrent first callers share one probe.
 *
 * **This awaits child processes — do not call it from a request path.** Use
 * {@link getCatalogStalenessSnapshot}. Kept for callers that genuinely want the
 * answer (CLI diagnostics, tests) and as the single implementation both entry
 * points share.
 */
export async function getCatalogStaleness(): Promise<CatalogStaleness> {
  if (stalenessCache !== null) return stalenessCache;
  if (stalenessInFlight) return stalenessInFlight;

  stalenessInFlight = computeCatalogStaleness();
  try {
    stalenessCache = await stalenessInFlight;
    return stalenessCache;
  } finally {
    stalenessInFlight = null;
  }
}

/**
 * The staleness the process already knows, plus a background probe when it
 * knows nothing yet. Never awaits a child process (§4 D2, DR3-013 (a)(b)(c)).
 *
 * Returning `{}` means "not known yet", not "nothing is stale" — the hint is
 * additive, so a palette that opens before the cache is warm simply shows no
 * banner and the next open shows it. That is the deal DR3-013 makes: the probe
 * result is worth having, but never at the cost of holding a response open.
 *
 * Issue #1913 follow-up: the earlier `await getCatalogStaleness()` in the
 * slash-commands route was defended as "an operator-initiated one-off, so
 * waiting is fine". Measurement says otherwise. Adding opencode and copilot took
 * the cold call from **79ms to 322ms** on the developer machine (`opencode
 * --version` 260ms and `copilot --version` 287ms are slow-starting binaries),
 * and the ceiling is not 322ms but `VERSION_PROBE_TIMEOUT_MS` × a probe that
 * hangs. A version banner is not worth a request that can block for seconds.
 */
export function getCatalogStalenessSnapshot(): CatalogStaleness {
  if (stalenessCache !== null) return stalenessCache;
  // Fire and forget. No in-flight check here on purpose: getCatalogStaleness
  // owns that slot and hands a concurrent caller the promise that is already
  // running, so a second guard would be a copy of an invariant that lives one
  // function down — and a copy is what goes stale. It also swallows its own
  // failures, so nothing here needs the result.
  void getCatalogStaleness().catch(() => ({}));
  return {};
}

// --------------------------------------------------------------------------
// Cache control
// --------------------------------------------------------------------------

/** Clear this module's process-level caches (wired into slash-commands clearCache). */
export function clearCatalogCache(): void {
  userCatalogCache = null;
  stalenessCache = null;
  stalenessInFlight = null;
}
