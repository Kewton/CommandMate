# Issue #460 設計レビュー

対象: `dev-reports/issue/460/design-policy.md`

## 総評

設計方針は、性能・拡張性・セキュリティ・保守性の4観点で、issue 本文より実装可能な粒度まで具体化できています。特に `SessionTransport` の capability 化、server-side gateway の明示、dual-path の段階導入、feature flag rollback を先に定義した点は妥当です。

大きな設計破綻はありません。実装着手可能です。

## レビュー結果

### 性能

- `capture-pane` 削減を terminal page と worktree detail で分けて記述しており、過大な期待を避けられています。
- registry による session 単位共有を前提にしており、多重 viewer で subprocess が増殖する設計を避けています。
- 一方で、全体 polling ゼロを目標にしていない点も現実的です。`response-poller.ts` と `current-output` を残す判断は妥当です。

判定: 妥当

### 拡張性

- `SessionTransport` が `getCapabilities()` を持つため、polling transport と streaming transport の差異を吸収しやすいです。
- `TmuxControlClient` / parser / registry / transport の責務分離も妥当です。
- transport abstraction を経由せず `tmux.ts` 直接参照が残ると崩れるため、Phase 0 の棚卸しは実装時の必須項目です。

判定: 妥当。ただし Phase 0 の徹底が前提

### セキュリティ

- browser から tmux control mode へ直接接続しない方針は必須であり、設計書で明示されたのは良いです。
- auth / worktree boundary / idle timeout / subscriber 上限 / backpressure を事前要件にした点も適切です。
- parser 異常時に fail-open せず snapshot fallback を優先する判断も安全です。

残留リスク:

- terminal 専用 gateway を `ws-server.ts` へ統合するか、別経路にするかで認証実装の重複リスクがあります
- raw output の取り扱いはログだけでなく metrics / debug tooling にも漏れないよう運用側で注意が必要です

判定: 妥当

### 保守性

- terminal page と worktree detail を別フェーズに切った点は正しいです。
- dual-path の期間・役割分担・rollback 条件が設計書にあるため、長期的な二重運用リスクを抑えられます。
- 受入条件に metrics と fallback を入れているため、「動くが縮退できない」状態を避けやすいです。

判定: 妥当

## 最終判断

- Must Fix: なし
- Should Fix: なし
- Nice to Have:
  - terminal 専用 gateway を `ws-server.ts` 拡張で行うか別モジュールで行うかを work plan で早めに確定する
  - control mode parser の入力例フィクスチャを Phase 1 の時点で先に用意する

## 実装着手条件

以下を満たせば実装着手可能です。

- Phase 0 で `tmux.ts` 直接利用箇所の一覧化
- terminal gateway の認証実装方針の確定
- feature flag 名とデフォルト値の確定
