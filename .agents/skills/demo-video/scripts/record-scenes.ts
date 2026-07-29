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

import type { BrowserContext, Page } from '@playwright/test';

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
export const DEFAULT_MESSAGE = 'Add a dark mode toggle to the header';

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
  fetchJson: (url: string) => Promise<{ worktrees?: WorktreeSummary[] }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultWaitDeps: WaitDeps = {
  fetchJson: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
    return (await response.json()) as { worktrees?: WorktreeSummary[] };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

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
    const payload = await deps.fetchJson(`${baseUrl}/api/worktrees`);
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
}

export interface PrepareContext {
  baseUrl: string;
  options: RecordOptions;
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
      await scene.prepare?.({ baseUrl: state.baseUrl, options });
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
        await scene.run({ page, baseUrl: state.baseUrl, options });
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
