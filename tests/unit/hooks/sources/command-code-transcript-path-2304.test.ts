/**
 * The hook payload is where Command Code's transcript path comes from
 * (Issue #2304, Epic #2249).
 *
 * #2251 shipped the reader (`readCommandCodeTranscriptPath`) and #2252 shipped
 * the consumer (`acceptCommandCodeTranscriptHint` → `locateCommandCodeTranscript`),
 * and each was tested against its own half. Nothing joined them, so "the slug
 * resolution uses the hook's `transcript_path` and does not depend on computing
 * anything from `cwd`" was a property the code had and no test stated. This file
 * states it, end to end, against payloads captured live.
 *
 * ## Provenance
 *
 * `tests/fixtures/transcripts/command-code/hook-payloads-1490.json` is the four
 * payloads a real session delivered on **Command Code 1.49.0**, 2026-09-04, over
 * an isolated `HOME` with `~/.commandcode/settings.json` registering one command
 * hook per event. `hook-session-1490.jsonl` is the transcript that session wrote,
 * at the path those payloads name. Redacted the way the capture directories'
 * READMEs describe — the probe `HOME` became `/private/tmp/cc2304-home`, the cwd
 * `/private/tmp/cc2304-probe/MyCodeBranchDesk/probe`, and the project directory
 * name was re-derived so the pair stays a coherent statement. Every other byte,
 * including the session id and the slug's *shape*, is what the tool sent.
 *
 * ## The one thing worth measuring twice
 *
 * `cwd` is on every payload, so a reader *could* try to compute the directory
 * name from it — and that is the mistake Epic #2249 決定 4 forbids. The
 * assertions below do not just say the reader "uses the hint"; they put a
 * **decoy** directory on disk, named exactly what claude's rule would have
 * produced for the same `cwd`, holding the same session id and a different body,
 * with a newer mtime so it also wins the scan's newest-first order. A reader
 * that computed the slug, and a reader that only scanned, both write the decoy's
 * body. Only one that follows the hook's own path writes the right one.
 *
 * @vitest-environment node
 */

import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getLastAgentEvent = vi.fn<(...a: unknown[]) => { sessionId: string | null } | null>();
vi.mock('@/lib/session/agent-event-state', () => ({
  getLastAgentEvent: (...a: unknown[]) => getLastAgentEvent(...a),
}));

/** A stand-in for `chat_messages`, keyed the way the real table's index is. */
const rows = new Map<string, Record<string, unknown>>();
function defaultCreateMessage(_db: unknown, message: Record<string, unknown>) {
  const saved = { id: `msg-${rows.size + 1}`, ...message };
  rows.set(`${String(message.worktreeId)}::${String(message.requestId)}`, saved);
  return saved;
}
const createMessage = vi.fn(defaultCreateMessage);
const findMessageByRequestId = vi.fn(
  (_db: unknown, worktreeId: string, requestId: string) =>
    rows.get(`${worktreeId}::${requestId}`) ?? null
);
const updateMessageContent = vi.fn();
const findUnkeyedUserMessages = vi.fn(() => [] as Array<Record<string, unknown>>);
const setMessageRequestId = vi.fn(() => true);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  updateMessageContent: (...a: [unknown, string, string]) => updateMessageContent(...a),
}));
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
  findUnkeyedUserMessages: () => findUnkeyedUserMessages(),
  setMessageRequestId: () => setMessageRequestId(),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import {
  acceptCommandCodeTranscriptHint,
  captureCommandCodeTranscriptTurn,
  commandCodeProjectsRoot,
  findCommandCodeTranscriptPath,
  resetCommandCodeTranscriptSessions,
  resolveCommandCodeTranscriptPath,
  type CommandCodeTranscriptCapture,
} from '@/lib/hooks/sources/command-code/history';
import {
  COMMAND_CODE_HOOK_EVENT_NAMES,
  COMMAND_CODE_TRANSCRIPT_PATH_FIELDS,
  readCommandCodeTranscriptPath,
} from '@/lib/hooks/sources/command-code/source';
import {
  buildCommandCodeTurns,
  parseCommandCodeTranscript,
  renderCommandCodeTurn,
} from '@/lib/hooks/sources/command-code/transcript';
import { claudeProjectSlug } from '@/lib/hooks/sources/claude/transcript';

const FIXTURES = join(process.cwd(), 'tests/fixtures/transcripts/command-code');

/** One captured hook delivery. */
interface CapturedDelivery {
  observed_at: string;
  event: string;
  payload: Record<string, unknown>;
}

const DELIVERIES: CapturedDelivery[] = JSON.parse(
  readFileSync(join(FIXTURES, 'hook-payloads-1490.json'), 'utf8')
);
const TRANSCRIPT = readFileSync(join(FIXTURES, 'hook-session-1490.jsonl'), 'utf8');
const TURN_BODY = readFileSync(join(FIXTURES, 'hook-session-1490.turn.md'), 'utf8').replace(
  /\n$/,
  ''
);

/** What the payloads say, read out once so every test below agrees. */
const PAYLOAD_PATH = String(DELIVERIES[0].payload.transcript_path);
const PAYLOAD_CWD = String(DELIVERIES[0].payload.cwd);
const SESSION = String(DELIVERIES[0].payload.session_id);
/** The project directory Command Code actually chose. */
const REAL_SLUG = basename(dirname(PAYLOAD_PATH));
/** What the redacted capture's `HOME` was, so a temp one can stand in for it. */
const FIXTURE_HOME = '/private/tmp/cc2304-home';

const WORKTREE_ID = 'wt-2304';
const TARGET = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'command-code',
  instanceId: 'command-code',
} as const;

let home: string;

/**
 * The hook's own path, re-rooted onto this test's temporary `HOME`.
 *
 * Only the `HOME` prefix is swapped. The project directory name and the file
 * name are the payload's, untouched — which is the whole point: nothing here
 * reconstructs either.
 */
function hintFromPayload(payload: Record<string, unknown>): string {
  const named = readCommandCodeTranscriptPath(payload);
  if (named === null) throw new Error('the captured payload carries no transcript_path');
  return named.replace(FIXTURE_HOME, home);
}

/** Put a file where a project directory would hold it. */
async function place(slug: string, fileName: string, body: string): Promise<string> {
  const dir = join(commandCodeProjectsRoot(home), slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, body, 'utf8');
  return path;
}

/** The transcript, where the hook says it is. */
async function placeRealTranscript(): Promise<string> {
  return place(REAL_SLUG, `${SESSION}.jsonl`, TRANSCRIPT);
}

/**
 * A same-session file under the directory claude's rule would have named, made
 * newer so it also wins `findCommandCodeTranscriptPath`'s newest-first order.
 */
async function placeDecoy(): Promise<string> {
  const decoyTurn = TRANSCRIPT.replace(
    'Created probe2304.txt with the exact content.',
    'DECOY-2304 — the computed slug won'
  );
  const path = await place(claudeProjectSlug(PAYLOAD_CWD), `${SESSION}.jsonl`, decoyTurn);
  const later = new Date(Date.now() + 60_000);
  await utimes(dirname(path), later, later);
  await utimes(path, later, later);
  return path;
}

function savedAssistantBodies(): string[] {
  return createMessage.mock.calls
    .map(([, message]) => message)
    .filter((row) => row.role === 'assistant')
    .map((row) => String(row.content));
}

beforeEach(async () => {
  vi.clearAllMocks();
  rows.clear();
  createMessage.mockImplementation(defaultCreateMessage);
  resetCommandCodeTranscriptSessions();
  home = await mkdtemp(join(tmpdir(), 'cmate-2304-'));
  findUnkeyedUserMessages.mockReturnValue([]);
  // The default for this file: no session pointer at all. The hint has to be
  // sufficient on its own, because the pointer is the *other* route and a test
  // with both cannot say which one answered.
  getLastAgentEvent.mockReturnValue(null);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('[#2304] what the hook actually delivers', () => {
  it('carries transcript_path on all four events, with one value for the session', () => {
    expect(DELIVERIES.map((d) => d.event)).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
    // Every event, not a particular one — which is what lets a receiver latch
    // the value off whichever it sees first (#2251).
    for (const delivery of DELIVERIES) {
      expect(readCommandCodeTranscriptPath(delivery.payload), delivery.event).toBe(PAYLOAD_PATH);
      expect(delivery.payload.session_id, delivery.event).toBe(SESSION);
    }
    expect(new Set(DELIVERIES.map((d) => String(d.payload.transcript_path))).size).toBe(1);
  });

  it('spells the field the way this source reads it, and no other', () => {
    expect([...COMMAND_CODE_TRANSCRIPT_PATH_FIELDS]).toEqual(['transcript_path']);
    for (const delivery of DELIVERIES) {
      expect(Object.keys(delivery.payload)).toContain('transcript_path');
      expect(delivery.payload.hook_event_name).toBe(delivery.event);
      expect(COMMAND_CODE_HOOK_EVENT_NAMES[delivery.event]).toBeTruthy();
    }
  });

  it('fires PreToolUse only after the dialog is answered — still true on 1.49.0', () => {
    // Epic #2249 決定 3 rests on this, and it is the reason Command Code keeps
    // Auto-Yes on the legacy numbered-response path. Measured again while
    // capturing these payloads: with the `Create File` dialog on screen the log
    // held one line (`SessionStart`); answering `1` took it to four. The
    // timestamps are the receipt — `PreToolUse` is 32 seconds after
    // `SessionStart`, i.e. after a human answered, and `PostToolUse` is in the
    // same second as `PreToolUse` rather than after another wait.
    const at = (event: string): number =>
      Date.parse(DELIVERIES.find((d) => d.event === event)!.observed_at);

    expect(at('PreToolUse')).toBeGreaterThan(at('SessionStart'));
    expect(at('PostToolUse') - at('PreToolUse')).toBeLessThan(1_000);
    expect(at('Stop')).toBeGreaterThanOrEqual(at('PostToolUse'));
  });
});

describe('[#2304] the project directory name is not a function of cwd', () => {
  it('differs from what claude`s rule would have produced for the same cwd', () => {
    // The negative that makes every "uses the hint" assertion below mean
    // something. claude's slug is `cwd.replace(/[^a-zA-Z0-9]/g, '-')` and is a
    // pure function of `cwd` — which is exactly why `../claude/history` may
    // compute its path. Command Code's `slugify` also lower-cases and splits
    // camel case, so the two disagree on any cwd with a capital in it.
    const computed = claudeProjectSlug(PAYLOAD_CWD);

    expect(REAL_SLUG).not.toBe(computed);
    // Not merely different — different in the two specific ways measured, so a
    // "close enough" reimplementation cannot pass this by accident.
    expect(PAYLOAD_CWD).toContain('MyCodeBranchDesk');
    expect(computed).toContain('MyCodeBranchDesk');
    expect(REAL_SLUG).toContain('my-code-branch-desk');
    expect(REAL_SLUG).not.toContain('MyCodeBranchDesk');
    expect(computed.startsWith('-')).toBe(true);
    expect(REAL_SLUG.startsWith('-')).toBe(false);
  });

  it('leaves the capture options with nothing a slug could be computed from', () => {
    // The structural half. `ClaudeTranscriptCapture` requires `worktreePath` and
    // documents it as "the slug input"; this one has no path field at all, so
    // the computation Epic #2249 決定 4 forbids is not expressible at the call
    // site. Written as a value of the type so `tsc` is the one enforcing it.
    const capture: CommandCodeTranscriptCapture = {
      transcriptPathHint: PAYLOAD_PATH,
      commandCodeHome: FIXTURE_HOME,
    };
    expect(Object.keys(capture).sort()).toEqual(['commandCodeHome', 'transcriptPathHint']);
  });
});

describe('[#2304] the hint decides, against a decoy that would win otherwise', () => {
  it('writes the turn the hook`s path names, not the computed slug`s', async () => {
    const real = await placeRealTranscript();
    const decoy = await placeDecoy();
    expect(decoy).not.toBe(real);

    const written = await captureCommandCodeTranscriptTurn(TARGET, {
      commandCodeHome: home,
      transcriptPathHint: hintFromPayload(DELIVERIES[3].payload),
    });

    expect(written).toBe(true);
    expect(savedAssistantBodies()).toEqual([TURN_BODY]);
    expect(savedAssistantBodies()[0]).not.toContain('DECOY-2304');
  });

  it('is the hint and not luck: with no hint the decoy is what the scan finds', async () => {
    // The positive control for the test above. Take the hook's answer away and
    // leave the session pointer, and the newest-first directory scan resolves
    // to the decoy — because a scan cannot tell two same-session files apart.
    // In production that pair cannot exist; here it is the only way to show
    // that the assertion above is about the hint rather than about there having
    // been one candidate all along.
    await placeRealTranscript();
    const decoy = await placeDecoy();
    getLastAgentEvent.mockReturnValue({ sessionId: SESSION });

    expect(await resolveCommandCodeTranscriptPath(TARGET, { commandCodeHome: home })).toBe(decoy);
  });

  it('refuses a hint outside its own root even when the payload shape is right', async () => {
    // The hint is a string an agent process chose, and this is the containment
    // that makes trusting it safe. A claude transcript is the realistic case —
    // `transcriptPathHint` is shared with `../claude/history` — so the refusal
    // is checked on a file that really exists and really is a transcript.
    await placeRealTranscript();
    const elsewhere = join(home, '.claude', 'projects', REAL_SLUG);
    await mkdir(elsewhere, { recursive: true });
    const claudeFile = join(elsewhere, `${SESSION}.jsonl`);
    await writeFile(claudeFile, TRANSCRIPT, 'utf8');

    expect(acceptCommandCodeTranscriptHint(home, claudeFile)).toBeNull();
    expect(
      await captureCommandCodeTranscriptTurn(TARGET, {
        commandCodeHome: home,
        transcriptPathHint: claudeFile,
      })
    ).toBe(false);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('accepts the payload`s own path as being inside the root', () => {
    // Stated on the captured value rather than on a constructed one, because
    // the thing worth knowing is that the *tool's* spelling passes the guard —
    // an absolute path, `.jsonl`, under `<home>/.commandcode/projects`.
    const hint = hintFromPayload(DELIVERIES[0].payload);
    expect(acceptCommandCodeTranscriptHint(home, hint)).toBe(hint);
    expect(hint.startsWith(commandCodeProjectsRoot(home))).toBe(true);
  });
});

describe('[#2304] the scan still works, and 1.49.0`s new sibling files do not confuse it', () => {
  /** What 1.49.0 writes next to a transcript. Measured; 1.40.1 wrote neither. */
  const SIBLINGS = ['.meta.json', '.checkpoints.jsonl'] as const;

  it('finds the transcript and not the checkpoints file beside it', async () => {
    const real = await placeRealTranscript();
    await place(REAL_SLUG, `${SESSION}.meta.json`, '{"traceIds":[]}\n');
    await place(
      REAL_SLUG,
      `${SESSION}.checkpoints.jsonl`,
      `${JSON.stringify({ id: SESSION, turnNumber: 1, prompt: 'x', messageCount: 0, files: [] })}\n`
    );

    expect(await findCommandCodeTranscriptPath(home, SESSION)).toBe(real);
    // The scan looks for `<session>.jsonl` exactly, so neither sibling is a
    // candidate — `.meta.json` is the wrong extension and `.checkpoints.jsonl`
    // is the wrong name. Asserted rather than assumed because both are new in
    // 1.49.0 and a `endsWith('.jsonl')` scan would have picked one of them.
    expect(basename(real)).toBe(`${SESSION}.jsonl`);
    for (const suffix of SIBLINGS) {
      expect(basename(real).endsWith(suffix), `matched ${suffix}`).toBe(false);
    }
  });

  it('reads nothing out of the checkpoints file if anything ever points at one', async () => {
    // `.checkpoints.jsonl` passes `acceptCommandCodeTranscriptHint` — it is
    // absolute, it is under the root and it ends in `.jsonl` — so the guard is
    // not what keeps it out. This is: its rows carry no `type`, so
    // `readCommandCodeTranscriptRecord` declines every one of them and the
    // reader answers false. The fail-open holds without a fourth condition on
    // the accept.
    const checkpoints = await place(
      REAL_SLUG,
      `${SESSION}.checkpoints.jsonl`,
      `${JSON.stringify({ id: SESSION, turnNumber: 1, prompt: 'x', messageCount: 0, files: [] })}\n`
    );
    expect(acceptCommandCodeTranscriptHint(home, checkpoints)).toBe(checkpoints);

    const parsed = parseCommandCodeTranscript(readFileSync(checkpoints, 'utf8'));
    expect(parsed.records).toEqual([]);
    // Every row was declined, so the parse reports them as malformed rather
    // than as records — which is the mechanism, not a side effect.
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.sessionId).toBeNull();
    expect(buildCommandCodeTurns(parsed.records, SESSION).turns).toEqual([]);
    expect(
      await captureCommandCodeTranscriptTurn(TARGET, {
        commandCodeHome: home,
        transcriptPathHint: checkpoints,
      })
    ).toBe(false);
  });

  it('finds the file under the camel-split slug with no hint and no cwd', async () => {
    // The route that exists so the reader is useful before a receiver plumbs
    // the payload (#2252): the session id alone, one level of scan, and a
    // directory name nothing here could have produced.
    const real = await placeRealTranscript();
    getLastAgentEvent.mockReturnValue({ sessionId: SESSION });

    expect(await findCommandCodeTranscriptPath(home, SESSION)).toBe(real);
    expect(await captureCommandCodeTranscriptTurn(TARGET, { commandCodeHome: home })).toBe(true);
    expect(savedAssistantBodies()).toEqual([TURN_BODY]);
  });
});

describe('[#2304] the 1.49.0 transcript reads the same as 1.40.1`s', () => {
  it('parses every record and builds one writable turn', () => {
    // The transcript half of the drift check. `version: 3`, `type: session` /
    // `type: message`, `message.meta.source`, `thinking` / `text` / `tool_use` /
    // `tool_result` blocks — all unchanged nine minor versions on, which is why
    // no reader change was needed for this Issue.
    const parsed = parseCommandCodeTranscript(TRANSCRIPT);
    expect(parsed.records).toHaveLength(5);
    expect(parsed.malformedLines).toBe(0);
    expect(parsed.records[0].type).toBe('session');
    // The header is what carries the session id, and it is the payload's.
    expect(parsed.sessionId).toBe(SESSION);

    const built = buildCommandCodeTurns(parsed.records, SESSION);
    expect(built.turns).toHaveLength(1);
    // Nothing in a 1.49.0 transcript is a shape this reader cannot place.
    expect(built.orphanedAssistantRecords).toBe(0);
    expect(built.unresolvedParentRecords).toBe(0);
    expect(built.nonMessageRecords).toBe(0);
  });

  it('renders the agent`s own Markdown, thinking block and tool call included', () => {
    // The golden is byte-pinned so a rendering change is a diff rather than a
    // paraphrase, and the three `toContain`s below say what the bytes are for:
    // the reasoning block survives as a blockquote, the reply is the reply, and
    // the tool call is named rather than inlined.
    const built = buildCommandCodeTurns(parseCommandCodeTranscript(TRANSCRIPT).records, SESSION);
    expect(renderCommandCodeTurn(built.turns[0]).body).toBe(TURN_BODY);

    expect(TURN_BODY).toContain('> **Thinking**');
    expect(TURN_BODY).toContain('Created probe2304.txt with the exact content.');
    expect(TURN_BODY).toContain('`write_file`');
  });
});
