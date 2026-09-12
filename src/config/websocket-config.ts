/**
 * WebSocket heartbeat / reconnect constants shared by the server and the browser.
 *
 * Issue #2502: the socket had no liveness probe at all, so a half-open path — a
 * phone that walked out of range, a laptop resuming from sleep, a Wi-Fi/LTE
 * handover — stayed `connected` on both ends while every frame fell on the
 * floor. TCP alone does not notice: without traffic neither side gets a RST,
 * and `readyState` keeps answering OPEN. The only way out is to put bytes on
 * the wire on a schedule and treat silence as a disconnect.
 *
 * Server and client read the same numbers from here because the two halves are
 * a single protocol: the client's patience has to be a multiple of the server's
 * beat, or a healthy connection gets killed between beats.
 */

/**
 * How often the server pings every client and emits an application-level beat.
 *
 * 30s is the `ws` library's own recipe cadence and stays well inside the idle
 * timeouts of the proxies CommandMate is tunnelled through (Cloudflare Quick
 * Tunnel, Tailscale Serve), which is a second reason to send it at all.
 */
export const WS_SERVER_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Server → client application-level beat (Issue #2502).
 *
 * A protocol-level ping is invisible to a browser: the WebSocket API answers
 * pings automatically and gives page JavaScript no way to observe either the
 * ping or its own pong. So the server sends this frame alongside the protocol
 * ping — same cadence, same sweep — purely so the tab has something it CAN see.
 * The client consumes it for liveness and does not forward it to listeners.
 */
export const WS_HEARTBEAT_MESSAGE_TYPE = 'heartbeat' as const;

/** How often the client checks how long it has been since anything arrived. */
export const WS_CLIENT_LIVENESS_CHECK_INTERVAL_MS = 5_000;

/**
 * Silence, in ms, after which the client declares the socket half-open.
 *
 * 2.5x the server beat: one lost or late heartbeat must not tear down a healthy
 * connection, but two in a row is not something a live path does. Anything
 * inbound refreshes the clock — a broadcast, a terminal chunk, the beat — so a
 * busy socket never gets near this.
 */
export const WS_CLIENT_LIVENESS_TIMEOUT_MS = 75_000;

/** Default base delay for the client's reconnect backoff. */
export const WS_RECONNECT_BASE_DELAY_MS = 1_000;

/** Default ceiling for the client's reconnect backoff. */
export const WS_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Fraction of the computed backoff the client randomises by, +/- (Issue #2502).
 *
 * Without it every tab that was connected to a restarting server retries on the
 * identical 1s/2s/4s grid and the thundering herd lands on the first socket the
 * new process opens. +/-20% is enough to smear the herd across the window while
 * keeping the backoff's shape recognisable.
 */
export const WS_RECONNECT_JITTER_RATIO = 0.2;

/**
 * Close code the client uses when it gives up on a silent socket.
 *
 * In the application-private 4000-4999 range (1000-2999 are reserved by the
 * protocol and browsers throw on most of them), so a server-side close log can
 * tell "the tab decided this path was dead" apart from an ordinary goodbye.
 */
export const WS_HALF_OPEN_CLOSE_CODE = 4001;
