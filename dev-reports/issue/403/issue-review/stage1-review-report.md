# Issue #403 Stage 1 Review Report

**Review Date**: 2026-03-03
**Focus**: Normal Review (Consistency & Correctness)
**Stage**: 1 (1st iteration)
**Reviewer**: Issue Review Agent

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 3 |

**Overall Quality**: Fair

Issue #403 identifies a real problem: `logs/server.log` has no rotation mechanism and grows unbounded when the server is started via `scripts/build-and-start.sh --daemon`. The background and motivation are clear. However, several inaccuracies and ambiguities need resolution before implementation can begin, particularly around implementation location, multiple server startup paths, and acceptance criteria testability.

---

## Must Fix (3 items)

### MF-1: Implementation location "dist/server/server.js" is inaccurate

**Category**: Correctness
**Location**: Implementation Tasks - "scripts/build-and-start.sh or dist/server/server.js"

**Problem**:
The Issue lists `dist/server/server.js` as a potential implementation location. However, `dist/server/server.js` is a build artifact generated from `server.ts` via `tsconfig.server.json`. Editing built files directly is not a valid approach in this project.

**Evidence**:
- `package.json` L37: `"start": "NODE_ENV=production node dist/server/server.js"` -- this is the runtime command, not the source.
- `tsconfig.server.json` L4: `"outDir": "dist/server"` -- confirms dist/server/ is build output.
- Source file is `server.ts` at the project root.

**Recommendation**:
Consolidate the implementation location to `scripts/build-and-start.sh` (for bash-level rotation). If TypeScript-level rotation is desired, reference `server.ts` as the source file instead. Remove all references to `dist/server/server.js` as an implementation target.

---

### MF-2: Multiple server startup paths not addressed

**Category**: Completeness
**Location**: Overview / Background sections

**Problem**:
The Issue only mentions `scripts/build-and-start.sh`, but the project has multiple server startup paths with different logging behaviors:

| Startup Path | Log Output | Writes to logs/server.log? |
|-------------|------------|--------------------------|
| `./scripts/build-and-start.sh --daemon` | `nohup npm start >> $LOG_FILE 2>&1 &` | Yes |
| `./scripts/build-and-start.sh` (foreground) | `npm start` (stdout) | No |
| `commandmate start --daemon` | `stdio: 'ignore'` | No |
| `commandmate start` (foreground) | `stdio: 'inherit'` | No |

**Evidence**:
- `scripts/build-and-start.sh` L107: `nohup npm start >> "$LOG_FILE" 2>&1 &`
- `src/cli/utils/daemon.ts` L106: `stdio: 'ignore'`

**Recommendation**:
Explicitly state that the rotation scope is limited to `logs/server.log` written by `scripts/build-and-start.sh --daemon`. Acknowledge that `commandmate start --daemon` does not produce this log file. If CLI daemon log support is desired in the future, create a separate Issue.

---

### MF-3: Acceptance criterion "no impact during rotation" is ambiguous and untestable

**Category**: Acceptance Criteria
**Location**: Acceptance Criteria - "Rotation should not affect log writing"

**Problem**:
The acceptance criterion "rotation should not affect log writing" is ambiguous. When a running `nohup` process has `server.log` open via file descriptor and the file is renamed (standard rotation), the process continues writing to the original inode (now renamed file). This is a well-known Unix behavior. The behavior depends entirely on *when* rotation occurs:

- **At server startup** (before nohup): No conflict possible, since the server process has not yet opened the file.
- **During server runtime** (e.g., daily rotation): Requires either `copytruncate` or process signal/restart to switch to the new file.

**Recommendation**:
Choose one of:
- (A) "Rotation executes only at server startup, before the server process begins writing. No running process is affected." (simplest, safest)
- (B) If daily rotation is required, specify the rotation strategy (copytruncate or signal-based) and change the criterion to: "No log lines are lost during rotation."

---

## Should Fix (5 items)

### SF-1: Ambiguous rotation timing ("at startup or daily")

**Category**: Clarity
**Location**: Proposed Solution - "at server startup or daily"

**Problem**:
"At server startup or daily" leaves the design decision open. `build-and-start.sh` naturally supports startup-time rotation. Daily rotation requires an external mechanism (cron) or a persistent in-process timer, which is architecturally different.

**Recommendation**:
Decide on one approach for the initial implementation. Startup-only rotation is recommended as it is simpler, requires no external dependencies, and addresses the core problem. Daily rotation can be listed as a future enhancement.

---

### SF-2: PRODUCTION_CHECKLIST.md update not included in tasks

**Category**: Consistency
**Location**: Implementation Tasks

**Problem**:
`docs/en/internal/PRODUCTION_CHECKLIST.md` line 164 contains "Log rotation is configured (optional)" without specific instructions. After implementing built-in rotation, this checklist item should be updated.

**Evidence**:
```
- [ ] Log rotation is configured (optional)
```

**Recommendation**:
Add a task: "Update PRODUCTION_CHECKLIST.md to document the built-in log rotation behavior and configuration."

---

### SF-3: Scope boundary with data/logs/ not explicitly stated

**Category**: Completeness
**Location**: Background section

**Problem**:
The project has two distinct log systems:
1. `logs/server.log` -- Server stdout/stderr redirected by `build-and-start.sh` (shell-level)
2. `data/logs/` -- Application-level conversation logs managed by `src/config/log-config.ts`

The Issue targets only (1), but without explicit scope boundary statement, implementers may be confused.

**Evidence**:
- `src/config/log-config.ts` L36: `return getEnvByKey('CM_LOG_DIR') || path.join(process.cwd(), 'data', 'logs');`
- `scripts/build-and-start.sh` L17: `LOG_FILE="$LOG_DIR/server.log"` where LOG_DIR is `$PROJECT_DIR/logs`

**Recommendation**:
Add a note: "Scope: This Issue targets `logs/server.log` only. Application-level logs under `data/logs/` are out of scope."

---

### SF-4: Threshold and generation count values are tentative

**Category**: Technical Validity
**Location**: Proposed Solution / Implementation Tasks

**Problem**:
"e.g., 10MB" and "e.g., 3 generations" indicate the values are undecided. Additionally, whether these should be configurable via environment variables or hardcoded constants is not specified.

**Recommendation**:
- Finalize default values: `MAX_LOG_SIZE_BYTES=10485760` (10MB), `MAX_LOG_GENERATIONS=3`.
- For the initial implementation, hardcoded constants in `build-and-start.sh` (shell variables) are sufficient.
- Document where the constants are defined (e.g., at the top of build-and-start.sh alongside existing LOG_DIR/LOG_FILE).

---

### SF-5: Implementation language/approach is unclear

**Category**: Completeness
**Location**: Implementation Tasks

**Problem**:
The implementation could be done in bash (within `build-and-start.sh`) or TypeScript (within `server.ts` or a new module). These are architecturally different approaches with different testability and maintenance characteristics.

| Approach | Pros | Cons |
|----------|------|------|
| Bash (build-and-start.sh) | Simple, no build step, matches existing pattern | Limited testability with Vitest |
| TypeScript (server.ts) | Testable with Vitest, type-safe | Only affects `npm start` path, not shell script |

**Recommendation**:
Since the Issue scope is limited to `build-and-start.sh --daemon`, a bash implementation within `build-and-start.sh` is the most natural choice. The task "Test addition" should specify whether this means bash-level testing (manual/script validation) or if a TypeScript wrapper is needed for Vitest testing.

---

## Nice to Have (3 items)

### NTH-1: Missing link to PRODUCTION_CHECKLIST.md

**Category**: Completeness
**Location**: Issue body

The production checklist already references log rotation as an optional item. Linking to it provides context.

**Recommendation**: Add "Related: docs/en/internal/PRODUCTION_CHECKLIST.md" to the Issue.

---

### NTH-2: Awareness of .claude/skills/rebuild/SKILL.md reference

**Category**: Completeness
**Location**: Issue body

The rebuild skill references `logs/server.log` for log viewing. While rotation does not change the primary log file name, awareness of this reference is useful during implementation.

**Recommendation**: Note `.claude/skills/rebuild/SKILL.md` as an awareness item (no changes needed).

---

### NTH-3: Missing operational duration context for the 46MB measurement

**Category**: Clarity
**Location**: Background - "46MB/182,000 lines"

The measurement of 46MB/182,000 lines lacks context on the operational duration. Knowing whether this was accumulated over days, weeks, or months helps validate the 10MB threshold choice.

**Recommendation**: If available, add the operational period (e.g., "accumulated over X weeks of operation").

---

## Code References

| File | Relevance |
|------|-----------|
| `scripts/build-and-start.sh` | Primary implementation target. L17 LOG_FILE definition, L107 nohup append |
| `server.ts` | Custom Next.js server source. TypeScript approach candidate |
| `src/config/log-config.ts` | data/logs/ configuration. Out of scope but referenced for disambiguation |
| `src/cli/utils/daemon.ts` | CLI daemon mode. L106 stdio:'ignore' - does not write to server.log |
| `scripts/stop-server.sh` | Server stop script. Same LOG_DIR/PID_FILE structure |
| `package.json` | L37 "start" script references dist/server/server.js (build output) |

## Document References

| File | Relevance |
|------|-----------|
| `docs/en/internal/PRODUCTION_CHECKLIST.md` | L164 Log rotation item. Needs update post-implementation |
| `.claude/skills/rebuild/SKILL.md` | References logs/server.log. Awareness item |
| `docs/user-guide/cli-setup-guide.md` | References tail -f logs/server.log. Awareness item |
