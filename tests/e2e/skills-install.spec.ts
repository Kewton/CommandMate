/**
 * E2E: Skill install / uninstall through the browser (Issue #1242)
 *
 * The MVP gate's manual criterion is that a user can see *what would change*
 * — target, install roots, declared permissions, scripts, risk and the per-file
 * diff — and only then approve it, on desktop and on mobile. These specs pin
 * that in the shipped pages, and pin the two refusals that make the preview
 * meaningful:
 *
 *   - a high-risk package is not applied until it is acknowledged, and the
 *     apply request does not leave the browser before then (the server's
 *     `SKILL_PLAN_RISK_NOT_ACKNOWLEDGED` stays a backstop, not the gate);
 *   - a blocked plan is rendered as "nothing was written, and here is what is in
 *     the way" rather than swallowed into a generic failure.
 *
 * The request log asserts the negative — that no apply was sent — which is the
 * half a screenshot cannot show.
 *
 * Write routes are stubbed in the browser; the real transaction, its fail-closed
 * refusals and its on-disk allowlist live in
 * tests/integration/skills-mvp-install-flow.test.ts and
 * skills-mvp-security-regression.test.ts.
 */

import { test, expect } from '@playwright/test';
import {
  HIGH_RISK_SKILL_ID,
  MOBILE_VIEWPORT,
  SKILL_ID,
  WORKTREE_ID,
  makeHighRiskInstallPlan,
  makeHighRiskSkill,
  makeInstallPlan,
  makeSkill,
  routeSkillApis,
} from './fixtures/skills-helpers';

test.describe('Install preview', () => {
  test('shows the target, both install roots and the file diff before anything is applied', async ({
    page,
  }) => {
    const log = await routeSkillApis(page);
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();

    const plan = page.getByTestId('skill-install-plan');
    await expect(plan).toBeVisible();

    // Which checkout, on which branch — the question a misplaced install answers
    // too late.
    await expect(plan).toContainText('feature/demo');
    await expect(plan).toContainText('CommandMate');

    // #1460: an install writes to both discovery roots, so the approval has to
    // name both. Showing only `.agents/skills` would be approval for something
    // narrower than what happens.
    await expect(plan).toContainText('.agents/skills/release-helper');
    await expect(plan).toContainText('.claude/skills/release-helper');

    await expect(page.getByTestId('skill-plan-risk-section')).toBeVisible();
    await expect(page.getByTestId('skill-plan-permissions')).toBeVisible();
    await expect(page.getByTestId('skill-plan-requirements')).toBeVisible();
    await expect(page.getByTestId('skill-plan-files')).toBeVisible();
    await expect(page.getByTestId('skill-plan-stats')).toBeVisible();

    await expect(
      page.getByTestId('skill-plan-file-.agents/skills/release-helper/SKILL.md')
    ).toBeVisible();

    // Previewing is not applying.
    expect(log.matching('install')).toHaveLength(0);
  });

  test('lists the scripts a package would install', async ({ page }) => {
    await routeSkillApis(page, {
      skills: [makeHighRiskSkill()],
      installPlan: makeHighRiskInstallPlan(),
    });
    await page.goto(`/skills/${HIGH_RISK_SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();

    const scripts = page.getByTestId('skill-plan-scripts');
    await expect(scripts).toBeVisible();
    await expect(scripts).toContainText('scripts/run.sh');
  });

  test('discards a plan without applying it', async ({ page }) => {
    const log = await routeSkillApis(page);
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();
    await expect(page.getByTestId('skill-install-plan')).toBeVisible();

    await page.getByTestId('skill-install-discard').click();
    await expect(page.getByTestId('skill-install-plan')).toHaveCount(0);
    expect(log.matching('install')).toHaveLength(0);
  });
});

test.describe('Install approval', () => {
  test('applies the previewed plan and says how to reload each Agent', async ({ page }) => {
    const log = await routeSkillApis(page);
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();
    await page.getByTestId('skill-install-confirm').click();

    await expect(page.getByTestId('skill-install-result')).toBeVisible();
    await expect(page.getByTestId('skill-operation-reload')).toBeVisible();

    const applies = log.matching('install');
    expect(applies).toHaveLength(1);
    // The token that was previewed is the token that is spent, so what was
    // approved and what was executed are the same plan.
    expect((applies[0].body as { planToken?: string }).planToken).toBe(makeInstallPlan().token);
  });

  test('does not send the apply until a high-risk package is acknowledged', async ({ page }) => {
    const log = await routeSkillApis(page, {
      skills: [makeHighRiskSkill()],
      installPlan: makeHighRiskInstallPlan(),
    });
    await page.goto(`/skills/${HIGH_RISK_SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();

    await expect(page.getByTestId('skill-install-risk-acknowledgement')).toBeVisible();
    const confirm = page.getByTestId('skill-install-confirm');
    await expect(confirm).toBeDisabled();
    expect(log.matching('install')).toHaveLength(0);

    await page.getByTestId('skill-install-risk-checkbox').click();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    const applies = log.matching('install');
    expect(applies).toHaveLength(1);
    expect((applies[0].body as { acknowledgeRisk?: boolean }).acknowledgeRisk).toBe(true);
  });

  test('renders a blocked plan as a refusal with its reasons, and applies nothing', async ({
    page,
  }) => {
    const blocked = makeInstallPlan({
      installable: false,
      blockers: [
        {
          code: 'SKILL_DIFF_UNMANAGED_FILE',
          path: '.agents/skills/release-helper/SKILL.md',
        },
      ],
    });
    const log = await routeSkillApis(page, { installPlan: blocked });
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();

    await expect(page.getByTestId('skill-install-blockers')).toBeVisible();
    await expect(page.getByTestId('skill-install-confirm')).toBeDisabled();
    expect(log.matching('install')).toHaveLength(0);
  });

  test('reports a rejected plan request with the code the server returned', async ({ page }) => {
    const log = await routeSkillApis(page, {
      installPlanError: {
        status: 409,
        body: { error: 'stale', code: 'SKILL_PLAN_STALE' },
      },
    });
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();

    const error = page.getByTestId('skill-operation-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('SKILL_PLAN_STALE');
    expect(log.matching('install')).toHaveLength(0);
  });
});

test.describe('Uninstall', () => {
  test('previews what would be removed, then removes it', async ({ page }) => {
    const log = await routeSkillApis(page);
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-uninstall-action').click();

    const plan = page.getByTestId('skill-uninstall-plan');
    await expect(plan).toBeVisible();
    await expect(
      page.getByTestId('skill-uninstall-file-.agents/skills/release-helper/SKILL.md')
    ).toBeVisible();
    await expect(page.getByTestId('skill-uninstall-stats')).toBeVisible();
    expect(log.matching('uninstall')).toHaveLength(0);

    await page.getByTestId('skill-uninstall-confirm').click();
    await expect(page.getByTestId('skill-uninstall-result')).toBeVisible();
    expect(log.matching('uninstall')).toHaveLength(1);
  });
});

test.describe('Install on a mobile viewport', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test('completes target → preview → approve at 390px', async ({ page }) => {
    const log = await routeSkillApis(page, { skills: [makeSkill()] });
    await page.goto(`/skills/${SKILL_ID}`);

    await page.getByTestId(`skill-target-option-${WORKTREE_ID}`).click();
    await page.getByTestId('skill-install-action').click();

    const plan = page.getByTestId('skill-install-plan');
    await expect(plan).toBeVisible();
    await expect(plan).toContainText('.claude/skills/release-helper');
    await expect(page.getByTestId('skill-plan-files')).toBeVisible();

    // The approval control has to be reachable, not merely present. A long
    // preview puts it below the fold — that is fine — but after scrolling it
    // must actually sit inside the 390px column and take the click, which is
    // what a clipped or overlapped button would fail.
    const confirm = page.getByTestId('skill-install-confirm');
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await confirm.click();

    await expect(page.getByTestId('skill-install-result')).toBeVisible();
    expect(log.matching('install')).toHaveLength(1);
  });
});
