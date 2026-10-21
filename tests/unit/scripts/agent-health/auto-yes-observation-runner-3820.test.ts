/**
 * Issue #3820 PR 4: `auto-yes-observation` from the production log files, the
 * way the daily run reads them (`server.log` first, then the rotated ones).
 * Every log is written under os.tmpdir(); the real `logs/server.log` is never read.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateServerLog, measureAll, type RunnerContext } from '../../../../scripts/agent-health/metrics-runners';
import { measureAutoYesObservation } from '@/lib/agent-health/auto-yes-observation';

const H = 60 * 60 * 1000;
const NOW = new Date('2026-10-21T07:30:00.000Z');
const E = Date.UTC(2026, 9, 21, 7, 0, 0);
const S = E - 24 * H;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-auto-yes-observation-3820-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return { repoRoot: root, workDir: path.join(root, 'work'), deadline: Date.now() + 60_000, env: process.env, log: () => undefined, ...overrides };
}

const ledger = (event: string, data: Record<string, unknown>) =>
  `[${new Date(data.atMs as number).toISOString()}] [INFO] [auto-yes-confirmation-ledger] ${event} ${JSON.stringify({ ledgerVersion: 1, bootId: 'bootsecret', ...data })}`;

function alive(at: number): string {
  return ledger('auto-yes-ledger-alive', {
    atMs: at,
    logLevel: 'info',
    segments: [{ path: 'screen', startMs: at - H, endMs: at }],
    openConfirmations: 0,
    openIntervals: 0,
    ledgerErrors: 0,
  });
}

const interval = { confirmationId: 'bootsecret-1', intervalId: 'bootsecret-1#1', cliToolId: 'claude', source: 'screen' };

/** The older half of the day goes to `server.log.1` (with the hour before the window), the newer half to `server.log`. */
function writeLogs(): { current: string; rotated: string } {
  const dir = path.join(root, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const older = [`[${new Date(S - 2 * H).toISOString()}] [INFO] [boot] ready`];
  for (let at = S; at <= S + 12 * H; at += H) older.push(alive(at));
  older.push(
    ledger('auto-yes-withhold-started', { ...interval, atMs: S + 11 * H, reason: 'type-not-allowed', startedAtMs: S + 11 * H }),
    ledger('auto-yes-confirmation-checkpoint', {
      atMs: S + 12 * H,
      confirmationId: 'bootsecret-1',
      cliToolId: 'claude',
      source: 'screen',
      presence: 'present',
      answerability: 'withheld',
      withheldMsTotal: H,
      intervalId: 'bootsecret-1#1',
      reason: 'type-not-allowed',
      intervalStartedAtMs: S + 11 * H,
      intervalMs: H,
    })
  );
  const newer: string[] = [];
  for (let at = S + 13 * H; at <= E; at += H) newer.push(alive(at));
  newer.push(
    ledger('auto-yes-withhold-ended', {
      ...interval,
      atMs: S + 13 * H + 30 * 60 * 1000,
      startedAtMs: S + 11 * H,
      endedAtMs: S + 13 * H + 30 * 60 * 1000,
      withheldMs: 2.5 * H,
      end: 'gone',
      lastReason: 'type-not-allowed',
    })
  );
  const current = path.join(dir, 'server.log');
  const rotated = path.join(dir, 'server.log.1');
  fs.writeFileSync(rotated, `${older.join('\n')}\n`);
  fs.writeFileSync(current, `${newer.join('\n')}\n`);
  return { current, rotated };
}

describe('auto-yes-observation from the production log (Issue #3820 PR 4)', () => {
  it('reads the same log as the performance metrics, across a rotation, and publishes no id', async () => {
    const { current } = writeLogs();
    const results = await measureAll(ctx({ serverLog: current, now: NOW }), ['auto-yes-observation']);
    expect(results[0]).toMatchObject({
      metricId: 'auto-yes-observation',
      status: 'ok',
      value: 150,
      findings: {},
      details: { coveredMs: 24 * H, withheldMsTotal: 2.5 * H, withheldIntervals: 1, partial: 1 },
    });
    expect(JSON.stringify(results)).not.toMatch(/bootsecret/);

    const none = await measureAll(ctx({ serverLog: null, now: NOW }), ['auto-yes-observation']);
    expect(none[0]).toMatchObject({ metricId: 'auto-yes-observation', status: 'skip' });
  });

  it('gives the same result when the rotated file is read first (read order is not time order)', async () => {
    const { current, rotated } = writeLogs();
    const newestFirst = await aggregateServerLog([current, rotated], NOW);
    const oldestFirst = await aggregateServerLog([rotated, current], NOW);
    expect(measureAutoYesObservation(oldestFirst.autoYes, oldestFirst)).toEqual(
      measureAutoYesObservation(newestFirst.autoYes, newestFirst)
    );
  });

  it('still reads a rotated file last written in the hour before the shared window', async () => {
    const { current, rotated } = writeLogs();
    // server.log.1 now ends at the first boundary of the window, before the shared window's start
    fs.writeFileSync(rotated, `[${new Date(S - 2 * H).toISOString()}] [INFO] [boot] ready\n${alive(S)}\n`);
    const mtime = new Date(S + 10 * 60 * 1000);
    fs.utimesSync(rotated, mtime, mtime);
    const agg = await aggregateServerLog([current, rotated], NOW);
    expect(agg.oldest).toBe(S - 2 * H);
    expect(agg.autoYes.lines.some((line) => line.atMs === S)).toBe(true);
  });

  it('is a skip, not 0, when the log has no alive line of the ledger', async () => {
    const dir = path.join(root, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'server.log'),
      `[${new Date(S - 2 * H).toISOString()}] [INFO] [boot] ready\n[${new Date(E - H).toISOString()}] [INFO] [api] something\n`
    );
    const results = await measureAll(ctx({ serverLog: path.join(dir, 'server.log'), now: NOW }), ['auto-yes-observation', 'log-volume']);
    const byId = Object.fromEntries(results.map((result) => [result.metricId, result]));
    expect(byId['auto-yes-observation']).toMatchObject({ status: 'skip' });
    expect(byId['log-volume']).toMatchObject({ status: 'ok', value: 1 });
  });
});
