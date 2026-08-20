/**
 * The canary's own `PermissionRequest` receiver (Issue #1847).
 *
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT
 * ----------------------------------------
 * Auto-Yes v2 (#1724) does not answer a dialog — it answers a *hook*, before
 * the dialog exists, and the whole feature rests on two behaviours of Claude
 * Code that no test in this repository can observe:
 *
 *  - a `{"hookSpecificOutput":{...,"decision":{"behavior":"allow"}}}` reply
 *    makes the tool run **with no dialog at all**, and
 *  - an empty reply (`{}`) lands back in the ordinary approval flow, i.e. the
 *    dialog appears and a human answers it (#1721 D5).
 *
 * Both are upstream contracts. A Claude release can change either one silently,
 * and the visible consequence — "the worker sat there" or, far worse, "the
 * worker approved something nobody saw" — arrives in production. So this module
 * puts a real receiver behind a real TUI and lets the two scenarios in
 * `scenarios.ts` watch what the screen does.
 *
 * HOW MUCH OF THE PRODUCTION PATH IS REAL
 * ---------------------------------------
 * Everything except the two places that need a database, and the HTTP framing:
 *
 * | production                                   | here                                   |
 * |---|---|
 * | `buildAgentHookSettings` writes the settings | the same function, `port` overridden   |
 * | `claudeAgentEventSource.parsePermissionRequest` | the same, via the registry          |
 * | `resolvePermissionRequest` decides            | the same function, called directly    |
 * | `claudeAgentEventSource.encodeVerdict`        | the same, via the registry            |
 * | `recordAgentEvent` / `reportPermissionRequestPending` / `recordPolicySuppression` | the same modules (all in-memory) |
 * | policy read from the active task row          | supplied by the scenario (no DB)      |
 * | `allow` written to the prompt history         | dropped (no DB)                       |
 * | Next.js route + middleware auth               | `node:http`, no auth                   |
 *
 * The two substitutions go through {@link PermissionDecisionDeps}, which exists
 * for this caller. Re-implementing the verdict table here instead would have
 * created a second ordering of it, free to drift from the one that decides
 * whether a command runs unattended — and drift toward permissive is invisible
 * to every assertion the canary makes.
 *
 * ISOLATION
 * ---------
 * The server binds `127.0.0.1` on port **0** (the kernel picks a free one), so
 * the canary can never collide with the operator's server on 3000 — or with a
 * worktree server, or with another canary run. The port is read back from the
 * listening socket and baked into the settings file, which itself is written
 * inside the throwaway HOME.
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setAutoYesEnabled } from '@/lib/auto-yes-state';
import { isAgentEventType, MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import {
  PERMISSION_REQUEST_PATH,
  AGENT_EVENT_PATH,
} from '@/lib/hooks/hook-settings-generator';
import {
  resolvePermissionRequest,
  type PermissionDecision,
} from '@/lib/hooks/permission-decision-service';
import { getAgentEventSource, type AgentEventSource, type Verdict } from '@/lib/hooks/sources';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import { getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import {
  getLastAgentEvent,
  isDuplicateAgentEvent,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { resolvePromptWaiting } from '@/lib/session/prompt-waiting-composition';
import { CANARY_CLI_TOOL } from './probe';
import type { HookDelivery, HookObservation, Observation } from './types';

/** Loopback only. The receiver must not be reachable from anywhere else. */
export const RECEIVER_HOST = '127.0.0.1';

/** Body cap, so a runaway payload cannot exhaust the canary's memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The one instance id these scenarios use: the primary (=== the tool id). */
export const CANARY_INSTANCE_ID: string = CANARY_CLI_TOOL;

/** The session the receiver is currently answering for. */
export interface CanaryHookSession {
  /** Correlation key baked into the injected URL. Never a real worktree. */
  worktreeId: string;
  /** Contract policy the adjudicator judges this session's requests against. */
  policy: AutoYesPolicy | null;
  /** Absolute path of the file the probe prompt asks Claude to write. */
  probeFilePath: string;
  /**
   * Answer the OPPOSITE of what the adjudicator decided (`--mutate-verdict`).
   *
   * The mutation Issue #1847 asks for, and the only one that can prove these
   * two scenarios are non-vacuous: both of them expect the screen a session
   * with no verdict at all would show, so a wrong *predicate* is not what
   * distinguishes a working receiver from a broken one — a wrong *reply* is.
   */
  invertVerdict: boolean;
}

/** A verdict, and the reply that was actually written back. */
function invert(verdict: Verdict): Verdict {
  return verdict.kind === 'allowOnce' ? { kind: 'abstain' } : { kind: 'allowOnce' };
}

/** Read a request body with a hard cap; resolves to `null` when it is not JSON. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A string field, or null when absent or of the wrong type. */
function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A `claude`-only hook receiver on an ephemeral loopback port.
 *
 * One instance serves the whole run; {@link beginSession} re-points it at the
 * scenario about to start and clears the delivery log, so a scenario can never
 * assert on another scenario's traffic.
 */
export class CanaryHookReceiver {
  private readonly deliveries: HookDelivery[] = [];
  private session: CanaryHookSession | null = null;
  private readonly source: AgentEventSource = getAgentEventSource(CANARY_CLI_TOOL);

  private constructor(
    private readonly server: Server,
    /** Port the kernel assigned. Baked into the injected settings file. */
    readonly port: number,
    private readonly log: (message: string) => void
  ) {}

  /** Bind `127.0.0.1:0` and start serving. */
  static async start(log: (message: string) => void): Promise<CanaryHookReceiver> {
    const server = createServer();
    const receiver = await new Promise<CanaryHookReceiver>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, RECEIVER_HOST, () => {
        const address = server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error('canary: hook receiver could not resolve its own port'));
          return;
        }
        resolve(new CanaryHookReceiver(server, address.port, log));
      });
    });
    server.on('request', (request, response) => {
      void receiver.handle(request, response);
    });
    return receiver;
  }

  /**
   * Point the receiver at the scenario about to run.
   *
   * Auto-Yes is enabled here rather than in the scenario because it is a
   * precondition of the adjudicator reaching the policy at all: with it off,
   * `decidePermissionRequest` answers `auto-yes-disabled` and both scenarios
   * would be measuring the same branch.
   */
  beginSession(session: CanaryHookSession): void {
    this.deliveries.length = 0;
    this.session = session;
    setAutoYesEnabled(session.worktreeId, CANARY_CLI_TOOL, true, undefined, undefined, CANARY_INSTANCE_ID);
  }

  /** Stop answering for the current scenario. */
  endSession(): void {
    if (this.session) {
      setAutoYesEnabled(
        this.session.worktreeId,
        CANARY_CLI_TOOL,
        false,
        undefined,
        undefined,
        CANARY_INSTANCE_ID
      );
    }
    this.session = null;
  }

  /**
   * The structured layer's view, read from the modules `buildCurrentOutput`
   * reads it from.
   *
   * `resolvePromptWaiting` is called with the scraper's verdict for the frame
   * just captured, exactly as the payload builder calls it — and that is not a
   * formality: it is the only place the scraper's observations reach the
   * structured record, so skipping it would leave a provisional
   * `permission-request` record to expire after 20 s
   * (`STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS`) in the middle of a scenario
   * that is still waiting for the dialog it describes.
   *
   * @param scraper - The observation built from the frame just captured
   */
  observe(scraper: Observation): HookObservation {
    const session = this.session;
    if (!session) {
      throw new Error('canary: hook receiver observed with no scenario session configured');
    }
    const lastEvent = getLastAgentEvent(session.worktreeId, CANARY_CLI_TOOL, CANARY_INSTANCE_ID);
    const promptWaiting = resolvePromptWaiting({
      worktreeId: session.worktreeId,
      cliToolId: CANARY_CLI_TOOL,
      instanceId: CANARY_INSTANCE_ID,
      scraper: {
        status: scraper.status.status,
        reason: scraper.status.reason,
        hasActivePrompt: scraper.status.hasActivePrompt,
      },
    }).structured;

    return {
      deliveries: [...this.deliveries],
      structuredEvents: {
        lastEventType: lastEvent?.event ?? null,
        lastEventAt: lastEvent?.at ?? null,
        lastEventDetail: lastEvent?.detail ?? null,
        promptWaitingSince: promptWaiting?.at ?? null,
        promptWaitingSource: promptWaiting?.source ?? null,
      },
      lastSuppression: getLastPolicySuppression(
        session.worktreeId,
        CANARY_CLI_TOOL,
        CANARY_INSTANCE_ID
      ),
      probeFileWritten: existsSync(session.probeFilePath),
    };
  }

  /** Close the socket and drop every keep-alive connection. */
  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${RECEIVER_HOST}:${this.port}`);
    const body = (await readJsonBody(request)) ?? {};

    if (request.method !== 'POST') {
      respond(response, 405, { error: 'method not allowed' });
      return;
    }
    if (url.pathname === PERMISSION_REQUEST_PATH) {
      respond(response, 200, this.answerPermissionRequest(body, url));
      return;
    }
    if (url.pathname === AGENT_EVENT_PATH) {
      this.recordEvent(body, url);
      respond(response, 202, { accepted: true });
      return;
    }
    respond(response, 404, { error: 'unknown path' });
  }

  /**
   * Adjudicate one `PermissionRequest` and write the verdict back.
   *
   * Mirrors `src/app/api/hooks/permission-request/route.ts` minus the parts
   * this process has no equivalent of (worktree lookup, auth, logging).
   */
  private answerPermissionRequest(
    body: Record<string, unknown>,
    url: URL
  ): Record<string, unknown> {
    const session = this.session;
    const worktreeId = url.searchParams.get('worktreeId');
    if (!session || worktreeId !== session.worktreeId) {
      // Not this scenario's request: abstain in the tool's own dialect, exactly
      // as the route does for a target it cannot resolve.
      return encodeBody(this.source, { kind: 'abstain' });
    }

    const payload = this.source.parsePermissionRequest(body);
    const decision: PermissionDecision = resolvePermissionRequest(
      { worktreeId: session.worktreeId, cliToolId: CANARY_CLI_TOOL, instanceId: CANARY_INSTANCE_ID },
      payload,
      {
        readPolicy: () => session.policy,
        // No database, so no prompt-history row. The audit write is the one
        // production side effect this canary deliberately drops; it is covered
        // by `tests/unit/hooks/permission-decision-service.test.ts`.
        recordAllow: () => undefined,
      }
    );

    const decided: Verdict = decision.behavior === 'allow' ? { kind: 'allowOnce' } : { kind: 'abstain' };
    const sent = session.invertVerdict ? invert(decided) : decided;

    this.deliveries.push({
      eventName: readString(body, 'hook_event_name') ?? 'PermissionRequest',
      toolName: payload?.toolName ?? readString(body, 'tool_name'),
      at: Date.now(),
      behavior: decision.behavior,
      reason: decision.reason,
      inverted: session.invertVerdict,
    });
    this.log(
      `  hook: PermissionRequest tool=${payload?.toolName ?? '<unparsed>'} ` +
        `→ ${decision.behavior ?? 'no-decision'} (${decision.reason})` +
        (session.invertVerdict ? ` [MUTATED: sent ${sent.kind}]` : '')
    );

    return encodeBody(this.source, sent);
  }

  /**
   * Record one lifecycle event, so `structuredEvents.lastEventType` means what
   * it means in `capture --json`.
   *
   * `AskUserQuestion` bodies are deliberately not filed as questions here (the
   * route does that for `pre_tool_use`): neither scenario asks a question, and
   * a canary that recorded one would be asserting on a path #1726 owns.
   */
  private recordEvent(body: Record<string, unknown>, url: URL): void {
    const session = this.session;
    const worktreeId = url.searchParams.get('worktreeId') ?? readString(body, 'worktreeId');
    if (!session || worktreeId !== session.worktreeId) return;

    const receivedAt = Date.now();
    // The relay script (`SessionStart`, the one event Claude refuses to deliver
    // over http — D1) names the word itself; the http hooks carry
    // `hook_event_name` and the source reads it.
    const relayEvent = readString(body, 'event');
    const normalized = this.source.normalizeEvent({
      payload: body,
      event: isAgentEventType(relayEvent) ? relayEvent : null,
      receivedAt,
    });
    if (!normalized) return;

    const detail =
      normalized.detail ?? readString(body, 'detail')?.slice(0, MAX_EVENT_DETAIL_LENGTH) ?? null;
    const sessionId = readString(body, 'sessionId') ?? readString(body, 'session_id');
    if (
      isDuplicateAgentEvent(
        session.worktreeId,
        CANARY_CLI_TOOL,
        CANARY_INSTANCE_ID,
        normalized.event,
        sessionId ?? undefined,
        receivedAt,
        detail
      )
    ) {
      return;
    }

    recordAgentEvent(session.worktreeId, CANARY_CLI_TOOL, CANARY_INSTANCE_ID, {
      event: normalized.event,
      at: receivedAt,
      detail,
      sessionId,
      message: readString(body, 'message'),
      model: normalized.model,
    });
    this.deliveries.push({
      eventName: readString(body, 'hook_event_name') ?? relayEvent ?? normalized.event,
      toolName: readString(body, 'tool_name'),
      at: receivedAt,
      behavior: null,
      reason: null,
      inverted: false,
    });
  }
}

/** The source's own spelling of a verdict, as a response body. */
function encodeBody(source: AgentEventSource, verdict: Verdict): Record<string, unknown> {
  const encoded = source.encodeVerdict(verdict);
  return encoded.kind === 'responseBody' ? encoded.body : {};
}

function respond(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(json)),
  });
  response.end(json);
}
