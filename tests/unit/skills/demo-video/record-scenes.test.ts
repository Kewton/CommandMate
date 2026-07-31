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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MESSAGE,
  DEFAULT_VIEWPORT,
  DEFAULT_WORKTREE_ID,
  MOBILE_VIEWPORT,
  SCENES,
  UNSYNCED_WORKTREE_ID,
  localeCookie,
  parseRecordArgs,
  parseStateFile,
  readRepositoryPaths,
  readUnstagedPaths,
  readWorktreeIds,
  secondSeedRepository,
  submitButtonLabel,
  viewportFor,
  waitForJson,
  waitForWorktree,
  type DemoState,
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

  it('accepts locale and theme', () => {
    const options = parseRecordArgs(['--locale', 'ja', '--theme', 'dark']);
    expect(options.locale).toBe('ja');
    expect(options.colorScheme).toBe('dark');
  });

  it('accepts an explicit viewport for the pc scenes', () => {
    expect(parseRecordArgs(['--viewport', '1440x900']).viewport).toEqual({
      width: 1440,
      height: 900,
    });
  });

  it('selects scenes by id, repeatably', () => {
    expect(
      parseRecordArgs(['--scene', 'sessions-overview', '--scene', 'complete']).sceneIds,
    ).toEqual(['sessions-overview', 'complete']);
  });

  it.each([
    [['--scene', 'nope'], /unknown scene/],
    // The Phase A ids were renamed to the storyboard's; the old ones must fail
    // loudly rather than record nothing.
    [['--scene', 'overview'], /unknown scene/],
    [['--scene', 'send-message'], /unknown scene/],
    [['--viewport', '1280'], /--viewport must look like/],
    [['--theme', 'sepia'], /--theme must be light or dark/],
    [['--locale', 'fr'], /--locale must be one of ja\|en/],
    [['--timeout', '0'], /--timeout must be a positive/],
    [['--timeout', 'soon'], /--timeout must be a positive/],
    [['--frobnicate'], /unknown argument/],
    [['--out'], /--out needs a value/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRecordArgs(argv)).toThrow(message);
  });
});

describe('SCENES', () => {
  it('exposes the scene library storyboards draw from', () => {
    // Since #1575 a storyboard is a subset of this list rather than a mirror of
    // it, so the order here is the order scenes were added, not a running order.
    expect(SCENES.map((scene) => scene.id)).toEqual([
      'sessions-overview',
      'send-and-generate',
      'respond-from-mobile',
      'add-repository',
      'sync-worktrees',
      'review-diff',
      'complete',
    ]);
  });

  it('registers a repository by path, never by clone URL', () => {
    // The isolated environment must not reach the network:
    // POST /api/repositories/clone walks out to a real git host, while the
    // path route resolves inside the throwaway seed. Filming the clone tab
    // would make the recording depend on GitHub being up.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../.claude/skills/demo-video/scripts/record-scenes.ts'),
      'utf8',
    );
    // Comment lines are stripped: the scene explains *why* it avoids the clone
    // route, and that prose must not read as use of it.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const CLONE_USE = /repositories\/clone|cloneUrl|trigger-url/;

    expect(code).toContain('add-repository-button');
    expect(code).toContain('repository-path-input');
    expect(code).not.toMatch(CLONE_USE);
    // A comment-stripping bug would make the assertion above pass on anything,
    // so prove the pattern still fires on code that does reach the clone route.
    expect('await fetch(`${baseUrl}/api/repositories/clone`)').toMatch(CLONE_USE);
  });

  it('gives every scene a title, a viewport and a runner', () => {
    for (const scene of SCENES) {
      expect(scene.title.length).toBeGreaterThan(0);
      expect(['pc', 'mobile']).toContain(scene.viewport);
      expect(typeof scene.run).toBe('function');
    }
  });

  it('does its waiting in prepare, before the camera rolls', () => {
    // Playwright starts recording when the context is created. A scene that
    // polls the API inside `run` films a blank page for as long as the poll
    // takes, and the shot it exists to capture is then cut by the trim.
    for (const scene of SCENES) {
      expect(typeof scene.prepare).toBe('function');
    }
  });

  it('films the approval scene, and only that one, at phone size', () => {
    expect(SCENES.filter((scene) => scene.viewport === 'mobile').map((s) => s.id)).toEqual([
      'respond-from-mobile',
    ]);
  });
});

describe('viewportFor', () => {
  const options = parseRecordArgs(['--viewport', '1440x900']);

  it('pins a mobile scene to the phone viewport even when --viewport says otherwise', () => {
    // Otherwise `--viewport 1440x900` would silently film the approval scene on
    // a desktop layout, where MobilePromptSheet does not exist at all.
    const mobile = SCENES.find((scene) => scene.viewport === 'mobile')!;
    expect(viewportFor(mobile, options)).toEqual(MOBILE_VIEWPORT);
    expect(MOBILE_VIEWPORT.width).toBeLessThan(768);
  });

  it('lets --viewport choose the size of the pc scenes', () => {
    const pc = SCENES.find((scene) => scene.viewport === 'pc')!;
    expect(viewportFor(pc, options)).toEqual({ width: 1440, height: 900 });
    expect(viewportFor(pc, parseRecordArgs([]))).toEqual(DEFAULT_VIEWPORT);
  });
});

describe('submitButtonLabel', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../..');

  it('reads the label from the dictionary the UI renders from', () => {
    // Hard-coding either spelling would make the approval scene time out under
    // the other locale, minutes into a take.
    expect(submitButtonLabel(REPO_ROOT, 'en')).toBe('Submit');
    expect(submitButtonLabel(REPO_ROOT, 'ja')).toBe('送信');
  });

  it('differs between the locales, which is why it is looked up at all', () => {
    expect(submitButtonLabel(REPO_ROOT, 'en')).not.toBe(submitButtonLabel(REPO_ROOT, 'ja'));
  });

  it('fails loudly when the key is gone rather than clicking nothing', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-locales-'));
    try {
      fs.mkdirSync(path.join(scratch, 'locales/en'), { recursive: true });
      fs.writeFileSync(path.join(scratch, 'locales/en/prompt.json'), '{"yes":"Yes"}');
      expect(() => submitButtonLabel(scratch, 'en')).toThrow(/no 'submit' string/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('localeCookie', () => {
  it('sets the cookie next-intl reads, scoped by url rather than domain', () => {
    // src/config/i18n-config.ts names it `locale`, not `NEXT_LOCALE`. And
    // env-up.sh serves on 127.0.0.1, so the e2e suite's `domain: 'localhost'`
    // would produce a cookie the browser never sends.
    expect(localeCookie('http://127.0.0.1:3399', 'ja')).toEqual({
      name: 'locale',
      value: 'ja',
      url: 'http://127.0.0.1:3399',
    });
  });

  it('carries the locale through verbatim', () => {
    expect(localeCookie('http://127.0.0.1:3399', 'en').value).toBe('en');
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

describe('the API projections the #1575 scenes synchronise on', () => {
  // Each of these endpoints answers with an envelope, not a bare array. A
  // reader that guessed wrong would return [] forever, and the scene would only
  // discover it at the timeout — minutes into a take.
  it('reads paths out of the /api/repositories envelope', () => {
    expect(
      readRepositoryPaths({ success: true, repositories: [{ path: '/seed/a' }, { path: '/seed/b' }] }),
    ).toEqual(['/seed/a', '/seed/b']);
    expect(readRepositoryPaths({})).toEqual([]);
  });

  it('reads ids out of the /api/worktrees envelope', () => {
    expect(readWorktreeIds({ worktrees: [{ id: 'wt-a' }, { id: 'wt-b' }], repositories: [] })).toEqual([
      'wt-a',
      'wt-b',
    ]);
    expect(readWorktreeIds({})).toEqual([]);
  });

  it('reads only the unstaged bucket of /git/staged', () => {
    // review-diff clicks a row inside `git-unstaged-list`. Keying off
    // /git/status's `isDirty` instead would also be true when nothing but
    // untracked files exist, and that list would be empty when the take rolls.
    expect(
      readUnstagedPaths({
        staged: [{ path: 'already-staged.ts' }],
        unstaged: [{ path: 'src/theme.ts' }],
        untracked: [{ path: 'brand-new.ts' }],
      }),
    ).toEqual(['src/theme.ts']);
    expect(readUnstagedPaths({})).toEqual([]);
  });
});

describe('waitForJson', () => {
  function deps(pages: unknown[]): WaitDeps {
    const clock = { value: 0 };
    let call = 0;
    return {
      fetchJson: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
      sleep: vi.fn(async (ms: number) => {
        clock.value += ms;
      }),
      now: () => clock.value,
    };
  }

  it('polls the given url until the projection satisfies the predicate', async () => {
    const d = deps([{ worktrees: [] }, { worktrees: [{ id: 'wt-new' }] }]);
    await expect(
      waitForJson(
        'http://x/api/worktrees',
        readWorktreeIds,
        (ids) => ids.includes('wt-new'),
        'the new worktree',
        10_000,
        d,
        100,
      ),
    ).resolves.toEqual(['wt-new']);
    expect(d.fetchJson).toHaveBeenCalledWith('http://x/api/worktrees');
  });

  it('supports an absence predicate, which is how the scenes assert a precondition', () => {
    // add-repository and sync-worktrees both film something *appearing*, so
    // their prepare step has to be able to require that it is not there yet.
    const d = deps([{ repositories: [{ path: '/seed/app' }] }]);
    return expect(
      waitForJson(
        'http://x/api/repositories',
        readRepositoryPaths,
        (paths) => !paths.includes('/seed/docs'),
        '/seed/docs to still be unregistered',
        0,
        d,
        100,
      ),
    ).resolves.toEqual(['/seed/app']);
  });

  it('names the endpoint state it last saw when the deadline passes', async () => {
    const d = deps([{ unstaged: [] }]);
    await expect(
      waitForJson(
        'http://x/git/staged',
        readUnstagedPaths,
        (paths) => paths.length > 0,
        'an unstaged change',
        1000,
        d,
        250,
      ),
    ).rejects.toThrow(/timed out after 1000ms waiting for an unstaged change; last seen: \[\]/);
  });
});

describe('secondSeedRepository', () => {
  const state = (extra: Record<string, string>): DemoState =>
    ({ baseUrl: 'http://x', videoDir: '/v', ...extra }) as DemoState;

  it('returns the unregistered repository env-up.sh recorded', () => {
    expect(secondSeedRepository(state({ CM_DEMO_SEED_REPO_2: '/seed/cmdemo-docs' }))).toBe(
      '/seed/cmdemo-docs',
    );
  });

  it('fails before the browser opens when env-up.sh recorded no second repository', () => {
    // Otherwise the scene types an empty path, the submit button stays
    // disabled, and the take dies at a Playwright timeout that says nothing
    // about the real cause.
    expect(() => secondSeedRepository(state({}))).toThrow(/CM_DEMO_SEED_REPO_2/);
  });
});

describe('the worktree the boot sync deliberately misses', () => {
  it('matches the branch env-up.sh creates after the server is ready', () => {
    // generateWorktreeId slugs `<repo>` + `<branch>`; if env-up.sh's branch
    // name and this constant drift apart, sync-worktrees waits for an id that
    // never arrives.
    expect(UNSYNCED_WORKTREE_ID).toBe('cmdemo-app-feature-demo-api-cache');
    const envUp = fs.readFileSync(
      path.resolve(__dirname, '../../../../.claude/skills/demo-video/scripts/env-up.sh'),
      'utf8',
    );
    expect(envUp).toContain('worktree add -q -b feature/demo-api-cache');
    expect(envUp).toContain('CM_DEMO_SEED_REPO_2=$SEED_REPO_2');
  });
});
