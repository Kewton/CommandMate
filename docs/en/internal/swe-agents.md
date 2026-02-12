[日本語版](../../internal/swe-agents.md)

# Guide for SWE Agents (Claude Code / OpenHands / Others)

This document provides guidelines for **SWE agents** such as Claude Code and OpenHands when working with the `CommandMate` repository.

Assuming pair programming between human developers and agents, this document covers:

- What the project assumes
- What to modify and how
- What must not be broken

---

## 0. Goals

Main roles expected of SWE agents:

- **Feature additions and specification changes** aligned with the existing architecture
- **Implementation consistency checks** spanning tmux / Claude CLI / WebSocket / SQLite
- Test and lint maintenance and improvement
- Documentation maintenance (updating `README.md` / `docs/*.md`)

Human developers will provide tasks to agents at a **small granularity**.

---

## 1. Repository Overview

### 1.1 Core Concepts

- `1 worktree = 1 tmux session = 1 Claude CLI session`
- **Event-driven design** that detects "processing complete" via the Stop hook (`CLAUDE_HOOKS_STOP`)
- `CommandMate` itself is a **local development assistant tool**, with its security boundary premised on "personal development machine" (though it also has access control for LAN exposure)

### 1.2 Main Technology Stack

- Next.js (App Router) / TypeScript
- Node.js (API Routes)
- SQLite (`db.sqlite`)
- tmux + Claude CLI
- WebSocket

For detailed architecture, see `docs/architecture.md` (planned) or the "Architecture Overview" in `README.md`.

---

## 2. Directory Structure and Responsibilities

Expected directory structure (may be adjusted based on actual implementation):

```text
src/app/        # UI Layer (Next.js App Router)
  page.tsx      # Screen A: Worktree list
  worktrees/[id]/page.tsx        # Screen B: Chat screen
  worktrees/[id]/logs/page.tsx   # Screen C: Log viewer

src/api/        # API Routes
  worktrees/route.ts                     # GET /api/worktrees
  worktrees/[id]/send/route.ts           # POST /api/worktrees/:id/send
  worktrees/[id]/messages/route.ts       # GET /api/worktrees/:id/messages
  worktrees/[id]/logs/route.ts           # GET /api/worktrees/:id/logs
  hooks/claude-done/route.ts             # POST /api/hooks/claude-done

src/lib/
  tmux.ts          # tmux command wrapper (new-session, send-keys, capture-pane...)
  worktrees.ts     # git worktree scanning and Worktree model management
  db.ts            # SQLite client
  ws-server.ts     # WebSocket server and room management

src/types/
  models.ts        # Worktree / ChatMessage / SessionState type definitions

docs/
  architecture.md  # Architecture details
  swe-agents.md    # This document
```

When SWE agents work with code, be mindful of the following separation of responsibilities:
- `src/app/*` -> UI / screen logic (rendering)
- `src/api/*` -> HTTP API entry points (validation / use case invocation)
- `src/lib/*` -> Domain logic / infrastructure integration (tmux, db, WebSocket, etc.)
- `src/types/*` -> Type definitions / shared models

---

## 3. Invariants / Premises to Protect

Listed below are **premises that must never be broken** when executing tasks.

### 3.1 Session Configuration

1. **1 worktree = 1 tmux session** prefix convention
   - tmux session names always use `cw_{worktreeId}`
   - worktreeId is a URL-safe ID (e.g., `feature-foo`)

2. **Stop hook setup when starting Claude CLI**
   - Always set the `CLAUDE_HOOKS_STOP` environment variable before starting `claude`
   - The hook must include at least `worktreeId` (POST as JSON)

### 3.2 Persistence and Logs

1. **Use db.sqlite as the single source for Worktree / ChatMessage persistence**
   - Worktree list and chat history retrieval should go through the DB
   - `.claude_logs/*.md` is for detailed log (raw log) storage and reference only

2. **Log file naming rules**
   - Base format: `YYYYMMDD-HHmmss-{worktreeId}-{uuid}.md`
   - Save in the `.claude_logs/` directory per worktree

### 3.3 Security

1. **Recommend reverse proxy authentication for external access**
   - When using `CM_BIND=0.0.0.0` (allowing LAN access):
   - Set up reverse proxy authentication such as Nginx + Basic Auth, Cloudflare Access, or Tailscale
   - See `docs/security-guide.md` for details

Agents must **not propose breaking these premises without specification changes**.
If specification changes are desired, always update `docs/architecture.md` and this document first under human developer direction.

---

## 4. Data Model Premises

### 4.1 Worktree

```
interface Worktree {
  id: string;              // "main", "feature-foo", etc. (URL-safe)
  name: string;            // "main", "feature/foo", etc., display name
  path: string;            // "/path/to/root/feature/foo" (absolute path)
  lastMessageSummary?: string; // Last message summary (for worktree list)
  updatedAt?: Date;        // Timestamp of the last message
}
```

### 4.2 ChatMessage

```
type ChatRole = "user" | "claude";

interface ChatMessage {
  id: string;           // UUID
  worktreeId: string;   // Worktree.id
  role: ChatRole;
  content: string;      // Full text for UI display
  summary?: string;     // Optional short summary (usable for worktree list, etc.)
  timestamp: Date;
  logFileName?: string; // Corresponding Markdown log file name (relative path)
  requestId?: string;   // Future extension: 1 submission = 1 UUID
}
```

### 4.3 Session State

```
interface WorktreeSessionState {
  worktreeId: string;
  lastCapturedLine: number; // Number of lines previously captured from tmux capture-pane
}
```

- The diff extraction method ("get new lines from the previous end line") is assumed.
- Implementation details and storage format (DB, memory, or file) depend on the implementation policy, but maintain the concept of "performing diff extraction".

---

## 5. Typical Task Examples

Examples of tasks suitable for delegating to SWE agents.

### 5.1 UI/UX

- Add **search/filter** to Screen A (Worktree list)
- Improve bubble display in Screen B (Chat) (color-coding for user / claude)
- Introduce **infinite scroll** in Screen B to load older messages
- Add jump-to-heading functionality for "User" and "Claude" headings in Screen C (Log viewer)

### 5.2 Backend / API

- Add `before` / `limit` parameters to `GET /api/worktrees/:id/messages` for pagination
- Extend the Stop hook API (`POST /api/hooks/claude-done`) to accept `requestId`
- Refactor tmux `capture-pane` diff extraction and add unit tests
- Maintain reverse proxy authentication setup guide

### 5.3 Infrastructure / Tools

- Add/improve ESLint / Prettier / TypeScript configuration
- Implement GitHub Actions (CI)
  - Run `npm run lint` / `npm test` per PR
- Add scripts for local verification
  - CLI for minimal operation verification with dummy worktrees

---

## 6. Execution and Testing Methods (Agent Premises)

When SWE agents present "execution commands", treat the following command set as standard.

### 6.1 Startup

```
npm run dev
```

- Starts the Next.js dev server.
- Default port is MCBD_PORT (3000 if unspecified).

### 6.2 Lint

```
npm run lint
```
- Assumes TypeScript / ESLint.

### 6.3 Testing

```
npm test
```

- Unit tests and simple integration tests will be added as implementation progresses.
- SWE agents are expected to instruct in the form: "I made this change, so please run `npm test` to confirm it passes."

---

## 7. Change Policies and Review Perspectives

When SWE agents make PR-equivalent change proposals, it is recommended to self-check the following perspectives:
- Is the existing separation of responsibilities maintained (properly separating UI / API / lib / types)?
- Has no incorrect change been made to license headers or LICENSE files?
- Has the meaning of existing settings like `CM_ROOT_DIR` / `CM_BIND` not been disrupted?
- If new environment variables or settings were added, have `README.md` and `docs/configuration.md` (if it exists) been updated?
- Have tests been added as needed, and at minimum confirmed existing tests aren't broken?
- Do UI changes not break on mobile (responsive verification)?

---

## 8. Initial Context Example for Claude Code / OpenHands

An example initial prompt when a human developer hands this repository to an agent like Claude Code:

> You are an SWE agent for a local development companion tool called CommandMate.
>
> This tool establishes tmux + Claude CLI sessions per git worktree, enabling chat UI operation on a per-branch basis from a smartphone browser.
>
> Important premises:
> - 1 worktree = 1 tmux session (`cw_{worktreeId}`)
> - Claude CLI starts after setting the Stop hook via the `CLAUDE_HOOKS_STOP` environment variable
> - When a session completes, the Stop hook hits `POST /api/hooks/claude-done`, and the backend retrieves the diff log via `tmux capture-pane`, saves it to DB and `.claude_logs/*.md`, and pushes the ChatMessage to the UI via WebSocket
>
> See `README.md` and `docs/architecture.md` for repository structure and architecture.
> For the tasks I instruct, please present change proposals step by step, explicitly stating:
> - Which files to modify
> - What the impact scope is
> - Test and lint execution commands if needed

Providing this context helps the agent avoid misunderstanding:
- What CommandMate "does"
- What the core concepts are
- Which layer of code to work with

---

## 9. Process When Specification Changes Are Needed

If a human developer wants to "change the architectural premises themselves" (e.g., switch from Stop hook to polling, add a non-tmux configuration, etc.):

1. First update `docs/architecture.md` and this document (`swe-agents.md`),
2. Then request implementation tasks from SWE agents based on those changes.

Following the order of "Specification -> Documentation -> Implementation" keeps the collaborative work between humans and agents smooth.
