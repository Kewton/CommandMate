/**
 * `commandmate wait`'s real exit code on an idle Claude composer
 * (Issue #2011, 受入条件 4).
 *
 * ## Why this is a spawn and not a unit test
 *
 * The acceptance condition is an EXIT CODE, and `wait` reaches its by calling
 * `process.exit` inside a commander action. Nothing short of running the command
 * as a process can observe that, and the Issue is explicit about the reason it
 * has to be observed rather than reasoned about: the reported symptom was
 * `exit 124` on a session that was sitting at its composer doing nothing, and
 * `/orchestrate`'s whole adjudication loop is `wait --verify`.
 *
 * ## What is real here, and what is not
 *
 * Real: the 200x1000 Claude capture, the detector, `buildCurrentOutput`, the
 * payload bytes, the `wait` binary, and the exit code — which is written to a
 * variable and asserted, never piped into a matcher that could swallow it.
 *
 * Stubbed: the HTTP server, which serves one captured payload for every poll.
 * That is the seam this Issue lives on either side of and nothing in between —
 * `wait` reads `GET /api/worktrees/<id>/current-output` and nothing else that
 * decides the verdict — so a live server and a live tmux session would add a
 * tmux round-trip and an agent process without adding a fact.
 *
 * Measured on this branch (`> log; echo $?` into a file, before and after):
 *
 * | payload                     | before #2011 | after |
 * |-----------------------------|--------------|-------|
 * | idle-tail-model-saved       | **124**      | 0     |
 * | idle-turn-complete-marker   | 0            | 0     |
 * | help-overlay                | 124          | 124   |
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/unit/lib/detection/fixtures/claude-live-2011');
const CLI_ENTRY = path.join(REPO_ROOT, 'src/cli/index.ts');
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');

/** The payload the real builder produces for one real capture. */
async function payloadFor(fixture: string): Promise<unknown> {
  vi.mocked(captureSessionOutput).mockResolvedValue(
    readFileSync(path.join(FIXTURE_DIR, `${fixture}.txt`), 'utf8'),
  );
  return buildCurrentOutput({} as Database.Database, 'wt-1', 'claude', 'claude');
}

/** One stub server per test, serving `payload` for every current-output poll. */
function startStub(payload: unknown): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname.endsWith('/current-output')) {
        res.end(JSON.stringify(payload));
        return;
      }
      // `wait` reads the message ledger to tell "sent a moment ago" from "idle
      // before this wait began" (#1975). An empty ledger is the second, which is
      // what this Issue's session is.
      if (pathname.endsWith('/messages')) {
        res.end('[]');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/**
 * Run the real `wait` against `port` and return what it exited with.
 *
 * `code` is null only when a signal killed the process, which is never a verdict
 * — see the exit>=128 note in the Issue's working rules. Reported as -1 so an
 * assertion on it fails loudly rather than matching `0` by coercion.
 */
function runWait(port: number, timeoutSeconds: number): Promise<{ code: number; log: string }> {
  return new Promise(resolve => {
    const child = spawn(
      TSX,
      [CLI_ENTRY, 'wait', 'probe', '--instance', 'claude', '--timeout', String(timeoutSeconds)],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CM_PORT: String(port), CM_BIND: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let log = '';
    child.stdout.on('data', chunk => (log += String(chunk)));
    child.stderr.on('data', chunk => (log += String(chunk)));
    child.on('close', (code, signal) => {
      resolve({ code: signal !== null ? -1 : (code ?? -1), log });
    });
  });
}

async function waitOn(
  fixture: string,
  timeoutSeconds: number,
): Promise<{ code: number; log: string }> {
  const payload = await payloadFor(fixture);
  const { server, port } = await startStub(payload);
  try {
    return await runWait(port, timeoutSeconds);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

beforeAll(() => {
  // The worst case for this Issue: Claude's idle rule enforcing and declining.
  // Under the shipped `observe` these frames publish `'positive'` and `wait`
  // would complete even on the broken build, so the regression would not be
  // reproducible from this suite at all.
  process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
});

afterAll(() => {
  delete process.env[IDLE_EVIDENCE_ENV_VAR];
});

describe('[#2011] wait on an idle Claude composer', () => {
  it(
    'completes with exit 0 on a pane whose tail row is a /model result',
    async () => {
      // The reported failure, byte for byte: on develop this printed
      // `Waiting: probe (status=ready, running=true, prompt=false)` three times
      // and exited 124.
      const { code, log } = await waitOn('idle-tail-model-saved', 15);

      expect(code, log).toBe(0);
      expect(log).toContain('Completed: probe');
    },
    60_000,
  );

  it(
    'still refuses to complete on a real /help overlay',
    async () => {
      // The control. `wait` must NOT have been made to complete on everything:
      // an unreadable pane is still one it holds, and with a `--timeout` under
      // the 60s unclassified dwell it reports 124 rather than 10.
      const { code, log } = await waitOn('help-overlay', 1);

      expect(code, log).toBe(124);
      expect(log).toContain('Timeout: probe');
    },
    60_000,
  );
});
