# `/sessions` タイル表示のポーリング負荷 — 計測とカデンス調整

Issue [#2511](https://github.com/Kewton/CommandMate/issues/2511)（Epic #2508 Phase 3）

Phase 1（#2509）で `/sessions` にタイル表示が入り、**可視タイル 1 枚につき
`useTerminalPanePolling`（`GET /current-output`）と `useSplitMessages`（`GET /messages`）が
1 本ずつ立つ**構造になった。タイル 20 枚 = ポーラー 40 本である。本書はその負荷を実測し、
タイル専用カデンスを決めるまでの記録。

- 実装: `src/config/pane-polling-cadence.ts`
- 計測ハーネス: `scripts/measure-tile-polling/index.mjs`
- 生データ: 本書 §3（ハーネスの JSON 出力をそのまま転記）

---

## 0. 先に決めた「許容範囲」

Issue の要求どおり、**基準は調整後の数値を見る前に決めた**。ローカルツールなので厳密な SLO は
置かず、「`/sessions` を開いているだけでファンが回る状態を避ける」を測れる形にしたもの。

対象は **定常状態**（タイル 20 枚が可視・どれも生成中でない・WebSocket 接続あり）、
基準機は §1 のマシン。

| # | 基準 | 値 |
|---|---|---|
| C1 | 総リクエストレート | ≤ 3 req/s |
| C2 | 総転送量 | ≤ 3 MB/s |
| C3 | サーバプロセス CPU | ≤ 1 コアの 10% |
| C4 | tmux サーバ CPU | ≤ 1 コアの 6% |
| C5 | 失敗リクエスト | 0 件 |
| C6 | `/current-output` p95 レイテンシ | ≤ 150 ms |

副次基準（WebSocket 切断中の劣化モード）: サーバ CPU ≤ 1 コアの 12%。

C3/C4 の絶対値が緩く見えるのは基準機が 28 コアのデスクトップだから。**基準機の CPU% は
下限**であって、同じ仕事はコアの遅いノート PC ではもっと高い割合になる。転送量（C2）の方が
機種に依らない指標で、ここでは**ブラウザ側の JSON パース負荷**の代理でもある。

---

## 1. 計測条件

| 項目 | 値 |
|---|---|
| ホスト | Apple M3 Ultra / 28 コア / 256GB / macOS 26.6.2 |
| Node | v24.1.0 |
| tmux | 3.5a |
| サーバ | `next build`（**production ビルド**）+ `dist/server/server.js`、port 3511 |
| DB | 隔離 SQLite（`<repo>/data/measure-2511/cm.db`） |
| tmux | 隔離ソケット `-L cmate-measure-2511`（アプリ側は socket 引数なしで `tmux` を呼ぶので、サーバの `PATH` 先頭に `-L` を注入する `tmux` シムを置いて強制。`-L` / `-S` だけが `$TMUX` に優先する唯一の隔離手段） |
| 認証 | なし（`CM_AUTH_TOKEN_HASH` 未設定で middleware 素通り） |
| 測定窓 | 各 60 秒 |
| HTTP クライアント | `http.Agent({ keepAlive: true, maxSockets: 6 })`（ブラウザの同一オリジン同時接続数を模倣） |

### ペイン内容

各 tmux セッションは `mcbd-claude-measure-wt-NNN`。ペインには
`tests/unit/lib/tmux/fixtures/capture-claude-busy.txt`（**実際の busy な Claude セッションの
1000 行 capture**）を繰り返して 10,000 行ぶん流し込んである（200x50、`history-limit 20000`）。
実測 capture は 10,001 行 / 881,854 bytes。

### 実物と模擬の境界

- **実物**: HTTP サーバ（production ビルド）、ルートハンドラ、`buildCurrentOutput`、SQLite 読み、
  実 tmux への `capture-pane`、`tmux-capture-cache`、JSON シリアライズ。
- **模擬**: エージェント本体。ペインは `sleep` で、実際には何も生成していない。**本 Issue が
  対象にしているのはまさにその「全部アイドル」の定常状態**であり、かつ 60 秒間固定できる唯一の
  状態でもある。
- **カデンスはハーネスのパラメータ**。クライアント側の判定ロジックそのものは
  `tests/unit/hooks/useTerminalPanePolling-tile-cadence-2511.test.ts` が実フックで固定している
  （この計測はカデンスの「実行コスト」を測るもので、「どのカデンスが選ばれるか」は測っていない）。

### 測っていないもの

- **ブラウザ側のコスト**。1.9MB の JSON を毎秒何本パースして React に流すかは別問題で、本書は
  サーバ側だけを扱う。数値は出していない。
- **生成中セッションが多いときの `broadcastTerminalSnapshot` の負荷**。WebSocket の push 経路は
  このハーネスでは再現していない（購読者がいないので `hasRoomSubscribers` で no-op になる）。
  §3 の `confirm-tile-generating-20` は「push が止まったまま 20 枚全部が生成中」という
  **最悪ケースを HTTP だけで**測ったもので、push が生きていれば実際はもっと軽い。
- **実機のユーザー環境そのもの**。本番サーバ（:3000）・本番 DB・稼働中の 46 セッションには
  一切触れていない。

---

## 2. 構造についての 4 つの発見

### 発見 1: アイドルのタイルは 5 秒ではなく **2 秒**で回っていた

Issue 本文は「アイドルのタイルは常に `IDLE_POLLING_INTERVAL_MS = 5000`」と書いているが、実際は
違う。カデンス判定は

```ts
connected && pushHealthy && !interactionActive ? 15000 : (isRunning || interactionActive) ? 2000 : 5000
```

で、`PaneTerminalState.isRunning` は **「健全な tmux セッションが存在する」** であって
「エージェントが生成中」ではない（#2238 がこの取り違えを直したときのドキュメントがフィールド
コメントに残っている）。`/sessions` に並ぶタイルはどれもセッションが生きているので、
**全タイルが 2 秒側に落ちる**。5000 が使われるのは tmux セッションが無い worktree だけ。

→ 想定の 2.5 倍の負荷だった。

### 発見 2: `pushHealthy` はアイドルでは**原理的に**立たない

`markPushHealthy()` は `terminal_snapshot` を受けたときだけ呼ばれ、そのスナップショットは
`response-poller-core.ts:414` の `broadcastTerminalSnapshot` からしか出ない。response poller は
**ターンを記録している間しか回らない**。したがって「push が健全」= 「生成中」であり、
`connected && pushHealthy` を遅いカデンスの条件にすると、**何も起きていないときにだけ速く
ポーリングする**という逆立ちになる。

タイル側の対策が `idleTrustsConnection`（§4）。

### 発見 3: `/current-output` の 99.8% は「同じフレームを 2 回」

10,000 行のペインに対する 1 レスポンスの内訳（`probe` コマンドの出力）:

| フィールド | bytes |
|---|---|
| `content` | 970,604 |
| `fullOutput` | 970,604 |
| `realtimeSnippet` | 2,108 |
| `structuredEvents` | 951 |
| その他全部 | < 200 |
| **合計** | **1,945,192** |

`content === fullOutput` は **文字列として完全一致**（確認済み）。生 capture が 881,854 bytes
なのに片方で 970,604 bytes になるのは、ANSI の ESC が JSON では `\u001b`（6 文字）に展開される
ため。つまり **1 リクエストあたり約 1.9MB**。

なお `MAX_TERMINAL_OUTPUT_LENGTH = 1MB`（`src/config/terminal-output-config.ts`）は
`sanitizeTerminalOutput()` の**表示側**の上限であって、ワイヤ上のペイロードには効かない。

### 発見 4: レスポンスは**圧縮されていない**

`Accept-Encoding: gzip, deflate, br` を送っても `Content-Encoding` ヘッダが付かない
（カスタムサーバ構成のため Next の `compress` が効いていない）。§3 の転送量は素の JSON バイト数
そのもの。

---

## 3. 計測結果（生データ）

各行 = 60 秒窓 1 本。`cadence` は `current-output ms / messages ms`。
CPU は「1 コアの何 %」（= 消費 CPU 秒 / 実時間）。

### 3.1 現行カデンス（= 変更前の実挙動）

| ラベル | タイル | cadence | req/s | 転送 | サーバ CPU | tmux CPU | p95 (co) | 失敗 |
|---|---|---|---|---|---|---|---|---|
| baseline-ws-10tiles | 10 | 2000/15000 | 5.67 | 9.30 MB/s | 16.0% | 5.2% | 98 ms | 0 |
| baseline-ws-20tiles | 20 | 2000/15000 | 11.32 | 18.58 MB/s | 24.6% | 9.9% | 105 ms | 0 |
| baseline-ws-40tiles | 40 | 2000/15000 | 22.66 | 37.21 MB/s | 42.5% | 19.3% | 191 ms | 0 |
| baseline-nows-20tiles | 20 | 2000/5000 | 13.97 | 18.62 MB/s | 24.9% | 9.7% | 125 ms | **2** |

`baseline-nows-20tiles` の失敗 2 件は、6 本のソケットに 14 req/s と 18.6MB/s を詰めた結果の
接続エラー。**現行カデンスは 20 枚ですでに取りこぼしが出る水準**である。

### 3.2 調整後カデンス（§4 で採用した値）

| ラベル | タイル | cadence | req/s | 転送 | サーバ CPU | tmux CPU | p95 (co) | 失敗 |
|---|---|---|---|---|---|---|---|---|
| **confirm-tile-idle-ws-20** | **20** | **15000/30000** | **2.00** | **2.50 MB/s** | **6.7%** | **3.9%** | **108 ms** | **0** |
| confirm-tile-idle-nows-20 | 20 | 10000/15000 | 3.33 | 3.76 MB/s | 8.7% | 5.8% | 116 ms | 0 |
| confirm-tile-generating-20 | 20 | 4000/30000 | 5.66 | 9.30 MB/s | 15.2% | 7.7% | 105 ms | 0 |
| tuned-ws-10tiles | 10 | 15000/15000 | 1.33 | 1.26 MB/s | 4.1% | 2.2% | 109 ms | 0 |
| tuned-ws-20tiles | 20 | 15000/15000 | 2.67 | 2.53 MB/s | 6.3% | 4.4% | 108 ms | 0 |
| tuned-ws-40tiles | 40 | 15000/15000 | 5.33 | 5.05 MB/s | 11.7% | 8.3% | 112 ms | 0 |

**定常状態（20 枚・アイドル・WS 接続あり）の合否**

| 基準 | 閾値 | 実測 | 判定 |
|---|---|---|---|
| C1 req/s | ≤ 3 | 2.00 | ✅ |
| C2 転送 | ≤ 3 MB/s | 2.50 MB/s | ✅ |
| C3 サーバ CPU | ≤ 10% | 6.7% | ✅ |
| C4 tmux CPU | ≤ 6% | 3.9% | ✅ |
| C5 失敗 | 0 | 0 | ✅ |
| C6 p95 | ≤ 150 ms | 108 ms | ✅ |

副次基準（WS 切断中）: サーバ CPU 8.7% ≤ 12% ✅

**変更前後（20 枚・アイドル・WS 接続あり）**

| | 変更前 | 変更後 | 差 |
|---|---|---|---|
| req/s | 11.32 | 2.00 | **−82%** |
| 転送 | 18.58 MB/s | 2.50 MB/s | **−87%** |
| サーバ CPU | 24.6% | 6.7% | **−73%** |
| tmux CPU | 9.9% | 3.9% | **−61%** |

40 枚でも変更後（11.7% / 5.05 MB/s）は変更前の 10 枚（16.0% / 9.30 MB/s）より軽い。

### 3.2b 再現確認

ハーネスの tmux 隔離を「`TMUX_TMPDIR` + `TMUX` 削除」から「`-L` を注入する PATH シム」へ
書き換えた後（`tests/unit/config/tmux-live-test-safety.test.ts` の規約に合わせるため）、
同じ手順で 2 本だけ取り直した。

| ラベル | タイル | cadence | req/s | 転送 | サーバ CPU | tmux CPU | tmux 呼び出し |
|---|---|---|---|---|---|---|---|
| rerun-baseline-ws-20 | 20 | 2000/15000 | 11.33 | 18.61 MB/s | 23.3% | 9.9% | has-session 800 / capture-pane 800 |
| rerun-confirm-tile-idle-ws-20 | 20 | 15000/30000 | 2.00 | 2.50 MB/s | 6.7% | 3.9% | has-session 160 / capture-pane 160 |

req/s・転送量・tmux 呼び出し回数は完全一致。サーバ CPU だけ 24.6% → 23.3% と振れたので、
**CPU の数値は ±1.5 ポイント程度のばらつきを持つ**ものとして読むこと（req/s と転送量は決定的）。
ペイロード内訳（§2 発見 3）も書き換え後に取り直して同一（1,945,192 bytes / `content` = `fullOutput` = 970,604）。

### 3.3 対照: サーバ単体

| ラベル | タイル | tmux 呼び出し | サーバ CPU |
|---|---|---|---|
| control-idle-server | 0 | 0 | 0% |

リクエストを 1 本も送らない 60 秒で、サーバは tmux を 1 回も叩かず CPU も 0。
**§3.1/§3.2 の数字はすべてタイルのポーリング由来**であり、バックグラウンドのポーラーが
混入していないことの確認。

### 3.4 `/api/worktrees`（#2060 のメトリクス）

`/sessions` のページ自身が回しているリスト取得。worktree 40 件のとき（サーバログ `list:slow`）:

```
totalMs=1578.1  dbMs=2.9  statusMs=1575.0  listSessionsMs=10.3  probeMs=1564.7
worktreeCount=40  tmuxSessionCount=41  probeCount=320  captureCount=40  healthCheckCount=40
```

レスポンス 149,814 bytes。**ほぼ全部が probe（1.56 秒）**で、DB は 3ms。タイルのカデンスとは
独立した固定費で、`useWorktreesCache` の 20s / 60s（WS 接続時）間隔で発生する。タイル枚数を
増やしてもこの費用は増えない（worktree 件数で決まる）が、40 worktree の環境では
**20 秒ごとに 1.5 秒ぶんの CPU バースト**があることは記録しておく。本 Issue の範囲外。

---

## 4. 採用したカデンス

`src/config/pane-polling-cadence.ts`。詳細画面とタイルを**別プロファイル**として持つ。

| | 詳細画面（既定） | タイル |
|---|---|---|
| `activeMs` | 2000 | 4000 |
| `idleMs` | 5000 | 10000 |
| `wsFallbackMs` | 15000 | 15000 |
| `activeRequiresGenerating` | false | **true** |
| `idleTrustsConnection` | false | **true** |
| messages `pollMs` | 5000 | 15000 |
| messages `wsFallbackMs` | 15000 | 30000 |

**詳細画面の値と挙動は 1 ビットも変えていない。** `selectPanePollIntervalMs` は既定
プロファイルの下で変更前の `? :` 式と同一で、`tests/unit/config/pane-polling-cadence-2511.test.ts`
が 5 入力・32 通りを全列挙して旧式と突き合わせている。実フックに対しては
`tests/unit/hooks/useTerminalPanePolling-tile-cadence-2511.test.ts` が
2s / 5s / 15s を固定する。

### `activeRequiresGenerating`（発見 1 への対策）

タイルは `terminal.isRunning`（= セッションが生きている）ではなく
`sessionStatus ∈ {running, waiting}`（= 生成中 / 人の回答待ち）で速いカデンスを選ぶ。
`waiting` を含めるのは、質問を出した画面は答えが入った瞬間に変わるから（答えは CLI 側や
Auto-Yes から来ることもあり、このタイルからは見えない）。

### `idleTrustsConnection`（発見 2 への対策）

WebSocket が繋がっていて、かつ生成中でないタイルは、push heartbeat を待たずに 15 秒側へ落ちる。

**安全な理由**: CommandMate 経由で始まったターンは response poller を起こし、その poller が
タイルの購読している worktree room にスナップショットを流す。タイルは自分の間隔に関係なく
**push で**気付く。

**コスト**: CommandMate を経由せず tmux に直接打ち込まれたターンは push が出ないので、
最悪 15 秒遅れる。一覧画面で 1 タップ先に本物がある以上これは妥当なトレードだが、詳細画面には
同じ理屈が立たないので、詳細プロファイルは heartbeat ゲートを残している。

なお **生成中のタイルで push が途絶えた場合は 4 秒側に戻る**（`selectPanePollIntervalMs` の
`!busy` ガード）。heartbeat が存在する理由である復旧性は緩めていない。

---

## 5. `tmux-capture-cache` の上限（100 エントリ）に当たるか

### 結論

**タイル枚数では当たらない。当たるのは「5 秒の TTL 窓の中でポーリングされる
(worktree × instance) の異なるセッション数」が 100 を超えたときで、そのとき
キャッシュは劣化ではなく崖のように無効化される。**

### 測り方

サーバの `PATH` の先頭に、argv をログしてから本物を `exec` する `tmux` シムを置き、
`capture-pane` の呼び出しを実数で数えた（`scripts/measure-tile-polling/index.mjs` の
`writeTmuxShim`）。キャッシュにカウンタが無いので、呼び出し数を数えるのが唯一の直接測定になる。

### 1 リクエストあたりの tmux 呼び出し

`/current-output` 680 本に対する `capture-pane` の内訳:

| 引数 | 呼び出し数 | 用途 | キャッシュ |
|---|---|---|---|
| `-S -50` | 680 | `isSessionHealthy` の liveness probe（`capturePane`） | **されない** |
| `-S -10000` | 280 | 表示用 capture（`captureSessionOutput` → `getOrFetchCapture`） | される |

**liveness probe はキャッシュを通らない**（`capturePane` は素の tmux ラッパーで、
`getOrFetchCapture` を使うのは `captureSessionOutput` だけ）。したがって
**1 リクエストあたり最低 1 回の `capture-pane` は必ず発生する**。キャッシュがカデンスの
肩代わりをすることはできない、というのがここの含意。

表示用 capture のヒット率:

| カデンス | リクエスト | fetch | ヒット率 |
|---|---|---|---|
| 2000ms（TTL 5000ms より短い） | 600 | 200 | 66.7% |
| 15000ms（TTL より長い） | 80 | 80 | **0%** |

遅いカデンスではキャッシュが効かなくなるが、**総 capture 数は 800 → 160 に減る**ので
差し引きは大きく得（§3.2）。

### 上限到達の実験

同一カデンス（2000ms）・同一ペイン内容で、異なるセッション数だけを変えた 2 本:

| ラベル | 異なるセッション数 | `/current-output` | `-S -10000` fetch | ヒット率 |
|---|---|---|---|---|
| cache-40keys | 40 | 1,200 | 400 | **66.7%** |
| cache-110keys | 110 | 3,298 | 3,298 | **0%** |

`CACHE_MAX_ENTRIES = 100` をまたぐと、ヒット率は下がるのではなく**ゼロになる**。
2 秒ごとに 110 個のキーが書かれると、`setCachedCapture` は毎回「最も古いエントリ」を
追い出すが、その最も古いエントリこそ次に読まれるものなので、TTL 内に読まれる前に必ず消える。

### `/sessions` にとっての意味

- キャッシュキーは tmux セッション名なので、**タイルは新しいキーを増やさない**。
  サイドバーの status probe が既に同じキーを使っている。
- 効いてくるのは **worktree 数 × instance 数**。計測に使った実機の既定 tmux サーバには
  この作業時点で 46 セッションが存在した。1 worktree あたり 3 instance を常用する構成が
  40 worktree に広がれば 120 キーとなり、上限を超える。
- 本 Issue のカデンス変更はこの上限に触れない（キー数を変えないので）。
  **上限を上げるべきかどうかは別 Issue の判断**とし、ここでは「崖であること」と
  「いつ崖に当たるか」を記録するにとどめる。

---

## 6. ペイロード削減（`?lines=` 案）— 見送り、根拠つき

発見 3 のとおり `/current-output` の 99.8% は同じフレーム 2 本。タイルは全スクロールバックを
必要としないので、行数上限クエリの効果は大きい（10,000 行 → 例えば 200 行なら転送は約 1/50）。

**それでも本 Issue では実装しない。** 理由は 3 つ。

1. `/current-output` のペイロードは **CLI の公開契約**でもある（`commandmate capture --json` が
   同じ `buildCurrentOutput` の出力を印字する）。行数を絞れる口を足すと、その口を通ったときの
   `capture --json` の意味が変わる。
2. `buildCurrentOutput` は capture 行数から `session_states.last_captured_line` のカーソル
   有効性（`capturedLineCountIsCursor` / `isCaptureWindowSaturated`）を判定し、**DB に書き戻す**。
   行数を変えるとこのカーソルの意味が変わり、応答記録（response recording）に波及しうる。
   カデンス調整と違って「クライアント側だけの変更」では済まない。
3. カデンス調整だけで定常状態は §0 の基準を全部満たした（§3.2）。上乗せの必要が現時点で無い。

**後続 Issue に渡す材料**（測定済みの事実として）:

- `content` と `fullOutput` は同一文字列で、**重複だけで約 970KB**。片方を落とすだけで
  カデンスを一切変えずに転送量が半減する。こちらの方が `?lines=` より副作用が小さい可能性が高い。
- レスポンスは gzip されていない（発見 4）。ANSI を多く含む JSON は圧縮率が高いので、
  カスタムサーバ側で圧縮を有効にするだけでも効く見込み。**圧縮率は測っていない。**
- liveness probe の `capture-pane -S -50` がキャッシュを通っていない（§5）。

---

## 7. 再現手順

```bash
npm run build && npm run build:server

node scripts/measure-tile-polling/index.mjs setup --tiles 40 --lines 10000
node scripts/measure-tile-polling/index.mjs serve &     # port 3511
node scripts/measure-tile-polling/index.mjs seed --tiles 40 --messages 60
node scripts/measure-tile-polling/index.mjs probe       # ペイロード内訳
node scripts/measure-tile-polling/index.mjs load --tiles 20 \
     --current-output-ms 15000 --messages-ms 30000 --duration 60 --label tile
node scripts/measure-tile-polling/index.mjs teardown    # 失敗した実行の後でも必ず流す
```

`teardown` は隔離 tmux セッション・隔離ソケット・隔離 DB をすべて消す。
本番サーバ（:3000）・本番 DB・既定 tmux ソケットには一切触れない。
