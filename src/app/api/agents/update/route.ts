/**
 * POST /api/agents/update — run an agent CLI's own updater, outside its pane,
 * streaming the output back (Issue #2069).
 *
 * ## Why this is not "type `codex update` into the session"
 *
 * codex's updater terminates codex and does not restart it, so a pane that runs
 * it is left sitting at a bare shell — the state #2070 taught the detector to
 * name, and which a user then has to repair. The update therefore runs as a
 * child of the *server*, with no tmux anywhere in the path, and a live session
 * keeps running the binary it started with until the user restarts it. The
 * client shows that warning and offers `kill-session` as the restart.
 *
 * ## Security
 *
 * The same three controls `/api/app/update` rests on (#1198 決定2), because this
 * route also causes a global install:
 *
 *  - **Auth is middleware's job.** No check here, and this path must never be
 *    added to `AUTH_EXCLUDED_PATHS`.
 *  - **A fixed argv.** The request body carries exactly one thing, a tool id,
 *    which is validated against `UPDATABLE_AGENT_TOOLS` and then discarded: the
 *    command and its arguments are literals inside `lib/updates/agent-updater`,
 *    selected by that id and resolved to an absolute path. No string from the
 *    request reaches `execFile`, and no shell is involved at any point.
 *  - **An in-flight lock** per tool, so a double-click cannot start two
 *    `npm install -g` against the same package.
 *
 * ## Why NDJSON rather than JSON or SSE
 *
 * The Issue asks for the output to be **streamed**, and an install is the one
 * place where a user staring at a spinner genuinely wants to see npm talking. A
 * single JSON response cannot start until the child exits. SSE would work but
 * buys nothing here — there is no reconnect semantics to want, no event ids,
 * and the client is a `fetch` reader either way — while NDJSON keeps the
 * envelope identical to the JSON the rest of the API speaks.
 *
 * @module api/agents/update
 */

// Spawns a child process per request. Nothing about it may be prerendered.
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import {
  acquireAgentUpdateLock,
  isUpdatableAgentTool,
  releaseAgentUpdateLock,
  resolveAgentUpdatePlan,
  runAgentUpdate,
  UPDATABLE_AGENT_TOOLS,
  type UpdatableAgentTool,
} from '@/lib/updates/agent-updater';
import { clearAgentVersionsCache, getAgentVersions } from '@/lib/updates/agent-versions';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/agents/update');

/** One line of the NDJSON stream. */
export type AgentUpdateEvent =
  | {
      type: 'plan';
      tool: UpdatableAgentTool;
      strategy: 'native' | 'npm';
      /** Display form of the argv, e.g. `codex update`. Never executed. */
      command: string;
      installed: string | null;
    }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | {
      type: 'done';
      ok: boolean;
      exitCode: number | null;
      /** Version before the update, as probed at plan time. */
      previousVersion: string | null;
      /** Version after the update, re-probed with the cache bypassed. */
      installed: string | null;
      error?: string;
    };

/** Failure body for the non-streaming rejections (400 / 409 / 500). */
export interface AgentUpdateErrorResponse {
  status: 'error';
  code: 'invalid_tool' | 'no_executable' | 'in_progress' | 'internal';
  error: string;
}

/** Read the tool id out of the body without trusting any of it. */
async function readTool(request: NextRequest): Promise<unknown> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as { tool?: unknown }).tool;
}

/** Re-probe the tool after the update, cache bypassed. Null on any failure. */
async function probeAfterUpdate(tool: string): Promise<string | null> {
  try {
    clearAgentVersionsCache();
    const rows = await getAgentVersions({ force: true });
    return rows.find((row) => row.tool === tool)?.installed ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const tool = await readTool(request);

  if (!isUpdatableAgentTool(tool)) {
    return NextResponse.json(
      {
        status: 'error' as const,
        code: 'invalid_tool' as const,
        error: `"tool" must be one of: ${UPDATABLE_AGENT_TOOLS.join(', ')}`,
      },
      { status: 400 }
    );
  }

  const planned = await resolveAgentUpdatePlan(tool);
  if (!planned.ok) {
    return NextResponse.json(
      { status: 'error' as const, code: 'no_executable' as const, error: planned.message },
      { status: 400 }
    );
  }

  if (!acquireAgentUpdateLock(tool)) {
    return NextResponse.json(
      {
        status: 'error' as const,
        code: 'in_progress' as const,
        error: `An update for ${tool} is already running.`,
      },
      { status: 409 }
    );
  }

  const plan = planned.plan;
  logger.info('agent-update-started', {
    tool,
    strategy: plan.strategy,
    command: plan.display,
    installed: plan.installed ?? 'unknown',
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A client that navigated away must not turn into an unhandled throw from
      // inside the child's data listener: the install keeps going either way,
      // and the only thing lost is the transcript.
      let open = true;
      const write = (event: AgentUpdateEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      try {
        write({
          type: 'plan',
          tool,
          strategy: plan.strategy,
          command: plan.display,
          installed: plan.installed,
        });

        const result = await runAgentUpdate(plan, {
          onChunk: (chunk) => write({ type: 'output', ...chunk }),
        });

        const installed = result.ok ? await probeAfterUpdate(tool) : plan.installed;

        write({
          type: 'done',
          ok: result.ok,
          exitCode: result.exitCode,
          previousVersion: plan.installed,
          installed,
          ...(result.error ? { error: result.error } : {}),
        });

        logger.info('agent-update-finished', {
          tool,
          ok: String(result.ok),
          from: plan.installed ?? 'unknown',
          to: installed ?? 'unknown',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('agent-update-failed', { tool, error: message });
        write({
          type: 'done',
          ok: false,
          exitCode: null,
          previousVersion: plan.installed,
          installed: plan.installed,
          error: message,
        });
      } finally {
        releaseAgentUpdateLock(tool);
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Streaming through a reverse proxy that buffers would defeat the point.
      'X-Accel-Buffering': 'no',
    },
  });
}
