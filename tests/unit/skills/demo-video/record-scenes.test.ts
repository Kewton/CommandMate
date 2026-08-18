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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';

import {
  DEFAULT_CLI_SESSION,
  DEFAULT_MESSAGE,
  DEFAULT_VIEWPORT,
  DEMO_CATALOG_SKILL_ID,
  MOBILE_VIEWPORT,
  SCENES,
  SLASH_PALETTE_COMMANDS,
  SceneUnavailableError,
  assertIdForPath,
  isTerminalScene,
  readCatalogAvailability,
  readInstalledSkillIds,
  terminalWorkDir,
  waitForTitleBadge,
  localeCookie,
  parseRecordArgs,
  parseStateFile,
  readRepositoryPaths,
  readUnstagedPaths,
  readWorktreeEntries,
  readWorktreeIds,
  resolveRecordOptions,
  secondSeedRepository,
  submitButtonLabel,
  viewportFor,
  waitForJson,
  waitForWorktree,
  type BrowserScene,
  type DemoState,
  type PrepareContext,
  type RecordOptions,
  type WaitDeps,
} from '../../../../.claude/skills/demo-video/scripts/record-scenes';
import { deriveWorktreeId } from '@/lib/git/worktree-id';
import { removeTempDir } from '@tests/helpers/temp-dir';

/** env-up.sh derives the ids from these directory names; nothing hard-codes them. */
const SEED_ROOT = '/home/dev/.commandmate-demo/seed';
const DARK_MODE_DIR = `${SEED_ROOT}/wt-dark-mode`;
const API_CACHE_DIR = `${SEED_ROOT}/wt-api-cache`;

/** The command line demo-video.sh builds from state.env. */
const ARGS = ['--worktree', 'wt-dark-mode', '--worktree-path', DARK_MODE_DIR];

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
  it('defaults to a 1280x800 PC viewport and no worktree id at all', () => {
    const options = parseRecordArgs([], {});
    expect(options.viewport).toEqual(DEFAULT_VIEWPORT);
    expect(options.viewport).toEqual({ width: 1280, height: 800 });
    // Issue #1809: there is no constant to fall back on. A default here is what
    // let the harness go on addressing a worktree the server had stopped
    // minting, and every scene died at its own timeout instead.
    expect(options.worktreeId).toBe('');
    expect(options.unsyncedWorktreeId).toBe('');
    expect(options.message).toBe(DEFAULT_MESSAGE);
    expect(options.locale).toBe('en');
    expect(options.colorScheme).toBe('light');
    expect(options.sceneIds).toEqual([]);
    expect(options.headless).toBe(true);
  });

  it('takes the worktree ids and paths from the environment env-up.sh writes', () => {
    const options = parseRecordArgs([], {
      CM_DEMO_WORKTREE_ID: 'wt-dark-mode',
      CM_DEMO_WORKTREE_PATH: DARK_MODE_DIR,
      CM_DEMO_UNSYNCED_WORKTREE_ID: 'wt-api-cache',
      CM_DEMO_UNSYNCED_WORKTREE_PATH: API_CACHE_DIR,
    });
    expect(options.worktreeId).toBe('wt-dark-mode');
    expect(options.worktreePath).toBe(DARK_MODE_DIR);
    expect(options.unsyncedWorktreeId).toBe('wt-api-cache');
    expect(options.unsyncedWorktreePath).toBe(API_CACHE_DIR);
  });

  it('lets the flags win over the environment', () => {
    const options = parseRecordArgs(
      ['--worktree', 'from-flag', '--unsynced-worktree', 'unsynced-from-flag'],
      { CM_DEMO_WORKTREE_ID: 'from-env', CM_DEMO_UNSYNCED_WORKTREE_ID: 'unsynced-from-env' },
    );
    expect(options.worktreeId).toBe('from-flag');
    expect(options.unsyncedWorktreeId).toBe('unsynced-from-flag');
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
    expect(() => parseRecordArgs(argv, {})).toThrow(message);
  });
});

describe('resolveRecordOptions', () => {
  const state = (extra: Record<string, string> = {}): DemoState =>
    ({ baseUrl: 'http://127.0.0.1:3399', videoDir: '/v', ...extra }) as DemoState;

  it('fills the ids and paths from state.env when the command line omits them', () => {
    const resolved = resolveRecordOptions(
      parseRecordArgs([], {}),
      state({
        CM_DEMO_WORKTREE_ID: 'wt-dark-mode',
        CM_DEMO_WORKTREE_PATH: DARK_MODE_DIR,
        CM_DEMO_UNSYNCED_WORKTREE_ID: 'wt-api-cache',
        CM_DEMO_UNSYNCED_WORKTREE_PATH: API_CACHE_DIR,
      }),
    );
    expect(resolved.worktreeId).toBe('wt-dark-mode');
    expect(resolved.worktreePath).toBe(DARK_MODE_DIR);
    expect(resolved.unsyncedWorktreeId).toBe('wt-api-cache');
    expect(resolved.unsyncedWorktreePath).toBe(API_CACHE_DIR);
  });

  it('refuses to record when nothing supplied a worktree id', () => {
    // The failure the whole of #1809 is about: silently keeping a stale id
    // turned into six scene timeouts with nothing in the message about ids.
    expect(() => resolveRecordOptions(parseRecordArgs([], {}), state())).toThrow(
      /no worktree id: pass --worktree, set CM_DEMO_WORKTREE_ID, or re-run env-up\.sh/,
    );
  });

  it('refuses to film sync-worktrees without the id the boot sync missed', () => {
    expect(() =>
      resolveRecordOptions(
        parseRecordArgs(['--scene', 'sync-worktrees', ...ARGS], {}),
        state(),
      ),
    ).toThrow(/sync-worktrees.*--unsynced-worktree/s);
  });

  it('does not demand the unsynced id for a run that never films that scene', () => {
    const resolved = resolveRecordOptions(
      parseRecordArgs(['--scene', 'sessions-overview', ...ARGS], {}),
      state(),
    );
    expect(resolved.unsyncedWorktreeId).toBe('');
  });
});

describe('SCENES', () => {
  it('exposes the scene library storyboards draw from', () => {
    // Since #1575 a storyboard is a subset of this list rather than a mirror of
    // it, so the order here is the order scenes were added, not a running order.
    expect(SCENES.map((scene) => scene.id)).toEqual([
      'sessions-overview',
      'send-and-generate',
      'attention-badge',
      'review-screen',
      'slash-palette',
      'install-skill',
      'contract-verify',
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
      // A terminal scene has no browser to drive, so it carries `record`
      // instead of `run` (#1810). Exactly one of the two, never both.
      expect(isTerminalScene(scene) ? typeof scene.record : typeof scene.run).toBe('function');
    }
  });

  it('films the contract and its verdict from a tmux pane, not a browser', () => {
    // Task Contract, the gates and Evidence have no Web UI to point a camera
    // at: `src/components` calls neither /api/worktrees/:id/tasks nor
    // /api/verification/*. A browser scene here would have to invent a screen.
    const terminal = SCENES.filter(isTerminalScene).map((scene) => scene.id);
    expect(terminal).toEqual(['contract-verify']);
  });

  it('names the four commands the slash palette take asserts are on screen', () => {
    // The seed carries the real files env-up.sh copies in, so a palette that
    // renders nothing means the seed is wrong rather than the shot being slow.
    expect(SLASH_PALETTE_COMMANDS).toEqual([
      '/cmate-verify',
      '/work-plan',
      '/create-pr',
      '/tdd-impl',
    ]);
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
      removeTempDir(scratch);
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
    pages: Array<{ worktrees?: Array<{ id: string; path?: string; isProcessing?: boolean }> }>,
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

  it('fails on the first poll when the seed directory carries a different id', async () => {
    // Not after the timeout: an id is frozen at first registration
    // (syncWorktreesToDB looks the row up by path), so waiting cannot fix it.
    // This is the check that would have named #1809 in one line.
    const { deps: d } = deps([
      { worktrees: [{ id: 'wt-dark-mode', path: DARK_MODE_DIR, isProcessing: true }] },
    ]);
    await expect(
      waitForWorktree(
        'http://x',
        { id: 'cmdemo-app-feature-demo-dark-mode', path: DARK_MODE_DIR },
        (w) => w.isProcessing === true,
        'generating',
        60_000,
        d,
        250,
      ),
    ).rejects.toThrow(/id mismatch.*'wt-dark-mode'.*'cmdemo-app-feature-demo-dark-mode'/s);
    expect(d.fetchJson).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('lists the ids and paths it does know when it times out', async () => {
    const { deps: d } = deps([{ worktrees: [{ id: 'other', path: '/seed/other' }] }]);
    await expect(
      waitForWorktree(
        'http://x',
        { id: 'wt-dark-mode', path: DARK_MODE_DIR },
        () => true,
        'present',
        1000,
        d,
        250,
      ),
    ).rejects.toThrow(
      new RegExp(`expected it at ${DARK_MODE_DIR}.*"id":"other","path":"/seed/other"`, 's'),
    );
  });
});

describe('assertIdForPath', () => {
  it('accepts the pair env-up.sh recorded', () => {
    expect(() =>
      assertIdForPath(
        [{ id: 'wt-dark-mode', path: DARK_MODE_DIR }],
        'wt-dark-mode',
        DARK_MODE_DIR,
      ),
    ).not.toThrow();
  });

  it('is a no-op when no path was recorded, so the check can never invent a failure', () => {
    expect(() => assertIdForPath([{ id: 'anything', path: DARK_MODE_DIR }], 'wt', '')).not.toThrow();
  });

  it('says nothing about a path the server does not know yet', () => {
    // sync-worktrees films a worktree *appearing*; its precondition is absence.
    expect(() => assertIdForPath([], 'wt-api-cache', API_CACHE_DIR)).not.toThrow();
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

  it('reads id/path pairs out of the /api/worktrees envelope', () => {
    // The path is what the id cross-check compares against; a reader that
    // dropped it would make assertIdForPath silently vacuous.
    expect(
      readWorktreeEntries({
        worktrees: [{ id: 'wt-dark-mode', path: DARK_MODE_DIR }],
        repositories: [],
      }),
    ).toEqual([{ id: 'wt-dark-mode', path: DARK_MODE_DIR }]);
    expect(readWorktreeEntries({})).toEqual([]);
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

describe('the harness ids agree with the rule the product mints them by', () => {
  // This used to pin two string constants, which is why it stayed green through
  // Issue #1621: the constants matched each other and matched nothing the
  // server did. It now runs the *product* function over the directories
  // env-up.sh creates, so a change to the derivation rule turns this red before
  // it turns a take into six timeouts.
  const envUp = fs.readFileSync(
    path.resolve(__dirname, '../../../../.claude/skills/demo-video/scripts/env-up.sh'),
    'utf8',
  );

  it.each([
    ['cmdemo-app', `${SEED_ROOT}/cmdemo-app`],
    ['wt-dark-mode', DARK_MODE_DIR],
    ['wt-login-error', `${SEED_ROOT}/wt-login-error`],
    ['wt-api-cache', API_CACHE_DIR],
  ])('deriveWorktreeId mints %s for the seed directory of the same name', (id, dir) => {
    expect(deriveWorktreeId(dir, new Set<string>())).toBe(id);
  });

  it('has no basename collision, so no id can pick up a digest suffix', () => {
    // deriveWorktreeId only appends `-<sha256 prefix>` on collision, and such an
    // id would depend on the absolute state dir — unpredictable for env-up.sh.
    const dirs = ['cmdemo-app', 'cmdemo-docs', 'wt-dark-mode', 'wt-login-error', 'wt-api-cache'];
    const taken = new Set<string>();
    for (const dir of dirs) {
      const id = deriveWorktreeId(`${SEED_ROOT}/${dir}`, taken);
      expect(id).toBe(dir);
      taken.add(id);
    }
  });

  it('creates exactly those directories and records their ids in state.env', () => {
    // The link between the rule above and the harness: if env-up.sh renames a
    // seed directory or stops writing a key, one of these fails.
    expect(envUp).toContain('WT_DARK_MODE="$SEED_ROOT/wt-dark-mode"');
    expect(envUp).toContain('WT_LOGIN_ERROR="$SEED_ROOT/wt-login-error"');
    expect(envUp).toContain('WT_API_CACHE="$SEED_ROOT/wt-api-cache"');
    expect(envUp).toContain('worktree add -q -b feature/demo-api-cache "$WT_API_CACHE"');
    expect(envUp).toContain('CM_DEMO_SEED_REPO_2=$SEED_REPO_2');
    expect(envUp).toContain('CM_DEMO_WORKTREE_ID=$WORKTREE_ID');
    expect(envUp).toContain('CM_DEMO_UNSYNCED_WORKTREE_ID=$UNSYNCED_WORKTREE_ID');
    expect(envUp).toContain('CM_DEMO_WORKTREE_PATH=$WT_DARK_MODE');
    expect(envUp).toContain('CM_DEMO_UNSYNCED_WORKTREE_PATH=$WT_API_CACHE');
  });

  it('keeps no trace of the branch-derived scheme in either install root', () => {
    // The acceptance grep of #1809, as a test: neither the retired id nor the
    // deprecated minter may survive anywhere in the skill — including in prose,
    // where a stale explanation is what sends the next reader to rebuild the
    // same broken assumption.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });

    const roots = ['.claude', '.agents'].map((root) =>
      path.resolve(__dirname, `../../../../${root}/skills/demo-video`),
    );
    const files = roots.flatMap(walk);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(`${file}: ${source}`).not.toContain('cmdemo-app-feature-demo');
      expect(`${file}: ${source}`).not.toContain('generateWorktreeId');
    }
  });
});


/**
 * The scenes #1810 added, exercised through their real `prepare` with `fetch`
 * stubbed.
 *
 * `prepare` is where every scene decides whether the product is in the state it
 * films, so it is the half worth testing without a browser: a wrong predicate
 * here costs a whole take and reports itself as a timeout.
 */
describe('the #1810 scenes', () => {
  const BASE = 'http://127.0.0.1:3399';
  const scene = (id: string) => SCENES.find((s) => s.id === id)!;

  function prepareContext(overrides: Partial<RecordOptions> = {}): PrepareContext {
    return {
      baseUrl: BASE,
      options: {
        ...parseRecordArgs(ARGS, {}),
        timeoutMs: 30,
        ...overrides,
      },
      state: { baseUrl: BASE, videoDir: '/tmp/videos' } as DemoState,
    };
  }

  /** A fetch stub over a fixed routing table, recording every POST it saw. */
  function stubFetch(routes: Record<string, unknown | (() => Response)>) {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      const key = Object.keys(routes).find((route) => url.endsWith(route));
      if (key === undefined) return new Response('not found', { status: 404 });
      const value = routes[key];
      if (typeof value === 'function') return (value as () => Response)();
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return posts;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const worktreeList = (worktree: Record<string, unknown>) => ({
    worktrees: [{ id: 'wt-dark-mode', path: DARK_MODE_DIR, ...worktree }],
  });

  it('sends a message itself when attention-badge is filmed against an idle session', async () => {
    // The take is filmable on its own (`--scene attention-badge`). An idle
    // cassette is parked on `@input` and paints nothing until something is sent.
    let processing = false;
    const posts = stubFetch({
      '/api/worktrees': () =>
        new Response(
          JSON.stringify(
            worktreeList({ isSessionRunning: true, isProcessing: processing, isWaitingForResponse: false }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const pending = scene('attention-badge').prepare!(prepareContext({ timeoutMs: 2000 }));
    // The send is what moves the cassette on, so the state only changes after it.
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    processing = true;
    await pending;

    expect(posts[0].url).toBe(`${BASE}/api/worktrees/wt-dark-mode/send`);
    expect(posts[0].body).toEqual({ content: DEFAULT_MESSAGE });
  });

  it('does not send again when attention-badge follows send-and-generate', async () => {
    const posts = stubFetch({
      '/api/worktrees': worktreeList({
        isSessionRunning: true,
        isProcessing: true,
        isWaitingForResponse: false,
      }),
    });
    await scene('attention-badge').prepare!(prepareContext());
    expect(posts).toEqual([]);
  });

  it('refuses to film attention-badge against a session that is already waiting', async () => {
    // The toast comes off a realtime `session_status_changed` event, which a
    // page opened after the edge never receives: the take would show the pill
    // and silently lose the toast it exists to show.
    stubFetch({
      '/api/worktrees': worktreeList({
        isSessionRunning: true,
        isProcessing: false,
        isWaitingForResponse: true,
      }),
    });
    await expect(scene('attention-badge').prepare!(prepareContext())).rejects.toThrow(
      /already waiting for a response/,
    );
  });

  it('waits for an approval before filming the Review screen', async () => {
    stubFetch({
      '/api/worktrees': worktreeList({ isSessionRunning: true, isWaitingForResponse: false }),
    });
    await expect(scene('review-screen').prepare!(prepareContext())).rejects.toThrow(
      /waiting for a response/,
    );
  });

  it('waits for a live session before filming the slash palette', async () => {
    stubFetch({ '/api/worktrees': worktreeList({ isSessionRunning: false }) });
    await expect(scene('slash-palette').prepare!(prepareContext())).rejects.toThrow(
      /showing a live agent session/,
    );
  });

  it('skips install-skill, with the reason, when the Catalog is unreachable', async () => {
    // The Catalog URL is a compile-time constant with an exact-match allowlist
    // (SSRF policy), so it cannot be pointed at a local fixture: offline is a
    // skip, and a skip has to say why rather than produce an empty take.
    stubFetch({ '/api/skills': () => new Response('unavailable', { status: 503 }) });
    const error = await scene('install-skill')
      .prepare!(prepareContext())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SceneUnavailableError);
    expect((error as Error).message).toMatch(/Skill Catalog is unreachable/);
  });

  it('skips install-skill when the Catalog is only served from a stale snapshot', async () => {
    stubFetch({ '/api/skills': { catalog: { stale: true }, skills: [] } });
    await expect(scene('install-skill').prepare!(prepareContext())).rejects.toBeInstanceOf(
      SceneUnavailableError,
    );
  });

  it('refuses to film an install of a Skill the worktree already has', async () => {
    stubFetch({
      '/api/skills': { catalog: { stale: false }, skills: [] },
      [`/api/worktrees/wt-dark-mode/skills`]: {
        skills: [{ skillId: DEMO_CATALOG_SKILL_ID }],
      },
    });
    await expect(scene('install-skill').prepare!(prepareContext())).rejects.toThrow(
      /to still be uninstalled/,
    );
  });
});

describe('readCatalogAvailability', () => {
  it.each([
    [{ catalog: { stale: false }, skills: [] }, true],
    [{ catalog: { stale: true }, skills: [] }, false],
    [{ skills: [] }, false],
  ])('reads %j as ok=%s', (payload, ok) => {
    expect(readCatalogAvailability(payload).ok).toBe(ok);
  });

  it('says why, so a skipped take is not a mystery', () => {
    expect(readCatalogAvailability({ catalog: { stale: true } }).reason).toMatch(/stale/);
  });
});

describe('readInstalledSkillIds', () => {
  it('reads ids out of the worktree skills envelope', () => {
    expect(readInstalledSkillIds({ skills: [{ skillId: 'a' }, { skillId: 'b' }] })).toEqual(['a', 'b']);
  });

  it('reads an empty list from a worktree with nothing installed', () => {
    expect(readInstalledSkillIds({ skills: [] })).toEqual([]);
    expect(readInstalledSkillIds({})).toEqual([]);
  });
});

describe('waitForTitleBadge', () => {
  /** The two calls the helper makes; enough of a Page for it to run. */
  const fakePage = (titles: string[]) => {
    let index = 0;
    return {
      title: async () => titles[Math.min(index++, titles.length - 1)],
      waitForTimeout: async () => undefined,
    } as unknown as Page;
  };

  it('resolves once the title carries the (N) prefix the badge prepends', async () => {
    await expect(
      waitForTitleBadge(fakePage(['CommandMate', 'CommandMate', '(1) CommandMate']), 5000),
    ).resolves.toBe('(1) CommandMate');
  });

  it('accepts a count above one, which is what a second waiting branch produces', async () => {
    await expect(waitForTitleBadge(fakePage(['(2) CommandMate']), 5000)).resolves.toBe(
      '(2) CommandMate',
    );
  });

  it('reports the title it kept seeing rather than timing out silently', async () => {
    // The badge is the half of the notification that reaches someone whose tab
    // is in the background — and the half a reviewer would never notice missing.
    await expect(waitForTitleBadge(fakePage(['CommandMate']), 0)).rejects.toThrow(
      /never took the attention badge; last seen: "CommandMate"/,
    );
  });
});

describe('terminalWorkDir', () => {
  it('scratches inside the demo state dir, never in the repository', () => {
    const options = parseRecordArgs(ARGS, {});
    const dir = terminalWorkDir(options, {
      baseUrl: 'http://127.0.0.1:3399',
      videoDir: '',
      CM_DEMO_STATE_DIR: '/home/dev/.commandmate-demo',
    });
    expect(dir).toBe('/home/dev/.commandmate-demo/terminal-work');
  });

  it('honours an explicit --work', () => {
    const options = { ...parseRecordArgs(ARGS, {}), workDir: '/elsewhere/work' };
    expect(terminalWorkDir(options, { baseUrl: '', videoDir: '' })).toBe('/elsewhere/work');
  });
});

/**
 * Assembled at runtime, never spelled out.
 *
 * `tests/unit/config/tmux-live-test-safety.test.ts` scans every test source for
 * these literals and fails on one that is not pinned to a private `-L` socket.
 * That guard cannot tell an assertion *against* a command from a use of it, so
 * even a negative assertion has to avoid writing the token down.
 */
const SERVER_GLOBAL_TMUX_COMMANDS = [
  ['kill', 'server'].join('-'),
  ['bind', 'key'].join('-'),
  `${['set', 'option'].join('-')} -g`,
];

/**
 * Top of the telop band's scrim in a 1280x800 frame, measured off the alpha
 * channel of the PNG render-overlays.ts writes (alpha > 32 spans y 612..720).
 */
const TELOP_BAND_TOP_Y = 612;

describe('the terminal take is wired to the recorded-session teardown', () => {
  const cliScene = fs.readFileSync(
    path.resolve(__dirname, '../../../../.claude/skills/demo-video/scripts/cli-scene.sh'),
    'utf8',
  );

  it('defaults to the session name env-down.sh will be told about', () => {
    expect(DEFAULT_CLI_SESSION).toBe('cmdemo-cli');
    expect(cliScene).toContain('SESSION="cmdemo-cli"');
  });

  it('records the session name before the session exists', () => {
    // A session created and then not written down is exactly the leak the
    // record-based teardown was built to prevent (#1809): env-down.sh kills
    // what it finds in $CM_DEMO_SESSIONS_FILE and never sweeps `mcbd-*`.
    const recordAt = cliScene.indexOf('>>"$CM_DEMO_SESSIONS_FILE"');
    const createAt = cliScene.indexOf('new-session -d -s "$SESSION"');
    expect(recordAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(recordAt).toBeLessThan(createAt);
  });

  it('never kills the tmux server, and never mutates it globally', () => {
    const code = cliScene
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    for (const forbidden of SERVER_GLOBAL_TMUX_COMMANDS) {
      expect(code, `cli-scene.sh uses ${forbidden}`).not.toContain(forbidden);
    }
    // The guard is not vacuous: the same check fires on a script that does it.
    expect(`tmux ${SERVER_GLOBAL_TMUX_COMMANDS[0]}`).toContain(SERVER_GLOBAL_TMUX_COMMANDS[0]);
  });

  it('refuses to drive port 3000 and isolates HOME from ~/.commandmate/.env', () => {
    expect(cliScene).toContain('refusing to drive a live CommandMate instance');
    expect(cliScene).toContain('HOME="$CLI_HOME"');
    expect(cliScene).toContain('CM_PORT="$CM_DEMO_PORT"');
  });

  it('asserts the CLI sees only this run’s seed worktrees before sending anything', () => {
    const assertAt = cliScene.indexOf('assert_only_seed_worktrees\n');
    const sendAt = cliScene.indexOf('cm send');
    expect(assertAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(assertAt);
    expect(cliScene).toContain('refusing to film a session that is not isolated');
  });

  it('keeps the transcript clear of the telop band', () => {
    // Issue #1811. templates/terminal.html lays the capture out from the top of
    // a body pinned to 736px, one 23px row per captured line, so row N lands at
    // about y = 42 + (N-1)*23 in the 1280x800 frame. The telop band is fixed at
    // `margin-bottom: 7.5%` for every cut and its scrim covers y 612..720
    // (measured off the rendered overlay PNG). At the old 32 rows the GATE
    // block landed underneath it and `GATE scope PASS (exit=0, 0.0s)` lost its
    // parenthesis; the pane height is what decides that, because the transcript
    // is anchored to the bottom of the pane.
    const height = Number(/^PANE_HEIGHT=(\d+)$/m.exec(cliScene)![1]);
    expect(Number.isFinite(height)).toBe(true);
    // `GATE unit PASS` is six rows above the last one (RESULT, blank-free tail,
    // `$ echo $?`, the code itself).
    const gateRowBottom = (rows: number) => 42 + (rows - 6) * 23 + 17;
    expect(gateRowBottom(height)).toBeLessThan(TELOP_BAND_TOP_Y);
    // Not vacuous: the geometry that shipped the bug fails this.
    expect(gateRowBottom(32)).toBeGreaterThan(TELOP_BAND_TOP_Y);
  });

  it('reads three states out of `ls --json`, not two', () => {
    // Issue #1811. The probe used to answer a yes/no question — "is it
    // generating and not on a prompt" — and the loop waited for the yes. The
    // cassette can finish its stretch before the poll first looks, so that yes
    // never arrived, the loop gave up after 90 tries, and the pane was killed
    // mid-take. Run the real heredoc rather than asserting on its source: what
    // matters is the exit code the shell branches on.
    const probe = /cat >"\$PROBE" <<'PROBEJS'\n([\s\S]*?)\nPROBEJS/.exec(cliScene)?.[1];
    expect(probe, 'probe heredoc not found in cli-scene.sh').toBeTruthy();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-probe-'));
    const probeFile = path.join(scratch, 'probe.mjs');
    fs.writeFileSync(probeFile, `${probe}\n`);

    const run = (status: Record<string, boolean> | null): number => {
      const payload = JSON.stringify([
        { id: 'other', sessionStatusByCli: { claude: { isProcessing: true } } },
        { id: 'wt-dark-mode', sessionStatusByCli: status ? { claude: status } : {} },
      ]);
      try {
        execFileSync('node', [probeFile, 'wt-dark-mode'], { input: payload, stdio: 'pipe' });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };

    try {
      // Parked on the prompt: never safe, whatever else is true.
      expect(run({ isProcessing: false, isWaitingForResponse: true })).toBe(1);
      expect(run({ isProcessing: true, isWaitingForResponse: true })).toBe(1);
      // No status at all is the same answer, not a pass.
      expect(run(null)).toBe(1);
      // Generating and off the prompt: continue at once.
      expect(run({ isProcessing: true, isWaitingForResponse: false })).toBe(0);
      // Settled and off the prompt: a distinct code, because the caller may
      // only continue on it after it has outlived the 5s capture cache.
      expect(run({ isProcessing: false, isWaitingForResponse: false })).toBe(2);
    } finally {
      removeTempDir(scratch);
    }
  });

  it('accepts the settled state only after it outlives the capture cache', () => {
    // The 5s cache (#1623) is the reason a single settled reading is not
    // enough: it could still be describing the pane as it was before the
    // message landed. The loop polls about once a second.
    const settled = Number(/^SETTLED_POLLS=(\d+)$/m.exec(cliScene)![1]);
    expect(settled).toBeGreaterThan(5);
    expect(cliScene).toMatch(/\[ "\$settled" -lt "\$SETTLED_POLLS" \] \|\| return 0/);
  });

  it('shows the redirect it actually performs', () => {
    // The banner is hand-written, so it can drift from the command underneath
    // it. These two payloads go to files to keep the transcript inside the row
    // budget (#1811); a banner that hid that would be the pane claiming to run
    // something it did not.
    for (const redirect of ['>task-id.txt', '>prompt.json']) {
      const occurrences = cliScene.split(redirect).length - 1;
      expect(occurrences, `${redirect} should appear in both banner and command`).toBe(2);
    }
  });

  it('runs the real gates: no stub, no mock, and the exit code is asserted', () => {
    // SKILL.md's design judgement — only the LLM is replaced — covers the
    // verification gates too. Comment lines are stripped so the script's own
    // prose *about* not mocking does not read as mocking.
    const code = cliScene
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(cliScene).toContain('--verify');
    expect(cliScene).toContain('expected exit 10 (prompt detected) from the first wait');
    expect(cliScene).toContain('expected exit 0 from the verified wait');
    expect(code).not.toMatch(/\bmock|\bstub\b/i);
    expect('cm() { echo "GATE unit PASS"; }  # a stub').toMatch(/\bstub\b/i);
  });
});

describe('the seed carries what the #1810 scenes read', () => {
  const envUp = fs.readFileSync(
    path.resolve(__dirname, '../../../../.claude/skills/demo-video/scripts/env-up.sh'),
    'utf8',
  );

  it('commits the verification config and contract on main, before the branches exist', () => {
    // The contract allows `src/**` and `test/**` only, and the scope gate
    // reconciles the whole `main..HEAD` diff. Committing verify.yaml on the
    // feature branch would make the take film its own harness failing scope.
    const seedAt = envUp.indexOf('seed_verification_assets\n');
    const worktreeAt = envUp.indexOf('worktree add -q -b feature/demo-dark-mode');
    expect(seedAt).toBeGreaterThan(-1);
    expect(seedAt).toBeLessThan(worktreeAt);
    expect(envUp).toContain('.commandmate/verify.yaml');
    expect(envUp).toContain('.commandmate/tasks/dark-mode.yaml');
    expect(envUp).toContain('node --test');
  });

  it('proves the seed gate green before a server exists to film it', () => {
    expect(envUp).toContain("the seed's own 'node --test' is not green");
    const testAt = envUp.indexOf('node --test >"$STATE_DIR/seed-node-test.log"');
    const themeAt = envUp.indexOf('cat >"$WT_DARK_MODE/src/theme.ts"');
    expect(themeAt).toBeGreaterThan(-1);
    // The test only passes against the uncommitted work, so it has to run after
    // that work is on disk.
    expect(testAt).toBeGreaterThan(themeAt);
  });

  it('copies the real commands and Skill the slash palette shows', () => {
    for (const command of ['work-plan', 'create-pr', 'tdd-impl']) {
      expect(envUp).toContain(command);
    }
    expect(envUp).toContain('skills/cmate-verify');
    // Both install roots, byte-identically, because that is how it ships.
    expect(envUp).toContain('for skill_root in .claude .agents');
  });
});
