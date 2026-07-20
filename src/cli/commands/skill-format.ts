/**
 * skill command output formatting
 * Issue #1237: renders Catalog entries and plans in the same vocabulary the UI
 * uses (capability, effect, provenance, risk, target, diff, next action) so a
 * user reading `--help` and one reading the browser see the same thing.
 *
 * Nothing here prints an absolute path, a token or an artifact URL: the API does
 * not serve them, and these functions must not reconstruct them either.
 */

import type {
  SkillCatalogMeta,
  SkillCatalogSummary,
  SkillInstallPlan,
  SkillUninstallPlan,
} from '../types/api-responses';

/** [DR1-08 consistency] Mirrors ls.ts / instances.ts table rendering. */
function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length))
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  return [
    line(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

/**
 * Freshness notice for a Catalog response, or null when it was confirmed current.
 * Belongs on stderr: it qualifies the listing rather than being part of it.
 */
export function formatCatalogFreshness(catalog: SkillCatalogMeta): string | null {
  if (!catalog.stale) return null;
  const reason = catalog.staleReason ?? catalog.state;
  return `Warning: showing the last known good Catalog (${reason}); it could not be confirmed current.`;
}

export function formatSkillTable(skills: SkillCatalogSummary[]): string {
  if (skills.length === 0) return 'No Skills are published in the official Catalog.';

  return formatTable(
    ['SKILL_ID', 'NAME', 'LATEST', 'RECOMMENDED', 'COMPATIBILITY'],
    skills.map((skill) => [
      skill.id,
      skill.name,
      skill.latest,
      skill.recommendedVersion ?? '-',
      skill.compatibility?.status ?? 'unknown',
    ])
  );
}

export function formatSkillDetail(skill: SkillCatalogSummary, version?: string): string {
  const lines: string[] = [
    `${skill.name} (${skill.id})`,
    skill.summary,
    '',
    `Provider:     ${skill.provider.name}`,
    `License:      ${skill.license}`,
    `Latest:       ${skill.latest}`,
    `Recommended:  ${skill.recommendedVersion ?? '-'} (${skill.recommendedReason})`,
  ];
  if (skill.homepage) lines.push(`Homepage:     ${skill.homepage}`);
  if (skill.compatibility) {
    lines.push(`Compatibility: ${skill.compatibility.status} — ${skill.compatibility.message}`);
  }

  const versions = version
    ? skill.versions.filter((entry) => entry.version === version)
    : skill.versions;
  lines.push('', 'Versions:');
  if (versions.length === 0) {
    lines.push(
      version
        ? `  (no published version ${version}; pass --prerelease if it is a prerelease)`
        : '  (none listed; pass --prerelease to include prereleases)'
    );
  } else {
    lines.push(
      formatTable(
        ['VERSION', 'RISK', 'PRERELEASE', 'COMPATIBILITY', 'PUBLISHED'],
        versions.map((entry) => [
          entry.version,
          entry.declaredRisk,
          entry.prerelease ? 'yes' : 'no',
          entry.compatibility.commandmate.status,
          entry.publishedAt,
        ])
      )
        .split('\n')
        .map((row) => `  ${row}`)
        .join('\n')
    );
  }
  return lines.join('\n');
}

function formatList(label: string, values: readonly string[]): string {
  return `${label}${values.length > 0 ? values.join(', ') : '(none)'}`;
}

/** The install preview: what lands, where, at what risk, and what stands in the way. */
export function formatInstallPlan(plan: SkillInstallPlan): string {
  const { skill, target, stats } = plan;
  const lines: string[] = [
    `Install plan: ${skill.name} ${skill.version} (${skill.id})`,
    skill.summary,
    '',
    `Target:       ${target.repositoryName} / ${target.worktreeName} (${target.worktreeId})`,
    `Branch:       ${target.branch ?? `(${target.headState})`}${target.workingTreeDirty ? ' [working tree dirty]' : ''}`,
    `Install root: ${target.installRoot}`,
    `Risk:         ${skill.effectiveRisk} — ${skill.riskRationale}`,
    `Compatibility: ${skill.compatibility.commandmate.status} — ${skill.compatibility.commandmate.message}`,
    formatList('Permissions:  ', skill.declaredPermissions),
    formatList('Scripts:      ', skill.scriptPaths),
    formatList(
      'Requires:     ',
      skill.requirements.commands.map((command) =>
        command.versionRange ? `${command.name} ${command.versionRange}` : command.name
      )
    ),
    formatList('Network:      ', skill.requirements.networkHosts),
    `Changes:      +${stats.added} added, ~${stats.modified} modified, =${stats.unchanged} unchanged, !${stats.conflicted} conflicting, ?${stats.unmanaged} unmanaged`,
  ];

  if (target.existingInstall) {
    lines.push(`Already installed: ${target.existingInstall.version}`);
  }
  if (plan.warnings.length > 0) {
    lines.push(`Warnings:     ${plan.warnings.join(', ')}`);
  }
  if (plan.blockers.length > 0) {
    lines.push('Blockers:');
    for (const blocker of plan.blockers) {
      lines.push(`  - ${blocker.code}${blocker.path ? `: ${blocker.path}` : ''}`);
    }
  }
  lines.push(
    plan.installable
      ? 'Installable:  yes'
      : 'Installable:  no — nothing would be written'
  );
  if (plan.requiresRiskAcknowledgement) {
    lines.push(
      `High risk:    installing requires --ack-risk ${skill.id}@${skill.version} in addition to --yes`
    );
  }
  return lines.join('\n');
}

/** The uninstall preview: what would be deleted, what would stay, and why. */
export function formatUninstallPlan(plan: SkillUninstallPlan): string {
  const { skill, target, stats } = plan;
  const lines: string[] = [
    `Uninstall plan: ${skill.id} ${skill.version}`,
    '',
    `Target:       ${target.repositoryName} / ${target.worktreeName} (${target.worktreeId})`,
    `Branch:       ${target.branch ?? '(detached)'}${target.workingTreeDirty ? ' [working tree dirty]' : ''}`,
    `Install root: ${target.installRoot}`,
    `Risk:         ${skill.effectiveRisk}`,
    `Files:        ${stats.removable} removable, ${stats.modified} locally modified, ${stats.missing} missing, ${stats.unknown} unmanaged, ${stats.irregular} irregular`,
    `Removable:    ${plan.removable ? 'yes' : 'no — nothing would be deleted'}`,
  ];

  if (plan.retained.length > 0) {
    lines.push('Retained:');
    for (const entry of plan.retained) {
      lines.push(`  - ${entry.path} (${entry.reason})`);
    }
  }
  if (plan.blockers.length > 0) {
    lines.push('Blockers:');
    for (const blocker of plan.blockers) {
      lines.push(`  - ${blocker.code}${blocker.path ? `: ${blocker.path}` : ''}`);
    }
  }
  lines.push(`Next action:  ${plan.nextActionKey}`);
  return lines.join('\n');
}
