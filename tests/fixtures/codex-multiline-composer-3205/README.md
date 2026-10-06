# codex-multiline-composer-3205 — 入力欄が 2 行以上ある codex の画面（Issue #3205）

codex がアイドルなのに、入力欄に 2 行以上の文字があると `running` / `thinking_indicator` と
判定された。このディレクトリはその画面と、そこから作った対照の画面である。

**raw のまま置いている。ANSI を剥がさないこと**（`tests/fixtures/codex-live-2310/README.md` と同じ理由）。

使っているテスト:

- `tests/unit/lib/detection/codex-multiline-composer-3205.test.ts`
- `tests/unit/lib/detection/codex-verdict-corpus.test.ts`（codex の画面は全件ここに行を持つ）

| ファイル | 由来 | 中身 |
|---|---|---|
| `tc104-raw-pane.txt` | 実測。2026-10-04 の UAT（codex-cli **0.160.0**、develop `5d5592b8`）の `dev-reports/uat/2026-10-04-run-3183-3185/evidence/tc104-raw-pane.txt` をそのまま複写 | アイドルの codex。入力欄に未送信の 6 行（39〜44 行目） |
| `idle-composer-two-lines.txt` | `tc104-raw-pane.txt` の 39〜45 行目を `› hello` / `  world` / 空行に差し替えたもの | アイドルの codex。入力欄に 2 行 |
| `running-composer-two-lines.txt` | `tests/fixtures/codex-mid-turn-3337/codex-0.160.0-working-bullet.txt` の入力欄（`Ask Codex to do anything` の行）を `› follow-up line one` / `  follow-up line two` に差し替えたもの | 作業中の codex。追いの入力を 2 行打っている途中（陰性対照） |
