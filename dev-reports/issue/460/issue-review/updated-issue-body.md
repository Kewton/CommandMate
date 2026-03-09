## Summary

現在の CommandMate は tmux を永続セッション基盤として活用しているが、ライブな terminal interaction は `send-keys` + `capture-pane` + polling + cache の積み上げで実現している。

この構成は detached session の維持には強い一方で、以下の問題がある。

- ライブ出力が snapshot 指向で、低レイテンシ更新に弱い
- TUI ツール対応がツール固有補償ロジックに流れやすい
- resize が transport の first-class event になっていない
- terminal page と worktree detail が別々の更新モデルを持ち、保守コストが高い

推奨方向は、**tmux を永続セッションバックエンドとして維持しつつ、`tmux control mode` をライブ入出力用 transport として段階導入すること**。

ただし、既存の polling / snapshot 経路は履歴取得・fallback・段階移行のため当面維持する。

## Problem

### 現在の技術的制約

1. `capture-pane` は snapshot API であり、イベントストリームではない
2. `response-poller.ts` は 2 秒ポーリング前提で、出力抽出と prompt 検出を transport 制約込みで実装している
3. `tmux-capture-cache.ts` は重複 capture 抑制には効くが、ライブ性自体は改善しない
4. OpenCode など TUI 指向ツール向けの補償が上位ロジックへ漏れている
5. browser terminal は専用の live transport を前提としているが、現行 app の WebSocket 契約と分離されており、統一された terminal transport になっていない

### 現在の関連モジュール

- `src/lib/tmux.ts`
  - `new-session`, `has-session`, `send-keys`, `capture-pane`, `kill-session`
- `src/lib/cli-session.ts`
  - capture と session existence check の高レベル窓口
- `src/lib/response-poller.ts`
  - 2 秒 polling、応答抽出、prompt 検出、OpenCode TUI accumulator
- `src/lib/tmux-capture-cache.ts`
  - `capture-pane` の TTL cache + singleflight
- `src/app/api/worktrees/[id]/current-output/route.ts`
  - worktree detail 向け snapshot 取得
- `src/app/api/worktrees/[id]/terminal/route.ts`
  - terminal input の send-keys 経路
- `src/lib/ws-server.ts`
  - 認証付き app WebSocket room 配信
- `src/components/Terminal.tsx`
  - browser terminal UI（現時点では app の標準 WebSocket 契約とは別系統）

## Goals

### 性能

- active terminal session の live output を polling ではなく event-driven にする
- terminal page の visible latency を削減する
- active terminal viewing 時の `capture-pane` 呼び出し回数を大幅に減らす

### 拡張性

- tmux transport を abstraction で分離し、snapshot path と streaming path を共存可能にする
- CLI tool 固有の TUI 補償を transport 側へ寄せ、上位ロジックの特例を減らす
- 将来の別 transport 実装や capability 差異を吸収できる構造にする

### セキュリティ

- control mode を server-side transport として閉じ込め、browser に tmux 制御面を露出しない
- 認証、worktree 境界、resource quota、idle cleanup を明示する
- 長寿命 stream に伴う DoS / resource leak / output handling リスクを制御する

### 保守性

- terminal page から段階導入し、main worktree detail は feature flag 配下で後続統合する
- dual-path 期間の fallback 条件と cleanup 条件を明確にする
- 計測・ログ・テスト戦略を先に定義して、長期的に polling path を縮退できる状態を作る

## Proposed Architecture

### 1. `SessionTransport` 抽象の導入

tmux の低レベル操作を直接アプリ全体に露出せず、snapshot transport と streaming transport を同じ境界で扱えるようにする。

```ts
interface SessionTransport {
  ensureSession(sessionName: string, cwd: string): Promise<void>;
  sessionExists(sessionName: string): Promise<boolean>;
  sendInput(sessionName: string, input: string): Promise<void>;
  sendSpecialKey(sessionName: string, key: string): Promise<void>;
  resize(sessionName: string, cols: number, rows: number): Promise<void>;
  captureSnapshot(sessionName: string, opts?: CaptureOptions): Promise<string>;
  subscribe(
    sessionName: string,
    handlers: TransportHandlers
  ): Promise<TransportSubscription>;
  getCapabilities(): TransportCapabilities;
  killSession(sessionName: string): Promise<boolean>;
}
```

補助型のイメージ:

```ts
interface TransportCapabilities {
  streamingOutput: boolean;
  explicitResize: boolean;
  snapshotFallback: boolean;
}

interface TransportHandlers {
  onOutput(data: string): void;
  onExit?(info: { exitCode?: number | null }): void;
  onError(error: Error): void;
}

interface TransportSubscription {
  unsubscribe(): Promise<void>;
}
```

### 2. `PollingTmuxTransport`

既存の `send-keys` / `capture-pane` / cache / polling をラップする。

- 初期段階ではユーザー可視の挙動を変えない
- 既存 route / poller の後方互換 transport として機能する
- control mode fallback 先として利用する

### 3. `ControlModeTmuxTransport`

- tmux control-mode client の起動と attach
- control mode イベントの parser
- session ごとの subscription registry
- resize / reconnect / unsubscribe lifecycle
- active viewer のみ streaming を有効化する resource 制御

想定コンポーネント:

- `TmuxControlClient`
- `TmuxControlParser`
- `TmuxControlRegistry`
- `ControlModeTmuxTransport`

### 4. app 側統合方針

- browser は tmux control stream を直接扱わない
- server 側で control mode を購読し、app の authenticated WebSocket / API 契約に変換して流す
- worktree detail は当面 snapshot を維持し、必要な箇所から段階的に event-driven 更新へ移す

## Migration Plan

### Phase 0: Transport seam の作成

- `SessionTransport` と capability 型を導入
- `tmux.ts` の直接利用箇所を棚卸しし、可能な範囲で `PollingTmuxTransport` 経由に寄せる
- cache invalidation と session lifecycle の責務境界を整理
- feature flag を追加する

成功基準:

- ユーザー可視の変更なし
- 既存 unit / integration test が維持される
- 新旧 transport を切り替え可能な構造になる

### Phase 1: server-side control-mode prototype

- `TmuxControlClient` / parser / registry を実装
- 単一 session で live output を受け取れる状態にする
- resize, disconnect, unsubscribe を扱えるようにする
- 開発用ログと最小限の metrics を入れる

成功基準:

- 1 session で polling なしの live output が確認できる
- control-mode subscription の開始 / 終了でプロセスや event listener がリークしない
- fallback で `PollingTmuxTransport` に戻せる

### Phase 2: terminal page 移行

- terminal page を control mode ベースに切り替える
- input / output / resize / reconnect を統一プロトコルで扱う
- terminal page の `capture-pane` 依存を除去する

成功基準:

- terminal page が pane polling に依存せず live 更新される
- resize が明示的に機能する
- TUI 操作で現行より表示忠実度が改善する

### Phase 3: worktree detail への限定統合

- worktree detail の active session view に live stream を導入
- session state 更新の一部を event-driven 化する
- 履歴・復旧・非表示状態では snapshot を維持する

成功基準:

- active viewing 中の `capture-pane` 呼び出しが削減される
- `response-poller.ts` / `current-output` 経路の特殊ケース補償を減らせる
- 非表示時や reconnect 時に fallback snapshot が機能する

### Phase 4: cleanup

- 不要になった TUI 補償ロジックと polling path を縮退
- 明確な価値がある snapshot fallback のみ残す
- metrics を見て feature flag を段階的に既定有効化する

成功基準:

- 特殊ケース parsing の削減
- session monitoring ロジックの単純化
- rollback 手順が不要になるまで新経路が安定

## Security Requirements

### 必須要件

- browser から tmux control mode へ直接接続しない
- 既存 auth / IP restriction の適用対象に乗せる
- worktree 単位の authorization を維持する
- session 単位で subscription 数、idle timeout、buffer 上限を持つ
- disconnect / unsubscribe / server shutdown 時に child process と listener を確実に cleanup する

### 実装上の注意

- control mode 出力は terminal rendering 用 raw stream と、status/prompt 判定用解析経路を分離する
- ログには tmux 生出力を安易に流さない
- backpressure を考慮し、遅い client に無制限バッファしない
- parser 異常時は fail-open ではなく snapshot fallback を優先する

## Risks and Mitigations

| リスク | 軽減策 |
|--------|--------|
| dual-path 期間が長引き、保守コストが逆に増える | feature flag と phase exit criteria を先に定義する |
| control-mode parser バグで表示不整合が出る | terminal page 限定で開始し、snapshot fallback を維持する |
| 長寿命 subscription によりメモリ・FD・CPU 使用量が増える | active viewer のみ有効化、idle timeout、自動 cleanup、接続数計測を入れる |
| worktree detail まで一気に拡張してスコープ膨張する | Phase 2 と Phase 3 を分離し、terminal page で先に価値検証する |
| CLI tool ごとの既存補償が新 transport と競合する | capability 判定と tool-specific fallback を明示し、段階的に削除する |

## Acceptance Criteria

- [ ] `SessionTransport` 抽象と `PollingTmuxTransport` が導入され、既存挙動が維持されている
- [ ] `ControlModeTmuxTransport` が少なくとも 1 session で live output を配信できる
- [ ] terminal page が control mode ベースで live 更新され、pane polling に依存しない
- [ ] resize が control-mode path で明示的にサポートされる
- [ ] auth / worktree boundary / idle cleanup / fallback が実装方針として明記されている
- [ ] active terminal viewing 中の `capture-pane` 呼び出し回数を計測できる
- [ ] snapshot fallback が残り、parser 異常時または unsupported path で利用できる
- [ ] phase ごとの rollback 手順または feature flag fallback が定義されている

## Validation

- [ ] unit test: parser, registry, subscription cleanup, capability fallback
- [ ] integration test: terminal page input/output/resize/reconnect
- [ ] integration test: auth 失敗、worktree 不一致、idle timeout cleanup
- [ ] manual verification: Codex / OpenCode の TUI 操作改善確認
- [ ] performance measurement: live latency、active viewing 中の `capture-pane` 回数、追加メモリ/接続数

## Out of Scope

- tmux を別 backend に置き換えること
- 履歴取得や非表示セッションの snapshot path を即座に全面廃止すること
- 全 CLI tool の特殊処理をこの issue 単体で完全撤去すること

## References

- 設計ドキュメント: `workspace/tmux-control-mode-design.md`
- 補足レビュー: `dev-reports/issue/460/issue-review/review-report.md`
