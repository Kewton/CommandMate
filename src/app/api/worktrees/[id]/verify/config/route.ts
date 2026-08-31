/**
 * API Route: GET / POST /api/worktrees/:id/verify/config
 * The repository's declared verification gates (Issue #2061).
 *
 * Until this route existed the Verification pane could not tell "this
 * repository has not declared what passing means" from "nobody has verified
 * yet": both rendered as an empty run list, and the only way to find out was to
 * press Re-verify and read an English sentence out of a failed run's `config`
 * gate. The pane's four states — no config / declared but never run / running /
 * results — all hang off this read.
 *
 * GET is a read of `.commandmate/verify.yaml`. An invalid file answers 200 with
 * `exists: true` and `error` set, not 500: the file being there and being wrong
 * are different problems with different fixes, and the pane has to say which.
 *
 * POST drafts the file from the repository's own CI definitions
 * (`lib/verification/verify-draft.ts`, the same module `commandmate verify
 * init` calls) and **never overwrites** — an existing config answers 409.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
// Past the barrel, as `gate-runner` does: this selector answers "which task
// would a verification run adopt", which is exactly the question the planned
// gate list has to agree with.
import { getVerifiableTask } from '@/lib/db/tasks-db';
import { contractGateDefinitions } from '@/lib/tasks/contract-message';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import {
  VERIFY_CONFIG_RELATIVE_PATH,
  VerifyConfigError,
  defaultPlannedGateIds,
  loadVerifyConfig,
  type VerifyConfig,
} from '@/lib/verification/verify-config';
import { describeSource, writeVerifyConfigDraft } from '@/lib/verification/verify-draft';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import type {
  VerifyConfigGateView,
  VerifyConfigResponse,
} from '@/cli/types/api-responses';

const logger = createLogger('api/verify-config');

/**
 * Gate rows in wire shape.
 *
 * The optional keys become explicit `null`s. `mutex?: string` means "the file
 * did not declare one", which over JSON is indistinguishable from a key the
 * server forgot to send; a client reading `mutex === null` knows it was asked
 * and answered.
 */
function toGateViews(config: VerifyConfig): VerifyConfigGateView[] {
  return config.gates.map((gate) => ({
    id: gate.id,
    command: gate.command,
    timeoutSec: gate.timeoutSec,
    mutex: gate.mutex ?? null,
    retryOnFail: gate.retryOnFail ?? null,
    flakyIsPass: gate.flakyIsPass ?? null,
  }));
}

/** Resolve `:id` to a worktree, or the response that explains why not. */
async function resolveWorktree(
  params: Promise<{ id: string }>
): Promise<{ id: string; path: string } | NextResponse> {
  const { id: requested } = await params;
  const id = canonicalWorktreeId(requested);
  if (!isValidWorktreeId(id)) {
    return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
  }
  const worktree = getWorktreeById(getDbInstance(), id);
  if (!worktree) {
    return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
  }
  return { id, path: worktree.path };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveWorktree(params);
    if (resolved instanceof NextResponse) return resolved;

    const empty: VerifyConfigResponse = {
      exists: false,
      path: VERIFY_CONFIG_RELATIVE_PATH,
      gates: [],
      options: null,
      plannedGateIds: [],
      error: null,
    };

    let config: VerifyConfig | null;
    try {
      config = loadVerifyConfig(resolved.path);
    } catch (error) {
      // The file is there and unreadable. `exists: true` with the loader's own
      // message is the honest answer: telling the operator "declare your gates"
      // when the gates ARE declared, badly, sends them to write a second file.
      return NextResponse.json(
        {
          ...empty,
          exists: true,
          error:
            error instanceof VerifyConfigError ? error.message : (error as Error).message,
        } satisfies VerifyConfigResponse,
        { status: 200 }
      );
    }

    if (!config) return NextResponse.json(empty, { status: 200 });

    // Issue #2063: the plan has to include the gates the worktree's contract
    // carries (#1791), because a default run executes those too. Resolved with
    // the same selector the runner uses, so the list the pane shows is the list
    // that would actually run rather than verify.yaml's half of it.
    const task = getVerifiableTask(getDbInstance(), resolved.id);
    const contractGates = task ? contractGateDefinitions(task.contract) : [];

    return NextResponse.json(
      {
        exists: true,
        path: VERIFY_CONFIG_RELATIVE_PATH,
        gates: toGateViews(config),
        options: config.options,
        plannedGateIds: defaultPlannedGateIds(config, contractGates),
        error: null,
      } satisfies VerifyConfigResponse,
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-reading-verify-config:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read the verification config' }, { status: 500 });
  }
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveWorktree(params);
    if (resolved instanceof NextResponse) return resolved;

    const result = writeVerifyConfigDraft(resolved.path);

    if (result.refusedBecause === 'exists') {
      return NextResponse.json(
        {
          error: `${VERIFY_CONFIG_RELATIVE_PATH} already exists; verification gates are never overwritten.`,
          exists: true,
        },
        { status: 409 }
      );
    }
    if (result.refusedBecause === 'no-gates') {
      // 422 rather than 500: nothing failed. The repository simply declares no
      // CI job and no npm script this drafter is willing to turn into a gate,
      // and the operator's next move is to write the file by hand.
      return NextResponse.json(
        {
          error:
            'No verification gates could be drafted: no CI workflow step or package.json script was usable.',
          scanned: result.draft.scanned,
        },
        { status: 422 }
      );
    }

    return NextResponse.json(
      {
        created: true,
        path: result.relativePath,
        gates: result.draft.gates.map((gate) => ({
          id: gate.id,
          command: gate.command,
          timeoutSec: gate.timeoutSec,
          mutex: null,
          retryOnFail: null,
          flakyIsPass: null,
        })),
        excluded: result.draft.excluded.map((item) => ({
          command: item.command,
          reason: item.reason,
          source: describeSource(item.source),
        })),
        scanned: result.draft.scanned,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    logger.error('error-drafting-verify-config:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to draft the verification config' }, { status: 500 });
  }
}
