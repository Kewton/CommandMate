# Issue #1623 設計方針: attach 時の「読むモード」

tmux セッションに attach しても読みたい内容が一行も見えない問題を、ジオメトリを
一切変えずに **オンデマンドの読むモード** で解決する。

- 案A: `prefix+g` → `display-popup` ページャ（tmux 内で読む）
- 案B: `commandmate capture <id> --pane`（attach せずに読む・tmux バージョン非依存）

Issue 本文が「着手前に解く必要がある」とした 5 件を、実機計測を根拠に確定した記録。
実測はすべて **tmux 3.5a / macOS(darwin 25.5.0) / 本番セッションの read-only 計測 +
`tmux -L` 私設サーバでの再現実験** による。

---

## 前提の裏取り（Issue 本文 vs 実測）

| Issue 本文の記述 | 実測 | 判定 |
|---|---|---|
| 全セッションが 200×1000・`window-size manual` | `mcbd-claude-*` / `mcbd-codex-*` の 3 セッションで `200x1000 winsize=manual` | 一致 |
| cursor_y = 997 | 3 セッションすべてで 997 | 一致 |
| Claude は alternate screen・`history_size=0` | `alt=1 hist=0` | 一致 |
| `prefix+g` は素の tmux 3.5a で未割当 | `list-keys -T prefix g` が exit 1 / `unknown key: g` | 一致（ただし他人の `.tmux.conf` は別なので衝突検査は必須） |
| `#{m:mcbd-*,#{session_name}}` が非対象で 0 | `mcbd-probe-1623` → `1`、`other-session` → `0` | 一致 |
| `display-popup` はフォーマット非展開 | 私設サーバで再現（セッションはスクリプト側で解決する方式が正解） | 一致 |
| `-e` 捕捉に SGR のみの見かけ空行がある | 1000 行中 7 行（すべて `ESC[49m`） | 一致 |
| squeeze で **1000 行→129 行** | 実測は **1000→745**（busy）/ **1000→50**（idle） | **不一致** |
| `capture-pane` の返却は常に 1000 行 | Claude(alt) は 1000 行。**codex(非 alt) は 2000 行**（history 1000 + 可視 1000） | **不一致** |

**不一致 1（圧縮率）**: 745 行になったのは、その捕捉が 513 行の実 transcript を含んでいたため。
空行が 962 行を占める idle セッションでは 50 行まで落ちる。129 行という数字は別セッションの
実測値であり、圧縮率はセッションの中身に依存する。**受入条件は圧縮率ではなく「`less +G` が
composer に着地すること」**なので、テストはそちらを固定した。

**不一致 2（返却行数）**: `capture-pane -S -1000` は「1000 行返す」コマンドではなく
「1000 行遡って可視画面の末尾まで返す」コマンド。scrollback を持つ非 alternate-screen ツール
（codex / gemini / vibe-local / antigravity）では history+可視で 2000 行になる。
したがって回帰ガードは「常に 1000 行」ではなく **「`capturePane` の argv が変わらないこと」**
として固定した（`-S -1000 -E -`）。これが検知系が依存している実体。

**不一致 3（squeeze フィルタは新規実装ではない）**: Issue は perl 数行の新規フィルタを想定して
いたが、**同じアルゴリズムが `src/lib/terminal/terminal-display-normalizer.ts`（#1172）に既に
存在する**。Web UI 用に「TUI キャンバスのレイアウト空行を畳む」目的で書かれたもので、
SGR のみ行の扱い（`extractAnsiSequences` で色状態を持ち越す）まで同一。新規に発明せず
**このルールを正**とし、conformance テストで固定した。

---

## D1: キーバインドのライフサイクル

| 論点 | 決定 | 根拠 |
|---|---|---|
| 導入タイミング | サーバ起動時（`server.listen` コールバック内、`initializeWorktrees()` の後） | セッション作成時だと未起動時に読めない。起動時なら 1 回で済み冪等 |
| import 方法 | **`await import()` による動的 import** | `server.ts` の top-level 静的 import は tsx 下で Next の AsyncLocalStorage bootstrap を壊す（既存の Skill/verification reconciler と同じ理由。server.ts のコメント参照） |
| 冪等性 | `list-keys` の内容に自スクリプトパスが含まれれば no-op | 再起動のたびに `bind-key` を撃っても状態は変わらない |
| 衝突検査 | `list-keys -T prefix <key>` が **exit 0 で自分以外のバインドを返したら導入しない** | exit 1 + `unknown key: g` が「未割当」の表現（実測） |
| キーの設定化 | `CM_READ_MODE_KEY`（既定 `g`）。`[CMS]-` 修飾つき英数字 1 文字か F1–F12 のみ許可 | typo を黙って global key table に流し込まない |
| 無効化 | `CM_READ_MODE=off`（`0` / `false` も可） | |
| **アンインストール** | `CM_READ_MODE=off` で再起動すると、**前回導入したバインドを削除する**（収束型）。自分以外のバインドは触らない | 下記参照 |
| shutdown 時 | **unbind しない** | CommandMate は `--issue N` で**複数サーバが 1 つの tmux サーバを共有**する。片方の停止で unbind すると他方のキーを奪う。popup 自体は CommandMate サーバ不要（tmux にしか依存しない）ので、停止に連動させる理由もない |

非対応 tmux / 衝突 / 無効キーのいずれでも `bind-key` も `unbind-key` も一切発行しない
（＝ユーザーの tmux は無傷）。これは `read-mode.test.ts` で argv を数えて固定している。

### capability プローブの実測上の罠

`tmux list-commands <未知のコマンド>` は **exit 0 で無出力**（3.5a 実測）。
exit code でプローブすると「あらゆる tmux が対応」と誤判定するため、**stdout が空でないこと**を
判定条件にした。`tmux -V` のバージョン文字列パース（`3.5a` / `next-3.6` / `master`）は採らない。

## D2: ページャスクリプトの配置場所

**`~/.commandmate/bin/cm-read-pane.sh`**（内容は TS 定数として埋め込み、起動時に materialize）。

- `package.json` の `files` は `bin/ dist/ .next/ public/ scripts/hooks/ .env.example` で、
  **`scripts/` を publish していない**。リポジトリ内パスは global install では存在しない
- `npx` 実行はキャッシュディレクトリで動き、npm がいつ GC しても不思議はない。
  長生きする `bind-key` がそこを指すのは不可
- したがって global / local / npx のどれでも同じ絶対パスになる `~/.commandmate/` 配下に置く
  （install 種別で分岐する `getConfigDir()` は使わない。bind-key はサーバグローバルなので
  配置も 1 箇所に固定したい）
- 内容一致時は書き込まない（mtime を無駄に動かさない）。mode は毎回 0755 に再適用

### squeeze を awk で再実装した理由と、その drift 対策

popup の中には CommandMate サーバも node も `dist/` も無い。tmux と sh と awk しかない。
そこで awk 版を書いたが、**実装が 2 つある事実は放置しない**:

`tests/unit/lib/tmux/transcript-squeeze.test.ts` が、実 capture 3 本に対して

1. `squeezeTranscript()`（TS・案B が使う）
2. `SQUEEZE_AWK_PROGRAM`（awk・案A の popup が使う）
3. `normalizeTerminalOutputForDisplay()`（#1172・Web UI が使う）

の出力が **バイト単位で一致**することを検証する。どれか 1 つを変えると落ちる
（awk 側だけ閾値を変える変異、TS 側だけ変える変異の両方で赤を確認済み）。

## D3: popup は静止画（追尾しない）

**仕様として明記する。** `less` の入力がパイプなので `F` による追尾はできない。
更新したければ **もう一度 `prefix+g`** を押す。スクリプト冒頭のコメントと user-guide に明記した。

追尾型は将来課題（案B の `--follow` 拡張）に置く。popup 側で無理に追尾すると、Issue が
「不採用とした案」で挙げた常時自動パンと同じ「視野の奪い合い」を popup の中に持ち込むことになる。

## D4: Claude 以外の CLI ツールでの squeeze 確認

CLI ツールは `ALTERNATE_SCREEN_CLI_TOOLS`（`src/lib/cli-tools/types.ts`）で 2 つに分かれ、
capture の構造もその 2 種類しかない。両方を実 capture で fixture 化した。

| クラス | ツール | fixture | 実測 |
|---|---|---|---|
| alternate screen（`alt=1 hist=0`） | claude / opencode / copilot | `capture-claude-busy.txt`（1000 行・SGR のみ空行 7）<br>`capture-claude-idle.txt`（1000 行中 962 空行） | 745 行 / 50 行に圧縮。composer に着地 |
| 非 alternate screen（`alt=0 hist>0`） | codex / gemini / vibe-local / antigravity | `capture-codex.txt`（実 capture の末尾 400 行） | 400 → 400 行。**ほぼ no-op で無害** |

`squeezeTranscript` は **非空行を 1 行も落とさない**（順序・重複込みで同一）ことを両クラスで
assert している。したがってフィルタが特定ツールの出力を壊す経路は無い。

**未計測を明記する**: opencode / copilot / gemini / vibe-local / antigravity の実セッションは
この環境に無かったため個別の capture は採っていない。構造クラスとしては上記 2 本でカバーされて
いるが、「全ツールで実測した」とは主張しない。

## D5: 案B のインターフェース

**新コマンドではなく `capture` のフラグにした。**

```
commandmate capture <worktree-id> --pane [--tail N] [--raw] [--json] [--agent X] [--instance Y]
```

| 論点 | 決定 | 根拠 |
|---|---|---|
| `capture --pane` か新コマンドか | `--pane` フラグ | `--agent` / `--instance` / `--token` の解決ロジックをそのまま共有できる。新コマンドだと同じものを二重に持つ |
| 既定（`--pane` なし）の挙動 | **不変**。`/current-output` の `content` を返す | 既存の呼び出し元・ドキュメント・orchestrator スクリプトを壊さない |
| バックエンド | POST `/api/worktrees/[id]/capture`（生 `capturePane`） | Issue 指定どおり。`/current-output` の `content` は「進行中応答の蓄積」でアイドル時に空文字になり、transcript ビューアにならない |
| cliTool の決定 | `--instance` → roster、次に `--agent`、最後に GET `/api/worktrees/<id>` の `cliToolId ?? 'claude'` | POST `/capture` は `cliToolId` 必須。`/current-output` のサーバ側 fallback（`worktree.cliToolId \|\| 'claude'`）と同じ式にして、素の `capture <id> --pane` が他コマンドと同じセッションを見るようにした |
| squeeze の実行場所 | **クライアント側** | サーバは生フレームを返し続ける。検知・Auto-Yes・応答保存が見る payload をこの機能のせいで変えない |
| `--tail N` の意味論 | **squeeze 後**の末尾 N 行 | 実測: idle capture の生フレーム末尾 20 行に読める行は 4 行しかない（空白は transcript と composer の**間**にある）。squeeze 後の末尾 20 行なら 13 行が読める |
| `--lines` の露出 | **しない**。常に 1000 行を要求 | 検知系と同じ要求にしておけば、人間が読んでいるという理由でサーバの挙動が変わる余地が無い |
| `--json` | `{cliToolId, instanceId, output, lines, rawLines, squeezed, tailed}`。ページャは通さない | orchestrator が圧縮前後の行数を見られるようにした |
| `--raw` | squeeze を飛ばして生フレームを出す | 逃げ道。`--json` と併用時は `squeezed:false` |
| ページャ | stdout が TTY のときだけ `CM_PAGER` → `PAGER` → `less -R` | パイプ・リダイレクト時は素で出す（`\| grep` が壊れない）。spawn 失敗時も素で出す |

---

## 回帰ガード（`tests/unit/lib/tmux/reading-mode-invariants.test.ts`）

1. `TUI_PANE_WIDTH/HEIGHT` が 200/1000 のまま
2. `reconcileSessionGeometry` が `window-size manual` + `resize-window -x 200 -y 1000` を発行し、
   既に一致していれば何も発行しない
3. `capturePane(name, 1000)` の argv が `capture-pane -t =name: -p -e -S -1000 -E -` のまま
4. 読むモードの 3 モジュールが `resize-window` / `set-window-option` / `send-keys` /
   `kill-*` / `set-option` などの**状態変更 verb を文字列としてすら含まない**（コメントも含む）
5. popup スクリプトが `capture-pane -pe`（読み取り専用）しか実行しない

これらは変異注入で赤になることを確認済み（キャンバス高の縮小 / `-y` の欠落 / `-S` の縮小 /
popup への `resize-window` 混入 / CLI 側 `lines` の変更）。

## 実機検証（`tmux -L` 私設サーバ）

既定サーバへ `bind-key` を撃たないため、私設サーバ 2 つで検証した。

| 検証 | 結果 |
|---|---|
| `bind-key g if-shell -F '#{m:mcbd-*,...}' "display-popup ... -E <script>"` の導入 | `list-keys -T prefix g` に出現 |
| ネストクライアント（server B の 200×50 pane から server A へ attach）で `prefix+g` | popup が開き、squeeze 済み transcript を表示 |
| `q` で復帰 | popup の枠線が消え通常表示へ |
| popup 表示中/表示後のジオメトリ | `200x1000 winsize=manual` のまま不変 |
| 非 CommandMate セッション（`other-session`）で `prefix+g` | popup 出ず（ガードが 0 を返す） |
| `unbind-key` 後 | `list-keys` が exit 1 に戻る |
| 既定サーバ | `prefix+g` は `unknown key` のまま・11 セッション無傷 |

**受入条件のうち「実セッションで attach → `prefix+g`」は、ネストクライアントによる等価な
再現までを自動で確認した。人間の端末から本番セッションに attach しての最終確認は UAT に残る。**
