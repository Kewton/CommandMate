/**
 * Roles: the vocabulary shared by the database, the resolver, the routes, the
 * CLI (#4116) and the screen (#4117). Free of the database and of `fs`, so a
 * client component and the launch path can both import it.
 *
 * Worked examples of every response: `tests/integration/fixtures/agent-roles-api-examples.ts`.
 *
 * Design: Epic #4112, `docs/design/agent-roles-adapters.md` §5 and §14.
 *
 * @module types/agent-roles
 */
import type { CLIToolType } from '../lib/cli-tools/types';

/** Largest body, in UTF-8 bytes. Applied to the body, never to a composed artifact (§5). */
export const MAX_ROLE_BODY_BYTES = 16384;

/** Longest role name, in UTF-16 code units. The name reaches no file name or command line. */
export const MAX_ROLE_NAME_LENGTH = 64;

/** The tools a role can be given to (D3). Gemini and vibe-local are out of scope. */
export const AGENT_ROLE_CLI_TOOLS = [
  'claude',
  'codex',
  'command-code',
  'opencode',
  'opencode-v2',
  'copilot',
  'antigravity',
] as const satisfies readonly CLIToolType[];

export type AgentRoleCliTool = (typeof AGENT_ROLE_CLI_TOOLS)[number];

export function isAgentRoleCliTool(value: unknown): value is AgentRoleCliTool {
  return typeof value === 'string' && (AGENT_ROLE_CLI_TOOLS as readonly string[]).includes(value);
}

/** Turns Antigravity's adapter on, once its check under a dedicated OS user has passed (§6.6). */
export const AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR = 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED';

/**
 * Whether a launch may apply a role through this tool's adapter yet. Antigravity
 * can hold settings and its adapter is built, but stays off until the check under
 * a dedicated OS user has passed (D3). A role resolved for a tool that is off
 * refuses the launch; it never starts without it.
 */
export function isAgentRoleAdapterEnabled(tool: AgentRoleCliTool): boolean {
  if (tool !== 'antigravity') return true;
  return typeof process !== 'undefined' && process.env?.[AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR] === '1';
}

/**
 * Whether a role through this tool replaces its default instructions instead of
 * adding to them: OpenCode V2 overrides the agent's `system`, which removes the
 * provider's base prompt (§7.2). The API says so, so a client can.
 */
export function agentRoleReplacesDefaultInstructions(tool: string): boolean {
  return tool === 'opencode-v2';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** What a client asks an instance or repository to hold. */
export type RoleAssignmentInput =
  | { state: 'inherit' }
  | { state: 'none' }
  | { state: 'role'; roleId: string };

/**
 * What an instance or repository holds. `inherit` is no row, `none` is a row
 * with a NULL role, `role` is a row with one.
 */
export type StoredRoleState =
  | { state: 'inherit' }
  | { state: 'none' }
  | { state: 'role'; roleId: string; roleName: string };

/** What the system level holds. It has no `none`: a missing row is the end of the chain. */
export type StoredSystemRoleState = { state: 'unset' } | { state: 'role'; roleId: string; roleName: string };

/** Everything pointing directly at a role. Inheritors of a default are not listed one by one. */
export interface AgentRoleReferences {
  instances: Array<{ worktreeId: string; instanceId: string }>;
  repositories: Array<{ repositoryId: string; repositoryPath: string; cliToolId: string }>;
  system: Array<{ cliToolId: string }>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The role a launch uses, taken once and never re-read. `bodyFingerprint` is the
 * only fingerprint it can carry: the injection fingerprint depends on the user's
 * settings at launch and comes from #4115's transform, the artifact fingerprint
 * from the writer (§5).
 */
export interface ResolvedRole {
  readonly id: string;
  readonly name: string;
  readonly bodyVersion: number;
  readonly body: string;
  readonly bodyFingerprint: string;
}

/** The level that decided. `unsupported` is the tool being outside D3. */
export type RoleResolutionSource = 'instance' | 'repository' | 'system' | 'fallback' | 'unsupported';

/** Why there is no role. */
export type NoRoleReason = 'explicit-none' | 'no-default' | 'unsupported-tool';

/**
 * - `root-settings-differ`: the roots of one git repository hold different settings.
 * - `membership-undetermined`: git could not say whether a root that would
 *   disagree belongs to this repository.
 */
export type RoleAmbiguityReason = 'root-settings-differ' | 'membership-undetermined';

export interface RoleAmbiguousRoot {
  repositoryId: string;
  path: string;
  state: StoredRoleState;
}

interface RoleResolutionBase {
  cliToolId: CLIToolType;
  /**
   * The registered root this answer is attributed to: the first by path among
   * {@link repositoryIds}, so it does not depend on the scan order. Null when the
   * worktree has no registered root.
   */
  repositoryId: string | null;
  /** Every root the worktree belongs to. Settings are stored per root. */
  repositoryIds: string[];
}

export type RoleResolution =
  | (RoleResolutionBase & { kind: 'role'; source: RoleResolutionSource; role: ResolvedRole })
  | (RoleResolutionBase & { kind: 'none'; source: RoleResolutionSource; reason: NoRoleReason })
  | (RoleResolutionBase & {
      kind: 'ambiguous';
      source: 'repository';
      reason: RoleAmbiguityReason;
      roots: RoleAmbiguousRoot[];
    });

/** A {@link ResolvedRole} safe to answer in a listing: no body. */
export type EffectiveRoleSummary = Omit<ResolvedRole, 'body'>;

/** A {@link RoleResolution} for an API response: the body is left out. */
export type EffectiveRole =
  | (RoleResolutionBase & { kind: 'role'; source: RoleResolutionSource; role: EffectiveRoleSummary })
  | (RoleResolutionBase & { kind: 'none'; source: RoleResolutionSource; reason: NoRoleReason })
  | (RoleResolutionBase & {
      kind: 'ambiguous';
      source: 'repository';
      reason: RoleAmbiguityReason;
      roots: RoleAmbiguousRoot[];
    });

// ---------------------------------------------------------------------------
// Launch records
// ---------------------------------------------------------------------------

export type RoleLaunchPhase = 'requested' | 'launched';

/**
 * One line of evidence about a launch: what was resolved at that moment, not
 * what the settings say now. Holds no body and no secret; a composition input is
 * recorded only as a fingerprint. Written once.
 */
export interface RoleLaunchSnapshotInput {
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  phase: RoleLaunchPhase;
  sessionGeneration: string;
  source: RoleResolutionSource;
  /** The root at that moment. Deliberately not a foreign key. */
  repositoryId: string | null;
  /** The role at that moment. Deliberately not a foreign key. */
  roleId: string | null;
  roleName: string | null;
  bodyVersion: number | null;
  bodyFingerprint: string | null;
  injectionFingerprint: string | null;
  artifactFingerprint: string | null;
  adapterId: string | null;
  adapterVersion: string | null;
  wrapperVersion: string | null;
  artifactPath: string | null;
  /** OpenCode V2: the agent whose `system` was overridden. */
  effectiveAgent: string | null;
  /** Codex: the fingerprint of the `developer_instructions` it composed with. */
  compositionSourceFingerprint: string | null;
  noRoleReason: NoRoleReason | null;
}

export interface RoleLaunchRecord extends RoleLaunchSnapshotInput {
  id: string;
  recordedAt: number;
}

/**
 * The application state of one instance. `effectiveNext` is what the next launch
 * would use; `requested` and `launched` are snapshots of a launch, and are the role
 * at startup, since a switch inside the TUI cannot be seen.
 *
 * `launched` is null until something confirms it (§14), and after a server restart:
 * null is "not known", which is not "no role". A launch with no role has a record
 * with a null fingerprint and a `noRoleReason`.
 *
 * `restartPending` compares injection fingerprints: another name or another level
 * holding the same text is `no`; `unknown` when either side cannot be computed.
 * `effectiveNext.injectionFingerprint` is null with no role, and when it could not
 * be computed: the role is set and {@link RoleApplicationState.restartPending} is `unknown`.
 */
export interface RoleApplicationState {
  effectiveNext: EffectiveRole & { injectionFingerprint: string | null };
  requested: RoleLaunchRecord | null;
  launched: RoleLaunchRecord | null;
  restartPending: 'yes' | 'no' | 'unknown';
  /** Whether this tool's role replaces its default instructions. See {@link agentRoleReplacesDefaultInstructions}. */
  replacesDefaultInstructions?: boolean;
  /**
   * OpenCode V1: the process continued a remembered conversation that had another
   * role, whose replies are still in its history (§6.4). A new conversation is the
   * `newConversation` of `POST /send`, at the next start.
   */
  resumedAcrossRole?: boolean;
}

// ---------------------------------------------------------------------------
// API responses
// ---------------------------------------------------------------------------

export interface AgentRoleSummary {
  id: string;
  name: string;
  bodyVersion: number;
  bodyFingerprint: string;
  bodyBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRoleDetail extends AgentRoleSummary {
  body: string;
}

export interface AgentRoleListResponse {
  success: true;
  roles: AgentRoleSummary[];
}

export interface AgentRoleDetailResponse {
  success: true;
  role: AgentRoleDetail;
  references: AgentRoleReferences;
}

export interface AgentRoleEditResponse {
  success: true;
  before: AgentRoleDetail;
  after: AgentRoleDetail;
  bodyVersion: number;
  affected: AgentRoleReferences;
}

export interface AgentRoleDeleteResponse {
  success: true;
  deleted: { id: string; name: string };
  affected: AgentRoleReferences;
}

/** Every refusal. `error` is the stable code; `message` is for people. */
export interface AgentRoleErrorResponse {
  success: false;
  error:
    | 'invalid_request'
    | 'not_found'
    | 'name_conflict'
    | 'version_conflict'
    | 'name_changed'
    | 'role_in_use'
    | 'tool_not_supported'
    | 'instance_exists'
    | 'roster_changed'
    | 'idempotency_key_reused'
    | 'creation_cancelled'
    | 'internal_error';
  message: string;
  /** `version_conflict` only. */
  currentBodyVersion?: number;
}

export interface AgentRoleDeleteConflictResponse extends AgentRoleErrorResponse {
  error: 'role_in_use';
  references: AgentRoleReferences;
}

export interface SystemRoleDefaultEntry {
  cliToolId: AgentRoleCliTool;
  adapterEnabled: boolean;
  stored: StoredSystemRoleState;
}

export interface SystemRoleDefaultsResponse {
  success: true;
  defaults: SystemRoleDefaultEntry[];
}

export interface RepositoryRoleDefaultEntry {
  cliToolId: AgentRoleCliTool;
  adapterEnabled: boolean;
  /** What this root holds. */
  stored: StoredRoleState;
  /** What a worktree of this root gets from the defaults, and from which level. */
  effective: EffectiveRole;
}

export interface RepositoryRoleDefaultsResponse {
  success: true;
  repository: { id: string; name: string; path: string; enabled: boolean };
  defaults: RepositoryRoleDefaultEntry[];
}

export interface InstanceRoleEntry {
  instanceId: string;
  cliToolId: CLIToolType;
  alias: string;
  /** False for a tool outside D3: it can hold no setting and always resolves to no role. */
  supported: boolean;
  adapterEnabled: boolean;
  stored: StoredRoleState;
  application: RoleApplicationState;
}

export interface WorktreeToolRoleDefault {
  cliToolId: AgentRoleCliTool;
  adapterEnabled: boolean;
  /** What a new instance of this tool would get, before it exists. */
  effective: EffectiveRole;
}

export interface InstanceRoleSettingsResponse {
  success: true;
  /** Hash of the roster as read. Hand it back as `expectedRosterRevision` to detect a change. */
  rosterRevision: string;
  /** False while the instances are derived primaries with no stored roster. */
  rosterSaved: boolean;
  instances: InstanceRoleEntry[];
  toolDefaults: WorktreeToolRoleDefault[];
}

export interface InstanceRoleCreateResponse extends InstanceRoleSettingsResponse {
  created: { instanceId: string };
  /** This `idempotencyKey` had already created it (#4132). Answered with 200 rather than 201. */
  replayed?: true;
}

/**
 * Carries a create's key (#4132): a client makes one per request. A condition about the
 * request rather than part of what is created, so the body is the same with or without it.
 */
export const INSTANCE_CREATION_KEY_HEADER = 'Idempotency-Key';

export const INSTANCE_CREATION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Carries the name a rename replaces (#4132), URI-encoded since a name need not be ASCII.
 * A condition as well: the body of an edit stays only what the edit changes.
 */
export const EXPECTED_ROLE_NAME_HEADER = 'X-Expected-Role-Name';

/**
 * `POST .../instances/roles/settle`, for a create whose answer was lost (#4132).
 * `cancelled`: the key made nothing and now never will, so adding again is safe.
 */
export type InstanceCreationSettleResponse =
  | { success: true; outcome: 'committed'; instanceId: string }
  | { success: true; outcome: 'cancelled' };
