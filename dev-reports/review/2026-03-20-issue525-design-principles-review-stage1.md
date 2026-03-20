# Issue #525 設計原則レビュー (Stage 1: 通常レビュー)

## Executive Summary

Issue #525「Auto-Yesエージェント毎独立制御」の設計方針書に対して、SOLID/KISS/YAGNI/DRY 準拠の観点からレビューを実施した。

全体として、既存アーキテクチャの `Map<string, State>` パターンを維持しつつ、文字列複合キーで拡張する設計方針は堅実であり、大規模なリファクタリングを回避しながら目的を達成する実用的なアプローチである。設計原則への準拠度は高いが、1件の必須改善項目と3件の推奨改善項目を検出した。

**Status**: conditionally_approved
**Score**: 4/5

---

## 設計原則チェックリスト

### SOLID 原則

#### Single Responsibility Principle (SRP)

- [x] auto-yes-state.ts: 状態管理の責務を維持 -- 合格
- [x] auto-yes-poller.ts: ポーリングロジックの責務を維持 -- 合格
- [!] 複合キーヘルパー関数の配置 -- 軽微な懸念 (SF-003)

`buildCompositeKey` / `extractWorktreeId` / `extractCliToolId` は状態管理に限定されないユーティリティ関数だが、auto-yes-state.ts に配置される設計。auto-yes-poller.ts、session-cleanup.ts、resource-cleanup.ts からも参照されるため、厳密には SRP から逸脱する。ただし、現在のファイルサイズ（約350行）を考慮すると、分離のオーバーヘッドと利益のバランスで許容範囲内。

#### Open/Closed Principle (OCP)

- [x] 既存 AutoYesState インターフェースは変更なし -- 合格
- [x] 新規ヘルパー関数による拡張アプローチ -- 合格
- [!] 複合キー形式の拡張性 -- 軽微な懸念 (SF-002)

キー区切り文字 `:` がハードコーディングされている点は、将来の拡張時に変更箇所が分散するリスクがある。定数化は容易だが YAGNI との兼ね合いでトレードオフ。

#### Liskov Substitution Principle (LSP)

- [x] インターフェース互換性維持 -- 合格

AutoYesState インターフェースに変更はなく、既存の利用パターンが壊れない設計。

#### Interface Segregation Principle (ISP)

- [x] 関数シグネチャの粒度が適切 -- 合格

byWorktree ヘルパー群（一括操作）と compositeKey ベース関数（個別操作）を分離しており、呼び出し元が必要な粒度の関数だけを使用できる。

#### Dependency Inversion Principle (DIP)

- [x] 依存方向が一貫 -- 合格

`auto-yes-poller.ts -> auto-yes-state.ts` の一方向依存が維持されており、循環依存のリスクはない。

### KISS 原則

- [x] 文字列複合キーによるシンプルな拡張 -- 合格

ネスト Map (`Map<string, Map<string, State>>`) を不採用とし、既存の `Map<string, State>` パターンを維持した判断は KISS に適合。globalThis パターンとの整合性も保たれる。

- [!] GET API の二重レスポンス形式 -- 軽微な懸念 (C-003)

cliToolId パラメータの有無でレスポンス型が変わる設計は、クライアント側に型分岐を強いる。統一的なマップ形式の方がシンプルだが、後方互換性を考慮した現設計も妥当な判断。

- [!] 関数名と返り値のセマンティクス不一致 -- 軽微な懸念 (C-001)

`getAutoYesStateWorktreeIds()` が複合キー配列を返す変更は、関数名から期待される動作と異なり、認知的複雑性を増加させる。

### YAGNI 原則

- [x] DB永続化を不採用（スコープ外として明確に除外） -- 合格
- [x] ネスト Map を不採用（過度な構造化の回避） -- 合格
- [!] getLatestServerResponseTimestampForWorktree -- 軽微な懸念 (C-002)

設計書内に具体的な使用箇所が明示されていない。実装フェーズで必要性を再評価すべき。

### DRY 原則

- [x] buildCompositeKey による一元的なキー生成 -- 合格
- [!] byWorktree フィルタリングパターンの重複 -- 推奨改善 (SF-001)

auto-yes-state.ts と auto-yes-poller.ts の両方で `keys().filter(key => extractWorktreeId(key) === worktreeId)` パターンが出現する。

---

## 設計パターンの適切性評価

| パターン | 評価 | コメント |
|---------|------|---------|
| Composite Key パターン | 適切 | 文字列結合によるキー複合化は Map ベースのインメモリストアで広く使われるパターン |
| Barrel File パターン | 適切 | auto-yes-manager.ts による re-export は後方互換を保証 |
| Facade パターン (session-cleanup) | 適切 | byWorktree ヘルパーの利用でクリーンアップの明示性を維持 |
| globalThis 永続化パターン | 適切 | Hot reload 耐性の既存パターンを維持 |
| Gateway バリデーション | 要確認 (MF-001) | compositeKey 化に伴うバリデーション戦略の再設計が必要 |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | deleteAutoYesState のバリデーション欠落 | Medium | High | P1 (MF-001) |
| 技術的リスク | byWorktree フィルタリングの DRY 違反 | Low | High | P2 (SF-001) |
| 技術的リスク | 関数名セマンティクス不一致による誤用 | Low | Medium | P3 (C-001) |
| セキュリティ | compositeKey に対するバリデーション未定義 | Medium | Medium | P1 (MF-001) |
| 運用リスク | barrel ファイル更新漏れ | Low | Medium | P3 (C-004) |

---

## 必須改善項目 (Must Fix)

### MF-001: deleteAutoYesState の責務変更によるセキュリティバリデーション欠落リスク

**原則**: SRP / セキュリティ
**影響箇所**: auto-yes-state.ts `deleteAutoYesState`

現行実装:
```typescript
export function deleteAutoYesState(worktreeId: string): boolean {
  if (!isValidWorktreeId(worktreeId)) {
    return false;
  }
  autoYesStates.delete(worktreeId);
  return true;
}
```

設計書では引数を `compositeKey` に変更するが、compositeKey (`worktreeId:cliToolId`) は `isValidWorktreeId()` の正規表現（英数字+ハイフン）にマッチしない。バリデーション戦略を設計書に明記する必要がある。

**推奨対応**: Section 4-1 に以下のいずれかを明記する。
1. `extractWorktreeId(compositeKey)` で抽出した worktreeId に `isValidWorktreeId()` を適用する
2. compositeKey 全体をバリデーションする `isValidCompositeKey()` を新設する

---

## 推奨改善項目 (Should Fix)

### SF-001: byWorktree フィルタリングの DRY 違反

auto-yes-state.ts と auto-yes-poller.ts で同一パターンの byWorktree フィルタリングが重複する。auto-yes-state.ts の `getCompositeKeysByWorktree` を poller 側からも利用できるようにインポート設計を検討するか、共通ユーティリティ関数として抽出する。

### SF-002: compositeKey 区切り文字の定数化

現在の `:` ハードコーディングを `COMPOSITE_KEY_SEPARATOR` 定数として定義し、build/extract 関数内で使用することを推奨。変更コストは小さく、将来の保守性向上に寄与する。

### SF-003: 複合キーヘルパーの配置の再検討

実装時にファイルサイズが大きくなるようであれば、`auto-yes-key.ts` への分離を検討する。現段階では auto-yes-state.ts 内で許容可能。

---

## 検討事項 (Consider)

### C-001: 関数名のセマンティクス更新

`getAutoYesStateWorktreeIds` -> `getAutoYesStateCompositeKeys` への名前変更を検討。同様に `getAutoYesPollerWorktreeIds` も対象。

### C-002: getLatestServerResponseTimestampForWorktree の必要性再評価

具体的な使用箇所が確認できた段階で実装する。

### C-003: GET API レスポンス形式の統一

将来的に API v2 で統一的なマップ形式への移行を検討。

### C-004: barrel ファイル更新ステップの追加

Section 11 実装順序の各 Phase に `auto-yes-manager.ts` barrel 更新ステップを追加する。

---

## 総合評価

設計方針書は、既存アーキテクチャとの整合性を保ちながら、最小限の変更でエージェント毎の独立制御を実現する堅実な設計である。SOLID/KISS/YAGNI/DRY の各原則への準拠度は高く、代替案との比較検討も適切に行われている。

必須改善項目 1 件（MF-001: バリデーション戦略の明記）を対応すれば、実装に進めるレベルの設計品質である。

---

*Reviewed by: architecture-review-agent (Stage 1: Design Principles)*
*Date: 2026-03-20*
*Design Document: dev-reports/design/issue-525-auto-yes-per-agent-design-policy.md*
