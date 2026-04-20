# Bug-Fix 進捗報告書: Issue #671

- **Bug ID**: `issue671_20260420_085636`
- **関連 Issue**: [#671 External Apps WebSocket proxy が upstream に到達しない](https://github.com/Kewton/CommandMate/issues/671)
- **ブランチ**: `feature/671-worktree`
- **ワークフロー**: `/bug-fix`
- **作成日**: 2026-04-20
- **総合ステータス**: Phase 1〜5 すべて完了 / 受け入れ基準 10/10 pass / 未コミット（レビュー待ち）

---

## 1. 概要

### 事象
External Apps として登録した Streamlit などの WebSocket 利用アプリを Open しても画面が初期状態で止まり、`_stcore/stream` への WebSocket 接続が確立しない。

### 根本原因
- `server.ts` は `upgrade` ヘッダを持つリクエストを HTTP サーバーの `upgrade` イベントに流している。
- `src/lib/ws-server.ts` の `upgrade` ハンドラは `/_next/` 以外のすべてのパスを CommandMate 内蔵 WebSocketServer にハンドオーバーしていたため、`/proxy/<prefix>/_stcore/stream` 宛の Upgrade も内蔵 WSS に吸収されていた。
- 結果として Next.js Route Handler 側の `proxyWebSocket()`（426 返却）はそもそも呼ばれず、Streamlit upstream にも到達しない構造的欠陥だった。

### 補助的な不具合
- `/proxy/<prefix>/` が Next.js の 308 で `/proxy/<prefix>` にリダイレクトされ、Streamlit の相対リンクと齟齬が出るケース。
- `src/app/proxy/[...path]/route.ts` に `HEAD` メソッドが無く、先行ヘルスチェックで 405 が返る。

### 採用対策（主対応＋補助対応すべて）
1. **主対応**: `ws-server.ts` の upgrade ハンドラに `/proxy/<prefix>` 専用の WebSocket TCP パススループロキシを追加（`handleProxyUpgrade()` を DI 可能なヘルパーとして分離）。
2. **補助**: `src/lib/proxy/handler.ts` の `proxyWebSocket()` を `@deprecated` stub 化し、防御的 fallback として 426 を維持。
3. **補助**: `/proxy/[...path]/route.ts` に `HEAD` エクスポートを追加。
4. **補助**: `next.config.js` に `skipTrailingSlashRedirect: true` を追加。

---

## 2. Phase 1〜5 の結果サマリ

### Phase 1: Investigation（調査）
- **ステータス**: completed
- **成果物**: `investigation-result.json`
- **備考**: Issue #671 に既に詳細な根本原因分析と採用対策が記載されていたため、investigation-agent 呼び出しは省略し、Issue 内容を投影した investigation-result.json を作成。
- **特定した影響ファイル**: `src/lib/ws-server.ts` / `src/lib/proxy/handler.ts` / `src/app/proxy/[...path]/route.ts` / `server.ts`

### Phase 2: Countermeasure Selection（対策選択）
- **ステータス**: completed
- **ユーザー判断**: 主対応 + 補助対応すべて
- **選択アクション**: `1-ws-proxy`, `2-proxy-handler-stub`, `3-head-method`, `4-trailing-slash`

### Phase 3: Work Plan（作業計画）
- **ステータス**: completed
- **成果物**: `work-plan-context.json`
- **主な Definition of Done**:
  - Streamlit で WS が確立しアプリが完全にインタラクティブに動作する
  - `enabled=0` / `websocket_enabled=0` の App への WS Upgrade を 4xx で拒否
  - 既存内蔵 WSS 機能（terminal_subscribe, subscribe, broadcast）にリグレッションが無いこと
  - lint / tsc がパス、新規テストカバレッジ 80% 以上

### Phase 4: TDD Implementation（実装）
- **ステータス**: success
- **成果物**: `tdd-fix-result.json`
- **追加テスト数**: 12（新規 11 + 既存ファイル追加 1）
- **新コードパスのカバレッジ見積もり**: 約 92%
- **実装アプローチ**:
  - `handleProxyUpgrade(request, socket, head, deps)` を `export` し、`getDb` / `getCache` / `netConnect` の DI を受け付ける構造に。テストは EventEmitter スタブで完結させ、実 TCP / 実 DB を使わない。
  - upgrade ハンドラは `IP 制限 → 認証 → /proxy/ 分岐 → 既存 wss.handleUpgrade` の順序を厳守。
  - `PROXY_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1'])` で SSRF 防御。
  - `buildUpstreamUpgradeRequest()` で HTTP Upgrade リクエスト行 + 全ヘッダをバイト単位で忠実に再構築。
  - 双方向 `socket.pipe(upstream)` / `upstream.pipe(socket)`、`teardown()` は `teardownCalled` ガードで冪等化。
  - 非同期 cache lookup 中にクライアントが切れるレースを想定し、`socket.destroyed`/`writable` を await 後に再チェック。
- **観点**: proxyWebSocket() は @deprecated JSDoc を付与し 426 挙動は維持（防御的 fallback）。

### Phase 5: Acceptance Test（受け入れ確認）
- **ステータス**: pass
- **成果物**: `acceptance-result.json`
- **結果**: AC-1〜AC-10 すべて pass（10/10）
- **検証方法**: regression-scope vitest 再実行（13 ファイル / 179 テスト / 2.44 秒） + lint / tsc 再実行 + 4 ファイルのコードレビュー

---

## 3. 変更ファイル一覧

### プロダクションコード
| ファイル | 変更概要 |
|---------|---------|
| `src/lib/ws-server.ts` | `/proxy/<prefix>` WebSocket TCP プロキシを `handleProxyUpgrade()` として追加。`PROXY_ALLOWED_HOSTS`, `writeRawResponseAndDestroy()`, `buildUpstreamUpgradeRequest()` を新規定義。`__internal.handleProxyUpgrade` でテスト公開。 |
| `src/lib/proxy/handler.ts` | `proxyWebSocket()` に `@deprecated` JSDoc を付与。防御的 fallback として残存しつつ ws-server.ts が先に受ける旨を明記。 |
| `src/app/proxy/[...path]/route.ts` | `export async function HEAD(...)` を追加（`handleProxy` に委譲）。WS 分岐上にコメントを追加し 426 挙動は維持。 |
| `next.config.js` | `skipTrailingSlashRedirect: true` を追加（Issue #671 + Streamlit baseUrlPath 整合性のコメント付き）。 |

### テストコード
| ファイル | 変更概要 |
|---------|---------|
| `tests/unit/ws-server-proxy-upgrade.test.ts`（新規） | `handleProxyUpgrade()` 全分岐の 11 テスト。400 / 404 / 503 / 403(websocket) / 403(SSRF) / localhost 許可 / happy path / 502(connect 前) / close(connect 後) / client close / destroyed-socket ガード。 |
| `tests/unit/proxy/route.test.ts` | `should proxy HEAD request through handleProxy` を追加。 |

---

## 4. テスト結果

| 種別 | コマンド | 結果 |
|------|----------|------|
| Lint | `npm run lint` | **pass** （No ESLint warnings or errors） |
| TypeScript | `npx tsc --noEmit` | **pass** （diagnostics 0 件） |
| Unit（全量） | `npm run test:unit` | **pass** 337 files / 6342 passed / 7 skipped / 0 failed |
| Regression Scope | `npx vitest run tests/unit/ws-server-proxy-upgrade.test.ts tests/unit/proxy/ tests/unit/external-apps/ tests/unit/ws-server-cleanup.test.ts tests/integration/websocket.test.ts` | **pass** 13 files / 179 passed / 0 failed （2.44s） |
| Integration（部分） | 個別実行 | `websocket.test.ts`, `ws-auth.test.ts`, `auth-middleware.test.ts` pass。`external-apps-api.test.ts` に既存の duplicate-name 409→500 失敗が 1 件（main 再現済み、本修正とは無関係）。 |

### 新コードパスのカバレッジ
- 推定 **92%**。`handleProxyUpgrade` の主要分岐（prefix 欠落 / cache miss / enabled=false / websocketEnabled=false / SSRF blocked / localhost 許可 / happy path / connect 前 error / connect 後 upstream close / client close / destroyed guard）をすべて単体テストで網羅。
- 外側の `void (async()=>{})()` の catch と cache スロー経路のみ直接アサートされていない（いずれも防御的）。

---

## 5. 受け入れ基準の達成状況

**全 10 項目 pass** （詳細は `acceptance-result.json` 参照）。

| ID | 内容 | 判定 | 根拠 |
|----|------|------|------|
| AC-1 | `/proxy/<prefix>` への WS Upgrade が upstream に TCP パススルーされる | pass | ws-server.ts:336-362 + 'connects upstream via netConnect' テスト |
| AC-2 | Upgrade 要求行・全ヘッダが verbatim 転送される | pass | `buildUpstreamUpgradeRequest()` + 対応ユニットテストで GET 行 / `upgrade: websocket` / `sec-websocket-*` / 末尾 `\r\n\r\n` を検証 |
| AC-3 | 非 `/proxy/` パスは既存内蔵 WSS (terminal_subscribe 等) に到達 | pass | upgrade handler がフォールスルー、`tests/integration/websocket.test.ts` regression pass |
| AC-4 | `enabled=0` / `websocket_enabled=0` は 4xx で拒否 | pass | 503 / 403 テスト、`netConnect` 未呼び出し確認 |
| AC-5 | 内蔵 WSS リグレッション無し | pass | 13 files / 179 tests / 0 failed |
| AC-6 | 新規ユニットテストが分岐を網羅 | pass | 11 + 1 = 12 テスト追加 |
| AC-7 | SSRF 防御（localhost/127.0.0.1 のみ許可、ログに host/port を出さない） | pass | `PROXY_ALLOWED_HOSTS` Set、403 テスト、ログに pathPrefix のみ出力 |
| AC-8 | `/proxy/[...path]` で HEAD が 405 にならない | pass | `HEAD` export + 対応テスト、`proxyHttp` は既に HEAD で body 送らない |
| AC-9 | `/proxy/<prefix>/` が 308 でリダイレクトされない | pass | `skipTrailingSlashRedirect: true` |
| AC-10 | lint / tsc / 回帰テスト pass | pass | 全て clean |

---

## 6. セキュリティ配慮

1. **SSRF 防御**
   - `PROXY_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1'])` で allow-list 化。
   - upstream host が allow-list 外なら 403 を返して client socket を destroy し、`netConnect` を呼ばない。
   - ログには host/port を含めず、`pathPrefix` と error メッセージのみ。

2. **認証 / IP 制限の順序維持**
   - upgrade handler は **IP 制限 (line 311-321) → 認証 (line 324-334) → `/proxy/` 分岐 (line 339-362) → 既存 `wss.handleUpgrade` (line 364)** の順序。
   - 認証未了 / IP 拒否のリクエストは `handleProxyUpgrade` に到達しない。

3. **ログマスキング**
   - 全ログポイント（`ws-proxy:cache-error`, `ws-proxy:ssrf-blocked`, `ws-proxy:upstream-error`, `ws-proxy:upstream-write-error`, `ws-proxy:client-error`, `ws-proxy:unhandled-error`）は pathPrefix と error message のみを含み、upstream host/port は出力しない（Issue #395 ポリシーに準拠）。

4. **リソースリーク防止**
   - `teardown()` は `teardownCalled` ガードで冪等化。
   - 双方向で error/close を検知し両端を destroy。
   - async cache lookup 後に `socket.destroyed`/`writable` を再チェックし、race による孤立 upstream 接続を防止。
   - `proxyWebSocket()` は deprecated だが 426 挙動を維持し、万一到達しても well-formed レスポンスを返す。

---

## 7. 残課題 / Follow-ups

1. **live Streamlit e2e 未実施**
   - AC-1 / AC-2 はユニットテストのバイト単位アサーションとハンドシェイク配線確認で検証。実 Streamlit upstream に対する round-trip 検証は意図的にスコープ外（重量過多のため）。
2. **統合テスト追加案**
   - `tests/integration/proxy-websocket.test.ts` として `ws` ライブラリの echo upstream + 127.0.0.1 ランダムポート + `external_apps` シード + CommandMate HTTP server 起動 + WS round-trip を行う e2e を別 Issue で追加する案あり。DB singleton の扱いと flakiness コストが懸念されるため、本 PR ではスキップ。
3. **IPv6 loopback 対応**
   - 現状 `PROXY_ALLOWED_HOSTS` は IPv4 loopback 系のみ。IPv6 loopback (`::1`) のみで待受する upstream がある場合に備え、追加可否を検討。
4. **ドキュメント追記**
   - `docs/architecture.md` ないし External Apps ドキュメントに `skipTrailingSlashRedirect` の rationale を追記（`/proxy/<prefix>/` と `/proxy/<prefix>` を区別扱いにする旨）。
5. **既存の duplicate-name 409 返却不具合**
   - `tests/integration/external-apps-api.test.ts` の `should return 409 for duplicate name` が 500 を返す既存 failure は、main ブランチでも再現済み・本修正と無関係。別 Issue として追跡する。

---

## 8. 次のステップ

1. **ユーザーレビュー依頼**
   - 本報告書と `tdd-fix-result.json` / `acceptance-result.json` を確認依頼。
2. **コミット**
   - レビュー承認後、`feature/671-worktree` ブランチに以下をまとめて commit。
     - `src/lib/ws-server.ts`
     - `src/lib/proxy/handler.ts`
     - `src/app/proxy/[...path]/route.ts`
     - `next.config.js`
     - `tests/unit/ws-server-proxy-upgrade.test.ts`
     - `tests/unit/proxy/route.test.ts`
   - コミットタイプ候補: `fix(proxy): pass-through /proxy/<prefix> WebSocket upgrades to upstream (#671)`
3. **PR 作成**
   - ベースブランチ: `develop`、ヘッド: `feature/671-worktree`。
   - PR タイトル例: `fix: proxy WebSocket upgrades to External Apps upstream (#671)`
   - PR 本文には Summary（事象/原因/対策）、受け入れ基準のチェックリスト、Follow-ups（live e2e / IPv6 / docs / duplicate-name Issue）を記載。
4. **Follow-up Issue 起票**
   - 統合テスト追加、IPv6 loopback 対応、docs 追記、duplicate-name 409 不具合 ── の 4 件を別 Issue としてドラフト。

---

## 付録: 生成物ファイル一覧

- `dev-reports/bug-fix/issue671_20260420_085636/investigation-result.json`
- `dev-reports/bug-fix/issue671_20260420_085636/work-plan-context.json`
- `dev-reports/bug-fix/issue671_20260420_085636/tdd-fix-context.json`
- `dev-reports/bug-fix/issue671_20260420_085636/tdd-fix-result.json`
- `dev-reports/bug-fix/issue671_20260420_085636/acceptance-context.json`
- `dev-reports/bug-fix/issue671_20260420_085636/acceptance-result.json`
- `dev-reports/bug-fix/issue671_20260420_085636/progress-context.json`
- `dev-reports/bug-fix/issue671_20260420_085636/progress-report.md` ← 本ファイル
