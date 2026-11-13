/**
 * E2E: the hand-off before a session ends (G-4) through the real worktree page, at a PC's
 * and a phone's width (Issue #4227, design `mem-ui-4227.md` §4.1・§4.4・§4.5.1・§4.6・§7.5,
 * the G-PR2 rows).
 *
 * What the component tests cannot show: the real "end" (the PC header's, the phone's
 * actions sheet) reads the mem mode and opens the hand-off, the dialog's requests go out
 * with the screen's mark, and the stop it runs is the page's existing stop (the
 * kill-session route). The whole `/api` is stubbed per browser context, so two pages share
 * one server model (the hand-off's request and proposals, the items with versions, whether
 * the instance runs, the conversation). The agent's side (`propose`, `done`) is the test
 * changing that model, as the agent's API would; the server's own rules are fixed in the
 * unit tables (`tests/unit/lib/handoff/**`). No default is assumed: mode, `popup`, the
 * worktree, the roster and the session are set here.
 *
 * In every flow the kill-session route sees no request until a person presses a stop.
 */

import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { mockStartPreview } from './fixtures/start-preview-helpers';

const WT = 'e2e-handoff-4227';
/** G10: another worktree, for the switch (the page's Loading). */
const WT2 = 'e2e-handoff-4227-other';
const RID = 'req-1';
const BASE = `/api/worktrees/${WT}/mem/handoff/requests`;
const HANDOFF_TEXT = 'Before this session ends, propose the updates of mem with `commandmate handoff propose`.';

type RequestState = 'awaiting_agent' | 'reviewing' | 'applying' | 'ending' | 'ended' | 'cancelled' | 'expired';
const OPEN: RequestState[] = ['awaiting_agent', 'reviewing', 'applying', 'ending'];

interface Proposal {
  id: string;
  op: 'add' | 'update' | 'close';
  itemId: string | null;
  kind: string;
  baseVersion: number | null;
  revision: number;
  state: 'proposed' | 'approved' | 'applied' | 'conflict' | 'discarded' | 'failed' | 'expired';
  stateReason: string | null;
  payload: { text?: string; reason?: string };
}

interface Item {
  id: string;
  kind: string;
  text: string;
  version: number;
}

interface HandoffRequest {
  id: string;
  state: RequestState;
  sendState: 'unsent' | 'sent' | 'failed';
  endForced: boolean;
  endToken: string | null;
  outcome: 'confirmed' | 'unconfirmed' | null;
  outcomeReason: string | null;
  agentDoneAt: string | null;
  agentTimedOut: boolean;
  extensions: number;
  version: number;
  conversation: number;
}

interface Server {
  mode: 'on' | 'derived' | 'off';
  popup: boolean;
  running: boolean;
  /** Which conversation runs now; a launch after a stop starts another. */
  conversation: number;
  /**
   * G-PR3 (#4289 B P3-6): whether D1 knows the instance's conversation (a boundary row). Without
   * one, `create` is 409 `session_unknown` as the real route answers (`request.ts`).
   */
  boundary: boolean;
  request: HandoffRequest | null;
  proposals: Proposal[];
  items: Item[];
  /** The kill-session route: every request it got. */
  kills: string[];
  /** The kill fails (500) and the instance keeps running. */
  killFails: boolean;
  /** While set, the kill's answer waits (the kill itself took effect). */
  killGate: Promise<void> | null;
  /** The send route's bodies. */
  sends: Array<Record<string, unknown>>;
  /** Every hand-off write: path (after the request) and body. */
  writes: Array<{ path: string; mark: string | null; body: Record<string, unknown> }>;
  /** Called by decide after its start passed, before the writes (to change things "on the way"). */
  duringDecide: (() => void) | null;
  tokens: number;
  /** G10: list WT2 too (the sidebar's switch of worktree). */
  second: boolean;
  /** G10: while set, WT2's detail waits (the page shows its Loading). */
  secondGate: Promise<void> | null;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const fingerprint = (proposal: Proposal) => `fp-${proposal.id}-${proposal.revision}-${proposal.baseVersion ?? 'n'}`;

function itemView(item: Item) {
  return {
    id: item.id,
    kind: item.kind,
    state: 'open',
    text: item.text,
    version: item.version,
    closeWhen: null,
    createdBy: 'agent',
    updatedBy: 'agent',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    stale: false,
    frozen: false,
  };
}

function view(server: Server) {
  const request = server.request!;
  return {
    ok: true,
    request: {
      id: request.id,
      worktreeId: WT,
      instanceId: 'claude',
      cliToolId: 'claude',
      branch: 'feat/handoff',
      detached: false,
      state: request.state,
      sendState: request.sendState,
      endForced: request.endForced,
      endToken: request.endToken,
      outcome: request.outcome,
      outcomeReason: request.outcomeReason,
      agentDeadlineAt: '2026-11-10T00:05:00.000Z',
      extensions: request.extensions,
      expiresAt: '2026-11-10T01:00:00.000Z',
      agentDoneAt: request.agentDoneAt,
      endedAt: request.state === 'ended' ? '2026-11-10T00:10:00.000Z' : null,
      agentTimedOut: request.state === 'awaiting_agent' && request.agentTimedOut,
      version: request.version,
    },
    proposals: server.proposals.map((proposal) => {
      const item = proposal.itemId ? server.items.find((entry) => entry.id === proposal.itemId) : undefined;
      return {
        ...proposal,
        fingerprint: fingerprint(proposal),
        current: item ? itemView(item) : null,
        appliedItemId: null,
        appliedVersion: null,
      };
    }),
    direct: [],
  };
}

/** What the agent would do through its API (`handoff propose` / `handoff done`). */
const agent = {
  proposeUpdate(server: Server, itemId: string, text: string): void {
    const item = server.items.find((entry) => entry.id === itemId)!;
    server.proposals.push({
      id: `p-${server.proposals.length + 1}`,
      op: 'update',
      itemId,
      kind: item.kind,
      baseVersion: item.version,
      revision: 1,
      state: 'proposed',
      stateReason: null,
      payload: { text },
    });
  },
  done(server: Server): void {
    const request = server.request!;
    request.agentDoneAt = '2026-11-10T00:02:00.000Z';
    if (request.state === 'awaiting_agent') {
      request.state = 'reviewing';
      request.version += 1;
    }
  },
};

/** Another writer changes an item (another page, another agent). */
function itemWrite(server: Server, itemId: string, text: string): void {
  const item = server.items.find((entry) => entry.id === itemId)!;
  item.text = text;
  item.version += 1;
}

function missing(server: Server): string | null {
  const request = server.request!;
  if (request.agentDoneAt === null) return request.sendState === 'failed' ? 'request_failed' : 'agent_timeout';
  const states = server.proposals.map((proposal) => proposal.state);
  if (states.some((state) => state === 'proposed' || state === 'approved')) return 'undecided_left';
  if (states.includes('conflict')) return 'conflict_left';
  if (states.includes('failed')) return 'apply_failed';
  return null;
}

function settle(server: Server, from: Proposal['state'][], to: Proposal['state'], reason: string): void {
  for (const proposal of server.proposals) {
    if (from.includes(proposal.state)) {
      proposal.state = to;
      proposal.stateReason = reason;
    }
  }
}

function handoffRoute(server: Server, route: Route, path: string, method: string, body: Record<string, unknown>) {
  const mark = route.request().headers()['x-commandmate-client'] ?? null;
  if (method === 'POST') server.writes.push({ path, mark, body });
  if (method === 'POST' && mark !== 'screen') return json(route, 403, { ok: false, code: 'screen_only' });

  if (path === '' && method === 'POST') {
    if (server.mode !== 'on') return json(route, 409, { ok: false, code: 'disabled' });
    if (!server.popup) return json(route, 409, { ok: false, code: 'unattended' });
    // G-PR3: the request picked up carries its text, as the real route answers (pr2e P3-3).
    if (server.request && OPEN.includes(server.request.state)) return json(route, 409, { ...view(server), ok: false, code: 'request_open', text: HANDOFF_TEXT });
    // G-PR3 (#4289 B P3-6): no boundary, no request (the real route's order: after the open one).
    if (!server.boundary) return json(route, 409, { ok: false, code: 'session_unknown' });
    server.proposals = [];
    server.request = {
      id: RID,
      state: 'awaiting_agent',
      sendState: 'unsent',
      endForced: false,
      endToken: null,
      outcome: null,
      outcomeReason: null,
      agentDoneAt: null,
      agentTimedOut: false,
      extensions: 0,
      version: 1,
      conversation: server.conversation,
    };
    return json(route, 201, { ...view(server), text: HANDOFF_TEXT });
  }
  const request = server.request;
  if (!request || !path.startsWith(`/${RID}`)) return json(route, 404, { ok: false, code: 'not_found' });
  const rest = path.slice(`/${RID}`.length);
  // Read-time judging: an open request before the declaration expires with its conversation.
  if (['awaiting_agent', 'reviewing', 'applying'].includes(request.state) && request.conversation !== server.conversation) {
    request.state = 'expired';
    settle(server, ['proposed', 'approved', 'conflict'], 'expired', 'session_changed');
  }
  const refuse = (code: string) => json(route, 409, { ...view(server), ok: false, code });
  const versionOk = () => body.ifVersion === request.version;

  if (rest === '' && method === 'GET') return json(route, 200, view(server));
  if (rest === '/sent' || rest === '/send-failed') {
    request.sendState = rest === '/sent' ? 'sent' : 'failed';
    request.version += 1;
    return json(route, 200, view(server));
  }
  if (rest === '/cancel') {
    if (!OPEN.includes(request.state)) return refuse('request_closed');
    request.state = 'cancelled';
    settle(server, ['proposed', 'approved', 'conflict'], 'discarded', 'cancelled');
    request.version += 1;
    return json(route, 200, view(server));
  }
  if (rest === '/decide') {
    if (!versionOk()) return refuse('version_conflict');
    if (server.mode !== 'on') return refuse('disabled');
    request.state = 'applying';
    request.version += 1;
    const decisions = (body.decisions as Array<{ proposalId: string; fingerprint: string; action: string }>) ?? [];
    const results: Array<{ proposalId: string; result: string; code?: string }> = [];
    for (const decision of decisions) {
      const proposal = server.proposals.find((entry) => entry.id === decision.proposalId)!;
      if (decision.action === 'discard') {
        proposal.state = 'discarded';
        proposal.stateReason = 'discarded';
        results.push({ proposalId: proposal.id, result: 'discarded' });
      } else if (decision.fingerprint !== fingerprint(proposal)) {
        results.push({ proposalId: proposal.id, result: 'proposal_changed' });
      } else {
        proposal.state = 'approved';
      }
    }
    server.duringDecide?.();
    for (const proposal of server.proposals.filter((entry) => entry.state === 'approved')) {
      const item = server.items.find((entry) => entry.id === proposal.itemId)!;
      if (server.mode !== 'on') {
        proposal.state = 'failed';
        proposal.stateReason = 'disabled';
        results.push({ proposalId: proposal.id, result: 'failed', code: 'disabled' });
      } else if (item.version !== proposal.baseVersion) {
        proposal.state = 'conflict';
        proposal.stateReason = 'version_conflict';
        results.push({ proposalId: proposal.id, result: 'conflict', code: 'version_conflict' });
      } else {
        item.text = proposal.payload.text ?? item.text;
        item.version += 1;
        proposal.state = 'applied';
        results.push({ proposalId: proposal.id, result: 'applied' });
      }
    }
    request.state = 'reviewing';
    request.version += 1;
    return json(route, 200, { ...view(server), results });
  }
  const rebase = /^\/proposals\/([^/]+)\/rebase$/.exec(rest);
  if (rebase) {
    if (!versionOk()) return refuse('version_conflict');
    const proposal = server.proposals.find((entry) => entry.id === rebase[1])!;
    if (proposal.state !== 'conflict' || body.fingerprint !== fingerprint(proposal)) return refuse('proposal_changed');
    proposal.baseVersion = server.items.find((entry) => entry.id === proposal.itemId)!.version;
    proposal.revision += 1;
    proposal.state = 'proposed';
    proposal.stateReason = null;
    request.version += 1;
    return json(route, 200, view(server));
  }
  if (rest === '/end') {
    if (!['awaiting_agent', 'reviewing', 'applying'].includes(request.state)) return refuse('request_closed');
    if (!versionOk()) return refuse('version_conflict');
    const force = body.force === true;
    // G-PR3 (#4289 B P3-6): as the real route (`end.ts`): a confirmation running is stopped only by force.
    if (request.state === 'applying' && !force) return json(route, 409, { ok: false, code: 'state_forbids', request: view(server).request });
    server.tokens += 1;
    request.state = 'ending';
    request.endToken = `end-${server.tokens}`;
    request.endForced = request.endForced || force;
    if (force) settle(server, ['proposed', 'approved', 'conflict'], 'discarded', 'forced');
    request.version += 1;
    return json(route, 200, { ...view(server), endToken: request.endToken });
  }
  if (rest === '/end/observe') {
    if (body.endToken !== request.endToken) return refuse('end_token_changed');
    if (request.state === 'ended') return refuse('already_recorded');
    if (request.state !== 'ending') return refuse('request_closed');
    const end = (outcome: 'confirmed' | 'unconfirmed', reason: string | null) => {
      request.state = 'ended';
      request.outcome = outcome;
      request.outcomeReason = reason;
      settle(server, ['proposed', 'approved', 'conflict'], 'expired', reason ?? 'ended');
      return json(route, 200, view(server));
    };
    if (request.conversation !== server.conversation) return end('unconfirmed', request.endForced ? 'forced' : 'session_changed');
    if (server.running) {
      request.state = 'reviewing';
      request.endToken = null;
      request.version += 1;
      return refuse('not_stopped');
    }
    if (request.endForced) return end('unconfirmed', 'forced');
    const reason = missing(server);
    return reason === null ? end('confirmed', null) : end('unconfirmed', reason);
  }
  return json(route, 404, { ok: false, code: 'not_found' });
}

function worktreeRow(server: Server, id: string = WT) {
  const status = { isRunning: server.running, isWaitingForResponse: false, isProcessing: false };
  return {
    id,
    name: id === WT ? 'feat/handoff' : 'feat/other',
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${WT}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E hand-off worktree',
    selectedAgents: ['claude'],
    agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    cliToolId: 'claude',
    status: 'ready',
    sessionStatusByCli: { claude: status },
    sessionStatusByInstance: { claude: status },
    isSessionRunning: server.running,
    isWaitingForResponse: false,
    isProcessing: false,
    gitStatus: { currentBranch: id === WT ? 'feat/handoff' : 'feat/other', initialBranch: id === WT ? 'feat/handoff' : 'feat/other', isBranchMismatch: false, commitHash: 'e2e0000', isDirty: false },
    sessionNotes: {},
    autoYesByInstance: {},
    lastActivityByInstance: {},
  };
}

/** One server model for every page of the context. */
async function stubServer(context: BrowserContext): Promise<Server> {
  const server: Server = {
    mode: 'on',
    popup: true,
    running: true,
    conversation: 1,
    boundary: true,
    request: null,
    proposals: [],
    items: [{ id: 'note-1', kind: 'note', text: 'first note', version: 1 }],
    kills: [],
    killFails: false,
    killGate: null,
    sends: [],
    writes: [],
    duringDecide: null,
    tokens: 0,
    second: false,
    secondGate: null,
  };
  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const { pathname } = url;
      const method = request.method();
      const body = (method === 'GET' ? {} : (request.postDataJSON() ?? {})) as Record<string, unknown>;
      const ok = (payload: unknown) => json(route, 200, payload);

      if (pathname === '/api/worktrees') {
        return ok({ worktrees: server.second ? [worktreeRow(server), worktreeRow(server, WT2)] : [worktreeRow(server)], repositories: [] });
      }
      if (pathname === `/api/worktrees/${WT2}`) {
        if (server.secondGate) await server.secondGate;
        return ok(worktreeRow(server, WT2));
      }
      if (pathname.startsWith(BASE)) return handoffRoute(server, route, pathname.slice(BASE.length), method, body);
      const detail = /^\/api\/worktrees\/([^/]+)(\/.*)?$/.exec(pathname);
      if (detail && decodeURIComponent(detail[1]) === WT) {
        const sub = detail[2] ?? '';
        if (sub === '') return ok(worktreeRow(server));
        if (sub === '/mem/mode') {
          return ok({ ok: true, mode: server.mode, features: { injectOnStart: true, promptOnEvents: true, popup: server.popup } });
        }
        if (sub === '/kill-session' && method === 'POST') {
          server.kills.push(`${pathname}${url.search}`);
          if (server.killFails) return json(route, 500, { error: 'kill failed' });
          server.running = false;
          if (server.killGate) await server.killGate;
          return ok({ success: true, message: 'killed' });
        }
        if (sub === '/send' && method === 'POST') {
          server.sends.push(body);
          // A send to a stopped instance launches it: another conversation.
          if (!server.running) {
            server.running = true;
            server.conversation += 1;
          }
          return ok({ success: true, message: { id: `m-${server.sends.length}` } });
        }
        if (sub.startsWith('/current-output')) {
          return ok({
            isRunning: server.running,
            cliToolId: 'claude',
            sessionStatus: 'ready',
            sessionStatusReason: 'input_prompt',
            content: '',
            fullOutput: '',
            realtimeSnippet: '',
            lineCount: 0,
            thinking: false,
            isGenerating: false,
            isPromptWaiting: false,
            isSelectionListActive: false,
            agentMode: 'unknown',
          });
        }
        if (sub.startsWith('/messages') || sub.startsWith('/memos') || sub.startsWith('/execution-logs') || sub.startsWith('/schedules')) return ok([]);
        if (sub.startsWith('/tree')) return ok({ items: [] });
        if (sub.startsWith('/tasks')) return ok({ tasks: [] });
        if (sub.startsWith('/verify/config')) return ok({ exists: false, path: '.commandmate/verify.yaml', gates: [], options: null, plannedGateIds: [], error: null });
        if (sub.startsWith('/verify/runs')) return ok({ runs: [] });
        if (sub.startsWith('/slash-commands')) return ok({ groups: [] });
        return ok({});
      }
      if (pathname.includes('/repositories')) return ok([]);
      if (pathname.includes('/tools')) return ok([]);
      return ok({});
    },
  );
  await mockStartPreview(context);
  return server;
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/** The page's existing "end" (the PC header's, the phone's actions sheet). */
async function pressEnd(page: Page): Promise<void> {
  if (isPhone(page)) {
    await page.getByTestId('mobile-more-actions-button').click();
    const end = page.getByTestId('actions-sheet-end');
    await expect(end).toBeEnabled();
    await end.click();
  } else {
    await page.getByTestId('desktop-kill-session').click();
  }
}

/** Opens the page and the hand-off; the request is made and its text sent. */
async function openHandoff(page: Page, server: Server): Promise<void> {
  await page.goto(`/worktrees/${WT}`);
  await pressEnd(page);
  await expect(page.getByTestId('handoff-dialog')).toBeVisible();
  await expect(page.getByTestId('handoff-state')).toBeVisible();
  await expect.poll(() => server.request?.sendState).toBe('sent');
}

/** The agent's answer is read again (the screen also reads every 3 seconds). */
async function readAgain(page: Page): Promise<void> {
  await page.getByTestId('handoff-reload').click();
}

const writePaths = (server: Server) => server.writes.map((write) => write.path);

for (const viewport of [
  { name: 'PC', size: { width: 1440, height: 900 } },
  { name: 'phone', size: { width: 390, height: 844 } },
]) {
  test.describe(`hand-off before ending (${viewport.name})`, () => {
    test.use({ viewport: viewport.size });

    test('the request’s text goes through the send route with brief: skip; every write has the screen mark', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      expect(server.sends).toEqual([{ content: HANDOFF_TEXT, cliToolId: 'claude', instanceId: 'claude', brief: 'skip' }]);
      expect(server.writes.map((write) => [write.path, write.mark])).toEqual([
        ['', 'screen'],
        [`/${RID}/sent`, 'screen'],
      ]);
      expect(server.writes[0].body).toEqual({ instanceId: 'claude' });
      expect(server.kills).toEqual([]);
      // At this width the dialog does not scroll sideways.
      const dialog = page.getByTestId('handoff-dialog');
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    });

    test('not answered: the agent’s time runs out, nothing is killed until the stop, recorded as agent_timeout', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      // The test's clock: the agent's window has passed with no `done`.
      server.request!.agentTimedOut = true;
      await readAgain(page);
      await expect(page.getByTestId('handoff-agent-timeout')).toBeVisible();
      await expect(page.getByTestId('handoff-extend')).toBeVisible();
      await expect(page.getByTestId('handoff-go-on')).toBeVisible();
      expect(server.kills).toEqual([]);

      await page.getByTestId('handoff-stop').click();
      await expect(page.getByTestId('handoff-outcome')).toContainText('agent_timeout');
      expect(server.kills).toEqual([`/api/worktrees/${WT}/kill-session?cliTool=claude&instance=claude`]);
      expect(writePaths(server).slice(-2)).toEqual([`/${RID}/end`, `/${RID}/end/observe`]);
      expect(server.writes.at(-2)!.body).toEqual({ ifVersion: expect.any(Number) });
    });

    test('a confirmation fails (the mode leaves on midway): the proposal fails, nothing is killed until the stop, apply_failed', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      agent.proposeUpdate(server, 'note-1', 'proposed by the agent');
      agent.done(server);
      await readAgain(page);
      await page.getByTestId('handoff-approve-p-1').click();
      server.duringDecide = () => {
        server.mode = 'derived';
      };
      await page.getByTestId('handoff-confirm').click();
      await expect(page.getByTestId('handoff-notice')).toBeVisible();
      await expect(page.getByTestId('handoff-proposal-p-1')).toContainText('disabled');
      expect(server.proposals[0].state).toBe('failed');
      expect(server.items[0].text).toBe('first note');
      expect(server.kills).toEqual([]);

      await page.getByTestId('handoff-stop').click();
      await expect(page.getByTestId('handoff-outcome')).toContainText('apply_failed');
      expect(server.kills).toHaveLength(1);
    });

    test('cancelled: the request is cancelled, undecided proposals discarded, the session goes on (no kill)', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      agent.proposeUpdate(server, 'note-1', 'proposed by the agent');
      agent.done(server);
      await readAgain(page);
      await expect(page.getByTestId('handoff-proposal-p-1')).toBeVisible();

      await page.getByTestId('handoff-cancel').click();
      await expect(page.getByTestId('handoff-dialog')).toHaveCount(0);
      expect(server.request!.state).toBe('cancelled');
      expect(server.proposals[0]).toMatchObject({ state: 'discarded', stateReason: 'cancelled' });
      expect(server.kills).toEqual([]);
      expect(server.running).toBe(true);
      expect(writePaths(server)).not.toContain(`/${RID}/end`);
    });

    test('forced before confirming: done and no proposals, “stop now” still records forced, not confirmed', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      agent.done(server);
      await readAgain(page);
      expect(server.kills).toEqual([]);

      await page.getByTestId('handoff-stop-now').click();
      await expect(page.getByTestId('handoff-outcome')).toContainText('forced');
      expect(server.request).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'forced' });
      expect(server.writes.find((write) => write.path === `/${RID}/end`)!.body).toMatchObject({ force: true });
      expect(server.kills).toHaveLength(1);
    });

    test('forced, then the stop does not take: “could not confirm”, stop again, forced for good', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      agent.done(server);
      await readAgain(page);
      server.killFails = true;

      await page.getByTestId('handoff-stop-now').click();
      await expect(page.getByTestId('handoff-notice')).toBeVisible();
      await expect(page.getByTestId('handoff-stop')).toBeVisible();
      expect(server.request).toMatchObject({ state: 'reviewing', endForced: true });
      expect(server.kills).toHaveLength(1);
      expect(server.running).toBe(true);

      // The second press is the person's, with the ordinary stop.
      server.killFails = false;
      await page.getByTestId('handoff-stop').click();
      await expect(page.getByTestId('handoff-outcome')).toContainText('forced');
      expect(server.request).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'forced' });
      expect(server.kills).toHaveLength(2);
      const ends = server.writes.filter((write) => write.path === `/${RID}/end`);
      expect(ends.map((write) => write.body.force)).toEqual([true, true]);
    });

    test('launched again after the stop, before the observation: session_changed, and the new process keeps running', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      agent.done(server);
      await readAgain(page);
      let release!: () => void;
      server.killGate = new Promise<void>((resolve) => {
        release = resolve;
      });

      await page.getByTestId('handoff-stop').click();
      await expect.poll(() => server.kills.length).toBe(1);
      // Another page sends to the same instance: the launch path starts another conversation.
      const other = await context.newPage();
      await other.goto(`/api/worktrees/${WT}/mem/mode`);
      await other.evaluate(async (wt) => {
        await fetch(`/api/worktrees/${wt}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'start again', cliToolId: 'claude', instanceId: 'claude' }),
        });
      }, WT);
      expect(server.conversation).toBe(2);
      // A read before the observation: the declared request stays `ending`.
      await readAgain(page);
      await expect.poll(() => server.request!.state).toBe('ending');
      expect(writePaths(server)).not.toContain(`/${RID}/end/observe`);

      release();
      await expect(page.getByTestId('handoff-outcome')).toContainText('session_changed');
      expect(server.request).toMatchObject({ state: 'ended', outcome: 'unconfirmed', outcomeReason: 'session_changed' });
      expect(server.running).toBe(true);
      expect(server.kills).toHaveLength(1);
    });

    test('a conflict after another write: moved onto the current version, shown again, approved and confirmed', async ({ context, page }) => {
      const server = await stubServer(context);
      await openHandoff(page, server);
      agent.proposeUpdate(server, 'note-1', 'proposed by the agent');
      agent.done(server);
      await readAgain(page);
      // Another page writes the item after the proposal was made.
      itemWrite(server, 'note-1', 'written by another page');

      await page.getByTestId('handoff-approve-p-1').click();
      await page.getByTestId('handoff-confirm').click();
      await expect(page.getByTestId('handoff-conflict-p-1')).toBeVisible();
      expect(server.proposals[0].state).toBe('conflict');

      await page.getByTestId('handoff-rebase-p-1').click();
      await expect(page.getByTestId('handoff-approve-p-1')).toBeVisible();
      await expect(page.getByTestId('handoff-proposal-current-p-1')).toContainText('written by another page');
      await expect(page.getByTestId('handoff-proposal-current-p-1')).toContainText('2');
      expect(server.proposals[0]).toMatchObject({ state: 'proposed', baseVersion: 2, revision: 2 });

      await page.getByTestId('handoff-approve-p-1').click();
      await page.getByTestId('handoff-confirm').click();
      await expect.poll(() => server.proposals[0].state).toBe('applied');
      expect(server.items[0]).toMatchObject({ text: 'proposed by the agent', version: 3 });
      const decides = server.writes.filter((write) => write.path === `/${RID}/decide`);
      expect(decides.map((write) => (write.body.decisions as Array<{ fingerprint: string }>)[0].fingerprint)).toEqual(['fp-p-1-1-1', 'fp-p-1-2-2']);
      expect(server.kills).toEqual([]);

      await page.getByTestId('handoff-stop').click();
      await expect(page.getByTestId('handoff-outcome')).toBeVisible();
      expect(server.request).toMatchObject({ state: 'ended', outcome: 'confirmed', outcomeReason: null });
      expect(server.kills).toHaveLength(1);
    });

    test('unattended (popup off): the plain confirmation as before, and no hand-off request (negative control)', async ({ context, page }) => {
      const server = await stubServer(context);
      server.popup = false;
      await page.goto(`/worktrees/${WT}`);
      await pressEnd(page);
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByTestId('handoff-dialog')).toHaveCount(0);
      expect(server.writes).toEqual([]);
      expect(server.kills).toEqual([]);
    });
  });
}

/**
 * G10 (the UAT of G-PR1+G-PR2, design §4.1.1): a dialog holding something is drawn open again
 * after the PC ↔ phone switch and the page's Loading, without a person's press. The cause found:
 * AppShell draws the page under another parent per layout, so the page (and its `handoffTarget`)
 * is mounted anew; the page now takes the store's live opening back on mount. Without that, the
 * dialog is gone 100 ms after the switch (the UAT's g10-02) and these tests fail at the first
 * `toBeVisible` after `setViewportSize`.
 */
test.describe('G10: the hand-off dialog stays over the layout switch and the Loading', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  const decidePath = `${BASE}/${RID}/decide`;
  const layoutOf = (width: number) => (width < 768 ? 'mobile' : 'desktop');

  /** Opens the hand-off at 1280, approves the agent's proposal and loses the decide: an unknown unit. */
  async function unknownUnit(page: Page, server: Server): Promise<void> {
    await openHandoff(page, server);
    agent.proposeUpdate(server, 'note-1', 'proposed by the agent');
    agent.done(server);
    await readAgain(page);
    await page.getByTestId('handoff-approve-p-1').click();
    // Page routes come before the context's: the decide is cut on the way (the UAT's disconnect).
    // pr3c (codex P2-3): `unroute` matches the very function `route` was given (compared by
    // identity), so the same reference goes to both — two arrows would leave the cut in place.
    const isDecide = (url: URL) => url.pathname === decidePath;
    await page.route(isDecide, (route) => route.abort('connectionreset'));
    await page.getByTestId('handoff-confirm').click();
    await expect(page.getByTestId('handoff-pending')).toBeVisible();
    await page.unroute(isDecide);
  }

  test('an unknown result: 1280 → 390 → 1280 → 390 draws the dialog open with the unit each time; no second request', async ({ context, page }) => {
    const server = await stubServer(context);
    await unknownUnit(page, server);
    for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await expect(page.getByTestId('handoff-dialog')).toBeVisible();
      await expect(page.getByTestId('handoff-dialog')).toHaveAttribute('data-layout', layoutOf(size.width));
      await expect(page.getByTestId('handoff-pending')).toBeVisible();
    }
    // Drawn again, nothing was made again: one create, no kill, and the decide not applied.
    expect(server.writes.filter((write) => write.path === '')).toHaveLength(1);
    expect(server.kills).toEqual([]);
    expect(server.proposals[0].state).toBe('proposed');
    // The person's choice is still there to make, at the phone's width: sent again as it was.
    await page.getByTestId('handoff-pending-resend').click();
    await expect.poll(() => server.proposals[0].state).toBe('applied');
    await expect(page.getByTestId('handoff-pending')).toHaveCount(0);
    await expect(page.getByTestId('handoff-dialog')).toBeVisible();
  });

  test('waiting for the agent (no unit): drawn open again after 1280 → 390 → 1280 too', async ({ context, page }) => {
    const server = await stubServer(context);
    await openHandoff(page, server);
    for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(size);
      await expect(page.getByTestId('handoff-dialog')).toBeVisible();
      // pr3c (review B P3-1): drawn under the new layout, not the dialog from before the remount.
      await expect(page.getByTestId('handoff-dialog')).toHaveAttribute('data-layout', layoutOf(size.width));
      await expect(page.getByTestId('handoff-state')).toBeVisible();
    }
    expect(server.writes.filter((write) => write.path === '')).toHaveLength(1);
    expect(server.sends).toHaveLength(1);
    expect(server.kills).toEqual([]);
  });

  test('the Loading of a switch of worktree: kept as the other worktree’s, then back on its own worktree it can be sent again', async ({ context, page }) => {
    const server = await stubServer(context);
    server.second = true;
    await unknownUnit(page, server);
    let release!: () => void;
    server.secondGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The modal covers the sidebar: the click is dispatched to the row (the page's own switch).
    await page.getByTestId('branch-list-item').filter({ hasText: 'feat/other' }).first().dispatchEvent('click');
    await expect(page).toHaveURL(new RegExp(`/worktrees/${WT2}`));
    release();
    await expect(page.getByTestId('handoff-dialog')).toBeVisible();
    await expect(page.getByTestId('handoff-foreign')).toBeVisible();
    await expect(page.getByTestId('handoff-pending')).toBeVisible();
    // And the layout switch on the other worktree's page keeps it as well.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('handoff-foreign')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId('branch-list-item').filter({ hasText: 'feat/handoff' }).first().dispatchEvent('click');
    await expect(page).toHaveURL(new RegExp(`/worktrees/${WT}(?:$|[?#])`));
    await expect(page.getByTestId('handoff-dialog')).toBeVisible();
    await expect(page.getByTestId('handoff-foreign')).toHaveCount(0);
    await expect(page.getByTestId('handoff-pending-resend')).toBeEnabled();
    expect(server.writes.filter((write) => write.path === '')).toHaveLength(1);
    expect(server.kills).toEqual([]);
  });

  test('G9: done with no proposal tells the person a proposal may not have arrived', async ({ context, page }) => {
    const server = await stubServer(context);
    await openHandoff(page, server);
    agent.done(server);
    await readAgain(page);
    await expect(page.getByTestId('handoff-done-empty')).toBeVisible();
    // Negative control: once a proposal is there, the notice goes (the list shows it).
    agent.proposeUpdate(server, 'note-1', 'proposed by the agent');
    await readAgain(page);
    await expect(page.getByTestId('handoff-proposal-p-1')).toBeVisible();
    await expect(page.getByTestId('handoff-done-empty')).toHaveCount(0);
  });
});

/**
 * G10 (G-PR4; the UAT of G-PR3, 差し戻し 4): on the dev server (`npm run dev`, React StrictMode)
 * the dialog waiting for the agent (no unit) was gone for 0.1〜1 s after A → B → A. The page is
 * made anew by Next (keyed by its `[id]`); since G10 its controller starts from the store's opening
 * and the page draws the dialog outside its Loading. Three waits are driven apart:
 *
 * - (a) a cache hit: the list holds A, so the page draws without its Loading;
 * - (b) a cache miss with the first read held: A is not in the list and its detail waits, so the
 *   page stays in its Loading through every sample;
 * - (c) the route's own transition held: the page's RSC request waits {@link ROUTE_HOLD_MS}, so
 *   for that time A's page does not exist yet (the route's `loading.tsx`, no dialog).
 *
 * G10b (PM's decision, codex P2-2): the point is that **once drawn, the dialog does not go away**.
 * From the push to 3s the dialogs are counted in the browser every {@link SAMPLE_EVERY_MS}ms (no
 * `toBeVisible`, which would wait a gap away). The invariant asserted in (a)(b)(c): after the first
 * sample with a dialog there is no sample without one (0 transitions 1→0), one dialog at most, and
 * one by 1s. G10c (codex-2 P2-2): that is judged by each sample's MEASURED `elapsed`, not by the
 * `at` it was scheduled for (a timer that fires late cannot pass as "on time"); a run in which any
 * sample fired more than 100ms after its schedule is indeterminate and fails. The value at 100ms is **recorded, not asserted** in (a) and (c): it is a known gap
 * (in dev the route's load and its Suspense come before the page exists), noted in the test's
 * annotations — if it becomes 1 the note changes, so it is noticed. (b) is the same since G10d: its 100ms is recorded too, not asserted (it wavers on a
 * loaded dev machine: 0 with the first dialog at ~400ms in most runs, 1 in some).
 */
test.describe('G10 (G-PR4): back on the worktree, sampled every 50ms to 3s after the push (dev, StrictMode)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  const ROUTE_HOLD_MS = 500;
  const SAMPLE_EVERY_MS = 50;
  const SAMPLE_UNTIL_MS = 3000;

  /** A sample is judged by the `elapsed` it was really taken at, never by the `at` it was scheduled for. */
  const DEADLINE_MS = 1000;
  /** A sample that fires later than this after its schedule makes the run indeterminate (a failure, never green). */
  const MAX_LATE_MS = 100;
  /** Mutation knob for the judge's own check (G10c): every sample fires this many ms after its schedule. */
  const SKEW_MS = Number(process.env.G10_SAMPLE_SKEW_MS ?? 0);
  /**
   * Mutation knob for (d)'s observer (#4317 d, a control only; unset: off): `1` takes the dialog's
   * node out of the DOM for one task 100ms after the push and puts the same node back, so the
   * MutationObserver sees a notification with 0 dialogs. Never set by default.
   */
  const D_DROP_DIALOG = process.env.G10_D_DROP_DIALOG === '1';

  type Sample = { at: number; elapsed: number; dialogs: number; path: string };
  type Summary = {
    /** In the order they were really taken (by `elapsed`). */
    samples: Sample[];
    /** The `elapsed` of the first sample with a dialog (null: never). */
    firstOneElapsed: number | null;
    /** How many times a sample without a dialog follows one with a dialog (in the order taken). */
    backToZero: number;
    maxDialogs: number;
    /** The largest `elapsed - at`; above {@link MAX_LATE_MS} the run proves nothing. */
    maxLate: number;
    indeterminate: boolean;
    /** The dialogs of the last sample really taken by {@link DEADLINE_MS} (-1: none was). */
    lastBeforeDeadline: number;
    /** That sample's `elapsed`. */
    lastBeforeDeadlineElapsed: number | null;
    /** The sample scheduled for 100ms: its dialogs and the `elapsed` it was taken at. */
    at100: number;
    at100Elapsed: number | null;
    /** The last sample (scheduled for {@link SAMPLE_UNTIL_MS}). */
    final: number;
  };

  /** Pure: the judgement of a run from its samples, by their measured `elapsed`. */
  function summarize(raw: Sample[]): Summary {
    const samples = [...raw].sort((x, y) => x.elapsed - y.elapsed || x.at - y.at);
    const first = samples.find((sample) => sample.dialogs >= 1);
    let backToZero = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i - 1].dialogs >= 1 && samples[i].dialogs === 0) backToZero++;
    const maxLate = Math.max(...samples.map((sample) => sample.elapsed - sample.at));
    const inTime = samples.filter((sample) => sample.elapsed <= DEADLINE_MS);
    const lastInTime = inTime.length > 0 ? inTime[inTime.length - 1] : null;
    const hundred = samples.find((sample) => sample.at === 100);
    return {
      samples,
      firstOneElapsed: first ? first.elapsed : null,
      backToZero,
      maxDialogs: Math.max(...samples.map((sample) => sample.dialogs)),
      maxLate,
      indeterminate: samples.length === 0 || maxLate > MAX_LATE_MS,
      lastBeforeDeadline: lastInTime ? lastInTime.dialogs : -1,
      lastBeforeDeadlineElapsed: lastInTime ? lastInTime.elapsed : null,
      at100: hundred ? hundred.dialogs : -1,
      at100Elapsed: hundred ? hundred.elapsed : null,
      final: samples.length > 0 ? samples[samples.length - 1].dialogs : -1,
    };
  }

  /** Pushes to `to` and counts the dialogs every {@link SAMPLE_EVERY_MS}ms to {@link SAMPLE_UNTIL_MS}, in the page. */
  async function pushAndSample(page: Page, to: string): Promise<Summary> {
    const samples = await page.evaluate(
      async ({ to, every, until, skew }) => {
        const router = (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router;
        const out: { at: number; elapsed: number; dialogs: number; path: string }[] = [];
        const start = performance.now();
        router.push(to);
        await new Promise<void>((resolve) => {
          for (let ms = every; ms <= until; ms += every) {
            setTimeout(() => {
              out.push({
                at: ms,
                elapsed: Math.round(performance.now() - start),
                dialogs: document.querySelectorAll('[data-testid="handoff-dialog"]').length,
                path: location.pathname,
              });
              if (ms === until) resolve();
            }, ms + skew);
          }
        });
        return out;
      },
      { to, every: SAMPLE_EVERY_MS, until: SAMPLE_UNTIL_MS, skew: SKEW_MS },
    );
    return summarize(samples);
  }

  /** A waiting for the agent, then B for 4 seconds (no unit: B does not show A's), then back. */
  async function waitingThenAway(page: Page, server: Server): Promise<void> {
    await openHandoff(page, server);
    await expect(page.getByTestId('handoff-state')).toBeVisible();
    await page.evaluate((to) => (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push(to), `/worktrees/${WT2}`);
    await expect(page).toHaveURL(new RegExp(`/worktrees/${WT2}`));
    await page.waitForTimeout(4000);
    // The takeBack rule is unchanged: another worktree's opening without a unit is not shown on B.
    expect(await page.getByTestId('handoff-dialog').count()).toBe(0);
  }

  function record(name: string, summary: Summary): void {
    const line =
      `first=${summary.firstOneElapsed}ms(elapsed) 1→0=${summary.backToZero} max=${summary.maxDialogs} ` +
      `judged@${summary.lastBeforeDeadlineElapsed}ms=${summary.lastBeforeDeadline} 100ms-sample@${summary.at100Elapsed}ms=${summary.at100} ` +
      `final=${summary.final} maxLate=${summary.maxLate}ms${summary.indeterminate ? ' INDETERMINATE' : ''} | ` +
      summary.samples.map((s) => `${s.at}:${s.dialogs}@${s.elapsed}`).join(' ');
    test.info().annotations.push({ type: `G10 ${name}`, description: line });
    console.log(`[G10 ${name}] ${line}`);
  }

  /**
   * The invariant of (a)(b)(c), judged by the measured `elapsed`: a run whose samples fired more than
   * {@link MAX_LATE_MS} after their schedule is indeterminate (it fails, never green); once drawn it
   * stays (0 transitions 1→0); one dialog at most; a dialog seen by 1s, and the last sample really
   * taken by 1s (and the last of all) shows one.
   */
  function expectStays(summary: Summary): void {
    expect(summary.indeterminate, `indeterminate: a sample fired ${summary.maxLate}ms after its schedule (limit ${MAX_LATE_MS}ms)`).toBe(false);
    expect(summary.backToZero).toBe(0);
    expect(summary.maxDialogs).toBeLessThanOrEqual(1);
    expect(summary.firstOneElapsed).not.toBeNull();
    expect(summary.firstOneElapsed as number).toBeLessThanOrEqual(DEADLINE_MS);
    expect(summary.lastBeforeDeadline).toBe(1);
    expect(summary.final).toBe(1);
  }

  /** The 100ms of (a), (b) and (c): recorded, never asserted (a known gap; a note that changes when it is 1). */
  function noteKnownGap(name: string, summary: Summary): void {
    const description =
      summary.at100 === 0
        ? `known gap (not asserted): 100ms=0, first at ${summary.firstOneElapsed}ms (elapsed) — in dev the route's load and its Suspense come before the page exists`
        : `100ms=${summary.at100}: the known gap did not show in this run; if it holds, the note and the design's G10 line can go`;
    test.info().annotations.push({ type: `G10 ${name} 100ms`, description });
    console.log(`[G10 ${name} 100ms] ${description}`);
  }

  function nothingMadeAgain(server: Server): void {
    expect(server.writes.filter((write) => write.path === '')).toHaveLength(1);
    expect(server.sends).toHaveLength(1);
    expect(server.kills).toEqual([]);
  }

  test('(a) a cache hit: once drawn the dialog stays (sampled every 50ms to 3s)', async ({ context, page }) => {
    const server = await stubServer(context);
    server.second = true;
    await waitingThenAway(page, server);
    const summary = await pushAndSample(page, `/worktrees/${WT}`);
    record('(a) cache hit', summary);
    noteKnownGap('(a) cache hit', summary);
    expectStays(summary);
    nothingMadeAgain(server);
  });

  test('(b) a cache miss, the first read held through the samples: one dialog over the Loading, staying (the 100ms value is recorded only)', async ({ context, page }) => {
    const server = await stubServer(context);
    let hold: Promise<void> | null = null;
    let release: () => void = () => undefined;
    // The list never holds A (a cache miss on the way back); B alone.
    await context.route(
      (url) => url.pathname === '/api/worktrees',
      (route) => json(route, 200, { worktrees: [worktreeRow(server, WT2)], repositories: [] }),
    );
    await context.route(
      (url) => url.pathname === `/api/worktrees/${WT}`,
      async (route) => {
        if (hold) await hold;
        return route.fallback();
      },
    );
    await waitingThenAway(page, server);
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const summary = await pushAndSample(page, `/worktrees/${WT}`);
    record('(b) cache miss, first read held', summary);
    noteKnownGap('(b) cache miss, first read held', summary);
    release();
    hold = null;
    expectStays(summary);
    await expect(page.getByTestId('handoff-state')).toBeVisible();
    nothingMadeAgain(server);
  });

  test(`(c) the route's transition held ${ROUTE_HOLD_MS}ms: once drawn the dialog stays (sampled every 50ms to 3s)`, async ({ context, page }) => {
    const server = await stubServer(context);
    server.second = true;
    let holding = false;
    await context.route(
      (url) => url.pathname === `/worktrees/${WT}`,
      async (route) => {
        if (holding && route.request().headers()['rsc'] === '1') await new Promise((done) => setTimeout(done, ROUTE_HOLD_MS));
        return route.fallback();
      },
    );
    await waitingThenAway(page, server);
    holding = true;
    const summary = await pushAndSample(page, `/worktrees/${WT}`);
    holding = false;
    record(`(c) route held ${ROUTE_HOLD_MS}ms`, summary);
    noteKnownGap(`(c) route held ${ROUTE_HOLD_MS}ms`, summary);
    expectStays(summary);
    nothingMadeAgain(server);
  });

  /**
   * Issue #4317 PR2 (d): the host of the dialog is outside the route (`AppShellGate`, beside the
   * shell), so the route's Loading between two worktrees with a unit never takes it away. The start
   * is the cause's: A's unknown unit shown on B as A's (foreign, one dialog); then B → A by
   * `router.push` with the route's RSC request held {@link ROUTE_HOLD_MS}ms, so A's page does not
   * exist for that time and the route's `loading.tsx` is drawn (checked: a run whose request was
   * not held, or whose Loading was never committed, proves nothing and fails).
   *
   * Counted two ways from before the push: a MutationObserver (every notification's DOM; it says
   * nothing of a removal and a re-add inside one batch of records) and the 50ms samples of (a)(b)(c)
   * judged by their measured `elapsed`. The observer is the judgement; the samples are auxiliary:
   * judged as (a)(b)(c) when on time, and when late (indeterminate: a slow runner) only recorded as
   * undecidable in the annotations, the observer's checks deciding the run (#4317 d). Asserted: one
   * dialog at the start, no notification with 0 and none with 2, one at the end, the same DOM node
   * of the dialog all along (one opening: one token); then A's page is back, the foreign notice
   * gone, the unit sent again from it — and the push made no create, send, decide, cancel, end nor
   * kill. Before the fix (the host inside the page) this counts 0 dialogs during the Loading (2
   * notifications with 0, the node changed; the 50ms samples missed both). B settles 4s before the
   * push, as in (a)(b)(c) (a push while B was still loading was seen not to navigate at all).
   */
  test(`(d) B shows A's unknown unit (foreign); B → A with the route held ${ROUTE_HOLD_MS}ms: one dialog, the same node, in every notification`, async ({ context, page }) => {
    const server = await stubServer(context);
    server.second = true;
    let holding = false;
    let held = 0;
    await context.route(
      (url) => url.pathname === `/worktrees/${WT}`,
      async (route) => {
        if (holding && route.request().headers()['rsc'] === '1') {
          held++;
          await new Promise((done) => setTimeout(done, ROUTE_HOLD_MS));
        }
        return route.fallback();
      },
    );
    // A: the hand-off with an unknown decide (as G10's switch test).
    await openHandoff(page, server);
    agent.proposeUpdate(server, 'note-1', 'proposed by the agent');
    agent.done(server);
    await readAgain(page);
    await page.getByTestId('handoff-approve-p-1').click();
    const decidePath = `${BASE}/${RID}/decide`;
    const isDecide = (url: URL) => url.pathname === decidePath;
    let cut: Record<string, unknown> | null = null;
    await page.route(isDecide, (route) => {
      cut = route.request().postDataJSON() as Record<string, unknown>;
      return route.abort('connectionreset');
    });
    await page.getByTestId('handoff-confirm').click();
    await expect(page.getByTestId('handoff-pending')).toBeVisible();
    await page.unroute(isDecide);
    expect(cut).not.toBeNull();
    // B: A's unit shown as A's (one dialog).
    await page.evaluate((to) => (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push(to), `/worktrees/${WT2}`);
    await expect(page).toHaveURL(new RegExp(`/worktrees/${WT2}`));
    await expect(page.getByTestId('handoff-foreign')).toBeVisible();
    await expect(page.getByTestId('handoff-pending')).toBeVisible();
    // As (a)(b)(c): B settles before the push back.
    await page.waitForTimeout(4000);
    await expect(page.getByTestId('handoff-foreign')).toBeVisible();
    const writesBefore = server.writes.map((write) => write.path);
    const sendsBefore = server.sends.length;

    holding = true;
    const run = await page.evaluate(
      async ({ to, every, until, skew, drop }) => {
        const router = (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router;
        const selector = '[data-testid="handoff-dialog"]';
        const dialogs = () => document.querySelectorAll(selector);
        const startNode = document.querySelector(selector);
        const start = dialogs().length;
        const notes: number[] = [];
        let notifications = 0;
        let sameNode = true;
        let loadingSeen = false;
        const look = (): void => {
          const found = dialogs();
          notes.push(found.length);
          if (found.length !== 1 || found[0] !== startNode) sameNode = false;
          if (document.querySelector('[data-testid="route-loading"]')) loadingSeen = true;
        };
        const observer = new MutationObserver(() => {
          notifications++;
          look();
        });
        const samples: { at: number; elapsed: number; dialogs: number; path: string }[] = [];
        let pending = 0;
        let final = -1;
        let finalSame = false;
        const t0 = performance.now();
        try {
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          router.push(to);
          if (drop) {
            // The control's knob (off by default): the same node out for one task, then back.
            setTimeout(() => {
              const node = document.querySelector(selector);
              const parent = node?.parentNode;
              if (!node || !parent) return;
              const next = node.nextSibling;
              parent.removeChild(node);
              setTimeout(() => parent.insertBefore(node, next && next.parentNode === parent ? next : null), 0);
            }, 100);
          }
          await new Promise<void>((resolve) => {
            for (let ms = every; ms <= until; ms += every) {
              setTimeout(() => {
                const count = dialogs().length;
                samples.push({ at: ms, elapsed: Math.round(performance.now() - t0), dialogs: count, path: location.pathname });
                if (document.querySelector('[data-testid="route-loading"]')) loadingSeen = true;
                if (ms === until) resolve();
              }, ms + skew);
            }
          });
          // The records not delivered yet, then the DOM as it is now.
          const records = observer.takeRecords();
          pending = records.length;
          if (pending > 0) look();
          final = dialogs().length;
          finalSame = final === 1 && dialogs()[0] === startNode;
        } finally {
          observer.disconnect();
        }
        return { start, notes, notifications, sameNode, loadingSeen, samples, pending, final, finalSame };
      },
      { to: `/worktrees/${WT}`, every: SAMPLE_EVERY_MS, until: SAMPLE_UNTIL_MS, skew: SKEW_MS, drop: D_DROP_DIALOG },
    );
    holding = false;
    const summary = summarize(run.samples);
    record(`(d) B→A foreign, route held ${ROUTE_HOLD_MS}ms`, summary);
    const line =
      `start=${run.start} notifications=${run.notifications} zeros=${run.notes.filter((n) => n === 0).length} ` +
      `max=${Math.max(0, ...run.notes)} pending=${run.pending} final=${run.final} sameNode=${run.sameNode && run.finalSame} ` +
      `loadingSeen=${run.loadingSeen} held=${held} paths=${[...new Set(run.samples.map((sample) => sample.path))].join('>')}`;
    test.info().annotations.push({ type: 'G10 (d) observer', description: line });
    console.log(`[G10 (d) observer] ${line}`);

    // The run proves something only if the route's request was held and its Loading was committed.
    expect(held, 'the route’s RSC request was not made (a cached run proves nothing)').toBeGreaterThan(0);
    expect(run.loadingSeen, 'the route’s Loading was never committed').toBe(true);
    expect(run.start).toBe(1);
    expect(run.notifications).toBeGreaterThan(0);
    expect(run.notes.filter((n) => n === 0)).toEqual([]);
    expect(Math.max(...run.notes)).toBeLessThanOrEqual(1);
    expect(run.final).toBe(1);
    expect(run.sameNode && run.finalSame, 'the dialog’s DOM node changed within one opening').toBe(true);
    // The samples are the auxiliary (#4317 d, PM's decision): the observer above is the judgement.
    // A run whose samples fired late (a slow runner) cannot judge by them: the sample checks are
    // recorded as undecidable and the observer's verdict stands. On time, they are judged as
    // (a)(b)(c), and none at 0 from the start.
    if (summary.indeterminate) {
      const undecidable =
        `undecidable (not asserted): a sample fired ${summary.maxLate}ms after its schedule (limit ${MAX_LATE_MS}ms); ` +
        `expectStays and "no sample at 0" not judged, the MutationObserver's checks above decided this run ` +
        `(samples at 0: ${summary.samples.filter((sample) => sample.dialogs === 0).length})`;
      test.info().annotations.push({ type: 'G10 (d) samples', description: undecidable });
      console.log(`[G10 (d) samples] ${undecidable}`);
    } else {
      expectStays(summary);
      expect(summary.samples.filter((sample) => sample.dialogs === 0)).toEqual([]);
    }

    // A's page is back: its own dialog (not foreign), the unit there to send again.
    await expect(page).toHaveURL(new RegExp(`/worktrees/${WT}(?:$|[?#])`));
    await expect(page.getByTestId('desktop-kill-session')).toBeVisible();
    await expect(page.getByTestId('handoff-foreign')).toHaveCount(0);
    await expect(page.getByTestId('handoff-pending-resend')).toBeEnabled();
    // The push made nothing: no create, send, decide, cancel, end nor kill.
    expect(server.writes.map((write) => write.path)).toEqual(writesBefore);
    expect(server.sends).toHaveLength(sendsBefore);
    expect(server.kills).toEqual([]);
    expect(server.proposals[0].state).toBe('proposed');
    // Sent again by the person, as it was cut: to A's request, with its version and decisions.
    await page.getByTestId('handoff-pending-resend').click();
    await expect.poll(() => server.proposals[0].state).toBe('applied');
    const decides = server.writes.filter((write) => write.path === `/${RID}/decide`);
    expect(decides).toHaveLength(1);
    expect(decides[0].body).toEqual(cut);
    expect(server.kills).toEqual([]);
  });
});
