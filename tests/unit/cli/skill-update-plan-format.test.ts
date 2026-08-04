/**
 * Issue #1243: `commandmate skill update-plan` output.
 *
 * The CLI shows the same facts the browser dialog shows — the version move,
 * the risk change, the security diff, the file totals and every blocker — and
 * never an absolute path, a token or an artifact URL, because the API does not
 * serve them and the formatter must not reconstruct them.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { formatUpdatePlan } from '@/cli/commands/skill-format';
import type { SkillUpdatePlan } from '@/cli/types/api-responses';

function makePlan(overrides: Partial<SkillUpdatePlan> = {}): SkillUpdatePlan {
  return {
    token: 'a'.repeat(48),
    expiresAt: '2026-08-05T00:10:00Z',
    updatable: true,
    blockers: [],
    nextActionKey: 'skills.update.nextAction.updatable',
    requiresRiskAcknowledgement: false,
    riskIncreased: false,
    update: {
      fromVersion: '1.2.0',
      toVersion: '1.3.0',
      latestVersion: '1.3.0',
      reasonCode: 'SKILL_UPDATE_RECOMMEND_HIGHEST_COMPATIBLE',
      prerelease: false,
    },
    target: {
      worktreeId: 'wt-1',
      worktreeName: 'demo-worktree',
      repositoryName: 'CommandMate',
      branch: 'feature/demo',
      headState: 'attached',
      workingTreeDirty: false,
      installRoot: '.agents/skills/release-helper',
      installRoots: ['.agents/skills/release-helper', '.claude/skills/release-helper'],
    },
    skill: {
      id: 'release-helper',
      name: 'Release Helper',
      version: '1.3.0',
      effectiveRisk: 'low',
      riskRationale: 'Reads bundled reference material only.',
      declaredPermissions: ['filesystem_read'],
      scriptPaths: [],
      compatibility: {
        commandmate: {
          status: 'compatible',
          message: 'CommandMate 0.11.4 satisfies the required range ">=0.11.0".',
          requiredRange: '>=0.11.0',
        },
      },
    },
    securityDiff: {
      risk: { from: { effective: 'low' }, to: { effective: 'low' }, increased: false },
      permissions: { added: [], removed: [] },
      executables: { added: [], removed: [] },
      scripts: { added: [], removed: [] },
      changelogs: [{ version: '1.3.0', changelog: 'Adds the new checklist.' }],
    },
    files: [{ path: '.agents/skills/release-helper/SKILL.md', change: 'update' }],
    stats: {
      added: 1,
      updated: 2,
      removed: 1,
      unchanged: 3,
      localModified: 0,
      localMissing: 0,
      localUnknown: 0,
      irregular: 0,
    },
    warnings: [],
    ...overrides,
  };
}

describe('formatUpdatePlan', () => {
  it('shows the version move, both install roots, the diff totals and the changelog', () => {
    const output = formatUpdatePlan(makePlan());

    expect(output).toContain('Update plan: Release Helper (release-helper) 1.2.0 -> 1.3.0');
    expect(output).toContain(
      '.agents/skills/release-helper, .claude/skills/release-helper'
    );
    expect(output).toContain('Changes:      +1 added, ~2 updated, -1 removed, =3 unchanged');
    expect(output).toContain('Changelog 1.3.0:');
    expect(output).toContain('Adds the new checklist.');
    expect(output).toContain('Updatable:    yes');
    // Never the token, never an absolute path.
    expect(output).not.toContain('a'.repeat(48));
    expect(output).not.toMatch(/\s\/(?:Users|home|tmp)\//);
  });

  it('renders a blocked plan with each blocker and its per-path detail', () => {
    const output = formatUpdatePlan(
      makePlan({
        updatable: false,
        nextActionKey: 'skills.update.nextAction.blocked',
        blockers: [
          {
            code: 'SKILL_UPDATE_LOCAL_CHANGES',
            path: '.agents/skills/release-helper/SKILL.md',
            detail: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
          },
        ],
        stats: {
          added: 1,
          updated: 2,
          removed: 1,
          unchanged: 3,
          localModified: 1,
          localMissing: 0,
          localUnknown: 0,
          irregular: 0,
        },
      })
    );

    expect(output).toContain('Updatable:    no — nothing would be written');
    expect(output).toContain(
      '- SKILL_UPDATE_LOCAL_CHANGES (SKILL_UNINSTALL_LOCAL_MODIFICATION): .agents/skills/release-helper/SKILL.md'
    );
    expect(output).toContain('Local:        1 modified, 0 missing, 0 unmanaged, 0 irregular');
  });

  it('marks a risk increase and both required confirmations', () => {
    const output = formatUpdatePlan(
      makePlan({
        requiresRiskAcknowledgement: true,
        riskIncreased: true,
        securityDiff: {
          risk: { from: { effective: 'low' }, to: { effective: 'high' }, increased: true },
          permissions: { added: ['process_execution'], removed: [] },
          executables: { added: ['scripts/run.sh'], removed: [] },
          scripts: { added: ['scripts/run.sh'], removed: [] },
          changelogs: [],
        },
      })
    );

    expect(output).toContain('Risk:         low -> high [RISK INCREASE]');
    expect(output).toContain('Perms added:  process_execution');
    expect(output).toContain('New scripts:  scripts/run.sh');
    expect(output).toContain('High risk:');
    expect(output).toContain('Risk rises:');
  });
});
