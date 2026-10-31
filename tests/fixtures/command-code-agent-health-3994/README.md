# command-code-agent-health-3994 — command-code 1.84.0 turns the model provider refused

Used by `tests/unit/lib/agent-health/model-auth-3994.test.ts` (Issue #3994; #3988 / #3989 / #3990).

| File | What | Source |
|---|---|---|
| `auth-failed-running-turn.txt` | `Run the shell command: sleep 20` answered with `⚠ Error: Authentication failed. …` and `⚠ taste learning failed: … 401 error: Invalid 'Authorization' header or token.` | Issue #3989 (`screen-running`), the `## 証拠` block |
| `auth-failed-approval-turn.txt` | the same turn, then `Run the shell command: touch agent-health-probe.txt` refused the same way (no approval dialog) | Issue #3990 (`screen-approval`), the `## 証拠` block |

Both are the report's `paneEvidence` (ANSI stripped, the empty rows above the
transcript dropped) as the daily run of 2026-10-29 filed them, kept byte for
byte. On that morning Command Code was unavailable after a security incident,
so every turn ended in the authentication error without a model reply — the
checks could not be done, nothing in CommandMate was broken.
