/**
 * terminal-scene.ts — film a tmux pane instead of a browser (Issue #1810).
 *
 * Task Contract, verification gates, Evidence and metrics have no Web UI to
 * point a camera at (`src/components` calls neither `/api/worktrees/:id/tasks`
 * nor `/api/verification/*`), so the one place the product shows them is its own
 * terminal output. This module photographs that output with the tools the skill
 * already depends on: `tmux capture-pane -p -e` for the bytes, Playwright for
 * the type-setting, ffmpeg for the encode. No asciinema, no agg.
 *
 * The ANSI reader below is deliberately a *subset*. It understands the SGR
 * parameters a CLI actually emits — reset, bold, dim, the 8+8 colours and the
 * indexed/true-colour forms — and silently drops everything else, including
 * cursor movement and OSC strings. Dropping is the safe direction: an
 * unrecognised sequence becomes nothing rather than becoming text the product
 * never printed.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ------------------------------------------------------------- ansi ---------

/** The 16 ANSI colours, in the palette the terminal template is drawn for. */
export const ANSI_PALETTE: readonly string[] = [
  '#1c2430', '#f2777a', '#7ec699', '#e6c07b',
  '#6cb6ff', '#c39ac9', '#56d4dd', '#c9d1d9',
  '#5c6b7a', '#ff9a9c', '#9ae6b4', '#f5d68a',
  '#8ecbff', '#d7b4dc', '#7fe3ea', '#f5f7fa',
];

export interface AnsiStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

export const EMPTY_STYLE: AnsiStyle = { fg: null, bg: null, bold: false, dim: false };

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.trunc(value)));
}

function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * xterm's 256-colour cube, as a hex string. Indices 0-15 reuse
 * {@link ANSI_PALETTE} so `38;5;1` and `31` render as the same red.
 */
export function xterm256(index: number): string {
  const n = clampChannel(index);
  if (n < 16) return ANSI_PALETTE[n];
  if (n < 232) {
    const c = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return rgb(steps[Math.floor(c / 36) % 6], steps[Math.floor(c / 6) % 6], steps[c % 6]);
  }
  const grey = 8 + (n - 232) * 10;
  return rgb(grey, grey, grey);
}

/**
 * Apply one SGR sequence's parameters to a style.
 *
 * Returns a new style; the caller keeps the old one, which is what makes an
 * unrecognised parameter a no-op rather than a state corruption.
 */
export function applySgr(style: AnsiStyle, params: readonly number[]): AnsiStyle {
  // An empty parameter list is `ESC[m`, which is `ESC[0m`.
  const codes = params.length === 0 ? [0] : params;
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) next = { ...EMPTY_STYLE };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code >= 30 && code <= 37) next.fg = ANSI_PALETTE[code - 30];
    else if (code >= 90 && code <= 97) next.fg = ANSI_PALETTE[code - 90 + 8];
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = ANSI_PALETTE[code - 40];
    else if (code >= 100 && code <= 107) next.bg = ANSI_PALETTE[code - 100 + 8];
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5 && codes.length > i + 2) {
        next[target] = xterm256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2 && codes.length > i + 4) {
        next[target] = rgb(codes[i + 2], codes[i + 3], codes[i + 4]);
        i += 4;
      } else {
        // Truncated or an unknown colour space. Everything after an extended
        // colour is positional, so once one parameter is unreadable the rest of
        // the sequence is too: stop, keeping the style built so far. Defaulting
        // a missing index to 0 would paint the text in colour 0 — near-black on
        // a dark ground, i.e. invisible output that the pane did print.
        break;
      }
    }
    // Everything else — italic, underline, blink, unknown codes — is ignored.
  }
  return next;
}

export function styleToCss(style: AnsiStyle): string {
  const declarations: string[] = [];
  if (style.fg) declarations.push(`color:${style.fg}`);
  if (style.bg) declarations.push(`background:${style.bg}`);
  if (style.bold) declarations.push('font-weight:700');
  if (style.dim) declarations.push('opacity:.65');
  return declarations.join(';');
}

/**
 * HTML-escape. `&` first, then the delimiters, so an escaped entity is not
 * escaped twice.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The lexer.
 *
 * Alternatives are ordered so SGR is matched before the generic CSI branch that
 * would otherwise swallow it. Everything after the first alternative is
 * *dropped*, which is why a cursor move or an OSC title string cannot leak into
 * the frame as visible text.
 */
const ANSI_TOKEN = new RegExp(
  [
    '\\u001b\\[([0-9;:]*)m', // SGR — the only form this reader interprets
    '\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)', // OSC, either terminator
    '\\u001b\\][\\s\\S]*$', // an OSC the capture cut in half
    '\\u001b\\[[0-9;?]*[A-Za-z]', // any other CSI
    '\\u001b[@-Z\\\\-_]', // single-character escapes
    '\\u001b', // a lone ESC at the end of a truncated capture
    '[\\u0000-\\u0008\\u000b-\\u001f\\u007f]', // stray C0 controls and DEL
  ].join('|'),
  'g',
);

function lineToHtml(line: string): string {
  let style: AnsiStyle = { ...EMPTY_STYLE };
  let out = '';
  let cursor = 0;
  let printable = false;

  const emit = (chunk: string): void => {
    if (chunk === '') return;
    printable = true;
    const css = styleToCss(style);
    out += css ? `<span style="${css}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
  };

  ANSI_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_TOKEN.exec(line)) !== null) {
    emit(line.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[1] === undefined) continue; // a dropped sequence or control byte
    const params = match[1]
      // `38:2::r:g:b` is the colon-separated form; treat both separators alike.
      .split(/[;:]/)
      .filter((part) => part !== '')
      .map((part) => Number.parseInt(part, 10))
      .filter((value) => Number.isFinite(value));
    style = applySgr(style, params);
  }
  emit(line.slice(cursor));
  return printable ? out : '&nbsp;';
}

/**
 * One captured pane frame as HTML.
 *
 * Every character is escaped before it reaches the output, so the result is
 * safe to assign with `innerHTML` — which is what the renderer does, and the
 * only reason it may. A pane containing `<script>` renders as the eight visible
 * characters, exactly as the terminal showed them.
 *
 * Lines become `<div class="t-line">`. A blank line still gets a box holding a
 * non-breaking space; without it the row collapses and every following line
 * moves up, which reads as output the CLI never produced.
 */
export function ansiToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => `<div class="t-line">${lineToHtml(line)}</div>`)
    .join('');
}

// ------------------------------------------------------------ frames --------

export interface CapturedFrame {
  /** Milliseconds since the capture started. */
  atMs: number;
  /** Raw `capture-pane -p -e` output, ANSI included. */
  text: string;
}

/**
 * Drop frames identical to the one before them.
 *
 * The pane is sampled on a fixed interval but only changes when the CLI writes,
 * so most samples repeat. Keeping them would multiply the PNG count — and the
 * render time — by the idle ratio without adding a single visible frame; the
 * elapsed time survives because each kept frame is held until the next one.
 */
export function dedupeFrames(frames: readonly CapturedFrame[]): CapturedFrame[] {
  const kept: CapturedFrame[] = [];
  for (const frame of frames) {
    if (kept.length > 0 && kept[kept.length - 1].text === frame.text) continue;
    kept.push(frame);
  }
  return kept;
}

/**
 * How long each kept frame stays on screen: until the next one, and the last
 * one until the capture ended.
 *
 * `minMs` keeps a burst of writes from producing frames too short to see — and,
 * at 30fps, too short to survive the encode at all.
 */
export function frameDurations(
  frames: readonly CapturedFrame[],
  endMs: number,
  minMs = 100,
): number[] {
  return frames.map((frame, index) => {
    const until = index + 1 < frames.length ? frames[index + 1].atMs : endMs;
    return Math.max(minMs, until - frame.atMs);
  });
}

/**
 * The ffmpeg concat-demuxer script for a frame sequence.
 *
 * The last entry is repeated without a `duration`: the demuxer applies a
 * duration to the *transition* to the next file, so the final image would
 * otherwise be shown for a single frame no matter what was asked for.
 */
export function buildConcatScript(
  files: readonly string[],
  durationsMs: readonly number[],
): string {
  if (files.length === 0) throw new Error('no frames to concatenate');
  if (files.length !== durationsMs.length) {
    throw new Error(`${files.length} frames but ${durationsMs.length} durations`);
  }
  const lines: string[] = [];
  files.forEach((file, index) => {
    lines.push(`file '${file}'`);
    lines.push(`duration ${(durationsMs[index] / 1000).toFixed(3)}`);
  });
  lines.push(`file '${files[files.length - 1]}'`);
  return `${lines.join('\n')}\n`;
}

export interface CaptureDeps {
  /** Read the pane. Returns null when the session is gone. */
  capture: () => string | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface CaptureOptions {
  intervalMs: number;
  /** Hard upper bound; a take that hits it fails rather than running forever. */
  timeoutMs: number;
}

export interface CaptureResult {
  frames: CapturedFrame[];
  endMs: number;
  /** True when the session ended on its own, false when the timeout won. */
  sessionEnded: boolean;
}

/**
 * Sample the pane until the session exits.
 *
 * The session exiting is the signal, not a marker in the output: cli-scene.sh
 * holds its last frame with a `sleep` and then exits, so "gone" means "the
 * script finished", and a script that died half way through produces a short
 * take rather than a full-length one full of nothing.
 */
export async function captureFrames(
  deps: CaptureDeps,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const startedAt = deps.now();
  const frames: CapturedFrame[] = [];
  for (;;) {
    const text = deps.capture();
    const atMs = deps.now() - startedAt;
    if (text === null) {
      return { frames: dedupeFrames(frames), endMs: atMs, sessionEnded: true };
    }
    frames.push({ atMs, text });
    if (atMs >= options.timeoutMs) {
      return { frames: dedupeFrames(frames), endMs: atMs, sessionEnded: false };
    }
    await deps.sleep(options.intervalMs);
  }
}

/** Escape sequences, so a marker split by a colour change still matches. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * The last frame has to carry the take's verdict (Issue #1811).
 *
 * `captureFrames` stops when the session ends, and a script that died half way
 * through ends its session too. The take is then short, encodes fine, and
 * composes into a cut whose telop promises something the footage never reaches
 * — measured on the #1811 re-shoot, where cli-scene.sh's post-`respond` probe
 * gave up and the ja cut shipped ending at `Response sent.`, no GATE block on
 * it. "The session ended" is therefore necessary but not sufficient; what the
 * pane finally said is the sufficient part.
 */
export function assertFinalFrame(frames: readonly CapturedFrame[], marker: string): void {
  const last = frames[frames.length - 1];
  const text = (last?.text ?? '').replace(ANSI, '');
  if (text.includes(marker)) return;
  const tail = text.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' / ');
  throw new Error(
    `the take ended without '${marker}' on screen — the pane finished at: ${tail || '(blank)'}`,
  );
}

// ------------------------------------------------------------- tmux ---------

export function tmuxArgs(socket: string, rest: readonly string[]): string[] {
  return socket ? ['-L', socket, ...rest] : [...rest];
}

/**
 * `capture-pane -p -e` for a session, or null when it no longer exists.
 *
 * `=name` is an exact-match target: without it tmux resolves a prefix, and this
 * could photograph — and, through {@link killSession}, kill — somebody else's
 * session that merely starts with the same characters.
 */
export function capturePane(session: string, socket: string): string | null {
  try {
    return execFileSync(
      'tmux',
      tmuxArgs(socket, ['capture-pane', '-p', '-e', '-t', `=${session}:`]),
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
}

/**
 * Exact-match kill, never `kill-server`: this tmux server holds the developer's
 * own sessions.
 */
export function killSession(session: string, socket: string): void {
  try {
    execFileSync('tmux', tmuxArgs(socket, ['kill-session', '-t', `=${session}:`]), {
      stdio: 'ignore',
    });
  } catch {
    // Already gone, which is the normal path.
  }
}

// ------------------------------------------------------------ render --------

export const TERMINAL_TEMPLATE = path.resolve(__dirname, '..', 'templates', 'terminal.html');
export const CLI_SCENE_SCRIPT = path.resolve(__dirname, 'cli-scene.sh');

export interface TerminalRenderOptions {
  frame: { width: number; height: number };
  outDir: string;
}

/** Type-set every captured frame into a PNG, reusing one browser page. */
export async function renderFrames(
  frames: readonly CapturedFrame[],
  options: TerminalRenderOptions,
): Promise<string[]> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const written: string[] = [];
  try {
    const context = await browser.newContext({
      viewport: { ...options.frame },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    await page.goto(`file://${TERMINAL_TEMPLATE}`, { waitUntil: 'load' });
    for (let index = 0; index < frames.length; index += 1) {
      // innerHTML is safe *because* ansiToHtml escaped every character of the
      // pane first; the only markup in the string is the markup it generated.
      await page.$eval(
        '#terminal-body',
        (element, html) => {
          element.innerHTML = html;
        },
        ansiToHtml(frames[index].text),
      );
      const file = path.join(options.outDir, `frame-${String(index).padStart(5, '0')}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, ...options.frame } });
      written.push(file);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return written;
}

/** Encode the PNG sequence into the webm compose.sh expects for a record scene. */
export function encodeWebm(
  concatScript: string,
  outFile: string,
  workDir: string,
  fps = 30,
): void {
  const listFile = path.join(workDir, 'frames.txt');
  fs.writeFileSync(listFile, concatScript, 'utf8');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-fps_mode', 'cfr', '-r', String(fps),
      '-c:v', 'libvpx', '-b:v', '1500k', '-pix_fmt', 'yuv420p',
      outFile,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

// ------------------------------------------------------------- scene --------

/**
 * Which take cli-scene.sh runs in the pane (Issue #1813).
 *
 * The three share one script because the isolation checks in front of them —
 * the port refusal, the redirected HOME, the "seed worktrees only" assertion —
 * are the load-bearing part, and a copy of them is a copy that drifts.
 */
export type CliSceneMode = 'contract' | 'verify-red' | 'evidence';

export interface TerminalSceneOptions {
  /** Path to the state file env-up.sh wrote; handed straight to cli-scene.sh. */
  statePath: string;
  session: string;
  /** Take to run; omitted is the original `contract` take. */
  mode?: CliSceneMode;
  /** `tmux -L` socket, or '' for the ambient server. */
  tmuxSocket: string;
  frame: { width: number; height: number };
  outFile: string;
  workDir: string;
  intervalMs: number;
  timeoutMs: number;
  /** Text the last captured frame must carry; see {@link assertFinalFrame}. */
  requireInFinalFrame?: string;
}

export function startCliSession(options: TerminalSceneOptions): void {
  const args = ['--state', options.statePath, '--session', options.session, '--start'];
  if (options.mode) args.push('--mode', options.mode);
  if (options.tmuxSocket) args.push('--tmux-socket', options.tmuxSocket);
  execFileSync(CLI_SCENE_SCRIPT, args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * Record one cli-scene.sh take end to end.
 *
 * Nothing is waited for in a `prepare`: unlike a browser scene there is no
 * camera to start early — the capture loop *is* the camera, and it begins the
 * moment the session does.
 */
export async function recordTerminalScene(options: TerminalSceneOptions): Promise<string> {
  fs.mkdirSync(options.workDir, { recursive: true });
  startCliSession(options);

  const result = await captureFrames(
    {
      capture: () => capturePane(options.session, options.tmuxSocket),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    { intervalMs: options.intervalMs, timeoutMs: options.timeoutMs },
  );

  if (!result.sessionEnded) {
    killSession(options.session, options.tmuxSocket);
    throw new Error(
      `cli-scene.sh did not finish within ${options.timeoutMs}ms; the take would show a ` +
        'run that never reached its verdict',
    );
  }
  if (result.frames.length === 0) {
    throw new Error('captured no frames: the tmux session ended before it painted anything');
  }
  if (options.requireInFinalFrame) {
    assertFinalFrame(result.frames, options.requireInFinalFrame);
  }

  const files = await renderFrames(result.frames, {
    frame: options.frame,
    outDir: path.join(options.workDir, 'frames'),
  });
  encodeWebm(
    buildConcatScript(files, frameDurations(result.frames, result.endMs)),
    options.outFile,
    options.workDir,
  );
  return options.outFile;
}
