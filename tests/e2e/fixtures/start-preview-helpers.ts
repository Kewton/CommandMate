/**
 * Shared `GET /api/worktrees/:id/mem/start-preview` mock for the E2E specs that mock the
 * worktree API (Issue #4227 G-PR6 follow-up).
 *
 * G-PR6: a plain send reads the start preview first and, when it cannot be read, sends NOTHING
 * and keeps the draft. A spec that mocks the API wholesale without this route therefore never
 * reaches `/send`. Every file that mocks the worktree API calls `mockStartPreview` — never a
 * per-spec route (guarded by tests/unit/guards/e2e-send-mock-start-preview-4227.test.ts).
 *
 * The answer is the production response when mem has no popup to show: nothing to ask, unattended.
 * Call it AFTER the catch-all `/api/` route: Playwright tries the last-registered route first.
 */
import type { BrowserContext, Page } from '@playwright/test';

export const START_PREVIEW_BODY = { ok: true, show: false, attended: false } as const;

export async function mockStartPreview(target: Page | BrowserContext): Promise<void> {
  await target.route(
    url => /^\/api\/worktrees\/[^/]+\/mem\/start-preview$/.test(url.pathname),
    route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(START_PREVIEW_BODY),
      }),
  );
}
