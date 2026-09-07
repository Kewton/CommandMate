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

import { recordTerminalScene } from './terminal-scene';

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
  /**
   * Worktree the send-message scene drives.
   *
   * Never a constant: `deriveWorktreeId` mints ids from the **directory**
   * (src/lib/git/worktree-id.ts, Issue #1621/#1644), so env-up.sh derives them
   * from the seed it created and records them in state.env.
   */
  worktreeId: string;
  /** Directory `worktreeId` must belong to; empty disables the cross-check. */
  worktreePath: string;
  /** Worktree the boot sync deliberately missed, for the sync-worktrees scene. */
  unsyncedWorktreeId: string;
  /** Directory `unsyncedWorktreeId` must belong to. */
  unsyncedWorktreePath: string;
  /** Upper bound for a single synchronisation point, in ms. */
  timeoutMs: number;
  headless: boolean;
  /** Repository root, used to read the locale dictionaries the UI renders from. */
  repoRoot: string;
  /** tmux session the `contract-verify` take runs the CLI in. */
  cliSession: string;
  /**
   * `tmux -L` socket for that session. Empty means the ambient tmux server,
   * which is where the demo's other sessions live. A dedicated socket is how a
   * developer verifies the scene without their own sessions being in reach.
   */
  tmuxSocket: string;
  /** Scratch directory for the terminal take's PNG frames. */
  workDir: string;
  /**
   * Whether a scene may report itself unfilmable and be passed over.
   *
   * Off by default: a scene the storyboard placed and the recorder skipped
   * silently is footage nobody notices missing until compose.sh fails on an
   * absent file, and the reason is gone by then. `install-skill` needs the
   * network, so an offline operator opts in explicitly.
   */
  allowSkip: boolean;
}

/**
 * Thrown by a `prepare` that has established the scene cannot be filmed *and*
 * that waiting will not change it — the Skill Catalog being unreachable, not a
 * state that has yet to arrive. Carries the reason so the run reports why
 * rather than producing an empty take.
 */
export class SceneUnavailableError extends Error {
  constructor(public readonly sceneId: string, reason: string) {
    super(`scene '${sceneId}' cannot be filmed here: ${reason}`);
    this.name = 'SceneUnavailableError';
  }
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
export const DEFAULT_MESSAGE = 'Add a dark mode toggle to the header';

/**
 * tmux session the `contract-verify` take runs in.
 *
 * A constant here and in cli-scene.sh's default, unlike a worktree id: this
 * session is created by the harness for the harness, so nothing on the server
 * side derives or looks for the name. env-down.sh still tears it down from the
 * record cli-scene.sh appends, never from a name pattern (#1809).
 */
export const DEFAULT_CLI_SESSION = 'cmdemo-cli';

/** The Skill the `install-skill` take installs from the official Catalog. */
export const DEMO_CATALOG_SKILL_ID = 'cmate-repository-analysis';

/**
 * There is deliberately no default worktree id in this file.
 *
 * Until Issue #1809 there were two, spelled in the retired branch-derived
 * scheme. When #1621 made the id a function of the directory they went on
 * parsing, went on type-checking and
 * addressed worktrees that no longer existed: the fake agent's tmux session was
 * never adopted, `isSessionRunning` stayed false forever, and every scene died
 * at its own timeout with nothing in the message about the id being wrong.
 * A missing id now stops the run before the browser opens.
 */

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

export function parseRecordArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): RecordOptions {
  const options: RecordOptions = {
    statePath: defaultStatePath(),
    outDir: '',
    sceneIds: [],
    locale: 'en',
    colorScheme: 'light',
    viewport: { ...DEFAULT_VIEWPORT },
    message: DEFAULT_MESSAGE,
    // Environment, not a constant. `resolveRecordOptions` then lets state.env
    // supply whatever was not passed, and refuses to record if nothing did.
    worktreeId: env.CM_DEMO_WORKTREE_ID ?? '',
    worktreePath: env.CM_DEMO_WORKTREE_PATH ?? '',
    unsyncedWorktreeId: env.CM_DEMO_UNSYNCED_WORKTREE_ID ?? '',
    unsyncedWorktreePath: env.CM_DEMO_UNSYNCED_WORKTREE_PATH ?? '',
    timeoutMs: 60_000,
    headless: true,
    // <repo>/.claude/skills/demo-video/scripts, and byte-identically
    // <repo>/.agents/skills/demo-video/scripts — four levels up either way.
    repoRoot: path.resolve(__dirname, '../../../..'),
    cliSession: env.CM_DEMO_CLI_SESSION ?? DEFAULT_CLI_SESSION,
    tmuxSocket: env.CM_DEMO_TMUX_SOCKET ?? '',
    workDir: '',
    allowSkip: false,
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
      case '--worktree-path': options.worktreePath = next(i, arg); i += 1; break;
      case '--unsynced-worktree': options.unsyncedWorktreeId = next(i, arg); i += 1; break;
      case '--unsynced-worktree-path':
        options.unsyncedWorktreePath = next(i, arg);
        i += 1;
        break;
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
      case '--cli-session': options.cliSession = next(i, arg); i += 1; break;
      case '--tmux-socket': options.tmuxSocket = next(i, arg); i += 1; break;
      case '--work': options.workDir = next(i, arg); i += 1; break;
      case '--allow-skip': options.allowSkip = true; break;
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
  /** Absolute directory the id was minted from (`deriveWorktreeId`). */
  path?: string;
  /** Checked-out branch, which is what a sidebar/popover row is labelled with. */
  branch?: string;
  isSessionRunning?: boolean;
  isProcessing?: boolean;
  isWaitingForResponse?: boolean;
}

/** A worktree to wait on, optionally with the directory its id must belong to. */
export interface WorktreeTarget {
  id: string;
  path?: string;
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

/** `GET /api/worktrees` -> `{ worktrees: [{ id, path, ... }] }`. */
export function readWorktreeEntries(payload: unknown): WorktreeSummary[] {
  return (payload as { worktrees?: WorktreeSummary[] }).worktrees ?? [];
}

/** `GET /api/worktrees` -> `{ worktrees: [{ id }] }`. */
export function readWorktreeIds(payload: unknown): string[] {
  return readWorktreeEntries(payload).map((worktree) => worktree.id);
}

/**
 * Fail — immediately, not after a full timeout — when the server knows
 * `expectedPath` under an id other than `expectedId`.
 *
 * The second safety net over reading the ids out of state.env, and the one that
 * turns a silent stall into a diagnosis. A worktree's id is frozen at first
 * registration (`syncWorktreesToDB` looks the row up by path, Issue #1621), so
 * once a different id has been minted, waiting cannot fix it: every scene would
 * run out its timeout and report `<worktree not in /api/worktrees>` without ever
 * naming the id that does exist. Both sides are printed for exactly that reason.
 */
export function assertIdForPath(
  entries: readonly WorktreeSummary[],
  expectedId: string,
  expectedPath: string,
): void {
  if (!expectedPath) return;
  const byPath = entries.find((entry) => entry.path === expectedPath);
  if (byPath && byPath.id !== expectedId) {
    throw new Error(
      `worktree id mismatch for ${expectedPath}: /api/worktrees reports '${byPath.id}', ` +
        `but this take was told to drive '${expectedId}'. Ids come from ` +
        'deriveWorktreeId(path) (src/lib/git/worktree-id.ts); re-run env-up.sh so ' +
        'state.env records the id the server actually minted.',
    );
  }
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
  target: string | WorktreeTarget,
  predicate: (worktree: WorktreeSummary) => boolean,
  what: string,
  timeoutMs: number,
  deps: WaitDeps = defaultWaitDeps,
  pollMs = 500,
): Promise<WorktreeSummary> {
  const { id: worktreeId, path: expectedPath = '' } =
    typeof target === 'string' ? { id: target, path: '' } : target;
  const deadline = deps.now() + timeoutMs;
  let seen: WorktreeSummary | undefined;
  let entries: WorktreeSummary[] = [];
  for (;;) {
    entries = readWorktreeEntries(await deps.fetchJson(`${baseUrl}/api/worktrees`));
    // Before the predicate: a wrong id is never going to satisfy it, and the
    // operator needs the id/path pair rather than `timed out` minutes later.
    assertIdForPath(entries, worktreeId, expectedPath);
    seen = entries.find((worktree) => worktree.id === worktreeId);
    if (seen && predicate(seen)) return seen;
    if (deps.now() >= deadline) {
      const known = JSON.stringify(entries.map((entry) => ({ id: entry.id, path: entry.path })));
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${worktreeId} to be ${what}; ` +
          `last seen: ${seen ? JSON.stringify(seen) : '<worktree not in /api/worktrees>'}` +
          (expectedPath ? `; expected it at ${expectedPath}` : '') +
          `; /api/worktrees knows: ${known}`,
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

interface SceneCommon {
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
  /**
   * Assert, off camera, what the take claimed (#2381). Runs after the
   * recording context has closed, so a server-side confirmation that can take
   * a capture-cache TTL to arrive — the prompt really released by the answer
   * the phone gave — is checked without being filmed as seconds of a page
   * doing nothing. compose.sh keeps the tail of a take, so a wait inside
   * `run` after the payoff would be exactly what ends up in the cut.
   */
  after?: (ctx: PrepareContext) => Promise<void>;
}

export interface BrowserScene extends SceneCommon {
  kind?: 'browser';
  /**
   * localStorage entries to plant before the page's first script runs
   * (#2381): the sidebar collapsed, the Agent pane open, the tool-call chips
   * unfolded. Every scene films in a fresh browser context, so a preference
   * one scene clicked into place is gone by the next; seeding it is the only
   * way a cut can open on the layout it means to show. Keys are the product's
   * own (`record-scenes.test.ts` pins them against the source).
   */
  seedStorage?: (options: RecordOptions, state: DemoState) => Record<string, string>;
  run: (ctx: SceneContext) => Promise<void>;
}

/**
 * A scene filmed from a tmux pane rather than a browser (Issue #1810).
 *
 * Task Contract, verification gates and Evidence have no Web UI — `src/components`
 * calls neither `/api/worktrees/:id/tasks` nor `/api/verification/*` — so the
 * only surface that shows them is the CLI's own output. `record` produces the
 * same `<sceneId>.webm` a browser scene does, which is what lets compose.sh
 * treat the two identically.
 */
export interface TerminalScene extends SceneCommon {
  kind: 'terminal';
  record: (ctx: TerminalRecordContext) => Promise<void>;
}

export type Scene = BrowserScene | TerminalScene;

export interface TerminalRecordContext {
  baseUrl: string;
  options: RecordOptions;
  state: DemoState;
  /** Where the take's webm must be written. */
  outFile: string;
  /** Scratch space for the frame PNGs; never inside the repository. */
  workDir: string;
}

export function isTerminalScene(scene: Scene): scene is TerminalScene {
  return scene.kind === 'terminal';
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

/** `POST` a JSON body, failing with the status the server actually returned. */
export async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} -> ${response.status} ${await response.text()}`);
  }
  return (await response.json().catch(() => null)) as unknown;
}

/**
 * `GET /api/skills` seen as a reachability probe for the official Catalog.
 *
 * Asked of the *server* rather than of the network directly: the Catalog URL is
 * a compile-time constant with an exact-match allowlist
 * (`src/config/skill-catalog-config.ts`, SSRF policy), so a second copy of it
 * in this file would be a second thing to keep in step. The route answers 503
 * when retrieval failed with nothing to fall back on, and marks a cached
 * answer `stale` — both mean the take would film last-known-good data rather
 * than an install.
 */
export function readCatalogAvailability(payload: unknown): { ok: boolean; reason: string } {
  const catalog = (payload as { catalog?: { stale?: boolean } }).catalog;
  if (!catalog) return { ok: false, reason: 'GET /api/skills returned no catalog envelope' };
  if (catalog.stale === true) {
    return { ok: false, reason: 'the Skill Catalog is served stale (offline snapshot)' };
  }
  return { ok: true, reason: '' };
}

/** `GET /api/worktrees/<id>/skills` -> `{ skills: [{ skillId }] }`. */
export function readInstalledSkillIds(payload: unknown): string[] {
  const list = (payload as { skills?: { skillId?: string }[] }).skills ?? [];
  return list.map((skill) => skill.skillId ?? '');
}

/**
 * Wait for the tab title to carry the `(N)` badge `formatTitleWithBadge`
 * prepends (`src/lib/pwa/attention-badge.ts`).
 *
 * Asserted rather than eyeballed: the badge is the half of the notification
 * that reaches someone whose CommandMate tab is in the background, and it is
 * also the half a reviewer watching a video would never notice missing.
 */
export async function waitForTitleBadge(page: Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let title = '';
  for (;;) {
    title = await page.title();
    if (/^\(\d+\)\s/.test(title)) return title;
    if (Date.now() >= deadline) {
      throw new Error(
        `document.title never took the attention badge; last seen: ${JSON.stringify(title)}`,
      );
    }
    await page.waitForTimeout(250);
  }
}

/**
 * What the `slash-palette` take asserts is on screen.
 *
 * `/cmate-verify` arrives from the Skill directories env-up.sh copies into the
 * seed worktree, the other three from its `.claude/commands`. Both loaders are
 * the product's own (`src/lib/slash-commands.ts`), reading the worktree the
 * take is pointed at.
 */
export const SLASH_PALETTE_COMMANDS: readonly string[] = [
  '/cmate-verify',
  '/work-plan',
  '/create-pr',
  '/tdd-impl',
];

/** How often the terminal take samples the pane. */
export const TERMINAL_CAPTURE_INTERVAL_MS = 250;

/**
 * Upper bound for the whole `contract-verify` take: two `wait --verify` calls
 * bounded at 180s each, the gates they start, and the hold on the last frame.
 */
export const TERMINAL_TAKE_TIMEOUT_MS = 480_000;

// ----------------------------------------------------- hero cut (#2381) ------

/**
 * localStorage keys the README hero scenes seed, spelled as the product spells
 * them. Not imported from `src/`: this script is run with `npx tsx` from a
 * checkout and reaches for nothing but Playwright, so the test pins these
 * against `SIDEBAR_OPEN_STORAGE_KEY`, `getActivityBarStorageKey`,
 * `ACTIVITY_CLOSED_SENTINEL` and `CHAT_TOOL_ACTIVITY_STORAGE_KEY` instead.
 */
export const SIDEBAR_OPEN_STORAGE_KEY = 'mcbd-sidebar-open';
export const ACTIVITY_BAR_STORAGE_KEY_PREFIX = 'commandmate.worktree.activeActivity-';
export const ACTIVITY_CLOSED_SENTINEL = '__closed__';
export const CHAT_TOOL_ACTIVITY_STORAGE_KEY = 'commandmate:chatShowToolActivity';
export const SURFACE_MODE_STORAGE_KEY_PREFIX = 'commandmate.worktree.surfaceMode-';

/** `?view=chat`: the deep link that opens a split's output surface as chat. */
export const CHAT_VIEW_QUERY = 'view=chat';

/**
 * The first split's and the phone's persisted surface mode for `worktreeId`
 * (`getSplitSurfaceModeStorageKey` / `getMobileSurfaceModeStorageKey`), set to
 * chat. `?view=chat` covers a page the take navigates to itself; this covers
 * the page the app navigates to — the branch picked in the tab strip opens
 * `/worktrees/<id>` with no query, and would open on the terminal.
 */
function chatSurfaceStorage(worktreeId: string): Record<string, string> {
  return {
    [`${SURFACE_MODE_STORAGE_KEY_PREFIX}${worktreeId}-split-0`]: 'chat',
    [`${SURFACE_MODE_STORAGE_KEY_PREFIX}${worktreeId}-mobile`]: 'chat',
  };
}

/**
 * What the `delegate-ask` take types before it inserts the brief: the ask
 * itself, on one line. The brief the Agent pane appends underneath is the
 * product's own text (`buildDelegationBrief`), and the request the claude
 * cassette really sends codex is spelled in the cassette's `@exec` row — this
 * line is the operator's instruction as the chat shows it.
 */
export const DELEGATE_ASK_MESSAGE = 'Ask Codex to review the dark mode toggle in the header.';

/**
 * What `mobile-approve` sends to reach the hero cassette's approval pass. One
 * line, deliberately: the transcript template for that pass writes `{{TASK}}`
 * (the first line of the pass's first submission), because by the time the
 * turn closes the LAST submission is the answer the phone gave.
 */
export const MOBILE_APPROVE_MESSAGE = 'Run the unit tests and tell me if the header is ready to merge.';

/**
 * Sidebar collapsed, so the repository tab strip is on screen (it is the
 * collapsed sidebar's navigation, shown by default only while collapsed —
 * `shouldShowRepositoryTabBar`).
 */
function heroPcStorage(options: RecordOptions, activity: string | null): Record<string, string> {
  return {
    ...chatSurfaceStorage(options.worktreeId),
    [SIDEBAR_OPEN_STORAGE_KEY]: 'false',
    [`${ACTIVITY_BAR_STORAGE_KEY_PREFIX}${options.worktreeId}`]: activity ?? ACTIVITY_CLOSED_SENTINEL,
    // The tool-call chip opens by default, so the `commandmate ask … --instance
    // codex` row is on screen the moment the reply lands, without a click.
    [CHAT_TOOL_ACTIVITY_STORAGE_KEY]: 'true',
  };
}

/** The worktree registered from `path`, once the server has scanned it. */
function worktreeAtPath(entries: readonly WorktreeSummary[], target: string): WorktreeSummary | undefined {
  return entries.find((entry) => entry.path === target);
}

/** The most recent reply's file link, on either surface. */
function lastFileLink(page: Page): Locator {
  return page.getByTestId('chat-file-link').last();
}

/**
 * Close the "Queued (session busy)" toast the PC composer raises on every send
 * to a live session, the way a user would.
 *
 * Measured on develop at 8f41c074 (2026-09-07): `TerminalSplitPaneContent`
 * hands `MessageInput` `isProcessing={terminal.isRunning}`, and since #2238
 * `isRunning` means "a tmux session exists", not "the agent is generating" —
 * so the warning fires for a session that is `ready`, as the header pill
 * says beside it. That is a product defect outside this skill's reach, and a
 * README that shows a false warning would be worse than one that shows a
 * toast being closed. It is closed through its own control, never hidden.
 */
async function dismissQueuedBusyToast(page: Page): Promise<void> {
  // The warning one specifically: the "brief inserted" success toast beside
  // it is the feature announcing itself and stays.
  const close = page
    .getByTestId('toast-container')
    .getByRole('alert')
    .filter({ has: page.getByTestId('toast-icon-warning') })
    .getByTestId('toast-close-button');
  try {
    await close.waitFor({ state: 'visible', timeout: 1500 });
    await close.click();
  } catch {
    /* no toast: nothing to close */
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
        { id: options.worktreeId, path: options.worktreePath },
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
        { id: options.worktreeId, path: options.worktreePath },
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
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isProcessing === true,
        'generating',
        options.timeoutMs,
      );
      await page.waitForTimeout(3000);
    },
  },
  {
    id: 'attention-badge',
    title: 'A session that needs an answer says so: pill, toast and tab title',
    viewport: 'pc',
    // The subject is a *transition*, so prepare's job is to guarantee the
    // transition has not happened yet. The toast fires off a realtime
    // `session_status_changed` event (WaitingToastListener), which a page that
    // opened after the edge never receives — a take started against an
    // already-waiting session would show the pill and silently lose the toast.
    prepare: async ({ baseUrl, options }) => {
      const target = { id: options.worktreeId, path: options.worktreePath };
      const live = await waitForWorktree(
        baseUrl,
        target,
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      );
      // Filmable on its own (`--scene attention-badge`) as well as after
      // send-and-generate: an idle cassette is parked on `@input` and needs a
      // message before it paints anything at all.
      if (live.isProcessing !== true && live.isWaitingForResponse !== true) {
        await postJson(`${baseUrl}/api/worktrees/${options.worktreeId}/send`, {
          content: options.message,
        });
      }
      const busy = await waitForWorktree(
        baseUrl,
        target,
        (worktree) => worktree.isProcessing === true || worktree.isWaitingForResponse === true,
        'generating',
        options.timeoutMs,
      );
      if (busy.isWaitingForResponse === true) {
        throw new Error(
          `${options.worktreeId} is already waiting for a response: this scene films the moment ` +
            'it starts waiting, so place attention-badge before any scene that answers the prompt',
        );
      }
    },
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/`, options.locale);
      await page.getByTestId('branch-list').waitFor({ state: 'visible' });

      // The one wait deliberately inside a take: the edge from generating to
      // waiting *is* the shot. Bounded by the same timeout as every other
      // synchronisation point, so a cassette that never asks fails the take
      // rather than filming a still page until the pipeline gives up.
      await waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isWaitingForResponse === true,
        'waiting for a response',
        options.timeoutMs,
      );

      // The toast is the most transient of the three (WAITING_TOAST_DURATION_MS
      // is 8s), so it is waited for first.
      await page
        .getByTestId('toast-container')
        // `role="alert"`, not `status`: the container is the `aria-live` region
        // and each toast inside it is the alert (src/components/common/Toast.tsx).
        .getByRole('alert')
        .first()
        .waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.getByTestId('attention-badge').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await waitForTitleBadge(page, options.timeoutMs);
      await page.waitForTimeout(3000);
    },
  },
  {
    id: 'review-screen',
    title: 'Answer from the Review screen and watch the row leave the list',
    viewport: 'pc',
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isWaitingForResponse === true,
        'waiting for a response',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      const approvalUrl = `${baseUrl}/review?filter=approval`;
      await gotoLocalized(page, approvalUrl, options.locale);
      const card = page.getByTestId(`review-item-${options.worktreeId}`);
      await card.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(1500);

      // ReviewTab renders each row as a Link to the worktree, with no composer
      // of its own (see the deviation table in SKILL.md), so the answer is
      // given where the product actually accepts one — the prompt panel the
      // card opens.
      await card.click();
      const panel = page.getByTestId('prompt-panel');
      await panel.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await panel
        .getByRole('button', { name: submitButtonLabel(options.repoRoot, options.locale) })
        .click();
      await waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isWaitingForResponse === false,
        'released by the answer',
        options.timeoutMs,
      );

      // Back to the list, which is where the answer becomes visible as absence.
      await gotoLocalized(page, approvalUrl, options.locale);
      await page.getByTestId('review-list').waitFor({ state: 'visible' });
      await card.waitFor({ state: 'detached', timeout: options.timeoutMs });
      await page.waitForTimeout(2000);
    },
  },
  {
    id: 'slash-palette',
    title: 'Type / in the composer and read the commands this worktree offers',
    viewport: 'pc',
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}`, options.locale);
      const composer = page.getByTestId('message-input-textarea');
      await composer.waitFor({ state: 'visible' });
      await composer.click();
      await composer.pressSequentially('/', { delay: 60 });

      const dropdown = page.getByTestId('slash-command-dropdown');
      await dropdown.waitFor({ state: 'visible', timeout: options.timeoutMs });
      // The four env-up.sh copies into the seed worktree. Asserted rather than
      // held for two seconds and hoped for: the list is read off the worktree's
      // own `.claude/commands` and `.claude|.agents/skills` directories, so an
      // empty palette means the seed is wrong, not that the shot is slow.
      for (const command of SLASH_PALETTE_COMMANDS) {
        await dropdown
          .getByText(command, { exact: false })
          .first()
          .waitFor({ state: 'visible', timeout: options.timeoutMs });
      }
      await page.waitForTimeout(2500);

      // Escape, never Enter: sending one of these would run a real command in
      // the pane, which is not what the scene claims happens.
      await page.keyboard.press('Escape');
      await dropdown.waitFor({ state: 'hidden', timeout: options.timeoutMs });
      await page.waitForTimeout(1200);
    },
  },
  {
    id: 'install-skill',
    title: 'Install a Skill from the official Catalog into this worktree',
    viewport: 'pc',
    // The only scene that needs the network: the Catalog URL is a compile-time
    // constant with an exact-match allowlist and cannot be pointed at a local
    // fixture. Unreachable is reported as a skip with its reason rather than
    // filmed as an empty panel.
    prepare: async ({ baseUrl, options }) => {
      let payload: unknown;
      try {
        payload = await defaultWaitDeps.fetchJson(`${baseUrl}/api/skills`);
      } catch (error) {
        throw new SceneUnavailableError(
          'install-skill',
          `the Skill Catalog is unreachable (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      const availability = readCatalogAvailability(payload);
      if (!availability.ok) throw new SceneUnavailableError('install-skill', availability.reason);

      await waitForJson(
        `${baseUrl}/api/worktrees/${options.worktreeId}/skills`,
        readInstalledSkillIds,
        (ids) => !ids.includes(DEMO_CATALOG_SKILL_ID),
        `${DEMO_CATALOG_SKILL_ID} to still be uninstalled in ${options.worktreeId}`,
        options.timeoutMs,
      );
    },
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}`, options.locale);
      const pane = page.locator('[data-testid="activity-pane"][data-active="skills"]');
      await clickUntilEffective(
        page.getByTestId('activity-bar-button-skills'),
        () => pane.isVisible(),
        'the Skills activity button',
        options.timeoutMs,
      );

      const entry = page.getByTestId(`worktree-skills-catalog-${DEMO_CATALOG_SKILL_ID}`);
      await entry.waitFor({ state: 'visible', timeout: options.timeoutMs });
      const panel = page.getByTestId('skill-install-panel');
      await clickUntilEffective(entry, () => panel.isVisible(), 'the Catalog entry', options.timeoutMs);

      await page.getByTestId('skill-install-action').click();
      // The plan, on screen, before anything is written: it is the reassurance
      // the shot is about.
      await page.getByTestId('skill-install-confirm').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(2000);
      await page.getByTestId('skill-install-confirm').click();

      // Server-side truth first: the footage must not claim an install the
      // worktree never received.
      await waitForJson(
        `${baseUrl}/api/worktrees/${options.worktreeId}/skills`,
        readInstalledSkillIds,
        (ids) => ids.includes(DEMO_CATALOG_SKILL_ID),
        `${DEMO_CATALOG_SKILL_ID} to be installed in ${options.worktreeId}`,
        options.timeoutMs,
      );
      await page.getByTestId('skill-install-result').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(2500);
    },
  },
  {
    id: 'contract-verify',
    title: 'Hand the agent a contract, then let the gates return the verdict',
    kind: 'terminal',
    viewport: 'pc',
    // No browser wait to do: the pane is the camera. The one precondition is
    // that the fake agent's session is adopted, because the contract is sent to
    // it and `wait --verify` blocks on its completion.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      ).then(() => undefined),
    record: async ({ options, outFile, workDir }) => {
      await recordTerminalScene({
        statePath: options.statePath,
        session: options.cliSession,
        tmuxSocket: options.tmuxSocket,
        frame: { ...options.viewport },
        outFile,
        workDir,
        intervalMs: TERMINAL_CAPTURE_INTERVAL_MS,
        // Two `wait --verify` calls at 180s each, plus the gates themselves.
        timeoutMs: Math.max(options.timeoutMs, TERMINAL_TAKE_TIMEOUT_MS),
        // The line the whole cut exists to show. A take that ends before it is
        // a failed take, not a short one (Issue #1811).
        requireInFinalFrame: 'RESULT passed',
      });
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
        { id: options.worktreeId, path: options.worktreePath },
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
        { id: options.worktreeId, path: options.worktreePath },
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
        readWorktreeEntries,
        (entries) => {
          // Throws out of the poll loop rather than returning false: an id the
          // server never minted cannot start existing by waiting.
          assertIdForPath(entries, options.unsyncedWorktreeId, options.unsyncedWorktreePath);
          const ids = entries.map((entry) => entry.id);
          return ids.includes(options.worktreeId) && !ids.includes(options.unsyncedWorktreeId);
        },
        `${options.unsyncedWorktreeId} to be on disk but not yet registered`,
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/repositories`, options.locale);
      // The outcome is read from the server, not from the button's own spinner:
      // the footage must not claim a registration the database never got.
      await clickUntilEffective(
        page.getByTestId('sync-all-button'),
        async () => {
          const entries = readWorktreeEntries(
            await defaultWaitDeps.fetchJson(`${baseUrl}/api/worktrees`),
          );
          assertIdForPath(entries, options.unsyncedWorktreeId, options.unsyncedWorktreePath);
          return entries.some((entry) => entry.id === options.unsyncedWorktreeId);
        },
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
        { id: options.worktreeId, path: options.worktreePath },
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
  {
    id: 'verify-red',
    title: 'Run the declared gate before any work and read exit 20 off it',
    kind: 'terminal',
    viewport: 'pc',
    // The seed worktree that branched off `main` without the fix, so the gate
    // is red for the reason the tutorial says it is: the repository's own
    // `node --test` fails there. No session is involved — a verification run is
    // server-side work on a checkout — so the only precondition is that the
    // worktree is registered.
    prepare: ({ baseUrl, options, state }) => {
      const id = state.CM_DEMO_LOGIN_WORKTREE_ID ?? '';
      if (!id) {
        throw new Error(
          'state.env has no CM_DEMO_LOGIN_WORKTREE_ID — the red-gate take has no checkout to fail in',
        );
      }
      return waitForWorktree(
        baseUrl,
        { id, path: state.CM_DEMO_LOGIN_WORKTREE_PATH ?? '' },
        () => true,
        'registered, so the gate has a checkout to run in',
        options.timeoutMs,
      ).then(() => undefined);
    },
    record: async ({ options, outFile, workDir }) => {
      await recordTerminalScene({
        statePath: options.statePath,
        session: `${options.cliSession}-verify`,
        mode: 'verify-red',
        tmuxSocket: options.tmuxSocket,
        frame: { ...options.viewport },
        outFile,
        workDir,
        intervalMs: TERMINAL_CAPTURE_INTERVAL_MS,
        timeoutMs: Math.max(options.timeoutMs, TERMINAL_TAKE_TIMEOUT_MS),
        // The last frame is the run read back out of the history, and this is
        // the substring that says it was recorded as a failure of the declared
        // gate. A take that stopped earlier — or one whose gate went green —
        // is a failed take, not a short one.
        requireInFinalFrame: 'failed: unit',
      });
    },
  },
  {
    id: 'evidence',
    title: 'Show the record a finished contract leaves behind',
    kind: 'terminal',
    viewport: 'pc',
    // Same precondition as `contract-verify`: the take runs the contract first
    // and then reads back what it wrote, so it needs the adopted session the
    // contract is sent to.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      ).then(() => undefined),
    record: async ({ options, outFile, workDir }) => {
      await recordTerminalScene({
        statePath: options.statePath,
        session: `${options.cliSession}-evidence`,
        mode: 'evidence',
        tmuxSocket: options.tmuxSocket,
        frame: { ...options.viewport },
        outFile,
        workDir,
        intervalMs: TERMINAL_CAPTURE_INTERVAL_MS,
        timeoutMs: Math.max(options.timeoutMs, TERMINAL_TAKE_TIMEOUT_MS),
        // The last line `task show` prints for a judged task. Requiring it is
        // what separates "the record is on screen" from "the pane got as far as
        // clearing itself".
        requireInFinalFrame: 'GATE unit passed',
      });
    },
  },
  // ---------------------------------------------------- README hero (#2381) --
  {
    id: 'repo-tab-switch',
    title: 'Switch repository and branch from the header tab strip',
    viewport: 'pc',
    // The take starts in the second repository, whose worktree id is the seed
    // directory's basename (`deriveWorktreeId`); its page gets the same layout
    // as the one the switch lands on, or the activity pane would close mid-cut.
    seedStorage: (options, state) => {
      const docsId = path.basename(state.CM_DEMO_SEED_REPO_2 ?? '');
      return {
        ...heroPcStorage(options, null),
        ...(docsId
          ? {
              ...chatSurfaceStorage(docsId),
              [`${ACTIVITY_BAR_STORAGE_KEY_PREFIX}${docsId}`]: ACTIVITY_CLOSED_SENTINEL,
            }
          : {}),
      };
    },
    // The strip needs two repositories to switch between. The second seed
    // (`cmdemo-docs`) is registered here by the same route the add-repository
    // scene drives on camera — a path scan, never a clone — so a cut that
    // places this scene and not that one still has two tabs.
    prepare: async ({ baseUrl, options, state }) => {
      const target = secondSeedRepository(state);
      const paths = readRepositoryPaths(await defaultWaitDeps.fetchJson(`${baseUrl}/api/repositories`));
      if (!paths.includes(target)) {
        await postJson(`${baseUrl}/api/repositories/scan`, { repositoryPath: target });
      }
      await waitForJson(
        `${baseUrl}/api/worktrees`,
        readWorktreeEntries,
        (entries) => {
          assertIdForPath(entries, options.worktreeId, options.worktreePath);
          const live = entries.find((entry) => entry.id === options.worktreeId);
          return live?.isSessionRunning === true && worktreeAtPath(entries, target) !== undefined;
        },
        `${path.basename(target)} to be registered and ${options.worktreeId} to show a live session`,
        options.timeoutMs,
      );
    },
    run: async ({ page, baseUrl, options, state }) => {
      const entries = readWorktreeEntries(await defaultWaitDeps.fetchJson(`${baseUrl}/api/worktrees`));
      const docs = worktreeAtPath(entries, secondSeedRepository(state));
      const live = entries.find((entry) => entry.id === options.worktreeId);
      if (!docs || !live?.branch) {
        throw new Error('the second repository or the live worktree left /api/worktrees between prepare and run');
      }
      // Start in the OTHER repository, so the switch has somewhere to go.
      await gotoLocalized(page, `${baseUrl}/worktrees/${docs.id}?${CHAT_VIEW_QUERY}`, options.locale);
      const strip = page.getByTestId('repository-tab-strip');
      await strip.waitFor({ state: 'visible', timeout: options.timeoutMs });
      const tab = strip.locator(
        `[data-testid="repository-tab"][data-repository="${path.basename(state.CM_DEMO_SEED_REPO ?? '')}"]`,
      );
      await tab.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(600);

      const popover = page.getByTestId('repository-tab-popover');
      await clickUntilEffective(tab, () => popover.isVisible(), 'the repository tab', options.timeoutMs);
      // The rows carry the sidebar's status dots; hold so they can be read.
      // Long on purpose: compose.sh keeps the tail, and the landing below —
      // a navigation and a transcript fetch — is what pushes the popover out
      // of the slot when it runs slow.
      const row = popover.getByTestId('branch-list-item').filter({ hasText: live.branch });
      await row.first().waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(2200);

      await row.first().click();
      // The popover closes under the pointer, which is then resting on
      // whatever was drawn underneath — the split toolbar's remove button,
      // with its tooltip — for the whole route transition. Park the pointer
      // over the transcript at once.
      await page.mouse.move(Math.round(options.viewport.width * 0.6), Math.round(options.viewport.height * 0.55));
      await page.waitForURL(`**/worktrees/${options.worktreeId}**`, { timeout: options.timeoutMs });
      // The header naming the branch is the landing; the transcript behind it
      // may still be loading, and waiting that out pushed the popover out of
      // the slot (measured: 3-4 s in a fresh context). The transition itself
      // is about 2 s on the dev server, which is why the slot is 5 s.
      // By `title`: the visible text is truncated to DESKTOP_BRANCH_MAX_LENGTH.
      await page
        .locator(`[data-testid="desktop-branch-name"][title="${live.branch}"]`)
        .waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(800);
    },
  },
  {
    id: 'agent-tabs',
    title: 'Five agents in one worktree: the roster and the split\'s instance picker',
    viewport: 'pc',
    seedStorage: (options) => heroPcStorage(options, 'agent'),
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options, state }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}?${CHAT_VIEW_QUERY}`, options.locale);
      await page.getByTestId('chat-surface').waitFor({ state: 'visible', timeout: options.timeoutMs });
      // Every agent env-up.sh seeded has a roster row — asserted, so a roster
      // that came back short (the client default is three) fails the take
      // rather than filming "three agents".
      const agents = (state.CM_DEMO_AGENTS ?? '').split(',').filter((id) => id !== '');
      if (agents.length === 0) throw new Error('state.env has no CM_DEMO_AGENTS — re-run env-up.sh');
      for (const agent of agents) {
        await page.getByTestId(`agent-instance-cli-${agent}`).waitFor({ state: 'visible', timeout: options.timeoutMs });
        await page.getByTestId(`desktop-agent-status-${agent}`).waitFor({ state: 'visible', timeout: options.timeoutMs });
      }
      await page.waitForTimeout(800);
      // The split's own instance picker lists the five by name, unabridged —
      // the header row folds idle agents into dots and the roster's alias
      // inputs truncate at the pane's width.
      const picker = page.getByTestId('cli-selector-0');
      await picker.click();
      const menu = page.getByRole('menu');
      await menu.waitFor({ state: 'visible', timeout: options.timeoutMs });
      // The list of five is the payoff, and the tail is what compose.sh
      // keeps, so the take ends on it open; the next scene opens its own page.
      await page.waitForTimeout(2600);
    },
  },
  {
    id: 'delegate-ask',
    title: 'Delegate to the next session: brief in, commandmate ask out, reply back',
    viewport: 'pc',
    seedStorage: (options) => heroPcStorage(options, 'agent'),
    // The first send of the cut: the hero cassette's delegation pass. Idle is
    // required, not merely live — a pane already mid-pass would consume this
    // send as its approval answer.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) =>
          worktree.isSessionRunning === true &&
          worktree.isProcessing !== true &&
          worktree.isWaitingForResponse !== true,
        'idle with a live agent session',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}?${CHAT_VIEW_QUERY}`, options.locale);
      const composer = page.getByTestId('message-input-textarea');
      await composer.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await composer.click();
      // The ask first, then the brief underneath it: `insertIntoVisibleComposer`
      // appends after a blank line, and Enter would send, so the two are
      // never joined by a typed newline.
      await composer.pressSequentially(DELEGATE_ASK_MESSAGE, { delay: 9 });

      await page.getByTestId('agent-instance-menu-codex').click();
      const insert = page.getByTestId('agent-instance-delegate-codex');
      await insert.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await insert.click();
      // The brief is the product's own text; wait for the line that names the
      // command rather than for a fixed time.
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="message-input-textarea"]') as HTMLTextAreaElement | null)
            ?.value.includes('--instance codex') ?? false,
        undefined,
        { timeout: options.timeoutMs },
      );
      await page.waitForTimeout(500);
      await page.getByTestId('send-message-button').click();
      await dismissQueuedBusyToast(page);

      // Server-side truth, in order: the claude pane starts, codex is asked,
      // and the reply — with its tool-call chip — lands in the transcript.
      const target = { id: options.worktreeId, path: options.worktreePath };
      await waitForWorktree(baseUrl, target, (w) => w.isProcessing === true, 'generating', options.timeoutMs);
      await lastFileLink(page).waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.getByTestId('chat-tool-log-body').last().waitFor({ state: 'visible', timeout: options.timeoutMs });
      // Short on purpose: the tail compose.sh keeps starts before the reply
      // landed, so the codex pill going `Running` is in the cut as well.
      await page.waitForTimeout(1200);
    },
  },
  {
    id: 'reply-file-link',
    title: 'Open the file a reply links to, beside the chat',
    viewport: 'pc',
    seedStorage: (options) => heroPcStorage(options, null),
    // The delegation reply has to be on record: the claude pane back to idle
    // after its pass means the transcript was read and the row written.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isSessionRunning === true && worktree.isProcessing !== true,
        'idle after the delegation',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}?${CHAT_VIEW_QUERY}`, options.locale);
      await page.getByTestId('chat-surface').waitFor({ state: 'visible', timeout: options.timeoutMs });
      // The reply of the session that was ASKED, from its own tab.
      await clickUntilEffective(
        page.getByTestId('desktop-agent-status-codex'),
        async () => (await page.getByTestId('desktop-agent-status-codex').getAttribute('aria-pressed')) === 'true',
        'the Codex instance tab',
        options.timeoutMs,
      );
      const link = page.getByTestId('chat-file-link').first();
      await link.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(1500);
      await link.click();
      // FilePanelSplit mounts the pane only once the file came back.
      await page.getByTestId('file-panel-pane').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(2300);
    },
  },
  {
    id: 'mobile-approve',
    title: 'Approve a confirmation from the phone, on the chat tab',
    viewport: 'mobile',
    seedStorage: (options) => chatSurfaceStorage(options.worktreeId),
    // The hero cassette's second pass: sent from here when the pane is idle
    // (the same self-service attention-badge does), then waited on until the
    // approval frame is up. Waiting is the whole of `prepare` so the sheet is
    // already on screen when the camera rolls.
    prepare: async ({ baseUrl, options }) => {
      const target = { id: options.worktreeId, path: options.worktreePath };
      const live = await waitForWorktree(
        baseUrl,
        target,
        (worktree) => worktree.isSessionRunning === true && worktree.isProcessing !== true,
        'idle with a live agent session',
        options.timeoutMs,
      );
      if (live.isWaitingForResponse !== true) {
        await postJson(`${baseUrl}/api/worktrees/${options.worktreeId}/send`, {
          content: MOBILE_APPROVE_MESSAGE,
        });
      }
      await waitForWorktree(
        baseUrl,
        target,
        (worktree) => worktree.isWaitingForResponse === true,
        'waiting for a response',
        options.timeoutMs,
      );
    },
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}?${CHAT_VIEW_QUERY}`, options.locale);
      // The session row (#2357) is the model the phone shows; absent means the
      // SessionStart env-up.sh announced carried no model, which is a seed
      // defect rather than a slow page.
      await page.getByTestId('mobile-session-model').waitFor({ state: 'visible', timeout: options.timeoutMs });
      const sheet = page.getByTestId('mobile-prompt-sheet');
      await sheet.waitFor({ state: 'visible', timeout: options.timeoutMs });
      // Long: the tail is what compose.sh keeps, and after the tap the sheet
      // spends ~2.5 s on "Sending…" (the answer typed, Enter, read-back) and
      // the context another second closing — measured — so the seconds the
      // sheet is simply on screen have to be bought up front.
      await page.waitForTimeout(3800);
      await sheet
        .getByRole('button', { name: submitButtonLabel(options.repoRoot, options.locale) })
        .click();
      // The sheet closes when POST prompt-response has succeeded — the answer
      // is in the pane — and that is the beat the shot ends on. The server's
      // own `isWaitingForResponse` follows within a capture-cache TTL and is
      // asserted in `after`, off camera: waited for here it would be the
      // seconds compose.sh keeps, and the sheet would be cut.
      await sheet.waitFor({ state: 'hidden', timeout: options.timeoutMs });
      await page.waitForTimeout(500);
    },
    after: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) => worktree.isWaitingForResponse === false,
        'released by the answer',
        options.timeoutMs,
      ).then(() => undefined),
  },
  {
    id: 'mobile-file-link',
    title: 'Open the file a reply links to, on the phone',
    viewport: 'mobile',
    seedStorage: (options) => chatSurfaceStorage(options.worktreeId),
    // The approval pass has to have closed: its reply carries the link.
    prepare: ({ baseUrl, options }) =>
      waitForWorktree(
        baseUrl,
        { id: options.worktreeId, path: options.worktreePath },
        (worktree) =>
          worktree.isSessionRunning === true &&
          worktree.isProcessing !== true &&
          worktree.isWaitingForResponse !== true,
        'idle after the approval',
        options.timeoutMs,
      ).then(() => undefined),
    run: async ({ page, baseUrl, options }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${options.worktreeId}?${CHAT_VIEW_QUERY}`, options.locale);
      const link = lastFileLink(page);
      await link.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await link.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      await link.click();
      // The phone opens files in FileViewer's modal (`modal-panel`, titled
      // with the path); the copy button is only drawn once the content is in.
      const viewer = page.getByTestId('modal-panel');
      await viewer.waitFor({ state: 'visible', timeout: options.timeoutMs });
      await viewer.getByTestId('copy-content-button').waitFor({ state: 'visible', timeout: options.timeoutMs });
      await page.waitForTimeout(1800);
    },
  },
];

/**
 * Runs in the page before any of its own scripts: the seeded preferences are
 * what the app's first render reads. `try` because a browser with site data
 * blocked throws on the property access, and the take should still film.
 */
function seedLocalStorage(entries: Record<string, string>): void {
  try {
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    /* storage unavailable: the page renders its defaults */
  }
}

/**
 * Compile the routes the takes will hit, off camera.
 *
 * The demo server is `tsx server.ts` in development mode, which compiles a
 * page on its first request. That first request used to be a scene's own
 * navigation, so the opening seconds of a take were a blank page — and for
 * a scene that keeps its head (`head:` in the storyboard) rather than its
 * tail, that blank page is what ships. One throwaway context, closed before
 * any recording starts.
 */
async function warmUp(
  browser: import('@playwright/test').Browser,
  baseUrl: string,
  options: RecordOptions,
): Promise<void> {
  const context = await browser.newContext({ viewport: { ...options.viewport }, locale: options.locale });
  await context.addCookies([localeCookie(baseUrl, options.locale)]);
  const page = await context.newPage();
  try {
    for (const url of [
      `${baseUrl}/`,
      `${baseUrl}/worktrees/${options.worktreeId}`,
      `${baseUrl}/worktrees/${options.worktreeId}?${CHAT_VIEW_QUERY}`,
    ]) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: options.timeoutMs }).catch(() => undefined);
    }
    // API routes a take calls for the first time mid-shot: the two reads
    // behind the delegation brief (`fetchDelegationBrief`) and the file the
    // reply links to. Compiled here, each costs a few hundred milliseconds
    // on camera instead of a couple of seconds.
    for (const url of [
      `${baseUrl}/api/worktrees/${options.worktreeId}/cli-reference`,
      `${baseUrl}/api/worktrees/${options.worktreeId}/resolve-target?instance=codex`,
      `${baseUrl}/api/worktrees/${options.worktreeId}/files/README.md`,
    ]) {
      await fetch(url).catch(() => undefined);
    }
  } finally {
    await context.close();
  }
}

export function viewportFor(scene: Scene, options: RecordOptions): { width: number; height: number } {
  return scene.viewport === 'mobile' ? { ...MOBILE_VIEWPORT } : { ...options.viewport };
}

/** Scratch space for the terminal take, always outside the repository. */
export function terminalWorkDir(options: RecordOptions, state: DemoState): string {
  if (options.workDir) return options.workDir;
  const base = state.CM_DEMO_STATE_DIR || path.dirname(options.statePath);
  return path.join(base, 'terminal-work');
}

/** The scenes a run will film: `--scene` when given, the whole library otherwise. */
export function selectedScenes(options: RecordOptions): Scene[] {
  return options.sceneIds.length
    ? SCENES.filter((scene) => options.sceneIds.includes(scene.id))
    : SCENES;
}

/**
 * Take the worktree ids and paths from state.env for whatever the command line
 * did not supply, and refuse to record when nothing supplied them.
 *
 * env-up.sh derives the ids from the seed directories it just created and
 * writes them to state.env, which makes the state file — not this source — the
 * place the harness and the server agree. Silently defaulting is what Issue
 * #1809 removed: see the note next to DEFAULT_MESSAGE.
 */
export function resolveRecordOptions(options: RecordOptions, state: DemoState): RecordOptions {
  const resolved: RecordOptions = {
    ...options,
    cliSession: options.cliSession || DEFAULT_CLI_SESSION,
    worktreeId: options.worktreeId || state.CM_DEMO_WORKTREE_ID || '',
    worktreePath: options.worktreePath || state.CM_DEMO_WORKTREE_PATH || '',
    unsyncedWorktreeId: options.unsyncedWorktreeId || state.CM_DEMO_UNSYNCED_WORKTREE_ID || '',
    unsyncedWorktreePath:
      options.unsyncedWorktreePath || state.CM_DEMO_UNSYNCED_WORKTREE_PATH || '',
  };

  if (!resolved.worktreeId) {
    throw new Error(
      'no worktree id: pass --worktree, set CM_DEMO_WORKTREE_ID, or re-run env-up.sh so ' +
        'state.env records the id it derived from the seed directory',
    );
  }
  if (
    !resolved.unsyncedWorktreeId &&
    selectedScenes(resolved).some((scene) => scene.id === 'sync-worktrees')
  ) {
    throw new Error(
      "scene 'sync-worktrees' needs the id of the worktree the boot sync missed: pass " +
        '--unsynced-worktree, set CM_DEMO_UNSYNCED_WORKTREE_ID, or re-run env-up.sh',
    );
  }
  return resolved;
}

// ---------------------------------------------------------------- main -------

export interface RecordOutcome {
  written: string[];
  /** Scenes that reported themselves unfilmable, with the reason. */
  skipped: { id: string; reason: string }[];
}

export async function recordScenes(requested: RecordOptions): Promise<string[]> {
  return (await recordScenesDetailed(requested)).written;
}

export async function recordScenesDetailed(requested: RecordOptions): Promise<RecordOutcome> {
  const state = parseStateFile(fs.readFileSync(requested.statePath, 'utf8'));
  const options = resolveRecordOptions(requested, state);
  const outDir = options.outDir || state.videoDir;
  if (!outDir) throw new Error('no output directory: pass --out or re-run env-up.sh');
  fs.mkdirSync(outDir, { recursive: true });

  // One cross-check before the browser is even launched: the server has to
  // agree that the id this run was handed is the one it minted for the seed
  // directory. Every scene then carries the same pair, so a rule change shows
  // up as a named mismatch instead of a scene-by-scene timeout.
  if (options.worktreePath) {
    await waitForWorktree(
      state.baseUrl,
      { id: options.worktreeId, path: options.worktreePath },
      () => true,
      'present in the worktree list',
      options.timeoutMs,
    );
  }

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: options.headless });
  const selected = selectedScenes(options);
  const written: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  try {
    if (selected.some((scene) => !isTerminalScene(scene))) {
      await warmUp(browser, state.baseUrl, options);
    }
    for (const scene of selected) {
      const target = path.join(outDir, `${scene.id}.webm`);
      try {
        // Outside the recording: see SceneCommon.prepare.
        await scene.prepare?.({ baseUrl: state.baseUrl, options, state });
      } catch (error) {
        if (!(error instanceof SceneUnavailableError)) throw error;
        // Loud in both directions. Without --allow-skip this is a failure, so
        // the operator learns the reason now rather than meeting an absent file
        // in ffmpeg an hour later.
        process.stderr.write(`skipping ${scene.id}: ${error.message}\n`);
        if (!options.allowSkip) throw error;
        skipped.push({ id: scene.id, reason: error.message });
        continue;
      }

      if (isTerminalScene(scene)) {
        // No browser context: the tmux capture loop is this scene's camera, and
        // it starts when the pane does.
        await scene.record({
          baseUrl: state.baseUrl,
          options,
          state,
          outFile: target,
          workDir: terminalWorkDir(options, state),
        });
        written.push(target);
        process.stdout.write(`recorded ${scene.id} -> ${target}\n`);
        continue;
      }

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
      const seeded = scene.seedStorage?.(options, state);
      if (seeded && Object.keys(seeded).length > 0) {
        await context.addInitScript(seedLocalStorage, seeded);
      }
      const page = await context.newPage();
      const video = page.video();
      try {
        await scene.run({ page, baseUrl: state.baseUrl, options, state });
      } finally {
        await context.close();
      }
      if (video) {
        await video.saveAs(target);
        await video.delete();
        written.push(target);
        process.stdout.write(`recorded ${scene.id} -> ${target}\n`);
      }
      // Off camera: see SceneCommon.after.
      await scene.after?.({ baseUrl: state.baseUrl, options, state });
    }
  } finally {
    await browser.close();
  }

  for (const skip of skipped) {
    process.stdout.write(`skipped ${skip.id}: ${skip.reason}\n`);
  }
  return { written, skipped };
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
