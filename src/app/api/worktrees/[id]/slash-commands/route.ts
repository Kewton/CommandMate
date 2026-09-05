/**
 * Worktree-Specific Slash Commands API (Issue #56, Issue #4)
 *
 * GET /api/worktrees/[id]/slash-commands?cliTool=claude|codex|gemini
 *
 * Returns merged slash commands for a specific worktree:
 * - Standard CLI tool commands (filtered by cliTool)
 * - Worktree-specific commands from .claude/commands/
 *
 * MF-1: Implements path validation to prevent traversal attacks
 * SF-1: Worktree commands take priority over standard commands
 * Issue #4: Filters commands by CLI tool
 */

import * as os from 'os';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getSlashCommandGroups, loadSkills, loadCodexSkills, loadAgentsSkills, loadOpencodeSkills, loadCommandCodeSkills, mergeCodexFamilySkills, getCopilotBuiltinCommands, getGeminiBuiltinCommands, opencodeLiveCommandsToSlashCommands } from '@/lib/slash-commands';
import {
  getOpencodeLiveCommands,
  scheduleOpencodeLiveRefresh,
} from './opencode-live';
import { getStandardCommandGroups } from '@/lib/standard-commands';
import {
  loadUserCatalogCommands,
  composeStandardLayer,
  getCatalogStalenessSnapshot,
} from '@/lib/slash-command-catalog';
import { mergeCommandGroups, filterCommandsByCliTool, groupByCategory, foldInMissingCommands } from '@/lib/command-merger';
import { isValidWorktreePath } from '@/lib/security/worktree-path-validator';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { SlashCommandGroup, CatalogStaleness } from '@/types/slash-commands';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/slash-commands');

/**
 * Slash commands API response
 *
 * NOTE: This interface is local to the worktree-specific API route.
 * A separate SlashCommandsResponse exists in api-client.ts for /api/slash-commands (MCBD).
 * The two types share the same name but have different structures (this one includes sources).
 */
interface SlashCommandsResponse {
  groups: ReturnType<typeof getStandardCommandGroups>;
  sources: {
    standard: number;
    worktree: number;
    mcbd: number;
    skill: number;  // Issue #343: Skills source count
    codexSkill: number;  // Issue #166: Codex skills source count
    userCatalog: number;  // Issue #1476: user extension entries
  };
  cliTool: CLIToolType;
  /**
   * Issue #1476: per-tool staleness of the built-in catalog. Additive and
   * backward compatible — a tool appears only when its CLI version could be
   * read, so an empty object means "nothing known to be stale".
   */
  catalogStaleness: CatalogStaleness;
}

/**
 * Validate CLI tool ID from query parameter
 */
function validateCliTool(cliTool: string | null): CLIToolType {
  if (cliTool && CLI_TOOL_IDS.includes(cliTool as CLIToolType)) {
    return cliTool as CLIToolType;
  }
  return 'claude'; // Default to Claude for backward compatibility
}

/**
 * GET /api/worktrees/[id]/slash-commands
 *
 * Returns merged slash commands for the specified worktree.
 * Optionally filters by CLI tool via ?cliTool=claude|codex|gemini query parameter.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<SlashCommandsResponse | { error: string }>> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);

    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    // MF-1: Path validation to prevent traversal attacks
    if (!isValidWorktreePath(worktree.path)) {
      logger.error('invalid-worktree-path-detected:');
      return NextResponse.json(
        { error: 'Invalid worktree configuration' },
        { status: 400 }
      );
    }

    // Issue #4: Get CLI tool from query parameter
    const cliTool = validateCliTool(request.nextUrl.searchParams.get('cliTool'));

    // Get standard command groups, then fold in user extension commands
    // (Issue #1476). User entries override bundled entries that share the same
    // name + CLI tool scope, but stay part of the standard layer so worktree
    // commands still take priority (SF-1 invariant preserved by the merge below).
    const standardGroups = composeStandardLayer(
      getStandardCommandGroups(),
      loadUserCatalogCommands()
    );

    // Get worktree-specific command groups (includes local Codex skills via getSlashCommandGroups)
    let worktreeGroups: SlashCommandGroup[] = [];
    try {
      worktreeGroups = await getSlashCommandGroups(worktree.path);
    } catch {
      logger.warn('commands:load-failed');
      worktreeGroups = [];
    }

    // Load global Codex-family skills: current ~/.agents/skills/ (Issue #1165,
    // codex+antigravity) and legacy ~/.codex/skills/ (Issue #166, #790, codex-only).
    // mergeCodexFamilySkills collapses same-named entries whose cliTools scopes now
    // differ (Issue #1504) so they are not shown twice in codex sessions.
    // .codex/prompts/ is intentionally NOT loaded: Codex CLI never reads it, so
    // surfacing those entries in the palette only misleads users.
    const globalCodexSkills = await loadCodexSkills().catch(() => []);
    const globalAgentsSkills = await loadAgentsSkills().catch(() => []);
    const globalSkills = mergeCodexFamilySkills(globalCodexSkills, globalAgentsSkills);

    // Load global Claude skills from ~/.claude/skills (Issue #1505). loadSkills
    // defaults its base to process.cwd(), so pass os.homedir() explicitly to scan
    // the user-level skills dir — symmetric with the global Codex-family scan
    // above. These keep the default 'skill' source and undefined cliTools, so
    // filterCommandsByCliTool surfaces them only in claude sessions (never
    // codex/antigravity). Missing dir tolerated by scanSkillDirs + .catch.
    const globalClaudeSkills = await loadSkills(os.homedir()).catch(() => []);

    // Skill roots opencode was measured to read — `.opencode/skills`,
    // `.claude/skills` and `.agents/skills`, in the worktree and under $HOME
    // (Issue #2037, opencode 1.18.22). opencode discovers a Skill in all six and
    // runs it as `/<name>`, but its own palette never offers one, so this is the
    // only place the route is discoverable.
    //
    // Loaded only for an opencode session, and here rather than inside
    // getSlashCommandGroups: the entries carry cliTools ['opencode'] so
    // filterCommandsByCliTool would drop them for every other tool anyway, and
    // keeping them out of the shared worktree layer means no other caller of
    // that function gains an opencode-scoped copy of every Skill.
    const [worktreeOpencodeSkills, globalOpencodeSkills] =
      cliTool === 'opencode'
        ? await Promise.all([
            loadOpencodeSkills(worktree.path).catch(() => []),
            loadOpencodeSkills(os.homedir()).catch(() => []),
          ])
        : [[], []];

    // Skill roots Command Code 1.47.0 was measured to read — `.commandcode/skills`
    // and `.agents/skills`, in the worktree and under $HOME (Issue #2322).
    // `.claude/skills` is deliberately absent: a Skill planted only there is not
    // discovered (negative control in loadCommandCodeSkills), so offering it
    // would put an unrunnable row in the palette.
    //
    // Placed here, and only for a command-code session, for the same two reasons
    // as the opencode scan above: the entries carry cliTools ['command-code'] so
    // every other tool would filter them out anyway, and keeping them out of
    // getSlashCommandGroups means no other caller gains a second copy of every
    // Skill. Without this the palette is empty of Skills entirely — the
    // `.agents/skills` rows loadAgentsSkills produces are scoped to codex and
    // antigravity.
    const [worktreeCommandCodeSkills, globalCommandCodeSkills] =
      cliTool === 'command-code'
        ? await Promise.all([
            loadCommandCodeSkills(worktree.path).catch(() => []),
            loadCommandCodeSkills(os.homedir()).catch(() => []),
          ])
        : [[], []];

    // SF-1: Merge with worktree commands taking priority
    // Include global Codex skills in worktree groups (local ones already included via getSlashCommandGroups)
    const globalCodexGroups: SlashCommandGroup[] = globalSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: globalSkills }]
      : [];

    // Global Claude skills sit below worktree entries so a same-named worktree
    // .claude/skills skill wins (worktree優先). Both carry key `name::claude`
    // (keyOf), and mergeCommandGroups lets later groups override earlier ones,
    // so this group is placed *before* worktreeGroups in the merge array below.
    const globalClaudeGroups: SlashCommandGroup[] = globalClaudeSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: globalClaudeSkills }]
      : [];

    // Builtins are injected per-cli to prevent unrelated tools from overriding
    // shared standard commands with same names (clear, model, help, etc.).
    const copilotBuiltinGroups: SlashCommandGroup[] = cliTool === 'copilot'
      ? groupByCategory(getCopilotBuiltinCommands())
      : [];
    const geminiBuiltinGroups: SlashCommandGroup[] = cliTool === 'gemini'
      ? groupByCategory(getGeminiBuiltinCommands())
      : [];

    // Global first, worktree second: mergeCommandGroups lets a later group win,
    // so a Skill installed into this worktree beats a same-named one in $HOME.
    const globalOpencodeGroups: SlashCommandGroup[] = globalOpencodeSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: globalOpencodeSkills }]
      : [];
    const worktreeOpencodeGroups: SlashCommandGroup[] = worktreeOpencodeSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: worktreeOpencodeSkills }]
      : [];

    // Same global-then-worktree ordering, same reason (Issue #2322).
    const globalCommandCodeGroups: SlashCommandGroup[] = globalCommandCodeSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: globalCommandCodeSkills }]
      : [];
    const worktreeCommandCodeGroups: SlashCommandGroup[] = worktreeCommandCodeSkills.length > 0
      ? [{ category: 'skill' as const, label: 'Skills', commands: worktreeCommandCodeSkills }]
      : [];

    const mergedGroups = mergeCommandGroups(
      standardGroups,
      [...globalClaudeGroups, ...globalOpencodeGroups, ...globalCommandCodeGroups, ...worktreeGroups, ...worktreeOpencodeGroups, ...worktreeCommandCodeGroups, ...globalCodexGroups, ...copilotBuiltinGroups, ...geminiBuiltinGroups]
    );

    // Issue #4: Filter by CLI tool
    let filteredGroups = filterCommandsByCliTool(mergedGroups, cliTool);

    // Issue #2036: fold in what only the running opencode server knows — the
    // project's own `.opencode/commands/*.md` and the Skills it discovered, with
    // their descriptions and argument hints. Read from the process cache and
    // additive only (foldInMissingCommands), so a catalog entry keeps its
    // translated description and a tool with no live source is untouched.
    //
    // The refresh is started *after* the snapshot is taken and never awaited
    // (#1913 §4 D2): a palette keystroke must not carry a request to a process
    // CommandMate did not start. An empty snapshot means "not known yet" — the
    // catalog answers this open and the live rows appear on the next one.
    if (cliTool === 'opencode') {
      filteredGroups = foldInMissingCommands(
        filteredGroups,
        opencodeLiveCommandsToSlashCommands(getOpencodeLiveCommands(id))
      );
      scheduleOpencodeLiveRefresh(id, worktree.path);
    }

    // Calculate source counts in a single pass
    const sourceCounts = { standard: 0, worktree: 0, skill: 0, codexSkill: 0, userCatalog: 0 };
    for (const group of filteredGroups) {
      for (const cmd of group.commands) {
        if (cmd.source === 'standard') sourceCounts.standard++;
        else if (cmd.source === 'worktree') sourceCounts.worktree++;
        else if (cmd.source === 'skill') sourceCounts.skill++;
        else if (cmd.source === 'codex-skill') sourceCounts.codexSkill++;
        else if (cmd.source === 'user-catalog') sourceCounts.userCatalog++;
      }
    }

    // Issue #1476: lazy, process-cached staleness probe. Never fails the request.
    // Issue #1913 follow-up: read the cache, start the probe in the background,
    // and never wait for it (§4 D2, DR3-013). Awaiting it put five child
    // processes on the response path — 322ms cold on the developer machine, and
    // up to VERSION_PROBE_TIMEOUT_MS if one of them hangs. `{}` here means "not
    // known yet"; the banner appears on the next palette open.
    const catalogStaleness: CatalogStaleness = getCatalogStalenessSnapshot();

    return NextResponse.json({
      groups: filteredGroups,
      sources: {
        ...sourceCounts,
        mcbd: 0, // MCBD commands are loaded separately via /api/slash-commands
      },
      cliTool,
      catalogStaleness,
    });
  } catch (error) {
    logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to load slash commands' },
      { status: 500 }
    );
  }
}
