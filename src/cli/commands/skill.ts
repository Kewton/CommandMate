/**
 * skill Command - manage official Agent Skills from the CLI
 * Issue #1237: a thin client over the Skill APIs (#1231/#1233/#1235/#1236)
 *
 *   commandmate skill list [--json]
 *   commandmate skill info <skill-id> [--version <v>] [--json]
 *   commandmate skill plan <skill-id> --worktree <id> [--version <v>] [--json]
 *   commandmate skill install <skill-id> --worktree <id> --version <exact> [--dry-run] [--yes] [--ack-risk <id>@<version>]
 *   commandmate skill uninstall <skill-id> --worktree <id> [--dry-run] [--yes] [--json]
 *   commandmate skill status <skill-id> --worktree <id> [--json]
 *
 * The CLI never downloads, extracts, writes or deletes anything: it asks the
 * server for a plan, shows it, and presents the token the server issued back to
 * the server unchanged. It reconstructs no file list, no checksum and no path —
 * those inputs are rejected by the API by design (#1233), and reproducing them
 * here would create exactly the UI/CLI security drift the design forbids.
 *
 * `--json` prints the API response body verbatim, so the JSON contract is the
 * API's. Every diagnostic, prompt and error goes to stderr, so a failed `--json`
 * run leaves stdout empty rather than half-written.
 */

import { Command } from 'commander';
import type {
  SkillInfoOptions,
  SkillInstallOptions,
  SkillListOptions,
  SkillPlanOptions,
  SkillStatusOptions,
  SkillUninstallOptions,
} from '../types';
import { ExitCode, SkillExitCode } from '../types';
import type {
  SkillDetailResponse,
  SkillInstallPlan,
  SkillInstallPlanResponse,
  SkillInstallResponse,
  SkillListResponse,
  SkillUninstallPlan,
  SkillUninstallPlanResponse,
  SkillUninstallResponse,
} from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING } from '../utils/command-helpers';
import {
  formatCatalogFreshness,
  formatInstallPlan,
  formatInstallRoots,
  formatSkillDetail,
  formatSkillTable,
  formatUninstallPlan,
} from './skill-format';
import {
  handleSkillCommandError,
  isValidSkillId,
  refuse,
  resolveWriteConfirmation,
  riskAcknowledgementMatches,
} from './skill-guards';

/** Validated `<skill-id>` plus `--worktree`, or null when either was rejected. */
function resolveTarget(
  skillId: string,
  worktree: string | undefined
): { skillId: string; worktreeId: string } | null {
  if (!isValidSkillId(skillId)) {
    refuse('Invalid Skill ID. Expected lowercase alphanumeric segments joined by hyphens.', ExitCode.CONFIG_ERROR);
    return null;
  }
  if (!worktree) {
    refuse('--worktree <id> is required. List candidates with: commandmate ls', ExitCode.CONFIG_ERROR);
    return null;
  }
  if (!isValidWorktreeId(worktree)) {
    refuse('Invalid worktree ID format.', ExitCode.CONFIG_ERROR);
    return null;
  }
  return { skillId, worktreeId: worktree };
}

function catalogQuery(options: { prerelease?: boolean }): string {
  return options.prerelease ? '?prerelease=true' : '';
}

// =============================================================================
// Read commands
// =============================================================================

async function listSkills(options: SkillListOptions): Promise<void> {
  const client = new ApiClient({ token: options.token });
  const response = await client.get<SkillListResponse>(`/api/skills${catalogQuery(options)}`);
  const body = assertResponseShape<SkillListResponse>(response, ['catalog', 'skills'], 'GET /api/skills');

  const freshness = formatCatalogFreshness(body.catalog);
  if (freshness) console.error(freshness);

  console.log(options.json ? JSON.stringify(body, null, 2) : formatSkillTable(body.skills));
}

async function showSkill(skillId: string, options: SkillInfoOptions): Promise<void> {
  if (!isValidSkillId(skillId)) {
    refuse('Invalid Skill ID. Expected lowercase alphanumeric segments joined by hyphens.', ExitCode.CONFIG_ERROR);
    return;
  }

  const client = new ApiClient({ token: options.token });
  const response = await client.get<SkillDetailResponse>(
    `/api/skills/${encodeURIComponent(skillId)}${catalogQuery(options)}`
  );
  const body = assertResponseShape<SkillDetailResponse>(
    response,
    ['catalog', 'skill'],
    `GET /api/skills/${skillId}`
  );

  const freshness = formatCatalogFreshness(body.catalog);
  if (freshness) console.error(freshness);

  console.log(
    options.json ? JSON.stringify(body, null, 2) : formatSkillDetail(body.skill, options.version)
  );
}

/** Ask the server to build an Install Plan. The only inputs are what to install. */
async function requestInstallPlan(
  client: ApiClient,
  target: { skillId: string; worktreeId: string },
  options: { version?: string; prerelease?: boolean }
): Promise<SkillInstallPlan> {
  const body: Record<string, unknown> = {};
  if (options.version) body.version = options.version;
  if (options.prerelease) body.includePrerelease = true;

  const response = await client.post<SkillInstallPlanResponse>(
    `/api/worktrees/${encodeURIComponent(target.worktreeId)}/skills/${encodeURIComponent(target.skillId)}/plan`,
    body
  );
  return assertResponseShape<SkillInstallPlanResponse>(response, ['plan'], 'POST .../skills/plan').plan;
}

/** Ask the server to build an Uninstall Plan. It takes no parameters at all. */
async function requestUninstallPlan(
  client: ApiClient,
  target: { skillId: string; worktreeId: string }
): Promise<SkillUninstallPlan> {
  const response = await client.post<SkillUninstallPlanResponse>(
    `/api/worktrees/${encodeURIComponent(target.worktreeId)}/skills/${encodeURIComponent(target.skillId)}/uninstall-plan`
  );
  return assertResponseShape<SkillUninstallPlanResponse>(
    response,
    ['plan'],
    'POST .../skills/uninstall-plan'
  ).plan;
}

async function planInstall(skillId: string, options: SkillPlanOptions): Promise<void> {
  const target = resolveTarget(skillId, options.worktree);
  if (!target) return;

  const client = new ApiClient({ token: options.token });
  const plan = await requestInstallPlan(client, target, options);

  console.log(options.json ? JSON.stringify({ plan }, null, 2) : formatInstallPlan(plan));
  if (!plan.installable) process.exit(SkillExitCode.BLOCKED);
}

/**
 * Report whether one Skill is installed in one worktree.
 *
 * Derived from the uninstall preview, which is the only endpoint that reports
 * installed state: it reads the on-disk receipt rather than the index, so what
 * it reports is evidence rather than a claim. It writes nothing. There is no
 * per-worktree listing endpoint yet, so `<skill-id>` is required.
 */
async function showStatus(skillId: string, options: SkillStatusOptions): Promise<void> {
  const target = resolveTarget(skillId, options.worktree);
  if (!target) return;

  const client = new ApiClient({ token: options.token });
  let plan: SkillUninstallPlan;
  try {
    plan = await requestUninstallPlan(client, target);
  } catch (error) {
    // Not installed is an answer, not a failure: `status` must be usable as a
    // precondition check without a script having to swallow an exit code.
    if (error instanceof ApiError && error.apiCode === 'SKILL_UNINSTALL_NOT_INSTALLED') {
      const notInstalled = { skillId: target.skillId, worktreeId: target.worktreeId, installed: false };
      console.log(
        options.json
          ? JSON.stringify(notInstalled, null, 2)
          : `${target.skillId} is not installed in ${target.worktreeId}.`
      );
      return;
    }
    throw error;
  }

  if (options.json) {
    console.log(JSON.stringify({ installed: true, plan }, null, 2));
    return;
  }
  console.log(
    [
      `${plan.skill.id} ${plan.skill.version} is installed in ${plan.target.worktreeId}.`,
      `Install root: ${plan.target.installRoot}`,
      `Risk:         ${plan.skill.effectiveRisk}`,
      `Removable:    ${plan.removable ? 'yes' : 'no'}`,
    ].join('\n')
  );
}

// =============================================================================
// Write commands
// =============================================================================

async function installSkill(skillId: string, options: SkillInstallOptions): Promise<void> {
  const target = resolveTarget(skillId, options.worktree);
  if (!target) return;
  if (!options.version) {
    refuse(
      '--version <exact> is required for install. Inspect published versions with: commandmate skill info ' + skillId,
      ExitCode.CONFIG_ERROR
    );
    return;
  }

  const client = new ApiClient({ token: options.token });
  const plan = await requestInstallPlan(client, target, options);

  // --dry-run stops here by construction: the plan is the whole output and no
  // token is ever presented back to the server.
  if (options.dryRun) {
    console.log(options.json ? JSON.stringify({ plan }, null, 2) : formatInstallPlan(plan));
    if (!plan.installable) process.exit(SkillExitCode.BLOCKED);
    return;
  }

  console.error(formatInstallPlan(plan));

  if (!plan.installable) {
    refuse('The Skill cannot be installed into this worktree; nothing was written.', SkillExitCode.BLOCKED);
    return;
  }

  // Checked before the generic confirmation so `--yes` alone can never carry a
  // high-risk install, in a TTY or out of one.
  if (
    plan.requiresRiskAcknowledgement &&
    !riskAcknowledgementMatches(options.ackRisk, plan.skill.id, plan.skill.version)
  ) {
    refuse(
      `${plan.skill.id} ${plan.skill.version} is high risk. Re-run with --ack-risk ${plan.skill.id}@${plan.skill.version} to acknowledge it explicitly.`,
      SkillExitCode.CONFIRMATION_REQUIRED
    );
    return;
  }

  const outcome = await resolveWriteConfirmation(
    `Install ${plan.skill.id} ${plan.skill.version} into ${plan.target.worktreeId} (${formatInstallRoots(plan.target.installRoots, plan.target.installRoot)})?`,
    options
  );
  if (outcome === 'non_interactive') {
    refuse(
      'Refusing to install without a confirmation. Pass --yes to install from a non-interactive environment.',
      SkillExitCode.CONFIRMATION_REQUIRED
    );
    return;
  }
  if (outcome === 'declined') {
    refuse('Install declined; nothing was written.', SkillExitCode.CONFIRMATION_REQUIRED);
    return;
  }

  const response = await client.post<SkillInstallResponse>(
    `/api/worktrees/${encodeURIComponent(target.worktreeId)}/skills/${encodeURIComponent(target.skillId)}/install`,
    {
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: plan.requiresRiskAcknowledgement,
    }
  );
  const body = assertResponseShape<SkillInstallResponse>(
    response,
    ['operation', 'install'],
    'POST .../skills/install'
  );

  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(
      `Installed ${body.install?.skillId ?? target.skillId} ${body.install?.version ?? plan.skill.version} into ${formatInstallRoots(body.install?.installRoots, body.install?.installRoot ?? plan.target.installRoot)}`
    );
  }

  if (body.operation.result === 'committed_reconciling') {
    // The payload is on disk; saying "install failed" would contradict what the
    // user can see. Report it as needing attention instead.
    console.error(
      `Warning: the files landed but the operation did not finish cleanly (${body.operation.nextActionKey}). Reconciliation will converge it.`
    );
    process.exit(SkillExitCode.COMMITTED_RECONCILING);
  }
}

async function uninstallSkill(skillId: string, options: SkillUninstallOptions): Promise<void> {
  const target = resolveTarget(skillId, options.worktree);
  if (!target) return;

  const client = new ApiClient({ token: options.token });
  const plan = await requestUninstallPlan(client, target);

  if (options.dryRun) {
    console.log(options.json ? JSON.stringify({ plan }, null, 2) : formatUninstallPlan(plan));
    if (!plan.removable) process.exit(SkillExitCode.BLOCKED);
    return;
  }

  console.error(formatUninstallPlan(plan));

  if (!plan.removable) {
    refuse('The uninstall is blocked by the paths listed above; nothing was deleted.', SkillExitCode.BLOCKED);
    return;
  }

  const outcome = await resolveWriteConfirmation(
    `Remove ${plan.skill.id} ${plan.skill.version} from ${plan.target.worktreeId} (${plan.target.installRoot})?`,
    options
  );
  if (outcome === 'non_interactive') {
    refuse(
      'Refusing to uninstall without a confirmation. Pass --yes to uninstall from a non-interactive environment.',
      SkillExitCode.CONFIRMATION_REQUIRED
    );
    return;
  }
  if (outcome === 'declined') {
    refuse('Uninstall declined; nothing was deleted.', SkillExitCode.CONFIRMATION_REQUIRED);
    return;
  }

  const response = await client.post<SkillUninstallResponse>(
    `/api/worktrees/${encodeURIComponent(target.worktreeId)}/skills/${encodeURIComponent(target.skillId)}/uninstall`,
    { planToken: plan.token }
  );
  const body = assertResponseShape<SkillUninstallResponse>(
    response,
    ['operation', 'uninstall'],
    'POST .../skills/uninstall'
  );

  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(
      `Removed ${body.uninstall?.skillId ?? target.skillId} ${body.uninstall?.version ?? plan.skill.version} from ${plan.target.installRoot}`
    );
  }

  for (const entry of body.uninstall?.retained ?? []) {
    console.error(`Retained: ${entry.path} (${entry.reason})`);
  }

  if (body.operation.result === 'committed_reconciling') {
    console.error(
      `Warning: deletion had already begun when the operation ended (${body.operation.nextActionKey}). Reconciliation will converge it.`
    );
    process.exit(SkillExitCode.COMMITTED_RECONCILING);
  }
}

// =============================================================================
// Wiring
// =============================================================================

export function createSkillCommand(): Command {
  const skill = new Command('skill');
  skill.description('Manage official Agent Skills (catalog, install plan, install, uninstall)');

  skill
    .command('list')
    .description('List Skills published in the official Catalog')
    .option('--json', 'JSON output (the API response body, verbatim)')
    .option('--prerelease', 'Include prerelease versions')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: SkillListOptions) => {
      try {
        await listSkills(options);
      } catch (error) {
        handleSkillCommandError(error);
      }
    });

  skill
    .command('info')
    .description('Show one Skill: capabilities, provider, versions and compatibility')
    .argument('<skill-id>', 'Skill ID from the Catalog')
    .option('--version <version>', 'Show only this published version')
    .option('--json', 'JSON output (the API response body, verbatim)')
    .option('--prerelease', 'Include prerelease versions')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (skillId: string, options: SkillInfoOptions) => {
      try {
        await showSkill(skillId, options);
      } catch (error) {
        handleSkillCommandError(error);
      }
    });

  skill
    .command('plan')
    .description('Preview installing a Skill into a worktree. Never writes.')
    .argument('<skill-id>', 'Skill ID from the Catalog')
    .option('--worktree <id>', 'Target worktree ID (see: commandmate ls)')
    .option('--version <version>', 'Exact version to plan (default: the recommended version)')
    .option('--json', 'JSON output (the API response body, verbatim)')
    .option('--prerelease', 'Include prerelease versions when resolving --version')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (skillId: string, options: SkillPlanOptions) => {
      try {
        await planInstall(skillId, options);
      } catch (error) {
        handleSkillCommandError(error);
      }
    });

  skill
    .command('install')
    .description('Install a Skill into a worktree, after showing the plan and confirming')
    .argument('<skill-id>', 'Skill ID from the Catalog')
    .option('--worktree <id>', 'Target worktree ID (see: commandmate ls)')
    .option('--version <version>', 'Exact version to install')
    .option('--dry-run', 'Build and print the plan, then stop without writing')
    .option('-y, --yes', 'Skip the confirmation prompt (required for non-interactive use)')
    .option(
      '--ack-risk <skill-id@version>',
      'Explicitly acknowledge a high-risk Skill. Required in addition to --yes.'
    )
    .option('--json', 'JSON output (the API response body, verbatim)')
    .option('--prerelease', 'Allow a prerelease --version')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (skillId: string, options: SkillInstallOptions) => {
      try {
        await installSkill(skillId, options);
      } catch (error) {
        handleSkillCommandError(error);
      }
    });

  skill
    .command('uninstall')
    .description('Remove an installed Skill from a worktree, after showing the plan and confirming')
    .argument('<skill-id>', 'Installed Skill ID')
    .option('--worktree <id>', 'Target worktree ID (see: commandmate ls)')
    .option('--dry-run', 'Build and print the plan, then stop without deleting')
    .option('-y, --yes', 'Skip the confirmation prompt (required for non-interactive use)')
    .option('--json', 'JSON output (the API response body, verbatim)')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (skillId: string, options: SkillUninstallOptions) => {
      try {
        await uninstallSkill(skillId, options);
      } catch (error) {
        handleSkillCommandError(error);
      }
    });

  skill
    .command('status')
    .description('Report whether a Skill is installed in a worktree, and whether it is removable')
    .argument('<skill-id>', 'Skill ID to look for')
    .option('--worktree <id>', 'Target worktree ID (see: commandmate ls)')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (skillId: string, options: SkillStatusOptions) => {
      try {
        await showStatus(skillId, options);
      } catch (error) {
        handleSkillCommandError(error);
      }
    });

  skill.addHelpText(
    'after',
    `
Confirmation contract:
  - Writes (install, uninstall) always build a plan first and print it.
  - Without a TTY, a write requires --yes; a missing --yes is refused, never assumed.
  - A high-risk Skill additionally requires --ack-risk <skill-id>@<version>.
    --yes alone never carries a high-risk install.
  - --dry-run stops at the plan and writes nothing.

Exit codes:
  0   success
  1   the server or the Catalog could not be reached
  2   invalid arguments, unknown Skill or unknown version
  11  the worktree refused the operation (local change, conflict, lock, plan drift)
  12  the write was never confirmed (no --yes, declined, or missing --ack-risk)
  13  the files changed but the operation needs reconciliation
`
  );

  return skill;
}
