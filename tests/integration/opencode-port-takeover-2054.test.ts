/**
 * A port that changed hands, over real sockets (Issue #2054).
 *
 * The unit suite stubs `./client`, so it proves the *fold* is right and nothing
 * about the HTTP. This one runs the whole path against real listeners: a server
 * that speaks opencode's `/global/health` and `/event`, a subscription that
 * connects to it, and then a **different** process on the same port answering a
 * different `version`. That is the shape of the failure the feature is for — the
 * pane's server died and something else took 4818 — and the reason it needs a
 * socket is that `probeOpencodeHealth` refuses anything that is not opencode's
 * health document by content type, which a stub cannot exercise.
 *
 * Mirrors the live measurement in
 * `docs/design/opencode-server-live-verification.md` §25, where the same
 * sequence was run against a real opencode 1.18.22 on an isolated HOME. The
 * expected values here are read from the fixture that measurement produced, so
 * this test cannot drift away from what the real server did.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { readFileSync } from 'fs';
import { once } from 'events';
import { AddressInfo } from 'net';
import {
  closeOpencodeSubscription,
  getOpencodeLiveness,
  isOpencodeSubscribed,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';

const LIVE = JSON.parse(
  readFileSync('tests/fixtures/opencode-liveness-2054/live-probe.json', 'utf-8')
) as { publishedStates: Record<string, Record<string, string>> };

const TARGET = { worktreeId: 'wt-2054-int', cliToolId: 'opencode', instanceId: 'opencode' } as const;

let servers: Server[] = [];

/**
 * A listener that answers opencode's health document with `version`, and — when
 * `withStream` — an `/event` stream that says hello and stays open.
 */
async function listen(version: string, withStream: boolean, port = 0): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version }));
      return;
    }
    if (req.url === '/event' && withStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // `server.connected` is what moves the subscription to `live`.
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server;
}

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

beforeEach(() => {
  servers = [];
  resetOpencodeSubscriptions();
});

afterEach(async () => {
  await closeOpencodeSubscription(TARGET);
  resetOpencodeSubscriptions();
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  servers = [];
});

describe('[#2054] a real port handed to a real other process', () => {
  it('publishes scraper / stale / port_identity_changed, and keeps saying so', async () => {
    const opencode = await listen('1.18.22', true);
    const port = portOf(opencode);

    await openOpencodeSubscription(
      TARGET,
      () => {},
      (raw) => opencodeAgentEventSource.normalizeEvent(raw),
      { port, resync: opencodeAgentEventSource.capabilities.resync }
    );

    await expect
      .poll(() => getOpencodeLiveness(TARGET).state, { timeout: 5_000 })
      .toBe('live');
    expect(
      describeAgentEventSource(opencodeAgentEventSource, getOpencodeLiveness(TARGET), Date.now())
    ).toEqual(LIVE.publishedStates.live);

    // The pane's server dies and a squatter takes the port. The subscription's
    // next reconnect probes health first — that is #1900's health-before-trust —
    // and refuses to believe anything on a port whose version moved.
    opencode.closeAllConnections?.();
    await new Promise<void>((resolve) => opencode.close(() => resolve()));
    servers = servers.filter((s) => s !== opencode);
    await listen('9.9.9-squatter', false, port);

    await expect
      .poll(() => isOpencodeSubscribed(TARGET), { timeout: 15_000 })
      .toBe(false);
    await expect
      .poll(() => getOpencodeLiveness(TARGET).state, { timeout: 15_000 })
      .toBe('lost');

    const liveness = getOpencodeLiveness(TARGET);
    expect(liveness.state === 'lost' && liveness.reason).toBe('port_identity_changed');
    // The part that used to be impossible: the subscription is gone from the
    // map, and the reason survives it.
    expect(
      describeAgentEventSource(opencodeAgentEventSource, liveness, Date.now())
    ).toEqual(LIVE.publishedStates.portIdentityChanged);

    // …until the pane itself is closed, at which point there is nothing left to
    // report about a process that no longer exists.
    await closeOpencodeSubscription(TARGET);
    expect(getOpencodeLiveness(TARGET)).toEqual({ state: 'unknown' });
    expect(
      describeAgentEventSource(opencodeAgentEventSource, getOpencodeLiveness(TARGET), Date.now())
    ).toEqual(LIVE.publishedStates.afterClose);
  }, 30_000);
});
