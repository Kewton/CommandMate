/**
 * GET  /api/settings/default-agents — the agent list new worktrees start with
 * PUT  /api/settings/default-agents — save (or clear) that list
 *
 * Issue #2065. Before this route the answer was a compiled-in constant
 * (`DEFAULT_SELECTED_AGENTS`), so a user who works in codex first had to
 * re-order the tabs on every branch they created. The setting is server-wide and
 * ordered, and `agents[0]` is the primary — the tab that opens first and the
 * instance a bare `commandmate send` targets.
 *
 * It is stored in `app_settings`, which means it is a preference and not a
 * migration: no row is written at install time, and `configured: false` is a
 * first-class answer meaning "still on the constant".
 *
 * ## Why the installed list is opt-in
 *
 * `?include=installed` annotates each choice with whether that CLI is actually
 * on this machine. It is opt-in because answering it runs one child process per
 * tool (Issue #1913's hot-path rule); the settings screen asks for it, and the
 * cheap GET that every other screen uses to seed its client-side fallback does
 * not. See `@/config/installed-agents-cache`.
 */

// Reads the database on every request; a prerendered answer would be a snapshot
// of whatever the setting was at build time.
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getDefaultSelectedAgents,
  setDefaultSelectedAgents,
  clearDefaultSelectedAgents,
} from '@/lib/db/app-settings-db';
import {
  DEFAULT_SELECTED_AGENTS,
  MAX_SELECTED_AGENTS,
  MIN_SELECTED_AGENTS,
  resolveSelectedAgents,
  validateSelectedAgentsInput,
} from '@/lib/selected-agents-validator';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { getInstalledAgentIds } from '@/config/installed-agents-cache';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/settings/default-agents');

interface DefaultAgentsBody {
  success: true;
  /** The list in force: the stored setting, else the compiled-in constant. */
  defaultSelectedAgents: CLIToolType[];
  /** false means "nothing stored" — the install is still on the constant. */
  configured: boolean;
  /** What a reset returns to. Lets the UI show "Default" without hardcoding it. */
  constantDefault: CLIToolType[];
  /** Every selectable id, so the UI never hardcodes the vocabulary. */
  available: CLIToolType[];
  minAgents: number;
  maxAgents: number;
  /** Present only for `?include=installed`. */
  installed?: CLIToolType[];
}

async function buildBody(includeInstalled: boolean): Promise<DefaultAgentsBody> {
  const db = getDbInstance();
  const stored = getDefaultSelectedAgents(db);

  const body: DefaultAgentsBody = {
    success: true,
    defaultSelectedAgents: resolveSelectedAgents({ appSettings: stored }),
    configured: stored !== null,
    constantDefault: DEFAULT_SELECTED_AGENTS,
    available: [...CLI_TOOL_IDS],
    minAgents: MIN_SELECTED_AGENTS,
    maxAgents: MAX_SELECTED_AGENTS,
  };

  if (includeInstalled) {
    body.installed = await getInstalledAgentIds();
  }
  return body;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const includeInstalled =
      request.nextUrl?.searchParams?.get('include') === 'installed';
    return NextResponse.json(await buildBody(includeInstalled), { status: 200 });
  } catch (error) {
    logger.error('get-default-agents-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('agents' in body)) {
      return NextResponse.json(
        { success: false, error: 'Invalid request body: "agents" is required' },
        { status: 400 }
      );
    }

    const agents = (body as { agents: unknown }).agents;
    const db = getDbInstance();

    // `null` is "forget my preference", not "store nothing": the row is deleted
    // so the install follows the constant again, including a later change to it.
    if (agents === null) {
      clearDefaultSelectedAgents(db);
      return NextResponse.json(await buildBody(false), { status: 200 });
    }

    const validation = validateSelectedAgentsInput(agents);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    setDefaultSelectedAgents(db, validation.value!);
    logger.info('default-agents-updated', { agents: validation.value! });

    // Existing worktrees are untouched on purpose: `agent_instances` rows are
    // the authority once they exist, and this route writes none. The setting
    // only reaches worktrees that have no roster yet — the ones a later sync
    // discovers. Applying it to existing branches is Issue #2067's "apply to
    // all" action, not a side effect of saving a preference.
    return NextResponse.json(await buildBody(false), { status: 200 });
  } catch (error) {
    logger.error('put-default-agents-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
