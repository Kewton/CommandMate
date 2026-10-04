/**
 * What every stage of the prompt-response route shares (Issue #3171).
 *
 * The route's POST ran every stage inline — validation, the structured
 * decision, the re-verification, the answer's resolution, the send and the
 * bookkeeping after it — and reached a complexity of 106. The stages now live
 * in this directory's modules, and this one holds what they all need: who is
 * being answered, how a stage hands back an early response, and the one log
 * line every refusal writes.
 *
 * @module app/api/worktrees/[id]/prompt-response/context
 */

import type { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

export const logger = createLogger('api/prompt-response');

/** The session being answered, resolved once the request is known to be valid. */
export interface PromptResponseContext {
  /** The canonical worktree id. */
  id: string;
  db: Database.Database;
  cliToolId: CLIToolType;
  /** Issue #868: undefined for the primary instance. */
  instanceId: string | undefined;
}

/**
 * A stage's outcome: either the response the route returns as it is (a
 * refusal, a 400, an answer already given) or the value the next stage needs.
 */
export type StageResult<T> = { response: NextResponse } | { value: T };

/** The log line every refusal on this route writes, with the stage's own evidence. */
export function logRefused(ctx: PromptResponseContext, fields: Record<string, unknown>): void {
  logger.info('prompt-response-refused', {
    worktreeId: ctx.id,
    cliToolId: ctx.cliToolId,
    instanceId: ctx.instanceId,
    ...fields,
  });
}
