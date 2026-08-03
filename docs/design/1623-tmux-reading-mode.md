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

古い tmux 実機での裏取りは **[#1641（下記）](#1641-非対応-tmux-での-no-op-実機検証)** で済ませた。

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

### awk 版の移植性: `LC_ALL=C` の固定（CI 赤で判明・2026-08-03 追記）

初回実装は macOS で緑・`ubuntu-latest` で赤になった。原因は squeeze 本体ではなく
**`sprintf("%c")` の解釈が awk 実装 × ロケールで割れる**こと。

NBSP の畳み込みは `NBSP = sprintf("%c%c", 194, 160)` でバイト列 `C2 A0` を組み立てているが、

| awk | `sprintf("%c", 194)` |
|---|---|
| mawk / BWK awk | バイト `0xC2` |
| gawk・`LC_ALL=C` | バイト `0xC2` |
| gawk・`*.UTF-8` ロケール | **文字 U+00C2 → `C3 82`** |

gawk を UTF-8 ロケールで動かすと NBSP マッチャが 4 バイト文字列になり、**実際の NBSP に
永久に一致しない**。結果として NBSP のみの行が空行と判定されず、フレームが無圧縮のまま返る。
CI の `/usr/bin/awk` は gawk（Debian の alternatives は gawk を mawk より上位に置く）で
UTF-8 ロケールのため、この条件を踏んでいた。

**採らなかった修正**: 文字形も拾う alternation
（`sprintf("%c%c",194,160) "|" sprintf("%c",160)`）は gawk では直るが、**BWK awk が
UTF-8 ロケールで `multibyte conversion failure` で異常終了する**（実測）。

**採った修正**: awk の呼び出しだけ `LC_ALL=C` に固定する。3 実装すべてが一致し
（実 fixture 1000 行の出力 sha256 が BWK / mawk / gawk で同一）、バイト透過なので
UTF-8 の罫線もそのまま通る。`less` と tmux はユーザーのロケールのまま。

**検知の作り直し**: conformance テストは「その環境の `awk` 1 本」しか見ていなかったため、
macOS 緑・Linux 赤を通してしまった。現在は

1. 手元にある awk 実装を**全部**探して（`awk` / `mawk` / `gawk` / `original-awk` /
   `nawk` / `busybox awk` / `goawk`）それぞれで conformance を回す
2. 1 本も見つからなければ**失敗**する（無言の空振り禁止）
3. `sprintf("%c", N)` に N > 127 が存在する限りロケール固定を要求する**静的ガード**を持つ
   — mawk しか無い環境（差分自体が再現しない）でも効く

変異注入で赤を確認済み: スクリプトから `LC_ALL=C` を外す / `SQUEEZE_AWK_LOCALE` を
`en_US.UTF-8`（＝ CI の条件）に変える。

**教訓（fixture と同じ轍）**: 赤になったテストケースは生の U+00A0 で書かれており、diff でも
端末でも vitest の失敗出力でも**半角スペースに見えていた**。そのため当初は trim の空白クラス
（`\v` / `\f` の移植性）が疑われた。ESC と NBSP は必ず `String.fromCharCode()` か
エスケープで組み、ソースに生バイトを置かない。

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

---

## #1641: 非対応 tmux での no-op 実機検証

#1623 は受入条件「`display-popup` 非対応 tmux で no-op となり案B が代替として動作すること」を
**未検証のままクローズした**。手元が 3.5a しか無く、単体テストはプローブの戻り値を
**モックして両分岐を通していただけ**だったためである。モックはプローブの戻り値を固定できるが、
**プローブが tmux に正しい質問をしているか**は何も言わない。#1641 でそこを実行で埋めた。

### 手法

`scripts/verify-legacy-tmux-readmode.sh`（ホスト側ドライバ）+
`scripts/legacy-tmux-probe/`（コンテナ側）。

- 出荷している `src/lib/tmux/{read-mode,tmux,transcript-squeeze}.ts` を esbuild で束ねて
  **そのまま実行**する。書き写した再実装は使わない
- **ホスト側スクリプトは tmux を 1 行も呼ばない**（`grep tmux` するとコメントと
  イメージ名とパスしか出ない）。2026-08-02 の「隔離したつもりの `kill-server` で
  稼働中の全 `mcbd-*` を消した」事故に対する構造的な防止策
- コンテナ側は既定ソケットに囮セッション、`-L cm1641` の私設サーバに被験セッションを置き、
  ソケット引数を取らない本番コードを `$TMUX` で私設サーバへ向ける。
  probe は**転送が効いていなければ実行を拒否**する
- コンテナ側は `CM1641_IN_CONTAINER=1` 未設定、または既定サーバに `mcbd-*` が居る場合は
  起動を拒否する（使い捨て環境であることを実行時に強制する）

### 実測（2026-08-03 / docker / node:18-{buster,bullseye,bookworm}）

| tmux | `list-commands display-popup` | `list-commands capture-pane` | `list-keys -T prefix g` | `supportsDisplayPopup()` |
|---|---|---|---|---|
| 2.8 | exit 1 `usage: list-commands [-F format]` | exit 1 **同じ usage エラー** | exit 1 `usage: list-keys [-T key-table]` | **false** |
| 3.1c | exit 0 / **stdout 空** | exit 0 / ヘルプ行 | exit 1 `unknown key: g` | **false** |
| 3.3a | exit 0 / ヘルプ行 | exit 0 / ヘルプ行 | exit 1 `unknown key: g` | **true** |

| 検証項目 | 2.8 | 3.1c | 3.3a（対照） |
|---|---|---|---|
| `reconcileReadModeBinding()` の outcome | `unsupported-tmux` | `unsupported-tmux` | `installed` |
| `list-keys -T prefix g`（私設サーバ・実行後） | 未バインド | 未バインド | 自バインドあり |
| 同一サーバの別セッション（`other-session-1641`） | 無傷 | 無傷 | 無傷 |
| 既定ソケットのセッション・キーテーブル | 無傷・バインド無し | 無傷・バインド無し | 無傷・バインド無し |
| バインドが撃つ `display-popup` を直接実行 | `unknown command: display-popup` | `unknown command: display-popup` | **`no current client`** |
| 案B（`capturePane` + `squeezeTranscript`） | 1003 → 52 行・マーカー検出 | 1003 → 52 行・マーカー検出 | 1003 → 52 行・マーカー検出 |

**結論**: 偽陽性（非対応 tmux にバインドを入れる）も偽陰性（3.2+ で無効になる）も起きていない。
案B は 2.8 / 3.1c / 3.3a で同一の結果を返し、**tmux バージョン非依存であることが実測で確認された**。

### 実測から出た新しい知見（#1623 時点で未把握だったもの）

1. **プローブが正解する理由はバージョンで違う。** 3.1c は「引数は受けるが未知の名前には
   無出力」、2.8 / 3.0a は「`list-commands` がそもそも**コマンド引数を取らない**」。
   後者は `capture-pane`（そのバージョンに実在する）でも同じ usage エラーを返すので、
   `supportsDisplayPopup` の形を**他のコマンドの capability 判定に流用してはいけない**
   （3.1 未満の全 tmux で偽陰性になる）。
2. **衝突検査も古い tmux では劣化する。** `list-keys` に**キー引数を渡せるのも 3.1 から**で、
   3.0 以下では usage エラー → `readExistingBinding` が常に undefined（＝キーは空き）を返す。
   これが無害なのは、**capability プローブが先に short-circuit していて 3.0 以下がそこへ到達しない**
   から。順序が load-bearing であることが実測で判明したので、
   `read-mode.test.ts` の「非対応 tmux では `list-keys` を一度も撃たない」で固定した。
3. `display-popup` を直接実行したときのエラーの**違い**（`unknown command` か
   `no current client` か）は、クライアント無しでもコマンドの実在を判定できる第 2 の証拠になる。

### 空振り防止

- `CM1641_INVERT_EXPECT=1` で全行の期待値を反転させて実行し、**3 行とも「正しく落ちる」**ことを
  確認済み（アサーションが実測を読んでいて、常緑ではないことの証明）
- 上記 1・2 の単体テストは、`supportsDisplayPopup` を exit-code 型に戻す変異と、
  衝突検査を capability プローブより前に移す変異の両方で赤になることを確認済み
- CI ジョブ `legacy-tmux-readmode`（`container: node:18-bullseye` = tmux 3.1c）は、
  **tmux が 3.2 以上だったらジョブ自身を失敗させる**。ベースイメージが将来上がったときに
  「何も検証していない緑」になるのを防ぐ

### 残る未検証

- **tmux 3.2 / 3.3 未満の macOS 実機**は見ていない（すべて Linux コンテナ）。
  `display-popup` の有無は tmux 本体の機能なのでプラットフォーム差は想定しないが、実測はしていない
- popup の**目視**確認は 3.3a では行っていない（クライアント非 attach のため）。
  目視は #1623 の 3.5a ネストクライアント検証が担保する
