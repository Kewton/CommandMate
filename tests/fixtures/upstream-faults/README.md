# 上流障害の画面（`matchUpstreamFault` の入力）

| ファイル | 出どころ |
|---|---|
| `context-limit-command-code-3011.txt` | Command Code の実測の画面（Issue #3011） |
| `codex-model-capacity-3936.txt` | **合成。実機の frame ではない**（Issue #3936、下の節） |
| `codex-0.160.0-model-capacity-3946.txt` | **合成。実機の frame ではない**（Issue #3946、下の節） |
| `codex-0.160.0-model-capacity-next-turn-3946.txt` | **合成。実機の frame ではない**（Issue #3946、下の節） |

## `codex-model-capacity-3936.txt`（合成）

- **出どころ: summary の引用。** 2026-10-26 の run の `summary-3925-3928.md` の 8-3 の 3 に引用された文言
  「Selected model is at capacity」と、Issue #3936 の本文の候補 `■ Selected model is at capacity. Please try a different model.`
  から作った。capacity の画面は記録が残っておらず、混雑は意図して起こせないので、実機の codex では採っていない
- **土台は実測の画面。** `../codex-idle-composer-0155/idle-after-turn.txt`（codex-cli 0.155.1 のアイドル入力欄、実測・匿名化済み）の
  1-based 126 行目（`Worked for 2m 32s · done 3:01 AM`、ターン終了の行）を、上の 1 行に差し替えただけ。ほかの 1001 行・ANSI・入力欄の行（129 行目）は元とバイト一致
- 行頭の `■ ` は codex 0.160.0 の実測のエラー行（`../startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt` の `■ Conversation interrupted …`）の形に合わせた。
  capacity の行が実際にこの形（行頭 `■ `、列 0）・この位置（入力欄の直上）に出るかは**確かめていない**。規則 `model-capacity` はこの行頭の形に錨を置いている
  （返答の本文が文言を引用しているだけの行に当たらないため。整合性レビュー P1）
- 配置は inline の codex の形で、内容はステータス行の 131 行目で終わり（入力欄は 129 行目）、その下の約 870 行は空。`realtimeSnippet` は末尾が空なので内容の最終行まで戻って切り出す（#2768）。
  push の判定（`response-checker`）も同じ切り出しを使う（#3936。以前は生の末尾 100 行で、この画面では null だった）
- 確かめられること: 規則がこの行に当たること、行を差し替えても codex の状態判定が `ready` のままであること。
  確かめられないこと: 実機の画面で capacity の行が入力欄に戻った後も `realtimeSnippet` に残るか、`current-output` が `ready` かつ
  `isUnclassifiedActive !== true` の経路でこの画面を返すか。実機の frame が採れたら、この合成と差し替える

## `codex-0.160.0-model-capacity-3946.txt` / `codex-0.160.0-model-capacity-next-turn-3946.txt`（合成）

- **土台は実測の画面。** `../startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt`（codex-cli 0.160.0、私設 tmux・200x1000 の実測）。
  上に transcript（2〜11 行目）、12〜996 行目は空行、下端の 997〜1000 行目に入力欄とフッタ、という分かれた画面
- `codex-0.160.0-model-capacity-3946.txt`: 1-based 11 行目（`■ Conversation interrupted - use /feedback if something went wrong`、transcript の最後の内容行）を
  `■ Selected model is at capacity. Please try a different model.` に差し替えただけ。ほかの行は元とバイト一致。
  実機の codex は起動していない（混雑は意図して起こせず、capacity の画面は記録が無い）。capacity の行が実機でもこの形・この位置に出るかは**確かめていない**
- `codex-0.160.0-model-capacity-next-turn-3946.txt`: 上の合成に、正常な次のターンを足したもの。13 行目に入力のエコー（`› Say hello in one short sentence.`。8 行目と同じ ANSI）、
  15 行目に返答（`• Hello there!`）、17 行目に `  Worked for 3s • 10:33` を書いた。いずれも元は空行。実測の `codex-0.160.0-first-turn-reply.txt` の並びに合わせたが、この画面そのものは採っていない
- 使い道: 末尾 100 行の窓（`realtimeSnippet`）は入力欄を含むのでそのまま返り、11 行目は窓の外になる。
  `matchPaneUpstreamFault`（`src/lib/realtime-snippet.ts`）が codex のときだけ transcript の最後の内容行を `■ ` の規則で読むことを確かめる（前者は `model-capacity`、後者は null）
