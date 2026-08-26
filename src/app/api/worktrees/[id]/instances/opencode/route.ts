/**
 * API Route: opencode launch settings for a worktree's agent instances (#2048).
 *
 * `GET`  — every opencode-backed instance's stored settings, plus the candidate
 *          lists read from a live server when one is reachable.
 * `PUT`  — write one instance's settings.
 *
 * ## Why the candidates come from a *running* pane
 *
 * The model and agent lists are not static: they are whatever the operator's own
 * opencode is configured with, and the only way to know that is to ask an
 * opencode. `GET /config/providers` and `GET /agent` are served by the TUI
 * itself once it has a `--port` (#1758 §5.1.2), so the catalogue is readable
 * exactly while a pane of this worktree is up. When none is —
 * which is the ordinary state of a worktree whose agents are stopped — the
 * response says `connected: false` and the pane falls back to free text, which
 * is what Issue #2048 asks for ("port 未接続時は自由入力").
 *
 * Any opencode instance of this worktree will do, because the catalogue is a
 * property of the *installation* rather than of the pane: `/config/providers`
 * answers from the merged config, and two panes in one worktree share a `HOME`.
 * The first one with a live port is asked and the rest are not.
 *
 * ## What this route deliberately does not do
 *
 * It does not restart anything, and it does not try to move a running session
 * onto the model it just stored. `--agent` / `--model` take effect on the **next
 * launch**, and switching a live pane is opencode's own `/tui/open-models` /
 * Tab / `ctrl+t` — which rewrite the operator's **global default model**, so it
 * is not something a CommandMate API should be doing on their behalf. The one
 * setting that reaches a running session is the variant, and it does so on the
 * prompt this server posts rather than by pushing anything at the pane.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  getOpencodeInstanceSettingsByWorktree,
  setOpencodeInstanceSettings,
  InvalidAgentInstanceError,
} from '@/lib/db/agent-instances-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { fetchOpencodeAgents, fetchOpencodeProviderCatalog } from '@/lib/hooks/sources/opencode/client';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { rememberOpencodeLaunchSettings } from '@/lib/hooks/sources/opencode/launch-settings';
import { OPENCODE_CLI_TOOL_ID } from '@/lib/hooks/sources/opencode/tool-id';
import { getOpencodeLiveness } from '@/lib/hooks/sources/opencode/subscription';
import {
  EMPTY_OPENCODE_INSTANCE_SETTINGS,
  EMPTY_OPENCODE_LAUNCH_CATALOG,
  normalizeOpencodeInstanceSettings,
  type OpencodeInstanceSettings,
  type OpencodeInstanceSettingsResponse,
  type OpencodeLaunchCatalog,
} from '@/types/opencode-instance-settings';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import type { AgentInstance } from '@/lib/cli-tools/types';

const logger = createLogger('api/instances/opencode');

/** The opencode-backed entries of a roster, in roster order. */
function opencodeInstances(instances: AgentInstance[]): AgentInstance[] {
  return instances.filter((instance) => instance.cliTool === OPENCODE_CLI_TOOL_ID);
}

/**
 * Ask the first reachable opencode of this worktree for its catalogue.
 *
 * `getOpencodeLiveness` is checked as well as the port, for the reason the send
 * path checks it: `getAssignedOpencodePort` answers from a file this server
 * wrote, and a number written down is not a server still listening on it. A
 * squatter would answer `200 text/html` to both routes (#1931), which the
 * readers refuse — so the worst case is an empty catalogue, not a wrong one.
 */
async function readCatalog(
  worktreeId: string,
  instances: AgentInstance[]
): Promise<OpencodeLaunchCatalog> {
  for (const instance of instances) {
    const target = {
      worktreeId,
      cliToolId: OPENCODE_CLI_TOOL_ID,
      instanceId: instance.id,
    };
    const port = getAssignedOpencodePort(target);
    if (port === null) continue;
    if (getOpencodeLiveness(target).state !== 'live') continue;
    const [providers, agents] = await Promise.all([
      fetchOpencodeProviderCatalog(port),
      fetchOpencodeAgents(port),
    ]);
    if (providers.length === 0 && agents.length === 0) continue;
    return { connected: true, providers, agents };
  }
  return { ...EMPTY_OPENCODE_LAUNCH_CATALOG };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const instances = opencodeInstances(
      resolveAgentInstances(db, id, worktree.selectedAgents)
    );
    const stored = getOpencodeInstanceSettingsByWorktree(db, id);

    // Every opencode instance gets an entry, configured or not: the pane renders
    // one row per instance and an absent key would make it guess.
    const settings: Record<string, OpencodeInstanceSettings> = {};
    for (const instance of instances) {
      settings[instance.id] = stored[instance.id] ?? { ...EMPTY_OPENCODE_INSTANCE_SETTINGS };
    }

    // Issue #2048: opening the pane repairs the launcher's mirror. The rows are
    // the source of truth and the mirror is what the launch line reads, so they
    // can drift — a worktree id rename (v54/v55) moves the rows and not the
    // mirror's keys, and a database restored from a backup moves neither. This
    // is the one read that is guaranteed to happen before somebody edits a
    // setting, which makes it the right place to reconcile.
    for (const instance of instances) {
      rememberOpencodeLaunchSettings(
        { worktreeId: id, cliToolId: OPENCODE_CLI_TOOL_ID, instanceId: instance.id },
        settings[instance.id]
      );
    }

    const body: OpencodeInstanceSettingsResponse = {
      settings,
      catalog: await readCatalog(id, instances),
    };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-reading-opencode-instance-settings', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to read opencode instance settings' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const payload = body as Record<string, unknown>;
    const instanceId = payload.instanceId;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      return NextResponse.json({ error: 'instanceId is required' }, { status: 400 });
    }

    // The roster decides which instances may hold opencode settings. Writing one
    // for a claude instance would be stored, never read, and would survive as a
    // row nothing can explain — and the roster is also what stops an arbitrary
    // id from creating a row at all.
    const instance = resolveAgentInstances(db, id, worktree.selectedAgents).find(
      (entry) => entry.id === instanceId
    );
    if (!instance) {
      return NextResponse.json(
        { error: `Instance '${instanceId}' not found in this worktree` },
        { status: 404 }
      );
    }
    if (instance.cliTool !== OPENCODE_CLI_TOOL_ID) {
      return NextResponse.json(
        { error: `Instance '${instanceId}' is not an opencode instance` },
        { status: 400 }
      );
    }

    // Field-by-field coercion rather than rejection: `normalizeOpencodeInstanceSettings`
    // drops what it cannot use, and what it keeps is what reaches a shell command
    // line. See `types/opencode-instance-settings` for why that is a refusal and
    // not an escape.
    const requested = normalizeOpencodeInstanceSettings(payload);
    const settings = setOpencodeInstanceSettings(db, id, instanceId, requested);

    // Issue #2048: and the launcher's mirror, which is the copy
    // `prepareOpencodeLaunch` actually reads — it is synchronous and outside
    // the database's import graph. See `../../../../../lib/hooks/sources/opencode/launch-settings`.
    rememberOpencodeLaunchSettings(
      { worktreeId: id, cliToolId: OPENCODE_CLI_TOOL_ID, instanceId },
      settings
    );

    logger.info('opencode-instance-settings-updated', {
      worktreeId: id,
      instanceId,
      agent: settings.agent,
      providerId: settings.providerId,
      modelId: settings.modelId,
      variant: settings.variant,
    });

    return NextResponse.json({ instanceId, settings }, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof InvalidAgentInstanceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error('error-writing-opencode-instance-settings', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to update opencode instance settings' },
      { status: 500 }
    );
  }
}
