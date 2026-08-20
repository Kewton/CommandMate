/**
 * opencode's `AgentEventSource` (Issue #1763, Epic #1720 Phase 4-5).
 *
 * Every input below is a frame that was actually captured from `opencode`
 * 1.18.3 — the files in `tests/fixtures/hooks/opencode/`, collected by the
 * #1758 spike. Nothing here is a payload shaped from documentation, because
 * the server's own OpenAPI document is provably incomplete: `server.heartbeat`
 * is absent from its `Event` union and arrives every ten seconds.
 *
 * The risk this file is written against is that the integration is *inert* —
 * present, green, and never actually consulted. So the assertions are aimed at
 * the specific ways that could be true: the registry really answers `opencode`,
 * the launch command really carries the port, the abstain semantics really say
 * `blocks`, and the three-valued reply really reaches the wire.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

// The HTTP surface is stubbed wholesale rather than spied on: these tests must
// never open a socket, and `vi.mock` is the only form that reaches the direct
// named imports `source.ts` and `ports.ts` hold.
vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodeHealth: vi.fn().mockResolvedValue({ healthy: true, version: '1.18.3' }),
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeActivity: vi.fn().mockResolvedValue(null),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
    readOpencodeEventStream: vi.fn(),
  };
});

import {
  describeAbstain,
  getAgentEventSource,
  getUnknownEventTally,
  hasAgentEventSource,
  isAbstainSafe,
  OPENCODE_CLI_TOOL_ID,
  renderAgentLaunchCommand,
  resetUnknownEventTallies,
  type PendingDecision,
  type Verdict,
} from '@/lib/hooks/sources';
import {
  opencodeAgentEventSource,
  prepareOpencodeLaunch,
  toOpencodePermissionReply,
} from '@/lib/hooks/sources/opencode/source';
import {
  parseOpencodePermissionRequest,
  parseOpencodeQuestion,
  rememberOpencodeToolCall,
  resetOpencodeToolCalls,
} from '@/lib/hooks/sources/opencode/payloads';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import {
  fetchOpencodeActivity,
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  replyOpencodePermission,
  replyOpencodeQuestion,
} from '@/lib/hooks/sources/opencode/client';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

/** One captured SSE frame: `{ id, type, properties }`. */
function frame(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const REF = {
  worktreeId: 'wt-oc',
  cliToolId: OPENCODE_CLI_TOOL_ID,
  instanceId: 'opencode',
} as const;

let sandbox: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-source-');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetUnknownEventTallies();
  resetOpencodeToolCalls();
  resetOpencodePortAssignments();
  // Never the real path: the default lives in the operator's home directory,
  // and a test that allocated a port would write into it.
  vi.stubEnv('CM_OPENCODE_PORT_FILE', join(sandbox, 'opencode-ports.json'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOpencodePortAssignments();
});

describe('registration', () => {
  it('is the registered source for opencode, and it is a pull source', () => {
    // Mutation target: deleting `registerAgentEventSource(opencodeAgentEventSource)`
    // from registry.ts drops the tool back to the legacy relay, which is a
    // *push* source that reads Claude's spellings. Nothing would throw.
    expect(hasAgentEventSource(OPENCODE_CLI_TOOL_ID)).toBe(true);
    expect(getAgentEventSource(OPENCODE_CLI_TOOL_ID)).toBe(opencodeAgentEventSource);
    expect(getAgentEventSource(OPENCODE_CLI_TOOL_ID).transport).toBe('pull');
  });

  it('leaves a tool with no source on the compatibility relay', () => {
    // Named deliberately: `vibe-local` has no Phase 4 Issue, so it stays
    // unregistered no matter which of the four branches lands.
    expect(hasAgentEventSource('vibe-local')).toBe(false);
    expect(getAgentEventSource('vibe-local').transport).toBe('push');
  });
});

describe('declared behaviour', () => {
  it('says abstaining blocks the agent, with no timeout', () => {
    // #1758 §5.5.3: an approval left unanswered for 10m19s was still pending.
    // Mutation target: `{ kind: 'proceeds' }` here would make Auto-Yes's
    // "when in doubt, say nothing" rule silently stop opencode sessions.
    expect(opencodeAgentEventSource.noDecision).toEqual({ kind: 'blocks' });
    expect(isAbstainSafe(opencodeAgentEventSource)).toBe(false);
    expect(describeAbstain(opencodeAgentEventSource)).toEqual({
      safe: false,
      blocksForMs: null,
      summary: 'the agent waits indefinitely; nothing else will unblock it',
    });
  });

  it('declares no config and no decision deadline', () => {
    expect(opencodeAgentEventSource.capabilities.configScope).toBe('none');
    // null, not 0 and not a large number: the agent really does wait forever.
    expect(opencodeAgentEventSource.capabilities.decisionTimeoutSeconds).toBeNull();
  });

  it('answers verdicts out of band — there is no response body to write', () => {
    // The event arrived on a stream that has been open for hours and carries no
    // reply channel (C2).
    expect(opencodeAgentEventSource.encodeVerdict({ kind: 'allowOnce' })).toEqual({
      kind: 'outOfBand',
    });
    expect(opencodeAgentEventSource.encodeVerdict({ kind: 'abstain' })).toEqual({
      kind: 'outOfBand',
    });
  });
});

describe('normalizeEvent against captured frames', () => {
  it.each([
    ['session-idle', 'stop', null],
    ['session-created', 'session_start', null],
    ['session-deleted', 'session_end', null],
    ['message-updated-user', 'user_prompt_submit', null],
    ['message-part-updated-tool-running', 'pre_tool_use', 'bash'],
    ['message-part-updated-tool-completed', 'post_tool_use', 'bash'],
    ['message-part-updated-tool-error', 'post_tool_use', 'bash'],
    ['permission-asked', 'notification', 'permission_prompt'],
    ['question-asked', 'notification', 'question_prompt'],
    ['session-error', 'notification', 'error'],
  ])('maps %s to %s', (name, event, detail) => {
    const normalized = opencodeAgentEventSource.normalizeEvent({ payload: frame(name) });
    expect(normalized?.event).toBe(event);
    expect(normalized?.detail).toBe(detail);
  });

  it('carries sessionID out of the nested envelope as conversationId', () => {
    // `conversationIdFields` reads flat keys and cannot reach
    // `properties.sessionID`, so the rules fill it in (C5).
    const normalized = opencodeAgentEventSource.normalizeEvent({ payload: frame('session-idle') });
    expect(normalized?.conversationId).toBe('ses_0000000000000000000000000');
  });

  it('splits one event name into two words by part.state.status', () => {
    // The thing a `Record<string, AgentEventType>` cannot express (C4). All
    // three frames below are `message.part.updated`.
    const running = opencodeAgentEventSource.normalizeEvent({
      payload: frame('message-part-updated-tool-running'),
    });
    const pending = opencodeAgentEventSource.normalizeEvent({
      payload: frame('message-part-updated-tool-pending'),
    });
    expect(running?.event).toBe('pre_tool_use');
    expect(running?.toolCallId).toBe('toolu_0000000000000000000000000');
    // `pending` is the frame immediately before `running`; mapping it as well
    // would report every tool call twice.
    expect(pending).toBeNull();
  });

  it('spells the approval notification the way agent-event-state reads it', () => {
    // `applyPromptWaitingTransition` opens its record on exactly this string.
    // Renaming it for opencode would leave `wait --on-prompt` unable to see an
    // opencode approval dialog, with nothing failing anywhere (#1758 §9.3).
    expect(
      opencodeAgentEventSource.normalizeEvent({ payload: frame('permission-asked') })?.detail
    ).toBe('permission_prompt');
  });

  it('drops unknown frames, counts them, and never throws', () => {
    // `server.heartbeat` is not in the server's own OpenAPI Event union and
    // arrives every ten seconds; a reader that threw would fail six times a
    // minute on a perfectly healthy connection (C8).
    for (const name of [
      'server-heartbeat',
      'server-connected',
      'session-status-busy',
      'session-status-idle',
      'permission-replied',
      'question-replied',
    ]) {
      expect(() => opencodeAgentEventSource.normalizeEvent({ payload: frame(name) })).not.toThrow();
      expect(opencodeAgentEventSource.normalizeEvent({ payload: frame(name) })).toBeNull();
    }
    expect(getUnknownEventTally(OPENCODE_CLI_TOOL_ID).names).toEqual([
      'server.heartbeat',
      'server.connected',
      'session.status',
      'permission.replied',
      'question.replied',
    ]);
  });

  it('does not map session.status(idle), which is the same signal as session.idle', () => {
    // Emitted in the same millisecond as `session.idle` (#1758 §5.3.2 rule 4).
    // Mapping both would report every turn's completion twice.
    expect(
      opencodeAgentEventSource.normalizeEvent({ payload: frame('session-status-idle') })
    ).toBeNull();
  });
});

describe('parsePermissionRequest', () => {
  it('reads a permission.asked frame into the shared payload shape', () => {
    const payload = parseOpencodePermissionRequest(frame('permission-asked'));
    expect(payload).not.toBeNull();
    expect(payload?.promptId).toBe('per_0000000000000000000000000');
    expect(payload?.sessionId).toBe('ses_0000000000000000000000000');
    // The command is what a deny pattern has to be able to match.
    expect(JSON.stringify(payload?.toolInput)).toContain('touch /tmp/cmate-oc-spike-marker.txt');
  });

  it('names the tool from the callID correlation when it has one', () => {
    // `permission.asked` carries no tool name at all (#1758 §5.4); the
    // `message.part.updated` frame for the same callID does.
    rememberOpencodeToolCall('toolu_0000000000000000000000000', 'bash');
    expect(parseOpencodePermissionRequest(frame('permission-asked'))?.toolName).toBe('bash');
  });

  it('falls back to the approval kind when the tool call was never seen', () => {
    // An unknown name makes `collectToolInputMatchTexts` serialise the whole
    // input, which still contains the command — over-matching costs a dialog,
    // under-matching costs the protection a contract asked for.
    expect(parseOpencodePermissionRequest(frame('permission-asked'))?.toolName).toBe(
      'external_directory'
    );
  });

  it('accepts the bare object GET /permission returns, not only the SSE frame', () => {
    // The reconnect path re-reads pending approvals as plain objects; both
    // arrival routes must go through one parser.
    const properties = (frame('permission-asked') as { properties: Record<string, unknown> })
      .properties;
    expect(parseOpencodePermissionRequest(properties)?.promptId).toBe(
      'per_0000000000000000000000000'
    );
  });

  it('refuses a question frame', () => {
    expect(parseOpencodePermissionRequest(frame('question-asked'))).toBeNull();
  });
});

describe('parseQuestion', () => {
  it('reads the structured choices opencode publishes', () => {
    // The one place opencode is better structured than Claude: its picker's
    // options arrive as data rather than having to be read off the screen.
    const spec = parseOpencodeQuestion(frame('question-asked'));
    expect(spec?.promptId).toBe('que_0000000000000000000000000');
    expect(spec?.questions).toHaveLength(1);
    expect(spec?.questions[0].question).toBe('Which colour do you prefer?');
    expect(spec?.questions[0].choices.map((choice) => choice.label)).toEqual(['Red', 'Blue']);
  });

  it('refuses an approval frame', () => {
    expect(parseOpencodeQuestion(frame('permission-asked'))).toBeNull();
  });
});

describe('decide', () => {
  const permission: PendingDecision = {
    kind: 'permission',
    id: 'per_0000000000000000000000000',
    conversationId: 'ses_0000000000000000000000000',
    subject: { kind: 'permission', toolName: 'bash', toolInput: {} },
    raw: {},
    askedAt: 0,
  };

  it('POSTs the three-valued reply to the agent server', async () => {
    const reply = vi.mocked(replyOpencodePermission);
    rememberOpencodePort(REF, 4242, '/tmp/wt');

    await opencodeAgentEventSource.decide(REF, permission, { kind: 'allowOnce' });
    await opencodeAgentEventSource.decide(REF, permission, { kind: 'allowAlways' });
    await opencodeAgentEventSource.decide(REF, permission, {
      kind: 'deny',
      message: 'blocked by CommandMate',
    });

    expect(reply.mock.calls.map((call) => call[2])).toEqual(['once', 'always', 'reject']);
    // The rejection reason reaches the agent verbatim — measured in the tool
    // part's `state.error` (#1758 §5.5.2). Only this endpoint can carry it.
    expect(reply.mock.calls[2][3]).toBe('blocked by CommandMate');
    expect(reply.mock.calls[0][0]).toBe(4242);
  });

  it('sends nothing at all when it abstains', async () => {
    // The whole reason `noDecision` is `blocks`: there is no wire value for
    // "no opinion", so abstaining is the absence of a request. What it costs is
    // an agent that waits forever, which is why the source logs it.
    rememberOpencodePort(REF, 4242, '/tmp/wt');

    await opencodeAgentEventSource.decide(REF, permission, { kind: 'abstain' });

    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('answers a question over its own endpoint', async () => {
    rememberOpencodePort(REF, 4242, '/tmp/wt');

    await opencodeAgentEventSource.decide(
      REF,
      {
        kind: 'question',
        id: 'que_0000000000000000000000000',
        conversationId: 'ses_0000000000000000000000000',
        subject: { kind: 'question', spec: { questions: [], promptId: null } },
        raw: {},
        askedAt: 0,
      },
      { kind: 'answer', answers: [['Blue']] }
    );

    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenCalledWith(
      4242,
      'que_0000000000000000000000000',
      [['Blue']]
    );
  });

  it('does nothing when no port is assigned', async () => {
    await opencodeAgentEventSource.decide(REF, permission, { kind: 'allowOnce' });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it.each<[Verdict, string | null]>([
    [{ kind: 'allowOnce' }, 'once'],
    [{ kind: 'allowAlways' }, 'always'],
    [{ kind: 'deny' }, 'reject'],
    [{ kind: 'answer', answers: [] }, null],
    [{ kind: 'abstain' }, null],
  ])('maps the $kind verdict onto the wire value', (verdict, expected) => {
    expect(toOpencodePermissionReply(verdict)).toBe(expected);
  });
});

describe('prepareLaunch', () => {
  const LAUNCH = { target: REF, executablePath: 'opencode', worktreePath: '/tmp/wt' };

  it('adds --port and pins the hostname to loopback', () => {
    rememberOpencodePort(REF, 4242, '/tmp/wt');
    // `--hostname` is passed explicitly because the default *is* the security
    // property: the server is unauthenticated (#1758 §5.8).
    expect(prepareOpencodeLaunch(LAUNCH)).toEqual({
      command: `'opencode' --port 4242 --hostname 127.0.0.1`,
      // Nothing is written to disk for this tool at all.
      settingsPath: null,
      // #1846: and no environment either. opencode is the one source that needs
      // no correlation variable, because CommandMate holds the connection.
      env: {},
    });
  });

  it('returns the bare command when CM_AGENT_HOOKS_INJECT=0', () => {
    // The rollback: structured events off puts the launch back on the exact
    // pre-#1763 command, and the scraper decides as it always did.
    rememberOpencodePort(REF, 4242, '/tmp/wt');
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    expect(prepareOpencodeLaunch(LAUNCH)).toEqual({
      command: 'opencode',
      settingsPath: null,
      env: {},
    });
  });

  it('returns the bare command when no port could be allocated', () => {
    // Port exhaustion is not a launch failure. The pane starts either way.
    expect(prepareOpencodeLaunch(LAUNCH)).toEqual({
      command: 'opencode',
      settingsPath: null,
      env: {},
    });
  });

  it('renders to the bare command line, because there is nothing to prefix', () => {
    // The #1846 renderer is the only thing that turns a plan into a line, and
    // an empty `env` has to leave the command byte-identical — otherwise every
    // source without correlation variables would grow a leading space.
    rememberOpencodePort(REF, 4242, '/tmp/wt');
    expect(renderAgentLaunchCommand(prepareOpencodeLaunch(LAUNCH))).toBe(
      `'opencode' --port 4242 --hostname 127.0.0.1`
    );
  });
});

describe('listPending / probeActivity', () => {
  it('re-reads approvals and questions from the server', async () => {
    rememberOpencodePort(REF, 4242, '/tmp/wt');
    const permissionProps = (frame('permission-asked') as { properties: Record<string, unknown> })
      .properties;
    const questionProps = (frame('question-asked') as { properties: Record<string, unknown> })
      .properties;
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([permissionProps]);
    vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([questionProps]);

    const pending = await opencodeAgentEventSource.listPending(REF);

    expect(pending.map((entry) => [entry.kind, entry.id])).toEqual([
      ['permission', 'per_0000000000000000000000000'],
      ['question', 'que_0000000000000000000000000'],
    ]);
  });

  it('answers busy/idle from GET /session/status', async () => {
    rememberOpencodePort(REF, 4242, '/tmp/wt');
    vi.mocked(fetchOpencodeActivity).mockResolvedValue('busy');
    expect(await opencodeAgentEventSource.probeActivity(REF)).toBe('busy');
  });

  it('answers null when there is no server to ask', async () => {
    expect(await opencodeAgentEventSource.probeActivity(REF)).toBeNull();
    expect(await opencodeAgentEventSource.listPending(REF)).toEqual([]);
  });
});
