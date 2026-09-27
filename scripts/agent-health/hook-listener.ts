/**
 * The HTTP listener the probe sessions' hooks are pointed at (Issue #2878).
 *
 * It stands in for the two CommandMate receivers
 * (`/api/hooks/agent-event`, `/api/hooks/permission-request`) and does exactly
 * one thing with what arrives: records the correlation keys, read the same way
 * `src/app/api/hooks/agent-event/route.ts` reads them (body first, then the
 * query string; the event word through the tool's own `normalizeEvent`).
 *
 * Permission requests are answered with the source's own "no decision"
 * encoding, so the CLI draws its approval dialog — which `screen-approval`
 * needs on screen.
 */

import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { isCliToolType } from '@/lib/cli-tools/types';
import { isAgentEventType } from '@/lib/hooks/agent-event-types';
import { AGENT_EVENT_PATH, PERMISSION_REQUEST_PATH } from '@/lib/hooks/hook-settings-generator';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { HookDelivery } from '@/lib/agent-health/hook-correlation';

export const LISTENER_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;

/** A delivery plus what actually arrived, for evidence. */
export interface RecordedDelivery extends HookDelivery {
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

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

function readEventWord(tool: string | null, body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  if (isAgentEventType(body.event)) return body.event;
  if (tool === null || !isCliToolType(tool)) return null;
  try {
    return getAgentEventSource(tool).normalizeEvent({ payload: body, event: null })?.event ?? null;
  } catch {
    return null;
  }
}

/** The body a permission hook gets back: the tool's own "no decision". */
function abstainBody(tool: string | null): Record<string, unknown> {
  if (tool === null || !isCliToolType(tool)) return {};
  try {
    const encoded = getAgentEventSource(tool).encodeVerdict({ kind: 'abstain' });
    return encoded.kind === 'responseBody' ? encoded.body : {};
  } catch {
    return {};
  }
}

export class HookListener {
  readonly deliveries: RecordedDelivery[] = [];

  private constructor(
    private readonly server: Server,
    readonly port: number
  ) {}

  static async start(): Promise<HookListener> {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LISTENER_HOST, () => {
        const address = server.address() as AddressInfo | null;
        if (address) resolve(address.port);
        else reject(new Error('agent-health: listener could not resolve its port'));
      });
    });
    const listener = new HookListener(server, port);
    server.on('request', (request, response) => {
      void listener.handle(request).then(
        ({ status, body }) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        },
        () => {
          response.writeHead(500);
          response.end();
        }
      );
    });
    return listener;
  }

  /** Base URL of the agent-event receiver (no query string). */
  get agentEventUrl(): string {
    return `http://${LISTENER_HOST}:${this.port}${AGENT_EVENT_PATH}`;
  }

  private async handle(
    request: IncomingMessage
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = new URL(request.url ?? '/', `http://${LISTENER_HOST}`);
    const kind =
      url.pathname === AGENT_EVENT_PATH
        ? 'agent-event'
        : url.pathname === PERMISSION_REQUEST_PATH
          ? 'permission-request'
          : null;
    if (request.method !== 'POST' || kind === null) return { status: 404, body: {} };

    const body = await readJsonBody(request);
    const query = Object.fromEntries(url.searchParams.entries());
    const tool = readString(body, 'tool') ?? query.tool ?? null;
    this.deliveries.push({
      kind,
      tool,
      event: kind === 'agent-event' ? readEventWord(tool, body) : 'permission_request',
      worktreeId: readString(body, 'worktreeId') ?? query.worktreeId ?? null,
      instanceId: readString(body, 'instanceId') ?? query.instanceId ?? null,
      receivedAt: Date.now(),
      query,
      body,
    });
    return kind === 'agent-event'
      ? { status: 202, body: { accepted: true } }
      : { status: 200, body: abstainBody(tool) };
  }

  forTool(tool: string): RecordedDelivery[] {
    return this.deliveries.filter((delivery) => delivery.tool === tool);
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }
}
