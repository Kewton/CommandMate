/**
 * E2E: Skill Catalog browse and detail (Issue #1242)
 *
 * The MVP gate asks whether a user can understand *what a Skill is and what it
 * would do* before installing it. The component tests answer that against a
 * mounted React tree; these answer it against the shipped pages in a browser,
 * at both a desktop and a mobile viewport, which is where the two things the
 * unit layer cannot see live: routing between list and detail, and whether the
 * content survives a 390px column.
 *
 * The Catalog API is stubbed in the browser (see fixtures/skills-helpers) —
 * the E2E server has no route to the upstream Catalog. Server behaviour is
 * covered by tests/integration/skills-mvp-*.test.ts.
 */

import { test, expect } from '@playwright/test';
import {
  MOBILE_VIEWPORT,
  SKILL_ID,
  makeCatalogMeta,
  makeSkill,
  makeVersion,
  routeSkillApis,
} from './fixtures/skills-helpers';

test.describe('Skill Catalog list', () => {
  test.beforeEach(async ({ page }) => {
    await routeSkillApis(page);
    await page.goto('/skills');
  });

  test('lists the Catalog entries with their identity and risk', async ({ page }) => {
    await expect(page.getByTestId(`skill-card-${SKILL_ID}`)).toBeVisible();
    await expect(page.getByTestId('skill-card-issue-refinement')).toBeVisible();
    await expect(page.getByTestId('skill-result-count')).toBeVisible();

    const card = page.getByTestId(`skill-card-${SKILL_ID}`);
    await expect(card).toContainText('Release Helper');
    await expect(card).toContainText('Walks an agent through the release checklist.');
  });

  test('narrows the list by search and restores it on reset', async ({ page }) => {
    await expect(page.getByTestId('skill-card-issue-refinement')).toBeVisible();

    await page.getByTestId('skill-search-input').fill('release');
    await expect(page.getByTestId(`skill-card-${SKILL_ID}`)).toBeVisible();
    await expect(page.getByTestId('skill-card-issue-refinement')).toBeHidden();

    await page.getByTestId('skill-filter-reset').click();
    await expect(page.getByTestId('skill-card-issue-refinement')).toBeVisible();
  });

  test('says the Catalog is unreachable instead of showing an empty Catalog', async ({ page }) => {
    // "No Skills exist" and "we could not reach the Catalog" lead a user to
    // opposite conclusions, so a retrieval failure must never render as empty.
    await page.route('**/api/skills', (route) =>
      route.fulfill({
        status: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'unreachable', code: 'SKILL_CATALOG_FETCH_FAILED' }),
      })
    );
    await page.goto('/skills');

    await expect(page.getByTestId('skill-catalog-error')).toBeVisible();
    await expect(page.getByTestId('skill-catalog-empty')).toHaveCount(0);
    await expect(page.getByTestId('skill-catalog-retry')).toBeVisible();
  });

  test('marks a stale Catalog as stale rather than presenting it as current', async ({ page }) => {
    await routeSkillApis(page, {
      catalog: makeCatalogMeta({
        stale: true,
        offline: true,
        state: 'stale',
        staleReason: 'SKILL_CATALOG_FETCH_FAILED',
      }),
    });
    await page.goto('/skills');

    await expect(page.getByTestId(`skill-card-${SKILL_ID}`)).toBeVisible();
    await expect(page.getByTestId('skill-catalog-stale')).toBeVisible();
    await expect(page.getByTestId('skill-catalog-fresh')).toHaveCount(0);
  });
});

test.describe('Skill detail', () => {
  test.beforeEach(async ({ page }) => {
    await routeSkillApis(page);
    await page.goto(`/skills/${SKILL_ID}`);
  });

  test('reaches the detail page from a Catalog card and back again', async ({ page }) => {
    await page.goto('/skills');
    // The card is itself the link to the detail route.
    await page.getByTestId(`skill-card-${SKILL_ID}`).click();

    await expect(page).toHaveURL(new RegExp(`/skills/${SKILL_ID}$`));
    await expect(page.getByTestId('skill-overview-section')).toBeVisible();

    await page.getByTestId('skill-detail-back').click();
    await expect(page).toHaveURL(/\/skills$/);
  });

  test('presents every section a user needs before deciding', async ({ page }) => {
    for (const section of [
      'skill-overview-section',
      'skill-capabilities-section',
      'skill-compatibility-section',
      'skill-risk-section',
      'skill-permissions-section',
      'skill-requirements-section',
      'skill-contents-section',
      'skill-versions-section',
    ]) {
      await expect(page.getByTestId(section)).toBeVisible();
    }

    // Permissions are a publisher declaration, and the page says so rather than
    // presenting them as something CommandMate verified.
    await expect(page.getByTestId('skill-permission-declaration-notice')).toBeVisible();
  });

  test('shows Agent support only for the Agents the publisher declared', async ({ page }) => {
    // The fixture declares claude and codex. Nothing may synthesise a verdict
    // for an Agent the manifest is silent about: rendering gemini as
    // "unsupported" would be a claim CommandMate has not measured, and
    // rendering it as CommandMate-runtime would be a capability it does not have.
    // Scoped to one section: the same badges are repeated per version card.
    const compatibility = page.getByTestId('skill-compatibility-section');
    await expect(compatibility.getByTestId('skill-agent-claude-native')).toBeVisible();
    await expect(compatibility.getByTestId('skill-agent-codex-native')).toBeVisible();

    // Page-wide, so a version card cannot smuggle one in either.
    for (const agent of ['gemini', 'opencode', 'vibe-local']) {
      for (const support of ['native', 'commandmate_runtime', 'unsupported', 'unknown']) {
        await expect(page.getByTestId(`skill-agent-${agent}-${support}`)).toHaveCount(0);
      }
    }
  });

  test('does not present a declared Agent claim as verified by CommandMate', async ({ page }) => {
    // The evidence the publisher supplied is shown verbatim, so a reader can see
    // what the claim rests on rather than only that a claim was made.
    const compatibility = page.getByTestId('skill-compatibility-section');
    await expect(compatibility).toContainText('Claude Code 2.1.220');
    await expect(compatibility).toContainText('Codex CLI 0.145.0');
  });

  test('warns on a high declared risk', async ({ page }) => {
    await routeSkillApis(page, {
      skills: [makeSkill({ versions: [makeVersion({ declaredRisk: 'high' })] })],
    });
    await page.goto(`/skills/${SKILL_ID}`);

    await expect(page.getByTestId('skill-high-risk-warning')).toBeVisible();
  });
});

test.describe('Skill Catalog on a mobile viewport', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test('browses the Catalog and opens a detail page at 390px', async ({ page }) => {
    await routeSkillApis(page);
    await page.goto('/skills');

    await expect(page.getByTestId(`skill-card-${SKILL_ID}`)).toBeVisible();

    await page.goto(`/skills/${SKILL_ID}`);
    for (const section of [
      'skill-overview-section',
      'skill-compatibility-section',
      'skill-risk-section',
      'skill-permissions-section',
    ]) {
      await expect(page.getByTestId(section)).toBeVisible();
    }
  });

  test('keeps the page from scrolling sideways', async ({ page }) => {
    await routeSkillApis(page);
    await page.goto(`/skills/${SKILL_ID}`);
    await expect(page.getByTestId('skill-overview-section')).toBeVisible();

    // A sha256 and an install root are both longer than 390px of text. They must
    // wrap, not push the document wider than the viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
