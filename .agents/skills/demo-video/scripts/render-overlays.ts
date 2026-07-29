/**
 * render-overlays.ts — turn storyboard telops into PNGs (#1554).
 *
 * Telops are drawn as HTML and screenshotted rather than burned in with
 * ffmpeg's drawtext: drawtext needs an explicit `fontfile` for Japanese and
 * escapes `:` and `'` in ways that make a storyboard string unsafe to pass
 * through, and the styling would then live in a shell string instead of one
 * CSS file. Playwright is already a dependency of this skill.
 *
 *   npx tsx .claude/skills/demo-video/scripts/render-overlays.ts --locale ja --out DIR
 */

import fs from 'fs';
import path from 'path';

import type { Browser } from '@playwright/test';

import { DEFAULT_VIEWPORT, MOBILE_VIEWPORT } from './record-scenes';
import {
  DEFAULT_STORYBOARD_PATH,
  LOCALES,
  buildPlan,
  parseStoryboard,
  type Locale,
  type PlanEntry,
  type Storyboard,
} from './storyboard';

export interface OverlayJob {
  /** `telop` overlays composite onto footage; `card` overlays *are* the frame. */
  kind: 'telop' | 'card';
  sceneId: string;
  text: string;
  file: string;
  width: number;
  height: number;
}

export interface RenderOptions {
  storyboardPath: string;
  outDir: string;
  locale: Locale;
  /** Frame size of the finished video. Card stills and telop overlays match it. */
  frame: { width: number; height: number };
}

/**
 * One PNG per scene: a card scene needs its full-frame still, a record scene
 * needs a transparent band to composite over its footage.
 *
 * Telops for mobile scenes are still rendered at the *output* frame size. The
 * mobile footage is letterboxed into that frame by compose.sh, so a band sized
 * to the phone viewport would land in the wrong place.
 */
export function overlayJobs(plan: PlanEntry[], options: RenderOptions): OverlayJob[] {
  return plan.map((entry) => ({
    kind: entry.type === 'card' ? 'card' : 'telop',
    sceneId: entry.id,
    text: entry.telop,
    file: path.join(
      options.outDir,
      `${entry.type === 'card' ? 'card' : 'telop'}-${entry.id}.${options.locale}.png`,
    ),
    width: options.frame.width,
    height: options.frame.height,
  }));
}

export function templatePath(kind: OverlayJob['kind']): string {
  return path.resolve(__dirname, '..', 'templates', `${kind}.html`);
}

async function renderJob(browser: Browser, job: OverlayJob): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
    // Both templates are pinned to light rendering; the palette is in the CSS.
    colorScheme: 'light',
  });
  const page = await context.newPage();
  try {
    await page.goto(`file://${templatePath(job.kind)}`, { waitUntil: 'load' });
    const selector = job.kind === 'card' ? '#card-text' : '#telop-text';
    // textContent, never innerHTML: storyboard wording is data, and a telop
    // containing `<` must render as `<`, not open an element.
    await page.$eval(selector, (element, text) => {
      element.textContent = text;
    }, job.text);
    const element = await page.$(job.kind === 'card' ? 'body' : '#telop-band');
    if (!element) throw new Error(`${job.kind}.html has no ${selector} container`);
    await page.screenshot({
      path: job.file,
      // A telop must be transparent everywhere but the band, or it would paint
      // the whole frame over the footage it is supposed to annotate.
      omitBackground: job.kind === 'telop',
      clip: { x: 0, y: 0, width: job.width, height: job.height },
    });
  } finally {
    await context.close();
  }
}

export async function renderOverlays(options: RenderOptions): Promise<OverlayJob[]> {
  const { storyboard, errors } = parseStoryboard(fs.readFileSync(options.storyboardPath, 'utf8'));
  if (!storyboard) {
    throw new Error(`storyboard is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  return renderStoryboardOverlays(storyboard, options);
}

export async function renderStoryboardOverlays(
  storyboard: Storyboard,
  options: RenderOptions,
): Promise<OverlayJob[]> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const jobs = overlayJobs(buildPlan(storyboard, options.locale), options);
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const job of jobs) {
      await renderJob(browser, job);
      process.stdout.write(`rendered ${job.kind} ${job.sceneId} -> ${job.file}\n`);
    }
  } finally {
    await browser.close();
  }
  return jobs;
}

function parseFrame(raw: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (!match) throw new Error(`--frame must look like 1280x800, got '${raw}'`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function parseRenderArgs(argv: string[]): RenderOptions {
  const options: RenderOptions = {
    storyboardPath: DEFAULT_STORYBOARD_PATH,
    outDir: '',
    locale: 'ja',
    frame: { ...DEFAULT_VIEWPORT },
  };
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--storyboard': options.storyboardPath = next(i, arg); i += 1; break;
      case '--out': options.outDir = next(i, arg); i += 1; break;
      case '--frame': options.frame = parseFrame(next(i, arg)); i += 1; break;
      case '--locale': {
        const value = next(i, arg);
        if (!LOCALES.includes(value as Locale)) {
          throw new Error(`--locale must be one of ${LOCALES.join('|')}, got '${value}'`);
        }
        options.locale = value as Locale;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.outDir === '') throw new Error('--out is required');
  return options;
}

/** Re-exported so compose.sh's letterbox target and the recorder cannot drift. */
export const SOURCE_VIEWPORTS = { pc: DEFAULT_VIEWPORT, mobile: MOBILE_VIEWPORT };

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 'render-overlays.ts'));

if (invokedDirectly) {
  renderOverlays(parseRenderArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(
      `render-overlays: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
