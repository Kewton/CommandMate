[日本語版](../../internal/requirements-design.md)

# CommandMate Requirements & Design

> A document summarizing the "requirements, specifications, and design policies" for a development companion tool that establishes Claude Code / tmux sessions per git worktree and allows chat operations from a smartphone browser.

- Product name: **CommandMate**
- Version: v2.1 Requirements, Specifications & Design Policies
- Scope:
  - Web UI operated from smartphone/PC browsers
  - Next.js / Node.js-based backend
  - tmux / Claude CLI integration
  - Persistence using SQLite / local filesystem

For detailed technical architecture, see `docs/architecture.md`.

---

## 0. Terminology

- **Root directory**: The local directory specified by `MCBD_ROOT_DIR` that manages git worktrees collectively.
- **Worktree**: A branch directory managed by git worktree (e.g., `main`, `feature/foo`).
- **worktreeId**: A URL-safe normalized identifier for a worktree (e.g., `feature-foo`).
- **tmux session**: A tmux session launched with the naming convention `cw_{worktreeId}`.
- **Stop hook**: A hook command set via the `CLAUDE_HOOKS_STOP` environment variable, called when processing is complete.

---

## 1. User Requirements

### 1.1 UX Requirements

1. Developers open CommandMate from a **smartphone browser** or PC browser and can:
   - Access Claude CLI sessions on a per-git-worktree basis.

2. On [Screen A: Worktree List]:
   - Worktrees under the root directory are displayed in a **chat-list-style UI**.
   - At minimum, the following should be displayed for each worktree:
     - Branch name (e.g., `main`, `feature/foo`)
     - Summary of the last chat message
     - Last update time (e.g., relative time display).

3. On [Screen B: Chat Screen]:
   - Each worktree is displayed as an **independent chat room**.
   - Past chat history can be viewed.
   - Natural language instructions can be sent to Claude from the input form.
   - After sending, the UI immediately shows a "Sending..." state and **does not block waiting for a response**.

4. After Claude completes processing:
   - Claude's response is **appended to the UI in real-time**.
   - When multiple clients (PC and smartphone, etc.) are viewing the same worktree, all screens are updated synchronously.

5. On [Screen C: Log Viewer]:
   - **Detailed logs (Markdown)** per worktree can be viewed in a list.
   - Opening individual log files shows Claude's detailed output and context.

6. Users can switch between "detailed log review in the development code" and "simplified display on the chat UI".

---

## 2. System Requirements

### 2.1 Functional Requirements

#### 2.1.1 UI/UX (Mobile Support)

- [FR-UI-01] Responsive design that is comfortable to operate on a smartphone browser.
- [FR-UI-02] **Screen A (Home): Worktree List**
  - Retrieve and display the list of worktrees under the root directory.
  - The list should be sorted by **most recently updated first**.
- [FR-UI-03] **Screen B (Chat)**
  - Selecting a worktree navigates to that worktree's dedicated chat screen.
  - Display past ChatMessages in chronological order.
  - Messages (instructions) can be sent from the input field.
- [FR-UI-04] **Screen C (Log)**
  - Display a list of Markdown files in the `.claude_logs/` directory under the relevant worktree.
  - Selecting a file displays a Markdown rendering view.

#### 2.1.2 Session Management

- [FR-SESSION-01] **1 worktree = 1 tmux session** + **1 Claude CLI session** mapping.
- [FR-SESSION-02] Sessions use "lazy startup":
  - Launch the tmux session when the worktree is first used (first access or first message).
- [FR-SESSION-03] tmux session name must be `cw_{worktreeId}`.
- [FR-SESSION-04] When Claude CLI is down or the session doesn't exist:
  - Automatically restart when a new API instruction arrives.

#### 2.1.3 Claude Integration (Stop Hook)

- [FR-CLAUDE-01] After sending a chat message, the UI becomes "sent" state without waiting for a response (asynchronous).
- [FR-CLAUDE-02] Processing completion from Claude is notified via the hook set in `CLAUDE_HOOKS_STOP`.
- [FR-CLAUDE-03] The Stop hook must pass at least the `worktreeId` to the API.
- [FR-CLAUDE-04] The hook API (`/api/hooks/claude-done`):
  - Retrieves output from the corresponding tmux session,
  - Analyzes the diff and saves it as a ChatMessage in the DB,
  - Pushes to the UI via WebSocket.

#### 2.1.4 Log Management

- [FR-LOG-01] Save detailed logs including instructions and responses as Markdown in the `.claude_logs/` directory under each worktree.
- [FR-LOG-02] Log file names follow the format `YYYYMMDD-HHmmss-{worktreeId}-{uuid}.md`.
- [FR-LOG-03] Save `logFileName` so the corresponding log file can be referenced from DB ChatMessage records.
- [FR-LOG-04] The "last message summary" displayed in the worktree list should be updated from the latest ChatMessage's `summary` or `content`.

### 2.2 Non-functional Requirements

#### 2.2.1 Security

- [NFR-SEC-01] Bind to `localhost` (`127.0.0.1`) by default, accessible only from the same machine.
- [NFR-SEC-02] When exposing to LAN with `CM_BIND=0.0.0.0`, recommend reverse proxy authentication (Nginx + Basic Auth, Cloudflare Access, Tailscale, etc.). See `docs/security-guide.md` for details.
- [NFR-SEC-03] Only target worktrees under the root directory:
  - Prevent arbitrary path access via the API.

#### 2.2.2 Responsiveness

- [NFR-PERF-01] Navigation from Screen A to Screen B (initial chat history load) should target under 1 second in a local environment.
- [NFR-PERF-02] Overhead from Claude completion to WebSocket notification to the UI should be kept as small as possible (target approximately 100-300ms).
- [NFR-PERF-03] The UI handles all API calls asynchronously so operations are never blocked.

#### 2.2.3 Availability and Fault Tolerance

- [NFR-AVAIL-01] When a tmux session goes down, have a mechanism to automatically restart it on the next message send.
- [NFR-AVAIL-02] Detect when the Claude CLI process has terminated and be able to restart it (at least check existence on API execution).
- [NFR-AVAIL-03] In case the Stop hook doesn't arrive (timeout/network error), leave at least a trace in the logs indicating an anomaly.

#### 2.2.4 Maintainability and Extensibility

- [NFR-MAINT-01] UI / API / domain logic / infrastructure (tmux, DB, etc.) should be structured with separation of responsibilities.
- [NFR-MAINT-02] API design should not hinder future `requestId` introduction or multi-LLM support.
- [NFR-MAINT-03] Maintain `README.md` / `docs/*.md` so SWE agents (Claude Code, etc.) can easily understand the project.

---

## 3. Design Policies

### 3.1 Overall Design Policies

1. **Adopt Event-Driven Architecture**
   - Use Claude CLI's Stop hook (`CLAUDE_HOOKS_STOP`) as a trigger,
   - Avoid polling (periodic state monitoring).
   - Perform tmux output retrieval, log saving, and UI updates triggered by completion events.

2. **Simplicity of 1 Worktree = 1 Session**
   - Assign 1 tmux session + 1 Claude session per worktree.
   - Session naming convention: `cw_{worktreeId}`.
   - This simple mapping prioritizes debuggability and operational clarity.

3. **Local-First, Developer Experience Priority**
   - Premise local environment operation and debugging, keeping setup minimal.
   - Prioritize "making daily work easier for developers" over external exposure or production operations.

4. **Two-Layer Structure: UI and Log View**
   - Use the chat UI for lightweight context display in daily use,
   - Refer to `.claude_logs/` Markdown for details as needed (two-layer structure).
   - This enables "diving into details only when needed".

---

### 3.2 Stop Hook Integration Design

- Always set `CLAUDE_HOOKS_STOP` when starting Claude CLI.
- The hook POSTs at least the `worktreeId` as JSON.
- Leave design room for adding `requestId` in the future to more strictly associate "which request completed".

```bash
HOOK_COMMAND="curl -X POST http://localhost:3000/api/hooks/claude-done \
  -H 'Content-Type: application/json' \
  -d '{\"worktreeId\":\"{worktreeId}\"}'"
export CLAUDE_HOOKS_STOP="${HOOK_COMMAND}"
```
- Use the Stop hook as the unified completion notification interface,
and do not adopt other paths (e.g., direct log file monitoring).

---

### 3.3 tmux Session Management Design

- Session creation:
  - Launch via `tmux new-session -d -s "cw_{worktreeId}" -c "{worktreePath}"`.
- Claude startup:
  - Within the session, set `CLAUDE_HOOKS_STOP` then start `claude` via `send-keys`.
- Existence check:
  - Determine session existence via `tmux has-session -t cw_{worktreeId}`.
- Restart policy:
  - If no session exists during API execution, run the new creation flow (lazy startup).
  - More advanced health monitoring (e.g., checking claude process via `ps`) is treated as optional, to be considered based on implementation cost vs. necessity.

---

### 3.4 Real-time Notification Design (WebSocket)

- The WebSocket server has "rooms / channels" per worktree.
- Clients subscribe to the worktreeId they are viewing.
- Whenever a new ChatMessage is generated,
  - Broadcast to all clients subscribed to the relevant worktreeId.
- Alternative methods like SSE (Server-Sent Events) are future options; WebSocket is the standard for the initial version.

---

### 3.5 Persistence Design

1. **SQLite (db.sqlite)**
   - Holds metadata including worktree list, ChatMessage, and session state (`lastCapturedLine`).
   - For local application use, SQLite is adopted for being more robust and faster than direct JSON file management.

2. **Markdown Logs (.claude_logs/)**
   - Create a `.claude_logs/` directory under each worktree and save Markdown logs there.
   - Logs include both user instructions and Claude responses.
   - Log file names follow a naming convention that achieves both uniqueness and chronological ordering.

3. **Cleanup Policy**
   - No automatic deletion in the initial version.
   - Consider adding a CLI in the future to delete/archive logs older than n days.

---

### 3.6 Security Design

- Default is `CM_BIND=127.0.0.1`, running on localhost only.
- When using `CM_BIND=0.0.0.0` for LAN access,
  - Recommend reverse proxy authentication (Nginx + Basic Auth, Cloudflare Access, Tailscale, etc.).
  - See `docs/security-guide.md` for details.
- Regarding HTTPS / TLS,
  - CommandMate itself remains HTTP,
  - TLS termination is expected at a reverse proxy (Caddy / nginx / Traefik, etc.) in front if needed.

---

### 3.7 Extensibility and Future Considerations

1. **requestId-Based Strict Binding**
   - Issue a `requestId` when `POST /api/worktrees/:id/send`,
   - Embed it in Stop hooks and log files,
   - Leave room to more strictly trace "which request completed".

2. **Multi-LLM Support**
   - When supporting CLIs other than Claude (OpenAI, LM Studio, OLLAMA, etc.),
   - To extend the design to hold provider/model information per session,
   - While fixing to Claude in the current design, keep an abstraction layer (tmux wrapper, etc.) in mind.

3. **Observability**
   - To enable future visualization of response time (latency), error rates, etc.,
   - Leave room for adding metadata to ChatMessage and Worktree.
   - When integrating with external observability tools (OpenTelemetry, Langfuse, etc.),
   - Enable tracing to be embedded in existing flows.

---

## 4. Document Maintenance Policy

- When adding new features:
  1. First update this document and `docs/architecture.md`,
  2. Then assign implementation tasks to SWE agents or yourself.
- When requirements, specifications, or design policies change:
  - Also update the README and SWE agent documentation (`docs/swe-agents.md`),
  - Maintain clarity about "why the change was necessary".
