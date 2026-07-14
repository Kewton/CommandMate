# Issue #1120 設計書: ターミナル出力・セッションステータスのWebSocketストリーミング化

親Issue: #1110 / Phase 3（ライブ感）/ サイズ: L

## 目的

実装済みだが未接続の WebSocket インフラ（`src/lib/ws-server.ts`）をクライアントへ接続し、
ターミナル出力・セッションステータス・新着メッセージ・プロンプト検出を
**HTTP ポーリングからサーバ→クライアント push へ移行**する。ポーリングは削除せず
フォールバックとして残す。第1段階（本設計書）→第2段階（実装）を1 worktree で完遂する。

方針: **サーバ→クライアントの一方向 push 優先**。入力系（send / respond / resize）は既存 HTTP/WS API を維持する。

---

## 1. 配信プロトコル設計

### 1.1 接続と認証ハンドシェイク（既存機構踏襲）

- クライアントは同一オリジンへ `new WebSocket(ws(s)://window.location.host)` で接続する。
- 認証は **Cookie ベース**（Issue #331）。`cm_auth_token` は `path:'/'` same-origin のため、
  ブラウザが WS upgrade ハンドシェイクに自動付与する。クライアント側の明示的トークン処理は不要。
- サーバは `setupWebSocket()` の upgrade ハンドラで `isAuthEnabled()` 時に `verifyToken` 検証し、
  失敗時 `401` で upgrade を拒否する（既存実装）。**認証失敗時は接続が拒否される**（受入基準）。

### 1.2 room 購読モデル

- 既存の room = worktreeId。`{ type:'subscribe', worktreeId }` / `{ type:'unsubscribe', worktreeId }` を送る。
- クライアントは「表示中の worktree 群」を購読する。再接続時は購読集合を自動再送する。

### 1.3 メッセージ種別（サーバ→クライアント）

サーバの `broadcast()` / `broadcastMessage()` は **エンベロープで二重包装**する:

```
{ type:'broadcast', worktreeId, data: { type:'<realType>', worktreeId, ...payload } }
```

クライアントは常に `msg.data`（内側）を実ペイロードとして扱う。`data.type` が実種別。

| 実種別 (`data.type`)     | 追加/既存 | ペイロード                                                  | 用途                          |
|--------------------------|-----------|-------------------------------------------------------------|-------------------------------|
| `session_status_changed` | 既存(stop)+追加(start) | `{ worktreeId, isRunning, cliTool?, instance?, messagesCleared? }` | サイドバー状態ドット即時反映  |
| `message`                | 既存      | `{ worktreeId, message }`                                   | 新着メッセージ即時反映/バッジ |
| `message_updated`        | 既存      | `{ worktreeId, message }`                                   | プロンプト応答後の更新        |
| `terminal_output`        | 追加      | `{ worktreeId, cliToolId, instanceId, output, isRunning, thinking, isPromptWaiting, promptData?, isSelectionListActive, isPagerActive, isUnclassifiedActive, version }` | ターミナル出力ストリーミング  |
| `repository_deleted`     | 既存      | `{ repositoryPath, deletedWorktreeIds }`                    | リポジトリ削除通知            |

- `terminal_output` は既存の `/current-output` と同一の payload を **共有ビルダー**
  （`buildCurrentOutput()`）で生成する（DRY）。生成箇所は **応答ポーラ tick**
  （`response-poller-core.ts` の `scheduleNextResponsePoll`）で、生成中（=ストリーミングが
  最も効く区間）に worktree room へ push する。`version` は
  `(worktreeId,cliToolId,instance)` 毎の単調増加カウンタで、クライアントは古い version を破棄する。
- 出力本文は **ANSI エスケープ付き生テキスト**（既存 `/current-output` の `fullOutput` と同じ）。
  クライアントは従来通り `sanitizeTerminalOutput`（ansi-to-html + DOMPurify）で描画する。

---

## 2. フォールバック戦略

### 2.1 自動降格（WS 切断 → ポーリング復帰）

- クライアントは WS 接続状態（`connecting|connected|disconnected|error`）を単一の情報源として持つ。
- **接続中**: ターミナル/ステータスのポーリング間隔を「フォールバック値」に**大幅間引き**する。
  push が主経路。
- **切断/エラー**: 直ちに従来の active/idle 間隔へ**自動復帰**。push は来ないためポーリングが担う。
- push は既存ポーリングの状態機械へ流し込む（stale-response ガード・visibility 停止と同一の堅牢性を維持）。

| ループ                   | 通常間隔(接続なし)      | WS 接続中の間隔          |
|--------------------------|-------------------------|-------------------------|
| ターミナル (`useTerminalPanePolling`) | active 2s / idle 5s | 15s（フォールバック監視のみ） |
| ステータス (`useWorktreesCache`)      | active 5s / idle 30s | 20s / 60s              |

### 2.2 指数バックオフ再接続

- 再接続遅延 = `min(baseDelay * 2^attempt, maxDelay)`（base 1s, max 30s）。
- 成功時 attempt を 0 にリセット。上限到達後は maxDelay 間隔で継続試行。

### 2.3 visibilitychange 連携

- タブ非表示中は再接続タイマを停止（無駄な接続試行を避ける）。
- 再表示時に即時再接続を試み、購読集合を再送する。既存ポーリングの visibility 停止と整合。

### 2.4 堅牢性の等価維持

- ターミナル: push 適用にも requestId 相当の **version ガード**と cliTool/instance 一致判定を適用。
  古い/別 CLI 宛の push は破棄する（既存 stale-response ガードと同等）。
- 非表示中は push 適用を抑止せずステートのみ更新し、DOM スクロール副作用は既存ロジックに委ねる。

---

## 3. 差分適用戦略（テキスト選択の維持）

### 3.1 問題

現状 `TerminalDisplay` は毎回 `output` 全体を `dangerouslySetInnerHTML` で丸ごと置換するため、
選択中テキストが解除され、更新のたびにカクつく。

### 3.2 方式: 追記優先の差分適用

純粋関数 `computeTerminalUpdate(prev, next)` を導入する（`src/lib/terminal/terminal-diff.ts`）:

- **append**: `next` が `prev` を接頭辞として含む（末尾に追記された）場合、追記分のみを算出し
  `{ mode:'append', appended }` を返す。DOM は既存ノードを保持し、追記分の HTML を末尾へ付加する
  → 既存行の DOM が保持され、**選択が維持される**。
- **replace**: 差異が接頭辞一致でない（画面クリア・スクロールバック巻き戻し・TUI 再描画）場合は
  `{ mode:'replace' }` で全置換にフォールバックする。
- **noop**: `prev === next` は無変更。
- **ANSI 境界**: append 判定は ANSI エスケープを含む生文字列に対して行うが、追記分の HTML 化は
  「追記分のみ」ではなく **全体を再サニタイズして末尾差分を反映**する方針とし、途中で切れた
  ANSI シーケンス（例: `\x1b[` の直後で分割）を跨いでも色が壊れないようにする。
  すなわち DOM 上は「変化した末尾ブロックのみ再描画・先頭は保持」を近似する
  （実装は末尾 chunk を別ノードに分離し、append 時はそのノードのみ差し替える）。

### 3.3 単体テスト観点（受入基準）

- 追記（prefix 一致）→ `append`
- リセット（不一致 / 短縮 / クリア）→ `replace`
- ANSI 境界（エスケープ途中分割・複数行 SGR）で色が壊れない
- 空/同一入力の noop

---

## 4. 実装対象と分割

- クライアント: `useWebSocket`（再設計: 購読/バックオフ/visibility/dispatch/状態）、
  realtime 提供層、`useWorktreesCache` / `useTerminalPanePolling` の push 統合 + 間引き、
  `TerminalDisplay` の差分適用、接続状態インジケータ、モバイル新着バッジ push 復活。
- サーバ: `send` で start 時 `session_status_changed(isRunning:true)` を push、
  ポーラ完了時に stop を push、ポーラ tick で `terminal_output` を push、
  `buildCurrentOutput()` を route と共有。
- 対象外: xterm.js ページ、tmux トランスポート層、Assistant Chat のストリーミング化。

## 5. 受入基準トレーサビリティ

- WS 接続中はターミナル出力 API のポーリング頻度が低減 → §2.1 の間引き。
- WS 切断→ポーリング復帰→再接続 → §2.1/§2.2 + 統合テスト。
- 認証失敗で接続拒否 → §1.1（既存 upgrade 検証）+ テスト。
- useWebSocket 単体（購読/再接続/バックオフ）→ §1.2/§2.2。
- 差分適用単体（追記/リセット/ANSI 境界）→ §3.3。
