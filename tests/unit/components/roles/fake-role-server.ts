/**
 * A role API that keeps state, answering in the shapes of
 * `tests/integration/fixtures/agent-roles-api-examples.ts`, which are checked against
 * the real routes. It enforces the revision the way the routes do, so a test can race
 * a save against something else that changed the roster.
 */
import { vi } from 'vitest';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type {
  AgentRoleReferences,
  AgentRoleSummary,
  EffectiveRole,
  InstanceRoleEntry,
  InstanceRoleSettingsResponse,
  RoleLaunchRecord,
  StoredRoleState,
  StoredSystemRoleState,
  SystemRoleDefaultEntry,
  WorktreeToolRoleDefault,
} from '@/types/agent-roles';
import {
  effectiveAmbiguousExample,
  instanceSettingsExample,
  launchRecordExample,
  repositoryDefaultsExample,
  roleDetailExample,
  roleEditExample,
  roleListExample,
  systemDefaultsExample,
} from '@tests/integration/fixtures/agent-roles-api-examples';

export const MARKETER = roleListExample.roles[0];
export const REVIEWER: AgentRoleSummary = { ...MARKETER, id: '8899aabbccddeeff', name: 'レビュー担当' };

/** Each tool's default, one of every kind of answer. */
export const TOOL_DEFAULTS: Record<string, EffectiveRole> = {
  claude: repositoryDefaultsExample.defaults[0].effective,
  codex: {
    kind: 'role',
    source: 'repository',
    cliToolId: 'codex',
    repositoryId: 'repo-1',
    repositoryIds: ['repo-1'],
    role: { id: REVIEWER.id, name: REVIEWER.name, bodyVersion: 1, bodyFingerprint: 'a'.repeat(64) },
  },
  opencode: {
    kind: 'none',
    source: 'repository',
    cliToolId: 'opencode',
    repositoryId: 'repo-1',
    repositoryIds: ['repo-1'],
    reason: 'explicit-none',
  },
  copilot: {
    kind: 'none',
    source: 'fallback',
    cliToolId: 'copilot',
    repositoryId: null,
    repositoryIds: [],
    reason: 'no-default',
  },
  'command-code': { ...effectiveAmbiguousExample, cliToolId: 'command-code' },
};

const NO_DEFAULT: EffectiveRole = TOOL_DEFAULTS.copilot;

export function launched(overrides: Partial<RoleLaunchRecord> = {}): RoleLaunchRecord {
  return { ...launchRecordExample, ...overrides };
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

export class FakeRoleServer {
  roster: AgentInstance[];
  rosterSaved = true;
  revisionNumber = 1;
  stored: Record<string, StoredRoleState> = {};
  application: Record<string, Partial<InstanceRoleEntry['application']>> = {};
  roles: AgentRoleSummary[] = [MARKETER, REVIEWER];
  bodies: Record<string, string> = { [MARKETER.id]: roleDetailExample.role.body, [REVIEWER.id]: 'レビューします' };
  system: Record<string, StoredSystemRoleState> = {};
  repositoryStored: Record<string, StoredRoleState> = {};
  references: Record<string, AgentRoleReferences> = {};
  running: Record<string, boolean> = {};
  /** Answer the next `POST .../instances/roles` with this refusal. */
  refuseNextCreate: { status: number; error: string } | null = null;
  refusePut = false;
  /** `GET /api/worktrees/:id` answers 500: the roster and the running state are unreadable. */
  refuseWorktreeRead = false;
  /** `GET .../instances/roles` answers 500. */
  refuseSettingsRead = false;
  /** While set, every roster-writing request waits for {@link release}. */
  holdWrites = false;
  /**
   * While set, a role PUT is written and its answer built at once, but the answer waits
   * in `held`, so answers can be delivered in another order than they were built.
   */
  holdPutAnswers = false;
  /** The same for a roster PATCH or a create: written and answered at once, delivered on release. */
  holdRosterAnswers = false;
  private held: Array<() => void> = [];
  readonly calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

  constructor(roster: AgentInstance[]) {
    this.roster = roster;
  }

  get revision(): string {
    return `rev-${this.revisionNumber}`;
  }

  /** Something outside this screen changed the roster: another tab, a phone, the CLI. */
  changeRosterElsewhere(next: AgentInstance[]): void {
    this.roster = next;
    this.revisionNumber += 1;
  }

  release(): void {
    this.held.shift()?.();
  }

  /** Deliver the newest held answer first. */
  releaseLast(): void {
    this.held.pop()?.();
  }

  get heldCount(): number {
    return this.held.length;
  }

  writes(method: string, pathEnd?: string): Array<Record<string, unknown>> {
    return this.calls
      .filter((call) => call.method === method && (pathEnd === undefined || call.url.endsWith(pathEnd)))
      .map((call) => call.body);
  }

  /** What a row with nothing of its own gets: the system default when one is set. */
  private inherited(cliTool: string): EffectiveRole {
    const system = this.system[cliTool];
    if (system?.state !== 'role') return TOOL_DEFAULTS[cliTool] ?? NO_DEFAULT;
    return {
      kind: 'role',
      source: 'system',
      cliToolId: cliTool,
      repositoryId: null,
      repositoryIds: [],
      role: { id: system.roleId, name: system.roleName, bodyVersion: 1, bodyFingerprint: 'a'.repeat(64) },
    } as EffectiveRole;
  }

  private settings(): InstanceRoleSettingsResponse {
    const template = instanceSettingsExample.instances[0];
    const instances: InstanceRoleEntry[] = this.roster.map((inst) => {
      const supported = !['gemini', 'vibe-local'].includes(inst.cliTool);
      const stored = this.stored[inst.id] ?? { state: 'inherit' };
      let effective: EffectiveRole = this.inherited(inst.cliTool);
      if (stored.state === 'none') {
        effective = {
          kind: 'none',
          source: 'instance',
          cliToolId: inst.cliTool,
          repositoryId: null,
          repositoryIds: [],
          reason: 'explicit-none',
        };
      } else if (stored.state === 'role') {
        effective = {
          kind: 'role',
          source: 'instance',
          cliToolId: inst.cliTool,
          repositoryId: null,
          repositoryIds: [],
          role: { id: stored.roleId, name: stored.roleName, bodyVersion: 1, bodyFingerprint: 'a'.repeat(64) },
        };
      }
      return {
        ...template,
        instanceId: inst.id,
        cliToolId: inst.cliTool,
        alias: inst.alias,
        supported,
        stored,
        application: {
          ...template.application,
          effectiveNext: { ...effective, injectionFingerprint: null },
          ...this.application[inst.id],
        },
      };
    });
    const toolDefaults: WorktreeToolRoleDefault[] = (
      ['claude', 'codex', 'command-code', 'opencode', 'opencode-v2', 'copilot', 'antigravity'] as const
    ).map((cliToolId) => ({
      cliToolId,
      adapterEnabled: cliToolId !== 'antigravity',
      effective: TOOL_DEFAULTS[cliToolId] ?? NO_DEFAULT,
    }));
    return {
      ...instanceSettingsExample,
      rosterRevision: this.revision,
      rosterSaved: this.rosterSaved,
      instances,
      toolDefaults,
    };
  }

  private systemDefaults(): SystemRoleDefaultEntry[] {
    const template = systemDefaultsExample.defaults[1];
    return (['claude', 'antigravity'] as const).map((cliToolId) => ({
      ...template,
      cliToolId,
      adapterEnabled: cliToolId !== 'antigravity',
      stored: this.system[cliToolId] ?? { state: 'unset' },
    }));
  }

  private async holdIfAsked(): Promise<void> {
    if (!this.holdWrites) return;
    await new Promise<void>((resolve) => this.held.push(resolve));
  }

  readonly fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    this.calls.push({ url, method, body });
    const path = url.split('?')[0];

    if (path.endsWith('/instances/roles')) {
      if (method === 'GET') {
        if (this.refuseSettingsRead) return json(500, { success: false, error: 'internal_error', message: 'x' });
        return json(200, this.settings());
      }
      if (method === 'PUT') {
        if (this.refusePut) return json(500, { success: false, error: 'internal_error', message: 'x' });
        const role = body.role as { state: string; roleId?: string };
        const instanceId = String(body.instanceId);
        this.stored[instanceId] =
          role.state === 'role'
            ? { state: 'role', roleId: String(role.roleId), roleName: this.roles.find((r) => r.id === role.roleId)?.name ?? '' }
            : ({ state: role.state } as StoredRoleState);
        const answer = json(200, this.settings());
        if (this.holdPutAnswers) await new Promise<void>((resolve) => this.held.push(resolve));
        return answer;
      }
      await this.holdIfAsked();
      if (this.refuseNextCreate) {
        const { status, error } = this.refuseNextCreate;
        this.refuseNextCreate = null;
        return json(status, { success: false, error, message: error });
      }
      if (body.expectedRosterRevision !== undefined && body.expectedRosterRevision !== this.revision) {
        return json(409, { success: false, error: 'roster_changed', message: 'changed' });
      }
      const instance = body.instance as AgentInstance;
      if (this.roster.some((inst) => inst.id === instance.id)) {
        return json(409, { success: false, error: 'instance_exists', message: 'exists' });
      }
      this.roster = [...this.roster, { ...instance, order: this.roster.length }];
      this.rosterSaved = true;
      this.revisionNumber += 1;
      const role = body.role as { state: string; roleId?: string };
      if (role.state === 'role') {
        this.stored[instance.id] = {
          state: 'role',
          roleId: String(role.roleId),
          roleName: this.roles.find((r) => r.id === role.roleId)?.name ?? '',
        };
      } else if (role.state === 'none') {
        this.stored[instance.id] = { state: 'none' };
      }
      const created = json(201, { ...this.settings(), created: { instanceId: instance.id } });
      if (this.holdRosterAnswers) await new Promise<void>((resolve) => this.held.push(resolve));
      return created;
    }

    if (path === '/api/roles') {
      if (method === 'POST') {
        if (this.roles.some((role) => role.name === body.name)) {
          return json(409, { success: false, error: 'name_conflict', message: 'taken' });
        }
        const role = { ...MARKETER, id: `f${this.roles.length}`.padEnd(16, '0'), name: String(body.name) };
        this.roles = [...this.roles, role];
        this.bodies[role.id] = String(body.body);
        return json(201, { success: true, role: { ...role, body: body.body } });
      }
      return json(200, { success: true, roles: this.roles });
    }

    const roleMatch = /^\/api\/roles\/([^/]+)$/.exec(path);
    if (roleMatch) {
      const id = roleMatch[1];
      const role = this.roles.find((candidate) => candidate.id === id);
      if (!role) return json(404, { success: false, error: 'not_found', message: 'gone' });
      if (method === 'GET') {
        return json(200, {
          ...roleDetailExample,
          role: { ...role, body: this.bodies[id] },
        });
      }
      if (method === 'PUT') {
        // As `updateAgentRole`: the version is checked only when sent, what is not sent
        // stays, and only a changed body moves the version. A rename does not.
        if (body.expectedBodyVersion !== undefined && body.expectedBodyVersion !== role.bodyVersion) {
          return json(409, { success: false, error: 'version_conflict', message: 'stale', currentBodyVersion: role.bodyVersion });
        }
        const name = body.name === undefined ? role.name : String(body.name);
        if (this.roles.some((candidate) => candidate.id !== id && candidate.name === name)) {
          return json(409, { success: false, error: 'name_conflict', message: 'taken' });
        }
        const bodyText = body.body === undefined ? this.bodies[id] : String(body.body);
        const after = { ...role, name, bodyVersion: bodyText === this.bodies[id] ? role.bodyVersion : role.bodyVersion + 1 };
        this.roles = this.roles.map((candidate) => (candidate.id === id ? after : candidate));
        this.bodies[id] = bodyText;
        for (const holder of [this.stored, this.system, this.repositoryStored]) {
          for (const stored of Object.values(holder)) {
            if (stored.state === 'role' && stored.roleId === id) stored.roleName = name;
          }
        }
        return json(200, { ...roleEditExample, after: { ...after, body: bodyText }, bodyVersion: after.bodyVersion });
      }
      const force = url.includes('force=true');
      const references = this.references[id];
      if (references && !force) {
        return json(409, { success: false, error: 'role_in_use', message: 'in use', references });
      }
      this.roles = this.roles.filter((candidate) => candidate.id !== id);
      // As `deleteAgentRole`: what pointed at it reads as inherit, not as an explicit none.
      for (const holder of [this.system, this.stored, this.repositoryStored]) {
        for (const [key, stored] of Object.entries(holder)) {
          if (stored.state === 'role' && stored.roleId === id) delete holder[key];
        }
      }
      return json(200, {
        success: true,
        deleted: { id, name: role.name },
        affected: references ?? { instances: [], repositories: [], system: [] },
      });
    }

    if (path === '/api/settings/agent-role-defaults') {
      if (method === 'PUT') {
        const tool = String(body.cliToolId);
        if (body.roleId === null) delete this.system[tool];
        else {
          const role = this.roles.find((candidate) => candidate.id === body.roleId);
          this.system[tool] = { state: 'role', roleId: String(body.roleId), roleName: role?.name ?? '' };
        }
      }
      return json(200, { success: true, defaults: this.systemDefaults() });
    }

    if (path.endsWith('/role-defaults')) {
      const tool = 'claude';
      if (method === 'PUT') {
        const role = body.role as { state: string; roleId?: string };
        this.repositoryStored[tool] =
          role.state === 'role'
            ? { state: 'role', roleId: String(role.roleId), roleName: this.roles.find((r) => r.id === role.roleId)?.name ?? '' }
            : ({ state: role.state } as StoredRoleState);
      }
      const stored = this.repositoryStored[tool] ?? { state: 'inherit' };
      const effective: EffectiveRole =
        stored.state === 'inherit'
          ? this.inherited('claude')
          : stored.state === 'none'
            ? { ...TOOL_DEFAULTS.opencode, cliToolId: 'claude' }
            : {
                kind: 'role',
                source: 'repository',
                cliToolId: 'claude',
                repositoryId: 'repo-1',
                repositoryIds: ['repo-1'],
                role: { id: stored.roleId, name: stored.roleName, bodyVersion: 1, bodyFingerprint: 'a'.repeat(64) },
              };
      return json(200, {
        ...repositoryDefaultsExample,
        defaults: [{ ...repositoryDefaultsExample.defaults[0], stored, effective }],
      });
    }

    if (path.endsWith('/kill-session')) return json(200, { success: true });

    if (method === 'PATCH') {
      await this.holdIfAsked();
      if (body.expectedRosterRevision !== undefined && body.expectedRosterRevision !== this.revision) {
        return json(409, { error: 'changed', code: 'ROSTER_CHANGED', rosterRevision: this.revision, agentInstances: this.roster });
      }
      this.roster = body.agentInstances as AgentInstance[];
      this.rosterSaved = true;
      this.revisionNumber += 1;
      const saved = json(200, { agentInstances: this.roster, rosterRevision: this.revision });
      if (this.holdRosterAnswers) await new Promise<void>((resolve) => this.held.push(resolve));
      return saved;
    }

    if (url.startsWith('/api/settings/default-agents')) {
      return json(200, { installed: ['claude', 'codex', 'opencode', 'copilot', 'command-code', 'antigravity', 'gemini'] });
    }
    if (/^\/api\/worktrees\/[^/]+$/.test(path)) {
      if (this.refuseWorktreeRead) return json(500, { error: 'Failed to fetch worktree' });
      return json(200, {
        agentInstances: this.roster.map((inst) => ({ ...inst, sessionName: `cm-${inst.id}` })),
        rosterRevision: this.revision,
        sessionStatusByInstance: Object.fromEntries(
          Object.entries(this.running).map(([id, isRunning]) => [id, { isRunning }]),
        ),
      });
    }
    return json(200, {});
  });
}
