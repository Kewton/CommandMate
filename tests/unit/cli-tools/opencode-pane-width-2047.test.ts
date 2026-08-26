/**
 * Issue #2047: opencode's pane width is one setting, read on both launch paths.
 *
 * Before this Issue the number `80` was written twice inside
 * `lib/cli-tools/opencode.ts` — once in the `resize-window` that sizes a NEWLY
 * created pane, and once in the `reconcileExistingSession` that re-sizes a pane
 * CommandMate is reconnecting to. Only the height came from
 * `config/tmux-pane-config.ts`. Two independent literals for one geometry is the
 * shape where "new sessions are 200 columns, reconnected ones are 80" ships and
 * nobody notices: the reconnect path runs on a server restart, and the pane it
 * hands the detectors would silently be the old shape.
 *
 * So the acceptance condition #2047 states is not "the constant exists" but
 * "`CM_OPENCODE_PANE_WIDTH` changes the width on BOTH paths", and that is what
 * the two launch tests below drive through the real `OpenCodeTool`.
 *
 * The measured reason the default is still 80 — opencode 1.18.22 paints a
 * right-hand sidebar at >=121 columns, into the same rows as the transcript —
 * lives in `detection-opencode-pane-width-fixtures-2047.test.ts`, which asserts
 * it against live captures rather than describing it.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  OPENCODE_PANE_HEIGHT,
  OPENCODE_PANE_WIDTH,
  OPENCODE_PANE_WIDTH_ENV,
  OPENCODE_PANE_WIDTH_MAX,
  OPENCODE_PANE_WIDTH_MIN,
  OPENCODE_SIDEBAR_MIN_WIDTH,
  resolveOpencodePaneWidth,
} from '@/config/tmux-pane-config';

// ---------------------------------------------------------------------------
// Module boundary mocks. Only the seams the width has to cross are faked: the
// tmux helpers, opencode's config writer, and the promisified `execFile` the
// creation path resizes through.
// ---------------------------------------------------------------------------

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  exactTarget: (name: string) => `=${name}:`,
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted: `vi.mock` factories are lifted above every `const` in the file, so a
// plain module-level spy is still in its temporal dead zone when the `util`
// factory runs.
const { execFileAsyncSpy } = vi.hoisted(() => ({
  execFileAsyncSpy: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: () => execFileAsyncSpy,
  };
});

vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { capturePane, hasSession, reconcileSessionGeometry } from '@/lib/tmux/tmux';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

let sandbox: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-pane-width-2047-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

const ORIGINAL_ENV = process.env[OPENCODE_PANE_WIDTH_ENV];

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsyncSpy.mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(capturePane).mockResolvedValue(buildOpencodeComposerFrame());
  delete process.env[OPENCODE_PANE_WIDTH_ENV];
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[OPENCODE_PANE_WIDTH_ENV];
  else process.env[OPENCODE_PANE_WIDTH_ENV] = ORIGINAL_ENV;
});

/**
 * The `-x <cols>` a `resize-window` call was made with, or null when the pane
 * was never resized. This is the creation path's only statement about geometry.
 */
function resizeWidthFromExecFile(): number | null {
  for (const call of execFileAsyncSpy.mock.calls) {
    const [command, args] = call as [string, string[]];
    if (command !== 'tmux' || !Array.isArray(args)) continue;
    const at = args.indexOf('-x');
    if (args[0] === 'resize-window' && at >= 0) return Number(args[at + 1]);
  }
  return null;
}

/** Run the creation path (no existing pane) and report the width it asked for. */
async function widthOnCreate(): Promise<number | null> {
  vi.mocked(hasSession).mockResolvedValue(false);
  await new OpenCodeTool().startSession('wt-2047', sandbox);
  return resizeWidthFromExecFile();
}

/** Run the reconnect path (pane already exists) and report the width it asked for. */
async function widthOnReconnect(): Promise<number | undefined> {
  vi.mocked(hasSession).mockResolvedValue(true);
  await new OpenCodeTool().startSession('wt-2047', sandbox);
  const call = vi.mocked(reconcileSessionGeometry).mock.calls[0];
  return call?.[1]?.windowWidth;
}

describe('Issue #2047: resolveOpencodePaneWidth', () => {
  it('defaults to the measured 80 when the variable is unset', () => {
    expect(resolveOpencodePaneWidth({})).toBe(OPENCODE_PANE_WIDTH);
    expect(OPENCODE_PANE_WIDTH).toBe(80);
  });

  it('accepts an in-range integer', () => {
    // 120 is not an arbitrary example: it is the widest pane measured to hide
    // opencode's sidebar, so it is the one override this repo can vouch for.
    expect(resolveOpencodePaneWidth({ [OPENCODE_PANE_WIDTH_ENV]: '120' })).toBe(120);
    expect(resolveOpencodePaneWidth({ [OPENCODE_PANE_WIDTH_ENV]: ' 120 ' })).toBe(120);
  });

  it('keeps the bounds inclusive', () => {
    expect(
      resolveOpencodePaneWidth({ [OPENCODE_PANE_WIDTH_ENV]: String(OPENCODE_PANE_WIDTH_MIN) })
    ).toBe(OPENCODE_PANE_WIDTH_MIN);
    expect(
      resolveOpencodePaneWidth({ [OPENCODE_PANE_WIDTH_ENV]: String(OPENCODE_PANE_WIDTH_MAX) })
    ).toBe(OPENCODE_PANE_WIDTH_MAX);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['non-numeric', 'wide'],
    ['hex', '0x50'],
    ['exponent', '1e2'],
    ['float', '120.5'],
    ['negative', '-120'],
    ['below the floor', String(OPENCODE_PANE_WIDTH_MIN - 1)],
    ['above the ceiling', String(OPENCODE_PANE_WIDTH_MAX + 1)],
  ])('falls back to the default on a %s value', (_label, raw) => {
    // A malformed override must not produce a pane geometry no detector has ever
    // been measured against — silently taking `Number('0x50')` as 80 columns
    // would be luck, and `Number('1e2')` as 100 would not be.
    expect(resolveOpencodePaneWidth({ [OPENCODE_PANE_WIDTH_ENV]: raw })).toBe(
      OPENCODE_PANE_WIDTH
    );
  });

  it('records the sidebar boundary as one column above the safe ceiling', () => {
    // Measured on opencode 1.18.22, walked one column at a time in both
    // directions: 120 hides the sidebar, 121 shows it. The default has to sit
    // below it and the constant has to say where "below" ends.
    expect(OPENCODE_SIDEBAR_MIN_WIDTH).toBe(121);
    expect(OPENCODE_PANE_WIDTH).toBeLessThan(OPENCODE_SIDEBAR_MIN_WIDTH);
  });
});

describe('Issue #2047: both launch paths size the pane from the same setting', () => {
  it('resizes a newly created pane to the default width', async () => {
    expect(await widthOnCreate()).toBe(OPENCODE_PANE_WIDTH);
  });

  it('re-sizes a reconnected pane to the default width', async () => {
    expect(await widthOnReconnect()).toBe(OPENCODE_PANE_WIDTH);
  });

  it('honours CM_OPENCODE_PANE_WIDTH when creating a pane', async () => {
    process.env[OPENCODE_PANE_WIDTH_ENV] = '120';
    expect(await widthOnCreate()).toBe(120);
  });

  it('honours CM_OPENCODE_PANE_WIDTH when reconnecting to a pane', async () => {
    // The half #2047 exists to stop from drifting. With the literal still in
    // place this returned 80 while the creation path returned 120, and the
    // difference only ever showed up after a CommandMate restart.
    process.env[OPENCODE_PANE_WIDTH_ENV] = '120';
    expect(await widthOnReconnect()).toBe(120);
  });

  it('drops a malformed override on both paths rather than resizing to junk', async () => {
    process.env[OPENCODE_PANE_WIDTH_ENV] = 'wide';
    expect(await widthOnCreate()).toBe(OPENCODE_PANE_WIDTH);
    vi.clearAllMocks();
    expect(await widthOnReconnect()).toBe(OPENCODE_PANE_WIDTH);
  });

  it('keeps the height on the constant it already came from', async () => {
    // #1906 moved the height here; #2047 must not have quietly re-hardcoded it
    // while moving the width.
    await widthOnCreate();
    const call = execFileAsyncSpy.mock.calls.find(
      ([command, args]) => command === 'tmux' && (args as string[])[0] === 'resize-window'
    );
    const args = call?.[1] as string[];
    expect(args[args.indexOf('-y') + 1]).toBe(String(OPENCODE_PANE_HEIGHT));
  });
});
