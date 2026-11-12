/**
 * Migration v71: the hand-off of a session that ends (Issue #4227, design
 * `docs/design/mem-ui-4227.md` §4.3, G-PR2).
 *
 * `mem_handoff_requests`: one request to the agent of one instance to propose its mem
 * updates before a person stops it. It fixes, when made, the branch it belongs to
 * (repository, branch, detached), the worktree's and the instance's lifetimes and the
 * conversation (the D1 boundary id), and none of them changes after (trigger). The
 * state is decided when it is read; nothing runs in the background.
 *
 * `mem_handoff_proposals`: one operation on one item (add, an update or a close with
 * the version the agent saw). What it is about never changes after it is made
 * (trigger): a rebase changes only the base version, the revision, the fingerprint
 * and the state. `approved_fingerprint` is the content a person approved (the mark a
 * confirmation is checked against, PM P3-a).
 *
 * `target_worktree_id` is not named `worktree_id` (A §10.3): a request is a record of
 * how a session ended and outlives its worktree for its 14 days; it does not follow a
 * worktree's id rename and is not a child table.
 *
 * Not `mem_items`: nothing here writes an item (the items are written by mem's
 * service, `memWriteFromScreen`, alone).
 *
 * The rollback drops both tables, which forgets every hand-off record.
 */

import type { Migration } from './runner';

export const v71_migrations: Migration[] = [
  {
    version: 71,
    name: 'mem-handoff',
    up: (db) => {
      db.exec(`
        CREATE TABLE mem_handoff_requests (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          branch TEXT,
          detached INTEGER NOT NULL CHECK (detached IN (0, 1)),
          target_worktree_id TEXT NOT NULL,
          target_worktree_incarnation TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          instance_incarnation TEXT,
          instance_on_roster INTEGER NOT NULL CHECK (instance_on_roster IN (0, 1)),
          boundary_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN
            ('awaiting_agent','reviewing','applying','ending','ended','cancelled','expired')),
          send_state TEXT NOT NULL DEFAULT 'unsent' CHECK (send_state IN ('unsent','sent','failed')),
          apply_token TEXT,
          end_token TEXT,
          end_forced INTEGER NOT NULL DEFAULT 0 CHECK (end_forced IN (0, 1)),
          outcome TEXT CHECK (outcome IN ('confirmed','unconfirmed')),
          outcome_reason TEXT,
          agent_deadline_at INTEGER NOT NULL,
          extensions INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER NOT NULL,
          agent_done_at INTEGER,
          ended_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_mem_handoff_open ON mem_handoff_requests(target_worktree_id, instance_id)
          WHERE state IN ('awaiting_agent','reviewing','applying');
        CREATE INDEX idx_mem_handoff_requests_target ON mem_handoff_requests(target_worktree_id, instance_id, ended_at);

        CREATE TABLE mem_handoff_proposals (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES mem_handoff_requests(id) ON DELETE CASCADE,
          op TEXT NOT NULL CHECK (op IN ('add','update','close')),
          item_id TEXT,
          kind TEXT NOT NULL,
          base_version INTEGER,
          revision INTEGER NOT NULL DEFAULT 1,
          payload TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          author_instance_id TEXT NOT NULL,
          author_incarnation TEXT,
          state TEXT NOT NULL CHECK (state IN
            ('proposed','approved','applied','conflict','discarded','failed','expired')),
          state_reason TEXT,
          apply_token TEXT,
          approved_fingerprint TEXT,
          applied_item_id TEXT,
          applied_version INTEGER,
          checked_rules_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          decided_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_mem_handoff_proposals_request ON mem_handoff_proposals(request_id);

        CREATE TRIGGER mem_handoff_proposals_immutable
          BEFORE UPDATE OF request_id, op, item_id, kind, payload, author_instance_id, author_incarnation
          ON mem_handoff_proposals
          BEGIN SELECT RAISE(ABORT, 'mem_handoff_proposals: immutable column'); END;

        CREATE TRIGGER mem_handoff_requests_pinned
          BEFORE UPDATE OF repository_id, branch, detached, target_worktree_id, target_worktree_incarnation,
            instance_id, instance_incarnation, instance_on_roster, boundary_id
          ON mem_handoff_requests
          BEGIN SELECT RAISE(ABORT, 'mem_handoff_requests: pinned column'); END;

        CREATE TRIGGER mem_handoff_requests_forced_sticky
          BEFORE UPDATE OF end_forced ON mem_handoff_requests
          WHEN OLD.end_forced = 1 AND NEW.end_forced = 0
          BEGIN SELECT RAISE(ABORT, 'mem_handoff_requests: end_forced is sticky'); END;
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TRIGGER IF EXISTS mem_handoff_requests_forced_sticky;
        DROP TRIGGER IF EXISTS mem_handoff_requests_pinned;
        DROP TRIGGER IF EXISTS mem_handoff_proposals_immutable;
        DROP TABLE IF EXISTS mem_handoff_proposals;
        DROP TABLE IF EXISTS mem_handoff_requests;
      `);
    },
  },
];
