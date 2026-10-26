# 上流障害の画面（`matchUpstreamFault` の入力）

| ファイル | 出どころ |
|---|---|
| `context-limit-command-code-3011.txt` | Command Code の実測の画面（Issue #3011） |
| `codex-model-capacity-3936.txt` | **合成。実機の frame ではない**（Issue #3936、下の節） |

## `codex-model-capacity-3936.txt`（合成）

- **出どころ: summary の引用。** 2026-10-26 の run の `summary-3925-3928.md` の 8-3 の 3 に引用された文言
  「Selected model is at capacity」と、Issue #3936 の本文の候補 `■ Selected model is at capacity. Please try a different model.`
  から作った。capacity の画面は記録が残っておらず、混雑は意図して起こせないので、実機の codex では採っていない
- **土台は実測の画面。** `../codex-idle-composer-0155/idle-after-turn.txt`（codex-cli 0.155.1 のアイドル入力欄、実測・匿名化済み）の
  1-based 126 行目（`Worked for 2m 32s · done 3:01 AM`、ターン終了の行）を、上の 1 行に差し替えただけ。ほかの 1001 行・ANSI・入力欄の行（129 行目）は元とバイト一致
- 行頭の `■ ` は codex 0.160.0 の実測のエラー行（`../startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt` の `■ Conversation interrupted …`）の形に合わせた。
  capacity の行が実際にこの形・この位置（入力欄の直上、`realtimeSnippet` の末尾 100 行の内側）に出るかは**確かめていない**
- 確かめられること: 規則がこの行に当たること、行を差し替えても codex の状態判定が `ready` のままであること。
  確かめられないこと: 実機の画面で capacity の行が入力欄に戻った後も `realtimeSnippet` に残るか、`current-output` が `ready` かつ
  `isUnclassifiedActive !== true` の経路でこの画面を返すか。実機の frame が採れたら、この合成と差し替える
