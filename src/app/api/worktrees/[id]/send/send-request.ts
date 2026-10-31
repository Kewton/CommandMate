/**
 * POST /api/worktrees/:id/send — the request body's validation and the
 * destination it resolves to (Issue #4055: split out of `handleSend`).
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import {
  resolveSessionTargetStrict,
  type SessionTarget,
} from '@/lib/session/resolve-session-target';
import { sessionTargetConflictResponse } from '@/lib/session/session-target-conflict-response';
import { respondAgentFor } from '@/lib/session/respond-target';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import {
  validateCopilotModelName,
  validateAntigravityModelName,
  validateClaudeModelName,
} from '@/lib/cmate-cli-tool-parser';

/** Supported CLI tool IDs - derived from CLI_TOOL_IDS (Issue #368: DRY) */
const VALID_CLI_TOOL_IDS: readonly CLIToolType[] = CLI_TOOL_IDS;

// Issue #2491: the route's own `DEFAULT_CLI_TOOL = 'claude'` is gone. The tail
// of the chain it spelled (`worktree.cliToolId || 'claude'`) is
// `resolveSessionTarget`'s worktree-default / fallback stages, and design §4 D5
// 決定 4 says that literal may be written in exactly one module.

export interface SendMessageRequest {
  content: string;
  cliToolId?: CLIToolType;  // Optional: override the worktree's default CLI tool
  instanceId?: string;  // Issue #868: agent instance ID (defaults to primary === cliToolId)
  imagePath?: string;  // Issue #474: relative path within .commandmate/attachments/
  model?: string;  // Issue #576/#989/#2771: AI model name for Copilot, Antigravity or Claude agent
  /**
   * Issue #1737: send even if only the agent's structured events report an open
   * dialog. The escape hatch for a hook-reported dialog nothing ever released —
   * a prompt the terminal scraper can see is still refused, because that one is
   * on screen and answerable.
   */
  ignoreStructuredPromptGuard?: boolean;
  /**
   * Issue #3957: the bound relay this send asks the question of. Reserved
   * before any side effect; a wrong id or destination is 400, a closed,
   * expired or already reserved relay 409, and neither types anything.
   */
  relayId?: string;
}

/**
 * One step of the send handler (Issue #4055): its value, or the answer the
 * handler returns as is. `response` may be a promise — an answer the step
 * did not await is handed back unawaited, as the handler used to return it.
 */
export type SendStep<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse | Promise<NextResponse> };

/** What {@link validateSendRequest} accepted and resolved (Issue #4055). */
export interface ValidatedSendRequest {
  trimmedContent: string;
  /** `body.cliToolId`, validated; undefined when the request named no tool. */
  requestedCliToolId: CLIToolType | undefined;
  /** `body.instanceId`, validated; undefined when the request named none. */
  instanceId: string | undefined;
  target: SessionTarget;
}

/**
 * Validate the body and resolve its destination, in the handler's order:
 * content, CLI tool, instance, the strict resolution, the model.
 */
export function validateSendRequest(
  db: Database.Database,
  id: string,
  body: SendMessageRequest,
): SendStep<ValidatedSendRequest> {
  const trimmedContent = typeof body.content === 'string' ? body.content.trim() : '';

  // Validate content
  if (trimmedContent === '') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Message content is required and must be a non-empty string' },
        { status: 400 }
      ),
    };
  }

  // Validate the requested CLI tool ID (DR4-002: fixed error text, no raw
  // input reflection) before it is used to resolve the instance.
  const requestedCliToolId = body.cliToolId || undefined;
  if (requestedCliToolId && !VALID_CLI_TOOL_IDS.includes(requestedCliToolId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Invalid CLI tool ID. Must be one of: ${VALID_CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      ),
    };
  }

  // Issue #868: Resolve the agent instance. When omitted, the primary instance
  // (instanceId === cliToolId) is used, preserving legacy single-session behavior.
  // The instance ID is embedded in tmux session names, so it must match the safe
  // identifier pattern to prevent command injection.
  if (body.instanceId !== undefined && !isValidInstanceId(body.instanceId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid instanceId. Must be an alphanumeric/underscore/hyphen identifier.' },
        { status: 400 }
      ),
    };
  }
  const instanceId = body.instanceId;

  // Issue #1629: the roster is what declares which CLI tool backs an instance.
  // Without this the tool came from the worktree default, so `--instance codex`
  // started Claude in a session named `mcbd-claude-<worktree>-codex`.
  //
  // Issue #1925 / #2491: resolution goes through the one shared resolver
  // (design §4 D5). This route was the last caller of the older
  // `resolveInstanceCliTool`, whose chain takes an explicit tool whenever the
  // roster has no row for the instance — so #2487's rule, that a tool-named
  // instance id declares its tool with or without a roster row (the #868
  // primary anchor), could not reach here. `POST /send {instanceId:
  // 'antigravity', cliToolId: 'command-code'}` therefore answered 201 and
  // started `mcbd-command-code-<wt>-antigravity`, a session nothing that names
  // the instance alone ever reads.
  //
  // Strict, like the other side-effect routes (`kill-session` / `terminal` /
  // `respond` / `auto-yes` POST, DR3-015): sending types into a session, and
  // with two contradicting declarations of which agent is meant, refusing is
  // the only answer that cannot land the message in the wrong pane.
  const resolution = resolveSessionTargetStrict(db, id, {
    instanceId,
    requestedCliTool: requestedCliToolId,
  });
  if (!resolution.ok) {
    return { ok: false, response: sessionTargetConflictResponse(resolution.conflict) };
  }

  // Which CLI tool to use (request/roster > primary anchor > worktree setting
  // > default). The resolver only ever answers with a CLIToolType — every
  // stage is guarded by `isCliToolType` — so the second `VALID_CLI_TOOL_IDS`
  // check this line used to carry had become unreachable. The one that still
  // matters is the check on `body.cliToolId` above, which runs on raw input.
  const cliToolId = resolution.target.cliToolId;

  const modelRefusal = validateSendModel(body.model, cliToolId);
  if (modelRefusal) return { ok: false, response: modelRefusal };

  return {
    ok: true,
    value: { trimmedContent, requestedCliToolId, instanceId, target: resolution.target },
  };
}

/**
 * The 400 for a `model` the resolved tool cannot take or a name it rejects;
 * null when there is no model or it is valid.
 */
export function validateSendModel(
  model: string | undefined,
  cliToolId: CLIToolType,
): NextResponse | null {
  // Issue #576/#588/#989: Validate model parameter via shared validator (DR1-003)
  //
  // Issue #2048 kept opencode OUT of this list on purpose, having measured
  // what including it would have to mean. opencode's model is a *launch* flag
  // (`-m provider/model`) and its variant is not a launch flag at all, so
  // `--model` on a send could only be honoured by restarting the pane or by
  // driving the TUI's own model picker — and that picker rewrites the
  // operator's **global default model**, the same trap `/model` is for Claude
  // (#1495). A per-instance setting is the channel instead
  // (`PUT /api/worktrees/:id/instances/opencode`), which is durable, visible,
  // and applies without touching anybody's defaults. Switching a *running*
  // opencode session is Issue #2046's question.
  //
  // Issue #2771 adds claude, on antigravity's terms rather than copilot's:
  // `claude --model` is a launch flag, and the in-session switch is the very
  // `/model` trap named above. So it is honoured when this send STARTS the
  // session and refused when the session is already running — see below.
  if (model) {
    // model is only supported for copilot, antigravity and claude
    if (cliToolId !== 'copilot' && cliToolId !== 'antigravity' && cliToolId !== 'claude') {
      return NextResponse.json(
        { error: 'The model parameter is only supported for copilot, antigravity and claude agents' },
        { status: 400 }
      );
    }
    const modelValidation = cliToolId === 'antigravity'
      ? validateAntigravityModelName(model)
      : cliToolId === 'claude'
        ? validateClaudeModelName(model)
        : validateCopilotModelName(model);
    if (!modelValidation.valid) {
      return NextResponse.json(
        { error: `Invalid model name: ${modelValidation.reason}` },
        { status: 400 }
      );
    }
  }
  return null;
}

/**
 * The tool a refusal's `respond` names (Issue #4049), for {@link respondAgentFor}.
 */
export function resolveRespondAgent(
  db: Database.Database,
  id: string,
  requestedCliToolId: CLIToolType | undefined,
  instanceId: string | undefined,
): CLIToolType | undefined {
  // Issue #4049: a refusal's `respond` must reach the tool this request named.
  // A bare `respond` resolves as a request naming nothing does, so the tool is
  // named only when the request named one (and no instance) and it is not that.
  const unqualified = requestedCliToolId && !instanceId ? resolveSessionTargetStrict(db, id, {}) : null;
  return respondAgentFor(
    requestedCliToolId,
    instanceId,
    unqualified?.ok ? unqualified.target.cliToolId : undefined,
  );
}
