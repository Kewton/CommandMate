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
  renderRoleFlags,
  renderSecretEnvAssignment,
  splitRoleEnv,
} from './adapters';
import {
  buildArtifactName,
  inspectRoleArtifact,
  removeLaunchEnvFile,
  writeLaunchEnvFile,
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
  /**
   * Remove the private file holding a composed env, once the line has run. The
   * caller's to call whichever way the launch ends. Safe to call twice.
   */
  release: () => void;
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
  const prepared = buildRoleLaunchArguments(injection, artifact, composition);
  const { plain, secret } = splitRoleEnv(prepared);
  const { args } = prepared;
  // As a launch does: a line gets logged and a pane shows it, and the user's values
  // may be secrets, so those go through a private file for the length of the launch.
  const envFile = secret === null ? null : writeLaunchEnvFile(adapter, secret, context.artifacts);
  const assignments = Object.entries(plain).map(([name, value]) => `${name}=${shellQuote(value)} `);
  return {
    linePrefix: `${envFile === null ? '' : renderSecretEnvAssignment(envFile)}${assignments.join('')}`,
    lineSuffix: args.length > 0 ? ` ${renderRoleFlags(args)}` : '',
    condition: {
      roleId: role.id,
      bodyFingerprint,
      injectionFingerprint: injection.injectionFingerprint,
      artifactFingerprint: artifact.artifactFingerprint,
      adapter,
    },
    release: () => {
      if (envFile !== null) removeLaunchEnvFile(envFile);
    },
  };
}
