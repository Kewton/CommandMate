#!/usr/bin/env node
/**
 * Measures what a wall of `/sessions` tiles actually costs a running server
 * (Issue #2511, Epic #2508 Phase 3).
 *
 * Phase 1 (#2509) gave `/sessions` a tile grid where **every visible tile owns
 * two pollers of its own** — `useTerminalPanePolling` on `/current-output` and
 * `useSplitMessages` on `/messages`. Ten visible tiles is therefore twenty
 * pollers against one local Node process, and the Issue asks for the cadence to
 * be re-tuned *from measurement* rather than from arithmetic. This is the
 * measurement: it stands up an isolated server with N fake-but-real sessions,
 * replays the tile cadence against it from N virtual tiles, and prints req/s,
 * transferred bytes and CPU seconds.
 *
 * ## What is real here and what is not
 *
 * **Real:** the HTTP server (a production `next build`, not dev mode), the route
 * handlers, `buildCurrentOutput`, the SQLite reads, `tmux capture-pane` against
 * live tmux sessions, the capture cache, JSON serialization, gzip.
 *
 * **Not real:** the agents. A pane here is a `sleep` with a captured Claude
 * transcript printed into its scrollback (`tests/unit/lib/tmux/fixtures/
 * capture-claude-busy.txt`, a 1000-line real capture, repeated to the requested
 * depth), so the *bytes* and the *capture cost* are representative while nothing
 * is actually generating. That is the steady state the Issue is about — a wall
 * of idle tiles — and it is also the only state that can be held still long
 * enough to measure. A generating session is strictly cheaper per tile on the
 * poll path, because its snapshots arrive over the WebSocket instead.
 *
 * **Not measured:** the client. Browser-side render cost of N live transcripts
 * is a separate question; this script is the server's side of it. The client's
 * request *rate* is pinned by `tests/unit/hooks/` instead, against the real
 * hooks.
 *
 * ## Isolation
 *
 * Nothing here touches the machine's real CommandMate:
 *  - its own SQLite file under `<repo>/data/measure-2511/` (gitignored)
 *  - its own tmux server on a private socket (`-L cmate-measure-2511`). The app
 *    calls `tmux` with no socket argument, so the socket is forced by a `tmux`
 *    shim placed first on the server's PATH; see {@link SHIM_DIR}
 *  - its own port (3511 by default)
 *  - no auth (`CM_AUTH_TOKEN_HASH` unset makes the middleware pass through)
 *
 * `teardown` removes all of it. Run it even after a failed run.
 *
 * ## Usage
 *
 *     node scripts/measure-tile-polling/index.mjs setup --tiles 40 --lines 10000
 *     node scripts/measure-tile-polling/index.mjs serve            # blocks
 *     node scripts/measure-tile-polling/index.mjs load --tiles 20 \
 *          --current-output-ms 2000 --messages-ms 5000 --duration 60
 *     node scripts/measure-tile-polling/index.mjs teardown
 *
 * `load` prints one JSON object on stdout; everything else goes to stderr.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Everything this harness writes lives here. `/data/` is gitignored. */
const ISO_DIR = path.join(REPO_ROOT, 'data', 'measure-2511');
const DB_PATH = path.join(ISO_DIR, 'cm.db');
const WORKTREE_ROOT = path.join(ISO_DIR, 'worktrees');

/**
 * The private tmux socket label.
 *
 * `-L` (equivalently `-S`) is the ONLY reliable isolation lever: it takes
 * precedence over `$TMUX`, which is always set here because this runs inside a
 * CommandMate pane. `scripts/canary/tmux-private.ts` encodes the same rule for
 * the detection canary, and `tests/unit/config/tmux-live-test-safety.test.ts`
 * enforces it repository-wide — including the rule that the temp-directory
 * environment variable must never be the isolation mechanism, since tmux ignores
 * it outright when `$TMUX` is set (which is always, inside a CommandMate pane).
 */
const TMUX_SOCKET_LABEL = 'cmate-measure-2511';

/**
 * A `tmux` that pins the socket, logs its argv, and then execs the real one.
 *
 * Two jobs, and the first is the important one. The server under measurement
 * reaches tmux through `execFile('tmux', …)` with **no socket argument** — it
 * takes the ambient server, which on this machine hosts the user's live `mcbd-*`
 * sessions. Putting this directory first on the server's PATH is what forces
 * every one of those calls onto {@link TMUX_SOCKET_LABEL} without touching
 * production code.
 *
 * The second job is the capture-cache hit rate. The cache publishes no counters,
 * so counting the `capture-pane` processes the server spawns is the only way to
 * measure it; requests minus captures is the number of hits.
 */
const SHIM_DIR = path.join(ISO_DIR, 'bin');
const SHIM_LOG = path.join(ISO_DIR, 'tmux-calls.log');

const PORT = Number(process.env.MEASURE_PORT ?? 3511);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** A real 1000-line `capture-pane -e` frame of a busy Claude session. */
const FIXTURE = path.join(REPO_ROOT, 'tests', 'unit', 'lib', 'tmux', 'fixtures', 'capture-claude-busy.txt');

/** Matches the app's own `TMUX_HISTORY_LIMIT` so scrollback depth is comparable. */
const HISTORY_LIMIT = 20000;
const PANE_WIDTH = 200;
const PANE_HEIGHT = 50;

function log(...args) {
  console.error('[measure]', ...args);
}

/**
 * `--key=value`, `--key value` and bare `--flag` all work.
 *
 * The space form matters: an earlier version accepted only `=`, so
 * `--tiles 40` silently read as `tiles=true` (`Number('true')` is NaN), the
 * setup loop ran zero times, and the failure surfaced several steps later as
 * "can't find session".
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) { out._.push(argv[i]); continue; }
    if (m[2] !== undefined) { out[m[1]] = m[2]; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[m[1]] = next; i += 1; }
    else out[m[1]] = 'true';
  }
  return out;
}

/**
 * Run tmux on the private socket.
 *
 * `-f /dev/null` for the same reason the canary uses it: the developer's
 * `~/.tmux.conf` must not change pane geometry or status lines underneath a
 * capture whose byte count is the measurement.
 */
function tmux(args, opts = {}) {
  return execFileSync('tmux', ['-L', TMUX_SOCKET_LABEL, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...process.env, TMUX: undefined },
    ...opts,
  });
}

function worktreeIdFor(i) {
  return `measure-wt-${String(i).padStart(3, '0')}`;
}

/**
 * The exact-match session target, `=<name>:`.
 *
 * Same rule as `src/lib/tmux/tmux.ts` and `scripts/canary/tmux-private.ts`: a
 * bare name is a PREFIX match in tmux, so `mcbd-claude-measure-wt-1` would also
 * select `mcbd-claude-measure-wt-10`. On a shared socket the same slip selects
 * one of the user's sessions.
 */
function exactTarget(sessionName) {
  return `=${sessionName}:`;
}

/**
 * The two request paths, spelled exactly as the tile's hooks spell them.
 *
 * `useTerminalPanePolling` sends `cliTool` + `instance`; `useSplitMessages`
 * adds `unit=pairs` (#1407). Getting the query string wrong is how a load test
 * quietly measures a cheaper request than the product makes — the first run
 * here omitted `unit=pairs` and `/messages` answered `[]`.
 */
function currentOutputPath(id) {
  return `/api/worktrees/${id}/current-output?cliTool=claude&instance=claude`;
}

function messagesPath(id) {
  return `/api/worktrees/${id}/messages?cliTool=claude&instance=claude&unit=pairs`;
}

/** Install the counting `tmux` shim (see {@link SHIM_DIR}). */
function writeTmuxShim() {
  const realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SHIM_DIR, 'tmux'),
    [
      '#!/bin/sh',
      '# Issue #2511 measurement shim: pin the socket, log the argv, run the real tmux.',
      `printf '%s\\n' "$*" >> ${JSON.stringify(SHIM_LOG)}`,
      `exec ${JSON.stringify(realTmux)} -L ${TMUX_SOCKET_LABEL} -f /dev/null "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  log(`tmux shim -> ${realTmux}`);
}

/** How many `tmux` calls of each kind the shim has logged so far. */
function readShimCounts() {
  if (!fs.existsSync(SHIM_LOG)) return null;
  const counts = {};
  for (const line of fs.readFileSync(SHIM_LOG, 'utf8').split('\n')) {
    if (!line) continue;
    const verb = line.split(' ').find((t) => t && !t.startsWith('-')) ?? '?';
    counts[verb] = (counts[verb] ?? 0) + 1;
  }
  return counts;
}

// =========================================================================
// setup
// =========================================================================

/**
 * Build the pane content: the real fixture repeated until it reaches `lines`.
 *
 * Repetition rather than synthesis because the thing being measured is the byte
 * cost of a *real* frame — ANSI sequences, box drawing, the lot. A generated
 * transcript would make the transfer numbers a property of the generator.
 */
function buildPaneContent(lines) {
  const fixture = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  // The fixture is a capture, so it ends with the blank padding tmux returns
  // below the last drawn row. Trimming it and then taking the TAIL is what
  // makes the pane end where a live pane ends — on the composer box. Keeping
  // the padding put ~250 blank rows at the bottom of every pane, `isSessionHealthy`
  // read that as an empty frame, and all 40 sessions probed as not running.
  while (fixture.length > 0 && fixture[fixture.length - 1].trim() === '') fixture.pop();
  const out = [];
  while (out.length < lines) out.push(...fixture);
  return out.slice(-lines).join('\n');
}

async function cmdSetup(args) {
  const tiles = Number(args.tiles ?? 40);
  const lines = Number(args.lines ?? 10000);

  fs.mkdirSync(ISO_DIR, { recursive: true });
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });

  writeTmuxShim();

  const contentPath = path.join(ISO_DIR, 'pane-content.txt');
  fs.writeFileSync(contentPath, buildPaneContent(lines));
  log(`pane content: ${lines} lines, ${fs.statSync(contentPath).size} bytes`);

  for (let i = 0; i < tiles; i += 1) {
    const id = worktreeIdFor(i);
    const session = `mcbd-claude-${id}`;
    const dir = path.join(WORKTREE_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });

    // Three steps rather than one, because `history-limit` is read when a PANE
    // is created and the only sanctioned way to set it is session-scoped
    // (`set-option -t`; the global form is a server-wide mutation this
    // repository forbids outright). So: an empty session to hang the option on,
    // the option, then the window whose pane inherits it. Verified against tmux
    // 3.5a — the content window reports `history_limit=20000` and keeps the full
    // scrollback, while the default would have capped it at 2000 rows and
    // silently shrunk every payload measured here.
    tmux([
      'new-session', '-d', '-s', session, '-c', dir,
      '-x', String(PANE_WIDTH), '-y', String(PANE_HEIGHT),
      'sleep', '1000000',
    ]);
    tmux(['set-option', '-t', exactTarget(session), 'history-limit', String(HISTORY_LIMIT)]);
    // `cat` then sleep: the transcript lands in the scrollback and the pane
    // stays alive, which is what makes `isRunning` / `isSessionHealthy` answer
    // the way a live agent's pane does.
    tmux([
      'new-window', '-t', exactTarget(session), '-c', dir, '-n', 'content',
      'sh', '-c', `cat ${JSON.stringify(contentPath)}; exec sleep 1000000`,
    ]);
    // Drop the bootstrap window so the session's current window — which is what
    // `capture-pane -t '=<session>:'` resolves to, in the app and here — is the
    // one holding the transcript.
    tmux(['kill-window', '-t', `${exactTarget(session)}0`]);
  }
  log(`created ${tiles} tmux sessions on -L ${TMUX_SOCKET_LABEL}`);

  // Give the panes a moment to finish printing before anything captures them.
  await new Promise((r) => setTimeout(r, 3000));
  const captured = tmux([
    'capture-pane', '-p', '-e', '-S', '-10000',
    '-t', exactTarget(`mcbd-claude-${worktreeIdFor(0)}`),
  ]);
  log(`sample capture: ${captured.split('\n').length} lines, ${Buffer.byteLength(captured)} bytes`);

  log('setup complete — now run `serve`, then `seed`, then `load`');
}

// =========================================================================
// seed — DB rows (run once the server has created + migrated the file)
// =========================================================================

/**
 * Insert the worktree rows and a realistic history directly.
 *
 * Directly rather than through `POST /api/repositories/sync` because the
 * alternative is forty real git worktrees, and none of the routes under
 * measurement reads anything git-derived on the polling path.
 */
async function cmdSeed(args) {
  const tiles = Number(args.tiles ?? 40);
  const messagesPerWorktree = Number(args.messages ?? 60);
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  const columns = new Set(db.prepare('PRAGMA table_info(worktrees)').all().map((c) => c.name));
  const row = {
    id: null, name: null, path: null, branch: null,
    repository_path: null, repository_name: null,
    cli_tool_id: 'claude', selected_agents: JSON.stringify(['claude']),
    updated_at: Date.now(),
  };
  const cols = Object.keys(row).filter((c) => columns.has(c));
  const insert = db.prepare(
    `INSERT OR REPLACE INTO worktrees (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
  );
  const insertMsg = db.prepare(
    `INSERT OR REPLACE INTO chat_messages (id, worktree_id, role, content, timestamp, cli_tool_id, instance_id, message_type, archived)
     VALUES (@id, @worktree_id, @role, @content, @timestamp, 'claude', 'claude', 'normal', 0)`,
  );

  // ~1.2KB of assistant prose per row: the shape of a real reply, without
  // pretending to a precision the sample size does not support.
  const body = 'ここまでの変更をまとめます。'.repeat(20) + '\n\n- `src/hooks/useTerminalPanePolling.ts` を更新\n- テストを追加\n';

  const tx = db.transaction(() => {
    for (let i = 0; i < tiles; i += 1) {
      const id = worktreeIdFor(i);
      insert.run({
        ...row,
        id,
        name: id,
        path: path.join(WORKTREE_ROOT, id),
        branch: `feature/measure-${i}`,
        repository_path: WORKTREE_ROOT,
        repository_name: 'measure-repo',
      });
      for (let m = 0; m < messagesPerWorktree; m += 1) {
        insertMsg.run({
          id: `${id}-msg-${m}`,
          worktree_id: id,
          role: m % 2 === 0 ? 'user' : 'assistant',
          content: m % 2 === 0 ? `メッセージ ${m}` : body,
          timestamp: Date.now() - (messagesPerWorktree - m) * 60_000,
        });
      }
    }
  });
  tx();
  db.close();
  log(`seeded ${tiles} worktrees × ${messagesPerWorktree} messages into ${DB_PATH}`);
}

// =========================================================================
// serve
// =========================================================================

function cmdServe() {
  const env = { ...process.env };
  // Belt and braces. The PATH shim's `-L` is what actually pins the socket, and
  // it wins over `$TMUX` — but a server that cannot see `$TMUX` at all also
  // cannot be talked into re-attaching to the ambient one.
  delete env.TMUX;
  delete env.CM_AUTH_TOKEN_HASH;         // middleware passes through
  env.NODE_ENV = 'production';
  env.PATH = `${SHIM_DIR}${path.delimiter}${env.PATH}`;
  env.CM_PORT = String(PORT);
  env.CM_BIND = '127.0.0.1';
  env.CM_DB_PATH = DB_PATH;
  env.CM_ROOT_DIR = WORKTREE_ROOT;
  // Deliberately NOT setting WORKTREE_REPOS. The isolated worktree directory
  // lives inside this repository's own git worktree, so a boot scan there runs
  // `git worktree list` against the REAL repository and seeds the isolated DB
  // with the machine's actual worktrees (27 of them, the first time this was
  // run). `seed` is the only thing that may put rows in this database.
  delete env.WORKTREE_REPOS;

  const child = spawn('node', [path.join(REPO_ROOT, 'dist', 'server', 'server.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// =========================================================================
// load
// =========================================================================

/**
 * One HTTP GET, counting the bytes that actually crossed the socket.
 *
 * Raw `http.request` rather than `fetch` because `fetch` decompresses and then
 * throws the encoded length away, and the encoded length IS the transfer cost.
 * `accept-encoding: gzip` matches what a browser sends.
 */
function get(agent, urlPath) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, agent, headers: { 'accept-encoding': 'gzip' } },
      (res) => {
        let wire = 0;
        res.on('data', (chunk) => { wire += chunk.length; });
        res.on('end', () => {
          resolve({
            ok: res.statusCode === 200,
            status: res.statusCode,
            wireBytes: wire,
            encoding: res.headers['content-encoding'] ?? 'identity',
            ms: Number(process.hrtime.bigint() - started) / 1e6,
          });
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, wireBytes: 0, error: err.message, ms: 0 }));
    req.end();
  });
}

/** Cumulative CPU seconds of a pid, from `ps -o cputime=` (`[dd-]hh:mm:ss.ss`). */
function cpuSeconds(pid) {
  try {
    const raw = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const [days, rest] = raw.includes('-') ? raw.split('-') : ['0', raw];
    const parts = rest.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  } catch {
    return null;
  }
}

function pidListening(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return Number(out.trim().split('\n')[0]);
  } catch {
    return null;
  }
}

function tmuxServerPid() {
  try {
    const out = execFileSync('pgrep', ['-f', `tmux.*${TMUX_SOCKET_LABEL}`], { encoding: 'utf8' });
    return Number(out.trim().split('\n')[0]);
  } catch {
    return null;
  }
}

function summarize(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    n: sorted.length,
    min: Math.round(sorted[0]),
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

async function cmdLoad(args) {
  const tiles = Number(args.tiles ?? 20);
  const currentOutputMs = Number(args['current-output-ms'] ?? 2000);
  const messagesMs = Number(args['messages-ms'] ?? 5000);
  const durationMs = Number(args.duration ?? 60) * 1000;
  const label = args.label ?? `${tiles}tiles-${currentOutputMs}/${messagesMs}`;

  const serverPid = pidListening(PORT);
  if (!serverPid) throw new Error(`no server listening on ${PORT} — run \`serve\` first`);
  const tmuxPid = tmuxServerPid();

  // A browser opens at most 6 HTTP/1.1 connections per origin, and that ceiling
  // is part of what the tile grid runs into. Modelling it is what makes the
  // achieved rate comparable to the one a real page gets.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });

  const stats = {
    currentOutput: { requests: 0, ok: 0, wireBytes: 0, latency: [] },
    messages: { requests: 0, ok: 0, wireBytes: 0, latency: [] },
  };
  const record = (bucket, res) => {
    bucket.requests += 1;
    if (res.ok) bucket.ok += 1;
    bucket.wireBytes += res.wireBytes;
    bucket.latency.push(res.ms);
  };

  const ids = Array.from({ length: tiles }, (_, i) => worktreeIdFor(i));
  const timers = [];
  const inflight = new Set();
  const fire = (bucket, urlPath) => {
    const p = get(agent, urlPath).then((res) => record(bucket, res)).finally(() => inflight.delete(p));
    inflight.add(p);
  };

  const cpuBefore = { server: cpuSeconds(serverPid), tmux: tmuxPid ? cpuSeconds(tmuxPid) : null };
  const shimBefore = readShimCounts();
  const startedAt = Date.now();

  for (const id of ids) {
    // Spread the tiles across the interval the way independently-mounted React
    // effects are spread, rather than firing all N on the same tick.
    const jitter = Math.random();
    timers.push(setTimeout(() => {
      fire(stats.currentOutput, currentOutputPath(id));
      timers.push(setInterval(
        () => fire(stats.currentOutput, currentOutputPath(id)),
        currentOutputMs,
      ));
    }, jitter * currentOutputMs));
    timers.push(setTimeout(() => {
      fire(stats.messages, messagesPath(id));
      timers.push(setInterval(
        () => fire(stats.messages, messagesPath(id)),
        messagesMs,
      ));
    }, jitter * messagesMs));
  }

  await new Promise((r) => setTimeout(r, durationMs));
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  await Promise.all([...inflight]);

  const elapsedMs = Date.now() - startedAt;
  const cpuAfter = { server: cpuSeconds(serverPid), tmux: tmuxPid ? cpuSeconds(tmuxPid) : null };
  const shimAfter = readShimCounts();
  agent.destroy();

  const totalRequests = stats.currentOutput.requests + stats.messages.requests;
  const totalBytes = stats.currentOutput.wireBytes + stats.messages.wireBytes;
  const serverCpu = cpuAfter.server !== null && cpuBefore.server !== null
    ? Number((cpuAfter.server - cpuBefore.server).toFixed(2)) : null;
  const tmuxCpu = cpuAfter.tmux !== null && cpuBefore.tmux !== null
    ? Number((cpuAfter.tmux - cpuBefore.tmux).toFixed(2)) : null;

  const result = {
    label,
    tiles,
    cadence: { currentOutputMs, messagesMs },
    elapsedSec: Number((elapsedMs / 1000).toFixed(1)),
    requests: {
      currentOutput: stats.currentOutput.requests,
      messages: stats.messages.requests,
      total: totalRequests,
      failed: totalRequests - stats.currentOutput.ok - stats.messages.ok,
    },
    reqPerSec: Number((totalRequests / (elapsedMs / 1000)).toFixed(2)),
    wireBytes: {
      currentOutput: stats.currentOutput.wireBytes,
      messages: stats.messages.wireBytes,
      total: totalBytes,
    },
    kbPerSec: Number((totalBytes / 1024 / (elapsedMs / 1000)).toFixed(1)),
    latencyMs: {
      currentOutput: summarize(stats.currentOutput.latency),
      messages: summarize(stats.messages.latency),
    },
    tmuxCalls: shimBefore && shimAfter
      ? Object.fromEntries(
          Object.keys(shimAfter).map((k) => [k, (shimAfter[k] ?? 0) - (shimBefore[k] ?? 0)]),
        )
      : null,
    cpuSeconds: { server: serverCpu, tmux: tmuxCpu },
    cpuPercentOfOneCore: serverCpu === null ? null : {
      server: Number((100 * serverCpu / (elapsedMs / 1000)).toFixed(1)),
      tmux: tmuxCpu === null ? null : Number((100 * tmuxCpu / (elapsedMs / 1000)).toFixed(1)),
    },
    host: { cores: os.cpus().length, model: os.cpus()[0]?.model },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// =========================================================================
// probe — one request of each kind, uncompressed, for the payload sizes
// =========================================================================

/** The five largest top-level fields of a JSON body, by serialized bytes. */
function topFieldSizes(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return Object.entries(parsed)
    .map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v) ?? 'null')])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}=${n}`);
}

async function cmdProbe() {
  const agent = new http.Agent({ keepAlive: false });
  const id = worktreeIdFor(0);
  const out = {};
  for (const [name, urlPath] of [
    ['currentOutput', currentOutputPath(id)],
    ['messages', messagesPath(id)],
    ['worktreesList', '/api/worktrees'],
  ]) {
    const gz = await get(agent, urlPath);
    const identity = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: urlPath, agent, headers: { 'accept-encoding': 'identity' } },
        (res) => {
          const chunks = [];
          let n = 0;
          res.on('data', (c) => { n += c.length; chunks.push(c); });
          res.on('end', () => resolve({
            status: res.statusCode, bytes: n, body: Buffer.concat(chunks).toString('utf8'),
          }));
        },
      );
      req.on('error', () => resolve({ status: 0, bytes: 0 }));
      req.end();
    });
    out[name] = {
      status: gz.status,
      gzipBytes: gz.wireBytes,
      contentEncoding: gz.encoding,
      identityBytes: identity.bytes,
      ms: Number(gz.ms.toFixed(1)),
      // Which fields the bytes are in, so "cap the line count" can be costed
      // instead of guessed at. Top-level only; the serialized size of each
      // value is what a reader of the wire would pay for it.
      topFields: identity.body ? topFieldSizes(identity.body) : null,
    };
  }
  agent.destroy();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// =========================================================================
// teardown
// =========================================================================

function cmdTeardown() {
  try {
    const sessions = tmux(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean);
    for (const name of sessions) {
      // One exact-match kill-session per session, never a server-wide teardown:
      // the destructive form is exactly what took down every live `mcbd-*`
      // session on 2026-08-02 (see `scripts/canary/tmux-private.ts`).
      try { tmux(['kill-session', '-t', exactTarget(name)]); } catch { /* already gone */ }
    }
    log(`killed ${sessions.length} isolated tmux sessions`);
  } catch {
    log('no isolated tmux server to stop');
  }
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  log('teardown complete');
}

// =========================================================================

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const commands = {
  setup: cmdSetup, seed: cmdSeed, serve: cmdServe,
  load: cmdLoad, probe: cmdProbe, teardown: cmdTeardown,
};
if (!commands[command]) {
  console.error(`usage: ${path.basename(process.argv[1])} <${Object.keys(commands).join('|')}> [--flags]`);
  process.exit(2);
}
await commands[command](args);
