import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Playwright configuration.
 *
 * [Issue #1180] The E2E run is fully isolated from a developer's live CommandMate
 * instance. Previously this config used `baseURL: localhost:3000` with
 * `reuseExistingServer: !process.env.CI`, so running `npm run test:e2e` on a
 * machine with CommandMate already running would silently attach to that server:
 * the suite tested stale code instead of the working tree, and — because the specs
 * create, mutate and delete worktree files — it drove the developer's production
 * instance. Isolation rests on four things that must stay together:
 *
 *   1. A dedicated port (3177, never 3000) so we cannot reach a live instance.
 *   2. `reuseExistingServer: false` so Playwright always boots its own server on
 *      that port rather than adopting whatever happens to be listening.
 *   3. `CM_DB_PATH` pinned to a scratch DB, so no test can write the real one.
 *   4. `CM_ROOT_DIR` pinned to an empty directory that is **not inside a git
 *      repository**, so the server's worktree scan finds nothing.
 *
 * (4) is the subtle one. The scan is `git worktree list` run with `cwd: CM_ROOT_DIR`
 * (src/lib/git/worktrees.ts). Git resolves a repository by walking *up* from that
 * cwd, so a scratch root placed inside the checkout — e.g. `<repo>/.e2e-tmp` — makes
 * the scan enumerate every real worktree of the repo, handing destructive specs
 * (recursive-delete, file-tree-operations) the developer's actual source trees.
 * Being gitignored does not help: git discovery ignores .gitignore. Hence the state
 * dir lives under $HOME, `GIT_CEILING_DIRECTORIES` blocks upward discovery, and the
 * guard below fails loudly if the root is ever inside a work tree anyway.
 *
 * $HOME rather than os.tmpdir() because `validateDbPath` rejects any DB path under
 * /tmp or /var as a system directory (src/config/system-directories.ts), and
 * os.tmpdir() resolves under /var on macOS and /tmp on Linux.
 *
 * Override the port with `CM_E2E_PORT` when 3177 is taken. Port 3000 is rejected.
 */

const DEFAULT_E2E_PORT = 3177;

/** The port a developer's real CommandMate instance uses. Never test against it. */
const FORBIDDEN_PORT = 3000;

function resolveE2EPort(): number {
  const raw = process.env.CM_E2E_PORT;
  if (raw === undefined || raw === '') {
    return DEFAULT_E2E_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(
      `CM_E2E_PORT must be an integer between 1024 and 65535, received: ${raw}`
    );
  }
  if (parsed === FORBIDDEN_PORT) {
    throw new Error(
      `CM_E2E_PORT must not be ${FORBIDDEN_PORT}: that is the default CommandMate port. ` +
        `Pointing E2E at it risks driving a live server and its production DB (Issue #1180).`
    );
  }
  return parsed;
}

const PORT = resolveE2EPort();

// `localhost` (not 127.0.0.1) is deliberate: locale-switcher.spec.ts seeds cookies
// with `domain: 'localhost'`, which only match a localhost origin.
const BASE_URL = `http://localhost:${PORT}`;

/** Throwaway server state. Safe to delete at any time; recreated on each run. */
const E2E_STATE_DIR = path.join(os.homedir(), '.commandmate-e2e');
const E2E_DB_PATH = path.join(E2E_STATE_DIR, 'cm-e2e.db');
const E2E_ROOT_DIR = path.join(E2E_STATE_DIR, 'worktrees');

/** Stops `git worktree list` from discovering a repo above the scratch root. */
const GIT_CEILING_DIRECTORIES = E2E_STATE_DIR;

// Created at config load rather than in globalSetup: Playwright boots `webServer`
// before globalSetup runs, and the server needs both paths to exist. mkdir -p is
// idempotent, which matters because workers re-import this config.
fs.mkdirSync(E2E_ROOT_DIR, { recursive: true });

/**
 * Fail closed if the scan root is inside a git work tree — that would expose real
 * worktrees to the suite. Checked with the same GIT_CEILING_DIRECTORIES the server
 * gets, so this asserts exactly what the server's scan will see.
 */
function assertScanRootIsNotInGitRepo(): void {
  let output: string;
  try {
    output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: E2E_ROOT_DIR,
      env: { ...process.env, GIT_CEILING_DIRECTORIES },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Non-zero exit means "not a git repository" — exactly what we want.
    return;
  }

  if (output.trim() === 'true') {
    throw new Error(
      `E2E scan root ${E2E_ROOT_DIR} is inside a git repository. The server would ` +
        `enumerate that repo's real worktrees and destructive specs could edit or ` +
        `delete real files (Issue #1180). Remove the enclosing repository or move ` +
        `the state dir.`
    );
  }
}

assertScanRootIsNotInGitRepo();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  /**
   * [Issue #1180] Chromium only. There was a second `Mobile Safari`
   * (iPhone 13) project, which re-ran the *whole* suite under a 390px WebKit
   * profile. That was never a working configuration — the collection error in
   * locale-switcher.spec.ts meant the suite had not run at all — and it cannot
   * pass as written: these specs assert desktop chrome, and on a mobile viewport
   * AppShell renders no `<header>` at all and parks the sidebar off-screen as a
   * closed drawer. Worse, it was actively misleading: `useIsMobile` seeds `false`
   * to match SSR, so a slow (cold-compile) hydration let assertions land on the
   * un-hydrated *desktop* markup and pass, while a warm run failed the same
   * assertions. Results tracked compile timing rather than the product.
   *
   * Mobile coverage is not lost — it lives in the specs that opt into a mobile
   * viewport explicitly (locale-switcher's mobile describe, worktree-list's
   * responsive case, cli-tool-selection, file-search's Mobile View,
   * mobile-cmate-tab), which run here under Chromium's device emulation. The
   * terminal-split specs already `test.skip(browserName !== 'chromium')`.
   *
   * Keeping one project also keeps local and CI identical, which is the whole
   * point of wiring E2E into CI: a second engine CI does not install is exactly
   * how this suite drifted out of sight in the first place. Reintroducing WebKit
   * means making the desktop-chrome specs viewport-aware first.
   */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    // Never adopt an already-running server: on a dev machine the process listening
    // here would be unrelated to the working tree (Issue #1180).
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // `npm run dev` must actually run Next in dev mode. Inherited env can carry
      // NODE_ENV=production (server.ts derives `dev` from it), which makes the
      // server demand a prebuilt .next and exit before any test runs.
      NODE_ENV: 'development',
      CM_PORT: String(PORT),
      CM_BIND: '127.0.0.1',
      // Pinned scratch paths. Playwright merges these over process.env, and Next's
      // .env loader never overrides an already-set variable, so a repo .env pointing
      // at the production DB cannot win here.
      CM_DB_PATH: E2E_DB_PATH,
      CM_ROOT_DIR: E2E_ROOT_DIR,
      GIT_CEILING_DIRECTORIES,
      CM_LOG_LEVEL: 'warn',
    },
  },
});
