// Vitest setup file
import { beforeAll, afterAll, afterEach, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import '@testing-library/jest-dom/vitest';
import { AGENT_CORRELATION_ENV_KEYS } from '../src/lib/security/env-sanitizer';
import {
  REAL_SHELL_TEST_TIMEOUT_MS,
  startsRealSubprocess,
} from './helpers/real-shell-budget';
import { installRealServerFence, TEST_HOOK_HOST } from './helpers/real-server-fence';
import {
  closeOpenTestDatabases,
  isolateTestDatabaseEnv,
  removeTestDatabaseDir,
} from './helpers/test-db-isolation';

// Issue #1950: give tests that start a real subprocess a budget that matches
// what they actually do.
//
// This runs once per test file, before collection, so `vi.setConfig` here is
// the file's default rather than a per-test override: an `it()` that states its
// own timeout still wins, which is how `compose` keeps its 300_000 and how a
// future test can opt back down.
//
// Membership is read off the file's own source instead of a path list, because
// a list is a thing that goes stale the first time somebody writes a new test
// that shells out. The cost is one `readFileSync` per test file — ~974 reads
// spread across the worker pool, against a suite whose baseline is 66s — and
// only the ~7% of files that match go on to change their budget.
//
// Why this cannot be expressed in vitest.config.ts: `testTimeout` there is
// global or per-`projects` entry, and splitting the family into its own project
// changes the pool the files run in. The budget is the fix; the pool is not
// (serializing the family was measured at 3x the wall clock and rejected).
// See tests/helpers/real-shell-budget.ts for the measurements.
const currentTestPath = expect.getState().testPath;
if (currentTestPath !== undefined) {
  let source = '';
  try {
    source = readFileSync(currentTestPath, 'utf8');
  } catch {
    // A file vitest can run but this process cannot read is not a case worth
    // failing the suite over; it simply keeps the default budget.
    source = '';
  }
  if (startsRealSubprocess(source)) {
    vi.setConfig({
      testTimeout: REAL_SHELL_TEST_TIMEOUT_MS,
      hookTimeout: REAL_SHELL_TEST_TIMEOUT_MS,
    });
  }
}

// Issue #4275: drop the agent correlation keys the suite inherited.
//
// The suite is run from inside agent tmux sessions (`wait --verify`), where
// CM_AGENT_WORKTREE_ID / CM_AGENT_INSTANCE_ID / ... name the *agent's* worktree.
// A test that hands `process.env` to a child then reads the parent agent's
// identity (measured in #4266: worktree-id `mycodebranchdesk`, instance `codex`).
// Decision: delete them here for every test file rather than having each test
// save them, because a per-test list is a hole the next test reopens. A test
// that wants a value sets it itself (this runs before the test file does), so
// tests that read an explicit correlation key are unaffected. The key list is
// imported from the module that defines it, not copied.
for (const key of AGENT_CORRELATION_ENV_KEYS) {
  delete process.env[key];
}

// Issue #1760: keep agent config generation out of the developer's home.
//
// `CodexTool.startSession` writes codex's hooks file, and codex reads exactly
// one location — `$CODEX_HOME/hooks.json`, defaulting to `~/.codex/hooks.json`.
// So any test that starts a codex session, including ones written long after
// this line, would edit the real file on whatever machine ran the suite. Pinned
// here rather than per file because the default is what makes it dangerous.
//
// Issue #4146: always this path, never the value the suite was started with. A
// `CODEX_HOME` exported in the shell, or inherited by a tmux pane, is a real
// directory, and `??=` kept it. A test that cares about the path still sets its
// own value: this runs before the test file does.
process.env.CODEX_HOME = join(tmpdir(), 'commandmate-test-codex-home');

// Issue #1942: the same hazard, for the tool that has no per-session escape.
//
// `~/.copilot/settings.json` is where copilot reads its hooks from, and it is
// the ONLY place: the source declares `configScope: 'global-singleton'` because
// copilot has no `--settings` flag. `writeCopilotHookSettings` therefore writes
// one file for the whole machine, and `COPILOT_HOME` is the single override
// that moves it. A test that starts a copilot session without setting the
// variable edits the developer's live copilot configuration — merged into,
// backed up over, and re-pointed at whatever port that run happened to use.
//
// Measured before adding this line, so it is a fence rather than a fix: the
// full `tests/unit` suite was run once with `HOME` redirected to an empty
// sentinel directory and `COPILOT_HOME` unset. No `.copilot` was created there
// at all — every copilot test sets `COPILOT_HOME` or `HOME` for itself today,
// and `terminal-route` / `api-send-cli-tool` mock `CopilotTool` outright. The
// default is here for the test written next month, which will inherit the
// isolation without knowing the hazard exists.
//
// Issue #4146: always this path, for CODEX_HOME's reason above: the value the
// suite was started with may be the real directory, and a blank one reads as
// unset and answers `~/.copilot` (`resolveSafeDirectory`). A test that redirects
// itself with `vi.stubEnv` or a bare assignment still wins over this.
//
// Scoped by worker pid, unlike CODEX_HOME's and CM_VERIFY_WORKTREE_INDEX_ROOT's
// single shared paths, because this default has a real writer and the file it
// writes is the contended one. `launch-contract-1846` stubs HOME but not
// COPILOT_HOME, so it lands here — and `writeCopilotHookSettings` MERGES into
// whatever is already at that path, takes a `.cmate.lock` it will decline to
// write without, and leaves a `.cmate-backup`. Two checkouts running the suite
// at once (this repo routinely runs five) would be reproducing the exact
// machine-global collision the isolation exists to prevent, one directory
// further down. Grouped under one parent so the whole family is `rm -rf`-able.
process.env.COPILOT_HOME = join(
  tmpdir(),
  'commandmate-test-copilot-home',
  String(process.pid)
);

// Issue #1873: keep worktree-index claims out of the developer's home.
//
// `executeRun` hands every command gate `CM_WORKTREE_INDEX`, and minting that
// number calls `resolveWorktreeIndex(worktreeId)` with no `root`
// (`src/lib/verification/gate-runner.ts`), so it lands in
// `~/.commandmate/worktree-index/` — the *shared, deliberately permanent*
// registry that numbers this machine's real worktrees. Slots are never
// released, so every `wt-*` fixture that ever ran burned one: measured on the
// author's machine, 40 of 45 entries were fixtures that had never been a
// worktree.
//
// Pinned here rather than per file for the same reason as CODEX_HOME above:
// the default is what makes it dangerous, so the fix has to sit where a test
// written next month inherits it without knowing the hazard exists. The three
// files that were leaking (`gate-runner`, `gate-runner-timestamps`,
// `hooks-agent-event`) plus `require-commit-conformance` never mention this
// variable; `gate-mutex` / `gate-flaky` / `worktree-index` already redirect
// themselves and keep doing so — `vi.stubEnv` and an explicit `{ root }`
// argument both still win over this line.
//
// Issue #4163: always this path, never the value the suite was started with,
// for CODEX_HOME's reason above. A worker's tmux pane inherits the shell or the
// server that started it, and an inherited root is a real directory. The same
// goes for every path below. `vi.stubEnv`, a bare assignment and an explicit
// `{ root }` run later and still win.
//
// One shared path under tmpdir is safe: claims are `O_EXCL` creates keyed by
// worktree id, so concurrent suites in different checkouts either reuse their
// own slot or take the next free one, never each other's.
process.env.CM_VERIFY_WORKTREE_INDEX_ROOT = join(tmpdir(), 'commandmate-test-worktree-index');

// Issue #3993: keep session-kill records out of the developer's home.
//
// A successful kill — `instances … kill`, the kill-session route, the session
// cleanup after sync or a repository removal — appends a line to
// `~/.commandmate/session-kills/` unless `CM_SESSION_KILL_LEDGER_ROOT` says
// otherwise, and the env-clean gate of a real verification reads that same
// directory back to excuse vanished sibling sessions. A test's fake kill of
// some `wt-*` fixture left there is both litter in $HOME and a record a real
// gate would read. Pinned like CM_VERIFY_WORKTREE_INDEX_ROOT above.
//
// Scoped by worker pid, unlike the worktree index: `evaluateEnvClean` reads
// this directory by default, so a kill another suite recorded at the same
// moment could otherwise excuse a removal in an unrelated test.
process.env.CM_SESSION_KILL_LEDGER_ROOT = join(
  tmpdir(),
  'commandmate-test-session-kills',
  String(process.pid)
);

// Issue #2490: keep opencode's port ledger out of the developer's home.
//
// `getOpencodePortFilePath()` answers `~/.commandmate/opencode-ports.json`
// unless `CM_OPENCODE_PORT_FILE` says otherwise, and `rememberOpencodePort` /
// `forgetOpencodePort` are read-modify-write on that one file. It is the same
// file a running CommandMate server keeps its live assignments in and reads
// back on restart (`hooks/sources/opencode/reattach.ts`,
// `slash-commands/opencode-live.ts`), so a test that writes it is editing
// production state on the machine that ran the suite.
//
// Unlike COPILOT_HOME above this is not a fence around a future test — it was
// already leaking. Measured on the author's machine 2026-09-12, before this
// line: the real file held SEVEN entries and every one of them was a fixture
// (`wt-alpha` / `wt-beta` / `wt-1898` / `wt-respond` / `wt-recheck`, all rooted
// at `/tmp/wt*`), the operator's own assignments having been read-modify-
// written away. Nineteen opencode test files redirect themselves; roughly ten
// more reach the module transitively and never think about it, which is why
// the fix belongs to the default rather than to the files somebody noticed.
//
// The `verify` env-clean gate cannot see this: it counts the entries directly
// under `~/.commandmate`, and rewriting a file that is already there changes
// no count (#2487's run 750 reported `commandmate-entries clean` while doing
// exactly this).
//
// A blank value is overwritten too: `resolveSafeDirectory` reads `''` as unset
// and answers the home path. A test that redirects itself with `vi.stubEnv` or a
// bare assignment still wins.
//
// Scoped by worker pid, like COPILOT_HOME and unlike CODEX_HOME: this default
// has a real writer and the write is read-modify-write on a single JSON
// document, so one shared path would let two checkouts running the suite at
// once (this repo routinely runs five) drop each other's keys — the same
// machine-global collision, one directory further down.
process.env.CM_OPENCODE_PORT_FILE = join(
  tmpdir(),
  'commandmate-test-opencode-ports',
  `${process.pid}.json`
);

// Issue #2948: OpenCode V2 keeps its per-instance passwords and port
// assignments under `~/.commandmate/opencode-v2` unless `CM_OPENCODE_V2_DIR`
// says otherwise (`getOpencodeV2StateDir()`). A test that reaches the
// startup sweep (`server.ts` → `reattachOpencodeV2EventStreams()`) with no
// live tmux session deletes every record there — the records of the user's
// running OpenCode V2 instances. Same default and same per-pid scoping as
// CM_OPENCODE_PORT_FILE above. A test that stubs the variable still wins.
process.env.CM_OPENCODE_V2_DIR = join(
  tmpdir(),
  'commandmate-test-opencode-v2',
  String(process.pid)
);

// Issue #3730: the Auto-Yes shutdown record lives next to the database
// (`<CM_DB_PATH>.auto-yes-shutdown.json`) unless
// `CM_AUTO_YES_SHUTDOWN_RECORD_PATH` says otherwise. A test that reaches
// `recordAutoYesShutdown` / `restoreAutoYesShutdownRecord` without its own path
// would write — or consume — the record of whatever database this machine's
// CM_DB_PATH names, i.e. a real server's. Same default and per-pid scoping as
// CM_OPENCODE_PORT_FILE above: the record has a writer and a deleter, so one
// shared path would let two suites running at once read each other's. A test
// that stubs the variable or passes `{ path }` still wins.
process.env.CM_AUTO_YES_SHUTDOWN_RECORD_PATH = join(
  tmpdir(),
  'commandmate-test-auto-yes-shutdown',
  `${process.pid}.json`
);

// Issue #4114: generated role files. The data root defaults to
// `~/.commandmate/agent-roles`, and Antigravity's agents directory to
// `~/.gemini/config/agents`, neither of which CODEX_HOME / COPILOT_HOME above
// cover. Same default and per-pid scoping as CM_OPENCODE_V2_DIR: a test that
// writes a role artifact without naming a directory lands here, and an explicit
// option or `vi.stubEnv` still wins.
process.env.CM_AGENT_ROLE_ARTIFACTS_DIR = join(
  tmpdir(),
  'commandmate-test-agent-roles',
  String(process.pid)
);
// Issue #4115: a shell that enabled the adapter does not enable it for the suite.
delete process.env.CM_AGENT_ROLE_ANTIGRAVITY_ENABLED;
process.env.CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR = join(
  tmpdir(),
  'commandmate-test-agent-roles-antigravity',
  String(process.pid)
);

// Issue #4163: the rest of the `CM_*` settings that name a real place. The
// classification of every `CM_*` is in this Issue's commit message (#4176's
// corrects CM_HTTPS_CERT / CM_HTTPS_KEY / CM_HOST / CM_PORT / CM_AUTH_TOKEN);
// `tests/unit/config/codex-home-isolation-4146.test.ts` holds these names and
// fails when one of them keeps a value from outside.
//
// Each of these has a real default or a real outer value: the opencode session
// memory and launch settings and the claude hook settings under `~/.commandmate`,
// the machine locks under `~/.commandmate/locks` that live runs share, the log
// directory, the UAT run lock and sockets (`<tmpdir>` and `/tmp`, shared with a
// live UAT), and the published daily result (`/Users/Shared/commandmate-check`).
// Scoped by worker pid: each has a writer, and two suites run at once.
process.env.CM_OPENCODE_SESSION_FILE = join(
  tmpdir(),
  'commandmate-test-opencode-sessions',
  `${process.pid}.json`
);
process.env.CM_OPENCODE_LAUNCH_SETTINGS_FILE = join(
  tmpdir(),
  'commandmate-test-opencode-launch-settings',
  `${process.pid}.json`
);
// Issue #4191: these per-worker paths are keyed by `process.pid`, which is one
// per worker under the default `forks` pool (vitest.config.ts sets no `pool`,
// and nothing runs the suite with `--pool=threads`). Under threads every worker
// would share them. Left as is: keying by `threadId` too would rename every
// path here for a pool nobody uses; add it when the pool changes.
process.env.CM_AGENT_HOOKS_DIR = join(tmpdir(), 'commandmate-test-agent-hooks', String(process.pid));
process.env.CM_VERIFY_LOCK_ROOT = join(tmpdir(), 'commandmate-test-locks', String(process.pid));
process.env.CM_LOG_DIR = join(tmpdir(), 'commandmate-test-logs', String(process.pid));
process.env.CM_RUN_LOCK_DIR = join(tmpdir(), 'commandmate-test-run-lock', String(process.pid));
process.env.CM_UAT_SOCK_BASE = join(tmpdir(), 'commandmate-test-uat-sock', String(process.pid));
process.env.CM_PRODUCT_PUBLISH_DIR = join(tmpdir(), 'commandmate-test-product-publish', String(process.pid));
// Issue #4176: the scripts the running server's tmux hooks execute
// (`~/.commandmate/bin`). `tests/unit/tmux/session-hooks-2317.test.ts` turns
// the live-attach and auto-popup options on, and each turn materializes them.
process.env.CM_TMUX_SCRIPT_DIR = join(tmpdir(), 'commandmate-test-tmux-scripts', String(process.pid));

// Issue #4163: these are removed, not pinned, because having no value is the safe
// state and is what CI runs with. The worker's shell carries
// `CM_ROOT_DIR=<the real repositories>` (scans and clones land under it; with none
// the root is the checkout); a hook URL names a running server; a pairing file
// means `remote` is running, and the route consumes it; the provider config asks
// for a file to be written beside opencode's own.
delete process.env.CM_ROOT_DIR;
delete process.env.MCBD_ROOT_DIR;
delete process.env.CM_BROWSE_ROOTS;
delete process.env.CM_HOOK_URL;
delete process.env.CM_PERMISSION_HOOK_URL;
delete process.env.CM_HOOK_PORT;
delete process.env.CM_REMOTE_PAIRING_FILE;
delete process.env.CM_OPENCODE_LOCAL_PROVIDER_CONFIG;

// Issue #4176: the server the suite would talk to. A worker's pane inherits the
// running server's `CM_PORT=3000`, and removing it changes nothing, because
// every reader falls back to 3000 — the same server. So the defaults are left
// as CI has them and the fence goes in front of `fetch` (the CLI's `ApiClient`
// and most of src/; `server-identity.ts`, `localhost-self-check.ts` and
// `cloudflare.ts` use `http.request` / `http.get` and are not fenced — the
// helper lists them and why no unit test reaches 3000 through them): a loopback
// request to 3000, or to the `CM_PORT` / `MCBD_PORT` the suite was started
// with, or to a port the client's `.env` names (read only), fails as a closed
// port does on CI, unsent. Installed before the ports are removed, so it reads
// them. See tests/helpers/real-server-fence.ts. A refusal is recorded
// (`refusedRealServerRequests`), and a file that calls `keepOffTheRealServer()`
// (tests/helpers/mock-api.ts) fails on one instead of passing by it (#4191).
//
// The hook relay runs `curl`, which the fence does not see, and reads `CM_HOST`
// (nothing in src/ does): a never-resolving host keeps a relay started from the
// suite off `127.0.0.1`. The relay's own tests set `CM_HOST` themselves.
//
// The rest are removed, as CI has them: a real token is a credential for the
// real server, and the HTTPS pair names real files and turns the CLI's URL into
// `https://` (`resolveServerEndpoint`).
installRealServerFence(
  process.env,
  [join(process.cwd(), '.env'), join(homedir(), '.commandmate', '.env')],
  () => {
    const state = expect.getState();
    return [state.testPath, state.currentTestName].filter(Boolean).join(' > ');
  }
);
process.env.CM_HOST = TEST_HOOK_HOST;
delete process.env.CM_PORT;
delete process.env.MCBD_PORT;
delete process.env.CM_AUTH_TOKEN;
delete process.env.CM_HTTPS_CERT;
delete process.env.CM_HTTPS_KEY;

// Issue #4191: the push keys, as CI has them (unset). A worker's pane inherits
// the running server's `CM_VAPID_PRIVATE_KEY` — a credential — and a test that
// read `getVapidConfig()` without setting the keys itself would sign with it.
// The VAPID tests set and restore their own values.
delete process.env.CM_VAPID_PUBLIC_KEY;
delete process.env.CM_VAPID_PRIVATE_KEY;
delete process.env.CM_VAPID_SUBJECT;

// Issue #4086: keep the suite off the database the calling shell names.
//
// A worker's tmux session, and every verification the server runs, inherit the
// server's `CM_DB_PATH=<production db>`. A test that reached the real
// `getDbInstance()` opened that file, set WAL and ran this checkout's
// migrations on it — on 2026-11-01 the production database went to v63 under a
// v62 server. So this is applied even when the environment already has a value
// (the inherited value is the hazard), and the deprecated aliases
// MCBD_DB_PATH / DATABASE_PATH are removed. With CM_DB_PATH
// always set, the install default (`~/.commandmate/data/cm.db` or
// `<cwd>/data/cm.db`) is never reached either. Scoped by worker pid like
// CM_OPENCODE_PORT_FILE, and by VITEST_POOL_ID because `--pool=threads` runs
// every worker in one pid: two workers migrating — or one deleting — one file
// is the collision.
// A test that stubs CM_DB_PATH or mocks getEnv still wins (it runs later), and
// getDbInstance() refuses any non-temp path under Vitest as a backstop.
// Covers only the Vitest suite, not the other steps of `commandmate verify`.
const testDatabase = isolateTestDatabaseEnv(process.env);

// Mock next-intl for all component tests
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, params?: Record<string, string | number>) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (params) {
        return Object.entries(params).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          fullKey
        );
      }
      return fullKey;
    };
  },
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// グローバルなテスト設定

beforeAll(() => {
  // テスト開始時の初期化処理

  // Polyfill ResizeObserver for jsdom (Issue #1080). Radix primitives such as
  // ui/Switch measure their thumb via `useSize` (ResizeObserver) in a layout
  // effect. AutoYesToggle now renders a Radix Switch, so any tree that mounts it
  // (worktree detail, composer meta row) would otherwise throw
  // "ResizeObserver is not defined". Global + benign (jsdom has no native impl).
  if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }

  // Mock Element.scrollTo for jsdom (only in browser-like environments)
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function(options?: ScrollToOptions | number) {
      if (typeof options === 'object') {
        this.scrollTop = options.top ?? 0;
        this.scrollLeft = options.left ?? 0;
      }
    };
  }

  // Polyfill window.matchMedia for jsdom (Issue #1069). jsdom does not
  // implement it, so hooks that switched from window.innerWidth to matchMedia
  // (e.g. useIsMobile) would throw. This lightweight stub evaluates the
  // min-/max-width bounds of a query against window.innerWidth and re-evaluates
  // on window `resize`, translating each crossing into a `change` event — so
  // component tests that drive layout by mutating innerWidth + dispatching
  // `resize` keep working without per-file matchMedia mocks.
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    const evaluate = (query: string): boolean => {
      // Issue #1519: orientation queries (useIsPortrait) resolve from the
      // viewport aspect ratio, mirroring how browsers answer them.
      const orientationMatch = query.match(/orientation:\s*(portrait|landscape)/);
      if (orientationMatch) {
        const portrait = window.innerHeight >= window.innerWidth;
        return orientationMatch[1] === 'portrait' ? portrait : !portrait;
      }
      const maxMatch = query.match(/max-width:\s*(\d+(?:\.\d+)?)px/);
      const minMatch = query.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
      const width = window.innerWidth;
      if (maxMatch && width > Number(maxMatch[1])) return false;
      if (minMatch && width < Number(minMatch[1])) return false;
      return Boolean(maxMatch || minMatch);
    };

    window.matchMedia = (query: string): MediaQueryList => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      let matches = evaluate(query);
      const onResize = () => {
        const next = evaluate(query);
        if (next !== matches) {
          matches = next;
          const event = { matches, media: query } as MediaQueryListEvent;
          listeners.forEach((listener) => listener(event));
        }
      };
      window.addEventListener('resize', onResize);

      return {
        media: query,
        get matches() {
          return matches;
        },
        onchange: null,
        addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (type === 'change') listeners.add(listener);
        },
        removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (type === 'change') listeners.delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    };
  }
});

afterEach(() => {
  // 各テスト後のクリーンアップ
});

afterAll(() => {
  // すべてのテスト終了後のクリーンアップ

  // Issue #4086: close what this file left open on the temp database and
  // remove it, so the next file in this worker starts from a fresh schema and
  // nothing is left under the temp dir. Runs after the file's own afterAll
  // hooks (stack order), so a file that closes its connection itself is fine.
  closeOpenTestDatabases();
  removeTestDatabaseDir(testDatabase.dir);
});
