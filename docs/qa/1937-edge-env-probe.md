# 実測記録: Edge サンドボックスの env スナップショットとモジュール分離（Issue #1937 U-7 / U-9）

- **対象**: [Issue #1937](https://github.com/Kewton/CommandMate/issues/1937) / 設計方針書 [`docs/design/remote-qr-pairing-1937.md`](../design/remote-qr-pairing-1937.md) §11 の **U-7** と **U-9**
- **実測日**: 2026-08-29
- **branch**: `docs/1937-u7-edge-probe`（develop に R1〜R11 が着地済みの状態）
- **本書の性格**: 手順書ではなく**記録**。U-7 は決定 B の根拠なので、覆っていれば §3 を書き直す必要がある

---

## 0. 結論（先に書く）

| ID | 問い | 結論 |
|---|---|---|
| **U-7** | production build の実機で、サーバ起動後に Node 側の `process.env.CM_AUTH_TOKEN_HASH` を書き換えると middleware の判定は変わるか | **変わらない。env はスナップショットされている。§3 / 決定 B の前提は実測で保たれた。§3 の書き直しは不要** |
| **U-9** | route handler から `server.ts` 由来のモジュールレベル状態が見えるか | **見えない。別インスタンスである。§7.2 の前提どおりで、ファイル方式の変更は不要**（ただし `globalThis` は共有されている。§4.3 に含意を書いた） |

**U-7 で 1 点だけ精度を上げる必要がある。** §3 と §11 は「サーバ起動後に書き換えても届かない」と書いているが、
実測では **`> Ready on` が出た瞬間（listen 直後・リクエスト 0 件）にはまだ書き換えが届く**。
窓が閉じるのは `Ready` から **0.5 秒以内**である（§3.4 の測定表）。
`commandmate remote` の文脈ではこの窓は使えない（ペアリング資格情報を listen と同じ tick で発行することはできない）ので
**決定は 1 ミリも動かない**が、§3 の文言を「起動後」ではなく **「サーバがリクエストを受け付け始めた後」** と読むこと。

---

## 1. 実測環境

| 項目 | 値 |
|---|---|
| Node | v24.1.0 |
| Next.js | 15.5.20（`next.config.js` に `experimental.nodeMiddleware` は無い） |
| ビルド | `npm run build`（`NODE_ENV=production next build`）＋ `npm run build:server` |
| 起動 | `node dist/server/server.js`（本番と同じカスタムサーバ経路。`npm start` と同一） |
| ポート | 3211 →（他 worktree の `cloudflared` と衝突したため途中から）3877。**本番 3000 には一切触れていない** |
| HOME | `/Users/maenokota/.commandmate-probe-1937u7/home`（隔離。`~/.commandmate/.env` を読ませないため） |
| `CM_DB_PATH` | `/Users/maenokota/.commandmate-probe-1937u7/db/<run>.sqlite`（使い捨て。実測後に削除） |
| `WORKTREE_REPOS` | 空ディレクトリ |
| PATH | `tmux` と `git` を**意図的に外した**。起動経路が `cleanupGlobalSessions()` を呼ぶため、稼働中の tmux に触らせない |

`.next` / `dist` は本 worktree のもので、本番（`MyCodeBranchDesk` チェックアウト、PID 22174）とは別物。
Tunnel は作っていない（`commandmate remote` / `tailscale` / `cloudflared` を実行していない）。

### 1.1 プローブ用の一時改変（commit していない）

実測のために次の 4 つを**一時的に**置き、計測後に完全に撤去した（`git diff HEAD` が空であることを確認済み）。

| 置いたもの | 目的 |
|---|---|
| `src/middleware.ts` の先頭に `/api/probe-mw` の短絡分岐 | **Edge サンドボックス側の `process.env` が実行時に何を持っているか**を JSON で返す |
| `src/lib/probe-u9-marker.ts`（モジュールレベルの可変状態） | server.ts 側と route handler 側の**インスタンス同一性**を比較する |
| `src/app/api/probe-u9/route.ts` | route handler 側から上記モジュールと `process.env` を読み出す |
| `server.ts` に上記モジュールの import ＋ `setProbeU9Value('set-by-server-ts')` | server.ts 側でモジュール状態を書き換える |

env の書き換え手段は**ランチャ方式**にした。`node <scratchpad>/probe-launcher.cjs` が
`require(dist/server/server.js)` の前に SIGUSR2 ハンドラを張るだけのもので、**サーバと同一プロセス**で動く。
したがって `process.env` はサーバが読むその object そのものである。

```js
process.on('SIGUSR2', () => {
  process.env.CM_AUTH_TOKEN_HASH = process.env.PROBE_HASH_B;
  process.env.CM_PROBE_MARKER = 'flipped-after-boot';
});
require(process.env.PROBE_SERVER_ENTRY);
```

### 1.2 使い捨てクレデンシャル

| 名前 | SHA-256 ハッシュ（先頭 12 桁） |
|---|---|
| token-A（起動時に与えた） | `a22fec8b2ee4` |
| token-B（起動後に差し替えた） | `4bb019d6b8ac` |

いずれも `crypto.randomBytes(32)` の使い捨てで、本記録には**ハッシュの先頭のみ**を載せる。

---

## 2. U-7 の手順

1. 上記の隔離環境で production build を作る
2. `CM_AUTH_TOKEN_HASH=<hash-A>` と `CM_PROBE_MARKER=boot-value` を与えて起動する
3. token-A で認証が通り、token-B が弾かれることを確認する（Bearer と Cookie の両経路）
4. **サーバプロセスの Node 側で** `process.env.CM_AUTH_TOKEN_HASH` を `<hash-B>` に、`CM_PROBE_MARKER` を
   `flipped-after-boot` に書き換える
5. 次の 3 つを見る
   - `GET /api/probe-mw` — **Edge サンドボックスが見ている env**
   - `GET /api/probe-u9` — **Node ランタイム（route handler）が見ている env**（＝書き換えが本当に起きたことの陽性対照）
   - token-A / token-B の**認証結果**（middleware の実際の判定）
6. 書き換えの**タイミングを変えて**同じ計測を繰り返し、窓が閉じる時点を挟み込む

---

## 3. U-7 の結果

### 3.1 陽性対照 — 書き換えは本当に起きている

書き換えを行った全ランで、**Node ランタイムの route handler は新しい値を見た**。

```
{"routeSeesValue":"initial", ..., "envAuthHashPrefix":"4bb019d6b8ac","nextRuntime":"nodejs","pid":35756}
```

つまり `process.env` の変更はプロセス全体に反映されており、以下の「middleware が変わらない」は
**書き換えが失敗したせいではない**。

### 3.2 本体 — リクエストを 1 回通した後に書き換える（run3）

```
### phase1-before-flip
-- GET /api/probe-mw
{"mwSeesHashPrefix":"a22fec8b2ee4","mwSeesProbeMarker":"boot-value","nextRuntime":"edge","envKeyCount":20,"hasProcessBinding":"function"}
-- GET /api/probe-u9  Bearer TOKEN_A   http=200   envAuthHashPrefix a22fec8b2ee4
-- GET /api/probe-u9  Bearer TOKEN_B   http=401
-- GET /  cookie=TOKEN_A               http=200
-- GET /  cookie=TOKEN_B               http=307 redirect=http://localhost:3211/login

  [PROBE-U7] flip(SIGUSR2): node-side CM_AUTH_TOKEN_HASH -> 4bb019d6b8ac / CM_PROBE_MARKER -> flipped-after-boot / uptime=4220ms

### phase2-after-flip
-- GET /api/probe-mw
{"mwSeesHashPrefix":"a22fec8b2ee4","mwSeesProbeMarker":"boot-value","nextRuntime":"edge","envKeyCount":20,"hasProcessBinding":"function"}
-- GET /api/probe-u9  Bearer TOKEN_A   http=200   envAuthHashPrefix 4bb019d6b8ac
-- GET /api/probe-u9  Bearer TOKEN_B   http=401
-- GET /  cookie=TOKEN_A               http=200
-- GET /  cookie=TOKEN_B               http=307 redirect=http://localhost:3211/login
```

**hash-A のトークンが依然として通り、hash-B のトークンは通らない。**
Edge 側は `mwSeesHashPrefix` も `mwSeesProbeMarker` も起動時の値のままである。
route handler が同時に `4bb019d6b8ac` を見ていることが、両者が**別の env を見ている**ことを直接示している。

→ **env はスナップショットされている。設計の前提どおり。**

### 3.3 リクエストを 1 回も通さずに書き換える（run4）

`getModuleContext()` は Next のソース上は遅延生成なので、「スナップショットは初回リクエスト時に取られるのでは」を潰した。
readiness 判定を **生の TCP connect のみ**にして HTTP リクエストを 1 件も発生させず、その状態で書き換えた。

```
[PROBE-U7] flip(SIGUSR2): ... uptime=4124ms      ← "> Ready on" より後、HTTP リクエストは 0 件
-- GET /api/probe-mw
{"mwSeesHashPrefix":"a22fec8b2ee4","mwSeesProbeMarker":"boot-value","nextRuntime":"edge", ...}
-- Bearer TOKEN_A http=200 / Bearer TOKEN_B http=401 / cookie A 200 / cookie B 307
```

**初回リクエストより前にすでに凍っている。**

### 3.4 窓が閉じる時点の挟み込み

書き換えの時刻だけを変えて 5 通り測った（すべて同一ビルド・同一手順）。

| ラン | 書き換えの時点 | uptime | Edge が見た hash | Edge が見た marker | Bearer A | Bearer B | cookie A | cookie B |
|---|---|---|---|---|---|---|---|---|
| run5 | `app.prepare()` 実行中（`Ready` より前） | 408ms | **B** `4bb019d6b8ac` | **flipped** | 401 | **200** | 307 → /login | **200** |
| run6 | `> Ready on` を出力したその瞬間 | 1101ms | **B** `4bb019d6b8ac` | **flipped** | 401 | **200** | 307 → /login | **200** |
| run7a | `Ready` + 500ms | 1720ms | A `a22fec8b2ee4` | boot-value | 200 | 401 | 200 | 307 → /login |
| run7b | `Ready` + 2000ms | 3215ms | A `a22fec8b2ee4` | boot-value | 200 | 401 | 200 | 307 → /login |
| run4 | `Ready` 後・HTTP リクエスト 0 件 | 4124ms | A `a22fec8b2ee4` | boot-value | 200 | 401 | 200 | 307 → /login |
| run3 | リクエストを 5 件通した後 | 4220ms | A `a22fec8b2ee4` | boot-value | 200 | 401 | 200 | 307 → /login |

**境界は `Ready`+0ms（まだ届く）と `Ready`+500ms（もう届かない）の間**にある。
その区間でサーバが行っているのは DB マイグレーション・worktree スキャン・schedule/timer/resource の初期化だけで、
**HTTP リクエストは 1 件も発生していない**（`server.log` で確認）。
Next のどの内部フックが env のコピーを取っているかまでは追っていない。**追う必要が無い**からで、
設計に効くのは「サーバがリクエストを受け付け始めた後は絶対に届かない」という事実のほうである。

なお run5 / run6 が**書き換えを検出できている**ことが、run3 / run4 / run7 の「変わらない」が
プローブの空振りではないことの陽性対照になっている。

### 3.5 なぜそうなるか（ソース側の裏取り、Next 15.5.20）

実測と整合するソースは `node_modules/next/dist/server/web/sandbox/context.js`（識別子で参照する）。

- `buildEnvironmentVariablesFrom()` が `Object.keys(process.env).map(...)` から**新しい object を作る**
- `createProcessPolyfill()` はその object を `env` に持ち、**`env` 以外の `process` のキーはすべて
  `undefined` か「呼ぶと `throwUnsupportedAPIError` を投げるスタブ」に潰す**
- 作られたコンテキストは `moduleContexts` Map にキャッシュされ、`clearAllModuleContexts()` /
  `clearModuleContext()` は dev のファイル変更経路からしか呼ばれない

3 点目までは §3.1 の記述どおり。**2 点目は §3.1 に無かった追加の裏取り**で、これは重要である:
Edge サンドボックスから Node 側の可変値を覗く**抜け道が `process` 経由には無い**ことを意味する。
プローブの `hasProcessBinding: "function"` は、`process.binding` が実体ではなく**投げるスタブ**として
生えていることを見ているだけで、値を運べる経路ではない。

ビルド成果物側も見た。`.next/server/src/middleware.js` には `process.env.CM_AUTH_TOKEN_HASH` が
**5 箇所そのまま残っている**（`grep -o ... | wc -l` = 5）。つまり値は build 時にインライン化されておらず、
実行時にサンドボックスの `process.env`（＝上記のコピー）から読まれている。これも実測と整合する。

### 3.6 §3 / 決定 B への影響

**覆っていない。書き直し不要。** §3.1 の障壁表 2 行目「env で渡しても動的に増やせない」は実測で裏付けられた。
S1〜S4 の選択肢の枠組みもそのまま成立する。

文言だけ 1 点、§3.1 と §11 の **「サーバ起動後に Node 側で `process.env` を書き換えても」** は、
厳密には **「サーバがリクエストを受け付け始めた後に」** である（§3.4）。
`remote` の実装がこの sub-second の窓を使う余地は無い（ペアリング資格情報は CLI 側が生成し、
サーバはそれを起動 env かファイルでしか受け取れない）ので、決定 B は変わらない。

---

## 4. U-9 の結果

### 4.1 手順

`src/lib/probe-u9-marker.ts` に、モジュール読み込みごとに異なる `instanceId` を持つモジュールレベルの
可変 object を置き、

- `server.ts`（`tsconfig.server.json` → `dist/server`、CommonJS の `require` レジストリ）が
  起動時に `value` を `'set-by-server-ts'` に書き換え、同じ `instanceId` を `globalThis` にも置く
- App Router の route handler（Next の webpack bundle）が同じモジュールを import して `value` と
  `instanceId`、および `globalThis` の値を返す

### 4.2 結果 — 別インスタンスである

```
server.ts 側:   [PROBE-U9] server.ts side instanceId=inst-nb0dijku value=set-by-server-ts

route handler:  {"routeSeesValue":"initial",
                 "routeInstanceId":"inst-chpe596e",
                 "globalMarkerFromServerTs":{"instanceId":"inst-nb0dijku","value":"set-by-server-ts"},
                 "nextRuntime":"nodejs","pid":35756}
```

- `pid` は server.ts 側と同一（同一プロセス）
- それでも `routeInstanceId` (`inst-chpe596e`) は server.ts 側 (`inst-nb0dijku`) と**異なる**
- `routeSeesValue` は `'initial'` のまま。**server.ts の書き込みは route handler に見えていない**

→ **§7.2 の「`server.ts` 側のモジュールレベル変数は route handler から見えない」は実測で正しい。
ハンドオフファイル方式に変更は要らない。** 4 ラン（run3〜run7）すべてで再現した。

### 4.3 ただし `globalThis` は共有されている（設計変更は不要・実装 Issue 向けの含意）

同じ計測で `globalMarkerFromServerTs` が **server.ts 側の `instanceId` をそのまま返した**。
つまり**モジュールレジストリは 2 つだが `globalThis` は 1 つ**である。§7.2 はこの区別に触れていない。

**これは §7.2 の決定を覆さない。** 理由は生成者が誰かにある。ペアリングコードと長期トークンを作るのは
`commandmate remote` の CLI プロセスであって、サーバプロセスではない。**別プロセスから相手の
`globalThis` には書けない**ので、CLI → サーバの受け渡しは結局 env かファイルしか無い。§7.2 の選択は正しい。

含意があるのは**サーバ内部**の一段だけである。R5/R6 の実装者への申し送りとして書いておく:

- server.ts が**起動時に 1 回**ハンドオフファイルを読んで `globalThis` に載せ、その場で `unlinkSync` する形が
  技術的には成立する（route handler から読めることを本実測が示した）
- その場合、平文がディスクに存在する時間は「`remote` 起動 〜 サーバ起動」の**数秒**に縮む
  （現行案は「`remote` 起動 〜 初回ペアリング」で最大 10 分。§7.2 が「数分に縮む」と書いている窓）
- 代償: 消費済みフラグが「ファイルの不在」で表現できなくなり、`server.ts` 側の初期化順序に依存が増える。
  §7.2 が module-level 変数を避けた理由 (2)（消費と同時に平文が消える）は `delete globalThis[...]` で
  代替できるが、**fail-closed の担保がファイル削除より弱い**
- **本書は方式を推奨しない。** §7.2 のファイル方式のままで設計上の破綻は無い

---

## 5. 環境への影響（禁止事項の遵守確認）

| 項目 | 開始時 | 終了時 |
|---|---|---|
| 本番 3000 の HTTP ステータス | 200 | 200 |
| 稼働 tmux セッション数 | 27 | 27 |

- 本番インスタンス（PID 22174、`MyCodeBranchDesk` チェックアウト）は停止も再起動もしていない。DB にも書いていない
- `commandmate remote` / `tailscale` / `cloudflared` を実行していない。**公開 Tunnel は作っていない**
- `tmux kill-server` を実行していない。プローブサーバの PATH から `tmux` を外し、`cleanupGlobalSessions()` が
  セッションに触れないようにした（開始時に `mcbd-*-__global__` セッションが 0 件であることも確認済み）
- ビルドは本 worktree でのみ実施。本番の `.next` / `dist` は触っていない
- 一時的なプローブ用の改変・使い捨て DB・隔離 HOME はすべて撤去済み

途中 1 度、ポート 3211 を**他の worktree の `cloudflared`（PID 50377）が掴んでいた**ため 3877 に移した。
その `cloudflared` には触れていない（本作業が起動したものではない）。以降のドライバは
`Port ... is already in use` を検出したら中断するようにした。
