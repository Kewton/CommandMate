# opencode のモーダルオーバーレイ検出 — 実測と設計（Issue #2112）

対象: opencode 1.18.22 / CommandMate `fix/2112-opencode-dialog`
計測日: 2026-08-27（新規キャプチャは無し。既存 commit 済み fixture を実 detector に通した）
計測に使った fixture:

- `tests/fixtures/opencode-live-2046/w80/` — #2046 が実 TUI のキーストロークで開いた 4 ダイアログ（80x200 = 本番幾何）
- `tests/fixtures/opencode-live-2047/w{80,120,200}/` — 同じパレットを 3 幅で
- `tests/unit/lib/detection/fixtures/opencode-live-{1883,1893,1894,1896,1906}/`
- `tests/fixtures/opencode-live-2049/`, `tests/fixtures/canary/`

---

## 1. 症状の実測（修正前）

| フレーム | フッタ | `detectSessionStatus` | `isSelectionListActive` | `wait` |
|---|---|---|---|---|
| `dialog-agent-list` | `Select agent … esc` | `ready` / `opencode_response_complete` | false | **exit 0（誤り）** |
| `dialog-session-list` | `Sessions … esc` | `ready` / `opencode_response_complete` | false | **exit 0（誤り）** |
| `dialog-timeline` | `Timeline … esc` | `ready` / `opencode_response_complete` | false | **exit 0（誤り）** |
| `dialog-command-palette` | `Commands … esc` | `running` / `unknown_frame` | false | 60 秒後に exit 10 |

Issue 本文の表と一致した。**食い違いは無い。**

3 件が `ready` になる経路は branch D（`OPENCODE_TURN_COMPLETE_PATTERN`）で、
拾っているのは**ダイアログを開く前のターンの完了マーカー**（`▣ Build · Claude Sonnet 4.6 · 2.8s`）。
オーバーレイはそれを画面から消さないので、マーカーは実在したまま「今の判定」に化ける。

`ready` は**肯定的証拠**なので `isUnclassifiedActive` が立たず、#1017 / #1494 の
60 秒エスケープハッチには永久に届かない。claude の `/help`（`running` / `default`）が
同じ形の良性版で、そちらはハッチが開く。

---

## 2. なぜ allowlist 拡張では足りないか

`OPENCODE_SELECTION_LIST_PATTERN`（#473 → #1896 で narrow）が受け付ける見出しは
`Select model` / `Select provider` / `Connect a provider` の 3 つだけで、`Select agent` すら落ちる。

見出しを 5 つ足せば `isSelectionListActive` は立つが、**`ready` を返すのは branch D であって
branch C ではない**。branch C は branch D より前にあるので順序としては直せるが、
それは「見出しの語彙をどれだけ集めたか」に完了判定を賭けることになる。
#1896 が実測した害（回答本文の `Select model to continue:` でセッションが
`waiting` に永久固着）は、語彙を長くするほど確率が上がる。

さらに実測で分かったこと: **`opencode-live-2047/w{120,200}/command-palette.txt` では
オーバーレイの左右に transcript が見えている**。行全体の形（行長・行末の `esc`）に
賭ける規則はこの幅で必ず外れる。

→ **完了判定の前に置くゲート**にし、**判定は幾何**にした。

---

## 3. 採用した signature（構造）

opencode はダイアログを**背景色で塗った矩形**として描く。`capture-pane -e` は
その背景をそのまま再送する。

```
  ␛[48;2;20;20;20m    Commands                     ␛[38;2;128;128;128mesc␛[0m    ␛[48;2;4;4;4mlogical
  └ column 10 ─────────────────────────────────────────────────────────┘ column 70
```

矩形の**両端の桁が行をまたいで一定**であり、その矩形の**タイトルバー行の右端に
`esc` ハッチが右詰めで入る**。実装は `src/lib/detection/opencode-modal-overlay.ts`。
判定条件は 6 つで、すべて layout についての条件（語彙は一切見ない）:

| # | 条件 | 定数 | 実測値 |
|---|---|---|---|
| 1 | 両端に背景境界がある／間が全部塗られている | — | — |
| 2 | 境界が本物の遷移（外側と内側で背景が違う） | — | — |
| 3 | 左端が 1 桁目以降 | `OPENCODE_OVERLAY_MIN_LEFT`=1 | 実測 1 / 10 / 30 / 70 |
| 4 | 幅 | `OPENCODE_OVERLAY_MIN_WIDTH`=16 | 実測 60 / 78 |
| 5 | 行数 | `OPENCODE_OVERLAY_MIN_ROWS`=3 | 実測 8〜72 |
| 6 | ハッチが矩形の上から数行以内 | `OPENCODE_OVERLAY_HEADER_ROW_LIMIT`=3 | 実測 **全 11 件で 1**（0 行目は上パディング） |
| 7 | 矩形の直左／左端が opencode の box gutter（`│┃╹`）でない | — | — |

条件 3 と 7 は実測から出た。3 が無いと 200 桁のフレーム（テーマがペイン全体を
`48;2;4;4;4` で塗る）で全行が「矩形」になる。7 が無いと composer と
ユーザー発話バブル（どちらも塗られた矩形）が矩形として通る。

`esc` は**矩形の右端に接している**ことを要求する。これが
`esc interrupt` / `esc again to interrupt`（生成中の composer フッタ、これも塗られた矩形）
との違いで、`OPENCODE_SELECTION_LIST_PATTERN` が行末 `$` を要求しているのと同じ論法。

### 全 fixture への適用結果（102 ファイル）

一致したのは 11 件だけで、すべて実際にオーバーレイが開いているフレーム:

`opencode-live-2046/w80/dialog-{agent-list,session-list,timeline,command-palette}`,
`opencode-live-2047/w{80,120,200}/command-palette`, `opencode-live-2049/command-palette-11822`,
`opencode-live-1896/{command-palette,model-picker}`, `canary/opencode-picker.raw`。

claude / codex / copilot の fixture、opencode の idle・生成中・permission・
#1896 の prose trap は 1 件も一致しない。

---

## 4. #2095 を流用できるか（読んだ上での判断）

**流用できない。理由は測って確かめた。**

`src/lib/detection/opencode-pane-obstruction.ts`（#2095）が読むのは
「**入力ボックスの下辺 `╹▀{4,}` の右端より右に文字を持つ行が 2 行以上**」＝
サイドバーが transcript と行を共有していること。ダイアログは入力ボックスを
**フル幅のまま残して上に浮く**ので、この規則は 4 フレームすべてで `null` を返す
（`detection-opencode-modal-overlay-2112.test.ts` にアサーションとして固定した）。

流用したのは**方法と形**:

- 「語彙ではなく幾何」という判断そのもの（#2095 の docblock の議論をそのまま踏襲）
- leaf module の形（`stripAnsi` / excerpt bound / column rule しか import しない）
- `indexAtColumn` の**実体**。#2095 の private helper を `src/lib/detection/terminal-columns.ts`
  に移し、両者が同じ「桁」の定義を共有するようにした（結合文字は 0 桁、East Asian
  wide の 2 桁は意図的に補正しない。理由はその関数の docblock）

publish 経路は流用していない。#2095 の `paneObstruction` は「証拠なし側に落ちた理由を
添える」ための payload で、こちらは**判定そのものを変える**必要があるため
`sessionStatusReason` = `opencode_modal_overlay` として検出チェーン（branch C2）に入れた。

---

## 5. 未計測（このIssueでは埋めていない）

- **`ctrl+x t`（Switch theme）** — fixture 無し。**未計測。**
- **`ctrl+t`（Variant cycle）／`Switch model variant`** — fixture 無し。**未計測。**
- **`F2`（`model_cycle_recent`）** — #2046 が測らなかったのと同じ理由（recent list を
  作るにはピッカーで実際にモデルを選ぶ必要があり、それは利用者の既定モデルを書き換える）。**未計測。**

`ctrl+x t` は `dialog-command-palette.txt:96` に `Switch theme   ctrl+x t` として
**キーバインド表には出ている**が、押した後のフレームは撮っていない。
パレット・セッション一覧・エージェント一覧・タイムライン・モデルピッカーが
すべて同一の矩形 chrome で描かれている（実測 5 種、左端 1/10/30/70・幅 60/78・
ハッチ行 index 1 が全件一致）ことから同じ形だと**予想**されるが、予想は実測ではない。

実機で埋める場合の手順は `docs/design/opencode-server-live-verification.md` §4 / §22
（私設 tmux ソケット `tmux -L <name>`、`kill-server` 禁止・`kill-session -t '=<name>:'`、
`TMUX_TMPDIR` は隔離手段にならない、pane は 200x1000、隔離 `HOME` は
**tmux サーバ側**に設定して `GET /path` で確認）。

---

## 6. 変更の影響（実測）

| フレーム | 変更前 | 変更後 |
|---|---|---|
| `2046/dialog-{agent-list,session-list,timeline}` | `ready` / `opencode_response_complete` | **`waiting` / `opencode_modal_overlay`** |
| `2046/dialog-command-palette` | `running` / `unknown_frame` | **`waiting` / `opencode_modal_overlay`** |
| `2047/w{80,120,200}/command-palette` | `running` / `unknown_frame` | **`waiting` / `opencode_modal_overlay`** |
| `2049/command-palette-11822` | `running` / `unknown_frame` | **`waiting` / `opencode_modal_overlay`** |
| `1896/command-palette` | `running` / `unknown_frame` | **`waiting` / `opencode_modal_overlay`** |
| `1896/model-picker`, `canary/opencode-picker` | `waiting` / `opencode_selection_list` | 不変（branch C が先に答える） |
| 上記以外の全 fixture（claude / codex / copilot / gemini 含む） | — | 不変 |

`1896/command-palette` が `tests/unit/detection/tools/unclassified-frames.test.ts` の
別表（`isUnclassifiedActive: true` の全件リスト）から**抜ける**。
床が広がったのではなく肯定的規則が書かれたための離脱で、DR2-001 が望む方向。

Auto-Yes は影響を受けない。`tools/opencode/prompt.ts` の `detectOpenCodeDialog` にも
同じ規則を足したが、opencode の dialog はすべて `answerMode: 'keys'` なので
ゲートの結論は変わらない（`null` も `keys` も「送るな」）。加えて Auto-Yes は
ANSI を落としたフレームを渡すので、この規則はその経路では常に `null` を返す。
