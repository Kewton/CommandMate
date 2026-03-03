# Issue #403 Stage 3 Review Report: Impact Scope Analysis

**Review Date**: 2026-03-03
**Focus**: Impact Scope (影響範囲レビュー)
**Stage**: 3 (1st Impact Scope Review)
**Previous Stages**: Stage 1 (通常レビュー) -> Stage 2 (反映)

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 5 |

**Overall Quality**: Good

The Issue, after Stage 2 revisions, is well-structured from an impact scope perspective. The scope clarification (limited to `build-and-start.sh --daemon`, `data/logs/` excluded, CLI daemon excluded) has been properly documented. No breaking changes are introduced. The main areas for improvement are: (1) documenting that `restart.sh` does not trigger rotation, (2) awareness of `logs.sh` limitations, and (3) concretizing the test strategy for bash scripts.

---

## Impact Scope Map

### Directly Modified Files

| File | Change Type | Description |
|------|-------------|-------------|
| `scripts/build-and-start.sh` | Modify | Add `rotate_logs()` function, `MAX_LOG_SIZE_MB`/`MAX_LOG_GENERATIONS` constants, rotation call before `nohup` |
| `docs/en/internal/PRODUCTION_CHECKLIST.md` | Modify | Update Log rotation checklist item |
| `docs/internal/PRODUCTION_CHECKLIST.md` | Modify | Update Log rotation checklist item (Japanese) |

### Indirectly Affected Files

| File | Impact | Reason |
|------|--------|--------|
| `scripts/stop-server.sh` | None | Shares `LOG_DIR`/`PID_FILE` vars but does not interact with log rotation. `server.log` filename unchanged |
| `scripts/restart.sh` | Low | Calls `stop.sh` + `start.sh` (not `build-and-start.sh`), so rotation is not triggered on this path |
| `scripts/setup.sh` | None | Calls `build-and-start.sh --daemon` at L118; on first setup, log file does not exist, so rotation is a no-op |
| `scripts/logs.sh` | Awareness | Only supports PM2/systemd logs. Does not show `build-and-start.sh --daemon` logs (pre-existing gap) |
| `scripts/status.sh` | None | Checks port/process/DB only. Does not reference log files |
| `scripts/health-check.sh` | None | Checks HTTP/DB/disk/memory only. Does not reference log files |
| `.claude/skills/rebuild/SKILL.md` | None | References `logs/server.log` for `tail -f`. Rotation does not change the primary log filename |
| `docs/user-guide/cli-setup-guide.md` | None | References `~/.commandmate/logs/server.log` (CLI path, different from `build-and-start.sh`) |
| `src/config/log-config.ts` | None | Controls `data/logs/` path. Completely independent from `logs/server.log`. Already marked as out-of-scope |
| `src/cli/utils/daemon.ts` | None | Uses `stdio: 'ignore'`. Does not write to `logs/server.log`. Already marked as out-of-scope |
| `.gitignore` | None | `logs/` directory is excluded. Rotated files (`server.log.1`, etc.) are automatically covered |

### Server Startup Paths and Rotation Behavior

| Startup Path | Rotation Executed? | Log File Written? |
|-------------|-------------------|-------------------|
| `scripts/build-and-start.sh --daemon` | Yes (proposed) | Yes (`logs/server.log`) |
| `scripts/build-and-start.sh` (foreground) | Yes (proposed) | No (stdout only) |
| `scripts/setup.sh` | Yes (calls `build-and-start.sh --daemon`) | Yes |
| `scripts/restart.sh` | No (calls `stop.sh` + `start.sh`) | Depends on PM2/npm |
| `commandmate start --daemon` (CLI) | No (different path) | No (`stdio: 'ignore'`) |
| `commandmate start` (CLI foreground) | No (different path) | No (`stdio: 'inherit'`) |

---

## Should Fix (3 items)

### IF-1: logs.sh Does Not Support build-and-start.sh Daemon Logs

**Category**: Affected Files
**Location**: Issue - Implementation Tasks

**Issue**:
`scripts/logs.sh` only supports PM2 (`pm2 logs`) and systemd (`journalctl`) log viewing. When the server is started via `build-and-start.sh --daemon`, there is no corresponding entry in `logs.sh` to display `logs/server.log`. While this is a pre-existing gap (not caused by this Issue), the introduction of log rotation makes it more relevant -- users may want to view both current and rotated log files.

**Evidence**:
- `scripts/logs.sh` L10-25: Only checks `pm2` and `systemctl`, falls back to "No logs found" message
- `scripts/build-and-start.sh` L118: Outputs `tail -f $LOG_FILE` as guidance after daemon start

**Recommendation**:
Add an awareness note in the Issue's impact scope section acknowledging that `logs.sh` does not support the `build-and-start.sh --daemon` log path. Addressing this gap is out of scope for this Issue but should be tracked as a future improvement.

---

### IF-2: restart.sh Path Does Not Trigger Rotation

**Category**: Affected Files
**Location**: Issue - Design Policy

**Issue**:
`scripts/restart.sh` calls `./scripts/stop.sh` and `./scripts/start.sh` -- NOT `build-and-start.sh`. Since the rotation function `rotate_logs()` will be implemented inside `build-and-start.sh`, restarts via `restart.sh` will not trigger log rotation. This creates a behavioral difference between:
- `stop-server.sh` + `build-and-start.sh --daemon` (rotation executes)
- `restart.sh` (rotation does NOT execute)

However, `restart.sh` uses PM2 when available (which has its own log management), and when PM2 is unavailable, it uses `stop.sh` + `start.sh` which runs `npm start` in foreground (no log file). The practical impact is therefore limited.

**Evidence**:
- `scripts/restart.sh` L21-24: Calls `./scripts/stop.sh` then `./scripts/start.sh`
- `scripts/start.sh` L25/L43: Uses PM2 or direct `npm start` (foreground, no file redirect)
- `.claude/skills/rebuild/SKILL.md` L39: Uses `./scripts/stop.sh && ./scripts/build-and-start.sh --daemon` (correctly triggers rotation)

**Recommendation**:
Add a note in the Issue's design policy section: "Log rotation is triggered only when `build-and-start.sh` is executed. The `restart.sh` script uses a different startup path (`start.sh`) and does not trigger rotation. This is by design, as `start.sh` either uses PM2 (with its own log management) or runs in foreground mode."

---

### IF-3: Test Strategy for Bash Script Needs Concretization

**Category**: Test Scope
**Location**: Issue - Implementation Tasks ("Test addition")

**Issue**:
The implementation task states "Test addition" but does not specify how to test a bash function. The project uses Vitest for TypeScript tests, which cannot directly test shell scripts. There is no existing shell test framework (e.g., bats) in the project. Without a clear test strategy, the "test addition" task is ambiguous and may be overlooked.

**Evidence**:
- No files matching `tests/**/*script*` exist in the project
- `package.json` test scripts: `test:unit` (Vitest), `test:integration` (Vitest), `test:e2e` (Playwright) -- none support shell testing
- The `rotate_logs()` function is pure bash with no TypeScript interface

**Recommendation**:
Replace the ambiguous "Test addition" task with concrete verification steps:
1. Manual test procedure documented in the PR (create a test log file exceeding 10MB, run `build-and-start.sh --daemon`, verify rotation output)
2. Edge case verification: empty log file, missing log file, exactly at threshold
3. Optionally, add a self-test function to `build-and-start.sh` (e.g., `--test-rotation` flag) that creates temporary files and verifies rotation behavior

---

## Nice to Have (5 items)

### IF-4: PRODUCTION_CHECKLIST.md Japanese Version Not Mentioned in Tasks

**Category**: Documentation Update
**Location**: Issue - Implementation Tasks

Both `docs/en/internal/PRODUCTION_CHECKLIST.md` (L164) and `docs/internal/PRODUCTION_CHECKLIST.md` (L164) contain the "Log rotation is configured (optional)" item. The Issue's implementation task only mentions the English version. The Japanese version should also be updated.

**Recommendation**: Update the task to explicitly mention both files.

---

### IF-5: Monthly "Log Cleanup" Item in PRODUCTION_CHECKLIST.md

**Category**: Documentation Update
**Location**: Issue - Implementation Tasks

The PRODUCTION_CHECKLIST.md's "Production Monitoring" section (L345 English) includes a "Monthly - Log cleanup" item. After rotation is implemented, this item could be updated to note that automatic cleanup occurs via rotation.

**Recommendation**: When updating PRODUCTION_CHECKLIST.md, also update the Monthly Log cleanup item to reference the built-in rotation feature.

---

### IF-6: Cross-Platform File Size Detection in Bash

**Category**: Dependencies
**Location**: Issue - Design Policy

The `rotate_logs()` function needs to determine file size. The `stat` command has different syntax on macOS (`stat -f%z`) vs. Linux (`stat -c%s`). The existing `build-and-start.sh` does not have platform-specific code.

**Recommendation**: Mention in the design policy that POSIX-compliant methods should be preferred for file size detection. `wc -c < "$LOG_FILE"` is portable across macOS and Linux.

---

### IF-7: CM_LOG_DIR Environment Variable Independence (Confirmation)

**Category**: Environment Variables
**Location**: Issue - Overview

`CM_LOG_DIR` controls `data/logs/` (application logs via `src/config/log-config.ts`). `scripts/build-and-start.sh` uses `$PROJECT_DIR/logs` (hardcoded, not configurable via env). These are completely independent, and the Issue correctly marks `data/logs/` as out-of-scope.

**Recommendation**: No action required. This is a confirmation that the separation is correctly documented.

---

### IF-8: .gitignore Coverage (Confirmation)

**Category**: Affected Files
**Location**: N/A

`.gitignore` L52 excludes the entire `logs/` directory. Rotated files (`server.log.1`, `server.log.2`, etc.) will be automatically excluded.

**Recommendation**: No action required.

---

## Breaking Changes

None. The changes are additive:
- `rotate_logs()` is a new function in `build-and-start.sh`
- Existing behavior is preserved (log files continue to be written to `logs/server.log`)
- No existing interfaces, APIs, or configuration formats are changed
- No migration is required for existing users

---

## Referenced Files

### Scripts
| File | Relevance |
|------|-----------|
| `scripts/build-and-start.sh` | Direct modification target. L16-18 define LOG_DIR/LOG_FILE, L107 nohup append |
| `scripts/stop-server.sh` | Shares LOG_DIR/PID_FILE. No impact confirmed |
| `scripts/restart.sh` | Alternative restart path (stop.sh + start.sh). Does not trigger rotation |
| `scripts/logs.sh` | PM2/systemd only. Pre-existing gap for daemon log viewing |
| `scripts/setup.sh` | Calls build-and-start.sh --daemon at L118. No impact |
| `scripts/status.sh` | Port/process/DB check only. No log file reference |
| `scripts/health-check.sh` | HTTP/DB/disk/memory check only. No log file reference |

### Source Code
| File | Relevance |
|------|-----------|
| `src/config/log-config.ts` | `data/logs/` path. Independent from `logs/server.log`. Out-of-scope confirmed |
| `src/cli/utils/daemon.ts` | CLI daemon: `stdio: 'ignore'`. Out-of-scope confirmed |
| `src/lib/env.ts` | `CM_LOG_DIR` env mapping. Independent from shell LOG_DIR |

### Documentation
| File | Relevance |
|------|-----------|
| `docs/en/internal/PRODUCTION_CHECKLIST.md` | L164 Log rotation item (update required) |
| `docs/internal/PRODUCTION_CHECKLIST.md` | L164 Japanese Log rotation item (update also needed - IF-4) |
| `.claude/skills/rebuild/SKILL.md` | References `logs/server.log`. No impact |
| `docs/user-guide/cli-setup-guide.md` | References CLI log path. No impact |
| `docs/en/user-guide/cli-setup-guide.md` | English version. No impact |
| `docs/DEPLOYMENT.md` | References `build-and-start.sh --daemon`. No additional update needed |

### Configuration
| File | Relevance |
|------|-----------|
| `.gitignore` | `logs/` excluded. Rotated files auto-covered |
