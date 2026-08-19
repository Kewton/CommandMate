/**
 * stills.ts — the five product screenshots, made in the isolated environment
 * (Issue #1810).
 *
 * These images are the LP hero, the og:image and the README gallery. Until now
 * they were taken by hand, which is why #1225 could not be reproduced: nobody
 * could say which machine, which repository or which state they came from. The
 * same env-up.sh instance that films the video takes them here, so the only
 * repository that can appear in one is the throwaway seed.
 *
 * Two rules are enforced rather than remembered:
 *
 *   1. **Nothing personal on screen.** The rendered text of every shot is read
 *      back and searched for home directories, private LAN addresses and the
 *      retired product name. A hit fails the shot — the fix is to change the
 *      composition, never to paint over it.
 *   2. **The byte budget is a gate, not a target.** `screenshot-desktop.webp` is
 *      the LCP element and `landing-page.test.ts` pins it under 100KB. Quality
 *      is stepped down, then the image is stepped down in size; if nothing
 *      fits, the file is removed and the run fails. Writing an over-budget
 *      image would turn a red test into a red *other* test, later, in CI.
 *
 *   npx tsx .claude/skills/demo-video/scripts/stills.ts --state ~/.commandmate-demo/state.env
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Page } from '@playwright/test';

import {
  DEFAULT_VIEWPORT,
  MOBILE_VIEWPORT,
  gotoLocalized,
  parseStateFile,
  waitForWorktree,
  type DemoState,
  type Locale,
} from './record-scenes';

// ------------------------------------------------------------- shots --------

export interface Still {
  /** File stem, shared by `docs/images/<stem>.png` and `website/assets/img/<stem>.webp`. */
  id: string;
  viewport: { width: number; height: number };
  /** 2x for desktop, 3x for phone — what the existing assets were taken at. */
  deviceScaleFactor: number;
  /** Bytes the webp must come in under. */
  budgetBytes: number;
  open: (ctx: StillContext) => Promise<void>;
}

export interface StillContext {
  page: Page;
  baseUrl: string;
  locale: Locale;
  worktreeId: string;
  state: DemoState;
}

/** Everything but the wide worktree shot shares the hero's budget. */
export const DEFAULT_BUDGET_BYTES = 100_000;
/**
 * The one documented exception (`website/assets/media/README.md`): the desktop
 * worktree screenshot is a three-pane layout whose detail is the point, and it
 * is neither the LCP element nor the og:image.
 */
export const WIDE_BUDGET_BYTES = 200_000;

export const STILLS: Still[] = [
  {
    id: 'screenshot-desktop',
    viewport: { ...DEFAULT_VIEWPORT },
    deviceScaleFactor: 2,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    open: async ({ page, baseUrl, locale }) => {
      await gotoLocalized(page, `${baseUrl}/`, locale);
      await page.getByTestId('branch-list').waitFor({ state: 'visible' });
      await page.getByTestId('status-indicator').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: 'screenshot-worktree-desktop',
    viewport: { ...DEFAULT_VIEWPORT },
    deviceScaleFactor: 2,
    budgetBytes: WIDE_BUDGET_BYTES,
    open: async ({ page, baseUrl, locale, worktreeId }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${worktreeId}`, locale);
      await page.getByTestId('message-input-textarea').waitFor({ state: 'visible' });
      await page.waitForTimeout(2000);
    },
  },
  {
    id: 'screenshot-mobile',
    viewport: { ...MOBILE_VIEWPORT },
    deviceScaleFactor: 3,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    open: async ({ page, baseUrl, locale }) => {
      await gotoLocalized(page, `${baseUrl}/sessions`, locale);
      await page.getByTestId('global-mobile-nav').waitFor({ state: 'visible' });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: 'screenshot-worktree-mobile',
    viewport: { ...MOBILE_VIEWPORT },
    deviceScaleFactor: 3,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    open: async ({ page, baseUrl, locale, worktreeId }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${worktreeId}`, locale);
      await page.getByTestId('mobile-tab-bar').waitFor({ state: 'visible' });
      await page.getByTestId('mobile-tab-history').click();
      await page.waitForTimeout(1500);
    },
  },
  {
    id: 'screenshot-worktree-mobile-terminal',
    viewport: { ...MOBILE_VIEWPORT },
    deviceScaleFactor: 3,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    open: async ({ page, baseUrl, locale, worktreeId }) => {
      await gotoLocalized(page, `${baseUrl}/worktrees/${worktreeId}`, locale);
      await page.getByTestId('mobile-tab-bar').waitFor({ state: 'visible' });
      await page.getByTestId('mobile-tab-terminal').click();
      await page.waitForTimeout(1500);
    },
  },
];

// ------------------------------------------------------------- leaks --------

/**
 * Private LAN addresses. A screenshot taken on a machine reachable at
 * `192.168.x.x` used to carry that address in the header (#1272), which is one
 * of the things that got the old assets withdrawn.
 */
const PRIVATE_IP =
  /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

/** Absolute home directories, whichever platform's spelling. */
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[A-Za-z0-9._-]+/;

/** The retired product name; a shot carrying it dates the whole gallery. */
const RETIRED_NAME = /MyCodeBranchDesk/;

/**
 * Everything in `text` that must not be in a published screenshot.
 *
 * A pure function so the rule can be tested without a browser, and so the
 * failure names the offending substring rather than "something leaked".
 */
export function findLeaks(text: string, extraForbidden: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const pattern of [PRIVATE_IP, HOME_PATH, RETIRED_NAME]) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  for (const literal of extraForbidden) {
    if (literal && text.includes(literal)) found.push(literal);
  }
  return [...new Set(found)];
}

/**
 * Read the shot's rendered text back and fail on anything private.
 *
 * `innerText`, not the DOM: what a viewer can read off the image is what is
 * laid out, and a value hidden behind `display:none` is not in the picture.
 */
export async function assertNothingPrivateOnScreen(
  page: Page,
  stillId: string,
  extraForbidden: readonly string[] = [],
): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  const leaks = findLeaks(text, extraForbidden);
  if (leaks.length > 0) {
    throw new Error(
      `${stillId} shows something that must not be published: ${leaks.join(', ')}. ` +
        'Compose the shot so it is off screen — do not mask it.',
    );
  }
}

// ------------------------------------------------------------ budget --------

export interface EncodeAttempt {
  quality: number;
  /** 1 keeps the capture's own pixel size; below 1 re-samples it. */
  scale: number;
}

/**
 * Quality first, size second.
 *
 * Dropping quality costs detail the reader does not miss on a screenshot of
 * flat UI; dropping resolution costs legibility of the very text the shot
 * exists to show. So every quality step is tried before the first resize.
 */
export const QUALITY_LADDER: readonly number[] = [82, 76, 70, 62, 55, 48, 40];
export const SCALE_LADDER: readonly number[] = [1, 0.8, 0.65];

export function encodeLadder(): EncodeAttempt[] {
  return SCALE_LADDER.flatMap((scale) => QUALITY_LADDER.map((quality) => ({ quality, scale })));
}

export interface BudgetResult {
  attempt: EncodeAttempt;
  bytes: number;
}

/**
 * The first rung whose output fits, or null when the ladder runs out.
 *
 * Null is a failure the caller must turn into "write nothing" — the same
 * discipline `video-to-gif` applies. An over-budget hero silently committed is
 * a red `landing-page.test.ts` for whoever touches the LP next, with no clue
 * pointing back here.
 */
export function fitToBudget(
  attempts: readonly EncodeAttempt[],
  encode: (attempt: EncodeAttempt) => number,
  budgetBytes: number,
): BudgetResult | null {
  for (const attempt of attempts) {
    const bytes = encode(attempt);
    if (bytes < budgetBytes) return { attempt, bytes };
  }
  return null;
}

export interface WebpDeps {
  /** Encode `png` into `out` and return the resulting size in bytes. */
  encode: (attempt: EncodeAttempt, png: string, out: string) => number;
  remove: (file: string) => void;
}

export function cwebpArgs(attempt: EncodeAttempt, png: string, out: string, width: number): string[] {
  const args = ['-quiet', '-q', String(attempt.quality)];
  if (attempt.scale !== 1) {
    args.push('-resize', String(Math.round(width * attempt.scale)), '0');
  }
  return [...args, png, '-o', out];
}

export const defaultWebpDeps = (width: number): WebpDeps => ({
  encode: (attempt, png, out) => {
    execFileSync('cwebp', cwebpArgs(attempt, png, out, width), { stdio: ['ignore', 'ignore', 'pipe'] });
    return fs.statSync(out).size;
  },
  remove: (file) => fs.rmSync(file, { force: true }),
});

/**
 * Write `out` at the best rung that fits, or write nothing and throw.
 *
 * The partially-written file is removed on failure: cwebp leaves its last
 * attempt on disk, and that attempt is by definition the over-budget one.
 */
export function writeWebpWithinBudget(
  png: string,
  out: string,
  budgetBytes: number,
  deps: WebpDeps,
): BudgetResult {
  const result = fitToBudget(encodeLadder(), (attempt) => deps.encode(attempt, png, out), budgetBytes);
  if (!result) {
    deps.remove(out);
    throw new Error(
      `${path.basename(out)} does not fit in ${budgetBytes} bytes at any quality down to ` +
        `${QUALITY_LADDER[QUALITY_LADDER.length - 1]} or any scale down to ` +
        `${SCALE_LADDER[SCALE_LADDER.length - 1]}; nothing was written`,
    );
  }
  return result;
}

// --------------------------------------------------------------- cli --------

export interface StillsOptions {
  statePath: string;
  /** Where the PNGs go; `docs/images` in the repository by default. */
  pngDir: string;
  /** Where the webp files go; `website/assets/img` by default. */
  webpDir: string;
  locale: Locale;
  colorScheme: 'light' | 'dark';
  worktreeId: string;
  worktreePath: string;
  stillIds: string[];
  timeoutMs: number;
  headless: boolean;
  repoRoot: string;
}

function defaultStatePath(): string {
  const home = process.env.CM_DEMO_HOME ?? path.join(os.homedir(), '.commandmate-demo');
  return path.join(home, 'state.env');
}

export function parseStillsArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): StillsOptions {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const options: StillsOptions = {
    statePath: defaultStatePath(),
    pngDir: path.join(repoRoot, 'docs/images'),
    webpDir: path.join(repoRoot, 'website/assets/img'),
    // The published gallery is the English UI; the LP is an English page.
    locale: 'en',
    colorScheme: 'light',
    worktreeId: env.CM_DEMO_WORKTREE_ID ?? '',
    worktreePath: env.CM_DEMO_WORKTREE_PATH ?? '',
    stillIds: [],
    timeoutMs: 60_000,
    headless: true,
    repoRoot,
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
      case '--png-dir': options.pngDir = next(i, arg); i += 1; break;
      case '--webp-dir': options.webpDir = next(i, arg); i += 1; break;
      case '--worktree': options.worktreeId = next(i, arg); i += 1; break;
      case '--worktree-path': options.worktreePath = next(i, arg); i += 1; break;
      case '--still': options.stillIds.push(next(i, arg)); i += 1; break;
      case '--theme': {
        const value = next(i, arg);
        if (value !== 'light' && value !== 'dark') {
          throw new Error(`--theme must be light or dark, got '${value}'`);
        }
        options.colorScheme = value;
        i += 1;
        break;
      }
      case '--locale': {
        const value = next(i, arg);
        if (value !== 'ja' && value !== 'en') {
          throw new Error(`--locale must be one of ja|en, got '${value}'`);
        }
        options.locale = value;
        i += 1;
        break;
      }
      case '--headed': options.headless = false; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  const unknown = options.stillIds.filter((id) => !STILLS.some((still) => still.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown still(s): ${unknown.join(', ')}. Known: ${STILLS.map((s) => s.id).join(', ')}`,
    );
  }
  return options;
}

export function selectedStills(options: StillsOptions): Still[] {
  return options.stillIds.length
    ? STILLS.filter((still) => options.stillIds.includes(still.id))
    : STILLS;
}

export interface StillResult {
  id: string;
  png: string;
  webp: string;
  bytes: number;
  attempt: EncodeAttempt;
}

export async function captureStills(requested: StillsOptions): Promise<StillResult[]> {
  const state = parseStateFile(fs.readFileSync(requested.statePath, 'utf8'));
  const worktreeId = requested.worktreeId || state.CM_DEMO_WORKTREE_ID || '';
  const worktreePath = requested.worktreePath || state.CM_DEMO_WORKTREE_PATH || '';
  if (!worktreeId) {
    throw new Error(
      'no worktree id: pass --worktree, set CM_DEMO_WORKTREE_ID, or re-run env-up.sh so ' +
        'state.env records the id it derived from the seed directory',
    );
  }

  fs.mkdirSync(requested.pngDir, { recursive: true });
  fs.mkdirSync(requested.webpDir, { recursive: true });

  // The repository this harness itself lives in must never appear in a shot;
  // its name is exactly the kind of private repository #1272 was about.
  const forbidden = [path.basename(requested.repoRoot), requested.repoRoot];

  await waitForWorktree(
    state.baseUrl,
    { id: worktreeId, path: worktreePath },
    () => true,
    'present in the worktree list',
    requested.timeoutMs,
  );

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: requested.headless });
  const results: StillResult[] = [];
  try {
    for (const still of selectedStills(requested)) {
      const context = await browser.newContext({
        viewport: { ...still.viewport },
        deviceScaleFactor: still.deviceScaleFactor,
        locale: requested.locale,
        colorScheme: requested.colorScheme,
      });
      await context.addCookies([
        { name: 'locale', value: requested.locale, url: state.baseUrl },
      ]);
      const page = await context.newPage();
      const png = path.join(requested.pngDir, `${still.id}.png`);
      try {
        await still.open({ page, baseUrl: state.baseUrl, locale: requested.locale, worktreeId, state });
        await assertNothingPrivateOnScreen(page, still.id, forbidden);
        await page.screenshot({ path: png });
      } finally {
        await context.close();
      }

      const webp = path.join(requested.webpDir, `${still.id}.webp`);
      const fitted = writeWebpWithinBudget(
        png,
        webp,
        still.budgetBytes,
        defaultWebpDeps(still.viewport.width * still.deviceScaleFactor),
      );
      results.push({ id: still.id, png, webp, bytes: fitted.bytes, attempt: fitted.attempt });
      process.stdout.write(
        `stills: ${still.id} -> ${webp} (${fitted.bytes}B, q=${fitted.attempt.quality}, ` +
          `scale=${fitted.attempt.scale}, budget ${still.budgetBytes}B)\n`,
      );
    }
  } finally {
    await browser.close();
  }
  return results;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 'stills.ts'));

if (invokedDirectly) {
  captureStills(parseStillsArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`stills: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
