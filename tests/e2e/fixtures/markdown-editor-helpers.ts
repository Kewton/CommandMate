/**
 * E2E fixtures for the markdown editor indent specs (Issue #1518)
 *
 * The indent behaviour has to be proven with *real* key presses: the unit tests
 * use `fireEvent`, and this repo has been burned before by keyboard handling
 * that was green under `fireEvent` yet dead in a browser. Reaching the editor
 * needs a worktree, which the E2E server deliberately has none of
 * (playwright.config.ts pins an empty scan root), so — following the
 * terminal-split fixtures — the worktree API is mocked in the browser instead
 * of seeded on the server. That also keeps these specs from making worktrees
 * visible to the destructive specs running in parallel.
 */

import type { Page, Route } from '@playwright/test';

/** Worktree id scoped to these specs so it cannot collide with other suites. */
export const E2E_EDITOR_WORKTREE = 'e2e-editor-indent';

/** Fixture file served by the mocked file API. */
export const E2E_EDITOR_FILE = 'indent-fixture.md';

/** Initial content of the fixture. Deliberately free of MARP frontmatter,
 *  which would route the file to the slides editor instead. */
export const E2E_EDITOR_CONTENT = 'alpha\nbeta\n';

/** Editor state persisted in localStorage; cleared so every test starts equal. */
const EDITOR_STORAGE_KEYS = [
  'commandmate:md-editor-view-mode',
  'commandmate:md-editor-split-ratio',
  'commandmate:md-editor-maximized',
  'commandmate:md-editor-auto-save',
  'commandmate:md-editor-tab-moves-focus',
  'commandmate.worktree.filePanelCollapsed',
  `commandmate.worktree.activeActivity-${E2E_EDITOR_WORKTREE}`,
];

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

const WORKTREE = {
  id: E2E_EDITOR_WORKTREE,
  name: 'E2E editor indent',
  path: `/tmp/${E2E_EDITOR_WORKTREE}`,
  repositoryPath: `/tmp/${E2E_EDITOR_WORKTREE}-repo`,
  repositoryName: 'e2e-repo',
  repositoryDisplayName: 'E2E Repo',
  description: 'E2E markdown indent worktree',
  selectedAgents: ['claude'],
  cliToolId: 'claude',
  status: 'ready',
  sessionStatusByCli: {
    claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
  },
  gitStatus: {
    currentBranch: 'main',
    initialBranch: 'main',
    isBranchMismatch: false,
    commitHash: 'e2e0000',
    isDirty: false,
  },
};

const EMPTY_OUTPUT = {
  isRunning: false,
  cliToolId: 'claude',
  isGenerating: false,
  isPromptWaiting: false,
  content: '',
  fullOutput: '',
  realtimeSnippet: '',
  thinking: false,
  isSelectionListActive: false,
};

/**
 * Serve every `/api/...` request for this spec. Unhandled paths get an empty
 * but well-formed body so no fetch is left pending.
 */
export async function mockEditorApi(page: Page): Promise<void> {
  await page.addInitScript((keys: string[]) => {
    for (const key of keys) window.localStorage.removeItem(key);
  }, EDITOR_STORAGE_KEYS);

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const { pathname } = new URL(route.request().url());

      if (pathname.endsWith('/api/worktrees')) {
        return fulfillJson(route, [WORKTREE]);
      }

      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const sub = detailMatch[2] ?? '';

        if (sub === '') return fulfillJson(route, WORKTREE);
        if (sub.startsWith('/tree')) {
          return fulfillJson(route, {
            path: '',
            name: '',
            parentPath: null,
            items: [
              {
                name: E2E_EDITOR_FILE,
                type: 'file',
                size: E2E_EDITOR_CONTENT.length,
                extension: 'md',
                mtime: '2026-01-01T00:00:00.000Z',
              },
            ],
          });
        }
        if (sub.startsWith(`/files/${E2E_EDITOR_FILE}`)) {
          if (route.request().method() === 'PUT') {
            return fulfillJson(route, { success: true, path: E2E_EDITOR_FILE });
          }
          return fulfillJson(route, {
            success: true,
            path: E2E_EDITOR_FILE,
            content: E2E_EDITOR_CONTENT,
            extension: 'md',
            worktreePath: WORKTREE.path,
            totalBytes: E2E_EDITOR_CONTENT.length,
          });
        }
        if (sub.startsWith('/current-output')) return fulfillJson(route, EMPTY_OUTPUT);
        if (sub.startsWith('/slash-commands')) return fulfillJson(route, { groups: [] });
        if (
          sub.startsWith('/messages') ||
          sub.startsWith('/memos') ||
          sub.startsWith('/execution-logs') ||
          sub.startsWith('/schedules')
        ) {
          return fulfillJson(route, []);
        }
        return fulfillJson(route, {});
      }

      if (pathname.includes('/repositories') || pathname.includes('/tools')) {
        return fulfillJson(route, []);
      }
      return fulfillJson(route, {});
    }
  );
}
