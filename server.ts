/**
 * Custom Next.js Server with WebSocket Support
 * Integrates WebSocket server for real-time communication
 * Issue #331: HTTPS support and auth cleanup on shutdown
 */

// IMPORTANT: Register uncaught exception handler FIRST, before any imports
// This ensures we catch WebSocket frame errors before other handlers
process.on('uncaughtException', (error: Error & { code?: string }) => {
  // Check for WebSocket-related errors that are non-fatal
  const isWebSocketError =
    error.code === 'WS_ERR_INVALID_UTF8' ||
    error.code === 'WS_ERR_INVALID_CLOSE_CODE' ||
    error.code === 'WS_ERR_UNEXPECTED_RSV_1' ||
    error.code === 'ECONNRESET' ||
    error.code === 'EPIPE' ||
    (error instanceof RangeError && error.message?.includes('Invalid WebSocket frame')) ||
    error.message?.includes('write after end');

  if (isWebSocketError) {
    // Silently ignore these non-fatal WebSocket frame errors
    // They commonly occur when mobile browsers send malformed close frames
    return;
  }
  // For other uncaught exceptions, log and exit
  console.error('Uncaught exception:', error);
  process.exit(1);
});

import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync, accessSync, realpathSync, statSync } from 'fs';
import { constants as fsConstants } from 'fs';
import { parse } from 'url';
import next from 'next';
import { setupWebSocket, closeWebSocket } from './src/lib/ws-server';
import {
  getRepositoryPaths,
  scanMultipleRepositories,
  reclaimGhostRepositories,
} from './src/lib/git/worktrees';
import { getDbInstance } from './src/lib/db/db-instance';
import { stopAllPolling } from './src/lib/polling/response-poller';
import { stopAllAutoYesPolling } from './src/lib/polling/auto-yes-manager';
import { initScheduleManager, stopAllSchedules } from './src/lib/schedule-manager';
import { initTimerManager, stopAllTimers } from './src/lib/timer-manager';
import { initResourceCleanup, stopResourceCleanup } from './src/lib/resource-cleanup';
import { runMigrations } from './src/lib/db/db-migrations';
import { getEnvByKey, runDotenvSelfCheck } from './src/lib/env';
import { registerAndFilterRepositories, getAllRepositories } from './src/lib/db/db-repository';
// Issue #1666: `resolveRepositoryPath`, `getWorktreeIdsByRepository`,
// `deleteWorktreesByIds`, `cleanupMultipleWorktrees` and `killWorktreeSession`
// went with the startup purge — they had no other caller here. `npm run lint`
// only covers `src/`, and tsconfig sets no `noUnusedLocals`, so nothing in the
// gates would have flagged them: they were removed by inspection, not by a tool.
import { syncWorktreesAndCleanup } from './src/lib/session-cleanup';

const dev = process.env.NODE_ENV !== 'production';
const hostname = getEnvByKey('CM_BIND') || '127.0.0.1';
const port = parseInt(getEnvByKey('CM_PORT') || '3000', 10);

// Issue #331: HTTPS configuration
const certPath = process.env.CM_HTTPS_CERT;
const keyPath = process.env.CM_HTTPS_KEY;

/** Maximum certificate file size: 1MB */
const MAX_CERT_FILE_SIZE = 1024 * 1024;

/**
 * Validate certificate file path for security
 * Issue #331: Certificate path validation
 */
function validateCertPath(filePath: string, label: string): string {
  if (!existsSync(filePath)) {
    console.error(`[Security] ${label} file not found: ${filePath}`);
    // ExitCode.CONFIG_ERROR = 2 (direct number, not imported from CLI types)
    process.exit(2);
  }

  try {
    accessSync(filePath, fsConstants.R_OK);
  } catch {
    console.error(`[Security] ${label} file not readable: ${filePath}`);
    process.exit(2);
  }

  const realPath = realpathSync(filePath);
  const stats = statSync(realPath);

  if (stats.size > MAX_CERT_FILE_SIZE) {
    console.error(`[Security] ${label} file too large (${stats.size} bytes, max ${MAX_CERT_FILE_SIZE}): ${filePath}`);
    process.exit(2);
  }

  return realPath;
}

// Create Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

/**
 * Issue #1621/#1645: emit a REAL 3xx for `/worktrees/<historical id>`.
 *
 * #1644 rescued those URLs from the layout with `permanentRedirect`, which
 * measures as HTTP 200 + `<meta http-equiv="refresh">` — App Router emits a
 * genuine 3xx only from Route Handlers, Server Actions and middleware. Old IDs
 * only start arriving now that #1645 renumbers the existing rows, so the real
 * redirect belongs here. `middleware.ts` cannot do it: it runs on the edge
 * runtime, where the SQLite alias lookup is impossible.
 *
 * Loaded through `await import()` and cached, NOT as a top-level static import:
 * adding a module graph to server.ts's eval-time graph perturbs Next's
 * AsyncLocalStorage bootstrap under `tsx server.ts`, and the first request that
 * compiles middleware then dies (measured; the symptom is E2E-only — unit,
 * integration and build all stay green). Do not hoist this.
 */
type WorktreeRedirect = { statusCode: number; location: string };
type WorktreeRedirectModule = typeof import('./src/lib/git/worktree-redirect');
let worktreeRedirectModule: WorktreeRedirectModule | null = null;
let worktreeRedirectLoad: Promise<void> | null = null;

async function resolveWorktreeAliasRedirect(url: string): Promise<WorktreeRedirect | null> {
  if (!worktreeRedirectModule) {
    if (!worktreeRedirectLoad) {
      worktreeRedirectLoad = import('./src/lib/git/worktree-redirect')
        .then((mod) => {
          worktreeRedirectModule = mod;
        })
        .catch((error) => {
          // Fail open: without the resolver the layout's meta refresh still
          // lands the user on the right worktree.
          console.error('Failed to load worktree redirect resolver:', error);
        });
    }
    await worktreeRedirectLoad;
  }

  if (!worktreeRedirectModule) return null;
  try {
    return worktreeRedirectModule.resolveWorktreeRedirect(url);
  } catch (error) {
    console.error('Worktree redirect resolution failed:', error);
    return null;
  }
}

// Issue #331: Prevent Next.js (NextCustomServer) from registering its own upgrade
// event listener on the HTTP server.
//
// When next() is called without customServer:false, it creates a NextCustomServer
// instance. NextCustomServer.getRequestHandler() lazily calls setupWebSocketHandler()
// on the first HTTP request, which registers an upgrade listener that calls
// router-server's upgradeHandler → resolveRoutes({ res: socket }) → middleware match
// → serverResult.requestHandler(req, socket, parsedUrl). This passes the raw TCP
// socket as the HTTP response object, causing:
//   TypeError: Cannot read properties of undefined (reading 'bind')
// in handleRequestImpl when it tries to call _res.setHeader.bind(_res).
//
// Making setupWebSocketHandler a no-op prevents this listener from being added.
// All WebSocket upgrades are handled by ws-server.ts (our own upgrade listener).
(app as unknown as { setupWebSocketHandler?: () => void }).setupWebSocketHandler = () => {};

app.prepare().then(() => {
  // Request handler for both HTTP and HTTPS
  const requestHandler = async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    // Guard: res must be a proper HTTP ServerResponse (not a raw net.Socket).
    // Defense-in-depth: normally not needed after the setupWebSocketHandler fix above,
    // but kept for safety in case any other path passes a non-ServerResponse object.
    if (typeof (res as unknown as { setHeader?: unknown })?.setHeader !== 'function') {
      return;
    }

    // Issue #332: Inject X-Real-IP header for IP restriction
    // [S3-005] This applies to HTTP requests only. WebSocket upgrade requests
    // are skipped below and handled by ws-server.ts (which uses socket.remoteAddress directly).
    const clientIp = req.socket.remoteAddress || '';
    if (process.env.CM_TRUST_PROXY !== 'true') {
      // CM_TRUST_PROXY=false: always overwrite to prevent forged headers
      req.headers['x-real-ip'] = clientIp;
    } else {
      // CM_TRUST_PROXY=true: only set if X-Forwarded-For is absent
      if (!req.headers['x-forwarded-for']) {
        req.headers['x-real-ip'] = clientIp;
      }
    }

    // Skip WebSocket upgrade requests - they are handled by the server 'upgrade' event.
    if (req.headers['upgrade']) {
      return;
    }

    const method = req.method ?? 'UNKNOWN';
    const url = req.url ?? '/';

    // Issue #1804: hand the proxy route handler the RAW request target.
    //
    // Next.js re-serializes the query string before an App Router route handler
    // sees `request.url` (`?q=a%20b` -> `?q=a+b`, `?bare` -> `?bare=`, a lone
    // `?` collapses), which breaks upstreams that verify a signature over the
    // query bytes. `req.url` here is the untouched request target, so stash it
    // in a header; `src/app/proxy/[...path]/route.ts` reads it back.
    //
    // The unconditional `delete` comes FIRST and runs for every request, so a
    // client-supplied `x-cm-raw-url` can never survive to be trusted; only the
    // conditional set below can put a value there. Requests still go through
    // Next (and therefore through middleware.ts's auth + IP restriction and
    // next.config.js's security headers) - deliberately NOT intercepted here.
    //
    // Kept inline, with the header name written out literally: importing a
    // helper or a constant module here adds a module graph to server.ts's
    // eval-time graph, which perturbs Next's AsyncLocalStorage bootstrap under
    // `tsx server.ts` and kills the first request that compiles middleware
    // (#1428; the symptom is E2E-only). Do not refactor this into an import.
    delete req.headers['x-cm-raw-url'];
    if (url.startsWith('/proxy/')) {
      req.headers['x-cm-raw-url'] = url;
    }

    // Issue #1621/#1645: a URL naming a worktree by a retired ID gets a real
    // 308 here, before Next renders anything. The cheap prefix test keeps every
    // other route free of the dynamic import and the alias lookup.
    if (url.startsWith('/worktrees/')) {
      const redirect = await resolveWorktreeAliasRedirect(url);
      if (redirect && !res.headersSent) {
        res.statusCode = redirect.statusCode;
        res.setHeader('Location', redirect.location);
        // See WORKTREE_REDIRECT_CACHE_CONTROL: alias -> live is durable, not
        // eternal, and a cached permanent redirect could never be corrected.
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
    }

    try {
      const parsedUrl = parse(url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error(`handleRequestImpl failed: ${method} ${url}`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  };

  // Issue #331: Create HTTP or HTTPS server
  let server: import('http').Server | import('https').Server;
  let protocol = 'http';

  if (certPath && keyPath) {
    const validatedCertPath = validateCertPath(certPath, 'Certificate');
    const validatedKeyPath = validateCertPath(keyPath, 'Key');

    try {
      const cert = readFileSync(validatedCertPath);
      const key = readFileSync(validatedKeyPath);
      server = createHttpsServer({ cert, key }, requestHandler);
      protocol = 'https';
      console.log('HTTPS server created with TLS certificates');
    } catch (error) {
      console.error('Failed to read TLS certificates:', error);
      process.exit(2);
    }
  } else {
    server = createHttpServer(requestHandler);
  }

  // Setup WebSocket server
  setupWebSocket(server as import('http').Server);

  // Scan and sync worktrees on startup
  async function initializeWorktrees() {
    try {
      // Run database migrations first
      console.log('Running database migrations...');
      const db = getDbInstance();
      runMigrations(db);

      // Issue #1428: converge Skill install/uninstall operations that a crash
      // left mid-flight, and garbage-collect expired journal entries. Runs after
      // migrations (the audit table is migration-owned) and is fail-open in its
      // own try/catch so a reconciliation error cannot stop the server — nor
      // abort the worktree sync that follows in the outer try.
      try {
        // Loaded via dynamic import, NOT a top-level static import: pulling the
        // skills module graph into server.ts's eval-time graph perturbs Next's
        // AsyncLocalStorage bootstrap under `tsx server.ts` (dev/E2E), so the
        // first request that compiles middleware crashes with
        // "AsyncLocalStorage accessed in runtime where it is not available".
        // Deferring the import to here (after app.prepare()) avoids it. Do not
        // hoist this back to a static import.
        const { runSkillStartupReconciliation } = await import(
          './src/lib/skills/startup-reconcile'
        );
        const skillReport = runSkillStartupReconciliation(db);
        if (skillReport.scanned > 0 || skillReport.pruned > 0) {
          console.log(
            `Skill operations reconciled: scanned=${skillReport.scanned} ` +
              `converged=${skillReport.converged} failed=${skillReport.failed} ` +
              `pruned=${skillReport.pruned} orphanLocks=${skillReport.orphanLocksReleased.length}`
          );
        }
      } catch (error) {
        console.error('Error reconciling Skill operations:', error);
      }

      // Issue #1621 Phase 3/4: make live tmux sessions follow the worktree IDs
      // that migration v54 has just renumbered. Session names are DERIVED from
      // the ID (`mcbd-{cli}-{worktreeId}`), so a running agent would otherwise
      // keep its process while disappearing from the UI — and the app would
      // happily start a second agent in the same directory. `worktree_aliases`
      // is the durable record of every ID that has moved, which makes this pass
      // idempotent: when nothing is stale it costs one `tmux list-sessions`.
      //
      // Fail-open in its own try/catch — reconciling sessions must never be
      // able to stop the server from serving. Dynamic import for the same
      // reason as the reconcilers around it: a static import here perturbs
      // Next's AsyncLocalStorage bootstrap under `tsx server.ts` and the first
      // request that compiles middleware dies. Do not hoist this.
      try {
        const { reconcileWorktreeSessionsFromAliases } = await import(
          './src/lib/session/worktree-session-reconcile'
        );
        const sessionReport = await reconcileWorktreeSessionsFromAliases(db);
        if (sessionReport.renamedSessions.length > 0) {
          console.log(
            `Reconciled ${sessionReport.renamedSessions.length} tmux session(s) to renamed worktree IDs ` +
              `(predicted=${sessionReport.planSources.predicted} ` +
              `discovered=${sessionReport.planSources.discovered})`
          );
        }
        // Issue #1661: a live `mcbd-*` session that no known worktree ID
        // explains is exactly what the previous report could not express — the
        // pass ran clean while two agents sat stranded under stale names. Say
        // it out loud, with the names, so it is actionable from the log alone.
        if (sessionReport.unaccountedSessions.length > 0) {
          console.warn(
            `${sessionReport.unaccountedSessions.length} tmux session(s) match no known worktree ID ` +
              `and were left untouched: ${sessionReport.unaccountedSessions.join(', ')}`
          );
        }
        if (sessionReport.errors.length > 0) {
          console.warn(`Session reconcile warnings: ${sessionReport.errors.join(', ')}`);
        }
      } catch (error) {
        console.error('Error reconciling worktree sessions:', error);
      }

      // Issue #1543: close verification runs that a crash left in `running`.
      // Gate execution lives in process memory, so none of them survived the
      // restart; leaving the rows open would keep their worktrees permanently
      // 409-locked against a new run. Dynamic import for the same reason as the
      // Skill reconciler above — do not hoist to a static import.
      try {
        const { reconcileOrphanVerificationRuns } = await import(
          './src/lib/verification/verification-reconciler'
        );
        const verifyReport = reconcileOrphanVerificationRuns(db);
        if (verifyReport.runs > 0) {
          console.log(
            `Verification runs reconciled: runs=${verifyReport.runs} gates=${verifyReport.gates}`
          );
        }
      } catch (error) {
        console.error('Error reconciling verification runs:', error);
      }

      // Get repository paths from environment variables
      const repositoryPaths = getRepositoryPaths();

      // Issue #2165: reclaim ghost `repositories` rows — enabled, no worktree
      // rows, directory confirmed gone — by demoting them to `enabled = 0`.
      // Without this they stay in the scan set forever and every boot spawns a
      // shell into a `cwd` that does not exist, logging `spawn /bin/sh ENOENT`
      // at ERROR. `pruneStaleRepositoryWorktrees` cannot reach them: it deletes
      // worktree rows and skips any repository that has none.
      //
      // Startup, not just the sync route, for two reasons. It is a full-scan
      // caller — it builds its path set from `WORKTREE_REPOS` plus every
      // enabled repository, exactly as `POST /api/repositories/sync` does — so
      // it satisfies the "global sync only" restriction that
      // `pruneStaleRepositoryWorktrees` documents; single-repository callers
      // (scan / restore) still must not run it. And startup is where the
      // symptom is: the reported ERROR lines are boot lines, and a server that
      // is only ever restarted would never reach a sync-only fix. It belongs
      // beside the four reconcilers above, which converge exactly this kind of
      // state left behind by a previous run.
      //
      // Placed BEFORE the scan set is built, so the very first boot after this
      // lands is already quiet rather than logging the ERROR one last time.
      //
      // Fail-open in its own try/catch, like the three reconcilers above.
      // Leaning on `initializeWorktrees()`'s outer catch instead would let a
      // throw here take the repository scan and the worktree sync down with
      // it — a tidy-up pass must never cost the cycle its actual work.
      try {
        const reclaimedGhosts = reclaimGhostRepositories(db, repositoryPaths);
        if (reclaimedGhosts.length > 0) {
          console.log(
            `Reclaimed ${reclaimedGhosts.length} ghost repository row(s) — directory gone, no worktrees; ` +
              `disabled (restorable from the Repositories screen): ` +
              reclaimedGhosts.map(r => r.path).join(', ')
          );
        }
      } catch (error) {
        console.error('Error reclaiming ghost repository rows:', error);
      }

      // Issue #490: Also include DB-registered repositories (e.g. cloned repos)
      const dbRepositories = getAllRepositories(db);
      const dbEnabledPaths = dbRepositories
        .filter(r => r.enabled)
        .map(r => r.path);

      // Merge env paths and DB-registered paths (deduplicate)
      const allPaths = [...new Set([...repositoryPaths, ...dbEnabledPaths])];

      if (allPaths.length === 0) {
        console.warn('Warning: No repository paths configured');
        console.warn('Set WORKTREE_REPOS (comma-separated) or MCBD_ROOT_DIR');
        return;
      }

      console.log(`Configured repositories: ${allPaths.length}`);
      allPaths.forEach((path, i) => {
        console.log(`  ${i + 1}. ${path}`);
      });

      // Issue #202: Register environment variable repositories and filter out excluded ones
      // registerAndFilterRepositories() encapsulates the ordering constraint:
      // registration MUST happen before filtering (see design policy Section 4)
      const { filteredPaths, excludedPaths, excludedCount } =
        registerAndFilterRepositories(db, allPaths);
      if (excludedCount > 0) {
        console.log(`Excluded repositories: ${excludedCount}, Active repositories: ${filteredPaths.length}`);
        // SF-SEC-003: Log excluded repository paths for audit/troubleshooting
        excludedPaths.forEach(p => {
          console.log(`  [excluded] ${p}`);
        });

        // Issue #1666: exclusion is where startup STOPS, not where it deletes.
        //
        // This branch used to purge every excluded repository — kill its tmux
        // sessions, then `deleteWorktreesByIds`, taking chat history, memos,
        // todos, timers, schedules, execution logs, tasks and verification runs
        // with it by cascade. That was #202's "deleted repositories must not
        // reappear after a restart", and it was harmless for exactly as long as
        // `DELETE /api/repositories` was the only route to `enabled = 0`: that
        // route already purged, so the loop re-deleted nothing.
        //
        // #1658 added a non-destructive disable (a single
        // `UPDATE repositories SET enabled = 0`), which made this loop the
        // thing that undid it — and only for `WORKTREE_REPOS` repositories,
        // because a DB-only one leaves `allPaths` when disabled and never
        // reaches `excludedPaths` at all. So the same toggle was destructive or
        // not depending on where the repository had been configured, and the
        // damage landed a restart later, far from the click that caused it.
        //
        // #202 survives without the deletion: an excluded repository is not
        // scanned, so nothing re-creates its rows, and keeping rows is not the
        // same as showing them. Hiding a repository's worktrees from the
        // sidebar is `visible`'s job (#690) — a separate, reversible flag that
        // the user sets deliberately — whereas `enabled` only decides what gets
        // scanned. Deleting rows to achieve "not shown" destroys history to
        // implement a view filter, and cannot be undone by re-enabling.
      }

      // Scan filtered repositories (excluded repos are skipped)
      const worktrees = await scanMultipleRepositories(filteredPaths);

      // Issue #526: Sync to database with cleanup (MF-001)
      const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, worktrees);
      if (cleanupWarnings.length > 0) {
        console.warn(`Sync cleanup warnings: ${cleanupWarnings.join(', ')}`);
      }
      if (syncResult.deletedIds.length > 0) {
        console.log(`Cleaned up ${syncResult.deletedIds.length} deleted worktree(s)`);
      }

      console.log(`Total: ${worktrees.length} worktree(s) synced to database`);
    } catch (error) {
      console.error('Error initializing worktrees:', error);
    }
  }

  // H3 fix: Pass hostname to listen() so CM_BIND is respected.
  // Note: http.Server.listen(port, hostname, callback) does not pass err to callback;
  // listen errors emit an 'error' event instead.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use`);
    } else if (err.code === 'EADDRNOTAVAIL') {
      console.error(`Address ${hostname}:${port} is not available`);
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });

  server.listen(port, hostname, async () => {
    console.log(`> Ready on ${protocol}://${hostname}:${port}`);
    console.log(`> WebSocket server ready`);

    // Issue #2113: verify that the URL the documentation advertises
    // (`http://localhost:<port>`) actually reaches THIS process. It does not when
    // another process holds `::1:<port>`: `localhost` resolves ::1 before 127.0.0.1
    // on macOS, and neither a 127.0.0.1 nor a 0.0.0.0 bind covers ::1. The user's
    // browser then talks to the squatter while we keep printing "Ready".
    //
    // Deliberately NOT awaited and wrapped in its own catch: a diagnostic must never
    // delay or block a successful `listen`. `runLocalhostSelfCheck` is fail-open in
    // its own right (it resolves `null` rather than throwing) and warns only on the
    // one actionable verdict — see src/lib/server/localhost-self-check.ts.
    //
    // Dynamic import for the same reason as every reconciler below: adding a module
    // graph to server.ts's eval-time graph perturbs Next's AsyncLocalStorage bootstrap
    // under `tsx server.ts` and kills the first request that compiles middleware. Do
    // not hoist this.
    void (async () => {
      try {
        const selfCheck = await import('./src/lib/server/localhost-self-check');
        clearStartupSelfCheckState = () => selfCheck.clearLocalhostConflict(port);
        await selfCheck.runLocalhostSelfCheck({
          server,
          port,
          bind: hostname,
          protocol: protocol === 'https' ? 'https' : 'http',
        });
      } catch (error) {
        console.error('Startup self-check failed:', error);
      }
    })();

    // Issue #2132: say, in one line, that `.env` is sitting right there and not
    // one variable in it reached this process.
    //
    // This runs BEFORE the VAPID check on purpose: an empty environment is the
    // CAUSE and "push is not configured" is one of its symptoms, so the reader
    // has to meet them in that order. During the Epic #2002 device UAT
    // (2026-08-29) only the symptom was printed, and reading it as "the iOS
    // notification replacement is broken" cost two UAT rounds — the server had
    // been started by hand after `source scripts/load-env.sh` from zsh, which
    // exported nothing and returned 0.
    //
    // Same contract as the checks around it: fail-open, never blocks `listen`,
    // and a healthy install prints NOTHING. No dynamic import here, unlike the
    // reconcilers: `src/lib/env` is already in server.ts's eval-time graph two
    // lines from the top (`getEnvByKey` decides the bind address and port), so
    // deferring it would defer nothing.
    try {
      runDotenvSelfCheck();
    } catch (error) {
      console.error('.env self-check failed:', error);
    }

    // Issue #2123 / #2124: say, in one line, whether Web Push can work at all.
    // Unconfigured VAPID keys disable push silently (correct fail-safe, wrong
    // ergonomics: the reader observes only "no notifications ever arrive"), and
    // a `CM_VAPID_SUBJECT` Apple will not accept silences iPhone/iPad while
    // Android keeps working. ONE check reports both — see src/lib/push/vapid.ts.
    //
    // A healthy configuration prints NOTHING, which is what makes the presence
    // of a line meaningful. Same contract as the localhost self-check above:
    // fail-open, never blocks `listen`. `commandmate status` runs the same
    // function over the env the daemon was started with, so the two surfaces
    // cannot drift.
    //
    // Dynamic import for the same reason as every reconciler here: adding a
    // module graph to server.ts's eval-time graph perturbs Next's
    // AsyncLocalStorage bootstrap under `tsx server.ts`. Do not hoist this.
    void (async () => {
      try {
        const { runVapidSelfCheck } = await import('./src/lib/push/vapid');
        runVapidSelfCheck();
      } catch (error) {
        console.error('VAPID self-check failed:', error);
      }
    })();

    // Initialize worktrees after server starts
    await initializeWorktrees();

    // Issue #2108: re-open the event streams of opencode panes that outlived
    // the last process. The port each one's server listens on is in
    // `~/.commandmate/opencode-ports.json`, and until this call nothing read it
    // at startup: the only chain that reached `recoverOpencodePort` was a
    // *launch*, and a restart does not launch anything — `POST /send` skips
    // `startSession` while the pane is running. The result was a server that
    // was alive and reachable while every HTTP surface answered
    // `409 NO_OPENCODE_PORT`, with the terminal view still working because the
    // screen scraper never needed the port.
    //
    // Deliberately NOT awaited. The sweep's cost is a health probe per live
    // pane, and a pane whose server has died pays a timeout for it; the
    // managers below must not queue behind that. It is fail-open in its own
    // right (it never rejects) and the `try`/`catch` below is belt-and-braces.
    //
    // Runs after `initializeWorktrees()` because the ingest path this
    // re-subscribes reaches `@/lib/db` at event time and the migrations above
    // are what make that table set current.
    //
    // Dynamic import for the same reason as every reconciler above: adding this
    // module graph to server.ts's eval-time graph perturbs Next's
    // AsyncLocalStorage bootstrap under `tsx server.ts` and the first request
    // that compiles middleware then dies. Do not hoist this.
    void (async () => {
      try {
        const { reattachOpencodeEventStreams } = await import(
          './src/lib/hooks/sources/opencode/reattach'
        );
        const report = await reattachOpencodeEventStreams();
        if (report.candidates > 0) {
          console.log(
            `opencode streams reattached: ${report.reattached}/${report.candidates} ` +
              `live pane(s) (persisted=${report.persisted} skipped=${report.skipped})`
          );
        }
      } catch (error) {
        console.error('Error reattaching opencode event streams:', error);
      }
    })();

    // Issue #1623: reconcile the `prefix+g` reading-mode binding on the user's
    // tmux server. Fail-open in its own try/catch — a convenience key must never
    // be able to stop the server from serving.
    //
    // Dynamic import, NOT a top-level static import, for the same reason as the
    // reconcilers above: adding a module graph to server.ts's eval-time graph
    // perturbs Next's AsyncLocalStorage bootstrap under `tsx server.ts`, and the
    // first request that compiles middleware then dies. Do not hoist this.
    try {
      const { initReadMode } = await import('./src/lib/tmux/read-mode');
      const readMode = await initReadMode();
      if (readMode.installed) {
        console.log(`Reading mode ready: press prefix+${readMode.key} in an attached CommandMate session`);
      }
    } catch (error) {
      console.error('Error initializing tmux reading mode:', error);
    }

    // [S3-010] Initialize schedule manager AFTER worktrees are ready
    initScheduleManager();

    // Issue #534: Initialize timer manager AFTER schedule manager
    initTimerManager();

    // Issue #404: Initialize resource cleanup AFTER schedule manager
    initResourceCleanup();
  });

  // Graceful shutdown with timeout
  let isShuttingDown = false;

  /**
   * Issue #2113: drop this port's localhost-conflict record on the way out, so a
   * resolved conflict cannot outlive the server that observed it. Assigned once the
   * self-check module has loaded; null until then, and never awaited.
   */
  let clearStartupSelfCheckState: (() => void) | null = null;

  function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
      console.log('Shutdown already in progress, forcing exit...');
      process.exit(1);
    }
    isShuttingDown = true;

    console.log(`${signal} received: shutting down...`);

    // Issue #2113: best-effort, never fatal.
    try {
      clearStartupSelfCheckState?.();
    } catch {
      // A leftover record is harmless: `status` only reports one whose PID matches.
    }

    // Stop polling first
    stopAllPolling();

    // Issue #138: Stop all auto-yes pollers
    stopAllAutoYesPolling();

    // Issue #294: Stop all scheduled executions (SIGKILL fire-and-forget)
    stopAllSchedules();

    // Issue #534: Stop all timer-based delayed messages
    stopAllTimers();

    // Issue #404: Stop resource cleanup timer
    stopResourceCleanup();

    // Close WebSocket connections immediately (don't wait)
    closeWebSocket();

    // Force exit after 3 seconds if graceful shutdown fails
    const forceExitTimeout = setTimeout(() => {
      console.log('Graceful shutdown timeout, forcing exit...');
      process.exit(1);
    }, 3000);

    // Try graceful HTTP server close
    server.close(() => {
      clearTimeout(forceExitTimeout);
      console.log('Server closed gracefully');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
});
