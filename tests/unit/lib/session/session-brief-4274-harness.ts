/**
 * Shared world for the #4274 session-brief tests: a migrated file DB in a `mkdtemp`
 * sandbox, a registered repository with mem settings, fake tools whose
 * `sendMessage` records what would be typed, the real launch (`beginAgentSession`),
 * the real hook intake fed with the committed fixtures, and the real send service.
 *
 * The test files mock the edges (tmux ownership, the prompt guard, the tool manager,
 * polling, sockets, the pane capture) themselves — `vi.mock` is hoisted per file —
 * and read the tools from `globalThis.__briefTools`, which this module fills.
 *
 * Nothing here touches the repository's files, tmux or a server.
 */
import { vi, type Mock } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { createRepository } from '@/lib/db/db-repository';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import type { MemBranchRule } from '@/types/mem';
import { setBoundaryDatabaseForTest } from '@/lib/session/session-boundary';
import {
  pinBriefRequest,
  pinBriefWorktree,
  resetLiveBriefClaimsForTest,
  setBriefMemTargetDepsForTest,
  type BriefReport,
} from '@/lib/session/session-brief';
import { EMPTY_BRIEF_PROVIDER, setBriefProviderForTest, type BriefProvider, type BriefRequest, type BriefResult } from '@/lib/session/brief-provider';
import { listRetainedBoundaries, type BoundaryRow } from '@/lib/db/session-brief-db';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import {
  applyAgentEventToState,
  readAgentEventRequest,
  readEventDetail,
  resolveAgentEventWorktree,
  type ResolvedAgentEvent,
} from '@/lib/hooks/agent-event-intake';
import { sendUserMessage, type SendUserMessageResult } from '@/lib/session/send-user-message';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { clearSendAttempts } from '@/lib/session/send-attempt-state';

export const FAKE_BRIEF = '[[brief:fixed]]';
export const WT = 'wt-brief-4274';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const FIXTURES = path.join(process.cwd(), 'tests/fixtures/hooks');

export type BoundaryTool = 'claude' | 'codex' | 'command-code';
export const BOUNDARY_TOOL_IDS: BoundaryTool[] = ['claude', 'codex', 'command-code'];

export interface FakeTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: Mock<(...args: any[]) => Promise<void>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessageWithImage: Mock<(...args: any[]) => Promise<void>>;
  supportsImage?: () => boolean;
  imageMessageBody?: (message: string, imagePath: string) => string;
}

export interface World {
  dir: string;
  db: Database.Database;
  root: string;
  repoId: string;
  wtPath: string;
  /** The branch git reports for the worktree (changed by a test to move HEAD). */
  branch: string;
  tools: Record<string, FakeTool>;
  /** Held before git's answer when armed (the claim's or the plan's `withMemTarget`). */
  observeHold: { wait: Promise<void>; armed: boolean } | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __briefTools: Record<string, FakeTool> | undefined;
}

function newTool(name: string): FakeTool {
  const tool: FakeTool = {
    name,
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithImage: vi.fn(async () => undefined),
  };
  if (name === 'claude') {
    tool.supportsImage = () => true;
    // ClaudeTool.imageMessageBody, byte for byte.
    tool.imageMessageBody = (message, imagePath) => (message ? `${message}\n![](${imagePath})` : `\n![](${imagePath})`);
    tool.sendMessageWithImage = vi.fn(async (wt: string, message: string, imagePath: string, instance?: string) =>
      tool.sendMessage(wt, tool.imageMessageBody!(message, imagePath), instance)
    );
  }
  return tool;
}

export function makeWorld(): World {
  const dir = makeTempDir('session-brief-4274-');
  const db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  const root = path.join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const repoId = createRepository(db, { name: 'repo', path: root, cloneSource: 'local' }).id;
  const wtPath = path.join(dir, 'wt');
  mkdirSync(wtPath, { recursive: true });
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(
    WT,
    WT,
    wtPath,
    root
  );
  const world: World = {
    dir,
    db,
    root,
    repoId,
    wtPath,
    branch: 'feature/a',
    tools: { claude: newTool('claude'), codex: newTool('codex'), 'command-code': newTool('command-code'), copilot: newTool('copilot') },
    observeHold: null,
  };
  globalThis.__briefTools = world.tools;
  setBoundaryDatabaseForTest(db);
  setBriefMemTargetDepsForTest({
    resolveCommonDir: async () => '/common/.git',
    pathExists: () => true,
    observe: async (): Promise<WorktreeHeadObservation> => {
      if (world.observeHold?.armed) {
        world.observeHold.armed = false;
        await world.observeHold.wait;
      }
      return { branch: world.branch, detached: false, head: SHA, commonDir: '/common/.git', known: true };
    },
  });
  setMem(world, 'on', true);
  // Issue #4224: the default provider is C's now (D2); this world briefs with D1's empty one
  // unless a test hands in its own (`fakeProvider`) — the world these tests were written for.
  setBriefProviderForTest(EMPTY_BRIEF_PROVIDER);
  clearSendAttempts();
  resetLiveBriefClaimsForTest();
  return world;
}

export function closeWorld(world: World): void {
  briefModeOverride = null;
  setBriefProviderForTest(null);
  setBoundaryDatabaseForTest(undefined);
  setBriefMemTargetDepsForTest(undefined);
  resetLiveBriefClaimsForTest();
  clearSendAttempts();
  globalThis.__briefTools = undefined;
  world.db.close();
  removeTempDir(world.dir);
}

/** The repository's mem settings: one rule for every branch unless `rules` is given. */
export function setMem(world: World, mode: 'off' | 'derived' | 'on', injectOnStart: boolean, rules?: MemBranchRule[]): void {
  const current = getMemSettings(world.db, world.repoId);
  saveMemSettings(world.db, world.repoId, {
    version: current.version,
    features: { ...current.features, injectOnStart },
    rules: rules ?? [{ match: 'glob', pattern: '**', mode }],
  });
}

/** Hold the next `withMemTarget` git read until the returned function is called. */
export function holdNextObserve(world: World): () => void {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  world.observeHold = { wait, armed: true };
  return release;
}

export interface FakeProvider extends BriefProvider {
  build: Mock<(request: BriefRequest) => BriefResult | Promise<BriefResult>>;
  settle: Mock<NonNullable<BriefProvider['settle']>>;
}

/** `[[brief:fixed]]` with notice `n1`, `minBytes` 16, `defaultBytes` 4096 (design §9). */
export function fakeProvider(overrides: Partial<BriefProvider> = {}): FakeProvider {
  const provider = {
    id: 'fake',
    minBytes: 16,
    defaultBytes: 4096,
    build: vi.fn((request: BriefRequest): BriefResult | Promise<BriefResult> => ({
      body: FAKE_BRIEF,
      includedNoticeIds: ['n1'],
      mode: request.membership.mode,
    })),
    settle: vi.fn(),
    ...overrides,
  } as FakeProvider;
  setBriefProviderForTest(provider);
  return provider;
}

/** A launch: the tool's creation path calls `beginAgentSession`. */
export function launch(tool: BoundaryTool, instanceId?: string): void {
  beginAgentSession({ worktreeId: WT, cliToolId: tool as CLIToolType, instanceId });
}

export interface HookOptions {
  sessionId?: string;
  source?: string;
  instanceId?: string;
  /** false: a headless run's hook — no instance id, worktree resolved from `cwd`. */
  identified?: boolean;
}

/** One committed hook fixture through the real intake (`readAgentEventRequest` → `applyAgentEventToState`). */
export function hook(world: World, tool: BoundaryTool, fixture: string, options: HookOptions = {}): void {
  const payload = JSON.parse(readFileSync(path.join(FIXTURES, tool, fixture), 'utf8')) as Record<string, unknown>;
  if (options.sessionId !== undefined) payload.session_id = options.sessionId;
  if (options.source !== undefined) payload.source = options.source;
  const identified = options.identified ?? true;
  const query = new URLSearchParams({ tool });
  if (identified) {
    delete payload.cwd;
    query.set('worktreeId', WT);
    query.set('instanceId', options.instanceId ?? tool);
  } else {
    payload.cwd = world.wtPath;
  }
  const parsed = readAgentEventRequest(payload, query);
  if ('error' in parsed) throw new Error(parsed.error);
  const worktree = resolveAgentEventWorktree(world.db, parsed.worktreeIdParam, parsed.cwd);
  if (!worktree) throw new Error('worktree not resolved');
  const ctx: ResolvedAgentEvent = {
    worktree,
    tool: parsed.tool,
    source: parsed.source,
    instanceParam: parsed.instanceParam,
    event: parsed.event,
    sessionId: parsed.sessionId,
    receivedAt: Date.now(),
    detail: readEventDetail(parsed.normalized, payload),
    normalized: parsed.normalized,
  };
  const quiet = () => undefined;
  applyAgentEventToState(ctx, payload, false, { info: quiet, warn: quiet, error: quiet, debug: quiet } as never);
}

export interface SendOptions {
  instanceId?: string;
  brief?: 'auto' | 'skip' | 'force' | 'never' | 'decline';
  absoluteImagePath?: string;
  /** Issue #4227 (S-B): the screen's choice (`full`) and the boundary its preview showed. */
  briefDetail?: 'short' | 'full';
  briefBoundary?: string;
}

export interface Sent {
  result: SendUserMessageResult;
  report: BriefReport | null;
}

let briefModeOverride: SendOptions['brief'] | null = null;

/** Make every `send` use this mode (the "as before" world of the byte-for-byte comparison). */
export function overrideBriefMode(mode: SendOptions['brief'] | null): void {
  briefModeOverride = mode;
}

export async function send(tool: string, content: string, options: SendOptions = {}): Promise<Sent> {
  let report: BriefReport | null = null;
  const db = globalThis.__briefDb as Database.Database;
  // Issue #4224: the request's entrance fixes its lifetimes, as the send route does.
  const briefPin = pinBriefRequest(db, pinBriefWorktree(db, WT), options.instanceId ?? tool);
  const result = await sendUserMessage(db, {
    worktreeId: WT,
    content,
    cliToolId: tool as CLIToolType,
    instanceId: options.instanceId,
    brief: briefModeOverride ?? options.brief ?? 'auto',
    briefPin,
    ...(options.briefDetail ? { briefDetail: options.briefDetail } : {}),
    ...(options.briefBoundary ? { briefBoundary: options.briefBoundary } : {}),
    absoluteImagePath: options.absoluteImagePath,
    onBrief: (r) => {
      report = r;
    },
  });
  return { result, report };
}

declare global {
  // eslint-disable-next-line no-var
  var __briefDb: Database.Database | undefined;
}

/** The world `send` writes through. */
export function bindWorld(world: World): void {
  globalThis.__briefDb = world.db;
}

/** Every body the tool was asked to type, in order. */
export function typed(world: World, tool: string): string[] {
  return world.tools[tool].sendMessage.mock.calls.map((call) => String(call[1]));
}

/**
 * The bodies that may have reached the agent: every call except one refused before
 * any key (the `not-sent` failure of {@link failNextSend}). An `indeterminate` one counts.
 */
export function delivered(world: World, tool: string): string[] {
  const mock = world.tools[tool].sendMessage.mock;
  return mock.calls
    .map((call, i) => ({ text: String(call[1]), result: mock.settledResults[i] }))
    .filter(({ result }) => !(result?.type === 'rejected' && (result.value as { code?: string })?.code === 'PASTE_NOT_STARTED'))
    .map(({ text }) => text);
}

export const briefed = (text: string, body: string): boolean => text === `${FAKE_BRIEF}\n\n${body}`;

/** How many typed bodies carry the brief. */
export function briefCount(world: World, tool: string): number {
  return typed(world, tool).filter((text) => text.startsWith(FAKE_BRIEF)).length;
}

export function rows(world: World, instanceId: string): BoundaryRow[] {
  return listRetainedBoundaries(world.db, WT, instanceId);
}

/** A send failure the tool throws: nothing typed (`not-sent`) or typed but unconfirmed (`indeterminate`). */
export function failNextSend(world: World, tool: string, kind: 'not-sent' | 'indeterminate'): void {
  world.tools[tool].sendMessage.mockImplementationOnce(async () => {
    if (kind === 'not-sent') {
      const error = new Error('load-buffer failed') as Error & { code?: string };
      error.code = 'PASTE_NOT_STARTED';
      throw error;
    }
    throw new Error('the pane answered something unexpected');
  });
}
