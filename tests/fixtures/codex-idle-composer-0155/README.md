# codex 0.155.1 のアイドル入力欄、実測（Issue #2798）

codex-cli **0.155.1** は、アイドルの入力欄の `›` を**太字＋truecolor のオレンジ**で描くようになった。
#2310 の行判定（`readCodexGlyphRowKind`）は「グリフに色が付いていれば選択肢」と読んでいたため、
**ターンが終わってアイドルに戻ったフレーム**が `waiting` / `codex_selection_list` になり、
チャット面が選択リストのカードのまま固まっていた。このディレクトリはその 1 枚である。

**raw のまま置いている。ANSI を剥がさないこと。** 判定の根拠は SGR 属性だけで、
剥がしたフレームでは入力欄・transcript のエコー・ダイアログの選択行が同じバイトになる
（`tests/fixtures/codex-live-2310/README.md` と同じ理由）。

## Provenance — ここに fixture を足す前に読むこと

| | |
|---|---|
| ファイル | `idle-after-turn.txt` の 1 枚。**live capture を匿名化したもの**（編集点は下の「編集」に全部書いた） |
| build | codex-cli **0.155.1**（バナー `OpenAI Codex (v0.155.1)`、同じ payload の `detector.staleness.codex.installed` も `0.155.1`。`verifiedAgainst` は `0.148.0`） |
| model | `gpt-5.6-terra max` |
| 採取日時 | **2026-09-21 11:06 JST**（Issue 起票と同じ日、同じセッション） |
| 採取経路 | 稼働中の本番サーバ `:3000` への `GET /api/worktrees/commandagent-develop/current-output?cliTool=codex&instance=codex`（Issue 本文の「再現」の curl そのもの）。返ってきた JSON の **`fullOutput` フィールド**をそのまま使った。つまりサーバ自身の `capture-pane -e`（ANSI 付き）の結果で、検出器が実際に読んだ入力と同じバイトである |
| 起動したもの | **無し。** サーバ・tmux セッション・codex はどれも起動も停止もしていない（読み取りの GET 1 回だけ）。tmux には直接触れていない |
| geometry | 本番のペイン 200x1000。payload の `lineCount` は **1002**、ファイルも `split('\n')` で 1002 行（`fullOutput` を末尾改行なしでそのまま書いた） |
| 採取時の payload | `sessionStatus: "waiting"`, `sessionStatusReason: "codex_selection_list"`, `isSelectionListActive: true`, `composerState: "ghost"`, `isGenerating: false` — Issue 本文の実測と一致 |
| 元のフレーム | コミットしていない（非公開リポジトリの会話が含まれるため）。作業中はリポジトリ外の一時領域にだけ置き、比較を終えた後に削除した |

## 編集

1. **1-based 20〜124 行目（0-based 19〜123）の可視テキストを置換した。** 非公開リポジトリの会話
   （利用者が貼った作業メモ、ツール呼び出しのパス、アシスタントの回答本文）である。
   - **行数・空行の位置・ANSI を含む行の位置は元と同じ**（空行 25 本、ANSI 行 31 本とも一致）
   - codex 自身の語彙と SGR はバイトのまま残した: エコー行の `ESC[1;2m› ESC[0m`、`• Ran` / `• Explored` /
     `└` / `│` / `Read` / `List` / `… +N lines (ctrl + t to view transcript)`、番号付き段落の
     `ESC[38;5;12m1. ESC[39m`〜`4.`、コマンド行のシンタックスハイライトのエスケープ列。
     置き換えたのはその間の文字だけ（パスは `notes/sample-task/...`、URL は `/sample/app/`）
2. **`github_kewton/CommandAgent-develop` → `example-owner/demo-agent-workspace`**（34 文字 → 34 文字で桁は動かない）。
   6 行目（バナー）と 131 行目（ステータスバー）の 2 か所だけ
3. それ以外の行（1〜19 行目、125〜1002 行目）は 2. を除いて**元とバイト一致**。
   **問題の 129 行目（入力欄）は一切編集していない**

### 匿名化で判定が変わっていないことの確認

元のフレームと匿名化後のフレームに同じ読み取りを全部かけ、出力が**完全一致**することを
修正前・修正後の両方で確かめた（`detectSessionStatus` の status / reason / hasActivePrompt / promptDetection、
`findCodexBottomGlyphRow`、`readCodexDialogFrame`、`isCodexStalePrompt`、`extractComposerText`、
`findCodexChromeStart`、ANSI を剥がした場合の status、`detectAgentMode`）。

| | 修正前（`develop` 13cfe5c6） | 修正後（#2798） |
|---|---|---|
| status / reason | **`waiting` / `codex_selection_list`** | `ready` / `input_prompt` |
| 最下段の `›` 行 | **row 128 = `option`** | row 128 = `composer` |
| `readCodexDialogFrame` | **`by: 'glyph'`、options 4 件**（下の番号付き段落） | `null` |
| `extractComposerText` | `ghost` | `ghost`（変わらない） |
| `findCodexChromeStart`（#2400） | **`-1`** | `128` |
| ANSI を剥がした場合 | `ready` | `ready` |

修正前は `codexDialogFooterUnrecognised` の警告も出ており、その `footer` にはアシスタントの回答本文が
入っていた（ダイアログではないので「フッタ」は地の文だった）。修正後は出ない。

## `›` 行（`cat -v`、`^[` が ESC）

| 行（0-based） | 生の行 | 判定 |
|---|---|---|
| 11 | `^[[1;2m› ^[[0ma` | transcript echo — glyph が dim |
| 19 | `^[[1;2m› ^[[0m下記のメモから再開してください。…` | transcript echo — glyph が dim（本文は置換済み） |
| 128 | `^[[1m^[[38;2;255;178;66m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | **composer**。glyph は太字＋truecolor、`ESC[0m` で閉じてから dim のプレースホルダ |

0.148.0〜0.154.0 の入力欄は `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m`（色なし）だった。
変わったのは glyph に `ESC[38;2;255;178;66m` が乗ったことだけで、**glyph の直後で `ESC[0m` を撃つ**点は同じ。
ダイアログの選択行（`^[[1m^[[38;5;6m› 1. Yes, proceed (y)^[[0m` / `^[[38;5;6m› 1. Yes, continue^[[39m`）は
glyph とラベルが**同じ SGR の 1 スパン**で、間に属性の変化が無い。#2798 の規則はこの差を読む。

## この fixture が扱わないもの

- **0.155.1 のダイアログは再採取していない。** 承認・`/model`・`/experimental`・`/keymap`・trust の選択行の形は
  0.153.2 以前の実測（`codex-live-2310/` ほか）のままである。0.155.1 がダイアログの選択行を
  「色付き glyph → リセット → 装飾なしラベル」に変えていたら、#2798 の規則はそれを入力欄と読む（#2310 の向きの誤り）。
  再採取には tmux セッションが要り、#2798 の作業契約はそれを禁じているので後続に残す
- **0.155.1 で文字を打ち込んだ入力欄・貼り付けた入力欄も実測していない。** テストの該当行は、この実測 glyph に
  実測ラベル（0.148.0 の `codex-live-1890/composer-residual-plain.txt`、0.154.0 の `long-body-2464/codex-pasted-content.capture`）を
  組み合わせた**合成**であり、テスト側にもそう書いてある
