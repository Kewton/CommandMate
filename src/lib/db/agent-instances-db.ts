/**
 * Agent instances database operations (Issue #868).
 *
 * CRUD for the `agent_instances` table, which holds the explicit per-worktree
 * roster of agent instances. Each instance has a stable `(worktree_id,
 * instance_id)` identity. The PRIMARY instance of a CLI tool uses
 * `instance_id === cli_tool_id`, keeping session names / poller keys / DB rows
 * identical to the pre-#868 single-session behavior.
 *
 * Cap: a worktree may hold at most MAX_AGENT_INSTANCES instances; attempts to
 * exceed it throw AgentInstanceLimitError.
 */

import Database from 'better-sqlite3';
import {
  EMPTY_OPENCODE_INSTANCE_SETTINGS,
  hasOpencodeInstanceSettings,
  normalizeOpencodeInstanceSettings,
  type OpencodeInstanceSettings,
} from '@/types/opencode-instance-settings';
import {
  type AgentInstance,
  type CLIToolType,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
  isValidInstanceId,
  isCliToolType,
  getCliToolDisplayName,
} from '@/lib/cli-tools/types';

/**
 * Thrown when an operation would exceed MAX_AGENT_INSTANCES for a worktree.
 */
export class AgentInstanceLimitError extends Error {
  constructor(worktreeId: string, limit: number = MAX_AGENT_INSTANCES) {
    super(`Worktree ${worktreeId} cannot have more than ${limit} agent instances`);
    this.name = 'AgentInstanceLimitError';
  }
}

/**
 * Thrown when an instance definition fails validation (bad id, tool, or alias).
 */
export class InvalidAgentInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentInstanceError';
  }
}

interface AgentInstanceRow {
  worktree_id: string;
  instance_id: string;
  cli_tool_id: string;
  alias: string;
  sort_order: number;
  created_at: number;
}

/**
 * Map a DB row to an AgentInstance. When the stored alias is empty, fall back to
 * the CLI tool's display name so consumers always get a non-empty label.
 */
function mapAgentInstance(row: AgentInstanceRow): AgentInstance {
  const cliTool = row.cli_tool_id as CLIToolType;
  const alias = row.alias && row.alias.length > 0
    ? row.alias
    : (isCliToolType(row.cli_tool_id) ? getCliToolDisplayName(cliTool) : row.cli_tool_id);
  return {
    id: row.instance_id,
    cliTool,
    alias,
    order: row.sort_order,
  };
}

/**
 * Validate a single instance definition before persisting.
 * @throws InvalidAgentInstanceError when the id/tool/alias are not acceptable
 */
function validateInstance(instance: AgentInstance): void {
  if (!isValidInstanceId(instance.id)) {
    throw new InvalidAgentInstanceError(`Invalid instance id: ${String(instance.id)}`);
  }
  if (!isCliToolType(instance.cliTool)) {
    throw new InvalidAgentInstanceError(`Invalid CLI tool: ${String(instance.cliTool)}`);
  }
  if (typeof instance.alias === 'string' && instance.alias.length > MAX_AGENT_ALIAS_LENGTH) {
    throw new InvalidAgentInstanceError(
      `Alias exceeds ${MAX_AGENT_ALIAS_LENGTH} characters`
    );
  }
}

/**
 * Get all agent instances for a worktree, ordered by sort_order.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @returns Ordered list of agent instances (empty when none are configured)
 */
export function getAgentInstances(
  db: Database.Database,
  worktreeId: string
): AgentInstance[] {
  const rows = db.prepare(`
    SELECT worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at
    FROM agent_instances
    WHERE worktree_id = ?
    ORDER BY sort_order ASC, instance_id ASC
  `).all(worktreeId) as AgentInstanceRow[];

  return rows.map(mapAgentInstance);
}

/**
 * Get a single agent instance by id.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Instance ID
 * @returns The instance, or null when it does not exist
 */
export function getAgentInstance(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): AgentInstance | null {
  const row = db.prepare(`
    SELECT worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at
    FROM agent_instances
    WHERE worktree_id = ? AND instance_id = ?
  `).get(worktreeId, instanceId) as AgentInstanceRow | undefined;

  return row ? mapAgentInstance(row) : null;
}

/**
 * Outcome of {@link resolveInstanceCliTool}.
 *
 * `cliToolId: null` means the request carried no signal about which CLI tool
 * backs the instance; the caller applies its own default (worktree setting,
 * then 'claude').
 */
export type InstanceCliToolResolution =
  | { ok: true; cliToolId: CLIToolType | null }
  | {
      ok: false;
      instanceId: string;
      rosterCliTool: CLIToolType;
      requestedCliTool: CLIToolType;
    };

/**
 * Resolve which CLI tool backs a targeted agent instance (Issue #1629).
 *
 * The CLI tool id is part of the tmux session name, so getting it wrong starts
 * (or looks for) the wrong agent under a session name that claims otherwise:
 * `--instance codex` used to start Claude in `mcbd-claude-<wt>-codex`.
 *
 * Resolution order:
 *   1. the roster entry for `instanceId` — the roster is what declares that
 *      `codex` is a codex instance, so it wins over the worktree default
 *   2. `requestedCliTool`, for an instance the roster does not know about
 *      (the ad-hoc `send --instance <new-id>` / `--register` flow)
 *   3. `instanceId` when it is itself a CLI tool id — that is how the primary
 *      instance is anchored (Issue #868), and holds without a roster row
 *   4. no signal (`cliToolId: null`) — the caller falls back to its default
 *
 * An explicit `requestedCliTool` that contradicts the roster is reported as a
 * conflict rather than silently overriding it: the roster is user-maintained
 * and a mismatch means one of the two is wrong. Callers surface it as an error.
 *
 * @deprecated Issue #1925 made `resolveSessionTarget`
 * (`src/lib/session/resolve-session-target.ts`) the one authority, and Issue
 * #2491 moved the last two callers — `POST /send` and `resolveRelaySession` —
 * onto it. **Do not give this function a new caller.** Step 2 above is exactly
 * what #2487 corrected: with no roster row it takes `requestedCliTool` even
 * when `instanceId` itself names a different tool, so a caller wired here gets
 * `mcbd-<requested>-<wt>-<tool-named-id>` back instead of a conflict. It is
 * kept only because its #1629 unit test
 * (`tests/unit/db/agent-instances-resolve-cli-tool.test.ts`) still pins that
 * behaviour; removing both is a separate change.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Targeted agent instance ID (omitted for the primary instance)
 * @param requestedCliTool - CLI tool explicitly named by the caller, if any
 */
export function resolveInstanceCliTool(
  db: Database.Database,
  worktreeId: string,
  instanceId: string | undefined,
  requestedCliTool?: CLIToolType
): InstanceCliToolResolution {
  if (!instanceId) {
    return { ok: true, cliToolId: requestedCliTool ?? null };
  }

  const registered = getAgentInstance(db, worktreeId, instanceId);
  if (registered && isCliToolType(registered.cliTool)) {
    if (requestedCliTool && requestedCliTool !== registered.cliTool) {
      return {
        ok: false,
        instanceId,
        rosterCliTool: registered.cliTool,
        requestedCliTool,
      };
    }
    return { ok: true, cliToolId: registered.cliTool };
  }

  // Not registered: an instance id that names a CLI tool is that tool's primary
  // instance by definition, which outranks the worktree default but not an
  // explicit request.
  if (requestedCliTool) {
    return { ok: true, cliToolId: requestedCliTool };
  }
  if (isCliToolType(instanceId)) {
    return { ok: true, cliToolId: instanceId };
  }
  return { ok: true, cliToolId: null };
}

/**
 * Count agent instances for a worktree.
 */
export function countAgentInstances(
  db: Database.Database,
  worktreeId: string
): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM agent_instances WHERE worktree_id = ?
  `).get(worktreeId) as { count: number };
  return row.count;
}

/**
 * Replace the full set of agent instances for a worktree (transactional).
 *
 * Enforces MAX_AGENT_INSTANCES and validates every instance before writing.
 * The empty alias is stored as '' so reads can fall back to the tool display
 * name; sort_order is taken from each instance's `order`.
 *
 * @throws AgentInstanceLimitError when instances.length > MAX_AGENT_INSTANCES
 * @throws InvalidAgentInstanceError when any instance is invalid
 */
export function setAgentInstances(
  db: Database.Database,
  worktreeId: string,
  instances: AgentInstance[]
): void {
  if (instances.length > MAX_AGENT_INSTANCES) {
    throw new AgentInstanceLimitError(worktreeId);
  }

  const seen = new Set<string>();
  for (const instance of instances) {
    validateInstance(instance);
    if (seen.has(instance.id)) {
      throw new InvalidAgentInstanceError(`Duplicate instance id: ${instance.id}`);
    }
    seen.add(instance.id);
  }

  const now = Date.now();
  const replace = db.transaction(() => {
    db.prepare(`DELETE FROM agent_instances WHERE worktree_id = ?`).run(worktreeId);
    // Issue #2048: the settings table is keyed on an instance id and this write
    // is a full replace, so an instance dropped from the roster would otherwise
    // leave its opencode settings behind for whoever next claimed that id.
    pruneOpencodeInstanceSettings(db, worktreeId, instances.map((instance) => instance.id));
    // Issue #2427: the same rule for the session notes, and the same rule read
    // the other way round — this prunes only the ids that LEFT the roster, so
    // the note of every surviving instance outlives the delete/re-insert that
    // renaming an alias or reordering the list performs. That survival is the
    // Issue's third acceptance condition; a mutation that drops this call makes
    // the note of a *removed* instance haunt the next instance to claim its id.
    pruneSessionNotes(db, worktreeId, instances.map((instance) => instance.id));
    const insertStmt = db.prepare(`
      INSERT INTO agent_instances
        (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    instances.forEach((instance, index) => {
      const alias = instance.alias ?? '';
      const order = Number.isInteger(instance.order) ? instance.order : index;
      insertStmt.run(worktreeId, instance.id, instance.cliTool, alias, order, now);
    });
  });
  replace();
}

/**
 * Add a single agent instance to a worktree.
 *
 * @throws AgentInstanceLimitError when adding would exceed MAX_AGENT_INSTANCES
 * @throws InvalidAgentInstanceError when the instance id already exists or is invalid
 */
export function addAgentInstance(
  db: Database.Database,
  worktreeId: string,
  instance: AgentInstance
): void {
  validateInstance(instance);

  const add = db.transaction(() => {
    const count = countAgentInstances(db, worktreeId);
    if (count >= MAX_AGENT_INSTANCES) {
      throw new AgentInstanceLimitError(worktreeId);
    }

    const existing = getAgentInstance(db, worktreeId, instance.id);
    if (existing) {
      throw new InvalidAgentInstanceError(
        `Instance ${instance.id} already exists for worktree ${worktreeId}`
      );
    }

    const order = Number.isInteger(instance.order) ? instance.order : count;
    db.prepare(`
      INSERT INTO agent_instances
        (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(worktreeId, instance.id, instance.cliTool, instance.alias ?? '', order, Date.now());
  });
  add();
}

/**
 * Remove a single agent instance from a worktree.
 *
 * @returns true when a row was deleted
 */
export function removeAgentInstance(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): boolean {
  const result = db.prepare(`
    DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?
  `).run(worktreeId, instanceId);
  // Issue #2048: same rule as the replace above — the instance is gone, so what
  // it was configured to launch opencode with is gone with it.
  db.prepare(`
    DELETE FROM opencode_instance_settings WHERE worktree_id = ? AND instance_id = ?
  `).run(worktreeId, instanceId);
  // Issue #2427: and the memo written about it. A note names a session; the
  // session is gone.
  db.prepare(`
    DELETE FROM session_notes WHERE worktree_id = ? AND instance_id = ?
  `).run(worktreeId, instanceId);
  return result.changes > 0;
}

// ============================================================================
// opencode launch settings (Issue #2048). Appended at the end of the file on
// purpose: everything below is additive and touches no export above it, so the
// roster CRUD's behaviour — and the `agentInstances` API contract that rests on
// it — is unchanged.
// ============================================================================

/** One row of `opencode_instance_settings`. */
interface OpencodeInstanceSettingsRow {
  agent: string | null;
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
}

/**
 * What this instance should launch and prompt opencode with (Issue #2048).
 *
 * Answers the all-unset settings for an instance with no row, which is every
 * instance until the settings pane writes one — and for an instance backed by
 * any other CLI tool, which never gets a row at all. The stored values are
 * re-validated on the way out rather than trusted: the row may have been written
 * by a build with a wider pattern, and the `agent` / `provider_id` / `model_id`
 * columns end up on a **shell command line**.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Instance ID (the primary instance uses the CLI tool id)
 */
export function getOpencodeInstanceSettings(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): OpencodeInstanceSettings {
  const row = db.prepare(`
    SELECT agent, provider_id, model_id, variant
    FROM opencode_instance_settings
    WHERE worktree_id = ? AND instance_id = ?
  `).get(worktreeId, instanceId) as OpencodeInstanceSettingsRow | undefined;

  if (!row) return { ...EMPTY_OPENCODE_INSTANCE_SETTINGS };
  return normalizeOpencodeInstanceSettings({
    agent: row.agent,
    providerId: row.provider_id,
    modelId: row.model_id,
    variant: row.variant,
  });
}

/**
 * Every opencode setting stored for a worktree, keyed by instance id.
 *
 * One statement rather than one per roster entry: the settings pane asks for the
 * whole worktree at once, and an instance with no row is simply absent from the
 * result — callers fill it with {@link EMPTY_OPENCODE_INSTANCE_SETTINGS}.
 */
export function getOpencodeInstanceSettingsByWorktree(
  db: Database.Database,
  worktreeId: string
): Record<string, OpencodeInstanceSettings> {
  const rows = db.prepare(`
    SELECT instance_id, agent, provider_id, model_id, variant
    FROM opencode_instance_settings
    WHERE worktree_id = ?
  `).all(worktreeId) as Array<OpencodeInstanceSettingsRow & { instance_id: string }>;

  const settings: Record<string, OpencodeInstanceSettings> = {};
  for (const row of rows) {
    settings[row.instance_id] = normalizeOpencodeInstanceSettings({
      agent: row.agent,
      providerId: row.provider_id,
      modelId: row.model_id,
      variant: row.variant,
    });
  }
  return settings;
}

/**
 * Write one instance's opencode settings.
 *
 * Validated before the write as well as after the read — a value that would not
 * survive {@link normalizeOpencodeInstanceSettings} is stored as null rather
 * than kept, so nothing unusable ever reaches the launcher even if a later build
 * loosens the reader.
 *
 * An all-unset write **deletes the row** instead of storing four nulls. The two
 * states are indistinguishable to every reader, and the delete keeps the table
 * to the instances somebody actually configured.
 *
 * @throws InvalidAgentInstanceError when the instance id is not a valid one
 */
export function setOpencodeInstanceSettings(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  settings: OpencodeInstanceSettings,
  at: number = Date.now()
): OpencodeInstanceSettings {
  if (!isValidInstanceId(instanceId)) {
    throw new InvalidAgentInstanceError(`Invalid instance id: ${String(instanceId)}`);
  }
  const normalized = normalizeOpencodeInstanceSettings(settings);

  if (!hasOpencodeInstanceSettings(normalized)) {
    db.prepare(`
      DELETE FROM opencode_instance_settings WHERE worktree_id = ? AND instance_id = ?
    `).run(worktreeId, instanceId);
    return normalized;
  }

  db.prepare(`
    INSERT INTO opencode_instance_settings
      (worktree_id, instance_id, agent, provider_id, model_id, variant, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
      agent = excluded.agent,
      provider_id = excluded.provider_id,
      model_id = excluded.model_id,
      variant = excluded.variant,
      updated_at = excluded.updated_at
  `).run(
    worktreeId,
    instanceId,
    normalized.agent,
    normalized.providerId,
    normalized.modelId,
    normalized.variant,
    at
  );
  return normalized;
}

/**
 * Drop the settings of instances that are no longer in the roster.
 *
 * Called by {@link setAgentInstances} and {@link removeAgentInstance}, because
 * `opencode_instance_settings` is keyed on an instance id and nothing else would
 * ever remove a row for an instance the operator deleted. Re-adding an instance
 * under the same id therefore starts from opencode's defaults rather than
 * inheriting a setting from a roster entry that no longer exists.
 *
 * @param keepInstanceIds - The ids that survive; every other row is deleted
 * @returns How many rows were removed
 */
export function pruneOpencodeInstanceSettings(
  db: Database.Database,
  worktreeId: string,
  keepInstanceIds: readonly string[]
): number {
  if (keepInstanceIds.length === 0) {
    return db.prepare(`
      DELETE FROM opencode_instance_settings WHERE worktree_id = ?
    `).run(worktreeId).changes;
  }
  const placeholders = keepInstanceIds.map(() => '?').join(', ');
  return db.prepare(`
    DELETE FROM opencode_instance_settings
    WHERE worktree_id = ? AND instance_id NOT IN (${placeholders})
  `).run(worktreeId, ...keepInstanceIds).changes;
}

// ============================================================================
// Session notes (Issue #2427). Appended after the opencode block for the same
// reason that one was appended after the roster CRUD: everything below is
// additive and touches no export above it, so `AgentInstance` — which is the
// roster PATCH's INPUT shape as much as its output — is unchanged, and so is
// every resolution path that reads it.
//
// A note is a memo a human reads. It is NOT an alias: since Issue #2376
// `--instance レビュー担当` resolves through `agent_instances.alias`, so an alias
// decides where a `send` lands. Nothing in this section is read by
// `resolveInstanceCliTool` or by `/resolve-target`, and that is the whole reason
// the two are stored apart.
// ============================================================================

/**
 * Longest note this server will store, in code points (Issue #2427).
 *
 * One line beside a session title, so the bound is about what can be READ in a
 * split header rather than about storage. Code points rather than UTF-16 units
 * because the operator counts characters: an emoji is one character to whoever
 * typed it and two to `String.prototype.length`, and a limit that charges two
 * for one is a limit that cannot be explained.
 *
 * The client mirrors it as the input's `maxLength` (`SESSION_NOTE_MAX_LENGTH` in
 * `TerminalSplitPane`), which is a convenience; THIS is the enforcement, because
 * the route is reachable without the UI.
 */
export const MAX_SESSION_NOTE_LENGTH = 100;

/**
 * One session's note (Issue #2427).
 *
 * `text` is never empty: clearing a note deletes its row, so "no note" is
 * absence rather than an empty string — see {@link setSessionNote}.
 */
export interface SessionNote {
  /** The note itself, normalized to a single line. */
  text: string;
  /** Epoch ms the note was last written; rendered beside it. */
  updatedAt: number;
}

/** Thrown when a note is longer than {@link MAX_SESSION_NOTE_LENGTH}. */
export class SessionNoteTooLongError extends Error {
  constructor(limit: number = MAX_SESSION_NOTE_LENGTH) {
    super(`Session note exceeds ${limit} characters`);
    this.name = 'SessionNoteTooLongError';
  }
}

/** One row of `session_notes`. */
interface SessionNoteRow {
  instance_id: string;
  note: string;
  updated_at: number;
}

/** Below this code point (plus DEL) a character cannot be typed into a memo. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;
const DELETE_CODE_POINT = 0x7f;

/**
 * Fold a submitted note into the one line that is actually stored.
 *
 * Control characters — a pasted newline above all, which is how a multi-line
 * clipboard reaches a one-line input — become spaces rather than being rejected:
 * the operator pasting two lines of a commit message means the text, not the
 * line break, and a refusal there would read as a bug. Runs of whitespace
 * collapse and the ends are trimmed, so the stored value is what the header will
 * render, and the length limit is measured against that rather than against
 * padding.
 *
 * Iterating code points rather than matching a control-character class keeps the
 * repository's own `scripts/check-control-chars.mjs` discipline — the escape
 * sequence for a control character is still a control character to a reviewer
 * skimming the line — and gets surrogate pairs right for free.
 *
 * Returns `''` for anything that folds away to nothing, which is the caller's
 * signal to DELETE rather than to store.
 */
export function normalizeSessionNoteText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let folded = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    folded += code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT ? ' ' : char;
  }
  return folded.replace(/\s+/g, ' ').trim();
}

/** How long a normalized note is, counted the way the limit is defined. */
export function sessionNoteLength(text: string): number {
  return Array.from(text).length;
}

/**
 * The note kept beside one session, or null when there is none.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Instance ID (the primary instance uses the CLI tool id)
 */
export function getSessionNote(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): SessionNote | null {
  const row = db.prepare(`
    SELECT instance_id, note, updated_at
    FROM session_notes
    WHERE worktree_id = ? AND instance_id = ?
  `).get(worktreeId, instanceId) as SessionNoteRow | undefined;

  return row ? { text: row.note, updatedAt: row.updated_at } : null;
}

/**
 * Every note kept for a worktree, keyed by instance id.
 *
 * One statement rather than one per roster entry: the split header asks for the
 * whole worktree at once, and an instance with no row is simply absent from the
 * result — which is also how the UI decides to render nothing.
 */
export function getSessionNotesByWorktree(
  db: Database.Database,
  worktreeId: string
): Record<string, SessionNote> {
  const rows = db.prepare(`
    SELECT instance_id, note, updated_at
    FROM session_notes
    WHERE worktree_id = ?
  `).all(worktreeId) as SessionNoteRow[];

  const notes: Record<string, SessionNote> = {};
  for (const row of rows) {
    notes[row.instance_id] = { text: row.note, updatedAt: row.updated_at };
  }
  return notes;
}

/**
 * Every note on the server, grouped by worktree id then instance id.
 *
 * `GET /api/worktrees` composes one payload for every worktree at once and is
 * polled by every open client, so it reads this table ONCE rather than issuing a
 * point query per row of the list. The whole table is a handful of rows per
 * worktree by construction (at most `MAX_AGENT_INSTANCES`, and only for the
 * sessions somebody annotated), so grouping in JS costs less than the round
 * trips it replaces — and it is immune to SQLite's bound-parameter ceiling,
 * which an `IN (...)` over every worktree id would not be.
 */
export function getAllSessionNotes(
  db: Database.Database
): Record<string, Record<string, SessionNote>> {
  const rows = db.prepare(`
    SELECT worktree_id, instance_id, note, updated_at
    FROM session_notes
  `).all() as Array<SessionNoteRow & { worktree_id: string }>;

  const byWorktree: Record<string, Record<string, SessionNote>> = {};
  for (const row of rows) {
    const notes = byWorktree[row.worktree_id] ?? (byWorktree[row.worktree_id] = {});
    notes[row.instance_id] = { text: row.note, updatedAt: row.updated_at };
  }
  return byWorktree;
}

/**
 * Write one session's note, or clear it.
 *
 * A note that normalizes to nothing DELETES the row instead of storing `''`, for
 * the reason {@link setOpencodeInstanceSettings} deletes an all-unset write: the
 * two states are indistinguishable to every reader, and absence is what lets the
 * split header render nothing at all rather than an empty chip.
 *
 * @param at - Epoch ms recorded as the note's time; injectable so a test can
 *   assert the displayed timestamp without racing the clock
 * @returns The stored note, or null when the note was cleared
 * @throws InvalidAgentInstanceError when the instance id is not a valid one
 * @throws SessionNoteTooLongError when the note is over the limit
 */
export function setSessionNote(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  text: unknown,
  at: number = Date.now()
): SessionNote | null {
  if (!isValidInstanceId(instanceId)) {
    throw new InvalidAgentInstanceError(`Invalid instance id: ${String(instanceId)}`);
  }
  const normalized = normalizeSessionNoteText(text);
  if (sessionNoteLength(normalized) > MAX_SESSION_NOTE_LENGTH) {
    throw new SessionNoteTooLongError();
  }

  if (normalized.length === 0) {
    db.prepare(`
      DELETE FROM session_notes WHERE worktree_id = ? AND instance_id = ?
    `).run(worktreeId, instanceId);
    return null;
  }

  db.prepare(`
    INSERT INTO session_notes (worktree_id, instance_id, note, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(worktreeId, instanceId, normalized, at);

  return { text: normalized, updatedAt: at };
}

/**
 * Drop the notes of instances that are no longer in the roster.
 *
 * Called by {@link setAgentInstances} and {@link removeAgentInstance} for the
 * reason {@link pruneOpencodeInstanceSettings} is: `session_notes` is keyed on an
 * instance id and nothing else would ever remove a row for an instance the
 * operator deleted, so re-adding an instance under the same id would inherit a
 * memo written about a session that no longer exists as if it were its own.
 *
 * The counterpart matters just as much: this prunes the ids that are GONE and
 * leaves every surviving id alone, which is what makes a note survive the roster
 * replace that an alias edit performs.
 *
 * @param keepInstanceIds - The ids that survive; every other row is deleted
 * @returns How many rows were removed
 */
export function pruneSessionNotes(
  db: Database.Database,
  worktreeId: string,
  keepInstanceIds: readonly string[]
): number {
  if (keepInstanceIds.length === 0) {
    return db.prepare(`
      DELETE FROM session_notes WHERE worktree_id = ?
    `).run(worktreeId).changes;
  }
  const placeholders = keepInstanceIds.map(() => '?').join(', ');
  return db.prepare(`
    DELETE FROM session_notes
    WHERE worktree_id = ? AND instance_id NOT IN (${placeholders})
  `).run(worktreeId, ...keepInstanceIds).changes;
}
