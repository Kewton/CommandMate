/**
 * The startup sweep and the lazy resume in `OpenCodeV2Tool.isRunning` can race
 * for the same pane after a CommandMate restart (Issue #2934). Both end in
 * `resumeOpencodeV2EventStream`; this pins that, however they interleave, the
 * instance ends up with ONE event stream.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { resumeOpencodeV2EventStream } from '@/lib/hooks/sources/opencode-v2/runtime';
import {
  OPENCODE_V2_PORT_RANGE,
  opencodeV2PortCandidates,
  rememberOpencodeV2Port,
  resetOpencodeV2PortAssignments,
} from '@/lib/hooks/sources/opencode-v2/ports';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import {
  isOpencodeV2Subscribed,
  resetOpencodeV2Subscriptions,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import { reattachOpencodeV2EventStreams } from '@/lib/hooks/sources/opencode-v2/reattach';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const target: AgentInstanceRef = {
  worktreeId: 'wt-2934-once',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

let dir: string;
let server: Server;
let streams: ServerResponse[];

beforeEach(async () => {
  dir = makeTempDir('cm-2934-once-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  resetOpencodeV2PortAssignments();
  writeOpencodeV2Password(target);
  streams = [];
  server = createServer((req, res) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      streams.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  // The persisted assignment is only trusted inside OpenCode V2's own range,
  // so the stand-in server has to live there too.
  let port = 0;
  for (const candidate of opencodeV2PortCandidates(target)) {
    const bound = await new Promise<boolean>((done) => {
      server.once('error', () => done(false));
      server.listen(candidate, '127.0.0.1', () => done(true));
    });
    if (bound) {
      port = candidate;
      break;
    }
  }
  expect(port).toBeGreaterThanOrEqual(OPENCODE_V2_PORT_RANGE.min);
  rememberOpencodeV2Port(target, port, '/repos/wt');
  // A restart: the assignment survives on disk only.
  resetOpencodeV2PortAssignments();
});

afterEach(async () => {
  resetOpencodeV2Subscriptions();
  resetOpencodeV2PortAssignments();
  for (const res of streams) res.destroy();
  await new Promise<void>((done) => server.close(() => done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('startup reattach + lazy resume (Issue #2934)', () => {
  it('opens one stream however many resumes race for the pane', async () => {
    const results = await Promise.all([
      reattachOpencodeV2EventStreams({
        isPaneRunning: async () => true,
        resolveWorktreePath: () => '/repos/wt',
        resume: resumeOpencodeV2EventStream,
      }),
      resumeOpencodeV2EventStream(target, '/repos/wt'),
      resumeOpencodeV2EventStream(target, '/repos/wt'),
    ]);

    expect(results[0]).toMatchObject({ known: 1, candidates: 1, reattached: 1, swept: 0 });
    expect(results.slice(1)).toEqual([true, true]);
    expect(isOpencodeV2Subscribed(target)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(streams).toHaveLength(1);

    // A later poll finds the subscription and does not open another.
    expect(await resumeOpencodeV2EventStream(target, '/repos/wt')).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(streams).toHaveLength(1);
  });
});
