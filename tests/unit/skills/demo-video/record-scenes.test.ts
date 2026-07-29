/**
 * record-scenes.ts argument parsing and synchronisation (Issue #1553).
 *
 * Importing the script from here is also what puts it under `npx tsc --noEmit`:
 * `.claude/**` is outside the root tsconfig `include` (Issue #1265) and outside
 * `eslint src`, so a file there is only type-checked when something in tests/
 * pulls it in.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MESSAGE,
  DEFAULT_VIEWPORT,
  DEFAULT_WORKTREE_ID,
  SCENES,
  parseRecordArgs,
  parseStateFile,
  waitForWorktree,
  type WaitDeps,
} from '../../../../.claude/skills/demo-video/scripts/record-scenes';

const STATE = [
  'CM_DEMO_PORT=3399',
  'CM_DEMO_BASE_URL=http://127.0.0.1:3399',
  'CM_DEMO_VIDEO_DIR=/home/dev/.commandmate-demo/videos',
  '',
].join('\n');

describe('parseStateFile', () => {
  it('reads the base URL and video dir env-up.sh wrote', () => {
    const state = parseStateFile(STATE);
    expect(state.baseUrl).toBe('http://127.0.0.1:3399');
    expect(state.videoDir).toBe('/home/dev/.commandmate-demo/videos');
  });

  it('refuses to record against port 3000', () => {
    expect(() =>
      parseStateFile('CM_DEMO_BASE_URL=http://127.0.0.1:3000\n'),
    ).toThrow(/port 3000/);
  });

  it('rejects a state file with no base URL', () => {
    expect(() => parseStateFile('CM_DEMO_PORT=3399\n')).toThrow(/CM_DEMO_BASE_URL/);
  });
});

describe('parseRecordArgs', () => {
  it('defaults to a 1280x800 PC viewport and the seeded worktree', () => {
    const options = parseRecordArgs([]);
    expect(options.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(options.viewport).toEqual({ width: 1280, height: 800 });
    expect(options.worktreeId).toBe(DEFAULT_WORKTREE_ID);
    expect(options.message).toBe(DEFAULT_MESSAGE);
    expect(options.locale).toBe('en');
    expect(options.colorScheme).toBe('light');
    expect(options.sceneIds).toEqual([]);
    expect(options.headless).toBe(true);
  });

  it('plumbs locale and theme through as arguments (switching lands in #1554)', () => {
    const options = parseRecordArgs(['--locale', 'ja', '--theme', 'dark']);
    expect(options.locale).toBe('ja');
    expect(options.colorScheme).toBe('dark');
  });

  it('accepts a mobile viewport for Phase B', () => {
    expect(parseRecordArgs(['--viewport', '390x844']).viewport).toEqual({
      width: 390,
      height: 844,
    });
  });

  it('selects scenes by id, repeatably', () => {
    expect(parseRecordArgs(['--scene', 'overview', '--scene', 'send-message']).sceneIds).toEqual([
      'overview',
      'send-message',
    ]);
  });

  it.each([
    [['--scene', 'nope'], /unknown scene/],
    [['--viewport', '1280'], /--viewport must look like/],
    [['--theme', 'sepia'], /--theme must be light or dark/],
    [['--timeout', '0'], /--timeout must be a positive/],
    [['--timeout', 'soon'], /--timeout must be a positive/],
    [['--frobnicate'], /unknown argument/],
    [['--out'], /--out needs a value/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRecordArgs(argv)).toThrow(message);
  });
});

describe('SCENES', () => {
  it('exposes the two Phase A scenes', () => {
    expect(SCENES.map((scene) => scene.id)).toEqual(['overview', 'send-message']);
  });

  it('gives every scene a title and a runner', () => {
    for (const scene of SCENES) {
      expect(scene.title.length).toBeGreaterThan(0);
      expect(typeof scene.run).toBe('function');
    }
  });
});

describe('waitForWorktree', () => {
  function deps(
    pages: Array<{ worktrees?: Array<{ id: string; isProcessing?: boolean }> }>,
  ): { deps: WaitDeps; clock: { value: number } } {
    const clock = { value: 0 };
    let call = 0;
    return {
      clock,
      deps: {
        fetchJson: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
        // The clock is driven by the sleeps, so the deadline is deterministic
        // and the test never waits on a real timer.
        sleep: vi.fn(async (ms: number) => {
          clock.value += ms;
        }),
        now: () => clock.value,
      },
    };
  }

  it('resolves as soon as the predicate holds', async () => {
    const { deps: d } = deps([
      { worktrees: [{ id: 'wt', isProcessing: false }] },
      { worktrees: [{ id: 'wt', isProcessing: true }] },
    ]);
    const seen = await waitForWorktree(
      'http://127.0.0.1:3399',
      'wt',
      (w) => w.isProcessing === true,
      'generating',
      10_000,
      d,
      100,
    );
    expect(seen.isProcessing).toBe(true);
    expect(d.fetchJson).toHaveBeenCalledTimes(2);
    expect(d.fetchJson).toHaveBeenCalledWith('http://127.0.0.1:3399/api/worktrees');
  });

  it('ignores a different worktree that satisfies the predicate', async () => {
    const { deps: d } = deps([
      { worktrees: [{ id: 'other', isProcessing: true }] },
    ]);
    await expect(
      waitForWorktree('http://x', 'wt', (w) => w.isProcessing === true, 'generating', 1000, d, 250),
    ).rejects.toThrow(/worktree not in \/api\/worktrees/);
  });

  it('throws with the last observed state when the deadline passes', async () => {
    const { deps: d } = deps([{ worktrees: [{ id: 'wt', isProcessing: false }] }]);
    await expect(
      waitForWorktree('http://x', 'wt', (w) => w.isProcessing === true, 'generating', 1000, d, 250),
    ).rejects.toThrow(/timed out after 1000ms waiting for wt to be generating.*"isProcessing":false/s);
  });

  it('polls at least once even with a zero timeout, so a satisfied state is not missed', async () => {
    const { deps: d } = deps([{ worktrees: [{ id: 'wt', isProcessing: true }] }]);
    await expect(
      waitForWorktree('http://x', 'wt', (w) => w.isProcessing === true, 'generating', 0, d, 250),
    ).resolves.toMatchObject({ id: 'wt' });
  });
});
