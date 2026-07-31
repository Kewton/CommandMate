/**
 * record-scenes.ts — record CommandMate demo scenes with Playwright.
 *
 * Playwright is used as a *library*, not as the test runner: each scene gets its
 * own `browser.newContext({ recordVideo })`, so closing the context yields one
 * webm per scene rather than one video for a whole spec file.
 *
 * Every scene synchronises on an observable server state before it starts the
 * action it means to film. `page.waitForTimeout` is only ever used to hold a
 * finished frame on screen, never to decide that something has happened —
 * otherwise the footage would track compile timing rather than the product.
 *
 * Run against the isolated instance that env-up.sh started:
 *   npx tsx .claude/skills/demo-video/scripts/record-scenes.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import type { BrowserContext, Locator, Page } from '@playwright/test';

export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export interface RecordOptions {
  /** Path to the state file env-up.sh wrote. */
  statePath: string;
  /** Directory the webm files are written to. Never inside the repository. */
  outDir: string;
  /** Scene ids to record; empty means "all". */
  sceneIds: string[];
  locale: Locale;
  colorScheme: 'light' | 'dark';
  /** Viewport for `pc` scenes; `mobile` scenes always use MOBILE_VIEWPORT. */
  viewport: { width: number; height: number };
  /** Message typed into the composer in the send-message scene. */
  message: string;
  /** Worktree the send-message scene drives. */
  worktreeId: string;
  /** Upper bound for a single synchronisation point, in ms. */
  timeoutMs: number;
  headless: boolean;
  /** Repository root, used to read the locale dictionaries the UI renders from. */
  repoRoot: string;
}

export interface DemoState {
  baseUrl: string;
  videoDir: string;
  [key: string]: string;
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/**
 * iPhone 13 logical viewport, matching what the e2e suite uses. Comfortably
 * below useIsMobile's 768px breakpoint (src/hooks/useIsMobile.ts), so the
 * mobile shell — and with it MobilePromptSheet — is what gets filmed.
 */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** `cmdemo-app` + `feature/demo-dark-mode`, slugged by generateWorktreeId(). */
export const DEFAULT_WORKTREE_ID = 'cmdemo-app-feature-demo-dark-mode';
/**
 * `cmdemo-app` + `feature/demo-api-cache`, the worktree env-up.sh adds *after*
 * the server has booted. The boot sync in server.ts has already run by then, so
 * this id is on disk and missing from the database until a sync is triggered —
 * the precondition the `sync-worktrees` scene films.
 */
export const UNSYNCED_WORKTREE_ID = 'cmdemo-app-feature-demo-api-cache';
export const DEFAULT_MESSAGE = 'Add a dark mode toggle to the header';

/** The unregistered repository env-up.sh seeds for the `add-repository` scene. */
export function secondSeedRepository(state: DemoState): string {
  const target = state.CM_DEMO_SEED_REPO_2;
  if (!target) {
    throw new Error('state file has no CM_DEMO_SEED_REPO_2 — re-run env-up.sh');
  }
  return target;
}

function defaultStatePath(): string {
  const home = process.env.CM_DEMO_HOME ?? path.join(os.homedir(), '.commandmate-demo');
  return path.join(home, 'state.env');
}

export function parseStateFile(contents: string): DemoState {
  const state: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    state[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  const baseUrl = state.CM_DEMO_BASE_URL;
  if (!baseUrl) {
    throw new Error('state file has no CM_DEMO_BASE_URL — was env-up.sh run?');
  }
  if (new URL(baseUrl).port === '3000') {
    throw new Error(
      `refusing to record against ${baseUrl}: port 3000 is a developer's live CommandMate instance`,
    );
  }
  return { ...state, baseUrl, videoDir: state.CM_DEMO_VIDEO_DIR ?? '' };
}

function parseViewport(raw: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (!match) throw new Error(`--viewport must look like 1280x800, got '${raw}'`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function parseRecordArgs(argv: string[]): RecordOptions {
  const options: RecordOptions = {
    statePath: defaultStatePath(),
    outDir: '',
    sceneIds: [],
    locale: 'en',
    colorScheme: 'light',
    viewport: { ...DEFAULT_VIEWPORT },
    message: DEFAULT_MESSAGE,
    worktreeId: DEFAULT_WORKTREE_ID,
    timeoutMs: 60_000,
    headless: true,
    // <repo>/.claude/skills/demo-video/scripts, and byte-identically
    // <repo>/.agents/skills/demo-video/scripts — four levels up either way.
    repoRoot: path.resolve(__dirname, '../../../..'),
  };

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--state': options.statePath = next(i, arg); i += 1; break;
      case '--out': options.outDir = next(i, arg); i += 1; break;
      case '--scene': options.sceneIds.push(next(i, arg)); i += 1; break;
      case '--locale': {
        const value = next(i, arg);
        if (!LOCALES.includes(value as Locale)) {
          throw new Error(`--locale must be one of ${LOCALES.join('|')}, got '${value}'`);
        }
        options.locale = value as Locale;
        i += 1;
        break;
      }
      case '--theme': {
        const value = next(i, arg);
        if (value !== 'light' && value !== 'dark') {
          throw new Error(`--theme must be light or dark, got '${value}'`);
        }
        options.colorScheme = value;
        i += 1;
        break;
      }
      case '--viewport': options.viewport = parseViewport(next(i, arg)); i += 1; break;
      case '--repo-root': options.repoRoot = next(i, arg); i += 1; break;
      case '--message': options.message = next(i, arg); i += 1; break;
      case '--worktree': options.worktreeId = next(i, arg); i += 1; break;
      case '--timeout': {
        const value = Number(next(i, arg));
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--timeout must be a positive number of ms, got '${argv[i + 1]}'`);
        }
        options.timeoutMs = value;
        i += 1;
        break;
      }
      case '--headed': options.headless = false; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  const unknownScenes = options.sceneIds.filter((id) => !SCENES.some((s) => s.id === id));
  if (unknownScenes.length > 0) {
    throw new Error(
      `unknown scene(s): ${unknownScenes.join(', ')}. Known: ${SCENES.map((s) => s.id).join(', ')}`,
    );
  }

  return options;
}

// ---------------------------------------------------------------- sync -------

interface WorktreeSummary {
  id: string;
  isSessionRunning?: boolean;
  isProcessing?: boolean;
  isWaitingForResponse?: boolean;
}

export interface WaitDeps {
  fetchJson: (url: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultWaitDeps: WaitDeps = {
  fetchJson: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    return (await response.json()) as unknown;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Poll a JSON endpoint until `read`'s projection satisfies `predicate`.
 *
 * `read` is separate from `predicate` so the timeout message can print the
 * projection — "last seen: []" tells the operator which endpoint stayed empty,
 * where a bare boolean would not.
 */
export async function waitForJson<T>(
  url: string,
  read: (payload: unknown) => T,
  predicate: (value: T) => boolean,
  what: string,
  timeoutMs: number,
  deps: WaitDeps = defaultWaitDeps,
  pollMs = 500,
): Promise<T> {
  const deadline = deps.now() + timeoutMs;
  let seen: T | undefined;
  for (;;) {
    seen = read(await deps.fetchJson(url));
    if (predicate(seen)) return seen;
    if (deps.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${what}; last seen: ${JSON.stringify(seen)}`,
      );
    }
    await deps.sleep(pollMs);
  }
}

/** `GET /api/repositories` -> `{ repositories: [{ path }] }`. */
export function readRepositoryPaths(payload: unknown): string[] {
  const list = (payload as { repositories?: { path?: string }[] }).repositories ?? [];
  return list.map((repository) => repository.path ?? '');
}

/** `GET /api/worktrees` -> `{ worktrees: [{ id }] }`. */
export function readWorktreeIds(payload: unknown): string[] {
  const list = (payload as { worktrees?: WorktreeSummary[] }).worktrees ?? [];
  return list.map((worktree) => worktree.id);
}

/**
 * `GET /api/worktrees/<id>/git/staged` -> `{ staged, unstaged, untracked }`.
 *
 * The `unstaged` bucket specifically, not `git/status`'s `isDirty`: the scene
 * clicks a row in `git-unstaged-list`, and `isDirty` is also true when only
 * untracked files exist, which would leave that list empty mid-take.
 */
export function readUnstagedPaths(payload: unknown): string[] {
  const list = (payload as { unstaged?: { path?: string }[] }).unstaged ?? [];
  return list.map((file) => file.path ?? '');
}

/**
 * Poll `GET /api/worktrees` until one worktree satisfies `predicate`.
 *
 * The server API is the synchronisation point rather than the rendered status
 * dot: the dot's accessible name is localized and can be overridden with a
 * per-agent breakdown, so matching on it would silently stop working under a
 * non-en locale.
 */
export async function waitForWorktree(
  baseUrl: string,
  worktreeId: string,
  predicate: (worktree: WorktreeSummary) => boolean,
  what: string,
  timeoutMs: number,
  deps: WaitDeps = defaultWaitDeps,
  pollMs = 500,
): Promise<WorktreeSummary> {
  const deadline = deps.now() + timeoutMs;
  let seen: WorktreeSummary | undefined;
  for (;;) {
    const payload = (await deps.fetchJson(`${baseUrl}/api/worktrees`)) as {
      worktrees?: WorktreeSummary[];
    };
    seen = (payload.worktrees ?? []).find((worktree) => worktree.id === worktreeId);
    if (seen && predicate(seen)) return seen;
    if (deps.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${worktreeId} to be ${what}; ` +
          `last seen: ${seen ? JSON.stringify(seen) : '<worktree not in /api/worktrees>'}`,
      );
    }
    await deps.sleep(pollMs);
  }
}

// -------------------------------------------------------------- scenes -------

export interface SceneContext {
  page: Page;
  baseUrl: string;
  options: RecordOptions;
  /** Everything env-up.sh recorded, including the seed paths it created. */
  state: DemoState;
}

export interface PrepareContext {
  baseUrl: string;
  options: RecordOptions;
  state: DemoState;
}

export interface Scene {
  id: string;
  title: string;
  /** `mobile` scenes are filmed at MOBILE_VIEWPORT regardless of --viewport. */
  viewport: 'pc' | 'mobile';
  /**
   * Block until the product is already in the state this scene films — before
   * the camera rolls.
   *
   * Playwright starts recording the moment the context is created, so a wait
   * done inside `run` is filmed. The approval scene waits for the cassette to
   * reach its prompt *and* for the 5s capture cache to expire; with that wait
   * inside the take, the first six seconds of footage were a blank page and the
   * prompt sheet the scene exists to show never made the cut.
   */
  prepare?: (ctx: PrepareContext) => Promise<void>;
  run: (ctx: SceneContext) => Promise<void>;
}

/**
 * The cookie next-intl resolves the UI language from.
 *
 * `src/config/i18n-config.ts` names it `locale` (not `NEXT_LOCALE`) and
 * `src/i18n.ts` reads it server-side, so setting it before the first navigation
 * makes even the server-rendered markup come back in the right language.
 *
 * `url` rather than `domain`/`path`: env-up.sh hands out
 * `http://127.0.0.1:<port>`, and a cookie scoped to the literal domain
 * `localhost` — which is what the e2e suite uses — would never be sent.
 */
export function localeCookie(baseUrl: string, locale: Locale): {
  name: string;
  value: string;
  url: string;
} {
  return { name: 'locale', value: locale, url: baseUrl };
}

/**
 * The label on MobilePromptSheet's submit button, read from the dictionary the
 * UI itself renders from.
 *
 * The button carries no test id and its text is localized ("Submit" / "送信"),
 * so hard-coding either spelling would make the approval scene fail under the
 * other locale — and it would fail as a timeout, minutes into a take.
 */
export function submitButtonLabel(repoRoot: string, locale: Locale): string {
  const dictionary = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'locales', locale, 'prompt.json'), 'utf8'),
  ) as Record<string, unknown>;
  const label = dictionary.submit;
  if (typeof label !== 'string' || label === '') {
    throw new Error(`locales/${locale}/prompt.json has no 'submit' string`);
  }
  return label;
}

/**
 * Navigate, then prove the app really switched language before filming.
 *
 * The Accept-Language route is not trustworthy on its own: `resolveLocale`
 * picks the first supported locale *contained* in the header, and it tests
 * `en` first — so a browser context created with `locale: 'ja'` sending
 * `ja-JP,ja;q=0.9,en;q=0.8` resolves to English. Asserting on `<html lang>`,
 * which `src/app/layout.tsx` renders from `getLocale()`, turns "the UI language
 * matches the telop language" from an acceptance criterion someone has to
 * eyeball into a condition that fails the take.
 */
export async function gotoLocalized(page: Page, url: string, locale: Locale): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== locale) {
    throw new Error(
      `refusing to record ${url}: requested locale '${locale}' but the app rendered <html lang="${lang}">`,
    );
  }
}

/**
 * Click a control until it actually takes effect.
 *
 * These pages are server-rendered, so a button is in the DOM — and satisfies
 * every one of Playwright's actionability checks: visible, stable, enabled,
 * hit-testable — before React has attached its `onClick`. A click that lands in
 * that window is silently swallowed, and the failure surfaces much later as a
 * timeout on whatever the click was supposed to produce, naming the wrong
 * element. Waiting a fixed time before clicking would only move the race.
 *
 * `isDone` is checked *before* the first click as well, so a control that
 * toggles — the activity bar closes the pane when its already-active icon is
 * clicked again — is never clicked one time too many.
 */
export async function clickUntilEffective(
  trigger: Locator,
  isDone: () => Promise<boolean>,
  what: string,
  timeoutMs: number,
  attemptMs = 4000,
  pollMs = 250,
): Promise<void> {
  const page = trigger.page();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isDone()) return;
    await trigger.click();
    const attemptUntil = Date.now() + attemptMs;
    while (Date.now() < attemptUntil) {
      await page.waitForTimeout(pollMs);
      if (await isDone()) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`clicked ${what} for ${timeoutMs}ms but it never took effect`);
    }
  }
}

export const SCENES: Scene[] = [
  {
    id: 'sessions-overview',
    title: 'Branch list with live per-worktree status',
    viewport: 'pc',
    // The seed repository's worktrees have to be in the API before the page is
    // worth filming.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        options.worktreeId,
        () => true,
        'present in the worktree list',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/`, options.locale);
      await page.getByTestId('branch-list').waitFor({ state: 'visible' });
      const items = page.getByTestId('branch-list-item');
      await items.first().waitFor({ state: 'visible' });
      await page.getByTestId('status-indicator').first().waitFor({ state: 'visible' });
      // Hold the finished frame; nothing is being decided here.
      await page.waitForTimeout(2500);
    },
  },
  {
    id: 'send-and-generate',
    title: 'Send a message and watch the agent start work',
    viewport: 'pc',
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}`, options.locale);
      const composer = page.getByTestId('message-input-textarea');
      await composer.waitFor({ state: 'visible' });
      await composer.click();
      await composer.pressSequentially(options.message, { delay: 45 });
      await page.getByTestId('send-message-button').click();

      // Read from the server, so the footage cannot claim a state the product
      // never reached.
      await waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isProcessing === true,
        'generating',
        options.timeoutMs,
      );
      await page.waitForTimeout(3000);
    },
  },
  {
    id: 'respond-from-mobile',
    title: 'Approve a confirmation prompt from a phone-sized viewport',
    viewport: 'mobile',
    // The cassette parks on an approval frame until an answer arrives, so this
    // wait is bounded by the send scene, not by a race.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isWaitingForResponse === true,
        'waiting for a response',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}`, options.locale);
      const sheet = page.getByTestId('mobile-prompt-sheet');
      await sheet.waitFor({ state: 'visible' });

      // Claude's approval is a numbered option block, so detectPrompt reports
      // `multiple_choice` and the sheet renders radio options with a submit
      // button rather than Yes/No buttons. Option 1 arrives pre-selected from
      // the cassette's default marker, which is what makes this one tap.
      await sheet
        .getByRole('button', { name: submitButtonLabel(options.repoRoot, options.locale) })
        .click();

      await waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isWaitingForResponse === false,
        'released by the answer',
        options.timeoutMs,
      );
      await page.waitForTimeout(1500);
    },
  },
  {
    id: 'add-repository',
    title: 'Register a repository by local path',
    viewport: 'pc',
    // Path registration rather than clone: `POST /api/repositories/clone` walks
    // out to a real git host, and the isolated environment is not allowed to
    // reach the network. The path route stays inside the throwaway seed.
    //
    // The precondition is the repository still being *absent*, which env-up.sh
    // guarantees by keeping it out of WORKTREE_REPOS — the only source the boot
    // sync in server.ts scans.
    prepare: async ({ baseUrl, options, state }) => {
      const target = secondSeedRepository(state);
      await waitForJson(
        `${baseUrl}/api/repositories`,
        readRepositoryPaths,
        (paths) => !paths.includes(target),
        `${target} to still be unregistered`,
        options.timeoutMs,
      );
    },
    run: async ({ page, baseUrl, options, state }) => {
      const target = secondSeedRepository(state);
      await gotoLocalized(page, `${baseUrl}/repositories`, options.locale);
      const input = page.getByTestId('repository-path-input');
      await clickUntilEffective(
        page.getByTestId('add-repository-button'),
        () => input.isVisible(),
        'the add-repository button',
        options.timeoutMs,
      );
      await input.click();
      await input.pressSequentially(target, { delay: 25 });
      // Path validation is debounced by 400ms (PATH_VALIDATION_DEBOUNCE_MS);
      // letting it land puts the "git repository detected" hint on screen
      // before the submit, which is the reassurance the shot is about.
      await page.waitForTimeout(1200);
      await page.getByTestId('repository-scan-submit').click();

      // Server-side truth first, then the row it produces. Registration is what
      // the scene claims happened, so the footage must not outrun it.
      await waitForJson(
        `${baseUrl}/api/repositories`,
        readRepositoryPaths,
        (paths) => paths.includes(target),
        `${target} to appear in the repository list`,
        options.timeoutMs,
      );
      await page
        .locator('[data-testid^="repository-row-"]')
        .filter({ hasText: path.basename(target) })
        .first()
        .waitFor({ state: 'visible' });
      await page.waitForTimeout(2000);
    },
  },
  {
    id: 'sync-worktrees',
    title: 'Pick up a worktree that was created outside CommandMate',
    viewport: 'pc',
    // CommandMate never creates worktrees — src/lib/git/worktrees.ts only
    // scans and registers them, and docs/user-guide/tutorial.md says so in as
    // many words. env-up.sh therefore makes this one with plain git, and does
    // it *after* the server's boot sync, so it is on disk and absent from the
    // database. That gap is the whole subject of the scene.
    prepare: ({ baseUrl, options }) =>
      waitForJson(
        `${baseUrl}/api/worktrees`,
        readWorktreeIds,
        (ids) => ids.includes(options.worktreeId) && !ids.includes(UNSYNCED_WORKTREE_ID),
        `${UNSYNCED_WORKTREE_ID} to be on disk but not yet registered`,
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/repositories`, options.locale);
      // The outcome is read from the server, not from the button's own spinner:
      // the footage must not claim a registration the database never got.
      await clickUntilEffective(
        page.getByTestId('sync-all-button'),
        async () =>
          readWorktreeIds(await defaultWaitDeps.fetchJson(`${baseUrl}/api/worktrees`)).includes(
            UNSYNCED_WORKTREE_ID,
          ),
        'the sync-all button',
        options.timeoutMs,
      );
      await page.waitForTimeout(2500);
    },
  },
  {
    id: 'review-diff',
    title: 'Read the diff of an uncommitted change in the Git pane',
    viewport: 'pc',
    // `git/staged` rather than `git/diff`: the latter is commit-scoped and
    // rejects anything that is not a 7-40 character hash, so it cannot speak
    // about working-tree changes at all. The pane reads `git/staged` too, so
    // this waits on exactly the list the take is about to click.
    prepare: ({ baseUrl, options }) =>
      waitForJson(
        `${baseUrl}/api/worktrees/${options.worktreeId}/git/staged`,
        readUnstagedPaths,
        (paths) => paths.length > 0,
        `${options.worktreeId} to report an unstaged change`,
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}`, options.locale);
      // `files` is the default activity, so Git needs one *effective* click —
      // clickUntilEffective re-checks before clicking so it can never toggle
      // the pane back shut.
      const gitPane = page.locator('[data-testid="activity-pane"][data-active="git"]');
      await clickUntilEffective(
        page.getByTestId('activity-bar-button-git'),
        () => gitPane.isVisible(),
        'the Git activity button',
        options.timeoutMs,
      );

      const unstaged = page.getByTestId('git-unstaged-list');
      await unstaged.waitFor({ state: 'visible' });
      await unstaged.getByTestId('git-changes-diff-button').first().click();
      // FilePanelSplit only mounts the viewer for a non-empty diff body, so a
      // visible pane is proof the diff really came back.
      await page.getByTestId('file-panel-pane').waitFor({ state: 'visible' });
      await page.waitForTimeout(2500);
    },
  },
  {
    id: 'complete',
    title: 'Session returns to ready and the list reflects it',
    viewport: 'pc',
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isProcessing === false && worktree.isSessionRunning === true,
        'back to ready',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/`, options.locale);
      await page.getByTestId('branch-list').waitFor({ state: 'visible' });
      await page.getByTestId('status-indicator').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(2000);
    },
  },
];

export function viewportFor(scene: Scene, options: RecordOptions): { width: number; height: number } {
  return scene.viewport === 'mobile' ? { ...MOBILE_VIEWPORT } : { ...options.viewport };
}

// ---------------------------------------------------------------- main -------

export async function recordScenes(options: RecordOptions): Promise<string[]> {
  const state = parseStateFile(fs.readFileSync(options.statePath, 'utf8'));
  const outDir = options.outDir || state.videoDir;
  if (!outDir) throw new Error('no output directory: pass --out or re-run env-up.sh');
  fs.mkdirSync(outDir, { recursive: true });

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: options.headless });
  const selected = options.sceneIds.length
    ? SCENES.filter((scene) => options.sceneIds.includes(scene.id))
    : SCENES;
  const written: string[] = [];

  try {
    for (const scene of selected) {
      // Outside the recording: see Scene.prepare.
      await scene.prepare?.({ baseUrl: state.baseUrl, options, state });
      const viewport = viewportFor(scene, options);
      const context: BrowserContext = await browser.newContext({
        viewport,
        locale: options.locale,
        colorScheme: options.colorScheme,
        recordVideo: { dir: outDir, size: viewport },
      });
      // The context locale only sets Accept-Language, which resolveLocale reads
      // as a fallback. The cookie is what actually pins the app's UI language.
      await context.addCookies([localeCookie(state.baseUrl, options.locale)]);
      const page = await context.newPage();
      const video = page.video();
      try {
        await scene.run({ page, baseUrl: state.baseUrl, options, state });
      } finally {
        await context.close();
      }
      const target = path.join(outDir, `${scene.id}.webm`);
      if (video) {
        await video.saveAs(target);
        await video.delete();
        written.push(target);
        process.stdout.write(`recorded ${scene.id} -> ${target}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  return written;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 'record-scenes.ts'));

if (invokedDirectly) {
  recordScenes(parseRecordArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`record-scenes: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
