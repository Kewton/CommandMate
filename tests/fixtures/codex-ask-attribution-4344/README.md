# codex rollout — 封筒つきの大きな貼り付けの実記録（Issue #4344 PR2、Q3）

ask の帰属（`docs/design/ask-attribution-4344.md` §6 PR2、§8 Q3）で、codex の capability を true にする条件の試験に使う 1 本。

**出典**: 2026-11-14 00:15 JST の実測（リーダー、`workspace/orchestration/runs/2026-11-14/lead-return-q3-probe-4344.md`、リポジトリ外）。
codex-cli **0.167.2**（`session_meta.payload.cli_version`）へ `commandmate send` で 1 回送った
9,428 bytes・63 行の本文（1 行目が封筒 `[cmate-ask v1 43440003-0000-4000-8000-000000004344]`、末尾が `END-OF-PROBE-4344-Q3`）の
rollout `rollout-2026-11-14T00-01-19-01a1d56d-69a6-7fd3-a2b9-35e6836ec3fb.jsonl` の 1 行目と 156〜165 行目。採取日 2026-11-14。

| 行 | 元の行 | 中身 | 変えたところ |
|---|---|---|---|
| 1 | 1 | `session_meta`（`session_id`・`cli_version: 0.167.2`） | アカウント ID・`base_instructions`・`cwd`・git 等を削った（`cwd` は `<CWD>`） |
| 2 | 156 | `thread_settings_applied`（`thread_id` あり・`turn_id` なし） | `thread_settings` を `{elided:true}` に |
| 3 | 157 | `task_started`（`turn_id` あり） | なし |
| 4 | 158 | `turn_context` | 中身を `turn_id`・`root_turn_id` 以外 `{elided:true}` に |
| 5 | 159 | `response_item` / `message` / role `user` | 本文の詰め物を短くした（下） |
| 6 | 160 | `event_msg` / `item_completed` / `UserMessage`（`thread_id`・`turn_id`・`item.id`） | 本文の詰め物を短くした（下） |
| 7 | 161 | `item_completed` / `AgentMessage`（`final_answer`、本文 `ok`） | なし |
| 8 | 162 | `response_item` / role `assistant` | なし |
| 9 | 163 | `token_usage_record`（`thread_id`・`session_id`・`turn_id`） | `usage` 等を `{elided:true}` に |
| 10 | 164 | `token_count` | `info` を `{elided:true}` に |
| 11 | 165 | `task_complete`（`turn_id` あり、`thread_id` なし＝設計 Q1 の形） | なし |

- **本文の詰め物**: 実記録では `UserMessage` と role `user` の `response_item` の本文が、送った全文（封筒・展開後の 61 行・末尾の行）と完全一致していた。
  fixture では封筒・指示の 1 行・詰め物の 1〜3 行目・末尾の `END-OF-PROBE-4344-Q3` だけを残した（形は保つ: 1 行目が封筒、2 つの本文は同一、末尾の行あり）
- TUI は入力欄で `[Pasted Content …]` に畳むが、rollout の本文には影響しない（実測の結論）
- ガード `tests/unit/guards/ask-capability-controls-4344.test.ts` が、版（`ASK_ATTRIBUTION_MIN_VERSIONS.codex` 以上）と必須の record
  （封筒つき `UserMessage` の `thread_id`・同じ `turn_id` の `AgentMessage` と `task_complete`・2 つの本文の一致と末尾の行）を確かめる。
  `tests/unit/hooks/sources/codex-ask-attribution-4344.test.ts` がこの fixture を reader に通し、`matched`・返答 `ok` を確かめる
