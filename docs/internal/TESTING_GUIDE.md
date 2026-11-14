[English](../en/internal/TESTING_GUIDE.md)

# CommandMate 動作確認ガイド

このガイドでは、CommandMate の動作確認方法を説明します。

## 📋 目次

1. [環境準備](#環境準備)
2. [開発サーバーの起動](#開発サーバーの起動)
3. [基本動作確認](#基本動作確認)
4. [API エンドポイントのテスト](#api-エンドポイントのテスト)
5. [WebSocket のテスト](#websocket-のテスト)
6. [UI の動作確認](#ui-の動作確認)
7. [テストの落とし穴](#テストの落とし穴)
8. [トラブルシューティング](#トラブルシューティング)

## 環境準備

### 1. 環境変数の設定

開発環境用の `.env` ファイルを作成します：

```bash
# .env ファイルを作成
cat > .env << 'EOF'
# Development環境設定
CM_ROOT_DIR=/Users/yourname/projects
CM_PORT=3000
CM_BIND=127.0.0.1
CM_DB_PATH=./data/cm.db
NODE_ENV=development
EOF
```

**重要**: `CM_ROOT_DIR` を実際の git worktree があるディレクトリに変更してください。

> **Note**: 旧名称の環境変数（`MCBD_*`）も後方互換性のためサポートされていますが、新名称（`CM_*`）の使用を推奨します。

### 2. データベースの初期化

```bash
# データディレクトリを作成
mkdir -p data

# データベースを初期化
npm run db:init
```

### 3. 依存関係の確認

```bash
# 依存関係がインストールされているか確認
npm list --depth=0
```

## 開発サーバーの起動

### 方法1: 通常起動（フォアグラウンド）

```bash
# 開発サーバーを起動
npm run dev
```

起動後、以下のメッセージが表示されます：
```
WebSocket server initialized
> Ready on http://localhost:3000
> WebSocket server ready
```

### 方法2: バックグラウンド起動

```bash
# バックグラウンドで起動
npm run dev > dev.log 2>&1 &

# ログを確認
tail -f dev.log
```

### サーバーの確認

```bash
# ポートで待ち受けているプロセスを確認
lsof -nP -iTCP:3000 -sTCP:LISTEN

# プロセスを確認
ps aux | grep "tsx server.ts"
```

## 基本動作確認

### 1. HTTP エンドポイントの確認

```bash
# ホームページにアクセス
curl http://localhost:3000/

# ステータスコードのみ確認
curl -I http://localhost:3000/
```

成功すると HTTP 200 が返ります。

### 2. ヘルスチェック

```bash
# 基本的なヘルスチェック
curl -s http://localhost:3000/ | grep -q "<!DOCTYPE html" && echo "✓ Server is healthy" || echo "✗ Server error"
```

## API エンドポイントのテスト

### 1. Worktree 一覧の取得

```bash
# Worktree 一覧を取得
curl -s http://localhost:3000/api/worktrees | jq .
```

**期待される出力**:
```json
[
  {
    "id": "worktree-id",
    "path": "/path/to/worktree",
    "branch": "main",
    "sessionId": null,
    "lastActivity": "2025-01-17T12:00:00.000Z"
  }
]
```

### 2. メッセージの取得

```bash
# 特定の worktree のメッセージを取得
WORKTREE_ID="your-worktree-id"
curl -s "http://localhost:3000/api/worktrees/${WORKTREE_ID}/messages" | jq .
```

### 3. メッセージの送信

```bash
# メッセージを送信
WORKTREE_ID="your-worktree-id"
curl -X POST http://localhost:3000/api/worktrees/${WORKTREE_ID}/send \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, Claude!",
    "summary": "Test message"
  }' | jq .
```

### 4. ログファイルの一覧取得

```bash
# ログファイル一覧を取得
WORKTREE_ID="your-worktree-id"
curl -s "http://localhost:3000/api/worktrees/${WORKTREE_ID}/logs" | jq .
```

## WebSocket のテスト

### Node.js スクリプトを使用

`test-websocket.js` というファイルを作成：

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('✓ WebSocket connected');

  // Worktree に subscribe
  ws.send(JSON.stringify({
    type: 'subscribe',
    worktreeIds: ['your-worktree-id']
  }));

  console.log('✓ Subscribed to worktree');
});

ws.on('message', (data) => {
  console.log('✓ Received message:', JSON.parse(data.toString()));
});

ws.on('error', (error) => {
  console.error('✗ WebSocket error:', error);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});

// 10秒後に接続を閉じる
setTimeout(() => {
  ws.close();
  process.exit(0);
}, 10000);
```

実行：

```bash
node test-websocket.js
```

### wscat を使用（オプション）

```bash
# wscat をインストール
npm install -g wscat

# WebSocket に接続
wscat -c ws://localhost:3000

# 接続後、以下を送信
{"type":"subscribe","worktreeIds":["your-worktree-id"]}
```

## UI の動作確認

### 1. ブラウザでアクセス

ブラウザで以下の URL にアクセス：

```
http://localhost:3000
```

### 2. Worktree 一覧ページの確認

以下を確認します：

- [ ] ページヘッダーが表示される
- [ ] "CommandMate" というタイトルが表示される
- [ ] Worktree の一覧が表示される（データがある場合）
- [ ] 検索ボックスが表示される
- [ ] ソートボタン（Name、Updated、Path）が表示される
- [ ] リフレッシュボタンが表示される

### 3. Worktree 詳細ページの確認

Worktree カードをクリックして詳細ページに移動：

```
http://localhost:3000/worktrees/[worktree-id]
```

以下を確認します：

- [ ] 戻るボタンが表示される
- [ ] タブ（Messages、Log Files）が表示される
- [ ] メッセージ入力フォームが表示される
- [ ] サイドバーに情報が表示される
- [ ] Quick Actions が表示される

### 4. メッセージ送信のテスト

1. メッセージ入力欄に「Hello, Claude!」と入力
2. [Send Message] ボタンをクリック
3. メッセージが送信され、チャット画面に表示されることを確認

### 5. ログビューアのテスト

1. [Log Files] タブをクリック
2. ログファイル一覧が表示されることを確認
3. ログファイルをクリックして内容が表示されることを確認

## 自動テストの実行

### ユニットテスト

```bash
# ユニットテストを実行
npm run test:unit

# カバレッジ付きで実行
npm run test:coverage
```

**期待される結果**:
- 75件のテストがパス
- カバレッジ: 80%以上

### 統合テスト

```bash
# 統合テストを実行
npm run test:integration
```

**期待される結果**:
- 40件以上のテストがパス
- API エンドポイントが正しく動作

### E2E テスト

```bash
# E2E テストを実行
npm run test:e2e

# 特定のブラウザで実行
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=webkit
```

**期待される結果**:
- 24件のテストがパス
- UI が正しく表示される

## テストの落とし穴

緑でも何も確かめていない・赤でも自分の変更のせいではない、の両方が起きる。テストを書く・回す・裁定するときに踏みやすい形をまとめる。
ワーカーの赤の裁定（差し戻すか）は [exit-codes.md 3-4](../orchestrate/exit-codes.md)、重い検証の資源の扱いは [ci-merge.md 6-1-1](../orchestrate/ci-merge.md) を見る。

### 合否は exit code で見る

- `npm run test:unit | grep ...` は exit code を grep のものにすり替える。合否は `npm run test:unit > <scratchpad>/unit.log 2>&1; echo "EXIT: $?"` の形で実測し、grep は要約の表示だけに使う（要約のパターンには `^ *Errors ` も入れる）
- vitest は `Tests N passed` で失敗 0 件でも、`Errors 1 error`（未処理の例外・rejection）があれば exit 1 にする。CI のログは `gh run view <run-id> --log-failed | tail -30` で集計行を直接見る（`×` はテスト名の掛け算記号にも当たるので grep で拾わない）
- この形の典型は、jsdom を破棄した後に非同期の続き（fetch の catch 節・debounce のタイマー）が `setState` を叩く `window is not defined`。失敗の経路と自分の差分が import を共有しなければ帰属は無い。テスト側で待ち切る・後始末でタイマーを止める
- 既存の呼び出しに `.catch()` / `.then()` を足す変更は、その関数がテストで素の `vi.fn()`（undefined を返す）にモックされていないかを見る。モックの戻り値が実装の契約（async なら Promise）と食い違うと、CI の順次実行でだけ TypeError になる
- 診断用のログを `/tmp/<よくある名前>.log` に書かない。並行する別の worktree が同じ名前に書くと、他人の赤を自分の赤と読む。ログはセッションの scratchpad に置き、集計のファイル数が自分の知っている総数と違えば他人のログを疑う

### CI だけで落ちるテスト

- `vitest.config.ts` は `CI=true` のときだけ `fileParallelism: false`・`maxConcurrency: 1`・`testTimeout` 20 秒になる。これはファイルを並べず 1 本ずつ順に回す**直列化**で、ファイル間で module や `globalThis` を共有する設定ではない（`isolate` は既定の `true` のままで、ファイルごとに module のグラフを作り直す）。CI でだけ変わるのは次の 3 つを分けて見る
  - 順序とタイミング: 直列なので待ちが長くなり、時間で待つテストが `testTimeout` や `waitFor` の既定の時間に当たる
  - 同じファイルの中の状態: module scope の変数・registry・モックは、そのファイルの後続のテストに残る（ファイルを越えては残らない）
  - 外部の共有資源: ディスクのファイル・DB・ポート・tmux・`process.env` を書き換えた子プロセスなどは、`isolate` の外なので後から走るファイルに残る
  ローカルの再現は `CI=true npx vitest run <file>`
- RTL の `waitFor` を「要素がある」のようなデータに依らない条件で抜け、直後の assertion が `fetch → setState → 再描画` と競走する形は、React の Scheduler と `waitFor` のドレインの順序が未規定なので、同じコードでも PR によって赤になる。再現はモックの fetch を 10ms 遅らせるプローブ（`mockImplementation(() => new Promise((r) => setTimeout(() => r(res), 10)))`）。直し方は assertion を `waitFor` の内側に入れる（データで待つ）。再実行で通すのは直したことにならない
- 「未登録のツール」の例に、実装予定のあるツール名を使わない（後でそのツールが着地した瞬間に壊れる）。stub を `register` するテストは `finally` で `unregister` せず本物を復元する。本物を消してもそのテストの assert は通り、同じファイルの後続のテストが壊れた registry で走る（ファイルを越えては残らないが、どのテストが壊したかが見えにくい）
- OS 依存のパスを fixture にしない。`/proc` 配下を「書けない dir」に使うと、Linux では `mkdirSync(..., { recursive: true })` が同期の無限ループになり、`testTimeout` すら発火しないまま CI が沈黙する（macOS は即 throw して緑）。書けない dir は「親が通常ファイルのパス」（`join(<一時ファイル>, 'sub')`、全 OS で ENOTDIR）にする
- Linux は環境変数・引数 1 本あたり 128KB の上限があり（`spawn E2BIG`）、macOS には無い。大きなデータは子プロセスの stdin か一時ファイルで渡す
- タイムアウトが一度も発火しない長い沈黙は、非同期のハングではなく同期のブロック（ネイティブのループ・`execSync`）。最小の再現は `docker run node:<版> timeout 30 node -e ...` で作る

### 並列 worktree と負荷

同じマシンでフルスイートを何本も同時に回すと、差分と無関係な赤が出る。差し戻す前に次の 3 点を確かめる。

1. 落ちたテストファイルがブランチの差分に入っているか（`git diff --name-only origin/develop...HEAD`）
2. 単独で回して緑か（`npx vitest run <file>; echo $?`）
3. 同時に何本のフルスイートが走っているか（`ps -ax -o command= | grep 'vitest run'`）

- 負荷の赤は `Test timed out in 5000ms`（`spawnSync` でシェルを叩くだけのテストなど）として出ることが多いが、実プロセスの生存や共有の state を見るテストでは assertion の失敗として出る。「assertion 失敗だから本物」とは限らない
- `cpu.heavy` の mutex はゲート同士しか直列化しない。ワーカー自身が起動した `npm run test:unit` は数えられないので、mutex があっても同時に何本も走る
- 止まって見える run は、`ps -o pid,etime,time,%cpu -p <pid>` を時間をあけて 2 回撮り、CPU time が動かなければハングとみなす。止めた後は、他の vitest が 0 本になってから直列で回し直す
- 固定名の共有リソース（tmux の socket 名・ポート・`/tmp` のパス・ロック名）を掴むテストは、別の checkout の同じテストと衝突する。リソースはマシン全体のスコープにあり worktree ごとに分かれていない。新しく書くテストは名前に pid や一時ディレクトリを含める
- フルスイートの走行中にソースを編集しない。vitest は transform が遅延するので「新しいテスト × 古いソース」の組で走り、もっともらしい赤が 1〜2 件出る。`git merge` による取り込みも編集であり、`CHANGELOG.md`・`docs/module-reference.md` などテストが読む文書も含む（`grep -rln 'CHANGELOG\.md\|module-reference\.md' tests/unit/`）。1〜2 件だけ赤なら、サマリの `Start at` と自分の編集時刻を突き合わせる
- 最終の判定は編集を挟まない 1 回の通しで取る（lint → typecheck → test:unit を 1 本のコマンドにつなぐと途中で触れない）
- 競合（race）を仕込むテストが高負荷で「競合が起きなかった」と落ちたら、攪乱側（writer）のスレッドを増やす。負荷が奪うのは CPU の総量ではなく 1 本のスレッドの連続性で、回数や木の大きさを増やしても弱い。競合を観測できなかったことは失敗にせず報告して skip し、競合に依らない決定的な経路（例: `chmod 0o000` の子で走査を確実に妨げる）を別に用意する。その経路が root では効かず CI で skip されていないかも確かめる（`<file> (N tests)` に `| N skipped` が付いていないか）

### 変異注入でテストが空振りでないことを示す

緑は「ガードが効いた」とも「ガードが空振りした」とも整合する。直すべき欠陥が空振りの緑そのものであるとき、緑だけでは完了と言えない。

- 対照（変異なし）と最低 2 つの変異（違反を起こす変異・以前の欠陥条件を再現する変異）を回し、結果を表に並べる。一部が緑で残るのは、そのケースが本来その条件で完結すると個別に説明できるときだけ正常
- 変異は作業ツリーではなく使い捨てのコピー（`git worktree add --detach <tmp> <branch>`）で行う。作業ツリーで行うなら変異の前に `cp` で退避する（戻しの確かめ方は [contract.md 2-4](../orchestrate/contract.md)）。`git checkout -- <file>` で戻すと、追跡ファイルでは未コミットの実装ごと HEAD に戻り、未追跡ファイルでは失敗して変異が残る
- 置換は sed ではなく、完全一致の置換と出現回数の確認で行う（下の「一括置換の確かめ」）
- 変異が緑のまま残ったら、まず同じ経路に同じ結果を出す別のガードが無いかを探す。あれば片方を実行時に無効化してから（`reset*()` を持つモジュールならそれを呼んで）撃つ
- 変異注入が示すのは「書いたアサーションが空振りでない」ことだけで、「コメント・JSDoc に書いた主張をアサーションが覆っている」ことではない。とくに「X は起きない・安全」型の主張と、許可リストに列挙した値（各値が実測済みか）を 1 つずつ「これを壊す入力は何か」に書き下してテストにする。構造のテストは素の文字列一致ではなく import 文にアンカーする
- 構造（枠の縦線・罫線・位置）を壊す変異は、後から同じ構造を境界として読むコードが入ると、別の理由で結果を変えて空虚になる。構造を読むコードを足したら、既存の変異注入が同じ構造を壊していないかを grep し、構造を保つ変異（ラベルの 1 文字など）に差し替える。赤くなった既存のテストを expect の反転で片づけず、赤の理由を実測する
- 判定のルール（検出・準備判定・正規表現）を書き換える変更は、`tests/fixtures/` の該当する実キャプチャ全件に旧ロジックと新ロジックを並べて通し、判定が変わったもの（T→F・F→T）を数える。旧ロジックは scratchpad のスクリプトに写し、cwd を worktree にして `npx tsx <script>.mts` で走らせる。意図した分以外が出たら、1 枚ずつ妥当性と、それを assert するテストの有無を PR 本文に書く。既存の掃引テストが一部の fixture（`.reconstructed.` など）を除外していないかも見る
- テスト名・docstring（「production topology を固定する」など）は主張であって証拠ではない。`vi.resetModules()` で作れるのは第 2 の module instance までで、webpack の chunk 境界ではない。module scope の状態がバンドル境界をまたいで共有されるかは、`.next/server/chunks` を grep して（別のコピーがあるか・初期化関数の呼び出しが何件あるか）裁定する
- ガードの許可リストの 1 行は、多くの場合「文書・コードがそうなっている」という主張で、ガードはそれを検証しない。行の理由が状態を主張していたら grep で裏を取る。「先例と同じ扱い」で揃えるときは、先例の行ではなく、先例が根拠にした文書の本文まで読む。散文の注記はガードで守れないので、同じ commit で両方を直す運用をコメントに残す

### モックとテスト環境の罠

- `vi.mock('<path>', () => ({ ... }))` の factory は、その時点の export を凍結した部分 mock になる。子モジュールに新しい export を足して親から使うと、その子を部分 mock している別のスイートだけが `No "<名前>" export is defined on the mock` で落ちる（そのスイート単独では起きない）。足す前に `grep -rln "vi.mock('@/<子のパス>'" tests/` で factory 形式の mock を探し、scope 外なら経路を変える
- `tests/setup.ts` の next-intl のグローバルモックは key をそのまま返し、補間の param を描画しない（key に placeholder が無いため）。param 由来の値（エラーコード・件数）を assert するテストは、ファイルの先頭で next-intl を再モックして param を見える形にする。辞書の key・placeholder の欠落はモックでは分からないので、実辞書のテスト（`tests/unit/i18n/`）で別に確かめる
- fake timers は子プロセスの完了を進められない。poller / checker を実物で回す統合テストは、await の先で実 tmux を呼ぶもの（`@/lib/tmux/geometry-delegation` の `probeGeometryDelegation` など）を stub する。stub しないと、`advanceTimersByTimeAsync` が返った後に tick が続き、後始末で DB を閉じた後に保存が走る。「tick が走ったのに行もログも無い」ときは、対象の関数の await に新しい実 I/O が増えていないかを見る
- React 19 は `act()` の外の state 更新をすぐには flush しない。タイマーを進めるのは `await act(async () => { await vi.advanceTimersByTimeAsync(ms) })` にする。否定の assert（`not.toBeInTheDocument()`）は act 無しだと「更新が flush されていないだけ」で偽の PASS になる。落ちた 1 件だけ直すと隣のテストに症状が移るので、同じ describe の同型をまとめて直す
- ルートハンドラの先頭が `await params` になると、`void GET(req, ctx); expect(...)` の「最初の await までは同期」という前提が崩れる。`await GET(...)` にする。クライアントの page が `use(params)` を使うなら、`await act(async () => { render(<Suspense fallback={null}>...</Suspense>) })` で描画する。移行で落ちたテストは skip せずテスト側を直す
- キーボード・フォーカスのテストで、フォーカスの当たっていない要素へ `fireEvent` を直撃させると、実使用でキー操作が全滅する欠陥を隠す。イベントは実際にフォーカスされた要素へ送る。この環境（React 19・jsdom・RTL）では `el.focus()`・`fireEvent.focus`・`fireEvent.focusIn` のどれも React の `onFocus` に届くので、Tab の経路をそのまま再現する `el.focus()` / `el.blur()` を第一に使う。親に素の `addEventListener('focus')` を付ける実装は、focus がバブルしないので実物でも動かない（テストではなく実装の問題）。`.focus()` は `tabIndex=-1` の要素にも当たるので、Tab で届くことは `tabIndex` で別に確かめる

### build と静的ガードだけが見るもの

- ブラウザ側（`src/hooks`・`src/components`）が読むモジュールが、推移的に node 専用のモジュール（logger → env → fs など）を引くと、Next の `npm run build` だけが `Can't resolve 'fs'` で落ちる。lint・typecheck・unit は通り、esbuild の metafile での確認も Next の webpack の判定とは別物。client が読む変更を含むときは自分の worktree で `npm run build` を通し、client が読む lib は logger / env / db を引かない純関数に分ける（ガードの例: `tests/unit/guards/use-auto-yes-client-imports-3748.test.ts`）
- `scripts/check-token-discipline.mjs` は名前に `Terminal` を含むファイルだけを raw palette の検査から外す。`*Terminal*` のファイルを分割すると、移しただけの行が違反になる。分割先の名前にも `Terminal` を含めるか、`node scripts/check-token-discipline.mjs` を回す（契約の既定のゲートには入っていない）
- 意図的に NUL バイトを含むテストファイルがある（制御文字を拒否するテストなど）。grep はそれをバイナリとして黙って飛ばすので、grep の件数を完了の判定に使うときは `grep -a` を付ける。NUL の有無の判定は shell ではなく python（`b'\x00' in open(f, 'rb').read()`）で行う（zsh の `$'\x00'` は空文字列に潰れる）。移行の完了は grep だけでなく typecheck でも裏を取る

### 一括置換の確かめ

置換の件数を確かめるガード自体が偽の PASS を出すことがある。数か所なら Edit ツールの完全一致の置換を使う（一致しなければ明示的に失敗する）。sed を使うのは同じパターンが多数あるときだけにし、置換前の件数を期待値と照合 → 置換 → 旧パターン 0 件・新パターンが期待値、を確かめる。

- zsh は未クォートの変数を単語分割しない。`FILES="a.ts b.ts"; grep -c x $FILES` は 1 つのファイル名として扱われる。配列（`files=(a.ts b.ts)`）か `${=FILES}` を使う
- `grep -c` は一致した行数で、出現回数ではない。複数ファイルでは `file:count` が並ぶので `awk -F: '{s+=$2} END{print s}'` で足す。`$(grep -c ... || echo 0)` は `"0\n0"` になって数値比較がエラーになり、`if` が偽になってガードを素通りする
- sed の区切り文字がパターンと衝突する（markdown の表の行に `s|...|...|` など）と `bad flag in substitute command` になる

### E2E（Playwright）

- `CI` が未設定だと reporter は `html`（既定は失敗時に開く）で、テストが 1 件でも落ちるとレポートのサーバ（ポート 9323）が起動してプロセスが返らない。エージェントに実行させるときは `CI=true npx playwright test tests/e2e/<spec>.spec.ts --reporter=line` の形にする。`test-results/.last-run.json` が書かれているのに `playwright test` のプロセスが生きていたらこの症状
- `playwright.config.ts` が起動する隔離サーバは worktree が 0 件なので、worktree に依存する spec は `test.skip(true, 'No worktrees available')` で黙って skip する。それで「通った」spec は何も確かめていない。画面に入るには、ブラウザ側で `/api/` を `page.route` でモックして `/worktrees/<id>` へ直接行く（`tests/e2e/fixtures/terminal-split-helpers.ts` の形）。サーバに worktree を登録すると、並行して走る破壊的な spec からも見えてしまう
- ポートは `CM_E2E_PORT` で変える（3000 は拒否される）。寸法の測定に手で dev サーバを立てない。継承した本番の環境変数は `env -u CM_DB_PATH -u CM_ROOT_DIR ...` で明示的に外す
- `addInitScript` はすべての document で走るので、localStorage を消す init script は `page.reload()` で永続を確かめるテストの値まで消す。`sessionStorage` のフラグで初回だけにする
- 初期状態を確かめずにトグルを押さない（パネルが既に開いていると押して閉じてしまう）。開いていなければ開く、の書き方にし、可視は `expect(...).toBeVisible()` で待つ。キャレットは Home / End キーではなく `setSelectionRange()` で置く（macOS の Chromium で割り当てが違う）
- CSS の修正が効いていることは、実行時にそのクラスを外して測り直す（陰性対照）ことで示す。Ctrl+ホイールのような実入力はページごと拡大して以降の測定を狂わせるので、合成の `WheelEvent({ ctrlKey: true })` を dispatch する
- UI に要素（とくに縦の行）を足す変更は、過去の Issue が e2e に書いた寸法の受入基準（高さのしきい値・タップ領域）を黙って壊す。検証ゲートに e2e は無いので、関連する spec をローカルで回して exit code を見る。赤は、その変更を含まないブランチで同じ spec を回す対照で帰属を確かめる。`tests/e2e/` のしきい値を緩めて直さない（並行する Issue の扱いは [plan-check.md 1-4](../orchestrate/plan-check.md)）

### 実 TUI と tmux を使う検証

- 隔離は `tmux -L <専用 socket>` だけが効く。エージェントは tmux のペインの中で動くので `$TMUX` が常に本番のサーバを指し、一時ディレクトリを変える環境変数は無視される。サーバ全体を止めるサブコマンドを socket 無しで打たない（[contract.md 2-5](../orchestrate/contract.md)。`tests/unit/config/tmux-live-test-safety.test.ts` が `tests/`・`scripts/`・`docs/`・`.claude/` などの禁止の綴りを弾くので、手順を文書に書くときも引っかかる）
- 準備のブロックと後始末のブロックは別のプロセスになる。準備で `unset TMUX` しても後始末には効かないので、ad-hoc の bash でも tmux は毎回 `-L` 付きで呼ぶ
- socket 引数を取らない本番コード（`src/lib/tmux/tmux.ts` は `execFile('tmux', ...)` で PATH を引く）を私設サーバへ向けるには、`-L <label>` を付けて本物の tmux を `exec` するシムを PATH の先頭に置くのが確実（`$TMUX` の値に関係なく届く）。シムで argv を記録すれば、本番にカウンタが無い呼び出し回数も数えられる。転送が効いていること（私設側にセッションがあり、既定のサーバ側に無いこと）を毎回 assert する
- `-S <絶対パス>` は unix socket のパス長の上限（macOS で約 104 byte）に当たるので、repo 配下の深いパスでは使えない。`-L <label>` を使う
- 私設サーバで `history-limit` を上げるときはサーバ全体のオプションではなくセッション単位で: 空の `new-session` → `set-option -t '=<名>:' history-limit N` → `new-window` で中身のペイン → 最初のウィンドウを `kill-window`
- 実 TUI のキャプチャは本番と同じペインの大きさ（200x1000）で採る。既定の 120x40 では、ダイアログと画面最下部に固定されるパネル・composer が同じ画面に載らず、検出層のバグが再現しない。`new-session -x 200 -y 1000` の後に `set-option -t '=<名>:' window-size manual` と `resize-window` で大きさを固定し、`capture-pane -p -S -1200` で採る
- 起動直後はシェルがまだプロンプトを出しておらず、送った起動コマンドが食われることがある（`#{pane_current_command}` がシェルのまま）。プロンプトの行が出るまで待ってから送るか、Enter を送り直す。1000 行のペインで `capture-pane -S -40` は空に見えることがあるので、`-S -200` 以上を採って空行を落とす
- 初回の信頼の確認（trust）ダイアログは Enter だけで通さない。claude には既定のカーソルが `No, exit` にある画面があり、そのまま Enter を送ると claude が終わる（`resolveClaudeTrustDialogKeys` が画面からカーソルと `Yes` の行の距離を読むのと同じ理由）。キャプチャでカーソルの行を確かめ、`Yes, I trust this folder` まで Up / Down で移ってから Enter で確定する（[uat-isolation.md](../user-guide/uat-isolation.md) の「tmux は私設のサーバーを通常の環境で起こす」と同じ手順）。設定を変えるコマンド（`/model` など）は送らない。ダイアログの表示中は `send-keys` の文字列がどこにも現れず飲まれる
- 検出パーサの fixture を Issue 本文の記述から起こすと、fixture とパーサが互いに合わせて作られ、unit も e2e も緑のまま実機で壊れる（行の並び・CLI の版の違い）。fixture の出所（実機採取か）を PR の前に確かめ、本文由来ならマージの前に実機で確かめる。実機のフレームを渡すときはメールアドレスなどを伏せ字にする
- `tests/` の下には fixture のディレクトリを再帰で走査して件数・名前を固定するスイートがあり、fixture を置くだけで別のスイートが赤になる。置く前に `grep -rln readdirSync tests/ | xargs grep -ln fixtures` で走査するスイートを挙げ、何を assert するかを読む（契約の書き方は [contract.md 2-4](../orchestrate/contract.md)）
- 修正前（HEAD）の対照は、repo のファイルを書き換えずに `git archive HEAD src tsconfig.json package.json | tar -x -C <scratch>/baseline` で取り出し、`node_modules` を symlink して同じドライバを走らせる（unit の対照なら `vitest.config.ts`・`tests/setup.ts`・`tests/helpers` も取り出す）。本物のモジュールは `./node_modules/.bin/tsx --tsconfig <root>/tsconfig.json driver.mts` から `await import()` で読む。hook のイベントは、サーバを立てずに小さな http の listener で受けて確かめられる。CLI が自分の設定ファイル（最近使ったモデルなど）を書き換えることがあるので、始める前に退避して後で戻す

### サーバの負荷を測る

- CPU を測るときは production ビルド（`npm run build && npm run build:server` → `node dist/server/server.js`）で起動する。dev mode は webpack が CPU を占める
- 隔離: 専用のポート、`CM_DB_PATH` は `<repo>/data/` の下（DB のパスの検証が `/tmp`・`/var` を拒否するので scratchpad は使えない）、tmux は上の PATH のシム。`WORKTREE_REPOS` を repo 内のディレクトリに向けない（起動時のスキャンが本物のリポジトリの worktree を隔離 DB に取り込む）
- キャプチャの fixture をペインに流すときは末尾の空行を落とす（空のフレームと判定されて全セッションが非稼働になり、軽すぎる結果が出る）。リクエストの URL・クエリはフックのソースから写す。自作の引数パーサが `--key value` を読めているかを確かめる
- 負荷 0 の対照（呼び出し 0・CPU 0%）を 1 本取ってから、測った数字をすべて対象の由来と言う。転送量は `fetch`（解凍して encoded の長さを捨てる）ではなく生の `http.request` で受信チャンクを足す。CPU は `ps -o cputime= -p <pid>` の前後差で、子プロセス（tmux サーバ）はサーバの値に入らないので別に取る
- 合否の基準は測る前に書く。始める前にポート・`$HOME` 直下・`~/.commandmate` 直下・`tmux -L <label> ls` の状態を控え、終わった後の差分で後始末を確かめる

## トラブルシューティング

### サーバーが起動しない

```bash
# ポートが使用中の場合（待ち受け中のプロセスだけを止める。-sTCP:LISTEN を外すと接続中のブラウザ等も止まる）
lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs kill -9

# 依存関係を再インストール
rm -rf node_modules package-lock.json
npm install

# ビルドをクリーンアップ
rm -rf .next
npm run build
```

### データベースエラー

```bash
# データベースをリセット
rm -f data/db.sqlite
npm run db:init
```

### Worktree が検出されない

`CM_ROOT_DIR` が正しく設定されているか確認：

```bash
# 環境変数を確認
cat .env | grep CM_ROOT_DIR

# ディレクトリが存在するか確認
ls -la $CM_ROOT_DIR

# Git worktree があるか確認
cd $CM_ROOT_DIR && git worktree list
```

### WebSocket 接続エラー

```bash
# WebSocket サーバーが起動しているか確認
curl -I \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  http://localhost:3000/

# ブラウザのコンソールでエラーを確認
# 開発者ツール > Console タブ
```

### 外部アクセスのセキュリティ

外部公開する場合はリバースプロキシでの認証を設定してください。
詳細は [セキュリティガイド](../../docs/security-guide.md) を参照してください。

## パフォーマンスチェック

### ページ読み込み時間

ブラウザの開発者ツールで確認：

1. F12 キーを押して開発者ツールを開く
2. Network タブを開く
3. ページをリロード
4. DOMContentLoaded、Load の時間を確認

**目標**:
- DOMContentLoaded: < 1秒
- Load: < 2秒

### メモリ使用量

```bash
# Node.js プロセスのメモリ使用量を確認
ps aux | grep "tsx server.ts" | awk '{print $6}'
```

**目標**: < 500MB

### データベースサイズ

```bash
# データベースサイズを確認
du -h data/db.sqlite
```

## 完了チェックリスト

すべての動作確認が完了したら、以下を確認してください：

- [ ] 開発サーバーが起動する
- [ ] HTTP エンドポイントにアクセスできる
- [ ] Worktree 一覧が取得できる
- [ ] メッセージの送受信ができる
- [ ] WebSocket 接続ができる
- [ ] ユニットテストがパスする
- [ ] 統合テストがパスする
- [ ] E2E テストがパスする
- [ ] UI が正しく表示される
- [ ] ブラウザのコンソールにエラーがない

## 次のステップ

動作確認が完了したら：

1. **本番環境へのデプロイ**
   - [デプロイメントガイド](./DEPLOYMENT.md) を参照
   - [プロダクションチェックリスト](./PRODUCTION_CHECKLIST.md) を確認

2. **カスタマイズ**
   - UI コンポーネントのカスタマイズ
   - Claude CLI の設定調整
   - tmux の設定カスタマイズ

3. **モニタリング**
   - ログの監視
   - パフォーマンスの追跡
   - エラーの監視

---

問題が発生した場合は、[GitHub Issues](https://github.com/kewton/CommandMate/issues) で報告してください。
