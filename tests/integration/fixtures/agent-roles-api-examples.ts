/**
 * Worked examples of the role API responses, for #4116 (CLI) and #4117 (screen).
 *
 * Typed against `src/types/agent-roles.ts`, so a change there breaks here, and
 * `tests/integration/api-agent-roles-4114.test.ts` compares the keys of each
 * example with what the routes really answer.
 *
 * `application.requested` / `launched` are null and `restartPending` is `unknown`
 * here because nothing has been launched; `launchRecordExample` shows a filled one.
 */
import type {
  AgentRoleDeleteConflictResponse,
  AgentRoleDeleteResponse,
  AgentRoleDetailResponse,
  AgentRoleEditResponse,
  AgentRoleErrorResponse,
  AgentRoleListResponse,
  EffectiveRole,
  InstanceRoleCreateResponse,
  InstanceRoleSettingsResponse,
  RepositoryRoleDefaultsResponse,
  RoleLaunchRecord,
  SystemRoleDefaultsResponse,
} from '@/types/agent-roles';

const FP_BODY = 'a'.repeat(64);
const FP_INJECTION = 'b'.repeat(64);
const FP_ARTIFACT = 'c'.repeat(64);

const summary = {
  id: '0011223344556677',
  name: 'マーケター',
  bodyVersion: 2,
  bodyFingerprint: FP_BODY,
  bodyBytes: 42,
  createdAt: 1800000000000,
  updatedAt: 1800000100000,
};

export const roleListExample: AgentRoleListResponse = { success: true, roles: [summary] };

export const roleDetailExample: AgentRoleDetailResponse = {
  success: true,
  role: { ...summary, body: 'あなたはマーケターです。' },
  references: { instances: [], repositories: [], system: [{ cliToolId: 'claude' }] },
};

export const roleEditExample: AgentRoleEditResponse = {
  success: true,
  before: { ...summary, bodyVersion: 1, bodyFingerprint: 'd'.repeat(64), body: '旧本文' },
  after: { ...summary, body: 'あなたはマーケターです。' },
  bodyVersion: 2,
  affected: {
    instances: [{ worktreeId: 'wt-1', instanceId: 'codex-2' }],
    repositories: [{ repositoryId: 'repo-1', repositoryPath: '/repos/app', cliToolId: 'codex' }],
    system: [{ cliToolId: 'claude' }],
  },
};

export const roleDeleteConflictExample: AgentRoleDeleteConflictResponse = {
  success: false,
  error: 'role_in_use',
  message: 'Role is in use',
  references: roleEditExample.affected,
};

export const roleDeleteExample: AgentRoleDeleteResponse = {
  success: true,
  deleted: { id: summary.id, name: summary.name },
  affected: roleEditExample.affected,
};

export const errorExample: AgentRoleErrorResponse = {
  success: false,
  error: 'version_conflict',
  message: 'The role was edited by someone else',
};

const effectiveFromSystem: EffectiveRole = {
  kind: 'role',
  source: 'system',
  cliToolId: 'claude',
  repositoryId: 'repo-1',
  repositoryIds: ['repo-1'],
  role: { id: summary.id, name: summary.name, bodyVersion: 2, bodyFingerprint: FP_BODY },
};

const effectiveNoRole: EffectiveRole = {
  kind: 'none',
  source: 'fallback',
  cliToolId: 'codex',
  repositoryId: null,
  repositoryIds: [],
  reason: 'no-default',
};

/** What `send` refuses to go ahead with (#4115). */
export const effectiveAmbiguousExample: EffectiveRole = {
  kind: 'ambiguous',
  source: 'repository',
  cliToolId: 'claude',
  repositoryId: 'repo-1',
  repositoryIds: ['repo-1', 'repo-2'],
  reason: 'root-settings-differ',
  roots: [
    { repositoryId: 'repo-1', path: '/repos/app', state: { state: 'none' } },
    {
      repositoryId: 'repo-2',
      path: '/repos/app-wt',
      state: { state: 'role', roleId: summary.id, roleName: summary.name },
    },
  ],
};

export const systemDefaultsExample: SystemRoleDefaultsResponse = {
  success: true,
  defaults: [
    {
      cliToolId: 'claude',
      adapterEnabled: true,
      stored: { state: 'role', roleId: summary.id, roleName: summary.name },
    },
    { cliToolId: 'antigravity', adapterEnabled: false, stored: { state: 'unset' } },
  ],
};

export const repositoryDefaultsExample: RepositoryRoleDefaultsResponse = {
  success: true,
  repository: { id: 'repo-1', name: 'app', path: '/repos/app', enabled: true },
  defaults: [
    {
      cliToolId: 'claude',
      adapterEnabled: true,
      stored: { state: 'inherit' },
      effective: effectiveFromSystem,
    },
  ],
};

export const launchRecordExample: RoleLaunchRecord = {
  id: 'rec-1',
  worktreeId: 'wt-1',
  instanceId: 'codex-2',
  cliToolId: 'codex',
  phase: 'launched',
  sessionGeneration: 'gen-7',
  source: 'repository',
  repositoryId: 'repo-1',
  roleId: summary.id,
  roleName: summary.name,
  bodyVersion: 2,
  bodyFingerprint: FP_BODY,
  injectionFingerprint: FP_INJECTION,
  artifactFingerprint: FP_ARTIFACT,
  adapterId: 'codex',
  adapterVersion: '1',
  wrapperVersion: '1',
  artifactPath: '/home/u/.codex/cm-role-ns-0011223344556677-bbbbbbbbbbbb.config.toml',
  effectiveAgent: null,
  compositionSourceFingerprint: 'e'.repeat(64),
  noRoleReason: null,
  recordedAt: 1800000200000,
};

export const instanceSettingsExample: InstanceRoleSettingsResponse = {
  success: true,
  rosterRevision: 'f'.repeat(64),
  rosterSaved: true,
  instances: [
    {
      instanceId: 'codex-2',
      cliToolId: 'codex',
      alias: 'レビュー',
      supported: true,
      adapterEnabled: true,
      stored: { state: 'inherit' },
      application: {
        effectiveNext: { ...effectiveNoRole, injectionFingerprint: null },
        requested: null,
        launched: null,
        restartPending: 'unknown',
      },
    },
  ],
  toolDefaults: [{ cliToolId: 'claude', adapterEnabled: true, effective: effectiveFromSystem }],
};

export const instanceCreateExample: InstanceRoleCreateResponse = {
  ...instanceSettingsExample,
  created: { instanceId: 'codex-2' },
};
