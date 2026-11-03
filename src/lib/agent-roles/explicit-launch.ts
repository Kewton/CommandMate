/**
 * A role named outright, with no settings behind it: for a probe (Issue #4115), which
 * opens no database and inherits nothing, and has to say under what condition it
 * ran. Goes through the same transform and the same file checks as a launch.
 *
 * @module lib/agent-roles/explicit-launch
 */
import type { AgentRoleCliTool } from '@/types/agent-roles';
import {
  buildRoleLaunchArguments,
  computeRoleInjection,
  OPENCODE_CONFIG_CONTENT_ENV_VAR,
  renderRoleFlags,
} from './adapters';
import {
  buildArtifactName,
  inspectRoleArtifact,
  writeRoleArtifact,
  type ArtifactOptions,
} from './artifacts';
import { fixedEnvReader, loadRoleComposition, type RoleEnv } from './composition';
import { computeBodyFingerprint } from './fingerprint';
import { shellQuote } from '@/lib/hooks/hook-settings-generator';

export interface ExplicitRole {
  /** Lower-case alphanumerics and hyphens: it goes into the file's name. */
  id: string;
  body: string;
}

/** What was tried, for the result. No body. */
export interface ExplicitRoleCondition {
  roleId: string;
  bodyFingerprint: string;
  injectionFingerprint: string;
  artifactFingerprint: string;
  adapter: AgentRoleCliTool;
}

export interface ExplicitRoleLaunch {
  /** Goes in front of the rendered launch line. Empty, or an assignment ending in a space. */
  linePrefix: string;
  /** Goes after it. Empty, or flags starting with a space. */
  lineSuffix: string;
  condition: ExplicitRoleCondition;
}

/**
 * @throws {RoleCompositionError} The isolated settings cannot be composed with
 * @throws {RoleArtifactError} The file cannot be written or fails its inspection
 */
export async function prepareExplicitRoleLaunch(
  adapter: AgentRoleCliTool,
  role: ExplicitRole,
  context: { worktreePath: string; env: RoleEnv; namespace: string; artifacts: ArtifactOptions }
): Promise<ExplicitRoleLaunch> {
  const bodyFingerprint = computeBodyFingerprint(role.body);
  const composition = await loadRoleComposition(adapter, {
    worktreePath: context.worktreePath,
    readEnv: fixedEnvReader(context.env),
    codexHome: context.artifacts.codexHome,
  });
  const injection = computeRoleInjection(adapter, { body: role.body, bodyFingerprint }, composition);
  const name = buildArtifactName({
    namespace: context.namespace,
    roleId: role.id,
    injectionFingerprint: injection.injectionFingerprint,
  });
  const artifact = writeRoleArtifact({ adapter, name, instructions: injection.instructions }, context.artifacts);
  inspectRoleArtifact(
    { adapter, name, path: artifact.path, expectedFingerprint: artifact.artifactFingerprint },
    context.artifacts
  );
  const { args, env } = buildRoleLaunchArguments(injection, artifact, composition);
  const content = env[OPENCODE_CONFIG_CONTENT_ENV_VAR];
  return {
    linePrefix: content === undefined ? '' : `${OPENCODE_CONFIG_CONTENT_ENV_VAR}=${shellQuote(content)} `,
    lineSuffix: args.length > 0 ? ` ${renderRoleFlags(args)}` : '',
    condition: {
      roleId: role.id,
      bodyFingerprint,
      injectionFingerprint: injection.injectionFingerprint,
      artifactFingerprint: artifact.artifactFingerprint,
      adapter,
    },
  };
}
