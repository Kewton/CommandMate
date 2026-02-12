# Issue #237 セキュリティレビュー (Stage 4)

| 項目 | 内容 |
|------|------|
| **Issue** | #237 未使用コードの削除・リファクタリング |
| **Stage** | 4 - セキュリティレビュー |
| **ステータス** | approved |
| **スコア** | 5/5 |
| **日付** | 2026-02-11 |
| **レビュー対象** | 設計方針書 + 削除対象5ファイル + 修正対象3ファイル |

---

## Executive Summary

Issue #237 は未使用コード（約1,900行、5ファイル）の削除を行うリファクタリングであり、機能追加を含まない。セキュリティ観点での評価の結果、本変更はセキュリティリスクを**増大させず、むしろ改善する**ことが確認された。

削除対象コードには以下の潜在的セキュリティ弱点が存在していたが、いずれもデッドコードであるため実際のリスクはなかった。削除により、これらが将来誤って利用されるリスクが完全に除去される。

- `terminal-websocket.ts`: 未認証WebSocket接続、ハードコードパス、入力サニタイズ欠如
- `claude-poller.ts`: stripAnsi()未適用のプロンプト検出パス

**結論: セキュリティ上の懸念事項なし。承認。**

---

## OWASP Top 10 準拠チェック

### A01: Broken Access Control（アクセス制御の不備）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | 削除対象に認証・認可ロジックは含まれない |

`terminal-websocket.ts` にはWebSocket接続時のOriginチェックや認証トークン検証が存在しなかったが（L31-46）、このモジュールは完全なデッドコード（コードベース内で一度もimportされていない）であり、実際にはリクエストを受け付ける状態になかった。削除により将来の誤用リスクが除去される。

### A02: Cryptographic Failures（暗号化の不備）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | 削除対象に暗号化処理や機密データの直接的な取り扱いは含まれない |

### A03: Injection（インジェクション）

| 項目 | 評価 |
|------|------|
| 影響 | 正の影響（改善） |
| 詳細 | 潜在的なコマンドインジェクション経路およびANSIエスケープ未処理パスが除去される |

**terminal-websocket.ts の sendToTmux() 関数（L169-186）:**

```typescript
// L171: ユーザー入力が直接 spawn の引数として渡される
const tmuxSend = spawn('tmux', ['send-keys', '-t', sessionName, input]);
```

`spawn()` の配列引数形式により、シェルインジェクションのリスクは軽減されているが、`input` パラメータのサニタイズが行われていない。また、`worktreeId` と `cliToolId` がURLパスから無検証で取得されていた（L48-49）。

**claude-poller.ts の detectPrompt() 呼び出し（L162-176, L234-236）:**

```typescript
// L162-163 のTODOコメント
// TODO [Issue #193]: This code path is unreachable...
// apply stripAnsi() + buildDetectPromptOptions() here.
```

`stripAnsi()` が適用されていないため、ANSIエスケープシーケンスを含む入力による誤検出の可能性があった。response-poller.ts ではL33で `stripAnsi` が正しくimportされ適用されている。

いずれもデッドコードのため実害はなかったが、削除は防御的に正しい。

### A04: Insecure Design（安全でない設計）

| 項目 | 評価 |
|------|------|
| 影響 | 正の影響（改善） |
| 詳細 | 攻撃対象面（Attack Surface）の縮小 |

未使用コードの削除はセキュアデザインの原則に合致する。約1,900行のデッドコード削除により：
- コードベースの監査対象が縮小
- セキュリティレビューの効率が向上
- `/worktrees/[id]/simple-terminal` ルートが消滅し、不要なエンドポイントが除去

### A05: Security Misconfiguration（セキュリティ設定の不備）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | 設定ファイルへの変更なし |

`tsconfig.json`, `next.config.js`, `vitest.config` 等のセキュリティ関連設定は影響を受けない。

### A06: Vulnerable and Outdated Components（脆弱なコンポーネント）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | 依存ライブラリの追加・削除は発生しない |

`terminal-websocket.ts` は `ws` ライブラリをimportしていたが、他のモジュール（`ws-server.ts` 等）も `ws` を使用しているため、当該ファイル削除後も依存関係に変更はない。

### A07: Identification and Authentication Failures（認証の不備）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | 削除対象に認証機構は含まれない |

### A08: Software and Data Integrity Failures（データ整合性の不備）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | データ整合性への影響なし |

`claude-poller.ts` は `createMessage()`, `updateSessionState()`, `getWorktreeById()` 等のDB操作関数を呼び出していたが、これらはデッドコードパスにある。`response-poller.ts` が同等のDB操作を正しく実行しており、削除による影響はない。

### A09: Security Logging and Monitoring Failures（セキュリティログの不備）

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | 実際に機能しているログ出力への影響なし |

削除対象の `console.log/warn/error` 呼び出しは全てデッドコードパスにある。`session-cleanup.ts` と `manager.ts` の修正は claude-poller 関連のログ出力削除のみであり、`response-poller` と `auto-yes-poller` のログは維持される。

### A10: Server-Side Request Forgery (SSRF)

| 項目 | 評価 |
|------|------|
| 影響 | なし |
| 詳細 | サーバーサイドHTTPリクエストの発行なし |

`SimpleTerminal.tsx` の `fetch()` 呼び出しはクライアントサイド（`'use client'` ディレクティブ）であり、SSRFリスクには該当しない。

---

## 削除に伴うセキュリティリスク評価

### 削除対象コードの既知セキュリティ弱点

| ファイル | 弱点 | 実際のリスク | 削除による影響 |
|---------|------|-------------|---------------|
| `terminal-websocket.ts` L200 | ハードコードされたユーザーホームパス (`/Users/maenokota/...`) | なし（デッドコード） | 除去（改善） |
| `terminal-websocket.ts` L31-46 | WebSocket接続に認証なし | なし（デッドコード） | 除去（改善） |
| `terminal-websocket.ts` L169-186 | `sendToTmux()` で入力サニタイズなし | なし（デッドコード） | 除去（改善） |
| `terminal-websocket.ts` L48-49 | URLパスからの入力バリデーションなし | なし（デッドコード） | 除去（改善） |
| `claude-poller.ts` L162-176, L234-236 | `stripAnsi()` 未適用のプロンプト検出 | なし（デッドコード） | 除去（改善） |

### 削除により新たに生じるセキュリティホール

**なし。** 全削除対象は未使用コードであり、削除により新たなセキュリティホールは発生しない。後継実装（`response-poller.ts`, `WorktreeDetailRefactored.tsx`, xterm.jsベースTerminal）が稼働中であり、セキュリティ機能の欠落は生じない。

---

## データ保護評価

| 項目 | 評価 | 詳細 |
|------|------|------|
| 機密情報の漏洩リスク | なし | 削除対象に機密情報の直接的な取り扱いはない |
| ハードコードされた情報 | 改善 | `terminal-websocket.ts` L200のローカルパス情報が除去される |
| 個人情報の取り扱い | 影響なし | 削除対象に個人情報の処理は含まれない |
| DB操作 | 影響なし | `claude-poller.ts` のDB操作はデッドコードパス。`response-poller.ts` が正しく実行中 |

---

## リスク評価サマリー

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティリスク増大 | 該当なし | - | - | - |
| 攻撃対象面の縮小 | 約1,900行の除去、ルート1件の消滅 | Low (Positive) | High | - |
| 潜在的弱点の除去 | terminal-websocket.ts, claude-poller.ts の弱点除去 | Low (Positive) | High | - |

---

## 改善提案

### 必須改善項目 (Must Fix)

なし。

### 推奨改善項目 (Should Fix)

なし。

### 検討事項 (Consider)

| ID | カテゴリ | 内容 | 推奨対応 |
|----|---------|------|---------|
| CS-008 | セキュリティ改善 | `terminal-websocket.ts` 削除により潜在的弱点（未認証WebSocket、ハードコードパス、入力サニタイズ欠如）が除去される | 追加対応不要。削除により改善される |
| CS-009 | セキュリティ改善 | `claude-poller.ts` 削除により `stripAnsi()` 未適用のプロンプト検出パスが除去される | 追加対応不要。削除により改善される |

---

## Stage 1-4 レビュー総括

| Stage | レビュー名 | スコア | ステータス | Must Fix | Should Fix | Consider |
|-------|-----------|--------|-----------|----------|------------|----------|
| 1 | 設計原則レビュー | 4/5 | conditionally_approved | 1 (反映済み) | 2 (反映済み) | 2 |
| 2 | 整合性レビュー | 5/5 | approved | 0 | 0 | 2 |
| 3 | 影響分析レビュー | 5/5 | approved | 0 | 0 | 3 |
| 4 | セキュリティレビュー | 5/5 | approved | 0 | 0 | 2 |

**全4段階レビュー完了。セキュリティ上の懸念事項なし。実装を推奨する。**

---

*Generated by architecture-review-agent for Issue #237*
*Stage 4: Security Review*
*Date: 2026-02-11*
