/**
 * Role tables (Issue #4114, migration v64).
 *
 * Every write that could leave a reference half done runs in a transaction. The
 * body is never logged and never placed in an error message.
 *
 * @module lib/db/agent-roles-db
 */
import { randomBytes, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { computeBodyFingerprint } from '@/lib/agent-roles/fingerprint';
import { normalizeRoleName, roleBodyProblem } from '@/lib/agent-roles/validation';
import type {
  AgentRoleDetail,
  AgentRoleReferences,
  NoRoleReason,
  RoleAssignmentInput,
  RoleLaunchPhase,
  RoleLaunchRecord,
  RoleLaunchSnapshotInput,
  RoleResolutionSource,
  StoredRoleState,
} from '@/types/agent-roles';

/** A role with its body and derived fields. */
export type AgentRole = AgentRoleDetail;

export class AgentRoleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRoleValidationError';
  }
}

export class AgentRoleNotFoundError extends Error {
  constructor(public readonly roleId: string) {
    super(`Role not found: ${roleId}`);
    this.name = 'AgentRoleNotFoundError';
  }
}

export class AgentRoleNameConflictError extends Error {
  constructor(name: string) {
    super(`A role named "${name}" already exists`);
    this.name = 'AgentRoleNameConflictError';
  }
}

export class AgentRoleVersionConflictError extends Error {
  constructor(public readonly currentBodyVersion: number) {
    super(`The role is at body version ${currentBodyVersion}`);
    this.name = 'AgentRoleVersionConflictError';
  }
}

export class AgentRoleNameChangedError extends Error {
  constructor(public readonly currentName: string) {
    super('The role was renamed since it was read');
    this.name = 'AgentRoleNameChangedError';
  }
}

export class AgentRoleInUseError extends Error {
  constructor(public readonly references: AgentRoleReferences) {
    super('The role is in use');
    this.name = 'AgentRoleInUseError';
  }
}

interface AgentRoleRow {
  id: string;
  name: string;
  body: string;
  body_version: number;
  created_at: number;
  updated_at: number;
}

function mapRole(row: AgentRoleRow): AgentRole {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    bodyVersion: row.body_version,
    bodyFingerprint: computeBodyFingerprint(row.body),
    bodyBytes: Buffer.byteLength(row.body, 'utf8'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueNameViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: agent_roles.name');
}

function validatedName(name: unknown): string {
  const normalized = normalizeRoleName(name);
  if (!normalized.ok) throw new AgentRoleValidationError(normalized.problem);
  return normalized.name;
}

function assertBody(body: unknown): asserts body is string {
  const problem = roleBodyProblem(body);
  if (problem) throw new AgentRoleValidationError(problem);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Every role, by name. */
export function listAgentRoles(db: Database.Database): AgentRole[] {
  const rows = db.prepare('SELECT * FROM agent_roles ORDER BY name ASC').all() as AgentRoleRow[];
  return rows.map(mapRole);
}

export function getAgentRole(db: Database.Database, id: string): AgentRole | null {
  const row = db.prepare('SELECT * FROM agent_roles WHERE id = ?').get(id) as AgentRoleRow | undefined;
  return row ? mapRole(row) : null;
}

/**
 * @throws {AgentRoleValidationError} The name or body is not acceptable
 * @throws {AgentRoleNameConflictError} The name is taken
 */
export function createAgentRole(db: Database.Database, input: { name: unknown; body: unknown }): AgentRole {
  const name = validatedName(input.name);
  assertBody(input.body);
  // Short and hex: it becomes part of a generated file name.
  const id = randomBytes(8).toString('hex');
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO agent_roles (id, name, body, body_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`
    ).run(id, name, input.body, now, now);
  } catch (error) {
    if (isUniqueNameViolation(error)) throw new AgentRoleNameConflictError(name);
    throw error;
  }
  return getAgentRole(db, id) as AgentRole;
}

/** What points directly at this role. */
export function getAgentRoleReferences(db: Database.Database, roleId: string): AgentRoleReferences {
  const instances = db
    .prepare(
      `SELECT worktree_id AS worktreeId, instance_id AS instanceId FROM agent_instance_roles
       WHERE role_id = ? ORDER BY worktree_id, instance_id`
    )
    .all(roleId) as AgentRoleReferences['instances'];
  const repositories = db
    .prepare(
      `SELECT d.repository_id AS repositoryId, r.path AS repositoryPath, d.cli_tool_id AS cliToolId
       FROM agent_role_repository_defaults d JOIN repositories r ON r.id = d.repository_id
       WHERE d.role_id = ? ORDER BY r.path, d.cli_tool_id`
    )
    .all(roleId) as AgentRoleReferences['repositories'];
  const system = db
    .prepare(
      `SELECT cli_tool_id AS cliToolId FROM agent_role_system_defaults WHERE role_id = ? ORDER BY cli_tool_id`
    )
    .all(roleId) as AgentRoleReferences['system'];
  return { instances, repositories, system };
}

export interface AgentRoleEditResult {
  before: AgentRole;
  after: AgentRole;
  affected: AgentRoleReferences;
}

/**
 * Edit a role. The body version moves only when the bytes change, so a rename is
 * not a new version of the text.
 *
 * @param input.expectedBodyVersion - When given, the edit applies only at this version
 * @param input.expectedName - When given, the edit applies only under this name, or
 *   when the role already has the name asked for
 * @throws {AgentRoleNotFoundError}
 * @throws {AgentRoleVersionConflictError} Someone else got there first; nothing changed
 * @throws {AgentRoleNameChangedError} Someone else renamed it first; nothing changed
 * @throws {AgentRoleValidationError}
 * @throws {AgentRoleNameConflictError}
 */
export function updateAgentRole(
  db: Database.Database,
  id: string,
  input: { name?: unknown; body?: unknown; expectedBodyVersion?: number; expectedName?: string }
): AgentRoleEditResult {
  const name = input.name === undefined ? undefined : validatedName(input.name);
  if (input.body !== undefined) assertBody(input.body);
  const newBody = input.body as string | undefined;

  return db.transaction((): AgentRoleEditResult => {
    const before = getAgentRole(db, id);
    if (!before) throw new AgentRoleNotFoundError(id);
    if (input.expectedBodyVersion !== undefined && input.expectedBodyVersion !== before.bodyVersion) {
      throw new AgentRoleVersionConflictError(before.bodyVersion);
    }
    if (input.expectedName !== undefined && input.expectedName !== before.name && name !== before.name) {
      throw new AgentRoleNameChangedError(before.name);
    }
    const bodyChanged = newBody !== undefined && newBody !== before.body;
    try {
      db.prepare(
        `UPDATE agent_roles SET name = ?, body = ?, body_version = ?, updated_at = ? WHERE id = ?`
      ).run(
        name ?? before.name,
        newBody ?? before.body,
        bodyChanged ? before.bodyVersion + 1 : before.bodyVersion,
        Date.now(),
        id
      );
    } catch (error) {
      if (isUniqueNameViolation(error)) throw new AgentRoleNameConflictError(name ?? before.name);
      throw error;
    }
    return {
      before,
      after: getAgentRole(db, id) as AgentRole,
      affected: getAgentRoleReferences(db, id),
    };
  })();
}

/**
 * Delete a role. With `force`, the settings pointing at it go in the same
 * transaction, so they read as "inherit" afterwards and not as an explicit none.
 * Launch records and generated files stay.
 *
 * @throws {AgentRoleNotFoundError}
 * @throws {AgentRoleInUseError} It has references and `force` was not given
 */
export function deleteAgentRole(
  db: Database.Database,
  id: string,
  options: { force?: boolean } = {}
): { role: AgentRole; affected: AgentRoleReferences } {
  return db.transaction(() => {
    const role = getAgentRole(db, id);
    if (!role) throw new AgentRoleNotFoundError(id);
    const affected = getAgentRoleReferences(db, id);
    const inUse = affected.instances.length + affected.repositories.length + affected.system.length > 0;
    if (inUse && !options.force) throw new AgentRoleInUseError(affected);

    db.prepare('DELETE FROM agent_instance_roles WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM agent_role_repository_defaults WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM agent_role_system_defaults WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM agent_roles WHERE id = ?').run(id);
    return { role, affected };
  })();
}

function assertRoleExists(db: Database.Database, roleId: string): void {
  if (!db.prepare('SELECT 1 FROM agent_roles WHERE id = ?').get(roleId)) {
    throw new AgentRoleNotFoundError(roleId);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function toStoredState(row: { role_id: string | null; role_name: string | null } | undefined): StoredRoleState {
  if (!row) return { state: 'inherit' };
  if (row.role_id === null) return { state: 'none' };
  return { state: 'role', roleId: row.role_id, roleName: row.role_name as string };
}

/** @returns The tools with a system default. A missing key means unset. */
export function getSystemRoleDefaults(db: Database.Database): Record<string, { roleId: string; roleName: string }> {
  const rows = db
    .prepare(
      `SELECT d.cli_tool_id, d.role_id, r.name AS role_name
       FROM agent_role_system_defaults d JOIN agent_roles r ON r.id = d.role_id`
    )
    .all() as Array<{ cli_tool_id: string; role_id: string; role_name: string }>;
  return Object.fromEntries(rows.map((row) => [row.cli_tool_id, { roleId: row.role_id, roleName: row.role_name }]));
}

/**
 * @param roleId - The role, or null for unset (no row)
 * @throws {AgentRoleNotFoundError}
 */
export function setSystemRoleDefault(db: Database.Database, cliToolId: string, roleId: string | null): void {
  if (roleId === null) {
    db.prepare('DELETE FROM agent_role_system_defaults WHERE cli_tool_id = ?').run(cliToolId);
    return;
  }
  assertRoleExists(db, roleId);
  db.prepare(
    `INSERT INTO agent_role_system_defaults (cli_tool_id, role_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(cli_tool_id) DO UPDATE SET role_id = excluded.role_id, updated_at = excluded.updated_at`
  ).run(cliToolId, roleId, Date.now());
}

/** @returns The tools with a row for this root. A missing key means inherit. */
export function getRepositoryRoleStates(db: Database.Database, repositoryId: string): Record<string, StoredRoleState> {
  const rows = db
    .prepare(
      `SELECT d.cli_tool_id, d.role_id, r.name AS role_name
       FROM agent_role_repository_defaults d LEFT JOIN agent_roles r ON r.id = d.role_id
       WHERE d.repository_id = ?`
    )
    .all(repositoryId) as Array<{ cli_tool_id: string; role_id: string | null; role_name: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.cli_tool_id, toStoredState(row)]));
}

/** @throws {AgentRoleNotFoundError} */
export function setRepositoryRoleState(
  db: Database.Database,
  repositoryId: string,
  cliToolId: string,
  input: RoleAssignmentInput
): void {
  if (input.state === 'inherit') {
    db.prepare('DELETE FROM agent_role_repository_defaults WHERE repository_id = ? AND cli_tool_id = ?').run(
      repositoryId,
      cliToolId
    );
    return;
  }
  const roleId = input.state === 'role' ? input.roleId : null;
  if (roleId !== null) assertRoleExists(db, roleId);
  db.prepare(
    `INSERT INTO agent_role_repository_defaults (repository_id, cli_tool_id, role_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(repository_id, cli_tool_id) DO UPDATE SET role_id = excluded.role_id, updated_at = excluded.updated_at`
  ).run(repositoryId, cliToolId, roleId, Date.now());
}

export function getInstanceRoleState(db: Database.Database, worktreeId: string, instanceId: string): StoredRoleState {
  const row = db
    .prepare(
      `SELECT i.role_id, r.name AS role_name
       FROM agent_instance_roles i LEFT JOIN agent_roles r ON r.id = i.role_id
       WHERE i.worktree_id = ? AND i.instance_id = ?`
    )
    .get(worktreeId, instanceId) as { role_id: string | null; role_name: string | null } | undefined;
  return toStoredState(row);
}

/**
 * Whether the target may hold a setting is for the caller to decide
 * (`agent-roles/management.ts`): this writes what it is told.
 *
 * @throws {AgentRoleNotFoundError}
 */
export function setInstanceRoleState(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  input: RoleAssignmentInput
): void {
  if (input.state === 'inherit') {
    db.prepare('DELETE FROM agent_instance_roles WHERE worktree_id = ? AND instance_id = ?').run(
      worktreeId,
      instanceId
    );
    return;
  }
  const roleId = input.state === 'role' ? input.roleId : null;
  if (roleId !== null) assertRoleExists(db, roleId);
  db.prepare(
    `INSERT INTO agent_instance_roles (worktree_id, instance_id, role_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(worktree_id, instance_id) DO UPDATE SET role_id = excluded.role_id, updated_at = excluded.updated_at`
  ).run(worktreeId, instanceId, roleId, Date.now());
}

/**
 * Whether any level holds a setting. With none, every instance of every tool
 * resolves to no role, so a launch need not run git to find that out (#4115).
 */
export function hasAnyRoleSetting(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT (EXISTS (SELECT 1 FROM agent_instance_roles)
            OR EXISTS (SELECT 1 FROM agent_role_repository_defaults)
            OR EXISTS (SELECT 1 FROM agent_role_system_defaults)) AS present`
    )
    .get() as { present?: number } | undefined;
  return row?.present === 1;
}

// ---------------------------------------------------------------------------
// Creation keys (#4132, migration v65)
// ---------------------------------------------------------------------------

/** How long a key is remembered. A request's deadline is seconds, so a late one is well inside it. */
export const INSTANCE_CREATION_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What a key did. A null `requestFingerprint` is a key given up on, or one whose row has
 * since left the roster: it makes nothing and claims nothing. Otherwise its write committed,
 * and `instanceId` names the row it added; null when it added not exactly one (a roster PATCH).
 */
export interface InstanceCreationKeyRecord {
  instanceId: string | null;
  requestFingerprint: string | null;
}

export function getInstanceCreationKey(
  db: Database.Database,
  worktreeId: string,
  key: string
): InstanceCreationKeyRecord | null {
  const row = db
    .prepare(
      `SELECT instance_id, request_fingerprint FROM agent_instance_creation_keys
       WHERE worktree_id = ? AND idempotency_key = ?`
    )
    .get(worktreeId, key) as { instance_id: string | null; request_fingerprint: string | null } | undefined;
  return row ? { instanceId: row.instance_id, requestFingerprint: row.request_fingerprint } : null;
}

function writeInstanceCreationKey(
  db: Database.Database,
  worktreeId: string,
  key: string,
  record: InstanceCreationKeyRecord
): void {
  const now = Date.now();
  db.prepare('DELETE FROM agent_instance_creation_keys WHERE created_at < ?').run(now - INSTANCE_CREATION_KEY_TTL_MS);
  db.prepare(
    `INSERT INTO agent_instance_creation_keys (worktree_id, idempotency_key, instance_id, request_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(worktreeId, key, record.instanceId, record.requestFingerprint, now);
}

/** Written in the transaction that creates the row, so one never exists without the other. */
export function recordInstanceCreationKey(
  db: Database.Database,
  worktreeId: string,
  key: string,
  instanceId: string | null,
  requestFingerprint: string
): void {
  writeInstanceCreationKey(db, worktreeId, key, { instanceId, requestFingerprint });
}

/**
 * What a key came to. One that has made nothing is marked given up on here, so a request
 * still on its way with it makes nothing either: the answer holds from now on.
 *
 * @returns The instance it made, or null when it made none and never will
 */
export function settleInstanceCreationKey(db: Database.Database, worktreeId: string, key: string): string | null {
  return db.transaction((): string | null => {
    const existing = getInstanceCreationKey(db, worktreeId, key);
    if (existing) return existing.instanceId;
    writeInstanceCreationKey(db, worktreeId, key, { instanceId: null, requestFingerprint: null });
    return null;
  })();
}

// ---------------------------------------------------------------------------
// Launch records
// ---------------------------------------------------------------------------

interface LaunchRecordRow {
  id: string;
  worktree_id: string;
  instance_id: string;
  cli_tool_id: string;
  phase: RoleLaunchPhase;
  session_generation: string;
  source: RoleResolutionSource;
  repository_id: string | null;
  role_id: string | null;
  role_name: string | null;
  body_version: number | null;
  body_fingerprint: string | null;
  injection_fingerprint: string | null;
  artifact_fingerprint: string | null;
  adapter_id: string | null;
  adapter_version: string | null;
  wrapper_version: string | null;
  artifact_path: string | null;
  effective_agent: string | null;
  composition_source_fingerprint: string | null;
  no_role_reason: NoRoleReason | null;
  recorded_at: number;
}

function mapLaunchRecord(row: LaunchRecordRow): RoleLaunchRecord {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    instanceId: row.instance_id,
    cliToolId: row.cli_tool_id,
    phase: row.phase,
    sessionGeneration: row.session_generation,
    source: row.source,
    repositoryId: row.repository_id,
    roleId: row.role_id,
    roleName: row.role_name,
    bodyVersion: row.body_version,
    bodyFingerprint: row.body_fingerprint,
    injectionFingerprint: row.injection_fingerprint,
    artifactFingerprint: row.artifact_fingerprint,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    wrapperVersion: row.wrapper_version,
    artifactPath: row.artifact_path,
    effectiveAgent: row.effective_agent,
    compositionSourceFingerprint: row.composition_source_fingerprint,
    noRoleReason: row.no_role_reason,
    recordedAt: row.recorded_at,
  };
}

/**
 * Add one line of evidence. There is no function that changes one.
 *
 * @throws When this generation already has a record of this phase
 */
export function recordRoleLaunch(db: Database.Database, record: RoleLaunchSnapshotInput): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agent_role_launch_records (
       id, worktree_id, instance_id, cli_tool_id, phase, session_generation, source,
       repository_id, role_id, role_name, body_version, body_fingerprint,
       injection_fingerprint, artifact_fingerprint, adapter_id, adapter_version,
       wrapper_version, artifact_path, effective_agent, composition_source_fingerprint,
       no_role_reason, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    record.worktreeId,
    record.instanceId,
    record.cliToolId,
    record.phase,
    record.sessionGeneration,
    record.source,
    record.repositoryId,
    record.roleId,
    record.roleName,
    record.bodyVersion,
    record.bodyFingerprint,
    record.injectionFingerprint,
    record.artifactFingerprint,
    record.adapterId,
    record.adapterVersion,
    record.wrapperVersion,
    record.artifactPath,
    record.effectiveAgent,
    record.compositionSourceFingerprint,
    record.noRoleReason,
    Date.now()
  );
  return id;
}

/** The latest record of each phase for one instance. Ties on the clock go to the later insert. */
export function getLatestRoleLaunchRecords(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): { requested: RoleLaunchRecord | null; launched: RoleLaunchRecord | null } {
  const latest = (phase: RoleLaunchPhase): RoleLaunchRecord | null => {
    const row = db
      .prepare(
        `SELECT * FROM agent_role_launch_records
         WHERE worktree_id = ? AND instance_id = ? AND phase = ?
         ORDER BY recorded_at DESC, rowid DESC LIMIT 1`
      )
      .get(worktreeId, instanceId, phase) as LaunchRecordRow | undefined;
    return row ? mapLaunchRecord(row) : null;
  };
  return { requested: latest('requested'), launched: latest('launched') };
}
