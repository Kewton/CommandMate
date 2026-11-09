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

const WT = 'e2e-handoff-4227';
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
    if (server.request && OPEN.includes(server.request.state)) return json(route, 409, { ...view(server), ok: false, code: 'request_open' });
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

function worktreeRow(server: Server) {
  const status = { isRunning: server.running, isWaitingForResponse: false, isProcessing: false };
  return {
    id: WT,
    name: 'feat/handoff',
    path: `/tmp/${WT}`,
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
    gitStatus: { currentBranch: 'feat/handoff', initialBranch: 'feat/handoff', isBranchMismatch: false, commitHash: 'e2e0000', isDirty: false },
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

      if (pathname === '/api/worktrees') return ok({ worktrees: [worktreeRow(server)], repositories: [] });
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
