# 作業計画書: Issue #460

## Issue 概要

**タイトル**: feat: introduce tmux control mode transport for live terminal interaction
**Issue番号**: #460
**サイズ**: L
**優先度**: High
**依存Issue**: なし
**前提資料**:

- `dev-reports/issue/460/design-policy.md`
- `dev-reports/issue/460/design-review.md`
- `dev-reports/issue/460/issue-review/updated-issue-body.md`

### 目標

tmux を永続セッション backend として維持しつつ、terminal page の live interaction を `capture-pane` + polling 依存から段階的に切り離し、server-side の `tmux control mode` transport を導入する。

### 実装方針要約

1. `SessionTransport` abstraction を導入する
2. `PollingTmuxTransport` で既存挙動を保持する
3. `ControlModeTmuxTransport` を server-side gateway 経由で terminal page に適用する
4. worktree detail は即時全面移行せず、snapshot path を維持する
5. feature flag, snapshot fallback, idle cleanup, metrics を先に整える

## 最終状況

更新日: 2026-03-09

- 完了:
  - Phase 0 の事前整理ドキュメント作成
  - Phase 1 の `SessionTransport` / `PollingTmuxTransport` 導入
  - Phase 2 の control mode client / parser / registry / transport 実装
  - Phase 3 の terminal gateway 基本配線
  - Phase 3 の resource control と basic metrics 実装
  - Phase 4 の `Terminal.tsx` 接続先切り替えと feature flag 表示の初期実装
  - Phase 5 の互換性確認ドキュメント作成
  - targeted unit test, `npx tsc --noEmit`, `npm run lint` の通過
- 進行中:
  - integration test の失敗要因切り分け
- 未完了:
  - 実機 manual verification
- 検証状況:
  - `npm ci --include=dev` 実施済み
  - targeted unit test, `npx tsc --noEmit`, `npm run lint` は通過
  - `npm run test:integration` は実行可能化済み
  - integration suite は issue #460 以外の既存 failure 33件で失敗
  - `tests/integration/websocket.test.ts` は sandbox の `listen EPERM` により実行不可
  - `tsx` を使った追加確認は sandbox の IPC 制約により未実施
  - manual verification 記録は `dev-reports/issue/460/manual-verification.md` に作成済み
  - integration failure の切り分けは `dev-reports/issue/460/integration-failures.md` に記録済み

---

## 詳細タスク分解

### Phase 0: 事前整理・設計確定

Status: 完了

- [x] **Task 0.1**: `tmux.ts` 直接利用箇所の棚卸し
  - 成果物: `dev-reports/issue/460/tmux-callsite-inventory.md`
  - 内容:
    - `tmux.ts` import 箇所を列挙
    - `SessionTransport` 経由へ置換対象と保留対象を分類
    - `response-poller.ts`, `current-output`, `terminal/route.ts`, CLI tool 固有処理の依存を整理
  - 依存: なし

- [x] **Task 0.2**: terminal gateway 実装位置の確定
  - 成果物: `dev-reports/issue/460/gateway-decision.md`
  - 内容:
    - `ws-server.ts` 拡張案と専用 gateway 案を比較
    - 認証、権限制御、接続管理、既存利用箇所への影響を整理
    - 採用案を明記
  - 依存: なし

- [x] **Task 0.3**: feature flag 方針の確定
  - 成果物: `dev-reports/issue/460/feature-flag-plan.md`
  - 内容:
    - flag 名
    - デフォルト値
    - terminal page 限定有効化の条件
    - rollback 条件
  - 依存: なし

- [x] **Task 0.4**: Phase 0 レビュー
  - 内容:
    - 棚卸し・gateway 方針・flag 方針の整合確認
    - worktree detail を直ちに streaming 化しないことを再確認
  - 依存: Task 0.1, 0.2, 0.3

### Phase 1: transport abstraction 導入

Status: 完了

- [x] **Task 1.1**: `SessionTransport` 型定義追加
  - 成果物: `src/lib/session-transport.ts`
  - 内容:
    - `SessionTransport`
    - `TransportCapabilities`
    - `TransportHandlers`
    - `TransportSubscription`
    - `CaptureOptions`
  - 依存: Task 0.4

- [x] **Task 1.2**: `PollingTmuxTransport` 実装
  - 成果物: `src/lib/transports/polling-tmux-transport.ts`
  - 内容:
    - 既存 `tmux.ts` / `tmux-capture-cache.ts` をラップ
    - capability は `streamingOutput=false`, `explicitResize=false`, `snapshotFallback=true`
    - 後方互換 transport として機能させる
  - 依存: Task 1.1

- [x] **Task 1.3**: transport selector / facade 追加
  - 成果物: `src/lib/cli-session.ts` または新規 selector モジュール
  - 内容:
    - transport 取得窓口の追加
    - 既存 capture / session existence 呼び出しを polling transport 経由へ集約
  - 依存: Task 1.2

- [x] **Task 1.4**: Phase 1 テスト追加
  - 成果物: `tests/unit/lib/...`
  - 内容:
    - transport interface の basic contract
    - polling transport capability
    - fallback path の後方互換性
  - 依存: Task 1.2, 1.3

### Phase 2: control-mode infrastructure 実装

Status: 完了

- [x] **Task 2.1**: `TmuxControlClient` 実装
  - 成果物: `src/lib/tmux-control-client.ts`
  - 内容:
    - tmux control mode subprocess 起動
    - stdout/stderr/event emitter 管理
    - close / kill / cleanup
  - 依存: Task 1.3

- [x] **Task 2.2**: `TmuxControlParser` 実装
  - 成果物: `src/lib/tmux-control-parser.ts`
  - 内容:
    - control mode 出力の event 化
    - output / exit / error 相当イベントの抽出
    - parser 異常時の safe failure
  - 依存: Task 2.1

- [x] **Task 2.3**: `TmuxControlRegistry` 実装
  - 成果物: `src/lib/tmux-control-registry.ts`
  - 内容:
    - sessionName 単位の client 共有
    - subscriber 管理
    - idle timeout
    - shutdown cleanup
  - 依存: Task 2.1, 2.2

- [x] **Task 2.4**: `ControlModeTmuxTransport` 実装
  - 成果物: `src/lib/transports/control-mode-tmux-transport.ts`
  - 内容:
    - `SessionTransport` 実装
    - capability は `streamingOutput=true`, `explicitResize=true`, `snapshotFallback=true`
    - parser 異常時の snapshot fallback 方針を実装
  - 依存: Task 2.3

- [x] **Task 2.5**: Phase 2 テスト追加
  - 成果物: `tests/unit/lib/...`
  - 内容:
    - parser fixture test
    - registry subscribe/unsubscribe
    - idle cleanup
    - transport capability / fallback
  - 依存: Task 2.2, 2.3, 2.4

### Phase 3: terminal gateway 実装

Status: 進行中

- [x] **Task 3.1**: terminal stream gateway 実装
  - 成果物: 新規 API / WebSocket gateway
  - 内容:
    - authenticated subscribe
    - worktree boundary check
    - input / resize / unsubscribe handling
    - browser へ stream event 配信
  - 依存: Task 0.2, 2.4

- [x] **Task 3.2**: input validation / resource control 実装
  - 成果物: gateway 実装内
  - 内容:
    - payload length 上限
    - resize 値 validation
    - subscriber 上限
    - idle timeout enforcement
  - 依存: Task 3.1

- [x] **Task 3.3**: metrics / observability 実装
  - 成果物: gateway / registry / transport 周辺
  - 内容:
    - `capture-pane` 呼び出し回数
    - active control sessions
    - subscriber count
    - cleanup 回数
    - 最初の出力までの時間
  - 依存: Task 3.1

- [x] **Task 3.4**: gateway テスト追加
  - 成果物: `tests/unit` または `tests/integration`
  - 内容:
    - unauthorized subscribe 拒否
    - invalid worktree 拒否
    - disconnect cleanup
    - parser 異常時 fallback
  - 現状:
    - subscriber 上限、payload length、first output latency の unit test は追加済み
    - unauthorized subscribe、invalid worktree、disconnect cleanup、parser fallback の unit test は追加済み
  - 依存: Task 3.1, 3.2

### Phase 4: terminal page 移行

Status: 進行中

- [x] **Task 4.1**: `src/components/Terminal.tsx` の接続方式変更
  - 成果物: `src/components/Terminal.tsx`
  - 内容:
    - 既存の `ws://localhost:3000/terminal/...` 直結前提を廃止
    - app の authenticated terminal gateway へ接続
    - input / resize / reconnect を新契約に合わせる
  - 依存: Task 3.1

- [x] **Task 4.2**: terminal page の feature flag 対応
  - 成果物: `src/app/worktrees/[id]/terminal/page.tsx` 周辺
  - 内容:
    - control mode 有効時のみ新経路使用
    - 無効時は既存 polling / fallback 経路へ戻せるようにする
  - 依存: Task 0.3, 4.1

- [x] **Task 4.3**: terminal page UI 調整
  - 成果物: `src/components/Terminal.tsx`, 関連 UI
  - 内容:
    - connection status
    - fallback status 表示
    - reconnect 時の UX 調整
  - 依存: Task 4.1

- [x] **Task 4.4**: terminal page integration test
  - 成果物: `tests/integration` または `tests/unit/components`
  - 内容:
    - input/output
    - resize
    - reconnect
    - fallback
  - 現状:
    - `tests/unit/components/TerminalPage.test.tsx` に page の flag/fallback 表示確認を追加済み
    - `tests/unit/components/TerminalComponent.test.tsx` に disabled/connect/quick command/input forwarding/resize/error/disconnected/reconnect の component test を追加済み
  - 依存: Task 4.1, 4.2, 4.3

### Phase 5: 後方互換性確認と限定統合準備

Status: 完了

- [x] **Task 5.1**: `current-output` / `response-poller` 影響確認
  - 成果物: `dev-reports/issue/460/compatibility-check.md`
  - 内容:
    - 現行 snapshot path が壊れていないことを確認
    - worktree detail が未移行でも成立することを確認
  - 依存: Task 4.4

- [x] **Task 5.2**: worktree detail 統合用フォローアップ整理
  - 成果物: `dev-reports/issue/460/follow-up-notes.md`
  - 内容:
    - active session view への限定統合条件
    - 残る polling 依存箇所
    - 将来削除候補の特殊ケース処理
  - 依存: Task 5.1

### Phase 6: 品質確認

Status: 進行中

- [x] **Task 6.1**: targeted unit test 実行
  - コマンド候補:
    - `npm run test:unit -- tests/unit/lib/...`
    - `npm run test:unit -- tests/unit/components/...`
  - 現状:
    - `npx vitest run tests/unit/lib/polling-tmux-transport.test.ts tests/unit/lib/control-mode-tmux-transport.test.ts tests/unit/lib/tmux-control-mode-metrics.test.ts tests/unit/lib/ws-server-terminal.test.ts` は通過
    - `npx vitest run tests/unit/components/TerminalPage.test.tsx tests/unit/components/TerminalComponent.test.tsx` は通過
  - 依存: Phase 1-5 完了

- [ ] **Task 6.2**: integration test 実行
  - コマンド候補:
    - `npm run test:integration`
  - 現状:
    - `tests/integration/worktree-detail-integration.test.tsx` は通過
    - suite 全体は既存 failure 33件で失敗
    - `tests/integration/websocket.test.ts` は sandbox の `listen EPERM` で失敗
    - `tests/integration/api-hooks.test.ts`, `tests/integration/api-kill-session-cli-tool.test.ts`, `tests/integration/api-messages.test.ts`, `tests/integration/issue-208-acceptance.test.ts`, `tests/integration/trust-dialog-auto-response.test.ts` など issue #460 非依存の failure が残る
  - 依存: Task 6.1

- [x] **Task 6.3**: lint / typecheck 実行
  - コマンド候補:
    - `npm run lint`
    - `npx tsc --noEmit`
  - 現状:
    - `npm run lint` 通過
    - `npx tsc --noEmit` 通過
  - 依存: Task 6.2

- [ ] **Task 6.4**: performance / manual verification
  - 内容:
    - live latency
    - active viewing 時の `capture-pane` 呼び出し回数
    - Codex / OpenCode TUI 操作確認
  - 現状:
    - automated evidence と sandbox 制約は `dev-reports/issue/460/manual-verification.md` に記録済み
    - 実ブラウザ + tmux 実機での確認は未実施
  - 依存: Task 6.3

---

## タスク依存関係

```mermaid
graph TD
    P01["Task 0.1<br/>callsite 棚卸し"] --> P04["Task 0.4<br/>Phase 0 review"]
    P02["Task 0.2<br/>gateway 方針"] --> P04
    P03["Task 0.3<br/>flag 方針"] --> P04

    P04 --> T11["Task 1.1<br/>SessionTransport"]
    T11 --> T12["Task 1.2<br/>PollingTransport"]
    T12 --> T13["Task 1.3<br/>selector"]
    T13 --> T14["Task 1.4<br/>Phase 1 tests"]

    T13 --> C21["Task 2.1<br/>ControlClient"]
    C21 --> C22["Task 2.2<br/>Parser"]
    C21 --> C23["Task 2.3<br/>Registry"]
    C22 --> C24["Task 2.4<br/>ControlTransport"]
    C23 --> C24
    C24 --> C25["Task 2.5<br/>Phase 2 tests"]

    P02 --> G31["Task 3.1<br/>gateway 実装"]
    C24 --> G31
    G31 --> G32["Task 3.2<br/>validation/resource control"]
    G31 --> G33["Task 3.3<br/>metrics"]
    G32 --> G34["Task 3.4<br/>gateway tests"]

    G31 --> U41["Task 4.1<br/>Terminal.tsx 移行"]
    P03 --> U42["Task 4.2<br/>feature flag"]
    U41 --> U42
    U41 --> U43["Task 4.3<br/>UI調整"]
    U42 --> U44["Task 4.4<br/>integration test"]
    U43 --> U44

    U44 --> K51["Task 5.1<br/>互換性確認"]
    K51 --> K52["Task 5.2<br/>follow-up整理"]

    K52 --> Q61["Task 6.1<br/>unit test"]
    Q61 --> Q62["Task 6.2<br/>integration test"]
    Q62 --> Q63["Task 6.3<br/>lint/typecheck"]
    Q63 --> Q64["Task 6.4<br/>manual/perf verification"]
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| TypeScript | `npx tsc --noEmit` | 型エラー 0件 |
| ESLint | `npm run lint` | エラー 0件 |
| Unit Test | `npm run test:unit` | 関連テスト全パス |
| Integration Test | `npm run test:integration` | 関連ケース全パス |
| Manual Verification | 手動 | terminal page の live input/output/resize/reconnect/fallback が成立 |

---

## 成果物チェックリスト

### ドキュメント

- [x] `dev-reports/issue/460/tmux-callsite-inventory.md`
- [x] `dev-reports/issue/460/gateway-decision.md`
- [x] `dev-reports/issue/460/feature-flag-plan.md`
- [x] `dev-reports/issue/460/compatibility-check.md`
- [x] `dev-reports/issue/460/follow-up-notes.md`
- [x] `dev-reports/issue/460/manual-verification.md`
- [x] `dev-reports/issue/460/integration-failures.md`

### コード

- [x] `src/lib/session-transport.ts`
- [x] `src/lib/transports/polling-tmux-transport.ts`
- [x] `src/lib/transports/control-mode-tmux-transport.ts`
- [x] `src/lib/tmux-control-client.ts`
- [x] `src/lib/tmux-control-parser.ts`
- [x] `src/lib/tmux-control-registry.ts`
- [x] terminal stream gateway 実装
- [x] `src/components/Terminal.tsx`

### テスト

- [x] transport unit tests
- [x] parser / registry unit tests
- [x] gateway tests
- [x] terminal page component tests
- [x] worktree detail integration tests
- [ ] terminal page manual verification

---

## 実装上の注意事項

1. **スコープ膨張防止**: terminal page を先行対象とし、worktree detail の全面移行は行わない
2. **認証境界維持**: browser から tmux control mode へ直接接続させない
3. **後方互換性**: `PollingTmuxTransport` を先に成立させ、既存 snapshot path を壊さない
4. **リーク対策**: subscriber 0 件時の idle cleanup、server shutdown cleanup を最優先で実装する
5. **性能評価**: 「速く感じる」ではなく `capture-pane` 回数、live latency、active session 数で評価する
6. **ログ方針**: raw output を無制限にログへ流さない
7. **fallback**: parser 異常時は fail-open ではなく snapshot fallback を使う

---

## Definition of Done

- [x] Phase 0 の方針確定ドキュメントが作成済み
- [x] `SessionTransport` と `PollingTmuxTransport` が導入されている
- [x] `ControlModeTmuxTransport` と registry / parser / client が実装されている
- [x] terminal page が feature flag 配下で control mode を使える
- [ ] terminal page で input/output/resize/reconnect/fallback が確認できる
  - automated test では確認済み、実機確認は未完了
- [x] auth / worktree boundary / resource control が実装されている
- [x] snapshot path の後方互換性が確認されている
- [x] lint / typecheck / 関連テストがパスしている
- [x] performance / manual verification の記録が残っている

---

## 次のアクション

1. ブラウザ + tmux 実環境で manual verification を完了する
2. integration の既存 failure を別 issue として切り出す
