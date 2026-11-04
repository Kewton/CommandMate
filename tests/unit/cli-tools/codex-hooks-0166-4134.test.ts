/**
 * Issue #4134: a new `CODEX_HOME` on codex-cli 0.166.0. A digit only moves the
 * cursor on the hook review and the folder trust screens, the list and the
 * detail stay open after `t`, and all of it has new footers. Before this the
 * launch ran out of keys on the first screen and `send` ended in exit 99.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  getSessionWorkingDirectory: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { CodexTool } from '@/lib/cli-tools/codex';
import { capturePane, getSessionWorkingDirectory, hasSession, sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { CODEX_HOOK_TRUST_ENV_VAR } from '@/lib/hooks/sources/codex/hooks-config';

const frame = (name: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/codex-dialogs-0166', `${name}.txt`), 'utf8');

/** A pane that moves only on the keys codex 0.166.0 was measured to take. */
function simulate(
  start: string,
  moves: Record<string, Record<string, string>>
): { keys: string[]; goTo: (name: string) => void } {
  let current = start;
  const typed = {
    keys: [] as string[],
    goTo: (name: string): void => {
      current = name;
    },
  };
  const press = (key: string): void => {
    typed.keys.push(key);
    current = moves[current]?.[key] ?? current;
  };
  vi.mocked(capturePane).mockImplementation(async () => frame(current));
  vi.mocked(sendKeys).mockImplementation(async (_s, keys, enter) => {
    if (enter === true && keys !== '') return; // the launch line
    press(enter === true ? 'Enter' : String(keys));
  });
  vi.mocked(sendSpecialKey).mockImplementation(async (_s, key) => {
    press(String(key));
  });
  return typed;
}

const LIVE_0166 = {
  'hooks-review': { '2': 'hooks-review-cursor-2', Enter: 'hooks-list' },
  'hooks-review-cursor-2': { '2': 'hooks-review-cursor-2', Enter: 'ready' },
  'hooks-list': { t: 'hooks-list-trusted', Escape: 'ready' },
  'hooks-detail': { t: 'hooks-detail-trusted', Escape: 'hooks-list' },
  'hooks-detail-trusted': { Escape: 'hooks-list' },
  'hooks-list-trusted': { Escape: 'ready' },
  trust: { Enter: 'ready' },
};

describe('codex 0.166.0 hook review', () => {
  let plain: string;
  let withRepoHooks: string;
  let savedTrust: string | undefined;
  let savedCodexHome: string | undefined;
  let codexHome: string;

  /** The launch really writes `hooks.json` and the relay: to this suite's own directory. */
  function useOwnCodexHome(): void {
    process.env.CODEX_HOME = codexHome;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    savedCodexHome = process.env.CODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), 'codex-4134-home-'));
    useOwnCodexHome();
    savedTrust = process.env[CODEX_HOOK_TRUST_ENV_VAR];
    delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
    plain = mkdtempSync(join(tmpdir(), 'codex-4134-plain-'));
    withRepoHooks = mkdtempSync(join(tmpdir(), 'codex-4134-repo-'));
    mkdirSync(join(withRepoHooks, '.codex'), { recursive: true });
    writeFileSync(join(withRepoHooks, '.codex', 'hooks.json'), '{"hooks":{}}');
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(getSessionWorkingDirectory).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTrust === undefined) delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
    else process.env[CODEX_HOOK_TRUST_ENV_VAR] = savedTrust;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    removeTempDir(codexHome);
    removeTempDir(plain);
    removeTempDir(withRepoHooks);
  });

  async function start(path: string): Promise<void> {
    vi.useFakeTimers();
    try {
      const promise = new CodexTool().startSession('wt-4134', path);
      await vi.runAllTimersAsync();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  }

  async function send(): Promise<unknown> {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      const outcome = new CodexTool().sendMessage('wt-4134', 'hello').then(
        () => null,
        (error: unknown) => error
      );
      await vi.runAllTimersAsync();
      return await outcome;
    } finally {
      vi.useRealTimers();
    }
  }

  it('moves to "Trust all" and confirms it with Enter', async () => {
    const pane = simulate('hooks-review', LIVE_0166);
    await start(plain);
    expect(pane.keys).toEqual(['2', 'Enter']);
  });

  it('declines the same way when trust is withheld, and never confirms another row', async () => {
    const moves = {
      'hooks-review': { '3': 'hooks-review-cursor-3' },
      'hooks-review-cursor-3': { Enter: 'ready' },
    };
    const declined = frame('hooks-review-cursor-2')
      .replace('› 2. Trust all', '  2. Trust all')
      .replace("  3. Continue without", "› 3. Continue without");
    const pane = simulate('hooks-review', moves);
    const base = vi.mocked(capturePane).getMockImplementation()!;
    let onThree = false;
    vi.mocked(capturePane).mockImplementation(async (...args) =>
      onThree ? declined : base(...(args as Parameters<typeof base>))
    );
    vi.mocked(sendKeys).mockImplementation(async (_s, keys, enter) => {
      if (enter === true && keys !== '') return;
      pane.keys.push(enter === true ? 'Enter' : String(keys));
      if (keys === '3') onThree = true;
    });
    vi.mocked(sendSpecialKey).mockImplementation(async (_s, key) => {
      pane.keys.push(String(key));
      if (key === 'Enter') {
        onThree = false;
        vi.mocked(capturePane).mockImplementation(async () => frame('ready'));
      }
    });
    await start(withRepoHooks);
    expect(pane.keys).toEqual(['3', 'Enter']);
  });

  it('never confirms when the cursor is on another row than the answer', async () => {
    // A screen that ignores the digit: the first row is `Review hooks`, which is not the answer.
    const pane = simulate('hooks-review', {});
    await start(plain);
    expect(pane.keys).not.toContain('Enter');
    expect(pane.keys.every((key) => key === '2')).toBe(true);
  });

  it('trusts the list and then closes the screen `t` leaves open', async () => {
    const pane = simulate('hooks-list', LIVE_0166);
    await start(plain);
    expect(pane.keys).toEqual(['t', 'Escape']);
  });

  it('walks the detail back up and closes everything', async () => {
    const pane = simulate('hooks-detail', LIVE_0166);
    await start(plain);
    expect(pane.keys).toEqual(['t', 'Escape', 't', 'Escape']);
  });

  it('escapes the list instead of trusting when trust is withheld', async () => {
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'never';
    const pane = simulate('hooks-list', LIVE_0166);
    await start(plain);
    expect(pane.keys).toEqual(['Escape']);
  });

  it('clears the screens at send time too, then sends', async () => {
    vi.mocked(getSessionWorkingDirectory).mockResolvedValue(plain);
    const pane = simulate('hooks-review', LIVE_0166);
    expect(await send()).toBeNull();
    expect(pane.keys).toEqual(['2', 'Enter']);
    expect(sendMessageWithSubmitVerification).toHaveBeenCalled();
  });

  it('does not type the message into a hooks screen that reads as a composer, and says why it stopped', async () => {
    // `› PreToolUse` wears the composer glyph, so the message used to be typed into this list.
    vi.mocked(getSessionWorkingDirectory).mockResolvedValue(plain);
    simulate('hooks-list', {});
    const error = await send();
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
    expect(String(error)).toMatch(/hook review/);
    expect(String(error)).toMatch(/hooks-list/);
  });

  it('confirms the folder trust with Enter after the digit, on row 1 only', async () => {
    const pane = simulate('trust', LIVE_0166);
    await start(plain);
    expect(pane.keys).toEqual(['1', 'Enter']);
  });

  it('leaves the update offer to its digit, as measured', async () => {
    const pane = simulate('update', { update: { '3': 'ready' } });
    await start(plain);
    expect(pane.keys).toEqual(['3']);
  });

  describe('a screen that changes while the folder trust Enter waits for the composer', () => {
    /** Another writer takes the composer right after the read that chose Enter, and the pane moves under it. */
    function moveWhileEnterWaits(after: string): { keys: string[] } {
      const pane = simulate('trust', LIVE_0166);
      const session = new CodexTool().getSessionName('wt-4134');
      const typeDigit = vi.mocked(sendKeys).getMockImplementation()!;
      let digitTyped = false;
      vi.mocked(sendKeys).mockImplementation(async (...args) => {
        await typeDigit(...args);
        if (args[1] === '1') digitTyped = true;
      });
      const read = vi.mocked(capturePane).getMockImplementation()!;
      vi.mocked(capturePane).mockImplementation(async (...args) => {
        const screen = await read(...args);
        if (digitTyped) {
          digitTyped = false;
          void withInstanceInputLock(session, async () => {
            pane.goTo(after);
            await new Promise((resolve) => setTimeout(resolve, 100));
          });
        }
        return screen;
      });
      return pane;
    }

    it('does not press Enter on `1. Review hooks`, the same number on another screen', async () => {
      const pane = moveWhileEnterWaits('hooks-review');
      await start(plain);
      // The hook review then gets its own answer, from its own read.
      expect(pane.keys).toEqual(['1', '2', 'Enter']);
    });

    it('still presses it when the trust screen is what the second read shows', async () => {
      const pane = moveWhileEnterWaits('trust');
      await start(plain);
      expect(pane.keys).toEqual(['1', 'Enter']);
    });
  });

  it('names the folder trust screen a running process is parked on, and types nothing', async () => {
    const pane = simulate('trust', {});
    const error = await send();
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
    expect(pane.keys).toEqual([]);
    expect(String(error)).toMatch(/prompt not ready/);
    expect(String(error)).toMatch(/\btrust\b/);
  });

  it('keeps the plain wording when no dialog is what is in the way', async () => {
    vi.mocked(capturePane).mockResolvedValue('Starting up');
    const error = await send();
    expect(String(error)).toMatch(/timed out waiting for the input prompt before sending$/);
  });

  describe('CODEX_HOME', () => {
    const written = (dir: string): string[] => readdirSync(dir);

    it('the launch writes where the variable points, so the check below can fail', async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'codex-4134-elsewhere-'));
      try {
        process.env.CODEX_HOME = elsewhere;
        simulate('ready', {});
        await start(plain);
        expect(existsSync(join(elsewhere, 'hooks.json'))).toBe(true);
      } finally {
        removeTempDir(elsewhere);
      }
    });

    it('a CODEX_HOME inherited from outside gets nothing: the suite moves it first', async () => {
      const inherited = mkdtempSync(join(tmpdir(), 'codex-4134-inherited-'));
      try {
        process.env.CODEX_HOME = inherited;
        useOwnCodexHome();
        simulate('ready', {});
        await start(plain);
        expect(written(inherited)).toEqual([]);
        expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
      } finally {
        removeTempDir(inherited);
      }
    });
  });
});
