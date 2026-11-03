/**
 * Issue #2053 — the ruling that opencode's `configScope` stays `'none'`.
 *
 * ## What this pins, and why a *rejection* gets a test file
 *
 * §3.3 of `docs/design/agent-event-source-interface.md` says the I/F rulings are
 * pinned "採る／採らないの両方" so the same proposal does not arrive a third time.
 * #2053 is one of those: it proposed handing opencode a `permission` `deny`
 * through `OPENCODE_CONFIG_CONTENT` (an inline JSON config — no file is written)
 * so the `permission.asked` round-trip never happens, and it was **measured and
 * rejected** (§3.4 of the same document; measurements in
 * `docs/design/opencode-server-live-verification.md` §26).
 *
 * The rejection is not "it does not work". It works: measured on opencode
 * 1.18.22, an injected `deny` took `permission.asked` from 1 to 0 and let the
 * turn finish on `session.idle` instead of blocking with no timeout. It is
 * rejected because inline config is the **top** of a five-layer precedence chain
 * and therefore silently outranks the operator's own `permission` rules — a
 * string `permission.bash: "ask"` is replaced wholesale by an injected object
 * (every unnamed command silently downgraded to the built-in `allow`), and
 * within a merged object rule order beats pattern specificity.
 *
 * ## Anti-vacuity
 *
 * A guard that scans nothing passes forever. The static scan below asserts it
 * actually reached the two files that are *supposed* to mention the mechanism,
 * and that they mention it — so "zero code uses" can never be produced by a
 * broken walk. The behavioural assertions cover all three `prepareLaunch`
 * branches rather than the happy one, because the branch an adopter would most
 * plausibly forget is the bare one.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

// Same stub set as `opencode.test.ts`: this file must never open a socket, and
// `vi.mock` is the only form that reaches the direct named imports `source.ts`
// and `ports.ts` hold.
vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodeHealth: vi.fn().mockResolvedValue({ healthy: true, version: '1.18.22' }),
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeActivity: vi.fn().mockResolvedValue(null),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
    openOpencodeEventStream: vi.fn(),
  };
});

import { OPENCODE_CLI_TOOL_ID, renderAgentLaunchCommand } from '@/lib/hooks/sources';
import {
  opencodeAgentEventSource,
  prepareOpencodeLaunch,
} from '@/lib/hooks/sources/opencode/source';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';

import { buildRoleLaunchArguments } from '@/lib/agent-roles/adapters';
import { fixedEnvReader, loadRoleComposition, RoleCompositionError } from '@/lib/agent-roles/composition';

const REF = {
  worktreeId: 'wt-oc-2053',
  cliToolId: OPENCODE_CLI_TOOL_ID,
  instanceId: 'opencode',
} as const;

const LAUNCH = { target: REF, executablePath: 'opencode', worktreePath: '/tmp/wt-2053' };

/** The env var #2053 measured and declined to use. */
const REJECTED_ENV = 'OPENCODE_CONFIG_CONTENT';

let sandbox: string;


/**
 * The port `renderAgentLaunchCommand` states on every launch line since #2403.
 *
 * A pane inherits whichever `CM_PORT` the tmux server's global environment
 * carries — the port of whatever CommandMate started that tmux server — so the
 * launching server pins its own, and a `commandmate` typed inside the agent
 * resolves to the server that launched it. Fixed here so the byte-pins below do
 * not depend on the `CM_PORT` of the machine running the tests.
 */
const SERVER_PORT = '60301';
const PORT_ASSIGNMENT = `CM_PORT='${SERVER_PORT}'`;

beforeAll(() => {
  sandbox = makeTempDir('opencode-config-scope-2053-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodePortAssignments();
  // Never the real path: the default lives in the operator's home directory,
  // and a test that allocated a port would write into it.
  vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  vi.stubEnv('CM_PORT', SERVER_PORT);
});

describe('[#2053] the ruling: opencode declares `configScope: "none"`', () => {
  it('still declares `none`, which is the whole ruling in one value', () => {
    // Flipping this is the change #2053 evaluated. §3.4 says what has to be
    // re-measured before it may move, and the module doc of
    // `sources/opencode/source.ts` repeats it at the declaration site.
    expect(opencodeAgentEventSource.capabilities.configScope).toBe('none');
  });

  it('keeps `blocks` as the abstain semantics, which is what made the proposal tempting', () => {
    // The proposal only mattered because abstaining here costs the session
    // rather than a dialog (#1758 §5.5.3, 10m19s with no timeout). If this ever
    // becomes `proceeds`, §3.4's cost/benefit has to be re-read, not assumed.
    expect(opencodeAgentEventSource.noDecision).toEqual({ kind: 'blocks' });
  });
});

describe('[#2053] the launch plan declares no configuration environment', () => {
  it('declares nothing at all when a port was assigned', () => {
    rememberOpencodePort(REF, 4731, '/tmp/wt-2053');
    const plan = prepareOpencodeLaunch(LAUNCH);
    expect(plan.settingsPath).toBeNull();
    expect(plan.env).toEqual({});
    expect(Object.keys(plan.env)).not.toContain(REJECTED_ENV);
    expect(plan.command).not.toContain(REJECTED_ENV);
  });

  it('declares nothing when hook injection is off', () => {
    // The rollback branch. An adopter who wires the env var into the `--port`
    // branch only would leave this one correct by accident, so it is asserted
    // rather than assumed.
    rememberOpencodePort(REF, 4731, '/tmp/wt-2053');
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    const plan = prepareOpencodeLaunch(LAUNCH);
    expect(plan).toEqual({ command: 'opencode', settingsPath: null, env: {} });
  });

  it('declares nothing when no port could be allocated', () => {
    const plan = prepareOpencodeLaunch(LAUNCH);
    expect(plan).toEqual({ command: 'opencode', settingsPath: null, env: {} });
  });

  it('renders to a command line that carries no configuration assignment', () => {
    // `renderAgentLaunchCommand` is the single place `env` becomes a shell
    // assignment (#1846). If the plan ever grew the variable, this is where it
    // would surface on the line CommandMate types into the pane.
    rememberOpencodePort(REF, 4731, '/tmp/wt-2053');
    const line = renderAgentLaunchCommand(prepareOpencodeLaunch(LAUNCH));
    // The only assignment is #2403's server port — which is not configuration,
    // it is which CommandMate the agent belongs to.
    expect(line).toBe(`${PORT_ASSIGNMENT} 'opencode' --port 4731 --hostname 127.0.0.1`);
    expect(line).not.toContain('OPENCODE_CONFIG');
  });
});

// ---------------------------------------------------------------------------
// Static scan: the mechanism is documented, never used
// ---------------------------------------------------------------------------

const SRC_ROOT = join(process.cwd(), 'src');

/** Files that are *expected* to name the mechanism, in prose. */
const DOCUMENTING_FILES = [
  'lib/cli-tools/opencode-config.ts',
  'lib/hooks/sources/opencode/source.ts',
] as const;

/**
 * The only files whose code may name the mechanism, exactly.
 *
 * #2053's ruling is about Auto-Yes: a `permission` injected here would silently
 * outrank the operator's own rules. A role is another matter, measured separately
 * (#4113, `docs/design/agent-roles-adapters.md` §6–§7): it adds `instructions` (V1)
 * or `agents.<effective>.system` (V2) and nothing that decides permissions, and it
 * is applied outside every source's `prepareLaunch`. So this narrows the ruling to
 * those four files and leaves it whole everywhere else, `hooks/sources/**` included.
 */
const ROLE_ADAPTER_FILES = [
  'lib/agent-roles/adapters.ts',
  'lib/agent-roles/composition.ts',
  'lib/agent-roles/explicit-launch.ts',
  'lib/session/role-launch.ts',
] as const;

function normalized(file: string): string {
  return file.split(/[\\/]/).join('/');
}

interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    // `statSync` rather than `withFileTypes`: a symlinked directory should be
    // walked the same as a real one, and the tree is small.
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read as `latin1`, not `utf8`.
 *
 * A file holding a NUL byte is skipped by a plain `grep` (it reports "binary
 * file matches" and prints nothing), which is how a guard can silently stop
 * seeing a whole file. Decoding every byte removes that failure mode; the guard
 * only ever compares ASCII substrings, so the mojibake does not matter.
 */
function scan(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of walk(SRC_ROOT, [])) {
    const text = readFileSync(file, 'latin1');
    if (!text.includes(REJECTED_ENV)) continue;
    text.split('\n').forEach((line, i) => {
      if (line.includes(REJECTED_ENV)) {
        found.push({ file: relative(SRC_ROOT, file), line: i + 1, text: line.trim() });
      }
    });
  }
  return found;
}

/** A line that is prose rather than code. */
function isCommentLine(text: string): boolean {
  return text.startsWith('*') || text.startsWith('//') || text.startsWith('/*');
}

describe('[#2053] `OPENCODE_CONFIG_CONTENT` is documented in src/, never used', () => {
  const occurrences = scan();

  it('reached the files that are supposed to mention it (anti-vacuity)', () => {
    // Without this, a walk that returned zero files would make every assertion
    // below pass for the wrong reason.
    const files = occurrences.map((o) => o.file.split(/[\\/]/).join('/'));
    for (const expected of DOCUMENTING_FILES) {
      expect(files).toContain(expected);
    }
  });

  it('names it only in comments — no code path passes it to a child process', () => {
    // Everywhere but the role adapter, which the next two tests hold to its own terms.
    const code = occurrences.filter(
      (o) => !isCommentLine(o.text) && !(ROLE_ADAPTER_FILES as readonly string[]).includes(normalized(o.file))
    );
    expect(
      code.map((o) => `${o.file}:${o.line} ${o.text}`),
      'OPENCODE_CONFIG_CONTENT is for roles only (lib/agent-roles, lib/session/role-launch). ' +
        'To use it for anything other than a role, read ' +
        'docs/design/agent-event-source-interface.md §3.4 first: #2053 measured and rejected it.'
    ).toEqual([]);
  });

  it('the role adapter is exactly these four files', () => {
    const files = new Set(occurrences.filter((o) => !isCommentLine(o.text)).map((o) => normalized(o.file)));
    expect([...files].sort()).toEqual([...ROLE_ADAPTER_FILES].sort());
  });

  it('no code under hooks/sources names it: a launch plan still declares nothing', () => {
    const inSources = occurrences.filter(
      (o) => normalized(o.file).startsWith('lib/hooks/sources/') && !isCommentLine(o.text)
    );
    expect(inSources).toEqual([]);
  });
});

describe('[#2053] what a role may add through it', () => {
  const artifact = { name: 'cm-role-x', path: '/data/cm-role-x.md' };
  const AUTO_YES_AND_ROUTING_KEYS = ['permission', 'model', 'provider', 'providers', 'default_agent'];

  it('V1: `instructions`, and with nothing of the user\'s that is the only key', () => {
    const { env } = buildRoleLaunchArguments({ adapter: 'opencode', effectiveAgent: null }, artifact, {});
    expect(Object.keys(JSON.parse(env[REJECTED_ENV]))).toEqual(['instructions']);
  });

  it('V2: `agents.<effective>.system`, and with nothing of the user\'s that is the only key', () => {
    const { env } = buildRoleLaunchArguments({ adapter: 'opencode-v2', effectiveAgent: 'build' }, artifact, {});
    const value = JSON.parse(env[REJECTED_ENV]);
    expect(Object.keys(value)).toEqual(['agents']);
    expect(Object.keys(value.agents)).toEqual(['build']);
    expect(Object.keys(value.agents.build)).toEqual(['system']);
  });

  it.each(AUTO_YES_AND_ROUTING_KEYS)('adds no `%s`, and leaves the user\'s value of it alone', (key) => {
    for (const adapter of ['opencode', 'opencode-v2'] as const) {
      const bare = JSON.parse(buildRoleLaunchArguments({ adapter, effectiveAgent: 'build' }, artifact, {}).env[REJECTED_ENV]);
      expect(bare).not.toHaveProperty(key);
      const user = { [key]: 'THE_USERS' };
      const composed = JSON.parse(
        buildRoleLaunchArguments({ adapter, effectiveAgent: 'build' }, artifact, { opencodeUserContent: user }).env[REJECTED_ENV]
      );
      expect(composed[key]).toBe('THE_USERS');
    }
  });

  it.each(['opencode', 'opencode-v2'] as const)('%s: a broken value of the user\'s is refused, so no child process gets it', async (adapter) => {
    await expect(
      loadRoleComposition(adapter, { worktreePath: sandbox, readEnv: fixedEnvReader({ [REJECTED_ENV]: '{broken' }) })
    ).rejects.toBeInstanceOf(RoleCompositionError);
  });
});

describe('[#2053] the ruling stays readable where the next implementer looks', () => {
  it('keeps §3.4 in the I/F document, naming the mechanism and the verdict', () => {
    const doc = readFileSync(
      join(process.cwd(), 'docs/design/agent-event-source-interface.md'),
      'utf8'
    );
    expect(doc).toContain('### 3.4');
    expect(doc).toContain(REJECTED_ENV);
    // The verdict word itself. §3.3 records rejections as 不採用, and a ruling
    // that loses its verdict is a paragraph nobody can act on.
    expect(doc).toContain('不採用');
  });

  it('keeps the measurements in the live-verification document', () => {
    const doc = readFileSync(
      join(process.cwd(), 'docs/design/opencode-server-live-verification.md'),
      'utf8'
    );
    expect(doc).toContain('## 26. Issue 2053');
    expect(doc).toContain(REJECTED_ENV);
  });
});
