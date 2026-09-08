/**
 * API Route: the one-line note kept beside each of a worktree's sessions (#2427).
 *
 * `GET` — every note this worktree holds, keyed by instance id.
 * `PUT` — write (or clear) one instance's note.
 *
 * ## Why a route of its own rather than a field on the roster PATCH
 *
 * `PATCH /api/worktrees/[id]` posts the WHOLE roster and `setAgentInstances`
 * replaces it — every row deleted, every row re-inserted from the payload. A
 * note carried on that payload would therefore be a value every writer has to
 * echo back correctly or silently destroy, and the writers are the instance
 * pane, the drag-to-reorder handler and the alias editor: three places that care
 * about ids, order and aliases and have no business holding a memo. Issue #2427
 * asks for the narrow endpoint for exactly that reason, and the storage follows
 * it (`session_notes`, migration v61).
 *
 * ## What this route deliberately does not do
 *
 * It does not touch resolution. A note is not an alias — since Issue #2376
 * `--instance レビュー担当` finds a roster row through `agent_instances.alias`,
 * and `/resolve-target` reads the roster and nothing else. Writing a note here
 * cannot make `send`, `wait` or `capture` land anywhere new, which is the point
 * of a field the operator is expected to rewrite every time they hand the
 * session a new instruction.
 *
 * ## Why the roster still gates the write
 *
 * The same reason the opencode settings route checks it: an arbitrary id would
 * be stored, never read (nothing renders a note for a session that is not in the
 * roster), and would survive as a row nothing can explain. `pruneSessionNotes`
 * cleans up ids that LEAVE the roster; this stops ids that were never in it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  getSessionNotesByWorktree,
  setSessionNote,
  InvalidAgentInstanceError,
  SessionNoteTooLongError,
  MAX_SESSION_NOTE_LENGTH,
  type SessionNote,
} from '@/lib/db/agent-instances-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/instances/notes');

/**
 * `GET` body. Only the instances that HAVE a note appear — absence is how the
 * split header decides to render nothing, so an entry per roster row (which is
 * what the opencode settings route returns) would make every caller re-derive
 * emptiness from a value that is present.
 */
interface SessionNotesResponse {
  notes: Record<string, SessionNote>;
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

    const body: SessionNotesResponse = { notes: getSessionNotesByWorktree(db, id) };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-reading-session-notes', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read session notes' }, { status: 500 });
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
    // A missing `text` is a malformed request rather than a clear: clearing is
    // `text: ''`, and the difference matters because a client that forgot the
    // field would otherwise erase a note by asking nothing.
    if (typeof payload.text !== 'string') {
      return NextResponse.json({ error: 'text must be a string' }, { status: 400 });
    }

    const instance = resolveAgentInstances(db, id, worktree.selectedAgents).find(
      (entry) => entry.id === instanceId
    );
    if (!instance) {
      return NextResponse.json(
        { error: `Instance '${instanceId}' not found in this worktree` },
        { status: 404 }
      );
    }

    const note = setSessionNote(db, id, instanceId, payload.text);

    logger.info('session-note-updated', {
      worktreeId: id,
      instanceId,
      // The note itself is the operator's own words about their own work; the
      // length is what a log needs to explain a write.
      length: note ? note.text.length : 0,
      cleared: note === null,
    });

    return NextResponse.json({ instanceId, note }, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof SessionNoteTooLongError) {
      return NextResponse.json(
        { error: error.message, maxLength: MAX_SESSION_NOTE_LENGTH },
        { status: 400 }
      );
    }
    if (error instanceof InvalidAgentInstanceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error('error-writing-session-note', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to update session note' }, { status: 500 });
  }
}
