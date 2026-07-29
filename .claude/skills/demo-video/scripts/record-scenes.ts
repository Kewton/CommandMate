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

export interface RecordOptions {
  /** Path to the state file env-up.sh wrote. */
  statePath: string;
  /** Directory the webm files are written to. Never inside the repository. */
  outDir: string;
  /** Scene ids to record; empty means "all". */
  sceneIds: string[];
  locale: string;
  colorScheme: 'light' | 'dark';
  viewport: { width: number; height: number };
  /** Message typed into the composer in the send-message scene. */
  message: string;
  /** Worktree the send-message scene drives. */
  worktreeId: string;
  /** Upper bound for a single synchronisation point, in ms. */
  timeoutMs: number;
  headless: boolean;
}

export interface DemoState {
  baseUrl: string;
  videoDir: string;
  [key: string]: string;
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
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
      case '--locale': options.locale = next(i, arg); i += 1; break;
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

export interface Scene {
  id: string;
  title: string;
  run: (ctx: SceneContext) => Promise<void>;
}

export const SCENES: Scene[] = [
  {
    id: 'overview',
    title: 'Branch list with live per-worktree status',
    run: async ({ page, baseUrl, options }) => {
      // Sync point: the seed repository's three worktrees have to be in the API
      // before the page is worth filming.
      await waitForWorktree(
        baseUrl,
        options.worktreeId,
        () => true,
        'present in the worktree list',
        options.timeoutMs,
      );
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('branch-list').waitFor({ state: 'visible' });
      const items = page.getByTestId('branch-list-item');
      await items.first().waitFor({ state: 'visible' });
      await page.getByTestId('status-indicator').first().waitFor({ state: 'visible' });
      // Hold the finished frame; nothing is being decided here.
      await page.waitForTimeout(2500);
    },
  },
  {
    id: 'send-message',
    title: 'Send a message and watch the agent run to completion',
    run: async ({ page, baseUrl, options }) => {
      await waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isSessionRunning === true,
        'showing a live agent session',
        options.timeoutMs,
      );

      await page.goto(`${baseUrl}/worktrees/${options.worktreeId}`, {
        waitUntil: 'domcontentloaded',
      });
      const composer = page.getByTestId('message-input-textarea');
      await composer.waitFor({ state: 'visible' });
      await composer.click();
      await composer.pressSequentially(options.message, { delay: 45 });
      await page.getByTestId('send-message-button').click();

      // The two transitions the demo exists to show. Both are read from the
      // server, so the footage cannot claim a state the product never reached.
      await waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isProcessing === true,
        'generating',
        options.timeoutMs,
      );
      await waitForWorktree(
        baseUrl,
        options.worktreeId,
        (worktree) => worktree.isProcessing === false && worktree.isSessionRunning === true,
        'back to ready',
        options.timeoutMs,
      );
      await page.waitForTimeout(2000);
    },
  },
];

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
      const context: BrowserContext = await browser.newContext({
        viewport: options.viewport,
        // Phase A plumbs locale/theme through to the browser context; switching
        // the app's own locale and theme lands with the storyboard (#1554).
        locale: options.locale,
        colorScheme: options.colorScheme,
        recordVideo: { dir: outDir, size: options.viewport },
      });
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
